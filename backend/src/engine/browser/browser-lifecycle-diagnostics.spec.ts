import {
  BrowserFailureCode,
  BrowserLifecycleError,
  browserFailureReason,
  elapsedBrowserMs,
} from './browser-lifecycle-diagnostics';
import {
  BraveFailureCode,
  BraveLifecycleError,
  braveFailureReason,
} from '../brave/brave-lifecycle-diagnostics';

describe('Phase 3: browser-neutral lifecycle diagnostics', () => {
  it('preserves the exact legacy reason-code values', () => {
    expect(BrowserFailureCode).toEqual(BraveFailureCode);
    expect(Object.values(BrowserFailureCode)).toEqual([
      'PROFILE_LOCKED', 'PROFILE_RECOVERY_UNSAFE', 'BROWSER_TERMINATION_FAILED',
      'BROWSER_TEARDOWN_INCOMPLETE', 'BROWSER_LAUNCH_FAILED', 'BROWSER_PROCESS_ERROR',
    ]);
  });

  it('classifies new and legacy typed errors through the neutral classifier', () => {
    const current = new BrowserLifecycleError(BrowserFailureCode.PROFILE_LOCKED, 'busy');
    const legacy = new BraveLifecycleError(BraveFailureCode.BROWSER_TERMINATION_FAILED, 'unsafe');
    expect(browserFailureReason(current, BrowserFailureCode.BROWSER_LAUNCH_FAILED)).toBe('PROFILE_LOCKED');
    expect(browserFailureReason(legacy, BrowserFailureCode.BROWSER_LAUNCH_FAILED)).toBe('BROWSER_TERMINATION_FAILED');
    expect(braveFailureReason(current, BraveFailureCode.BROWSER_LAUNCH_FAILED)).toBe('PROFILE_LOCKED');
    expect(legacy.name).toBe('BraveLifecycleError');
    expect(legacy).toBeInstanceOf(BrowserLifecycleError);
  });

  it('recognizes legacy orphan failure text and redacts unknown errors', () => {
    expect(browserFailureReason(new Error('BROWSER_ORPHAN_RECOVERY_UNSAFE: no owner'),
      BrowserFailureCode.BROWSER_LAUNCH_FAILED)).toBe('PROFILE_RECOVERY_UNSAFE');
    expect(browserFailureReason(new Error('SECRET=must-not-be-logged'),
      BrowserFailureCode.BROWSER_PROCESS_ERROR)).toBe('BROWSER_PROCESS_ERROR');
  });

  it('retains nonnegative elapsed milliseconds', () => {
    expect(elapsedBrowserMs(Date.now() + 1_000)).toBe(0);
  });
});
