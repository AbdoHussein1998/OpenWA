/**
 * Stable, browser-neutral operational failure reasons. Reason-code values and
 * engine.browser.* event names are unchanged. Never emit lease tokens, raw
 * profile owner.json, or untrusted error text into structured telemetry.
 */
export const BrowserFailureCode = {
  PROFILE_LOCKED: 'PROFILE_LOCKED',
  PROFILE_RECOVERY_UNSAFE: 'PROFILE_RECOVERY_UNSAFE',
  BROWSER_TERMINATION_FAILED: 'BROWSER_TERMINATION_FAILED',
  BROWSER_TEARDOWN_INCOMPLETE: 'BROWSER_TEARDOWN_INCOMPLETE',
  BROWSER_LAUNCH_FAILED: 'BROWSER_LAUNCH_FAILED',
  BROWSER_PROCESS_ERROR: 'BROWSER_PROCESS_ERROR',
} as const;

export type BrowserFailureCode = typeof BrowserFailureCode[keyof typeof BrowserFailureCode];

export class BrowserLifecycleError extends Error {
  readonly code: BrowserFailureCode;
  constructor(code: BrowserFailureCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = 'BrowserLifecycleError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Map legacy and new errors without returning arbitrary error contents. */
export function browserFailureReason(error: unknown, fallback: BrowserFailureCode): BrowserFailureCode {
  if (error instanceof BrowserLifecycleError) return error.code;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/\b(?:PROFILE_LOCKED|locked by another owner)\b/i.test(message)) return BrowserFailureCode.PROFILE_LOCKED;
  if (/\b(?:BROWSER_ORPHAN_RECOVERY_UNSAFE|PROFILE_RECOVERY_UNSAFE)\b/.test(message)) {
    return BrowserFailureCode.PROFILE_RECOVERY_UNSAFE;
  }
  if (/\bBROWSER_TEARDOWN_INCOMPLETE\b/.test(message)) return BrowserFailureCode.BROWSER_TEARDOWN_INCOMPLETE;
  if (/\bBROWSER_TERMINATION_FAILED\b/.test(message)) return BrowserFailureCode.BROWSER_TERMINATION_FAILED;
  return fallback;
}

/** Nonnegative elapsed milliseconds even after a wall-clock adjustment. */
export function elapsedBrowserMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
