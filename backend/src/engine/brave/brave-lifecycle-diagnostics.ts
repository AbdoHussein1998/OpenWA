/**
 * Phase 3 compatibility entrypoint. Legacy reason codes and exported names
 * remain supported while new code can use the browser-neutral module.
 */
import {
  BrowserFailureCode,
  BrowserLifecycleError,
  browserFailureReason,
} from '../browser/browser-lifecycle-diagnostics';

export const BraveFailureCode = BrowserFailureCode;
export type BraveFailureCode = import('../browser/browser-lifecycle-diagnostics').BrowserFailureCode;

/** Preserve the old instanceof test and error.name for manually created legacy errors. */
export class BraveLifecycleError extends BrowserLifecycleError {
  constructor(code: BraveFailureCode, message: string) {
    super(code, message);
    this.name = 'BraveLifecycleError';
  }
}

/** Classifies both legacy and new browser lifecycle failures. */
export function braveFailureReason(error: unknown, fallback: BraveFailureCode): BraveFailureCode {
  return browserFailureReason(error, fallback);
}

export { elapsedBrowserMs } from '../browser/browser-lifecycle-diagnostics';
