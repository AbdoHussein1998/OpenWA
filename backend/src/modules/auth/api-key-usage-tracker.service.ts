import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiKey } from './entities/api-key.entity';
import { createLogger } from '../../common/services/logger.service';

/** Usage metrics are advisory; never used to authorize requests or bill customers. */
const FLUSH_INTERVAL_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Buffers usage counters between writes and uses a database-atomic increment
 * for every flush. No read/modify/write of a stale entity can overwrite other
 * replicas' counts or authentication metadata.
 *
 * Counts still may be lost after a process crash; these are approximate metrics.
 */
@Injectable()
export class ApiKeyUsageTracker implements OnModuleDestroy {
  private readonly logger = createLogger('ApiKeyUsageTracker');
  private readonly pendingCounts = new Map<string, number>();
  private readonly forgetEpoch = new Map<string, number>();

  constructor(
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeyRepository: Repository<ApiKey>,
  ) {}

  /** Record one authenticated request. A metrics failure never rejects the request. */
  async record(apiKey: ApiKey): Promise<void> {
    const now = new Date();
    const previousLastUsedAt = apiKey.lastUsedAt;
    const count = (this.pendingCounts.get(apiKey.id) ?? 0) + 1;
    const epoch = this.forgetEpoch.get(apiKey.id) ?? 0;

    // Do not add `count` to an entity that may already include previous calls.
    apiKey.lastUsedAt = now;
    apiKey.usageCount += 1;

    if (
      previousLastUsedAt &&
      now.getTime() - previousLastUsedAt.getTime() < FLUSH_INTERVAL_MS
    ) {
      this.pendingCounts.set(apiKey.id, count);
      return;
    }

    // Claim the pending counts before awaiting IO. A concurrent request can
    // safely start a new pending batch without being deleted by this flush.
    this.pendingCounts.delete(apiKey.id);
    await this.writeUsageStats(apiKey.id, count, now, epoch);
  }

  /** Stop retrying stats belonging to an invalidated/deleted credential. */
  forget(keyId: string): void {
    this.pendingCounts.delete(keyId);
    this.forgetEpoch.set(keyId, (this.forgetEpoch.get(keyId) ?? 0) + 1);
  }

  async onModuleDestroy(): Promise<void> {
    await this.flushOnShutdown();
  }

  async flushOnShutdown(): Promise<void> {
    if (this.pendingCounts.size === 0) return;
    this.logger.log(`Flushing usage stats for ${this.pendingCounts.size} API key(s) before shutdown`);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT_MS);
      timer.unref?.();
    });
    const flush = this.flushAllPending().then(() => 'done' as const);
    const winner = await Promise.race([flush, timeout]);
    if (timer) clearTimeout(timer);
    if (winner === 'timeout') {
      this.logger.warn('Usage-stat shutdown flush timed out; some counts may be lost');
    }
  }

  /** Claim entries one by one and restore only failed entries, without losing new arrivals. */
  private async flushAllPending(): Promise<void> {
    for (const [keyId, count] of [...this.pendingCounts.entries()]) {
      if (count <= 0) {
        this.pendingCounts.delete(keyId);
        continue;
      }
      this.pendingCounts.delete(keyId);
      await this.writeUsageStats(
        keyId,
        count,
        new Date(),
        this.forgetEpoch.get(keyId) ?? 0,
      );
    }
  }

  /** A single UPDATE changes only advisory usage fields; never persists a stale entity. */
  private async writeUsageStats(
    keyId: string,
    count: number,
    now: Date,
    epoch: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(count) || count <= 0) return;
    try {
      // `count` is a locally calculated positive integer (not request SQL).
      // Quoting the name supports the existing SQLite driver and PostgreSQL.
      await this.apiKeyRepository.update(
        { id: keyId },
        {
          usageCount: () => `"usageCount" + ${count}`,
          lastUsedAt: now,
        },
      );
    } catch (error) {
      // forget() may run during IO (revoke/delete). Do not resurrect its batch.
      if ((this.forgetEpoch.get(keyId) ?? 0) === epoch) {
        this.pendingCounts.set(
          keyId,
          (this.pendingCounts.get(keyId) ?? 0) + count,
        );
      }
      this.logger.warn('Usage-stat write failed; eligible counts kept for retry', {
        keyId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
