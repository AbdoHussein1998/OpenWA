import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import type { LoggerService } from '../../common/services/logger.service';

/**
 * Chromium/Brave profile hygiene run before a browser launches.
 *
 * This file is being MIGRATED to BraveProfileManager. These functions remain as
 * thin wrappers for backward compatibility during the transition.
 */

type HygieneLogger = Pick<LoggerService, 'debug' | 'log'>;

/**
 * SIGKILL any browser (Chromium OR Brave) orphaned by a previous process lifetime.
 * 
 * CHANGE: The regex now matches BOTH Chromium and Brave process names.
 * Before: /chrome|chromium|headless/i
 * After:  /chrome|chromium|headless|brave/i
 * 
 * WHY: Brave processes appear as 'brave' or 'brave-browser' in ps output.
 * Without this change, orphaned Brave processes survive and hold profile locks.
 */
export async function killOrphanedChromiumProcesses(sessionId: string, logger: HygieneLogger): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    logger.debug(`Skipping orphaned browser sweep: unsupported platform ${process.platform}`);
    return;
  }
  try {
    const psOutput = await new Promise<string>((resolve, reject) => {
      execFile('ps', ['-eo', 'pid=,args='], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(error instanceof Error ? error : new Error(error.message));
        else resolve(stdout);
      });
    });

    const marker = `--openwa-session=${sessionId}`;
    const markerRe = new RegExp('(?:^|\\s)' + marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$)');
    const killedPids: number[] = [];

    for (const line of psOutput.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const args = match[2];

      if (pid === process.pid || !markerRe.test(args)) continue;

      // ═══════════════════════════════════════════════════════════════════════
      // CRITICAL CHANGE: Process name matching
      // ═══════════════════════════════════════════════════════════════════════
      // BEFORE: Only matched Chrome/Chromium/Headless processes
      //   if (!/chrome|chromium|headless/i.test(args)) continue;
      //
      // AFTER: Also matches Brave processes
      //   Brave binary names: 'brave', 'brave-browser', 'Brave Browser'
      //
      // WHY: The marker arg identifies the SESSION, but the process name filter
      // prevents killing a 'grep' or 'cat' that happens to contain the marker string.
      // Brave must be in this whitelist or orphaned Brave processes survive forever.
      // ═══════════════════════════════════════════════════════════════════════
      if (!/chrome|chromium|headless|brave/i.test(args)) continue;
      // ═══════════════════════════════════════════════════════════════════════

      try {
        process.kill(pid, 'SIGKILL');
        killedPids.push(pid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          logger.debug(`Could not SIGKILL orphaned browser pid ${pid}`, { error: String(error) });
        }
      }
    }

    if (killedPids.length > 0) {
      logger.log(
        `Killed ${killedPids.length} orphaned browser process(es) left over from a previous process lifetime`,
        { sessionId, pids: killedPids },
      );
    }
  } catch (error) {
    logger.debug('Could not enumerate processes for the orphaned browser sweep', { error: String(error) });
  }
}

/**
 * Remove SingletonLock/SingletonSocket/SingletonCookie from a profile directory.
 * 
 * CHANGE: The profile directory path is now configurable.
 * Before: Hardcoded to sessionDataPath/session-<id> (LocalAuth path)
 * After:  Accepts the profile directory as a parameter
 * 
 * WHY: Brave profiles live at /data/brave-profiles/<sessionId>, NOT in the
 * LocalAuth sessionDataPath. The old path would clean the wrong directory.
 */
export async function removeStaleSingletonFiles(
  sessionId: string,
  profileDir: string,        // <-- CHANGED: was sessionDataPath: string
  logger: HygieneLogger,
): Promise<void> {
  // ═══════════════════════════════════════════════════════════════════════
  // PATH RESOLUTION CHANGE
  // ═══════════════════════════════════════════════════════════════════════
  // BEFORE: Computed the path internally from sessionDataPath
  //   const profileDir = path.join(path.resolve(sessionDataPath), `session-${sessionId}`);
  //
  // AFTER: Accepts the full profile directory path directly
  //   The caller (BraveProfileManager) passes the resolved Brave profile path.
  //
  // WHY: Decouples this function from path construction logic. The BraveProfileManager
  // knows where profiles live; this function just cleans whatever directory it's given.
  // ═══════════════════════════════════════════════════════════════════════

  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      await fs.promises.rm(path.join(profileDir, name), { force: true });
    } catch (error) {
      logger.debug(`Could not remove stale ${name} from ${profileDir}`, { error: String(error) });
    }
  }
}




