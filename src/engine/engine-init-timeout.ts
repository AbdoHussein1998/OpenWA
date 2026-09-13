/**
 * Shared timeout configuration for the session engine lifecycle and the
 * whatsapp-web.js adapter.
 *
 * The OUTER engine-initialization deadline is engine-agnostic, while the
 * auth/readiness windows are whatsapp-web.js-specific. Keeping the parsers
 * here avoids making SessionEngineLifecycle import an adapter merely to size
 * its timeout.
 */

/**
 * whatsapp-web.js's upstream default for the initial browser boot/inject
 * window when WWEBJS_AUTH_TIMEOUT_MS is unset or invalid.
 */
export const DEFAULT_WWEBJS_AUTH_TIMEOUT_MS = 30_000;

/**
 * Post-scan/default readiness window.
 *
 * 90s was previously hard-coded in wwebjs-reconcile.ts. Some phones/accounts
 * legitimately take longer to synchronize WhatsApp Web after QR pairing, so
 * the default is now four minutes. Operators can raise it further with
 * WWEBJS_READY_TIMEOUT_MS.
 */
export const DEFAULT_WWEBJS_READY_TIMEOUT_MS = 240_000;

/**
 * Do not accept a configured readiness timeout below the old 90s behavior.
 *
 * Besides avoiding accidental aggressive recovery, this preserves enough room
 * for the 45s event-bridge reload grace used by WwebjsReadyReconcile.
 */
export const MIN_WWEBJS_READY_TIMEOUT_MS = 90_000;

/**
 * Optional override for whatsapp-web.js's initial boot/inject wait (#353).
 *
 * On slow first boots (for example WSL2 or low-resource containers), the
 * default 30s authTimeoutMs can expire before WhatsApp Web finishes loading,
 * aborting QR generation.
 *
 * Set WWEBJS_AUTH_TIMEOUT_MS to a larger value in milliseconds (for example
 * 120000) to extend it. Unset, or a value that is not a positive safe integer,
 * keeps the whatsapp-web.js default.
 */
export function resolveAuthTimeoutMs(): number | undefined {
  const raw = process.env.WWEBJS_AUTH_TIMEOUT_MS?.trim();

  if (!raw || !/^\d+$/.test(raw)) {
    return undefined;
  }

  const ms = Number(raw);

  // Number.isSafeInteger rejects Infinity and >2^53 unsafe integers. Both can
  // pass the digit-only shape check but are not valid timeout values.
  return Number.isSafeInteger(ms) && ms > 0
    ? ms
    : undefined;
}

/**
 * Resolve the post-authentication/post-QR readiness window.
 *
 * This is intentionally separate from WWEBJS_AUTH_TIMEOUT_MS:
 *
 * - AUTH timeout: Brave/page boot + WWebJS injection before/around QR.
 * - READY timeout: phone/account synchronization after authentication.
 *
 * Invalid values, and values below the old 90s behavior, fall back to the
 * safe four-minute default rather than making recovery more aggressive.
 */
export function resolveReadyTimeoutMs(): number {
  const raw = process.env.WWEBJS_READY_TIMEOUT_MS?.trim();

  if (!raw || !/^\d+$/.test(raw)) {
    return DEFAULT_WWEBJS_READY_TIMEOUT_MS;
  }

  const ms = Number(raw);

  return Number.isSafeInteger(ms) &&
    ms >= MIN_WWEBJS_READY_TIMEOUT_MS
    ? ms
    : DEFAULT_WWEBJS_READY_TIMEOUT_MS;
}

/**
 * How long a session waits for engine.initialize() before treating it as
 * wedged.
 *
 * The deadline MUST exceed the auth wait whatsapp-web.js runs INSIDE
 * engine.initialize(). A shorter outer deadline would kill a legitimate slow
 * initialization mid-auth.
 *
 * Floor: 60s.
 * Otherwise: configured/default auth window + 30s launch/navigation overhead.
 *
 * WWEBJS_READY_TIMEOUT_MS does not participate here because readiness
 * reconciliation happens after initialize()/authentication has moved into the
 * separate AUTHENTICATING phase.
 */
export function resolveEngineInitTimeoutMs(): number {
  return Math.max(
    60_000,
    (resolveAuthTimeoutMs() ?? DEFAULT_WWEBJS_AUTH_TIMEOUT_MS) +
      30_000,
  );
}
