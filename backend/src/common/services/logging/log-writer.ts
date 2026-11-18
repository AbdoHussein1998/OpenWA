import { randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import * as path from 'node:path';
import type { ApplicationLogEntry } from './log-entry.interface';

const MAX_LOG_ENTRY_BYTES = 32 * 1024;
const MAX_PENDING_BYTES = 16 * 1024 * 1024; // hard cap for overload reporting, not a log-size limit
const MAX_FILENAME_LENGTH = 100;
const INSTANCE_ID = (process.env.LOG_INSTANCE_ID || hostname()).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_FILENAME_LENGTH);
const BOOT_ID = randomUUID();

/** No recursive logging from this writer. Operators must monitor stderr and status. */
export function emergencyLog(reason: string): void {
  process.stderr.write(`[al-hakim-logging-emergency] ${reason.replace(/[^a-zA-Z0-9_. -]/g, '_').slice(0, 160)}\n`);
}

/** Process-wide sink shared by `new LoggerService()` and Nest DI transient instances. */
class DailyNdjsonWriter {
  readonly instanceId = INSTANCE_ID;
  readonly bootId = BOOT_ID;
  readonly directory = path.resolve(process.env.LOG_ARCHIVE_DIR || './data/log-spool');
  private stream?: WriteStream;
  private activeDate?: string;
  private activeFile?: string;
  private readonly pendingClosures = new Set<Promise<void>>();
  private failed = false;
  private dropped = 0;
  private lastFailure?: string;

  write(entry: ApplicationLogEntry): void {
    const day = entry.timestamp.slice(0, 10);
    try {
      if (this.activeDate !== day || !this.stream || this.stream.destroyed) this.openDay(day);
      let content = JSON.stringify(entry) + '\n';
      if (Buffer.byteLength(content) > MAX_LOG_ENTRY_BYTES) {
        // Retain the forensic envelope; never write an unbounded metadata/body dump.
        const preserved = ['eventId', 'timestamp', 'level', 'context', 'operation', 'eventType',
          'message', 'source', 'requestId', 'sessionId', 'correlationId', 'incidentId',
          'connectionAttemptId', 'engineGenerationId', 'instanceId', 'bootId', 'actorType',
          'actorId', 'status', 'reasonCode', 'elapsedMs'] as const;
        const essential = Object.fromEntries(preserved.filter(key => entry[key] !== undefined)
          .map(key => [key, entry[key]]));
        content = JSON.stringify({ ...essential, metadata: { truncated: true } }) + '\n';
        emergencyLog('archive_entry_metadata_truncated');
      }
      if ((this.stream?.writableLength || 0) + Buffer.byteLength(content) > MAX_PENDING_BYTES) {
        this.dropped++;
        if (this.dropped === 1 || this.dropped % 1000 === 0) emergencyLog('archive_queue_overflow_events_dropped');
        return;
      }
      this.stream?.write(content);
    } catch {
      this.failed = true;
      this.lastFailure = 'archive_write_failed';
      emergencyLog('archive_write_failed');
    }
  }

  private openDay(day: string): void {
    this.closeActive();
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.activeDate = day;
    this.activeFile = path.join(this.directory, `${day}.${INSTANCE_ID}.${BOOT_ID}.ndjson`);
    this.failed = false;
    const stream = createWriteStream(this.activeFile, { flags: 'a', mode: 0o600, highWaterMark: 256 * 1024, flush: true });
    stream.on('error', () => {
      this.failed = true;
      this.lastFailure = 'archive_stream_error';
      emergencyLog('archive_stream_error');
      // Node's autoClose releases the fd; do not attempt to write again on this stream.
    });
    this.stream = stream;
  }

  private closeActive(): void {
    const stream = this.stream;
    this.stream = undefined;
    this.activeDate = undefined;
    this.activeFile = undefined;
    if (stream && !stream.destroyed) {
      const closed = new Promise<void>(resolve => {
        // Node 22 createWriteStream({flush:true}) fsyncs before the close event.
        stream.once('close', resolve);
        stream.once('error', () => resolve());
        stream.end();
      });
      this.pendingClosures.add(closed);
      void closed.finally(() => this.pendingClosures.delete(closed));
    }
  }

  /** Open new UTC file at midnight even if no further events are emitted. */
  rotate(): void {
    if (this.activeDate && this.activeDate !== new Date().toISOString().slice(0, 10)) this.closeActive();
  }

  async drainClosedSegments(): Promise<void> {
    await Promise.allSettled([...this.pendingClosures]);
  }

  async flush(): Promise<void> {
    this.closeActive();
    await this.drainClosedSegments();
  }

  getActiveFile(): string | undefined { return this.activeFile; }
  getStatus(): { instanceId: string; bootId: string; directory: string; activeDate?: string; writerFailed: boolean; dropped: number; lastFailure?: string; backlogFiles: number; backlogBytes: number } {
    let backlogFiles = 0;
    let backlogBytes = 0;
    if (existsSync(this.directory)) {
      const today = new Date().toISOString().slice(0, 10);
      for (const file of readdirSync(this.directory)) {
        if (!file.endsWith('.ndjson') || file.slice(0, 10) >= today) continue;
        try {
          if (path.join(this.directory, file) === this.activeFile) continue;
          backlogFiles++;
          backlogBytes += statSync(path.join(this.directory, file)).size;
        } catch { /* concurrent archive unlink */ }
      }
    }
    return { instanceId: INSTANCE_ID, bootId: BOOT_ID, directory: this.directory, activeDate: this.activeDate,
      writerFailed: this.failed, dropped: this.dropped, lastFailure: this.lastFailure, backlogFiles, backlogBytes };
  }
}

export const applicationLogWriter = new DailyNdjsonWriter();
