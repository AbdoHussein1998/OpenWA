/**
 * Existing per-step teardown deadlines: do not change these as part of the
 * browser-abstraction refactor. The caller's lifecycle fence is 10 seconds;
 * grace + force + lease verification budgets total 9.5 seconds.
 *
 * A timeout bounds only the caller's wait. The underlying operation is NOT
 * cancelled; it may finish later. The session/profile owner must stay locked
 * until process termination and absence of conflicting owners are verified.
 */
export const BROWSER_TEARDOWN_BUDGETS = Object.freeze({
  graceMs: 2_000,
  forceMs: 4_000,
  leaseMs: 3_500,
  postKillDestroyMs: 500,
});

export class BrowserTeardownTimeoutError extends Error {
  constructor(readonly operation: string, readonly timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'BrowserTeardownTimeoutError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Bounds a caller's wait and ensures rejection from the late operation is observed. */
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
        timer = setTimeout(() => reject(new BrowserTeardownTimeoutError(label, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
