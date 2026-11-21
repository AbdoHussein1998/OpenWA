/**
 * Phase 3 per-step deadlines. The existing SessionLifecycleFences deadline is 10 seconds;
 * the worst normal path (grace -> OS escalation -> lease verification) is 9.5 seconds.
 * These operations are NOT cancellable: a timed-out underlying call continues, but the
 * profile lock remains held until independently verified safe to release.
 */
export const BROWSER_TEARDOWN_BUDGETS = Object.freeze({
  graceMs: 2_000,
  forceMs: 4_000,
  leaseMs: 3_500,
  postKillDestroyMs: 500,
});

export class BraveTeardownTimeoutError extends Error {
  constructor(readonly operation: string, readonly timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'BraveTeardownTimeoutError';
  }
}

/** Bounds the caller's wait; always consumes later rejections from the underlying promise. */
export async function boundedBrowserOperation<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BraveTeardownTimeoutError(label, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
