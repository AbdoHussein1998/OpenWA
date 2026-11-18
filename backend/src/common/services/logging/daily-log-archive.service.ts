import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import * as readline from 'node:readline';
import { DataSource, LessThan } from 'typeorm';
import { ApplicationDailyLog, ApplicationDailyLogChunk } from './application-daily-log.entity';
import { applicationLogWriter, emergencyLog } from './log-writer';
import { sanitizeLogText } from './log-sanitizer';
import { LoggerService } from '../logger.service';
import { getRetentionDays } from './logging-settings';

const CHUNK_BYTES = 256 * 1024;
const MAX_LOG_LINE = 64 * 1024;
const SCAN_MS = 5 * 60 * 1000;
const LEASE_MS = 15 * 60 * 1000;
const HISTORY_PAGE_SIZE = 24;

export interface ArchiveStatus {
  retentionDays: number;
  archiveLevel: 'trace';
  consoleLevel: string;
  pendingDates: string[];
  backlogBytes: number;
  writerFailed: boolean;
  droppedEvents: number;
  databaseAvailable: boolean;
  lastArchiveAt: string | null;
  lastCleanupAt: string | null;
  nextCleanupUtc: string;
  failureReason: string | null;
}

/**
 * Main-SQLite backed, streaming daily archival. Sources remain on disk until a complete,
 * byte-verified committed archive has been independently re-read from the database.
 * No DB transaction is opened on the message/request logging hot path.
 */
@Injectable()
export class DailyLogArchiveService implements OnModuleInit, OnModuleDestroy {
  private interval?: ReturnType<typeof setInterval>;
  private busy = false;
  private lastCleanupDay = '';
  private lastCleanupAt: string | null = null;
  private lastArchiveAt: string | null = null;
  private failureReason: string | null = null;
  private databaseAvailable = true;
  private readonly retryAfter = new Map<string, { failures: number; nextAttemptMs: number }>();

  constructor(@InjectDataSource('main') private readonly db: DataSource) {}

  onModuleInit(): void {
    // Best-effort background maintenance. A transient database failure must not affect Nest boot.
    void this.runMaintenance();
    this.interval = setInterval(() => { void this.runMaintenance(); }, SCAN_MS);
    this.interval.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    await applicationLogWriter.flush();
  }

  private repo() { return this.db.getRepository(ApplicationDailyLog); }
  private chunks() { return this.db.getRepository(ApplicationDailyLogChunk); }

