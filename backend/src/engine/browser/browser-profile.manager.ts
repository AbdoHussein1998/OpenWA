// Browser-neutral implementation of the established Brave profile lease and recovery policy.
// Legacy import compatibility lives in ../brave/brave-profile.manager.ts.
// Deliberately retain existing .openwa-profile-locks/owner.json layout, action codes,
// lease-generation semantics and process-inspection fail-closed behavior.
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { promisify } from 'util';
import { type createLogger } from '../../common/services/logger.service';
import { BrowserFailureCode, BrowserLifecycleError, browserFailureReason, elapsedBrowserMs } from './browser-lifecycle-diagnostics';
import { BraveBrowser } from './implementations/brave.browser';
import { isSessionOwnedBrowserRoot, planOwnedBrowserTree, type BrowserExecutableMatcher, type BrowserProcessRecord } from './browser-process-identity';

const execFileAsync = promisify(execFile);
const PROCESS_LIST_MAX_BUFFER = 10 * 1024 * 1024;
const PROCESS_KILL_SETTLE_MS = 500;
const OWNED_TREE_INSPECTION_TIMEOUT_MS = 15_000;
const ORPHAN_EXIT_SETTLE_MS = 500;

export type BrowserProfileLeaseRelease = (() => Promise<void>) & { readonly ownerToken: string };

/**
 * Manages persistent Chromium-based browser profiles per al-hakim session.
 *
 * Each al-hakim session owns one persistent browser user-data directory.
 * Browser processes are disposable, but the profile is not.
 */
export class BrowserProfileManager {
  private readonly recognizedBrowsers: readonly BrowserExecutableMatcher[];

  /**
   * Optional additional browser drivers used to recognize PREVIOUS owners too.
   * Brave must remain recognized for abandoned-profile cleanup after changing
   * the selected browser. Unknown executables are never authorized for reaping.
   */
  constructor(
    private readonly baseProfilePath: string,
    additionalBrowsers: readonly BrowserExecutableMatcher[] = [],
  ) {
    // The known Brave matcher is mandatory and cannot be replaced by an
    // additional driver declaring the same type.
    const browsers = [new BraveBrowser(), ...additionalBrowsers.filter(browser => browser.type !== 'brave')];
    this.recognizedBrowsers = [...new Map(browsers.map(browser => [browser.type, browser])).values()];
  }

  private isSessionOwnedBrowserRoot(
    commandLine: string,
    sessionId: string,
    profilePath: string,
  ): boolean {
    return isSessionOwnedBrowserRoot(commandLine, sessionId, profilePath, this.recognizedBrowsers);
  }

  private planOwnedBrowserTree(
    records: readonly BrowserProcessRecord[],
    rootPid: number,
    sessionId: string,
    profilePath: string,
  ): BrowserProcessRecord[] {
    return planOwnedBrowserTree(records, rootPid, sessionId, profilePath, this.recognizedBrowsers);
  }


  /**
   * Return the persistent browser profile directory for one al-hakim session.
   */
  getProfilePath(sessionId: string): string {
    // Enforce the session DTO's safe-name contract at the filesystem boundary too. Plugin
    // configuration and imported database rows do not necessarily pass through the REST DTO.
    if (!/^[a-zA-Z0-9-]{1,50}$/.test(sessionId)) {
      throw new Error('Unsafe browser profile session name');
    }
    // Absolute launch path must match OS process command lines during crash recovery.
    // For a relative base, this resolves to the SAME on-disk directory (no migration).
    return path.resolve(this.baseProfilePath, sessionId);
  }

  /**
   * Exclusive, filesystem-backed profile ownership across cooperating backend workers.
   *
   * The lock is outside userDataDir so a browser-profile purge cannot erase ownership.
   * A VERIFIED abandoned local lock may be recovered: the recorded process must be gone,
   * the host must match, and either no browser remains or a surviving browser must
   * have the exact old lease token, session marker, and user-data directory.
   * Unknown metadata, remote owners, live owners, and enumeration errors fail closed.
   *
   * Recovery uses an exclusive claim INSIDE the old lock directory, then atomically moves
   * that directory aside. This serializes competing recoverers without replacing a new
   * owner's lock. If recovery itself crashes while holding the claim, fail closed and
   * require operator verification; do not gamble on an automatic claim timeout.
   */
  async acquireProfileLease(
    sessionId: string,
    logger?: Pick<ReturnType<typeof createLogger>, 'warn' | 'log'>,
  ): Promise<BrowserProfileLeaseRelease> {
    const startedAt = Date.now();
    try {
      const release = await this.acquireProfileLeaseInternal(sessionId, logger);
      logger?.log('Brave profile lease acquired', {
        sessionId, eventType: 'engine.browser.lease_acquired', operation: 'acquireProfileLease',
        action: 'brave_profile_lease_acquired', status: 'succeeded', elapsedMs: elapsedBrowserMs(startedAt),
      });
      return release;
    } catch (error) {
      logger?.warn('Brave profile lease acquisition refused', {
        sessionId, eventType: 'engine.browser.lease_rejected', operation: 'acquireProfileLease',
        action: 'brave_profile_lease_rejected', status: 'failed', elapsedMs: elapsedBrowserMs(startedAt),
        reasonCode: browserFailureReason(error, BrowserFailureCode.PROFILE_RECOVERY_UNSAFE),
      });
      throw error;
    }
  }

