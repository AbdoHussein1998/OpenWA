/**
 * Centralized Puppeteer argv assembly. A browser driver can customize vendor
 * flags, but must never define session identity, lease generation, or the
 * persistent user-data directory. Those are owned by WwebjsLifecycle.
 *
 * The legacy application supplied arguments are filtered for compatibility;
 * a *driver* attempting to override a reserved flag fails closed, rather than
 * launching a browser that the profile supervisor cannot identify safely.
 */
const RESERVED = /^--(?:al-hakim-session|al-hakim-lease|user-data-dir)(?:=|$)/;

export function createBrowserLaunchArgs(
  sessionId: string,
  leaseToken: string,
  configuredArgs: readonly string[],
  browserArgs: readonly string[],
): string[] {
  if (!/^[a-zA-Z0-9-]{1,50}$/.test(sessionId) || !leaseToken) {
    throw new Error('Invalid browser session or lease identity');
  }

  // Prevent browser implementations from changing ownership. Filtering here
  // would hide a configuration mistake that can reappear in another driver.
  if (browserArgs.some(arg => RESERVED.test(arg))) {
    throw new Error('Browser driver must not override profile or ownership flags');
  }

  const safeConfiguredArgs: string[] = [];
  for (let i = 0; i < configuredArgs.length; i += 1) {
    const arg = configuredArgs[i];
    if (RESERVED.test(arg)) {
      // Also discard a positional value after e.g. --user-data-dir /tmp/profile.
      if (!arg.includes('=') && configuredArgs[i + 1] && !configuredArgs[i + 1].startsWith('-')) {
        i += 1;
      }
      continue;
    }
    safeConfiguredArgs.push(arg);
  }

  return [
    ...safeConfiguredArgs,
    ...browserArgs,
    `--al-hakim-session=${sessionId}`,
    `--al-hakim-lease=${leaseToken}`,
  ];
}
