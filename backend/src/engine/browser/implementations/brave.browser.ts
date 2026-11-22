import * as fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import * as path from 'path';
import type { BrowserInterface, BrowserExecutableOptions } from '../interfaces/browser.interface';

/**
 * Brave-specific executable discovery and identification.
 *
 * Phase 1 intentionally does NOT wire this into WwebjsLifecycle: the old
 * resolveBraveExecutable() remains active until Phase 4, so introducing the
 * new implementation cannot change production launch, profile or lock behavior.
 */
export class BraveBrowser implements BrowserInterface {
  readonly type = 'brave' as const;

  /**
   * Preserve the current wwebjs-lifecycle.ts discovery order:
   *   1) config.brave.executablePath
   *   2) config.puppeteer.executablePath
   *   3) well-known platform locations
   *   4) platform PATH entries
   *
   * Like the current resolver, inaccessible candidates are skipped so the
   * historical Linux default '/usr/bin/brave' does not break Windows hosts.
   * This is an existence/access check, not a browser version compatibility
   * check; the live lifecycle and Puppeteer still perform the actual launch.
   */
  async resolveExecutablePath(options: BrowserExecutableOptions): Promise<string> {
    if (options.strictExecutablePath) {
      // This is BROWSER_EXECUTABLE_PATH (or a browser-specific persisted override),
      // not the historic BRAVE_EXECUTABLE best-effort discovery path.
      const explicitPath = options.executablePath?.trim();
      if (!explicitPath) {
        throw new Error('Explicit browser executable path must be a non-empty string');
      }
      // Process recovery identifies roots through the registered driver.
      // Launching a binary under a different name would make ownership checks
      // unable to prove safe termination after a crash.
      if (!this.matchesExecutable(explicitPath)) {
        throw new Error(
          `Explicit BROWSER_EXECUTABLE_PATH does not match the Brave driver process identity: ${explicitPath}`,
        );
      }
      try {
        const stat = await fs.stat(explicitPath);
        if (!stat.isFile()) throw new Error('Not a regular file');
        // X_OK is ignored by Windows, where stat + Puppeteer's launch verifies it.
        await fs.access(explicitPath, fsConstants.X_OK);
        return explicitPath;
      } catch {
        throw new Error(
          `Explicit BROWSER_EXECUTABLE_PATH is missing, inaccessible, or not executable: ${explicitPath}`,
        );
      }
    }
    const seen = new Set<string>();
    const candidates: string[] = [];

    const addCandidate = (candidate?: string | null): void => {
      if (!candidate) return;
      const trimmed = candidate.trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      candidates.push(trimmed);
    };

    addCandidate(options.executablePath);
    addCandidate(options.puppeteerExecutablePath);

    const pathDirectories = (process.env.PATH ?? '')
      .split(path.delimiter)
      .map((directory) => directory.trim())
      .filter(Boolean);

    switch (process.platform) {
      case 'win32': {
        const installRoots = [
          process.env.PROGRAMFILES,
          process.env['PROGRAMFILES(X86)'],
          process.env.LOCALAPPDATA,
          process.env.USERPROFILE
            ? path.join(process.env.USERPROFILE, 'AppData', 'Local')
            : undefined,
        ].filter((root): root is string => Boolean(root));

        for (const root of installRoots) {
          addCandidate(path.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
          addCandidate(path.join(root, 'BraveSoftware', 'Brave-Browser-Beta', 'Application', 'brave.exe'));
          addCandidate(path.join(root, 'BraveSoftware', 'Brave-Browser-Nightly', 'Application', 'brave.exe'));
        }
        for (const directory of pathDirectories) {
          addCandidate(path.join(directory, 'brave.exe'));
          addCandidate(path.join(directory, 'brave-browser.exe'));
        }
        break;
      }

      case 'darwin': {
        addCandidate('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
        addCandidate('/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta');
        addCandidate('/Applications/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly');
        if (process.env.HOME) {
          addCandidate(path.join(
            process.env.HOME, 'Applications', 'Brave Browser.app', 'Contents', 'MacOS', 'Brave Browser',
          ));
        }
        for (const directory of pathDirectories) {
          addCandidate(path.join(directory, 'brave'));
          addCandidate(path.join(directory, 'brave-browser'));
        }
        break;
      }

      case 'linux': {
        addCandidate('/usr/bin/brave-browser');
        addCandidate('/usr/bin/brave');
        addCandidate('/usr/bin/brave-browser-stable');
        addCandidate('/usr/local/bin/brave-browser');
        addCandidate('/usr/local/bin/brave');
        addCandidate('/snap/bin/brave');
        for (const directory of pathDirectories) {
          addCandidate(path.join(directory, 'brave-browser'));
          addCandidate(path.join(directory, 'brave'));
          addCandidate(path.join(directory, 'brave-browser-stable'));
        }
        break;
      }

      default: {
        for (const directory of pathDirectories) {
          addCandidate(path.join(directory, 'brave-browser'));
          addCandidate(path.join(directory, 'brave'));
        }
      }
    }

    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // Preserve the existing behavior: inaccessible candidates are skipped.
      }
    }

    throw new Error(
      `Brave browser executable was not found for platform '${process.platform}'. ` +
        `Checked ${candidates.length} candidate path(s). ` +
        `Configured Brave path: ${options.executablePath || '(none)'}. ` +
        `Configured Puppeteer path: ${options.puppeteerExecutablePath || '(none)'}. ` +
        'Install Brave or set BRAVE_EXECUTABLE / brave.executablePath to the correct executable.',
    );
  }

  /** The existing lifecycle already supplies all of Brave's launch arguments. */
  getBrowserSpecificArgs(): string[] {
    return [];
  }

  /**
   * Mirrors the executable check from isSessionOwnedBraveRoot(). This is only
   * a *candidate* match, not sufficient authorization for process termination.
   * Phase 2 will combine this with the existing exact marker/profile checks.
   */
  matchesExecutable(commandLine: string): boolean {
    const executablePart = commandLine.split(/\s--/)[0];
    return /(?:^|[\\/])brave(?: browser|-browser(?:-stable)?)?(?:\.exe)?(?="|$|\s)/i
      .test(executablePart);
  }
}
