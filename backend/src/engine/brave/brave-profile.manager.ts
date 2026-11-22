/**
 * Transitional compatibility entrypoint for existing WhatsApp engine code.
 *
 * Phase 2 moves the implementation to BrowserProfileManager. Existing imports,
 * constructor signatures, test seams and helper functions remain functional;
 * the plugin/lifecycle transition is deliberately postponed to Phase 4/5.
 */
import { BraveBrowser } from '../browser/implementations/brave.browser';
import {
  isSessionOwnedBrowserRoot,
  planOwnedBrowserTree,
  type BrowserProcessRecord,
} from '../browser/browser-process-identity';
import { BrowserProfileManager } from '../browser/browser-profile.manager';

export type BraveProcessRecord = BrowserProcessRecord;
export type BraveProfileLeaseRelease = import('../browser/browser-profile.manager').BrowserProfileLeaseRelease;

/** Backward compatible class: now inherits the shared browser-neutral implementation. */
export class BraveProfileManager extends BrowserProfileManager {}

const legacyBraveDriver = new BraveBrowser();

/** Preserve exact existing process-matcher signature for current consumers/tests. */
export function isSessionOwnedBraveRoot(
  commandLine: string,
  sessionId: string,
  profilePath: string,
  windows = process.platform === 'win32',
): boolean {
  return isSessionOwnedBrowserRoot(commandLine, sessionId, profilePath, [legacyBraveDriver], windows);
}

/** Preserve existing process-tree planner signature while reusing the shared algorithm. */
export function planOwnedBraveTree(
  records: readonly BraveProcessRecord[],
  rootPid: number,
  sessionId: string,
  profilePath: string,
  windows = process.platform === 'win32',
): BraveProcessRecord[] {
  return planOwnedBrowserTree(records, rootPid, sessionId, profilePath, [legacyBraveDriver], windows);
}
