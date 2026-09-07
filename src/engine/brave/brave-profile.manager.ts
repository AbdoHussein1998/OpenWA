// src/engine/brave/brave-profile.manager.ts

import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { type createLogger } from '../../common/services/logger.service';

const execFileAsync = promisify(execFile);

const PROCESS_LIST_MAX_BUFFER = 10 * 1024 * 1024;
const PROCESS_KILL_SETTLE_MS = 500;

/**
 * Manages persistent Brave browser profiles per OpenWA session.
 *
 * Each OpenWA session owns one persistent Brave user-data directory.
 * Browser processes are disposable, but the profile is not.
 */
export class BraveProfileManager {
  constructor(private readonly baseProfilePath: string) {}

  /**
   * Return the persistent Brave profile directory for one OpenWA session.
   */
  getProfilePath(sessionId: string): string {
    return path.join(this.baseProfilePath, sessionId);
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
    await fs.mkdir(this.getProfilePath(sessionId), {
      recursive: true,
    });
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
   * Kill Brave processes left behind by a previous crashed OpenWA process.
   *
   * The lifecycle adds:
   *
   *   --openwa-session=<sessionName>
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
      return;
    }

    logger.warn(
      `Found ${pids.length} orphaned Brave process(es) for session ${sessionId}; terminating them`,
      {
        sessionId,
        action: 'kill_orphaned_brave',
        pids,
      },
    );

    for (const pid of pids) {
      this.killPid(
        pid,
        sessionId,
        logger,
      );
    }

    await this.sleep(
      PROCESS_KILL_SETTLE_MS,
    );

    /*
     * Verify that the processes really disappeared.
     *
     * A kill can race process exit, fail due to permissions, or leave
     * another matching Brave child process behind.
     */
    let survivors =
      await this.findSessionBravePids(
        sessionId,
      );

    if (survivors.length > 0) {
      logger.warn(
        'Brave process(es) still present after the first termination pass; retrying once',
        {
          sessionId,
          action: 'kill_orphaned_brave_retry',
          pids: survivors,
        },
      );

      for (const pid of survivors) {
        this.killPid(
          pid,
          sessionId,
          logger,
        );
      }

      await this.sleep(
        PROCESS_KILL_SETTLE_MS,
      );

      survivors =
        await this.findSessionBravePids(
          sessionId,
        );
    }

    if (survivors.length > 0) {
      const error =
        new Error(
          `Unable to terminate Brave process(es) holding session '${sessionId}' profile: ` +
            survivors.join(', '),
        );

      logger.warn(
        'Brave profile is still owned by a live process; refusing to continue startup',
        {
          sessionId,
          action: 'brave_orphan_kill_failed',
          pids: survivors,
        },
      );

      throw error;
    }
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
    return `--openwa-session=${sessionId}`;
  }

  /**
   * Enumerate PIDs carrying the exact OpenWA session marker.
   */
  private async findSessionBravePids(
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
     *   --openwa-session=foo
     *
     * does NOT accidentally match:
     *
     *   --openwa-session=foobar
     */
    const powershellScript =
      '$marker = $env:OPENWA_SESSION_MARKER; ' +
      "$pattern = '(?:^|\\s)' + [regex]::Escape($marker) + '(?=$|\\s)'; " +
      'Get-CimInstance Win32_Process | ' +
      'Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern } | ' +
      'ForEach-Object { $_.ProcessId }';

    const env = {
      ...process.env,
      OPENWA_SESSION_MARKER:
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

  /**
   * Best-effort process signal.
   *
   * Final success is decided by the verification pass afterwards.
   */
  private killPid(
    pid: number,
    sessionId: string,
    logger: ReturnType<typeof createLogger>,
  ): void {
    try {
      process.kill(
        pid,
        'SIGKILL',
      );
    } catch (error) {
      const nodeError =
        error as NodeJS.ErrnoException;

      /*
       * ESRCH:
       * the process died between enumeration and kill.
       * That is already the desired result.
       */
      if (
        nodeError.code ===
        'ESRCH'
      ) {
        return;
      }

      logger.warn(
        `Failed to terminate orphan Brave PID ${pid}`,
        {
          sessionId,
          pid,
          action:
            'kill_orphaned_brave_pid_failed',

          error:
            nodeError.message ??
            String(
              error,
            ),
        },
      );
    }
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