  async runMaintenance(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      applicationLogWriter.rotate();
      await applicationLogWriter.drainClosedSegments();
      const pending = await this.pendingFiles();
      for (const filename of pending) {
        const scheduled = this.retryAfter.get(filename);
        if (scheduled && scheduled.nextAttemptMs > Date.now()) break; // oldest first
        try {
          await this.archiveOne(filename);
          this.retryAfter.delete(filename);
          this.databaseAvailable = true;
          this.failureReason = null;
        } catch {
          this.databaseAvailable = false;
          this.failureReason = 'archive_upload_or_verify_failed';
          const failures = (scheduled?.failures || 0) + 1;
          const delay = Math.min(60 * 60_000, 60_000 * 2 ** Math.min(failures - 1, 6));
          this.retryAfter.set(filename, { failures,
            nextAttemptMs: Date.now() + delay + Math.floor(Math.random() * 30_000) });
          emergencyLog('archive_upload_failed_pending_file_retained');
          // Stop immediately during an outage; retry oldest file with bounded exponential backoff.
          break;
        }
      }
      const day = new Date().toISOString().slice(0, 10);
      if (this.lastCleanupDay !== day) {
        try {
          await this.cleanupRetention();
          this.lastCleanupDay = day;
          this.lastCleanupAt = new Date().toISOString();
          this.databaseAvailable = true;
        } catch {
          this.databaseAvailable = false;
          this.failureReason = 'retention_cleanup_failed';
          emergencyLog('log_retention_cleanup_failed');
        }
      }
      await this.checkStoragePressure();
    } catch {
      this.failureReason = 'archive_maintenance_failed';
      emergencyLog('archive_maintenance_failed');
    } finally {
      this.busy = false;
    }
  }

  /** All completed prior UTC-date segments, including those from containers whose hostname changed.
   * Database leases arbitrate when multiple workers share a mounted volume. */
  async pendingFiles(): Promise<string[]> {
    const directory = applicationLogWriter.directory;
    let names: string[];
    try { names = await fs.readdir(directory); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const today = new Date().toISOString().slice(0, 10);
    return names.filter(name => /^\d{4}-\d{2}-\d{2}\.[a-zA-Z0-9_-]+\.[0-9a-f-]{36}\.ndjson$/.test(name))
      .filter(name => name.slice(0, 10) < today)
      .sort();
  }

  /** Read/parse once before any DB work. A torn NDJSON record is retained, not discarded. */
  private async fingerprint(filename: string): Promise<{ sha: string; bytes: number; count: number; first: Date | null; last: Date | null }> {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const piece of createReadStream(filename)) {
      const buf = piece as Buffer;
      bytes += buf.length;
      hash.update(buf);
    }
    const day = path.basename(filename).slice(0, 10);
    let count = 0;
    let first: Date | null = null;
    let last: Date | null = null;
    const lines = readline.createInterface({ input: createReadStream(filename), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.length > MAX_LOG_LINE || line.length === 0) throw new Error('invalid_log_line');
        const entry: unknown = JSON.parse(line);
        if (!entry || typeof entry !== 'object') throw new Error('invalid_log_entry');
        const ts = (entry as { timestamp?: unknown }).timestamp;
        if (typeof ts !== 'string' || !ts.startsWith(day)) throw new Error('wrong_log_date');
        const date = new Date(ts);
        if (Number.isNaN(date.getTime())) throw new Error('invalid_timestamp');
        count++;
        if (!first) first = date;
        last = date;
      }
    } finally { lines.close(); }
    return { sha: hash.digest('hex'), bytes, count, first, last };
  }

  private async claim(segmentKey: string, dateUtc: string): Promise<ApplicationDailyLog | null> {
    const repository = this.repo();
    let row = await repository.findOneBy({ segmentKey });
    if (!row) {
      try {
        row = await repository.save(repository.create({
          segmentKey, dateUtc, instanceId: segmentKey.split('.')[1],
          status: 'pending', leaseOwner: null, leaseUntil: null,
        }));
      } catch { row = await repository.findOneByOrFail({ segmentKey }); }
    }
    if (row.status === 'complete') return row;
    const now = new Date();
    const until = new Date(now.getTime() + LEASE_MS);
    const owner = applicationLogWriter.bootId;
    const update = await repository.createQueryBuilder().update(ApplicationDailyLog)
      .set({ leaseOwner: owner, leaseUntil: until, status: 'uploading' })
      .where('id = :id', { id: row.id })
      .andWhere('("leaseUntil" IS NULL OR "leaseUntil" < :now OR "leaseOwner" = :owner)', { now, owner })
      .andWhere('status <> :done', { done: 'complete' }).execute();
    return update.affected ? { ...row, leaseOwner: owner, leaseUntil: until, status: 'uploading' } : null;
  }

  private async archiveOne(segmentKey: string): Promise<void> {
    const filename = path.join(applicationLogWriter.directory, segmentKey);
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe_archive_source');
    const checksum = await this.fingerprint(filename);
    const row = await this.claim(segmentKey, segmentKey.slice(0, 10));
    if (!row) return; // a different writer is currently archiving this exact segment

    if (row.status === 'complete') {
      if (row.sha256 !== checksum.sha || row.uncompressedBytes !== checksum.bytes || row.entryCount !== checksum.count) {
        throw new Error('source_changed_since_commit');
      }
      if (!(await this.verifyCommitted(row))) throw new Error('committed_archive_verification_failed');
      await fs.unlink(filename);
      return;
    }

    // Retry is idempotent: clear only THIS segment's uncommitted chunks; never remove another day.
    await this.chunks().delete({ dailyLogId: row.id });
    let chunkNo = 0;
    let compressedBytes = 0;
    let pending = Buffer.alloc(0);
    const saveChunk = async (chunk: Buffer) => {
      await this.chunks().save(this.chunks().create({
        dailyLogId: row.id, chunkNo: chunkNo++, content: chunk,
        compressedBytes: chunk.length, sha256: createHash('sha256').update(chunk).digest('hex'),
      }));
      compressedBytes += chunk.length;
      // Renew long uploads, without changing the claim of another worker.
      if (chunkNo % 24 === 0) {
        const renewed = await this.repo().createQueryBuilder().update(ApplicationDailyLog)
          .set({ leaseUntil: new Date(Date.now() + LEASE_MS) })
          .where('id = :id AND leaseOwner = :owner AND status = :state', {
            id: row.id, owner: applicationLogWriter.bootId, state: 'uploading',
          }).execute();
        if (!renewed.affected) throw new Error('archive_lease_lost');
      }
    };
    const compressed = createReadStream(filename).pipe(createGzip());
    for await (const part of compressed) {
      let b = part as Buffer;
      while (b.length > 0) {
        const n = Math.min(CHUNK_BYTES - pending.length, b.length);
        pending = Buffer.concat([pending, b.subarray(0, n)]);
        b = b.subarray(n);
        if (pending.length === CHUNK_BYTES) {
          await saveChunk(pending);
          pending = Buffer.alloc(0);
        }
      }
    }
    if (pending.length) await saveChunk(pending);
    if (chunkNo === 0) throw new Error('archive_empty_gzip');

    // The source may have been touched during upload. Do not mark complete or unlink it.
    const after = await this.fingerprint(filename);
    if (after.sha !== checksum.sha || after.bytes !== checksum.bytes) throw new Error('source_mutated_during_upload');
    await this.repo().update({ id: row.id, leaseOwner: applicationLogWriter.bootId }, {
      sha256: checksum.sha, uncompressedBytes: checksum.bytes, compressedBytes,
      chunkCount: chunkNo, entryCount: checksum.count, firstEventAt: checksum.first, lastEventAt: checksum.last,
    });
    const provisional = await this.repo().findOneByOrFail({ id: row.id });
    if (!(await this.verifyContents(provisional))) throw new Error('archive_checksum_mismatch');

    const completed = await this.repo().createQueryBuilder().update(ApplicationDailyLog)
      .set({ status: 'complete', completedAt: new Date(), leaseUntil: null, leaseOwner: null })
      .where('id = :id AND leaseOwner = :owner AND status = :state', {
        id: row.id, owner: applicationLogWriter.bootId, state: 'uploading',
      }).execute();
    if (!completed.affected) throw new Error('archive_commit_lease_lost');
    const committed = await this.repo().findOneByOrFail({ id: row.id, status: 'complete' });
    if (!(await this.verifyCommitted(committed))) throw new Error('archive_post_commit_verification_failed');
    await fs.unlink(filename);
    this.lastArchiveAt = new Date().toISOString();
  }

  /** Pagination bounds memory even for arbitrarily large archives. */
  async *compressedChunks(archiveId: string): AsyncGenerator<Buffer> {
    let skip = 0;
    for (;;) {
      const items = await this.chunks().find({ where: { dailyLogId: archiveId },
        order: { chunkNo: 'ASC' }, skip, take: HISTORY_PAGE_SIZE });
      if (!items.length) break;
      for (const item of items) {
        const data = Buffer.from(item.content);
        if (createHash('sha256').update(data).digest('hex') !== item.sha256) throw new Error('db_chunk_checksum_mismatch');
        yield data;
      }
      skip += items.length;
      if (items.length < HISTORY_PAGE_SIZE) break;
    }
  }

  private async verifyContents(row: ApplicationDailyLog): Promise<boolean> {
    let countChunks = 0;
    let compressedBytes = 0;
    for await (const b of this.compressedChunks(row.id)) { countChunks++; compressedBytes += b.length; }
    if (countChunks !== row.chunkCount || compressedBytes !== row.compressedBytes) return false;
    const digest = createHash('sha256');
    let bytes = 0;
    let lines = 0;
    const gunzip = Readable.from(this.compressedChunks(row.id)).pipe(createGunzip());
    for await (const chunk of gunzip) {
      const b = chunk as Buffer;
      bytes += b.length;
      digest.update(b);
      for (const ch of b) if (ch === 10) lines++;
    }
    return digest.digest('hex') === row.sha256 && bytes === row.uncompressedBytes && lines === row.entryCount;
  }

  private async verifyCommitted(row: ApplicationDailyLog): Promise<boolean> {
    return row.status === 'complete' && Boolean(row.sha256) && await this.verifyContents(row);
  }

  async getArchive(archiveId: string): Promise<ApplicationDailyLog | null> {
    return this.repo().findOneBy({ id: archiveId, status: 'complete' });
  }

  async listArchives(dateUtc?: string): Promise<Array<Pick<ApplicationDailyLog, 'id' | 'dateUtc' | 'instanceId' | 'entryCount' | 'compressedBytes' | 'completedAt'>>> {
    const items = await this.repo().find({ where: { status: 'complete', ...(dateUtc ? { dateUtc } : {}) },
      order: { dateUtc: 'DESC', completedAt: 'DESC' }, take: 150 });
    return items.map((item: ApplicationDailyLog) => ({
      id: item.id, dateUtc: item.dateUtc, instanceId: item.instanceId,
      entryCount: item.entryCount, compressedBytes: item.compressedBytes, completedAt: item.completedAt,
    }));
  }

  /** Live current-day query, including segments from prior boots. Memory bounded to the last limit matches. */
  async currentDay(limit = 200, sessionId?: string, incidentId?: string): Promise<unknown[]> {
    const today = new Date().toISOString().slice(0, 10);
    const files = (await fs.readdir(applicationLogWriter.directory).catch(() => [] as string[]))
      .filter(f => f.startsWith(`${today}.`) && f.endsWith('.ndjson')).sort();
    const found: unknown[] = [];
    for (const file of files) {
      const lines = readline.createInterface({ input: createReadStream(path.join(applicationLogWriter.directory, file)), crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (line.length > MAX_LOG_LINE) continue;
          let entry: { sessionId?: unknown; incidentId?: unknown };
          try { entry = JSON.parse(line) as { sessionId?: unknown; incidentId?: unknown }; } catch { continue; }
          if (sessionId && entry.sessionId !== sessionId) continue;
          if (incidentId && entry.incidentId !== incidentId) continue;
          found.push(entry);
          if (found.length > limit) found.shift();
        }
      } finally { lines.close(); }
    }
    return found;
  }

  /** Slow-path archived search, streaming gzip through line reader, with explicit result cap. */
  async searchHistory(day: string, limit = 200, sessionId?: string, incidentId?: string): Promise<unknown[]> {
    const archives = await this.repo().find({ where: { dateUtc: day, status: 'complete' }, take: 50,
      order: { createdAt: 'ASC' } });
    const result: unknown[] = [];
    for (const archive of archives) {
      const uncompressed = Readable.from(this.compressedChunks(archive.id)).pipe(createGunzip());
      const lines = readline.createInterface({ input: uncompressed, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (line.length > MAX_LOG_LINE) continue;
          let entry: { sessionId?: unknown; incidentId?: unknown };
          try { entry = JSON.parse(line) as { sessionId?: unknown; incidentId?: unknown }; } catch { continue; }
          if (sessionId && entry.sessionId !== sessionId) continue;
          if (incidentId && entry.incidentId !== incidentId) continue;
          result.push(entry);
          if (result.length >= limit) break;
        }
      } finally { lines.close(); uncompressed.destroy(); }
      if (result.length >= limit) break;
    }
    return result;
  }

  /** Daily retention of COMPLETED archives only. Pending local evidence is never deleted. */
  async cleanupRetention(): Promise<number> {
    const date = new Date(Date.now() - getRetentionDays() * 86_400_000).toISOString().slice(0, 10);
    let removed = 0;
    for (;;) {
      const expired = await this.repo().find({ where: { status: 'complete', dateUtc: LessThan(date) }, take: 10 });
      if (!expired.length) break;
      for (const entry of expired) {
        await this.db.transaction(async (manager: import('typeorm').EntityManager) => {
          await manager.delete(ApplicationDailyLogChunk, { dailyLogId: entry.id });
          await manager.delete(ApplicationDailyLog, { id: entry.id, status: 'complete' });
        });
        removed++;
      }
    }
    return removed;
  }

  private async checkStoragePressure(): Promise<void> {
    try {
      const disk = await fs.statfs(applicationLogWriter.directory);
      if (disk.blocks && disk.bavail / disk.blocks < 0.1) emergencyLog('log_spool_disk_free_below_10_percent');
      const writer = applicationLogWriter.getStatus();
      if (writer.backlogFiles > 2) emergencyLog('log_spool_backlog_multiple_days');
      if (writer.writerFailed || writer.dropped > 0) emergencyLog('log_spool_writer_dropped_or_failed');
    } catch { /* not available on all filesystems */ }
  }

  async status(): Promise<ArchiveStatus> {
    const writer = applicationLogWriter.getStatus();
    let pendingDates: string[] = [];
    try { pendingDates = [...new Set((await this.pendingFiles()).map(f => f.slice(0, 10)))]; } catch { /* status remains available */ }
    let liveDb = false;
    try { await this.db.query('SELECT 1'); liveDb = true; } catch { /* dashboard must still report backlog */ }
    let latest = this.lastArchiveAt;
    if (liveDb && !latest) {
      try {
        const completed = await this.repo().findOne({ where: { status: 'complete' }, order: { completedAt: 'DESC' } });
        latest = completed?.completedAt?.toISOString?.() || null;
      } catch { /* unavailable while rebuilding tables */ }
    }
    return {
      retentionDays: getRetentionDays(), archiveLevel: 'trace',
      consoleLevel: LoggerService.getLogLevel(),
      pendingDates, backlogBytes: writer.backlogBytes, writerFailed: writer.writerFailed,
      droppedEvents: writer.dropped, databaseAvailable: liveDb,
      lastArchiveAt: latest, lastCleanupAt: this.lastCleanupAt,
      nextCleanupUtc: new Date(new Date().setUTCHours(24, 0, 0, 0)).toISOString(),
      failureReason: this.failureReason ? sanitizeLogText(this.failureReason) : null,
    };
  }
}