  private async acquireProfileLeaseInternal(
    sessionId: string,
    logger?: Pick<ReturnType<typeof createLogger>, 'warn' | 'log'>,
  ): Promise<BrowserProfileLeaseRelease> {
    this.getProfilePath(sessionId); // validate before creating anything
    const root = path.join(this.baseProfilePath, '.openwa-profile-locks');
    const lockPath = path.join(root, sessionId);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await fs.chmod(root, 0o700);

    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      const recovered = await this.recoverAbandonedProfileLease(sessionId, lockPath, logger);
      if (!recovered) throw await this.profileLockedError(sessionId, lockPath);

      // A different backend can win the new lease after the old directory is moved.
      // Never adopt or overwrite that new owner's profile lock.
      try {
        await fs.mkdir(lockPath, { mode: 0o700 });
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code !== 'EEXIST') throw retryError;
        throw await this.profileLockedError(sessionId, lockPath);
      }
    }

    const token = randomUUID();
    const owner = { token, pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() };
    try {
      await fs.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      await fs.rmdir(lockPath).catch(() => undefined);
      throw error;
    }

    let released = false;
    const release = async () => {
      if (released) return;
      const startedAt = Date.now();
      try {
        // Never release a lock if the browser is still running or PID enumeration failed.
        const processes = await this.findSessionBravePids(sessionId);
        if (processes.length > 0) {
          throw new Error(`Cannot release Browser profile '${sessionId}': browser PID(s) ${processes.join(', ')} still live`);
        }
        // An external browser may use this directory without our session marker.
        await this.assertNoProcessUsesProfile(sessionId);
        const current = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')) as { token?: string };
        if (current.token !== token) throw new Error(`Browser profile '${sessionId}' lock owner changed`);
        await fs.unlink(path.join(lockPath, 'owner.json'));
        await fs.rmdir(lockPath);
        released = true;
        logger?.log('Brave profile lease released', {
          sessionId, eventType: 'engine.browser.lease_released', operation: 'releaseProfileLease',
          action: 'brave_profile_lease_released', status: 'succeeded', elapsedMs: elapsedBrowserMs(startedAt),
        });
      } catch (error) {
        logger?.warn('Brave profile lease retained because release could not be verified', {
          sessionId, eventType: 'engine.browser.lease_retained', operation: 'releaseProfileLease',
          action: 'brave_profile_lease_retained', status: 'failed', elapsedMs: elapsedBrowserMs(startedAt),
          reasonCode: BrowserFailureCode.BROWSER_TEARDOWN_INCOMPLETE,
        });
        throw error;
      }
    };
    // The token is deliberately not a log field. Teardown uses it to prove that
    // the browser belongs to THIS lease generation before signalling its OS PID.
    return Object.assign(release, { ownerToken: token });
  }

  private async profileLockedError(sessionId: string, lockPath: string): Promise<Error> {
    // Never print owner.json: it contains a lease generation token. The token is
    // process identity metadata, not information needed by an API consumer.
    const owner = await this.readProfileLeaseOwner(lockPath);
    const identity = owner ? `pid=${owner.pid}, host=${owner.host}` : 'owner metadata unavailable';
    return new BrowserLifecycleError(
      BrowserFailureCode.PROFILE_LOCKED,
      `Browser profile '${sessionId}' is locked by another owner (${identity}). ` +
      'Refusing to launch or terminate any matching browser. The owner may be active, remote, ' +
      'or unverifiable, or another recovery may be in progress. Check the owner and browser ' +
      'processes before any manual recovery.',
    );
  }

  private async readProfileLeaseOwner(lockPath: string): Promise<{
    token: string;
    pid: number;
    host: string;
    acquiredAt: string;
  } | null> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      if (
        typeof record.token !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.token) ||
        typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
        typeof record.host !== 'string' || record.host.length === 0 ||
        typeof record.acquiredAt !== 'string' || !Number.isFinite(Date.parse(record.acquiredAt))
      ) return null;
      return {
        token: record.token,
        pid: record.pid,
        host: record.host,
        acquiredAt: record.acquiredAt,
      };
    } catch {
      // Missing, partial, or unreadable metadata can be an in-progress acquisition.
      return null;
    }
  }

  private isLocalOwnerDefinitelyDead(owner: { pid: number; host: string }): boolean {
    if (owner.host.toLowerCase() !== hostname().toLowerCase()) return false;
    // PIDs can be reused. Any existing PID (even if unrelated) is treated as alive.
    // EPERM and other OS errors are unknown, never proof of owner death.
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  /**
   * Crash recovery has two separate fences:
   * 1. The old backend PID is positively absent on the SAME host.
   * 2. An exclusive recovery claim is held under the ORIGINAL profile lock.
   * A browser can be reaped only if its launch command identifies that exact
   * old lease generation. Older (pre-Phase-4) browsers lack this marker and
   * cannot be killed automatically.
   */
  private async recoverAbandonedProfileLease(
    sessionId: string,
    lockPath: string,
    logger?: Pick<ReturnType<typeof createLogger>, 'warn' | 'log'>,
  ): Promise<boolean> {
    const previous = await this.readProfileLeaseOwner(lockPath);
    if (!previous || !this.isLocalOwnerDefinitelyDead(previous)) return false;

    // Claim before inspecting/reaping: a competing backend must never run
    // recovery for the same lock simultaneously.
    const claimPath = path.join(lockPath, '.recovery-claim');
    try {
      await fs.mkdir(claimPath, { mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOENT') return false;
      throw error;
    }

    let moved = false;
    const recoveryStartedAt = Date.now();
    const claimToken = randomUUID();
    logger?.log('Brave profile recovery claim acquired', {
      sessionId, eventType: 'engine.browser.recovery_started', operation: 'recoverAbandonedProfileLease',
      action: 'brave_profile_recovery_started', status: 'started', previousOwnerPid: previous.pid,
    });
    try {
      await fs.writeFile(
        path.join(claimPath, 'owner.json'),
        JSON.stringify({ token: claimToken, pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() }),
        { flag: 'wx', mode: 0o600 },
      );

      if (!await this.isAbandonedClaimCurrent(lockPath, previous, claimToken)) {
        logger?.warn('Abandoned profile recovery skipped because the claim changed', {
          sessionId, eventType: 'engine.browser.recovery_skipped', operation: 'recoverAbandonedProfileLease',
          action: 'brave_profile_recovery_skipped', status: 'skipped',
          elapsedMs: elapsedBrowserMs(recoveryStartedAt), reasonCode: BrowserFailureCode.PROFILE_RECOVERY_UNSAFE,
        });
        return false;
      }

      const liveBefore = await this.findSessionBravePids(sessionId);
      if (liveBefore.length !== 0) {
        logger?.warn('Recovering a verified orphan Brave browser from a crashed backend', {
          sessionId, action: 'brave_orphan_recovery_started', pids: liveBefore,
        });
        await this.reapVerifiedAbandonedBrowsers(sessionId, lockPath, previous, claimToken);
      }

      // A process could have launched or become visible during recovery. Never
      // rename away the old ownership record while any matching process remains.
      if (!await this.isAbandonedClaimCurrent(lockPath, previous, claimToken)) {
        logger?.warn('Abandoned profile recovery skipped because the claim changed', {
          sessionId, eventType: 'engine.browser.recovery_skipped', operation: 'recoverAbandonedProfileLease',
          action: 'brave_profile_recovery_skipped', status: 'skipped',
          elapsedMs: elapsedBrowserMs(recoveryStartedAt), reasonCode: BrowserFailureCode.PROFILE_RECOVERY_UNSAFE,
        });
        return false;
      }
      if ((await this.findSessionBravePids(sessionId)).length !== 0) {
        throw new Error(`Browser profile '${sessionId}': orphan browser still present after recovery`);
      }
      // A manually launched Brave without our session marker could still hold
      // exactly this user-data directory. Never unlock based on the marker alone.
      const profilePath = path.resolve(this.getProfilePath(sessionId));
      if ((await this.inspectAllProcessRecords()).some(record =>
          this.commandLineUsesProfile(record.commandLine, profilePath))) {
        throw new Error(`BROWSER_ORPHAN_RECOVERY_UNSAFE: profile '${sessionId}' is still in use`);
      }

      const quarantinePath = `${lockPath}.recovered-${randomUUID()}`;
      // Only the ownership directory is moved, NEVER the persistent browser profile.
      await fs.rename(lockPath, quarantinePath);
      moved = true;
      await fs.rm(quarantinePath, { recursive: true, force: true }).catch(() => undefined);
      logger?.log('Recovered an abandoned local Brave profile lease', {
        sessionId, action: 'brave_abandoned_lease_recovered',
        eventType: 'engine.browser.recovery_succeeded', operation: 'recoverAbandonedProfileLease',
        status: 'succeeded', elapsedMs: elapsedBrowserMs(recoveryStartedAt), previousOwnerPid: previous.pid,
      });
      return true;
    } catch (error) {
      logger?.warn('Brave abandoned-profile recovery failed; ownership retained', {
        sessionId, eventType: 'engine.browser.recovery_failed', operation: 'recoverAbandonedProfileLease',
        action: 'brave_profile_recovery_failed', status: 'failed',
        elapsedMs: elapsedBrowserMs(recoveryStartedAt), previousOwnerPid: previous.pid,
        reasonCode: browserFailureReason(error, BrowserFailureCode.PROFILE_RECOVERY_UNSAFE),
      });
      throw error;
    } finally {
      if (!moved) {
        const claim = await this.readProfileLeaseOwner(claimPath);
        if (claim?.token === claimToken) {
          await fs.rm(claimPath, { recursive: true, force: true }).catch(() => undefined);
        } else {
          await fs.rmdir(claimPath).catch(() => undefined);
        }
      }
    }
  }

  private async isAbandonedClaimCurrent(
    lockPath: string,
    expected: { token: string; pid: number; host: string; acquiredAt: string },
    claimToken: string,
  ): Promise<boolean> {
    const [current, claim] = await Promise.all([
      this.readProfileLeaseOwner(lockPath),
      this.readProfileLeaseOwner(path.join(lockPath, '.recovery-claim')),
    ]);
    return Boolean(
      current && current.token === expected.token && current.pid === expected.pid &&
      current.host === expected.host && current.acquiredAt === expected.acquiredAt &&
      this.isLocalOwnerDefinitelyDead(current) &&
      claim && claim.token === claimToken && claim.pid === process.pid &&
      claim.host.toLowerCase() === hostname().toLowerCase(),
    );
  }

  /**
   * Map every session-marked process to a verified, token-matching browser root.
   * An unmarked child is allowed only if the OS process tree links it to that root.
   * A marked process with the wrong token/profile, or an unaccounted marker PID,
   * is an unsafe conflict (never permission to kill it).
   */
  private async reapVerifiedAbandonedBrowsers(
    sessionId: string,
    lockPath: string,
    oldOwner: { token: string; pid: number; host: string; acquiredAt: string },
    claimToken: string,
  ): Promise<void> {
    const profilePath = path.resolve(this.getProfilePath(sessionId));
    const snapshot = await this.inspectAllProcessRecords();
    const marked = snapshot.filter(record =>
      this.commandLineHasMarker(record.commandLine, this.getSessionMarker(sessionId)));
    const roots = marked.filter(record =>
      this.isSessionOwnedBrowserRoot(record.commandLine, sessionId, profilePath));
    const expectedArg = `--al-hakim-lease=${oldOwner.token}`;

    if (!roots.length || roots.some(root => !this.commandLineHasMarker(root.commandLine, expectedArg))) {
      throw new Error(`BROWSER_ORPHAN_RECOVERY_UNSAFE: browser session '${sessionId}' has no verified old-lease root`);
    }

    const plans = roots.map(root => this.planOwnedBrowserTree(snapshot, root.pid, sessionId, profilePath));
    const accounted = new Set(plans.flatMap(plan => plan.map(item => item.pid)));
    if (marked.some(processRecord => !accounted.has(processRecord.pid))) {
      throw new Error(`BROWSER_ORPHAN_RECOVERY_UNSAFE: session '${sessionId}' has an unverified marked process`);
    }
    // Compare the independent marker enumeration with the detailed process
    // snapshot. A disappearing process is okay only if a fresh scan confirms it.
    const independentlyMarked = await this.findSessionBravePids(sessionId);
    const unaccounted = independentlyMarked.filter(pid => !accounted.has(pid));
    if (unaccounted.length !== 0 && (await this.findSessionBravePids(sessionId))
      .some(pid => unaccounted.includes(pid))) {
      throw new Error(`BROWSER_ORPHAN_RECOVERY_UNSAFE: incomplete process inspection for '${sessionId}'`);
    }

    for (const root of roots) {
      if (!await this.isAbandonedClaimCurrent(lockPath, oldOwner, claimToken)) {
        throw new Error('BROWSER_ORPHAN_RECOVERY_UNSAFE: old lease or recovery claim changed');
      }
      await this.terminateVerifiedAbandonedTree(
        sessionId, root, profilePath, lockPath, oldOwner, claimToken,
      );
    }
    await this.sleep(ORPHAN_EXIT_SETTLE_MS);
    if ((await this.findSessionBravePids(sessionId)).length !== 0) {
      throw new Error(`BROWSER_ORPHAN_RECOVERY_UNSAFE: browser for '${sessionId}' survived termination`);
    }
    // Verify captured children too, not just roots. Chromium child processes
    // commonly lack the application-specific --al-hakim-session marker.
    const remaining = await this.inspectAllProcessRecords();
    for (const planned of plans.flat()) {
      if (remaining.some(record => record.pid === planned.pid &&
          record.commandLine === planned.commandLine)) {
        throw new Error(`BROWSER_ORPHAN_RECOVERY_UNSAFE: Browser descendant PID ${planned.pid} still alive`);
      }
    }
  }

  private async terminateVerifiedAbandonedTree(
    sessionId: string,
    originalRoot: BrowserProcessRecord,
    profilePath: string,
    lockPath: string,
    oldOwner: { token: string; pid: number; host: string; acquiredAt: string },
    claimToken: string,
  ): Promise<void> {
    const originalRecords = await this.inspectProcessTree(originalRoot.pid);
    const originalPlan = this.planOwnedBrowserTree(originalRecords, originalRoot.pid, sessionId, profilePath);
    if (!originalPlan.length) return; // Exited between snapshots.
    const expectedArg = `--al-hakim-lease=${oldOwner.token}`;
    if (originalPlan[originalPlan.length - 1].commandLine !== originalRoot.commandLine ||
        !this.commandLineHasMarker(originalRoot.commandLine, expectedArg)) {
      throw new Error('BROWSER_ORPHAN_RECOVERY_UNSAFE: browser root changed identity');
    }
    if (!await this.isAbandonedClaimCurrent(lockPath, oldOwner, claimToken)) {
      throw new Error('BROWSER_ORPHAN_RECOVERY_UNSAFE: old lease or recovery claim changed');
    }

    if (process.platform === 'win32') {
      // taskkill /T includes the verified root's children. Never kill by image name.
      const latest = this.planOwnedBrowserTree(
        await this.inspectProcessTree(originalRoot.pid), originalRoot.pid, sessionId, profilePath,
      );
      if (!latest.length) return;
      if (latest[latest.length - 1].commandLine !== originalRoot.commandLine ||
          !await this.isAbandonedClaimCurrent(lockPath, oldOwner, claimToken)) {
        throw new Error('BROWSER_ORPHAN_RECOVERY_UNSAFE: browser changed before taskkill');
      }
      try {
        await execFileAsync('taskkill.exe', ['/PID', String(originalRoot.pid), '/T', '/F'], {
          windowsHide: true, timeout: OWNED_TREE_INSPECTION_TIMEOUT_MS,
          maxBuffer: PROCESS_LIST_MAX_BUFFER,
        });
      } catch (error) {
        if (this.planOwnedBrowserTree(
          await this.inspectProcessTree(originalRoot.pid), originalRoot.pid, sessionId, profilePath,
        ).length > 0) throw error;
      }
    } else {
      for (const item of originalPlan) {
        if (!await this.isAbandonedClaimCurrent(lockPath, oldOwner, claimToken)) {
          throw new Error('BROWSER_ORPHAN_RECOVERY_UNSAFE: old lease or claim changed during termination');
        }
        const latest = await this.inspectProcessTree(originalRoot.pid);
        const plan = this.planOwnedBrowserTree(latest, originalRoot.pid, sessionId, profilePath);
        const current = plan.find(record => record.pid === item.pid);
        if (!current) continue;
        if (current.parentPid !== item.parentPid || current.commandLine !== item.commandLine) {
          throw new Error(`BROWSER_ORPHAN_RECOVERY_UNSAFE: PID ${item.pid} changed identity`);
        }
        try {
          process.kill(item.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
  }

  /** Exact --user-data-dir match, including quoted Windows paths with spaces. */
  private commandLineUsesProfile(commandLine: string, profilePath: string): boolean {
    const windows = process.platform === 'win32';
    const cmd = windows ? commandLine.replace(/\\/g, '/').toLowerCase() : commandLine;
    const profile = windows ? profilePath.replace(/\\/g, '/').toLowerCase() : profilePath;
    const escaped = profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\s)"?--user-data-dir=(?:"${escaped}"|${escaped})"?(?=$|\\s)`).test(cmd);
  }

  /**
   * Even an unmarked process can own Chromium's user-data directory. Do not
   * remove singleton locks or release the filesystem lease while such a
   * process might still be running. Process-inventory errors fail closed.
   */
  private async assertNoProcessUsesProfile(sessionId: string): Promise<void> {
    const profilePath = path.resolve(this.getProfilePath(sessionId));
    const matching = (await this.inspectAllProcessRecords()).filter(record =>
      this.commandLineUsesProfile(record.commandLine, profilePath));
    if (matching.length !== 0) {
      throw new Error(
        `BROWSER_PROFILE_IN_USE: profile '${sessionId}' is still in use by PID(s): ` +
        matching.map(record => record.pid).join(', '),
      );
    }
  }

  /** Full PID/PPID/command-line snapshot for orphan root and child verification. */
  private async inspectAllProcessRecords(): Promise<BrowserProcessRecord[]> {
    if (process.platform !== 'win32') return this.inspectProcessTree(0);
    const script = 'Get-CimInstance Win32_Process | ' +
      'Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress';
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
    ], {
      windowsHide: true, timeout: OWNED_TREE_INSPECTION_TIMEOUT_MS,
      maxBuffer: PROCESS_LIST_MAX_BUFFER,
    });
    const raw = String(stdout).trim();
    if (!raw) throw new Error('BROWSER_ORPHAN_RECOVERY_UNSAFE: empty Windows process inventory');
    const parsed: unknown = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const row = item as { ProcessId?: unknown; ParentProcessId?: unknown; CommandLine?: unknown };
      if (typeof row.CommandLine !== 'string') return [];
      if (!Number.isSafeInteger(row.ProcessId) || !Number.isSafeInteger(row.ParentProcessId)) {
        throw new Error('BROWSER_ORPHAN_RECOVERY_UNSAFE: malformed Windows process inventory');
      }
      return [{ pid: row.ProcessId as number, parentPid: row.ParentProcessId as number,
        commandLine: row.CommandLine }];
    });
  }

  /** Refuse destructive credential purge when any worker still holds a profile lock. */
  async assertProfileUnlocked(sessionId: string): Promise<void> {
    this.getProfilePath(sessionId);
    const lockPath = path.join(this.baseProfilePath, '.openwa-profile-locks', sessionId);
    try {
      await fs.stat(lockPath);
      throw new Error(`Cannot purge Browser profile '${sessionId}': ownership lock is still present`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  /**
   * True when the session's Brave profile directory exists.
   */
  async profileExists(sessionId: string): Promise<boolean> {
    try {
      await fs.access(this.getProfilePath(sessionId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create the persistent profile directory when it does not already exist.
   */
  async ensureProfile(sessionId: string): Promise<void> {
    const dir = this.getProfilePath(sessionId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // mkdir(mode) does NOT tighten a previously existing directory. This folder holds browser
    // identity secrets. On POSIX, fail initialization if we cannot lock down its permissions.
    // Windows ACLs require separate OS-level deployment controls; chmod does not establish them.
    if (process.platform !== 'win32') await fs.chmod(dir, 0o700);
  }

  /**
   * Permanently remove a Brave profile.
   *
   * Used only by the session-delete purge flow.
   */
  async deleteProfile(sessionId: string): Promise<void> {
    const profilePath = this.getProfilePath(sessionId);

    try {
      await fs.rm(profilePath, {
        recursive: true,
        force: true,
      });
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;

      if (nodeError.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * Refuse startup while another marked browser may still own the profile.
   *
   * The lifecycle adds:
   *
   *   --al-hakim-session=<sessionName>
   *
   * to the Brave command line.
   *
   * Windows:
   *   Win32_Process.CommandLine through PowerShell/CIM.
   *
   * POSIX:
   *   `ps -eo pid=,args=` parsed in Node.
   *
   * IMPORTANT:
   *
   * A process-enumeration failure is NOT treated as "no orphan".
   * If we cannot prove the old Brave process is gone, startup fails instead
   * of deleting Singleton lock files underneath a possibly live browser.
   */
  async killOrphanedBraveProcesses(
    sessionId: string,
    logger: ReturnType<typeof createLogger>,
    // Retained for legacy signature compatibility; true is rejected because marker
    // matching alone cannot prove safe process ownership.
    allowOwnedRecovery = false,
  ): Promise<void> {
    let pids: number[];

    try {
      pids = await this.findSessionBravePids(sessionId);
    } catch (error) {
      logger.warn(
        'Unable to enumerate Brave processes; refusing unsafe profile-lock cleanup',
        {
          sessionId,
          platform: process.platform,
          action: 'brave_orphan_enumeration_failed',
          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
      );

      throw error;
    }

    if (pids.length === 0) {
      await this.assertNoProcessUsesProfile(sessionId);
      return;
    }

    // The session marker identifies candidates, not ownership. Even an explicit
    // allowOwnedRecovery=true is insufficient to kill a process. A verified
    // lease-generation token, profile path and process tree are required; those
    // checks live in recoverAbandonedProfileLease()/terminateOwnedBrowserTree().
    // No current production caller uses allowOwnedRecovery=true. Fail closed.
    logger.warn('Existing marked browser process blocks profile startup; refusing unsafe reaping', {
      sessionId,
      action: 'brave_process_owner_not_verified',
      pids,
    });
    if (allowOwnedRecovery) {
      throw new Error(
        `BROWSER_ORPHAN_RECOVERY_UNSAFE: refusing marker-only recovery for '${sessionId}'; ` +
        'use verified ownership recovery instead',
      );
    }
    throw new Error(
      `Browser profile '${sessionId}' still has marked browser process(es): ${pids.join(', ')}. ` +
      'A session marker does not prove the process is an orphan; verify the old owner is stopped.',
    );
  }

  /** Browser-independent name for startup's fail-closed marked-process verification. */
  async assertNoConflictingBrowserProcesses(
    sessionId: string,
    logger: ReturnType<typeof createLogger>,
  ): Promise<void> {
    await this.killOrphanedBraveProcesses(sessionId, logger, false);
  }

  /**
   * Terminate the process tree belonging to THIS adapter's captured Brave PID.
   * Used only for explicit forced teardown (not startup / Phase 1 stale-lock recovery).
   * Process identity is revalidated before signalling; unknown identity fails closed.
   * Windows taskkill /T targets children of the VERIFIED PID, not every brave.exe.
   * POSIX descendants are verified against the recorded parent tree before SIGKILL.
   */
  async terminateOwnedBrowserTree(
    sessionId: string,
    browserPid: number,
    logger: ReturnType<typeof createLogger>,
    ownerToken: string,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.terminateOwnedBrowserTreeInternal(sessionId, browserPid, logger, ownerToken);
      logger.log?.('Verified Brave process-tree termination completed', {
        sessionId, browserPid, action: 'brave_owned_tree_terminated',
        eventType: 'engine.browser.termination_succeeded', operation: 'terminateOwnedBrowserTree',
        status: 'succeeded', elapsedMs: elapsedBrowserMs(startedAt),
      });
    } catch (error) {
      logger.warn?.('Verified Brave process-tree termination failed', {
        sessionId, browserPid, action: 'brave_owned_tree_termination_failed',
        eventType: 'engine.browser.termination_failed', operation: 'terminateOwnedBrowserTree',
        status: 'failed', elapsedMs: elapsedBrowserMs(startedAt),
        reasonCode: BrowserFailureCode.BROWSER_TERMINATION_FAILED,
      });
      throw error;
    }
  }

  private async terminateOwnedBrowserTreeInternal(
    sessionId: string,
    browserPid: number,
    logger: ReturnType<typeof createLogger>,
    ownerToken: string,
  ): Promise<void> {
    const profilePath = path.resolve(this.getProfilePath(sessionId));
    await this.assertLocalProfileLeaseOwner(sessionId, ownerToken);
    if (!Number.isSafeInteger(browserPid) || browserPid <= 0) {
      throw new Error('No valid captured browser PID for targeted process-tree termination');
    }
    const initial = await this.inspectProcessTree(browserPid);
    const plan = this.planOwnedBrowserTree(initial, browserPid, sessionId, profilePath);
    if (plan.length === 0) return; // Exited between capture and verification.

    logger.warn('Terminating verified session-owned browser process tree', {
      sessionId, browserPid, action: 'brave_owned_tree_terminate',
      pids: plan.map(record => record.pid),
    });

    if (process.platform === 'win32') {
      // Revalidate immediately before taskkill. taskkill /T /F includes Chromium
      // children; taskkill /IM brave.exe would kill unrelated WhatsApp sessions.
      const current = this.planOwnedBrowserTree(
        await this.inspectProcessTree(browserPid), browserPid, sessionId, profilePath,
      );
      if (current.length === 0) return;
      await this.assertLocalProfileLeaseOwner(sessionId, ownerToken);
      try {
        await execFileAsync('taskkill.exe', ['/PID', String(browserPid), '/T', '/F'], {
          windowsHide: true, timeout: OWNED_TREE_INSPECTION_TIMEOUT_MS,
          maxBuffer: PROCESS_LIST_MAX_BUFFER,
        });
      } catch (error) {
        // The PID might have exited after verification; prove this before accepting.
        if (this.planOwnedBrowserTree(await this.inspectProcessTree(browserPid), browserPid, sessionId, profilePath).length) {
          throw error;
        }
      }
    } else {
      // Signal descendants before their parent so they do not get reparented.
      for (const original of plan) {
        await this.assertLocalProfileLeaseOwner(sessionId, ownerToken);
        const latest = await this.inspectProcessTree(browserPid);
        const live = latest.find(record => record.pid === original.pid);
        if (!live) continue;
        if (live.parentPid !== original.parentPid || live.commandLine !== original.commandLine) {
          throw new Error(`PID ${original.pid} changed identity during Brave teardown`);
        }
        // Require that the verified root still owns this tree, except when checking
        // the root itself. Never kill an unrelated PID following a process restart.
        const current = this.planOwnedBrowserTree(latest, browserPid, sessionId, profilePath);
        if (!current.some(record => record.pid === original.pid)) {
          throw new Error(`Browser descendant PID ${original.pid} no longer belongs to captured tree`);
        }
        try {
          process.kill(original.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }

    await this.sleep(PROCESS_KILL_SETTLE_MS);
    const survivors = await this.inspectProcessTree(browserPid);
    const stillOwned = plan.some(original => {
      const now = survivors.find(record => record.pid === original.pid);
      return now && now.commandLine === original.commandLine;
    });
    if (stillOwned) {
      throw new Error(`Browser process tree for session '${sessionId}' did not exit completely`);
    }
  }

  /** Prevent a retired adapter from terminating a new owner's browser. */
  private async assertLocalProfileLeaseOwner(sessionId: string, ownerToken: string): Promise<void> {
    if (!ownerToken || typeof ownerToken !== 'string') {
      throw new Error(`Browser profile '${sessionId}' has no verified owner token for termination`);
    }
    const owner = await this.readProfileLeaseOwner(
      path.join(this.baseProfilePath, '.openwa-profile-locks', sessionId),
    );
    if (!owner || owner.token !== ownerToken || owner.pid !== process.pid ||
        owner.host.toLowerCase() !== hostname().toLowerCase()) {
      throw new Error(`Browser profile '${sessionId}' ownership changed; refusing browser termination`);
    }
  }

  /** A snapshot with PID, parent PID and command line (not just an unverified PID). */
  private async inspectProcessTree(browserPid: number): Promise<BrowserProcessRecord[]> {
    if (process.platform === 'win32') {
      // Only root identity is required: taskkill /T does the child traversal itself.
      const script =
        '$pidToInspect = [int]$env:ALHAKIM_BROWSER_PID; ' +
        'Get-CimInstance Win32_Process -Filter "ProcessId = $pidToInspect" | ' +
        'Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress';
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
      ], {
        env: { ...process.env, ALHAKIM_BROWSER_PID: String(browserPid) },
        windowsHide: true, timeout: OWNED_TREE_INSPECTION_TIMEOUT_MS,
        maxBuffer: PROCESS_LIST_MAX_BUFFER,
      });
      const raw = String(stdout).trim();
      if (!raw) return [];
      const record = JSON.parse(raw) as {
        ProcessId?: number; ParentProcessId?: number; CommandLine?: string | null;
      };
      if (!Number.isSafeInteger(record.ProcessId) || typeof record.CommandLine !== 'string') {
        throw new Error('Unable to verify browser command line on Windows');
      }
      return [{ pid: record.ProcessId!, parentPid: record.ParentProcessId ?? 0, commandLine: record.CommandLine }];
    }
    const { stdout } = await execFileAsync('ps', ['-ww', '-eo', 'pid=,ppid=,args='], {
      timeout: OWNED_TREE_INSPECTION_TIMEOUT_MS,
      maxBuffer: PROCESS_LIST_MAX_BUFFER,
    });
    return String(stdout).split(/\r?\n/).flatMap(line => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      return match ? [{
        pid: Number(match[1]), parentPid: Number(match[2]), commandLine: match[3],
      }] : [];
    });
  }

  /**
   * Remove stale Brave/Chromium singleton files.
   *
   * Before deleting anything, independently verify that no process carrying
   * this session's marker is still alive.
   *
   * This verification is intentionally repeated here even though the normal
   * lifecycle calls killOrphanedBraveProcesses() immediately before this.
   */
  async removeStaleSingletonFiles(
    sessionId: string,
    logger: ReturnType<typeof createLogger>,
  ): Promise<void> {
    let livePids: number[];

    try {
      livePids =
        await this.findSessionBravePids(
          sessionId,
        );
    } catch (error) {
      logger.warn(
        'Unable to verify Brave profile ownership; refusing to remove Singleton files',
        {
          sessionId,
          platform: process.platform,
          action: 'brave_singleton_verification_failed',
          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
      );

      throw error;
    }

    if (livePids.length > 0) {
      const error =
        new Error(
          `Refusing to remove Brave Singleton files while session '${sessionId}' ` +
            `is still owned by PID(s): ${livePids.join(', ')}`,
        );

      logger.warn(
        'Refusing to remove Brave Singleton files while a matching process is alive',
        {
          sessionId,
          action: 'brave_singleton_live_owner',
          pids: livePids,
        },
      );

      throw error;
    }

    // A browser without our marker can still hold the same directory.
    await this.assertNoProcessUsesProfile(sessionId);

    const profilePath =
      this.getProfilePath(
        sessionId,
      );

    const singletonFiles = [
      'SingletonLock',
      'SingletonSocket',
      'SingletonCookie',
    ];

    for (const file of singletonFiles) {
      const filePath =
        path.join(
          profilePath,
          file,
        );

      try {
        await fs.unlink(
          filePath,
        );

        logger.log(
          `Removed stale ${file} from Brave profile`,
          {
            sessionId,
            action: 'brave_singleton_removed',
            file,
          },
        );
      } catch (error) {
        const nodeError =
          error as NodeJS.ErrnoException;

        if (
          nodeError.code !==
          'ENOENT'
        ) {
          logger.warn(
            `Failed to remove stale ${file}`,
            {
              sessionId,
              action:
                'brave_singleton_remove_failed',
              file,
              error:
                nodeError.message,
            },
          );
        }
      }
    }
  }

  /**
   * The marker placed on Brave's command line for this session.
   */
  private getSessionMarker(
    sessionId: string,
  ): string {
    return `--al-hakim-session=${sessionId}`;
  }

  /**
   * Enumerate PIDs carrying the exact al-hakim session marker.
   */
  private async findSessionBravePids(
    sessionId: string,
  ): Promise<number[]> {
    // Compatibility seam: existing Brave tests override this method directly.
    // The implementation is browser-neutral and scans exact session markers.
    return this.findSessionBrowserPids(sessionId);
  }

  private async findSessionBrowserPids(
    sessionId: string,
  ): Promise<number[]> {
    const marker =
      this.getSessionMarker(
        sessionId,
      );

    if (
      process.platform ===
      'win32'
    ) {
      return this.findWindowsSessionPids(
        marker,
      );
    }

    return this.findPosixSessionPids(
      marker,
    );
  }

  /**
   * Windows implementation using Win32_Process.CommandLine.
   */
  private async findWindowsSessionPids(
    marker: string,
  ): Promise<number[]> {
    /*
     * The marker is passed through the environment rather than interpolated
     * into the PowerShell command.
     *
     * The regex requires whitespace boundaries so:
     *
     *   --al-hakim-session=foo
     *
     * does NOT accidentally match:
     *
     *   --al-hakim-session=foobar
     */
    const powershellScript =
      '$marker = $env:al_hakim_SESSION_MARKER; ' +
      "$pattern = '(?:^|\\s)' + [regex]::Escape($marker) + '(?=$|\\s)'; " +
      'Get-CimInstance Win32_Process | ' +
      'Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern } | ' +
      'ForEach-Object { $_.ProcessId }';

    const env = {
      ...process.env,
      al_hakim_SESSION_MARKER:
        marker,
    };

    let lastError:
      unknown;

    /*
     * Windows PowerShell is normally present on Windows.
     * PowerShell 7 is a fallback when only pwsh is installed.
     */
    for (
      const executable
      of [
        'powershell.exe',
        'pwsh.exe',
      ]
    ) {
      try {
        const {
          stdout,
        } =
          await execFileAsync(
            executable,
            [
              '-NoLogo',
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              powershellScript,
            ],
            {
              windowsHide:
                true,

              env,

              maxBuffer:
                PROCESS_LIST_MAX_BUFFER,
              timeout: OWNED_TREE_INSPECTION_TIMEOUT_MS,
            },
          );

        return this.parsePidLines(
          String(
            stdout,
          ),
        );
      } catch (error) {
        lastError =
          error;

        const nodeError =
          error as NodeJS.ErrnoException;

        /*
         * Missing executable:
         * try the next PowerShell implementation.
         *
         * Any other error means process ownership could not be verified.
         */
        if (
          nodeError.code ===
          'ENOENT'
        ) {
          continue;
        }

        throw error;
      }
    }

    throw lastError instanceof
      Error
      ? lastError
      : new Error(
          'Neither powershell.exe nor pwsh.exe is available to enumerate Brave processes',
        );
  }

  /**
   * POSIX implementation.
   *
   * No grep/awk shell pipeline and no session-id interpolation.
   */
  private async findPosixSessionPids(
    marker: string,
  ): Promise<number[]> {
    const {
      stdout,
    } =
      await execFileAsync(
        'ps',
        [
          '-eo',
          'pid=,args=',
        ],
        {
          maxBuffer:
            PROCESS_LIST_MAX_BUFFER,
          timeout: OWNED_TREE_INSPECTION_TIMEOUT_MS,
        },
      );

    const pids =
      new Set<number>();

    for (
      const line
      of String(
        stdout,
      ).split(
        /\r?\n/,
      )
    ) {
      const match =
        line.match(
          /^\s*(\d+)\s+(.*)$/,
        );

      if (!match) {
        continue;
      }

      const pid =
        Number(
          match[1],
        );

      const commandLine =
        match[2];

      if (
        Number.isInteger(
          pid,
        ) &&
        pid > 0 &&
        pid !==
          process.pid &&
        this.commandLineHasMarker(
          commandLine,
          marker,
        )
      ) {
        pids.add(
          pid,
        );
      }
    }

    return [
      ...pids,
    ];
  }

  /**
   * Match the marker as a complete argument rather than a prefix.
   */
  private commandLineHasMarker(
    commandLine: string,
    marker: string,
  ): boolean {
    const escaped =
      marker.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
      );

    return new RegExp(
      `(?:^|\\s)${escaped}(?=$|\\s)`,
    ).test(
      commandLine,
    );
  }

  /**
   * Parse one PID per line.
   */
  private parsePidLines(
    stdout: string,
  ): number[] {
    const pids =
      new Set<number>();

    for (
      const raw
      of stdout.split(
        /\r?\n/,
      )
    ) {
      const value =
        raw.trim();

      if (
        !/^\d+$/.test(
          value,
        )
      ) {
        continue;
      }

      const pid =
        Number(
          value,
        );

      if (
        Number.isInteger(
          pid,
        ) &&
        pid > 0 &&
        pid !==
          process.pid
      ) {
        pids.add(
          pid,
        );
      }
    }

    return [
      ...pids,
    ];
  }

  private sleep(
    ms: number,
  ): Promise<void> {
    return new Promise(
      resolve =>
        setTimeout(
          resolve,
          ms,
        ),
    );
  }
}

