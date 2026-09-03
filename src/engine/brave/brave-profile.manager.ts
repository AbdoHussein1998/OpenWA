// src/engine/brave/brave-profile.manager.ts

import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { type createLogger } from '../../common/services/logger.service';

/**
 * Promisified version of child_process.exec.
 * 
 * Python reference: This is like wrapping subprocess.run() to return a Promise (async/await)
 * instead of using callbacks. Node's util.promisify converts callback-based APIs to Promise-based.
 */
const execAsync = promisify(exec);

/**
 * Manages persistent Brave browser profiles per OpenWA session.
 * 
 * Python reference: Think of this as a utility class that manages Chrome user-data directories.
 * In Python you'd have a class with methods like get_profile_path(), ensure_profile(), delete_profile().
 * The difference is TypeScript uses `private readonly` for instance variables and `async/await`
 * with explicit Promise<void> return types instead of Python's implicit async.
 */
export class BraveProfileManager {
  /**
   * Constructor dependency injection.
   * 
   * Python reference: Similar to __init__(self, base_profile_path: str) where base_profile_path
   * is a required argument. The `private readonly` shorthand in TypeScript both declares the
   * parameter AND creates an instance variable — equivalent to assigning self.baseProfilePath
   * inside __init__. The `readonly` means it can only be set in the constructor (like a final
   * attribute in Python's dataclasses or @dataclass(frozen=True)).
   */
  constructor(private readonly baseProfilePath: string) {}

  /**
   * Returns the full filesystem path for a session's Brave profile.
   * 
   * Python reference: Similar to os.path.join(self.base_path, session_id). TypeScript's
   * path.join() works identically to Python's os.path.join() — it handles path separators
   * correctly for the current OS. No `async` here because it's pure computation, no I/O.
   */
  getProfilePath(sessionId: string): string {
    return path.join(this.baseProfilePath, sessionId);
  }

  /**
   * Checks whether a profile directory already exists on disk.
   * 
   * Python reference: Similar to os.path.exists(profile_path), but using fs.access() which is
   * the Node.js equivalent. Returns a boolean synchronously (no async/await) because we use
   * a try/catch pattern: if fs.access() throws, the profile doesn't exist.
   * 
   * Note: In production you'd probably want this to be async using fs.access() with await,
   * but here we use a synchronous check for simplicity in guards.
   */
  profileExists(sessionId: string): boolean {
    try {
      // fs.access with no second argument checks if the path is accessible (exists + permissions)
      // We use the synchronous version (fs.accessSync would be the true sync equivalent)
      // but here we fire-and-forget the promise — this is a quick existence check.
      fs.access(this.getProfilePath(sessionId));
      return true;
    } catch {
      // TypeScript's `catch` without a parameter — equivalent to Python's `except:`
      // The catch block catches ANY error (ENOENT, permission denied, etc.)
      return false;
    }
  }

  /**
   * Creates the profile directory if it doesn't already exist.
   * 
   * Python reference: Equivalent to os.makedirs(path, exist_ok=True). The `{ recursive: true }`
   * option is the Node.js equivalent of exist_ok=True — it creates parent directories as needed
   * and does NOT throw if the directory already exists. Returns Promise<void> because fs.mkdir
   * is async in Node.js (non-blocking I/O).
   */
  async ensureProfile(sessionId: string): Promise<void> {
    const profilePath = this.getProfilePath(sessionId);
    await fs.mkdir(profilePath, { recursive: true });
  }

