import {
  BROWSER_TEARDOWN_BUDGETS,
  BrowserTeardownTimeoutError,
  boundedBrowserOperation,
} from './browser-teardown';
import {
  BraveTeardownTimeoutError,
  boundedBrowserOperation as boundedLegacyOperation,
} from '../brave/brave-browser-teardown';

describe('Phase 3: browser-neutral teardown deadlines', () => {
  it('preserves the existing teardown budget constants', () => {
    expect(BROWSER_TEARDOWN_BUDGETS).toEqual({
      graceMs: 2_000, forceMs: 4_000, leaseMs: 3_500, postKillDestroyMs: 500,
    });
    expect(Object.isFrozen(BROWSER_TEARDOWN_BUDGETS)).toBe(true);
  });

  it('returns the underlying result and propagates its original error', async () => {
    await expect(boundedBrowserOperation(async () => 'ok', 100, 'success')).resolves.toBe('ok');
    const failure = new Error('original operation error');
    await expect(boundedBrowserOperation(async () => { throw failure; }, 100, 'reject'))
      .rejects.toBe(failure);
  });

  it('bounds a hung new operation and preserves operation metadata', async () => {
    jest.useFakeTimers();
    try {
      const pending = boundedBrowserOperation(() => new Promise<void>(() => undefined), 50, 'stalled browser');
      const assertion = expect(pending).rejects.toMatchObject({
        name: 'BrowserTeardownTimeoutError', operation: 'stalled browser', timeoutMs: 50,
      });
      await jest.advanceTimersByTimeAsync(50);
      await assertion;
    } finally { jest.useRealTimers(); }
  });

  it('retains the legacy Brave timeout type and error name', async () => {
    jest.useFakeTimers();
    try {
      const pending = boundedLegacyOperation(() => new Promise<void>(() => undefined), 30, 'stalled CDP');
      const assertion = expect(pending).rejects.toBeInstanceOf(BraveTeardownTimeoutError);
      await jest.advanceTimersByTimeAsync(30);
      await assertion;
    } finally { jest.useRealTimers(); }
    const legacy = new BraveTeardownTimeoutError('legacy', 10);
    expect(legacy).toBeInstanceOf(BrowserTeardownTimeoutError);
    expect(legacy.name).toBe('BraveTeardownTimeoutError');
  });

  it('does not infer process termination after a deadline', async () => {
    jest.useFakeTimers();
    try {
      let complete!: () => void;
      const operation = new Promise<void>(resolve => { complete = resolve; });
      const pending = boundedBrowserOperation(() => operation, 25, 'not-cancellable');
      const assertion = expect(pending).rejects.toBeInstanceOf(BrowserTeardownTimeoutError);
      await jest.advanceTimersByTimeAsync(25);
      await assertion;
      // The underlying operation is still active; the ownership lease must
      // remain held until independent verification by BrowserProfileManager.
      complete();
      await operation;
    } finally { jest.useRealTimers(); }
  });
});
