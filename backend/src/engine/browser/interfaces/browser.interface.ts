import type { BrowserType } from '../browser.types';

/**
 * Paths supplied by the existing WhatsApp-Web.js / Puppeteer configuration.
 *
 * `executablePath` maps to the current `config.brave.executablePath` for Brave;
 * `puppeteerExecutablePath` preserves the existing legacy fallback. The
 * profile directory does NOT belong here: it is managed separately by the
 * shared profile manager in a later phase.
 */
export interface BrowserExecutableOptions {
  readonly executablePath?: string | null;
  readonly puppeteerExecutablePath?: string | null;
  /** Do not fall back when the new browser-neutral executable override is invalid. */
  readonly strictExecutablePath?: boolean;
}

/**
 * Browser-specific capabilities needed by the existing Puppeteer lifecycle.
 *
 * This is NOT a WhatsApp client or Puppeteer abstraction. WwebjsLifecycle
 * continues to own Client.initialize/destroy and the application owns the
 * session/profile/lease launch flags. Drivers must never generate or change
 * --user-data-dir, --al-hakim-session or --al-hakim-lease themselves.
 */
export interface BrowserInterface {
  readonly type: BrowserType;

  /** Resolve a host-local browser executable, using the driver's OS defaults. */
  resolveExecutablePath(options: BrowserExecutableOptions): Promise<string>;

  /** Optional vendor-specific Puppeteer arguments (not session-ownership flags). */
  getBrowserSpecificArgs(): string[];

  /**
   * Identify the executable portion of a process command line.
   * This alone NEVER proves ownership: the shared process/profile manager must
   * additionally verify session id, profile path, lease token and process tree.
   */
  matchesExecutable(commandLine: string): boolean;
}
