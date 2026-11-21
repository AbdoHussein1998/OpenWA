import { BraveFailureCode, BraveLifecycleError, braveFailureReason, elapsedBrowserMs } from './brave-lifecycle-diagnostics';

describe('Brave lifecycle operational reason codes', () => {
  it('uses a stable PROFILE_LOCKED reason independent of its human-readable message', () => {
    const error = new BraveLifecycleError(BraveFailureCode.PROFILE_LOCKED, 'Session is locked');
    expect(error.code).toBe('PROFILE_LOCKED');
    expect(braveFailureReason(error, BraveFailureCode.BROWSER_LAUNCH_FAILED)).toBe('PROFILE_LOCKED');
  });

  it('maps earlier Phase 4 recovery failures without changing their thrown message', () => {
    const error = new Error('BROWSER_ORPHAN_RECOVERY_UNSAFE: process inventory unavailable');
    expect(braveFailureReason(error, BraveFailureCode.BROWSER_LAUNCH_FAILED))
      .toBe(BraveFailureCode.PROFILE_RECOVERY_UNSAFE);
  });

  it('uses a caller-provided fallback for unexpected errors and cannot leak their text', () => {
    const error = new Error('secret=NEVER_LOG_THIS');
    expect(braveFailureReason(error, BraveFailureCode.BROWSER_TERMINATION_FAILED))
      .toBe(BraveFailureCode.BROWSER_TERMINATION_FAILED);
  });

  it('reports a nonnegative elapsed time', () => {
    expect(elapsedBrowserMs(Date.now() + 10_000)).toBe(0);
  });
});