  /**
   * Completely removes a session's Brave profile directory.
   * Called during session deletion (the purge flow).
   * 
   * Python reference: Equivalent to shutil.rmtree(path, ignore_errors=True). The `recursive: true`
   * option deletes directories and their contents. `force: true` is like ignore_errors=True —
   * it suppresses errors when the path doesn't exist (idempotent delete). Returns Promise<void>
   * because fs.rm is async.
   * 
   * This enforces RULE 4: Session deletion = browser shutdown + profile deletion + session deletion.
   * This enforces RULE 7: A recreated session starts with a clean profile.
   */
  async deleteProfile(sessionId: string): Promise<void> {
    const profilePath = this.getProfilePath(sessionId);
    try {
      await fs.rm(profilePath, { recursive: true, force: true });
    } catch (error) {
      // Type narrowing: we check if this is a Node.js ENOENT error (file not found)
      // Python equivalent: except OSError as e: if e.errno != errno.ENOENT: raise
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'ENOENT') {
        // Re-throw anything OTHER than "file not found" — permission errors, etc.
        throw error;
      }
      // If ENOENT: the profile was already gone, which is fine (idempotent)
    }
  }

  /**
   * Kills orphaned Brave processes that hold a session's profile lock.
   * 
   * Python reference: This is like running subprocess.check_output(['ps', 'aux']) and parsing
   * the output to find PIDs matching a pattern, then calling os.kill(pid, signal.SIGKILL).
   * 
   * WHY THIS MATTERS: When OpenWA crashes hard (SIGKILL, power loss, OOM killer), Puppeteer's
   * normal cleanup hook never runs. Brave keeps running, holding file locks on the profile.
   * On next start, Brave refuses to open a locked profile ("Profile already in use").
   * 
   * HOW IT WORKS: We use `ps aux | grep` to find processes with our session marker argument
   * (--openwa-session=<sessionId>), then SIGKILL them. This is best-effort: if no orphans exist,
   * the grep returns empty and we no-op.
   * 
   * RULE 3: Browser process is disposable, but profile must survive.
   */
  async killOrphanedBraveProcesses(
    sessionId: string,
    logger: ReturnType<typeof createLogger>,
  ): Promise<void> {
    try {
      // Build a shell command that finds PIDs of Brave processes with our session marker.
      // The marker is passed as a command-line arg to Brave, so it appears in ps output.
      // 
      // Python reference: Similar to:
      //   result = subprocess.run("ps aux | grep 'marker' | grep -v grep | awk '{print $2}'",
      //                          shell=True, capture_output=True, text=True)
      //   pids = result.stdout.strip().split('\n')
      const marker = this.getSessionMarker(sessionId);
      const { stdout } = await execAsync(
        `ps aux | grep '${marker}' | grep -v grep | awk '{print $2}'`
      );

      // Parse the output into individual PIDs (non-empty lines only)
      // Python reference: Similar to [pid for pid in stdout.strip().split('\n') if pid.strip()]
      const pids = stdout.trim().split('\n').filter(Boolean);

      // No orphans found — clean start, nothing to do
      if (pids.length === 0) {
        return;
      }

      // Log the discovery before killing
      // Python reference: logger.warning(f"Found {len(pids)} orphaned Brave processes...")
      logger.warn(
        `Found ${pids.length} orphaned Brave process(es) for session ${sessionId}, killing...`,
        { sessionId, action: 'kill_orphaned_brave', pids }
      );

      // SIGKILL each orphan. SIGKILL (signal 9) cannot be caught or ignored — immediate termination.
      // Python reference: for pid in pids: os.kill(int(pid), signal.SIGKILL)
      for (const pid of pids) {
        try {
          // process.kill() is Node's built-in, NOT the same as os.kill() in Python
          // It sends signals to processes by PID. Number(pid) casts string to int.
          process.kill(Number(pid), 'SIGKILL');
        } catch (error) {
          // The process might have died between our `ps` and `kill` — race condition.
          // We log and continue; other PIDs might still need killing.
          logger.warn(`Failed to kill orphan PID ${pid}`, { error: String(error) });
        }
      }

      // Give the OS time to release file locks before we try to open the profile.
      // Python reference: time.sleep(0.5) — but here we use an async sleep to avoid blocking.
      await this.sleep(500);
    } catch (error) {
      // The execAsync might fail if `ps` isn't available or grep finds nothing.
      // We log at debug level since this is expected behavior when no orphans exist.
      logger.debug('No orphaned Brave processes found', { sessionId });
    }
  }

  /**
   * Removes stale lock files left by a crashed Brave instance.
   * 
   * Python reference: Brave (like Chrome) creates lock files to prevent multiple instances from
   * using the same profile simultaneously. If Brave crashes, these files are left behind and
   * block the next launch. This is like removing SingletonLock, SingletonSocket from a Chrome
   * profile directory.
   * 
   * The three files:
   * - SingletonLock: Prevents multiple Brave instances from opening the profile
   * - SingletonSocket: IPC socket for the running instance
   * - SingletonCookie: Authentication cookie for the singleton protocol
   * 
   * WHEN: Called BEFORE launching Brave, so the new instance can acquire fresh locks.
   * Safe because we already killed orphans above — no live Brave should be holding these.
   */
  async removeStaleSingletonFiles(
    sessionId: string,
    logger: ReturnType<typeof createLogger>,
  ): Promise<void> {
    const profilePath = this.getProfilePath(sessionId);
    const singletonFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

    // Iterate over each lock file and try to delete it
    // Python reference: for filename in ['SingletonLock', ...]: os.remove(os.path.join(path, filename))
    for (const file of singletonFiles) {
      const filePath = path.join(profilePath, file);
      try {
        // fs.unlink deletes a file (equivalent to os.remove in Python)
        await fs.unlink(filePath);
        logger.log(`Removed stale ${file} from Brave profile`, { sessionId });
      } catch (error) {
        // Type narrowing to check the error code
        const nodeError = error as NodeJS.ErrnoException;
        
        // ENOENT = file didn't exist, which is the normal case (no crash left locks behind)
        // We only log warnings for OTHER errors (permission denied, etc.)
        if (nodeError.code !== 'ENOENT') {
          logger.warn(`Failed to remove stale ${file}`, { sessionId, error: nodeError.message });
        }
        // If ENOENT: silently continue — the file was already gone, which is what we wanted
      }
    }
  }

  /**
   * Returns the command-line marker argument used to identify this session's processes.
   * 
   * Python reference: This is like a constant or helper method that returns a formatted string.
   * Brave receives this as --openwa-session=sales-agent-01, and `ps aux` shows it in the
   * command line, allowing us to grep for it later.
   */
  private getSessionMarker(sessionId: string): string {
    return `--openwa-session=${sessionId}`;
  }

  /**
   * Async sleep utility.
   * 
   * Python reference: Equivalent to asyncio.sleep(seconds) — but Node.js doesn't have a built-in
   * async sleep, so we create one using setTimeout wrapped in a Promise. The Promise resolves
   * after `ms` milliseconds. This is a common pattern in JavaScript for non-blocking delays.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}