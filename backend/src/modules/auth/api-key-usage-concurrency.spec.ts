import type { ApiKey } from './entities/api-key.entity';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';

/** A shared persisted counter: the repository evaluates the atomic expression at commit time. */
function sharedRepository(row: { usageCount: number; lastUsedAt: Date | null }) {
  return {
    update: jest.fn(async (_criteria: unknown, patch: {
      usageCount: () => string;
      lastUsedAt: Date;
    }) => {
      const match = patch.usageCount().match(/\+ (\d+)$/);
      if (!match) throw new Error('Expected atomic increment SQL');
      row.usageCount += Number(match[1]);
      row.lastUsedAt = patch.lastUsedAt;
      return { affected: 1 };
    }),
  };
}

function key(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'key-1',
    usageCount: 0,
    lastUsedAt: null,
    ...overrides,
  } as ApiKey;
}

describe('ApiKeyUsageTracker atomic counters', () => {
  it('does not lose increments across independent tracker replicas', async () => {
    const row = { usageCount: 0, lastUsedAt: null as Date | null };
    const repo = sharedRepository(row);
    const replicaA = new ApiKeyUsageTracker(repo as never);
    const replicaB = new ApiKeyUsageTracker(repo as never);

    await Promise.all([replicaA.record(key()), replicaB.record(key())]);
    expect(row.usageCount).toBe(2);
    expect(repo.update).toHaveBeenCalledTimes(2);
  });

  it('does not double-add pending counts to a request-held entity', async () => {
    const row = { usageCount: 0, lastUsedAt: null as Date | null };
    const repo = sharedRepository(row);
    const tracker = new ApiKeyUsageTracker(repo as never);
    const held = key();

    await tracker.record(held);
    await tracker.record(held); // buffered because lastUsedAt was updated
    expect(held.usageCount).toBe(2);
    await tracker.flushOnShutdown();
    expect(row.usageCount).toBe(2);
  });

  it('keeps failed increments for retry', async () => {
    const row = { usageCount: 0, lastUsedAt: null as Date | null };
    const repo = sharedRepository(row);
    repo.update.mockRejectedValueOnce(new Error('temporary database outage'));
    const tracker = new ApiKeyUsageTracker(repo as never);

    await expect(tracker.record(key())).resolves.toBeUndefined();
    expect(row.usageCount).toBe(0);
    await tracker.flushOnShutdown();
    expect(row.usageCount).toBe(1);
  });

  it('does not requeue a failed batch after a key has been revoked', async () => {
    let rejectWrite!: (error: Error) => void;
    const repo = {
      update: jest.fn(() => new Promise((_, reject) => { rejectWrite = reject; })),
    };
    const tracker = new ApiKeyUsageTracker(repo as never);

    const recording = tracker.record(key());
    tracker.forget('key-1');
    rejectWrite(new Error('late write failure'));
    await recording;
    expect((tracker as unknown as { pendingCounts: Map<string, number> })
      .pendingCounts.has('key-1')).toBe(false);
  });
});
