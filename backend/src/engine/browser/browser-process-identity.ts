/** OS process record used for per-session identity and process-tree verification. */
export interface BrowserProcessRecord {
  pid: number;
  parentPid: number;
  commandLine: string;
}

/** Browser drivers trusted to recognize their own executable, not profile owners. */
export interface BrowserExecutableMatcher {
  readonly type: string;
  matchesExecutable(commandLine: string): boolean;
}

/**
 * A browser root must have a recognized executable AND the exact session and
 * persistent user-data directory. A marker by itself is never proof of ownership.
 *
 * We deliberately accept multiple known drivers here so a crashed Brave process
 * is not mistaken for an absent process after a later switch to Chrome.
 * A driver does not authorize process termination by itself; a valid lease token
 * and the verified OS process tree are checked by BrowserProfileManager.
 */
export function isSessionOwnedBrowserRoot(
  commandLine: string,
  sessionId: string,
  profilePath: string,
  browsers: readonly BrowserExecutableMatcher[],
  windows = process.platform === 'win32',
): boolean {
  if (browsers.length === 0 || !browsers.some((browser) => browser.matchesExecutable(commandLine))) {
    return false;
  }
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = windows ? 'i' : '';
  const exactArg = (arg: string): boolean =>
    new RegExp(`(?:^|\\s)"?${escape(arg)}"?(?=$|\\s)`, flags).test(commandLine);
  const normalizedProfile = windows ? profilePath.replace(/\\/g, '/').toLowerCase() : profilePath;
  const normalizedCommand = windows ? commandLine.replace(/\\/g, '/').toLowerCase() : commandLine;
  const profileArgs = [
    `--user-data-dir=${normalizedProfile}`,
    `--user-data-dir="${normalizedProfile}"`,
  ];
  return exactArg(`--al-hakim-session=${sessionId}`) && profileArgs.some((arg) =>
    new RegExp(`(?:^|\\s)"?${escape(arg)}"?(?=$|\\s)`, flags).test(normalizedCommand));
}

/**
 * Compute a leaves-first plan ONLY for the captured and verified root process.
 * Refuse cross-session descendants and malformed/cyclic PID trees. Never scan
 * and kill every process sharing the browser executable name.
 */
export function planOwnedBrowserTree(
  records: readonly BrowserProcessRecord[],
  rootPid: number,
  sessionId: string,
  profilePath: string,
  browsers: readonly BrowserExecutableMatcher[],
  windows = process.platform === 'win32',
): BrowserProcessRecord[] {
  const byPid = new Map<number, BrowserProcessRecord>();
  for (const record of records) {
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || byPid.has(record.pid)) {
      throw new Error('Cannot verify browser process tree: invalid or duplicate PID');
    }
    byPid.set(record.pid, record);
  }
  const root = byPid.get(rootPid);
  if (!root) return [];
  if (!isSessionOwnedBrowserRoot(root.commandLine, sessionId, profilePath, browsers, windows)) {
    throw new Error(`Refusing to terminate PID ${rootPid}: browser session/profile identity mismatch`);
  }
  const ordered: BrowserProcessRecord[] = [];
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const escapedSession = sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const childSessionMarker = new RegExp(`(?:^|\\s)--al-hakim-session=${escapedSession}(?=$|\\s)`);
  const visit = (parent: BrowserProcessRecord): void => {
    if (visiting.has(parent.pid)) throw new Error('Cycle in browser process tree');
    if (visited.has(parent.pid)) return;
    visiting.add(parent.pid);
    for (const child of records) {
      if (child.pid === parent.pid || child.parentPid !== parent.pid) continue;
      if (/--al-hakim-session=/.test(child.commandLine) &&
          !childSessionMarker.test(child.commandLine)) {
        throw new Error('Refusing to terminate a browser tree containing a different session');
      }
      visit(child);
    }
    visiting.delete(parent.pid);
    visited.add(parent.pid);
    ordered.push(parent);
  };
  visit(root);
  return ordered;
}
