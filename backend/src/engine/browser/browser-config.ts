import { isBrowserType, type BrowserType } from './browser.types';

/**
 * A small, engine-owned configuration boundary shared by plugin, fallback,
 * and direct adapter creation. Profile ownership is NOT part of browser drivers.
 * BROWSER_* settings arrive through validated ConfigService values, never
 * through ad-hoc process.env reads in the plugin or factory.
 */
export interface BrowserConfigInput {
  readonly browser?: {
    readonly type?: unknown;
    readonly executablePath?: string;
    readonly profileBasePath?: string;
    /** Carries explicit-path provenance through an already-resolved config. */
    readonly strictExecutablePath?: boolean;
  };
  readonly brave?: {
    readonly executablePath?: string;
    readonly profileBasePath?: string;
  };
  readonly puppeteer?: {
    readonly executablePath?: string;
  };
}

export interface ResolvedBrowserSettings {
  readonly type: BrowserType;
  readonly executablePath: string | undefined;
  readonly profileBasePath: string;
  /** False for legacy BRAVE_EXECUTABLE/PUPPETEER_EXECUTABLE_PATH fallbacks. */
  readonly strictExecutablePath: boolean;
}

export function resolveBrowserSettings(
  config: BrowserConfigInput,
  defaults: { readonly profileBasePath: string; readonly executablePath?: string },
): ResolvedBrowserSettings {
  const requestedType = config.browser?.type === undefined ? 'brave' : config.browser.type;
  // Defensive validation for plugin-owned persisted config, which bypasses
  // the boot-time environment validator.
  if (config.browser?.executablePath !== undefined &&
      (typeof config.browser.executablePath !== 'string' ||
       config.browser.executablePath.trim() === '')) {
    throw new Error('Browser executable path must be a non-empty string');
  }
  const strictExecutablePath = config.browser?.strictExecutablePath ??
    (config.browser?.executablePath !== undefined);
  if (!isBrowserType(requestedType)) {
    throw new Error(`Unsupported browser type: ${String(requestedType)} (no registered driver)`);
  }

  // A configured browser path takes precedence. Never accidentally pass a
  // legacy Brave binary/default to a FUTURE non-Brave implementation.
  const executablePath = config.browser?.executablePath ??
    (requestedType === 'brave' ? config.brave?.executablePath : undefined) ??
    config.puppeteer?.executablePath ??
    (requestedType === 'brave' ? defaults.executablePath : undefined);
  const profileBasePath = config.browser?.profileBasePath ??
    config.brave?.profileBasePath ??
    defaults.profileBasePath;
  if (typeof profileBasePath !== 'string' || !profileBasePath.trim()) {
    throw new Error('Browser profile base path must be a non-empty string');
  }
  return { type: requestedType, executablePath, profileBasePath, strictExecutablePath };
}
