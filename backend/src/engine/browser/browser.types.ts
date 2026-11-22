/**
 * Browser implementations supported by the current build.
 *
 * Add a browser here only when its driver has been implemented, registered in
 * BrowserManager, and verified with the browser/process ownership test suite.
 * Do not advertise future browsers before they are supported.
 */
export const SUPPORTED_BROWSER_TYPES = ['brave'] as const;

export type BrowserType = (typeof SUPPORTED_BROWSER_TYPES)[number];

/** Validate untrusted runtime input (environment variables / persisted configuration). */
export function isBrowserType(value: unknown): value is BrowserType {
  return typeof value === 'string' &&
    SUPPORTED_BROWSER_TYPES.some((browserType) => browserType === value);
}
