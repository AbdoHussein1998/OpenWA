/** Legacy entrypoint retained for existing WwebjsLifecycle/WwebjsStuckAuth imports. */
import {
  BrowserTeardownTimeoutError,
  boundedBrowserOperation as boundedNeutralBrowserOperation,
} from '../browser/browser-teardown';

export { BROWSER_TEARDOWN_BUDGETS } from '../browser/browser-teardown';

/** Preserve the historical class name for callers checking error.name/type. */
export class BraveTeardownTimeoutError extends BrowserTeardownTimeoutError {
  constructor(operation: string, timeoutMs: number) {
    super(operation, timeoutMs);
    this.name = 'BraveTeardownTimeoutError';
  }
}

/**
 * The deadline implementation lives in browser-teardown.ts. Translate only
 * its timeout error to preserve instanceof BraveTeardownTimeoutError for old
 * consumers; other failures are propagated unchanged.
 */
export async function boundedBrowserOperation<T>(
  operation: () => Promise<T>, timeoutMs: number, label: string,
): Promise<T> {
  try {
    return await boundedNeutralBrowserOperation(operation, timeoutMs, label);
  } catch (error) {
    if (error instanceof BrowserTeardownTimeoutError) {
      throw new BraveTeardownTimeoutError(error.operation, error.timeoutMs);
    }
    throw error;
  }
}
