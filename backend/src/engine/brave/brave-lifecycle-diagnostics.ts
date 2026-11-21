/**
 * Stable operational reasons for the Brave profile/process lifecycle.
 * These are deliberately NOT replacements for existing HTTP error codes.
 * Only a short code and non-sensitive context go into structured logs; in
 * particular, never log the filesystem lease generation token or owner.json.
 */
export const BraveFailureCode = {
  PROFILE_LOCKED: 'PROFILE_LOCKED',
  PROFILE_RECOVERY_UNSAFE: 'PROFILE_RECOVERY_UNSAFE',
  BROWSER_TERMINATION_FAILED: 'BROWSER_TERMINATION_FAILED',
  BROWSER_TEARDOWN_INCOMPLETE: 'BROWSER_TEARDOWN_INCOMPLETE',
  BROWSER_LAUNCH_FAILED: 'BROWSER_LAUNCH_FAILED',
  BROWSER_PROCESS_ERROR: 'BROWSER_PROCESS_ERROR',
} as const;

export type BraveFailureCode = typeof BraveFailureCode[keyof typeof BraveFailureCode];

export class BraveLifecycleError extends Error {
  readonly name = 'BraveLifecycleError';
  constructor(readonly code: BraveFailureCode, message: string) {
    super(`${code}: ${message}`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Classify legacy errors without exposing raw error strings or on-disk tokens in telemetry. */
export function braveFailureReason(error: unknown, fallback: BraveFailureCode): BraveFailureCode {
  if (error instanceof BraveLifecycleError) return error.code;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/\b(?:PROFILE_LOCKED|locked by another owner)\b/i.test(message)) return BraveFailureCode.PROFILE_LOCKED;
  if (/\b(?:BROWSER_ORPHAN_RECOVERY_UNSAFE|PROFILE_RECOVERY_UNSAFE)\b/.test(message)) {
    return BraveFailureCode.PROFILE_RECOVERY_UNSAFE;
  }
  if (/\bBROWSER_TEARDOWN_INCOMPLETE\b/.test(message)) return BraveFailureCode.BROWSER_TEARDOWN_INCOMPLETE;
  if (/\bBROWSER_TERMINATION_FAILED\b/.test(message)) return BraveFailureCode.BROWSER_TERMINATION_FAILED;
  return fallback;
}

/** Milliseconds for an operation; nonnegative even if the wall clock is adjusted. */
export function elapsedBrowserMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
