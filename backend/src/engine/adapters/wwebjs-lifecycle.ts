import { LogLevel } from '../../common/services/logger.service';












import * as qrcode from 'qrcode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Client, NoAuth, WAState } from 'whatsapp-web.js';
import {
  type AccountRestriction,
  type ConnectionStage,
  type EngineEventCallbacks,
  EngineStatus,
} from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { type createLogger } from '../../common/services/logger.service';
import { MAX_TIMER_MS } from '../../config/configuration';
import { resolveWebVersionPin } from '../wa-web-version';
import { resolveAuthTimeoutMs, resolveEngineInitTimeoutMs } from '../engine-init-timeout';
import { isSupportedProxyUrl, buildProxyLaunchConfig } from './wwebjs-proxy';
import { BACKPORT_MISSING_MESSAGE, isBackportMissing } from './wwebjs-backport-check';
import { inspectWwebjsRuntime } from './wwebjs-runtime-compat';
import { type WhatsAppWebJsConfig } from './whatsapp-web-js.adapter';
import { WwebjsBridgeMonitor, type WwebjsBridgeStatus } from './wwebjs-bridge-monitor';

import { BraveProfileManager, type BraveProfileLeaseRelease } from '../brave/brave-profile.manager';
import { BraveProcessSupervisor, type ObservedBrowserProcess } from '../brave/brave-process-supervisor';
import { boundedBrowserOperation, BROWSER_TEARDOWN_BUDGETS } from '../brave/brave-browser-teardown';
import { BraveFailureCode, braveFailureReason, elapsedBrowserMs } from '../brave/brave-lifecycle-diagnostics';


/**
 * Detect Puppeteer's "Execution context was destroyed" error. During `Client.inject()` this is most
 * often a persistent browser profile left stale by an al-hakim upgrade that changed the Chromium/Chrome
 * binary (e.g. the v0.8.12 amd64 Debian Chromium → Chrome for Testing switch, #663 / #708) — but it is
 * not exclusively that: Puppeteer also raises it on a page navigation or a renderer crash (see
 * puppeteer-core `ExecutionContext` / `IsolatedWorld`), so the caller advises rather than asserts.
 * Pure so the detection is unit-testable without mocking the whatsapp-web.js `Client`.
 */
export function isExecutionContextDestroyedError(reason: string): boolean {
  return /execution context was destroyed/i.test(reason);
}

/**
 * A first-inject rejection that reads as "the page navigated out from under the in-flight evaluate":
 * the exec-context class above plus the 'window.require is not a function' variant (an evaluate
 * landing on a document whose WA bundle has not booted yet). Deliberately SEPARATE from the
 * stale-profile advisory classifier: the advisory names a remedy (delete the profile) that is wrong
 * for the window.require shape (see src/config/process-error-monitor.ts) — this predicate only
 * decides whether one in-place retry is worth it, both shapes being transient when a reload caused
 * them. whatsapp-web.js registers its own re-inject handler only AFTER the first inject succeeds
 * (Client.js:502 vs :504), so a navigation landing during it is caught by nothing upstream (#1081).
 */
function isNavigationShapedInitRejection(reason: string): boolean {
  return isExecutionContextDestroyedError(reason) || /window\.require is not a function/i.test(reason);
}

// A post-READY page navigation (WhatsApp Web's ~5-minute first reload on a fresh pairing, a
// service-worker update, …) destroys the page's JS world; whatsapp-web.js re-injects on its own
// framenavigated handler (Client.js:504-513), but until WA Web has booted again getState() REJECTS,
// so the liveness probe reads a healing page as dead and every delegate evaluate dies as a raw
// TypeError under a status that still says READY (#1081). Sizing — floor: the pre-boot phase alone
// (page load + WA Web bundle boot, the stretch where getState() rejects) takes tens of seconds on a
// slow host, and upstream's re-inject then polls up to 30s for window.WWebJS (Client.js:332-343);
// ceiling: one watchdog interval (60s), so a page that navigates and then wedges loses at most one
// probe to the grace and still dies within one extra interval. NOT a sibling of
// READY_RECONCILE_BRIDGE_RELOAD_GRACE_MS above: that one is capped by the 90s reconcile deadline,
// this one by keeping the watchdog's safety net alive — do not "harmonize" them.
export const NAVIGATION_REINJECT_GRACE_MS = 60_000;

// Hard bound per recovery episode (first navigation → the next completed re-inject): a page stuck in
// a navigation loop re-stamps the rolling grace faster than it expires, which would suppress the
// watchdog forever and leave a zombie session READY that only ever answers 409. Past this cap the
// probe reports the truth again and the watchdog takes over.
export const NAVIGATION_EPISODE_CAP_MS = 3 * NAVIGATION_REINJECT_GRACE_MS;

/**
 * Ambiguous Puppeteer/CDP failures such as "Execution context was destroyed" are not proof that
 * the browser died. They also occur during normal WhatsApp Web navigations. Outside the explicit
 * navigation grace, keep the Session alive for this bounded confirmation window while probing the
 * page. Hard-death signals (browser disconnected/page close/Target closed) still disconnect
 * immediately.
 */
export const PAGE_TRANSPORT_CONFIRMATION_MS = 20_000;
const PAGE_TRANSPORT_CONFIRMATION_PROBE_INTERVAL_MS = 2_500;

// The single in-adapter retry of a navigation-killed first inject only runs while at least this much
// of the lifecycle's outer init deadline remains — a retry the outer race SIGKILLs mid-launch would
// surface as a bare 504 with no reason. Below it, fail with today's exact terminal shape instead.
const INIT_RETRY_MIN_REMAINING_MS = 20_000;

// WhatsApp Web states that mean WhatsApp has judged the account or its egress, mapped to the neutral
// restriction kinds. This is the ONLY channel the library offers: there is no dedicated event, error
// type or cause code for account standing (whatsapp-web.js 1.34.7), just a `WAState` string on the
// `disconnected` event.
//
// Deliberately only three of the twelve states. UNPAIRED/UNPAIRED_IDLE and LOGOUT are unlinks,
// CONFLICT is another device taking over, DEPRECATED_VERSION is our own client being too old, and
// TIMEOUT is a fault — none is a statement about the account's standing, and reporting them as
// restrictions would be exactly the false positive that makes the signal worthless to act on.
const WA_STATE_RESTRICTIONS: Readonly<Record<string, AccountRestriction['kind']>> = {
  TOS_BLOCK: 'tos_block',
  SMB_TOS_BLOCK: 'tos_block',
  PROXYBLOCK: 'proxy_block',
};

/**
 * Host surface for {@link WwebjsLifecycle}. The adapter keeps the public engine methods as thin
 * forwarders and builds ONE object literal of these closures, so the delegate drives connection
 * state only through the seams named here: the sibling delegates it coordinates (reconcile,
 * onboarding watcher, call cache, stuck-auth) and the adapter-owned event surface.
 */
export interface WwebjsLifecycleHost {
  readonly logger: ReturnType<typeof createLogger>;
  readonly config: WhatsAppWebJsConfig;
  /** Live callbacks bag — read per event, since initialize() installs it after delegates are built. */
  getCallbacks(): EngineEventCallbacks;
  /** Re-emit a status transition on the adapter's EventEmitter (`stateChanged`). */
  emitState(status: EngineStatus): void;
  /** Arm / disarm the pre-authentication QR_READY reconciliation (./wwebjs-reconcile). */
  scheduleAuthReconcile(): void;
  clearAuthReconcile(): void;
  /** Arm / disarm the post-authentication readiness reconciliation (./wwebjs-reconcile). */
  scheduleReadyReconcile(): void;
  clearReadyReconcile(): void;
  /** Arm / disarm the onboarding-modal watcher (./wwebjs-onboarding). */
  startOnboardingWatcher(): void;
  clearOnboardingWatcher(): void;
  /** Drop every cached live-call handle — the client they point at is going away. */
  clearLiveCalls(): void;
  /** Release pending media jobs when this one-shot client generation is retired. */
  closeInboundMedia(): void;

  /** Register the domain client events (messages, groups, calls) on a freshly built client. */
  attachDomainEvents(client: Client): void;
}

/**
 * Connection lifecycle extracted from WhatsAppWebJsAdapter: the initialize launch (with its single
 * navigation-killed retry), the client-event wiring for connection state, puppeteer death detection,
 * teardown in its four flavors, the liveness probe, and the state behind them. The adapter keeps the
 * public IWhatsAppEngine members as thin forwarders and injects the host surface via closures, so
 * the delegate never touches adapter state beyond the seams the host names.
 *
 * The state fields below are public where the adapter aliases them by reference (host closures and
 * an unmodified spec poking `adapter.client` / `adapter.status` / … through a cast keep working
 * byte-identically — the same aliasing BaileysAdapter does for `sock`); the rest stay private.
 */
export class WwebjsLifecycle {
  /** Live whatsapp-web.js client, null once torn down. Aliased by the adapter's `client` accessor. */
  client: Client | null = null;
  /** Current engine status. Aliased by the adapter's `status` accessor. */
  status: EngineStatus = EngineStatus.DISCONNECTED;
  /** Last encoded QR, cleared on authentication. Aliased by the adapter's `qrCode` accessor. */
  qrCode: string | null = null;
  /** Own-account phone number, read once at readiness. */
  private phoneNumber: string | null = null;
  /** Own-account push name, read once at readiness. */
  private pushName: string | null = null;
  /** Set once teardown begins so a late 'authenticated' can't resurrect a disconnecting adapter. Not
   *  reset — an adapter is single-use after teardown (the session creates a fresh one to reconnect).
   *  Aliased by the adapter's `tearingDown` accessor. */
  tearingDown = false;
  /** Set by logout() before it starts the native unlink, which itself registers the real
   *  `client.logout()` promise as the credential teardown. The 'disconnected' LOGOUT handler consults
   *  this to avoid registering a second, redundant stand-in for the same profile rm — while still
   *  registering one for a WhatsApp-initiated logout, including one that lands after another teardown
   *  path has already latched the flags below. Aliased by the adapter's `logoutInitiated` accessor. */
  logoutInitiated = false;
  /** Set once the adapter ACTIVELY transitions to DISCONNECTED (engine disconnect, puppeteer death,
   *  stuck-auth recovery, teardown). Same single-use contract as `tearingDown`, but it latches earlier:
   *  on LOGOUT whatsapp-web.js keeps the browser and re-runs inject(), while the lifecycle only replaces
   *  the engine after the reconnect backoff — so for those seconds the old client can still emit a QR or
   *  re-authenticate, and neither belongs to the session any more (#982). Aliased by the adapter's
   *  `disconnectReported` accessor. */
  disconnectReported = false;
  // Navigation re-inject window (#1081): stamped by our framenavigated listener, closed by the
  // library's re-emitted 'ready' and by teardown. Timestamps, never timers — several suites pin
  // exact jest timer counts, and a timer would also outlive the single-use adapter.
  /**
   * Consecutive per-command protocol timeouts observed while the session is READY. A single timeout
   * is treated as a transient browser/renderer fault; repeated timeouts after failed health probes
   * trigger the existing forceDestroy() recovery path.
   */
  private consecutiveProtocolTimeouts = 0;
  /**
   * At most one ambiguous transport-death confirmation runs at a time. Delegate calls can fail in
   * bursts while the page is navigating; coalescing prevents a burst from spawning competing
   * health-check loops that could each independently disconnect the same client generation.
   */
  private pageTransportConfirmationInFlight = false;
  private lastMainFrameNavigationAt = 0;
  private navigationEpisodeStartedAt = 0;
  /** True after at least one QR was produced by this client generation. */
  private qrPresentedThisAttempt = false;
  private readonly bridgeMonitor = new WwebjsBridgeMonitor();
  private readonly browserProcessSupervisor = new BraveProcessSupervisor();
  /** Holds the profile lock across the complete Client lifetime, including the one init retry. */
  private profileLeaseRelease?: BraveProfileLeaseRelease;
  /** Coalesce attempts when the process scan outlasts the caller's lease-release deadline. */
  private pendingProfileLeaseRelease?: Promise<void>;
  /** A timed-out CDP destroy may continue in the background. Never start it twice on the same Client. */
  private pendingClientDestroy?: { client: Client; promise: Promise<void> };
  /** Stuck-auth deletion owns the lease until profile deletion finishes, not just browser exit. */
  private profileResetActive = false;

  private async releaseProfileLease(): Promise<void> {
    const lease = this.profileLeaseRelease;
    if (!lease) return;
    let pending = this.pendingProfileLeaseRelease;
    if (!pending) {
      pending = Promise.resolve().then(() => lease());
      this.pendingProfileLeaseRelease = pending;
      // If the caller timed out, a late successful release must still clear the
      // cached token. Otherwise a second caller may run the same unlink twice.
      void pending.then(
        () => { if (this.profileLeaseRelease === lease) this.profileLeaseRelease = undefined; },
        () => undefined,
      ).finally(() => {
        if (this.pendingProfileLeaseRelease === pending) {
          this.pendingProfileLeaseRelease = undefined;
        }
      });
    }
    try {
      await boundedBrowserOperation(
        () => pending,
        BROWSER_TEARDOWN_BUDGETS.leaseMs,
        'Brave profile lease release',
      );
    } catch (error) {
      // Do not claim success: the lock is deliberately retained if a browser may still own it.
      this.host.logger.event(LogLevel.WARN, 'engine.browser.lease_retained', 'releaseProfileLease',
        'Brave profile ownership lock retained after incomplete teardown', {
          sessionId: this.host.config.sessionId,
          action: 'brave_profile_lock_retained', status: 'failed',
          reasonCode: BraveFailureCode.BROWSER_TEARDOWN_INCOMPLETE,
        });
      throw error;
    }
  }
  /**
   * True after requestPairingCode() succeeds. Authentication after that point must not be labelled
   * as a QR scan merely because the page also happened to have produced a QR earlier.
   */
  private pairingCodeRequestedThisAttempt = false;

  constructor(
    private readonly host: WwebjsLifecycleHost,
    private readonly braveProfileManager: BraveProfileManager,
  ) {}

  private emitConnectionStage(stage: ConnectionStage): void {
    this.host.getCallbacks().onConnectionStage?.({ stage, source: 'native' });
  }

  async initialize(): Promise<void> {
    this.host.logger.event(LogLevel.DEBUG, 'engine.wwebjs.initialize', 'initialize', 'Browser engine initialization started', { sessionId: this.host.config.sessionId });
    this.setStatus(EngineStatus.INITIALIZING);
    const initStartedAt = Date.now();

    // Inventory the ACTUAL installed library. Do not confuse the npm package release with the
    // independently selected WhatsApp Web page build or with local postinstall patches.
    const compatibility = inspectWwebjsRuntime();
    this.host.logger.log('whatsapp-web.js runtime compatibility', {
      sessionId: this.host.config.sessionId,
      ...compatibility,
      eventBridgeVerification: 'adapter-owned attachEventListeners completion',
    });
    if (compatibility.version !== '1.34.8') {
      this.host.logger.warn('This adapter was reviewed against whatsapp-web.js 1.34.8; verify compatibility with the installed release', {
        sessionId: this.host.config.sessionId,
        installedVersion: compatibility.version,
        expectedVersion: '1.34.8',
        action: 'wwebjs_version_not_verified',
      });
    }
    if (isBackportMissing()) {
      this.host.logger.error(BACKPORT_MISSING_MESSAGE);
    }

    try {
      // Build puppeteer args, including proxy if configured
      const puppeteerArgs = this.host.config.puppeteer?.args
        ? [...this.host.config.puppeteer.args]
        : [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
          ];

      // Add proxy configuration if provided — but only when the URL parses to a supported scheme, so
      // a malformed/stored proxy value can't break the Chromium launch or smuggle a non-proxy scheme.
      let proxyAuthentication: { username: string; password: string } | undefined;
      if (this.host.config.proxy) {
        if (isSupportedProxyUrl(this.host.config.proxy.url)) {
          // Chromium ignores credentials in --proxy-server; pass a credential-less server and hand the
          // username/password to wwjs's proxyAuthentication (page.authenticate) for HTTP/HTTPS proxies (#628).
          const proxyLaunch = buildProxyLaunchConfig(this.host.config.proxy.url);
          puppeteerArgs.push(`--proxy-server=${proxyLaunch.serverArg}`);
          proxyAuthentication = proxyLaunch.proxyAuthentication;
          if (proxyLaunch.socksAuthUnsupported) {
            this.host.logger.warn(
              `Proxy for session ${this.host.config.sessionId} has credentials on a SOCKS proxy, but Chromium ` +
                `cannot authenticate SOCKS proxies. Use an IP-authorized proxy or an HTTP/HTTPS proxy instead.`,
            );
          }
          this.host.logger.log(`Using proxy: ${proxyLaunch.serverArg}`);
        } else {
          this.host.logger.warn(`Ignoring invalid proxy URL for session ${this.host.config.sessionId}`);
        }
      }

      // Marker arg: Chromium silently ignores unknown flags, so this exists purely as a label that
      // lets BraveProfileManager identify this session's browser processes in `ps`
      // output later (after a hard kill of the al-hakim process orphaned them).
      puppeteerArgs.push(`--al-hakim-session=${this.host.config.sessionId}`);

      // Pin the WA-Web version (fixes the 1.34.x "stuck at authenticating" hang on some setups,
      // #251/#488). DEFAULT: auto-resolve a settled build from the wa-version registry and pin its
      // remote HTML (no integrity check — resolveWebVersionPin logs a loud warning); only
      // WWEBJS_WEB_VERSION=off leaves whatsapp-web.js to use the first-party build from WhatsApp.
      const versionPin = await resolveWebVersionPin();
      if (this.tearingDown) {
        this.setStatus(EngineStatus.DISCONNECTED);
        return;
      }
      if (versionPin) {
        this.host.logger.log(`Pinning WhatsApp Web version ${versionPin.webVersion}`);
      }

      // Extend the first-boot init wait on slow setups (WSL2/low-resource), #353. Opt-in:
      // unset keeps whatsapp-web.js's 30000ms default.
      const authTimeoutMs = resolveAuthTimeoutMs();
      if (authTimeoutMs) {
        this.host.logger.log(`Using auth timeout ${authTimeoutMs}ms`);
      }

      // One retry for a navigation-killed first inject (#1081): a WhatsApp Web reload landing
      // mid-inject rejects initialize() with nothing upstream ever retrying (see
      // isNavigationShapedInitRejection), and the onError channel below is terminal end to end.
      // Structurally a single second try — skipped when the lifecycle's outer init race is nearly
      // spent (a retry the race SIGKILLs mid-launch would surface as a bare 504 with no reason), and
      // abandoned when attempt 1's browser cannot be destroyed (see resetForInitRetry).
      try {
        await this.runInitAttempt(puppeteerArgs, authTimeoutMs, proxyAuthentication, versionPin);
      } catch (attemptError) {
        const attemptReason = attemptError instanceof Error ? attemptError.message : String(attemptError);
        const budgetLeftMs = resolveEngineInitTimeoutMs() - (Date.now() - initStartedAt);
        if (
          this.tearingDown ||
          !isNavigationShapedInitRejection(attemptReason) ||
          budgetLeftMs < INIT_RETRY_MIN_REMAINING_MS
        ) {
          throw attemptError;
        }
        this.host.logger.warn(
          `"${attemptReason}" killed the first inject — a page navigation landed before ` +
            `whatsapp-web.js installed its re-inject handler. Retrying the launch once (#1081).`,
          { sessionId: this.host.config.sessionId, action: 'init_navigation_retry' },
        );
        const cleaned = await this.resetForInitRetry();
        if (this.tearingDown) {
          this.setStatus(EngineStatus.DISCONNECTED);
          return;
        }
        if (!cleaned) {
          this.host.logger.warn(
            "Attempt 1's browser did not die within the destroy bound — abandoning the retry rather " +
              'than launching a second Chromium into the same profile',
            { sessionId: this.host.config.sessionId, action: 'init_navigation_retry_abandoned' },
          );
          throw attemptError;
        }
        await this.runInitAttempt(puppeteerArgs, authTimeoutMs, proxyAuthentication, versionPin);
      }
    } catch (error) {
      this.host.clearAuthReconcile();
      this.host.clearReadyReconcile();
      this.setStatus(EngineStatus.FAILED);
      const reason = error instanceof Error ? error.message : String(error);
      // What the dashboard renders as `lastError` is exactly this string and nothing else — the log
      // below never reaches it. Carry a one-line remedy with the reason for the one failure we can
      // actually advise on, so the session card stops being a dead end (#1081).
      let surfacedReason = reason;
      if (isExecutionContextDestroyedError(reason)) {
        // #708: Puppeteer's "Execution context was destroyed" during inject reads like a Puppeteer bug.
        // During initialize() its dominant cause is a browser profile left stale by an upgrade that
        // changed the Chromium/Chrome binary (e.g. v0.8.12 amd64: Debian Chromium → Chrome for Testing,
        // #663) — but it can also follow a page navigation or a renderer crash, so advise, don't assert.
        // The profile dir is the same persistent Brave user-data directory stuck-auth recovery removes. Safe to compute
        // here: sessionDataPath is a required config field already resolved in the try block above, so
        // this can't throw and mask the original error we are about to rethrow.
        this.host.logger.warn(
          `"${reason}" during initialize. If this followed an al-hakim upgrade that changed the ` +
            `Chromium/Chrome binary (v0.8.12 amd64 switched Debian Chromium → Chrome for Testing), the ` +
          `session's Brave browser profile is likely stale — delete the profile dir ` +
          `"${this.braveProfileManager.getProfilePath(this.host.config.sessionId)}" ` +
            `and start again to re-scan. If no upgrade happened, Puppeteer also raises this on a page ` +
            `navigation or renderer crash (check for memory pressure or a WhatsApp Web reload). ` +
            `See docs/12-troubleshooting-faq.md.`,
        );
        // Kept short and with the raw Puppeteer text FIRST: operators search on that string, and the
        // dashboard truncates a long reason. The profile path stays in the log above — it is too long
        // for a card, and naming the wrong remedy is worse than pointing at the FAQ, since deleting a
        // profile forces an irreversible re-pair.
        surfacedReason =
          `${reason} WhatsApp Web's page context was destroyed during startup. If this followed an ` +
          `upgrade, the session's browser profile is likely stale — see docs/12-troubleshooting-faq.md.`;
      }
      this.host.logger.event(LogLevel.ERROR, 'engine.browser.initialize_failed', 'initialize',
        'Brave-backed WhatsApp engine initialization failed', {
          sessionId: this.host.config.sessionId, status: 'failed',
          elapsedMs: elapsedBrowserMs(initStartedAt),
          reasonCode: braveFailureReason(error, BraveFailureCode.BROWSER_LAUNCH_FAILED),
        });
      this.host.getCallbacks().onError?.(surfacedReason);
      throw error;
    }
  }

  /**
   * One construction+launch attempt: everything from `new Client(...)` through the puppeteer death
   * listeners. Extracted so the navigation retry (#1081) repeats the FULL sequence — a second
   * attempt without setupEventHandlers() would have no qr/authenticated/ready handlers at all, and
   * without the pre-launch sweeps it would trip over attempt 1's stale Singleton files. A LIVE
   * attempt-1 browser never reaches attempt 2: resetForInitRetry() abandons the retry instead.
   */
  private async runInitAttempt(
    puppeteerArgs: string[],
    authTimeoutMs: number | undefined,
    proxyAuthentication: { username: string; password: string } | undefined,
    versionPin: Awaited<ReturnType<typeof resolveWebVersionPin>>,
  ): Promise<void> {
    const launchStartedAt = Date.now();
    this.host.logger.event(LogLevel.INFO, 'engine.browser.launch_started', 'runInitAttempt',
      'Browser initialization attempt started', {
        sessionId: this.host.config.sessionId, status: 'started',
        headless: this.host.config.puppeteer?.headless ?? true,
      });
    // Range-checked at the sink, not only in configuration.ts: a plugin config written through
    // `PUT /api/plugins/whatsapp-web.js/config` is validated as an object and merged over the env
    // blob at every boot, so it can carry a value the config layer never saw. Both bounds are
    // load-bearing. `common/CallbackRegistry.js` arms the timer under `if (timeout)`, so 0 arms
    // none and a wedged renderer holds the command, and the request behind it, indefinitely; above
    // MAX_TIMER_MS Node's timer overflows and fires after 1 ms, so the browser never launches.
    const configuredProtocolTimeout = this.host.config.puppeteer?.protocolTimeoutMs;
    const protocolTimeout =
      typeof configuredProtocolTimeout === 'number' &&
      configuredProtocolTimeout > 0 &&
      configuredProtocolTimeout <= MAX_TIMER_MS
        ? configuredProtocolTimeout
        : undefined;

    // ═══════════════════════════════════════════════════════════════════════
    // BRAVE PROFILE SETUP — THE CORE ARCHITECTURAL CHANGE
    // ═══════════════════════════════════════════════════════════════════════
    // 
    // BEFORE: Puppeteer launched its bundled Chromium with a TEMPORARY profile.
    //   → Every restart = new browser identity = WhatsApp requires QR re-scan.
    //
    // AFTER: Puppeteer launches the REAL Brave binary with a PERSISTENT profile.
    //   → Profile survives restarts = WhatsApp auth restored automatically.
    //
    // The sessionId becomes the profile identity: /data/brave-profiles/<sessionId>
    // This enforces RULE 1: 1 al-hakim session = 1 Brave profile
    // This enforces RULE 2: sessionId = profile identity

    // Step 1: Resolve where this session's Brave profile lives on disk
    const braveProfilePath = this.braveProfileManager.getProfilePath(this.host.config.sessionId);
    
    // Step 2: Ensure the directory exists (creates it if first time, no-op if exists)
    // Like Python: os.makedirs(profile_path, exist_ok=True)
    await this.braveProfileManager.ensureProfile(this.host.config.sessionId);
    // Acquire before orphan enumeration / Singleton cleanup. A matching process marker alone
    // does not prove an orphan and must never justify killing a peer's active browser.
    if (!this.profileLeaseRelease) {
      this.profileLeaseRelease = await this.braveProfileManager.acquireProfileLease(
        this.host.config.sessionId, this.host.logger,
      );
    }
    this.host.logger.log(`Using Brave profile: ${braveProfilePath}`);

    // Step 3: Resolve which Brave binary to launch
    // Priority:
    //   1. config.brave.executablePath
    //   2. config.puppeteer.executablePath
    //   3. Automatically detect Brave on Windows
    //   4. Existing Linux default
    const braveExecutable = await this.resolveBraveExecutable();
    // ═══════════════════════════════════════════════════════════════════════

    // Bind this browser generation to the *existing* filesystem lease. A new
    // backend can recover its orphan only if the old backend is confirmed dead
    // and the Brave launch argument matches that old lease's owner token.
    // This marker is a generation identifier, not a secret or access token.
    const leaseToken = this.profileLeaseRelease?.ownerToken;
    if (!leaseToken) throw new Error('Brave profile lease missing before browser launch');
    const launchArgs = [
      // Reserved browser identity flags are managed exclusively by the engine.
      // A plugin-provided --user-data-dir or duplicate marker would defeat
      // profile verification, so do not forward them to Chromium.
      ...puppeteerArgs.filter(arg =>
        !/^--(?:al-hakim-session|al-hakim-lease|user-data-dir)(?:=|$)/.test(arg)),
      `--al-hakim-session=${this.host.config.sessionId}`,
      `--al-hakim-lease=${leaseToken}`,
    ];

    const client = new Client({
      authStrategy: new NoAuth(),
      puppeteer: {
        headless: this.host.config.puppeteer?.headless ?? true,
        args: launchArgs,
        // Do NOT let Puppeteer install its own process signal handlers. By default it handles
        // SIGINT (→ synchronous process.exit(130), which would skip the graceful drain entirely)
        // and SIGTERM/SIGHUP (→ kills Chromium at signal time, defeating the drain window). We own
        // signal handling in main.ts. Puppeteer's unconditional `exit` hook still SIGKILLs this
        // browser when the process actually exits, so nothing is orphaned.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        userDataDir: braveProfilePath,  // ← Brave stores cookies, localStorage, IndexedDB here

        // ═══════════════════════════════════════════════════════════════════
        // THE TWO CRITICAL LINES — BROWSER IDENTITY MAPPING
        // ═══════════════════════════════════════════════════════════════════
        // executablePath: Tells Puppeteer "use THIS browser binary, not your bundled Chromium"
        //   → Points to real Brave installed in Docker (e.g., /usr/bin/brave)
        //   → Python equivalent: subprocess.Popen(['/usr/bin/brave', ...])
        //
        // userDataDir: Tells Brave "store ALL your data HERE" 
        //   → Cookies, localStorage, IndexedDB, service workers, cache
        //   → This is what makes the session PERSISTENT across restarts
        //   → Python equivalent: chrome --user-data-dir=/path/to/profile
        //
        // Together: sessionId → profilePath → Brave binary → persistent identity
        executablePath: braveExecutable,
        // ═══════════════════════════════════════════════════════════════════
        // Per-CDP-command budget, spread only when the host configured a usable one (see above).
        // Absent, puppeteer-core nullish-coalesces to its own 180 000 ms (`cdp/Connection.js`).
        ...(protocolTimeout !== undefined ? { protocolTimeout } : {}),
      },
      ...(authTimeoutMs !== undefined ? { authTimeoutMs } : {}),
      ...(proxyAuthentication ? { proxyAuthentication } : {}),
      ...(versionPin ?? {}),
    });
    this.client = client;
    // Instrument the real 1.34.8 attachEventListeners() before initialize() can invoke it.
    // An unpatched eventsAttached=undefined is NOT evidence of a working message bridge.
    if (!this.bridgeMonitor.instrument(client)) {
      this.host.logger.error(
        'Cannot verify whatsapp-web.js event bridge: attachEventListeners is unavailable or cannot be observed. ' +
          'This engine will not report READY until compatibility is restored.',
        undefined,
        { sessionId: this.host.config.sessionId, action: 'wwebjs_bridge_instrumentation_unavailable' },
      );
    }

    this.setupEventHandlers();
    if (this.tearingDown) {
      this.client = null;
      this.setStatus(EngineStatus.DISCONNECTED);
      await this.releaseProfileLease();
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // POST-RECOVERY BRAVE VERIFICATION
    // ═══════════════════════════════════════════════════════════════════════
    // acquireProfileLease() has already checked any abandoned owner under an
    // exclusive recovery claim. Only a Brave process with the same old lease
    // generation, session marker and user-data directory can be reaped there.
    // This check must now find zero remaining marked processes. It NEVER kills
    // a merely matching process during ordinary startup.

    // Refuse startup if any unverified session-marked Brave process remains.
    await this.braveProfileManager.killOrphanedBraveProcesses(
      this.host.config.sessionId,
      this.host.logger,
    );

    // Remove stale lock files left by a crashed Brave instance
    // These files prevent Brave from opening the profile: "Profile is in use"
    await this.braveProfileManager.removeStaleSingletonFiles(
      this.host.config.sessionId,
      this.host.logger,
    );
    // ═══════════════════════════════════════════════════════════════════════

    await client.initialize();
    // whatsapp-web.js 1.34.x never observes the Chromium process/page it drives, so a crashed
    // browser leaves the client looking READY forever ("silent death"). Attach death listeners
    // to the puppeteer handles so a dead browser surfaces as a normal disconnect → reconnect.
    this.attachPuppeteerLifecycleListeners();
    this.host.logger.event(LogLevel.INFO, 'engine.browser.launch_succeeded', 'runInitAttempt',
      'Browser initialized and process supervision installed', {
        sessionId: this.host.config.sessionId, status: 'succeeded',
        elapsedMs: elapsedBrowserMs(launchStartedAt),
        browserPid: this.browserProcessSupervisor.getPid(client),
        headless: this.host.config.puppeteer?.headless ?? true,
      });
  }
  
  /**
   * Reset between a failed first init attempt and its single retry (#1081). Deliberately NOT
   * beginClientTeardown(): that would latch tearingDown (the adapter is single-use after teardown)
   * and write DISCONNECTED, whose disconnectReported latch permanently drops the retry's
   * qr/authenticated events. The reconcile clear matters most: the patched hasSynced level-check can
   * fire AUTHENTICATED before the navigation-killed evaluate rejects initialize(), leaving attempt
   * 1's 90s deadline live — its non-bridge branch deletes credentials (recoverFromStuckAuth), which
   * must never run underneath a retry that is about to succeed.
   *
   * Returns false when attempt 1's browser could not be destroyed within the bound — the caller
   * must then abandon the retry:launching a second Brave into the same userDataDir risks

   * "Profile already in use" lock conflicts copy (an irreversible re-pair), and the marker-based orphan
   * sweep is explicitly best-effort, so it cannot be trusted as the escalation for a LIVE browser.
   */
  private async resetForInitRetry(): Promise<boolean> {
    const failed = this.client;
    this.client = null;
    this.host.clearAuthReconcile();
    this.host.clearReadyReconcile();
    this.qrCode = null;
    this.setStatus(EngineStatus.INITIALIZING);
    if (!failed) return true;
    // The old client may still emit late events from persisted page bindings; 'authenticated' and
    // 'ready' have no source-client identity fence, so silence it before the new attempt starts.
    failed.removeAllListeners();
    // Bounded DIRECT destroy — never this.destroy()/forceDestroy(), both of which latch the
    // teardown flags above.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        failed.destroy(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('init-retry destroy timed out')), 5_000);
          timeout.unref?.();
        }),
      ]);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.host.logger.warn('Destroying the failed first init attempt did not complete cleanly', {
        error: message,
      });
      // A FAST rejection means the browser was already gone (destroy found nothing live to close) —
      // safe to relaunch. A TIMEOUT means a live, wedged Chromium still holds the profile.
      return message !== 'init-retry destroy timed out';
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /**
   * Resolve the Brave executable for the current operating system.
   *
   * Resolution order:
   *
   * 1. config.brave.executablePath, but only when the path really exists.
   * 2. config.puppeteer.executablePath, but only when the path really exists.
   * 3. Well-known Brave installation paths for the current OS.
   * 4. Brave binaries discoverable through PATH.
   *
   * This existence check is important because configuration.ts historically
   * defaulted brave.executablePath to `/usr/bin/brave`. Without validating that
   * path first, a Windows host receives the Linux default and Puppeteer fails
   * before Windows auto-detection can run.
   */
  private async resolveBraveExecutable(): Promise<string> {
    const seen = new Set<string>();
    const candidates: string[] = [];

    const addCandidate = (candidate?: string | null): void => {
      if (!candidate) {
        return;
      }

      const trimmed = candidate.trim();
      if (!trimmed || seen.has(trimmed)) {
        return;
      }

      seen.add(trimmed);
      candidates.push(trimmed);
    };

    /*
     * Explicit configuration has first priority, but it is not trusted blindly.
     * A stale/default Linux path on Windows must not prevent OS auto-detection.
     */
    addCandidate(this.host.config.brave?.executablePath);
    addCandidate(this.host.config.puppeteer?.executablePath);

    const pathDirectories = (process.env.PATH ?? '')
      .split(path.delimiter)
      .map(directory => directory.trim())
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
          addCandidate(
            path.join(
              root,
              'BraveSoftware',
              'Brave-Browser',
              'Application',
              'brave.exe',
            ),
          );

          addCandidate(
            path.join(
              root,
              'BraveSoftware',
              'Brave-Browser-Beta',
              'Application',
              'brave.exe',
            ),
          );

          addCandidate(
            path.join(
              root,
              'BraveSoftware',
              'Brave-Browser-Nightly',
              'Application',
              'brave.exe',
            ),
          );
        }

        for (const directory of pathDirectories) {
          addCandidate(path.join(directory, 'brave.exe'));
          addCandidate(path.join(directory, 'brave-browser.exe'));
        }

        break;
      }

      case 'darwin': {
        addCandidate(
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        );

        addCandidate(
          '/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta',
        );

        addCandidate(
          '/Applications/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly',
        );

        if (process.env.HOME) {
          addCandidate(
            path.join(
              process.env.HOME,
              'Applications',
              'Brave Browser.app',
              'Contents',
              'MacOS',
              'Brave Browser',
            ),
          );
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
        /*
         * Unknown Unix-like platforms still get a PATH-based attempt.
         */
        for (const directory of pathDirectories) {
          addCandidate(path.join(directory, 'brave-browser'));
          addCandidate(path.join(directory, 'brave'));
        }

        break;
      }
    }

    for (const candidate of candidates) {
      try {
        await fs.access(candidate);

        this.host.logger.log(
          `Using Brave browser executable: ${candidate}`,
          {
            platform: process.platform,
            executablePath: candidate,
            action: 'brave_executable_resolved',
          },
        );

        return candidate;
      } catch {
        /*
         * Candidate is absent/inaccessible on this host.
         * Continue to the next configured/OS/PATH location.
         */
      }
    }

    const configuredBrave = this.host.config.brave?.executablePath;
    const configuredPuppeteer = this.host.config.puppeteer?.executablePath;

    throw new Error(
      `Brave browser executable was not found for platform '${process.platform}'. ` +
        `Checked ${candidates.length} candidate path(s). ` +
        `Configured Brave path: ${configuredBrave || '(none)'}. ` +
        `Configured Puppeteer path: ${configuredPuppeteer || '(none)'}. ` +
        `Install Brave or set BRAVE_EXECUTABLE / brave.executablePath to the correct executable.`,
    );
  }

  setupEventHandlers(): void {
    if (!this.client) return;

    // Every handler registered by this call belongs to exactly one whatsapp-web.js Client generation.
    // Re-check that identity before mutating lifecycle state so a retired init-attempt/browser cannot
    // race a replacement client with late qr/authenticated/ready/disconnected events.
    const sourceClient = this.client;

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    sourceClient.on('qr', async (qr: string) => {
      // A 'qr' buffered by a wedged page can flush during the awaited client.destroy(), after
      // recoverFromStuckAuth() nulls this.client, or from a client that whatsapp-web.js re-injected
      // after a LOGOUT (#982) — in the last case the browser is still alive and will keep serving QRs
      // until the lifecycle replaces the engine. Ignore all of them so a late event can't resurrect a
      // finished adapter to QR_READY and publish a QR that links a phantom device. Mirrors the
      // 'authenticated' guard below; the normal first QR is unaffected (initialize() moves the status to
      // INITIALIZING before any client exists, so the latch is still clear).
      const statusAtQrStart = this.getStatus();
      if (
        this.client !== sourceClient ||
        this.tearingDown ||
        this.disconnectReported ||
        !this.client ||
        (statusAtQrStart !== EngineStatus.INITIALIZING && statusAtQrStart !== EngineStatus.QR_READY)
      ) {
        return;
      }
      // Capture the source client so the post-await fence can prove THIS client is still the live one.
      // qrcode.toDataURL() is an awaited macrotask: a 'disconnected' (or a teardown nulling this.client)
      // that lands during the encode leaves the pre-await guard stale. Encode to a LOCAL so the stored
      // qrCode is only touched once the fence re-proves the source client and the finished flags.
      const qrSourceClient = sourceClient;
      try {
        const encodedQr = await qrcode.toDataURL(qr);
        // Post-await fence: the encode resolved, but the source client may have disconnected or been
        // replaced while we were waiting. Re-check the live client identity and the finished flags before
        // assigning state, publishing a QR, or driving any downstream callback/webhook — a late encode for
        // a dead/finished adapter must be dropped, not resurrected. The status is read through getStatus()
        // (not `this.status`) so the pre-await guard's narrowing does not elide this comparison:
        // setStatus(FAILED) can run on another tick during the await.
        const currentStatus = this.getStatus();
        if (
          this.client !== qrSourceClient ||
          this.tearingDown ||
          this.disconnectReported ||
          (currentStatus !== EngineStatus.INITIALIZING && currentStatus !== EngineStatus.QR_READY)
        ) {
          /*
           * Authentication/readiness may have advanced while qrcode.toDataURL() was awaiting.
           * Never let a stale QR encode drive the state machine backwards:
           *
           *   AUTHENTICATING  -> QR_READY
           *   READY           -> QR_READY
           *   ACTION_REQUIRED -> QR_READY
           *   FAILED          -> QR_READY
           *
           * INITIALIZING -> QR_READY and QR_READY -> QR_READY are the only legitimate QR
           * transitions (the latter is normal QR rotation).
           */
          return;
        }

        this.qrCode = encodedQr;
        this.qrPresentedThisAttempt = true;
        this.setStatus(EngineStatus.QR_READY);
        this.emitConnectionStage('qr_ready');
        this.host.getCallbacks().onQRCode?.(this.qrCode);
        // Do not rely exclusively on whatsapp-web.js's `authenticated` edge. With a persistent
        // Brave profile the page can already be synced before that edge listener is attached; the
        // QR watcher is the runtime backstop that replays the missed handoff when necessary.
        this.host.scheduleAuthReconcile();
      } catch (error) {
        this.host.logger.error('Error generating QR code', String(error));
      }
    });

    sourceClient.on('authenticated', () => {
      // Only the first authentication starts the reconcile window. Ignore a re-fired 'authenticated'
      // while already AUTHENTICATING (so it can't restart the 90s deadline), once READY/FAILED, or any
      // time after the adapter is finished — teardown, or a reported disconnect the lifecycle has not
      // replaced the engine for yet (#982). The initial status is DISCONNECTED too, so "finished" is
      // carried by the flags, never by the status alone.
      if (
        this.client !== sourceClient ||
        this.tearingDown ||
        this.disconnectReported ||
        this.status === EngineStatus.AUTHENTICATING ||
        this.status === EngineStatus.READY ||
        this.status === EngineStatus.ACTION_REQUIRED ||
        this.status === EngineStatus.FAILED
      ) {
        return;
      }
      this.host.clearAuthReconcile();
      if (this.qrPresentedThisAttempt && !this.pairingCodeRequestedThisAttempt) {
        this.emitConnectionStage('qr_scanned');
      }
      this.emitConnectionStage('authenticated');
      this.setStatus(EngineStatus.AUTHENTICATING);
      this.emitConnectionStage('authenticating');
      this.qrCode = null;
      this.host.scheduleReadyReconcile();
    });

    sourceClient.on('ready', () => {
      // A late ready from a retired client must not touch a null/replaced client or resurrect a
      // terminal lifecycle state.
      if (
        this.client !== sourceClient ||
        !this.client ||
        this.tearingDown ||
        this.disconnectReported ||
        this.status === EngineStatus.DISCONNECTED ||
        this.status === EngineStatus.FAILED ||
        this.status === EngineStatus.ACTION_REQUIRED
      ) {
        return;
      }

      // 1.34.8's duplicate synced callback can emit ready before attachEventListeners resolves.
      // Our adapter-owned monitor tracks completion independently of the optional local patch.
      const bridgeStatus = this.getBridgeStatus(sourceClient);
      if (bridgeStatus !== 'attached') {
        this.host.logger.warn('Ignoring premature ready: event bridge completion is unverified', {
          sessionId: this.host.config.sessionId,
          bridgeStatus,
          action: 'premature_ready_ignored',
        });
        if (this.status !== EngineStatus.AUTHENTICATING) {
          this.host.clearAuthReconcile();
          this.setStatus(EngineStatus.AUTHENTICATING);
          this.host.scheduleReadyReconcile();
        }
        return;
      }

      // A bridge-capable ready is the completion edge for a post-navigation reinjection. Do this
      // before markReadyFromClientInfo(): that helper intentionally early-returns while already
      // READY, which is the normal state for a post-READY page reload.
      this.clearNavigationReinjectWindow();
      this.markReadyFromClientInfo();
    });

    // Message/group/call domain events: registered through the adapter's attachDomainEvents seam,
    // which wires ./wwebjs-message-events, ./wwebjs-group-events and the call-cache delegate.
    this.host.attachDomainEvents(sourceClient);

    sourceClient.on('disconnected', reason => {
      // whatsapp-web.js treats this event as terminal for this Client generation. Do not try to
      // preserve a pre-auth generation here: upstream may already be destroying its browser. The
      // generation fence prevents a later authenticated/ready from resurrecting that dead client.
      if (this.client !== sourceClient || this.tearingDown || this.disconnectReported) return;

      const reasonCode = String(reason);
      const statusAtDisconnect = this.status;
      const bridgeStatus = this.getBridgeStatus(sourceClient);
      const hasIdentity = Boolean(sourceClient.info?.wid?.user);

      this.host.logger.warn('WhatsApp Web client disconnected', {
        sessionId: this.host.config.sessionId,
        reason: reasonCode,
        status: statusAtDisconnect,
        hasIdentity,
        bridgeStatus,
        action: 'wwebjs_disconnected',
      });

      this.host.clearAuthReconcile();
      this.host.clearReadyReconcile();

      if (reasonCode === 'LOGOUT') {
        // With NoAuth the browser profile is the persistence layer. whatsapp-web.js/WA has already
        // performed the unlink; we preserve the browser profile itself (preferences/cache) and let
        // the next generation discover that it needs a fresh pairing.
        this.host.logger.warn(
          'WhatsApp unlinked this device (LOGOUT). The Brave profile container is preserved; ' +
            'the next start should return to pairing if the stored WA link is no longer valid.',
          { sessionId: this.host.config.sessionId, action: 'wwebjs_logout_disconnect' },
        );
      }

      this.setStatus(EngineStatus.DISCONNECTED);

      const restriction = WA_STATE_RESTRICTIONS[reasonCode];
      if (restriction) {
        this.host.getCallbacks().onAccountRestriction?.({ kind: restriction, code: reasonCode });
      }
      this.host.getCallbacks().onDisconnected?.(reasonCode);
    });

    sourceClient.on('auth_failure', (message?: string) => {
      if (this.client !== sourceClient || this.tearingDown || this.disconnectReported) return;
      this.host.clearAuthReconcile();
      this.host.clearReadyReconcile();
      this.setStatus(EngineStatus.FAILED);
      // Authentication failure is terminal for this generation. Do not automatically erase the
      // persistent Brave profile here: destructive cleanup is reserved for the one-shot stuck-auth
      // recovery path, which is session-budgeted and process-safe. Route this through onError.
      this.host.getCallbacks().onError?.(message ? `Authentication failed: ${message}` : 'Authentication failed');
    });
  }

  /**
   * Attach to the loosely-typed whatsapp-web.js puppeteer handles (same cast pattern as
   * isClientRuntimeReady/forceDestroy). whatsapp-web.js itself never listens to these, so without
   * this a dead Chromium is invisible: browser process death, renderer crash ("Aw Snap"), and a
   * closed tab all mean the session is gone, no matter what status the client still reports.
   */
  attachPuppeteerLifecycleListeners(): void {
    const sourceClient = this.client;
    if (!sourceClient) return;
    const { pupBrowser, pupPage } = sourceClient as unknown as {
      pupBrowser?: { on: (event: 'disconnected', cb: () => void) => void };
      pupPage?: {
        on: (event: 'error' | 'close' | 'framenavigated', cb: (frame?: { url?: () => string }) => void) => void;
        mainFrame?: () => unknown;
      };
    };
    let capturedProcess: ObservedBrowserProcess | null | undefined;
    try {
      capturedProcess = (
        sourceClient as unknown as { pupBrowser?: { process?: () => ObservedBrowserProcess | null } }
      ).pupBrowser?.process?.();
    } catch (error) {
      this.host.logger.warn('Unable to inspect Puppeteer browser process handle', {
        sessionId: this.host.config.sessionId,
        action: 'brave_process_handle_inspection_failed', error: String(error),
      });
    }
    const browserPid = this.browserProcessSupervisor.observe(
      sourceClient, capturedProcess,
      reason => this.handlePuppeteerDeath(reason, sourceClient),
      (_error, pid) => this.host.logger.event(LogLevel.WARN, 'engine.browser.process_error',
        'observeBrowser', 'Brave process emitted an error', {
          sessionId: this.host.config.sessionId, browserPid: pid,
          action: 'brave_process_error', status: 'failed',
          reasonCode: BraveFailureCode.BROWSER_PROCESS_ERROR,
        }),
    );
    if (browserPid !== null) {
      this.host.logger.event(LogLevel.INFO, 'engine.browser.process_supervised',
        'observeBrowser', 'Brave process now supervised', {
          sessionId: this.host.config.sessionId, browserPid,
          action: 'brave_process_supervised', status: 'succeeded',
          headless: this.host.config.puppeteer?.headless ?? true,
        });
    } else {
      this.host.logger.warn('Browser process handle unavailable; Puppeteer CDP death listeners remain active', {
        sessionId: this.host.config.sessionId,
        action: 'brave_process_handle_unavailable',
      });
    }
    // Puppeteer listeners outlive whatsapp-web.js removeAllListeners(). They MUST capture the
    // client which installed them, otherwise a delayed old-browser crash can kill a replacement.
    const isCurrent = (): boolean =>
      this.client === sourceClient && !this.tearingDown && !this.disconnectReported;
    pupBrowser?.on('disconnected', () => {
      if (isCurrent()) this.handlePuppeteerDeath('Browser process closed or crashed', sourceClient);
    });
    pupPage?.on('error', () => {
      if (isCurrent()) this.handlePuppeteerDeath('Page crashed', sourceClient);
    });
    pupPage?.on('close', () => {
      if (isCurrent()) this.handlePuppeteerDeath('Page closed', sourceClient);
    });
    // A page NAVIGATION fires none of the above: the page is healing, not dead — whatsapp-web.js
    // re-injects on its own framenavigated handler and re-emits 'ready' when done. Stamp the window
    // so probeLiveness and ensureReady treat it as alive-but-recovering (#1081). Never stamp the
    // LOGOUT navigation shapes (post_logout URL, or upstream's latched lastLoggedOut): there the
    // credential teardown driven by the DISCONNECTED('LOGOUT') event is the path that must win.
    pupPage?.on('framenavigated', frame => {
      if (!isCurrent()) return;
      try {
        // mainFrame is feature-detected: the spec harnesses' EventEmitter pages have no frames.
        if (typeof pupPage.mainFrame === 'function' && frame !== pupPage.mainFrame()) return;
        if (typeof frame?.url === 'function' && frame.url().includes('post_logout=1')) return;
      } catch {
        return; // the frame detached before this handler ran — nothing worth stamping
      }
      // lastLoggedOut is a runtime field the wwjs typings do not declare (same loose-cast pattern as
      // the pupBrowser/pupPage handles above).
      if ((this.client as unknown as { lastLoggedOut?: boolean } | null)?.lastLoggedOut) return;
      this.bridgeMonitor.invalidate(sourceClient);
      const now = Date.now();
      if (this.navigationEpisodeStartedAt === 0) this.navigationEpisodeStartedAt = now;
      this.lastMainFrameNavigationAt = now;
      // `graced: false` here means the episode cap already expired — the stamp is recorded but the
      // probe/ensureReady grace is NOT being granted, so the log must not claim it is.
      this.host.logger.warn('Page navigated; whatsapp-web.js is re-injecting', {
        sessionId: this.host.config.sessionId,
        action: 'page_navigation_reinject_window',
        graced: this.isInNavigationReinjectWindow(),
      });
    });
  }

  /**
   * Route a Chromium/page death (detected via the puppeteer handles) through the exact same path as
   * the client's own 'disconnected' event. A deliberate teardown also fires the browser's
   * 'disconnected', and a real crash usually fires page 'error' and browser 'disconnected' together
   * — so ignore calls during teardown or once the status already is DISCONNECTED/FAILED (first
   * signal wins, no double-report).
   */
  private handlePuppeteerDeath(reason: string, sourceClient: Client | null = this.client): void {
    if (!sourceClient || this.client !== sourceClient || this.tearingDown || this.disconnectReported) return;
    this.host.logger.event(LogLevel.WARN, 'engine.browser.death_observed', 'handlePuppeteerDeath', 'Browser process or page death observed', { sessionId: this.host.config.sessionId, observedReason: reason, actorType: 'unknown' });
    if (this.tearingDown || this.status === EngineStatus.DISCONNECTED || this.status === EngineStatus.FAILED) {
      return;
    }
    this.host.clearAuthReconcile();
    this.host.clearReadyReconcile();
    this.setStatus(EngineStatus.DISCONNECTED);
    this.host.getCallbacks().onDisconnected?.(reason);
  }

  /**
   * Error-message signatures of a dead page/transport: Puppeteer raises these when the browser
   * process, the renderer, or the CDP connection is gone (e.g. 'Protocol error: Target closed').
   */
  private static readonly PAGE_TRANSPORT_ERROR_PATTERN =
    /protocol error|target closed|targetclosederror|detached frame|session closed|connection closed/i;

  /**
   * A per-command CDP timeout is NOT a death: the renderer is merely slower than the budget, and
   * the next command may succeed. On Puppeteer 24.38.0 this message carries none of the signatures
   * above, so the guard changes no current behaviour — it pins the intent.
   *
   * Matched on the FULL puppeteer phrase, not a bare `timed out`: a broad exclusion would also
   * swallow a genuine death whose message happens to mention a timeout.
   */
  private static readonly PROTOCOL_TIMEOUT_PATTERN = /timed out\. increase the 'protocoltimeout'/i;

  /** Whether the error carries a dead page/transport signature (see PAGE_TRANSPORT_ERROR_PATTERN). */
  isPageTransportError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    if (WwebjsLifecycle.PROTOCOL_TIMEOUT_PATTERN.test(message)) {
      return false;
    }
    return WwebjsLifecycle.PAGE_TRANSPORT_ERROR_PATTERN.test(message);
  }

  public isProtocolTimeoutError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return WwebjsLifecycle.PROTOCOL_TIMEOUT_PATTERN.test(message);
  }
  

  async probeBrowserHealth(): Promise<boolean> {
  if (!this.client || this.tearingDown || this.status !== EngineStatus.READY) {
    return false;
  }

  const { pupPage } = this.client as unknown as {
    pupPage?: {
      isClosed?: () => boolean;
      evaluate: <T>(pageFunction: () => T) => Promise<T>;
    };
  };

  if (!pupPage) {
    return false;
  }

  if (typeof pupPage.isClosed === 'function' && pupPage.isClosed()) {
    return false;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      pupPage.evaluate(() => true),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('browser health probe timed out')),
          10_000,
        );
        timeout.unref?.();
      }),
    ]);

    return true;
  } catch (error) {
    this.host.logger.warn('Browser health probe failed', {
      sessionId: this.host.config.sessionId,
      error: error instanceof Error ? error.message : String(error),
      action: 'browser_health_probe_failed',
    });

    return false;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}


  /**
   * Error shapes that prove the target/CDP session is already gone. These can disconnect
   * immediately. A plain "Protocol error", "Execution context was destroyed", or "detached frame"
   * is deliberately NOT in this set because normal page navigation produces those too.
   */
  private static readonly HARD_PAGE_TRANSPORT_ERROR_PATTERN =
    /target closed|targetclosederror|session closed|connection closed|browser (?:has )?disconnected/i;

  /**
   * Report a failed page operation without promoting every Puppeteer protocol exception into an
   * immediate Session death.
   *
   * Hard target/connection closure is definitive and still disconnects synchronously. Ambiguous
   * protocol/context failures are first protected by the explicit navigation grace; outside that
   * window they receive a bounded PAGE_TRANSPORT_CONFIRMATION_MS health-check period. The original
   * operation still rejects to its caller immediately — only the Session-level death decision is
   * deferred.
   */
  reportIfPageTransportError(error: unknown, context: string): void {
    if (!this.isPageTransportError(error)) {
      return;
    }

    const message =
      error instanceof Error
        ? error.message
        : String(error);

    if (this.isInNavigationReinjectWindow()) {
      this.host.logger.warn(
        `Page transport error during ${context} inside the navigation re-inject window — not a death`,
        {
          sessionId: this.host.config.sessionId,
          error: message,
          action: 'page_transport_error_graced',
        },
      );
      return;
    }

    if (WwebjsLifecycle.HARD_PAGE_TRANSPORT_ERROR_PATTERN.test(message)) {
      this.host.logger.warn(
        `Hard page transport error during ${context} — treating the session as dead`,
        {
          sessionId: this.host.config.sessionId,
          error: message,
          action: 'page_transport_error_hard_death',
        },
      );
      this.handlePuppeteerDeath(`Page transport error during ${context}`);
      return;
    }

    if (this.pageTransportConfirmationInFlight) {
      this.host.logger.warn(
        `Ambiguous page transport error during ${context} while a health confirmation is already running`,
        {
          sessionId: this.host.config.sessionId,
          error: message,
          action: 'page_transport_error_confirmation_coalesced',
        },
      );
      return;
    }

    this.pageTransportConfirmationInFlight = true;
    this.host.logger.warn(
      `Ambiguous page transport error during ${context}; confirming browser death before disconnecting`,
      {
        sessionId: this.host.config.sessionId,
        error: message,
        confirmationMs: PAGE_TRANSPORT_CONFIRMATION_MS,
        action: 'page_transport_error_confirmation_started',
      },
    );

    void this.confirmAmbiguousPageTransportFailure(context)
      .catch(confirmError => {
        this.host.logger.warn('Page transport health confirmation failed unexpectedly', {
          sessionId: this.host.config.sessionId,
          context,
          error:
            confirmError instanceof Error
              ? confirmError.message
              : String(confirmError),
          action: 'page_transport_error_confirmation_failed',
        });
      })
      .finally(() => {
        this.pageTransportConfirmationInFlight = false;
      });
  }

  /**
   * Confirm ambiguous transport death with repeated direct page probes. Twenty seconds is long
   * enough to absorb the short context-destruction/reload gap seen in production without turning a
   * truly wedged READY session into a multi-minute zombie.
   */
  private async confirmAmbiguousPageTransportFailure(context: string): Promise<void> {
    const sourceClient = this.client;
    if (
      !sourceClient ||
      this.tearingDown ||
      this.status !== EngineStatus.READY
    ) {
      return;
    }

    const deadline =
      Date.now() +
      PAGE_TRANSPORT_CONFIRMATION_MS;

    while (Date.now() < deadline) {
      if (
        this.client !== sourceClient ||
        this.tearingDown ||
        this.status !== EngineStatus.READY
      ) {
        return;
      }

      if (this.isInNavigationReinjectWindow()) {
        this.host.logger.warn(
          `Navigation/reinjection was observed while confirming ${context}; keeping the session alive`,
          {
            sessionId: this.host.config.sessionId,
            action: 'page_transport_error_confirmation_graced',
          },
        );
        return;
      }

      if (await this.probeBrowserHealth()) {
        this.host.logger.warn(
          `Browser recovered while confirming page transport error during ${context}; keeping the session alive`,
          {
            sessionId: this.host.config.sessionId,
            action: 'page_transport_error_confirmation_recovered',
          },
        );
        return;
      }

      const remainingMs =
        deadline -
        Date.now();

      if (remainingMs <= 0) {
        break;
      }

      await new Promise<void>(resolve => {
        const timer = setTimeout(
          resolve,
          Math.min(
            PAGE_TRANSPORT_CONFIRMATION_PROBE_INTERVAL_MS,
            remainingMs,
          ),
        );
        timer.unref?.();
      });
    }

    if (
      this.client !== sourceClient ||
      this.tearingDown ||
      this.status !== EngineStatus.READY
    ) {
      return;
    }

    if (this.isInNavigationReinjectWindow()) {
      return;
    }

    this.host.logger.warn(
      `Page transport remained unhealthy for ${PAGE_TRANSPORT_CONFIRMATION_MS}ms during ${context}; treating the session as dead`,
      {
        sessionId: this.host.config.sessionId,
        action: 'page_transport_error_confirmed_dead',
      },
    );
    this.handlePuppeteerDeath(`Confirmed page transport failure during ${context}`);
  }

  getBridgeStatus(client: Client | null = this.client): WwebjsBridgeStatus {
    return this.bridgeMonitor.getStatus(client);
  }

  markReadyFromClientInfo(): void {
    if (
      [EngineStatus.READY, EngineStatus.DISCONNECTED, EngineStatus.FAILED, EngineStatus.ACTION_REQUIRED].includes(
        this.status,
      )
    ) {
      return;
    }

    const wasAuthenticating = this.status === EngineStatus.AUTHENTICATING;

    try {
      const info = this.client?.info;
      const phone = info?.wid?.user || null;
      const pushName = info?.pushname || null;

      // READY is the persisted identity boundary. Never publish READY with an empty phone: doing so
      // makes the DB say the engine is usable while the account identity is unknown, and it also
      // defeats restart logic that relies on a completed link. If a library `ready` emit races
      // ClientInfo population, stay/re-enter AUTHENTICATING and let the existing reconciler retry.
      if (!phone) {
        this.host.logger.warn(
          'WhatsApp Web signalled readiness before the own-account identity was available; keeping the session authenticating',
          {
            sessionId: this.host.config.sessionId,
            action: 'ready_identity_not_available',
          },
        );

        this.host.clearAuthReconcile();
        if (!wasAuthenticating) {
          this.setStatus(EngineStatus.AUTHENTICATING);
          this.host.scheduleReadyReconcile();
        }
        return;
      }

      // Do not trust a bare upstream `ready`: 1.34.8 can emit it from a duplicate synced handoff
      // even while attachEventListeners() is still in flight. Only a positively completed attach
      // (for THIS Client and page generation) can open the READY boundary.
      const bridgeStatus = this.getBridgeStatus();
      if (bridgeStatus !== 'attached') {
        this.host.logger.warn('WhatsApp identity is available but its message event bridge is not verified', {
          sessionId: this.host.config.sessionId,
          bridgeStatus,
          action: 'ready_bridge_unverified',
        });
        this.host.clearAuthReconcile();
        if (!wasAuthenticating) {
          this.setStatus(EngineStatus.AUTHENTICATING);
          this.host.scheduleReadyReconcile();
        }
        return;
      }

      this.phoneNumber = phone;
      this.pushName = pushName;
      this.emitConnectionStage('runtime_connected');
      this.emitConnectionStage('identity_ready');
      this.emitConnectionStage('event_bridge_ready');

      this.host.clearAuthReconcile();
      this.host.clearReadyReconcile();
      this.setStatus(EngineStatus.READY);
      this.emitConnectionStage('ready');
      this.host.getCallbacks().onReady?.(phone, pushName || '');

      // A freshly-linked account may show a "What's new" onboarding modal that, left
      // unacknowledged, gets the companion unlinked later. Arm the watcher only after the session
      // has a real identity and READY has actually been published.
      this.host.startOnboardingWatcher();
    } catch (error) {
      this.host.logger.error('Error getting client info', String(error));

      // An exception reading ClientInfo is not proof of readiness. Preserve/re-enter the
      // AUTHENTICATING state and allow the normal reconciliation window to retry instead of
      // persisting READY with an empty identity.
      this.host.clearAuthReconcile();
      if (!wasAuthenticating) {
        this.setStatus(EngineStatus.AUTHENTICATING);
        this.host.scheduleReadyReconcile();
      }
    }
  }

  /** The single status-transition funnel: latches disconnectReported, fires the callback, re-emits
   *  on the adapter's EventEmitter. Public because the sibling delegates (reconcile, stuck-auth,
   *  onboarding watcher) drive transitions through their host slices. */
  setStatus(status: EngineStatus): void {
    // Latch before anything observes the transition. The constructor's initial DISCONNECTED is a field
    // initializer and never reaches here, so this only ever fires on a real transition — startup is
    // unaffected while a finished adapter is marked finished for good.
    if (status === EngineStatus.DISCONNECTED) {
      this.disconnectReported = true;
    }
    // The cached QR belongs to the page that produced it, so it dies with the QR_READY window. Same
    // funnel placement as the Baileys engine: only the 'authenticated' and init-retry exits cleared the
    // cache by hand, so a browser or page death, a failed init, an auth failure and teardown all left a
    // dead QR to be served over GET /qr for the whole reconnect backoff.
    if (status !== EngineStatus.QR_READY) {
      this.qrCode = null;
    }
    this.status = status;
    if (status === EngineStatus.DISCONNECTED || status === EngineStatus.FAILED) {
      this.host.closeInboundMedia();
    }
    this.host.getCallbacks().onStateChanged?.(status);
    this.host.emitState(status);
  }

  private beginClientTeardown(): Client | null {
    this.tearingDown = true;
    // Any cached call handle is dead once the client goes away — drop them all so a later
    // rejectCall() reports not-found instead of acting on a destroyed page.
    this.host.clearLiveCalls();
    // Before the clientless early-return: a teardown must always close the navigation window, or a
    // stale stamp could grace the next generation's probe (single-use contract notwithstanding).
    this.clearNavigationReinjectWindow();
    this.host.clearAuthReconcile();
    this.host.clearReadyReconcile();
    const client = this.client;
    if (!client) return null;

    this.host.clearOnboardingWatcher();
    if (this.status !== EngineStatus.DISCONNECTED) {
      this.setStatus(EngineStatus.DISCONNECTED);
    }

    return client;
  }

  private finishClientTeardown(client: Client): void {
    this.browserProcessSupervisor.detach(client);
    if (this.client === client) {
      this.client = null;
    }
    this.host.clearAuthReconcile();
    this.host.clearReadyReconcile();
    this.host.clearOnboardingWatcher();
    this.clearNavigationReinjectWindow();
  }

  /** The same browser generation may be retired by disconnect() and then forceDestroy(). */
  private destroyClientOnce(client: Client): Promise<void> {
    const pending = this.pendingClientDestroy;
    if (pending && pending.client === client) return pending.promise;
    const promise = Promise.resolve().then(() => client.destroy());
    this.pendingClientDestroy = { client, promise };
    return promise;
  }

  private capturedBrowserPid(client: Client): number | null {
    const processHandle = (
      client as unknown as { pupBrowser?: { process?: () => ObservedBrowserProcess | null } }
    ).pupBrowser?.process?.();
    return this.browserProcessSupervisor.getPid(client) ?? processHandle?.pid ?? null;
  }

  /**
   * Phase 3 teardown: first ask whatsapp-web.js to close, then escalate ONLY against the
   * browser captured by this adapter generation and this filesystem lease owner token.
   * A missing PID never authorizes kill-by-name. The lease release independently checks
   * all session-marked browsers and fails closed if one remains or enumeration fails.
   *
   * A failed lease release is not swallowed. The client remains attached on failure so
   * SessionEngineControls.stop() can retry using forceDestroy() without losing its PID.
   */
  private async teardownBrowser(
    client: Client, forceFirst: boolean, action: string, releaseLease = true,
  ): Promise<void> {
    const teardownStartedAt = Date.now();
    this.host.logger.event(LogLevel.INFO, 'engine.browser.teardown_started', action,
      'Browser teardown started', {
        sessionId: this.host.config.sessionId, status: 'started',
        forced: forceFirst, browserPid: this.browserProcessSupervisor.getPid(client),
      });
    let gracefulError: unknown;
    let terminationError: unknown;
    let forced = forceFirst;
    const hadLease = Boolean(this.profileLeaseRelease);
    let forcedSucceeded = false;
    let destroySucceeded = false;

    if (!forceFirst) {
      try {
        await boundedBrowserOperation(
          () => this.destroyClientOnce(client),
          BROWSER_TEARDOWN_BUDGETS.graceMs,
          'client.destroy()',
        );
        destroySucceeded = true;
      } catch (error) {
        gracefulError = error;
        forced = true;
        this.host.logger.warn('Graceful Brave shutdown incomplete; escalating to owned tree termination', {
          sessionId: this.host.config.sessionId, action: 'brave_graceful_shutdown_incomplete',
          operation: action, error: String(error),
        });
      }
    }

    if (forced) {
      const browserPid = this.capturedBrowserPid(client);
      if (browserPid) {
        try {
          await boundedBrowserOperation(
            () => this.braveProfileManager.terminateOwnedBrowserTree(
              this.host.config.sessionId, browserPid, this.host.logger,
              this.profileLeaseRelease?.ownerToken ?? '',
            ),
            BROWSER_TEARDOWN_BUDGETS.forceMs,
            'owned Brave process-tree termination',
          );
          forcedSucceeded = true;
        } catch (error) {
          terminationError = error;
          this.host.logger.warn('Ownership-verified Brave tree termination incomplete', {
            sessionId: this.host.config.sessionId, action: 'brave_owned_tree_termination_failed',
            operation: action, browserPid, error: String(error),
          });
        }
      } else {
        this.host.logger.warn('No captured Brave PID; cannot use forced OS termination', {
          sessionId: this.host.config.sessionId, action: 'brave_process_pid_missing', operation: action,
        });
      }
      // In a force-first path CDP teardown can hang after its browser has already exited.
      // Bound it; whether teardown is actually safe is decided by verified tree termination
      // AND release of our filesystem lock, not whether a dead CDP connection resolves.
      if (forceFirst) {
        try {
          await boundedBrowserOperation(
            () => this.destroyClientOnce(client),
            BROWSER_TEARDOWN_BUDGETS.postKillDestroyMs,
            'client.destroy() after forced termination',
          );
          destroySucceeded = true;
        } catch (error) {
          gracefulError = error;
          this.host.logger.warn('Post-termination client.destroy() incomplete', {
            sessionId: this.host.config.sessionId, action: 'brave_post_kill_destroy_incomplete',
            operation: action, error: String(error),
          });
        }
      }
    }

    // Profile reset keeps this same lease while deleting credentials. Never release it
    // before the deletion; instead verify independently that no session browser lives.
    try {
      if (releaseLease) {
        await this.releaseProfileLease();
      } else {
        await boundedBrowserOperation(
          () => this.braveProfileManager.killOrphanedBraveProcesses(
            this.host.config.sessionId, this.host.logger, false,
          ),
          BROWSER_TEARDOWN_BUDGETS.leaseMs,
          'Brave profile-reset process verification',
        );
      }
    } catch (releaseError) {
      this.host.logger.event(LogLevel.ERROR, 'engine.browser.teardown_failed', action,
        'Brave teardown incomplete; ownership remains protected', {
          sessionId: this.host.config.sessionId, status: 'failed',
          reasonCode: BraveFailureCode.BROWSER_TEARDOWN_INCOMPLETE,
          browserPid: this.browserProcessSupervisor.getPid(client), forced,
          elapsedMs: elapsedBrowserMs(teardownStartedAt),
        });
      throw new Error(
        `BROWSER_TEARDOWN_INCOMPLETE: ${action}: profile lock retained; ` +
        `graceful=${String(gracefulError ?? 'ok')}; ` +
        `forced=${String(terminationError ?? 'not needed')}; ` +
        `release=${String(releaseError)}`,
      );
    }

    // Standalone adapters constructed without a lease must not silently count a failed
    // destroy or a failed kill as complete. A real leased adapter relies on the release
    // callback's independently verified absence of session-marked browser processes.
    if (!hadLease && !destroySucceeded && !forcedSucceeded) {
      this.host.logger.event(LogLevel.ERROR, 'engine.browser.teardown_failed', action,
        'Brave teardown incomplete; browser exit not verified', {
          sessionId: this.host.config.sessionId, status: 'failed',
          reasonCode: BraveFailureCode.BROWSER_TEARDOWN_INCOMPLETE,
          elapsedMs: elapsedBrowserMs(teardownStartedAt), forced,
        });
      throw new Error(`BROWSER_TEARDOWN_INCOMPLETE: ${action}: browser exit not verified`);
    }
    this.finishClientTeardown(client);
    this.host.logger.event(LogLevel.INFO, 'engine.browser.teardown_succeeded', action,
      'Brave teardown completed', {
        sessionId: this.host.config.sessionId, action: 'brave_teardown_complete',
        status: 'succeeded', elapsedMs: elapsedBrowserMs(teardownStartedAt),
        forced, browserPid: this.browserProcessSupervisor.getPid(client),
      });
  }

  private async finishTeardownWithClient(client: Client | null, force: boolean, action: string): Promise<void> {
    if (!client) {
      // The stuck-auth path temporarily detaches its Client before deleting the profile.
      // A concurrent forceDestroy()/destroy() must not unlock it in the middle of deletion.
      if (this.profileResetActive) {
        throw new Error('BROWSER_PROFILE_RESET_IN_PROGRESS: profile lease remains held');
      }
      await this.releaseProfileLease();
      return;
    }
    await this.teardownBrowser(client, force, action);
  }

  /** Called synchronously before stuck-auth detaches its client, fencing competing teardown. */
  beginProfileReset(): void {
    this.profileResetActive = true;
  }

  /** Stuck-auth reset holds this lease while its dedicated profile is deleted. */
  async stopClientForProfileReset(client: Client | null): Promise<void> {
    this.profileResetActive = true;
    if (!client) {
      await boundedBrowserOperation(
        () => this.braveProfileManager.killOrphanedBraveProcesses(
          this.host.config.sessionId, this.host.logger, false,
        ),
        BROWSER_TEARDOWN_BUDGETS.leaseMs,
        'Brave profile-reset process verification',
      );
      return;
    }
    await this.teardownBrowser(client, false, 'stuck-auth-reset', false);
  }

  /** Invoked only after successful profile deletion, never before. */
  async completeProfileReset(): Promise<void> {
    await this.releaseProfileLease();
    this.profileResetActive = false;
  }

  async disconnect(): Promise<void> {
    this.host.logger.event(LogLevel.INFO, 'engine.wwebjs.disconnect_requested', 'disconnect', 'Browser engine disconnect requested', { sessionId: this.host.config.sessionId });
    const client = this.beginClientTeardown();
    await this.finishTeardownWithClient(client, false, 'disconnect');
  }

  async logout(): Promise<void> {
    this.host.logger.event(LogLevel.INFO, 'engine.wwebjs.logout_requested', 'logout', 'Browser engine logout requested', { sessionId: this.host.config.sessionId });
    this.logoutInitiated = true;
    const client = this.beginClientTeardown();
    if (!client) {
      await this.releaseProfileLease();
      throw new Error('No live WhatsApp Web client — the unlink was not sent');
    }

    let logoutError: unknown;
    try {
      await boundedBrowserOperation(
        () => client.logout(), BROWSER_TEARDOWN_BUDGETS.graceMs, 'client.logout()',
      );
    } catch (error) {
      logoutError = error;
      this.host.logger.warn('WhatsApp logout did not complete; retiring the browser', {
        sessionId: this.host.config.sessionId, action: 'brave_logout_incomplete', error: String(error),
      });
    }
    if (!logoutError) {
      // whatsapp-web.js logout() already invokes destroy() before it resolves. Do NOT
      // call destroy() again: it can hang on a closed CDP session and turn a confirmed
      // unlink into a false timeout. Its profile lease still verifies browser exit.
      try {
        await this.releaseProfileLease();
        this.finishClientTeardown(client);
        return;
      } catch (releaseError) {
        // An acknowledged remote unlink is not enough to free an occupied profile.
        // Escalate only with our captured PID + owner token. Failure remains visible.
        this.host.logger.warn('Logout completed but browser ownership remains; escalating', {
          sessionId: this.host.config.sessionId,
          action: 'brave_logout_cleanup_escalation', error: String(releaseError),
        });
        await this.teardownBrowser(client, true, 'logout-post-unlink');
        return;
      }
    }

    // An unacknowledged/failed unlink must NEVER be reported as a successful logout.
    // Retire the local browser anyway, retaining the lock on unsafe teardown.
    try {
      await this.teardownBrowser(client, true, 'logout');
    } catch (cleanupError) {
      throw new AggregateError([logoutError, cleanupError], 'WhatsApp logout and browser teardown both failed');
    }
    throw logoutError;
  }

  async destroy(): Promise<void> {
    this.host.logger.event(LogLevel.DEBUG, 'engine.wwebjs.destroy_requested', 'destroy', 'Browser engine destroy requested', { sessionId: this.host.config.sessionId });
    const client = this.beginClientTeardown();
    await this.finishTeardownWithClient(client, false, 'destroy');
  }

  /** Bounded immediate escalation for a wedged CDP client; never a machine-wide Brave kill. */
  async forceDestroy(): Promise<void> {
    this.host.logger.event(LogLevel.WARN, 'engine.wwebjs.force_destroy_requested', 'forceDestroy', 'Browser forced destruction requested', { sessionId: this.host.config.sessionId });
    const client = this.beginClientTeardown();
    await this.finishTeardownWithClient(client, true, 'forceDestroy');
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  /**
   * Whether a recent main-frame navigation is still inside its bounded re-inject window. Two bounds:
   * the rolling per-navigation grace, and the per-episode cap that stops a navigation LOOP from
   * re-stamping its way past the watchdog forever. Consulted only AFTER the READY-status gates in
   * probeLiveness()/ensureReady() — a teardown or LOGOUT drops the status first, and the grace must
   * never outrank that (#1081).
   */
  /**
   * Stamp the navigation/reinjection grace BEFORE code intentionally calls page.reload().
   *
   * Relying only on Puppeteer's later `framenavigated` event leaves a small race where an in-flight
   * delegate evaluate rejects first. The readiness reconciler calls this method immediately before
   * its deliberate reinjection reloads, so those errors are correctly treated as transient from
   * the first millisecond of the reload.
   */
  beginNavigationReinjectWindow(reason: string): void {
    if (
      this.tearingDown ||
      this.status === EngineStatus.DISCONNECTED ||
      this.status === EngineStatus.FAILED
    ) {
      return;
    }

    this.bridgeMonitor.invalidate(this.client!);
    const now = Date.now();
    if (this.navigationEpisodeStartedAt === 0) {
      this.navigationEpisodeStartedAt = now;
    }
    this.lastMainFrameNavigationAt = now;

    this.host.logger.warn('WhatsApp Web page reload/reinjection is expected', {
      sessionId: this.host.config.sessionId,
      reason,
      action: 'page_navigation_reinject_expected',
      graced: this.isInNavigationReinjectWindow(),
    });
  }

  isInNavigationReinjectWindow(): boolean {
    if (this.lastMainFrameNavigationAt === 0) return false;
    const now = Date.now();
    return (
      now - this.lastMainFrameNavigationAt < NAVIGATION_REINJECT_GRACE_MS &&
      now - this.navigationEpisodeStartedAt < NAVIGATION_EPISODE_CAP_MS
    );
  }

  private clearNavigationReinjectWindow(): void {
    this.lastMainFrameNavigationAt = 0;
    this.navigationEpisodeStartedAt = 0;
  }

  /**
   * Active liveness probe for the session watchdog: race a real getState() round-trip against a 10s
   * timeout. Probe failure or timeout means dead — a wedged page can keep reporting CONNECTED
   * (whatsapp-web.js #5728), so turning consecutive probe failures into a reconnect decision stays
   * the calling watchdog's job. One exception: inside the bounded navigation re-inject window a
   * failing probe answers alive, since the page is healing, not dead (#1081).
   */
  async probeLiveness(): Promise<boolean> {
    if (this.status !== EngineStatus.READY || !this.client) return false;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const sourceClient = this.client;
      const state = await Promise.race([
        sourceClient.getState(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('liveness probe timed out')), 10_000);
          timeout.unref?.();
        }),
      ]);
      if (this.client !== sourceClient) return false;
      if (state === WAState.CONNECTED) {
        // WA socket connectivity does not prove that Node receives messages. During page reload,
        // allow the bounded reinjection grace; after it expires, let the watchdog recover the engine.
        if (this.getBridgeStatus(sourceClient) !== 'attached') {
          return this.isInNavigationReinjectWindow();
        }
        this.clearNavigationReinjectWindow();
        return true;
      }
      return this.isInNavigationReinjectWindow();
    } catch {
      // Inside the navigation window the evaluate rejecting (context destroyed, window.require not
      // yet a function) means the page is healing, not dead — answer alive so the watchdog does not
      // tear down a session whatsapp-web.js is about to re-inject (#1081). The window is bounded, so
      // a page that navigated and then wedged still dies within one extra watchdog interval.
      return this.isInNavigationReinjectWindow();
    } finally {
      // Never leave the timeout dangling when getState() settles first (Jest open-handle hygiene).
      if (timeout) clearTimeout(timeout);
    }
  }

  /**
   * Request an 8-char pairing code so the user can link via "Link with phone number" instead of
   * scanning the QR.
   *
   * Gated on QR_READY, not on the client merely existing. `this.client` is assigned before
   * `client.initialize()` (see runInitAttempt), so for the whole Chromium launch — seconds on a
   * modest host — a client is present while its `pupPage` is still null, and whatsapp-web.js's
   * requestPairingCode reaches `exposeFunctionIfAbsent(this.pupPage, …)` and throws a raw TypeError
   * that surfaces as a 500. QR_READY is the precise window this can work in anyway: the library
   * emits 'qr' only once the Store is injected and the in-page socket reports UNPAIRED, which are
   * the same preconditions the pairing flow needs.
   */
  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.client || this.status !== EngineStatus.QR_READY) {
      throw new EngineNotReadyError('Session is not waiting to be linked. Start it and wait for the QR stage.');
    }
    const pairingCode = await this.client.requestPairingCode(phoneNumber);
    this.pairingCodeRequestedThisAttempt = true;
    return pairingCode;
  }

  
  async handleProtocolTimeout(operation: string): Promise<void> {
    const MAX_PROTOCOL_TIMEOUT_RECOVERY_ATTEMPTS = 2;

    this.host.logger.warn('Puppeteer protocol timeout detected', {
      sessionId: this.host.config.sessionId,
      operation,
      status: this.status,
      consecutiveProtocolTimeouts: this.consecutiveProtocolTimeouts,
      action: 'protocol_timeout_detected',
    });

    if (
      this.tearingDown ||
      this.status === EngineStatus.DISCONNECTED ||
      this.status === EngineStatus.FAILED ||
      !this.client
    ) {
      return;
    }

    /*
    * First question:
    * Is the Chromium/CDP/page transport still responsive?
    */
    const browserHealthy = await this.probeBrowserHealth();

    if (browserHealthy) {
      this.consecutiveProtocolTimeouts = 0;

      this.host.logger.warn(
        'Browser is responsive after protocol timeout; keeping session alive',
        {
          sessionId: this.host.config.sessionId,
          operation,
          action: 'protocol_timeout_browser_healthy',
        },
      );

      return;
    }

    /*
    * The direct page probe failed.
    *
    * Before destroying the browser, give the existing whatsapp-web.js
    * liveness probe a chance to confirm that the WhatsApp runtime itself
    * is still alive/recovering.
    */
    const waRuntimeHealthy = await this.probeLiveness();

    if (waRuntimeHealthy) {
      this.consecutiveProtocolTimeouts = 0;

      this.host.logger.warn(
        'WhatsApp runtime is still responsive after protocol timeout; keeping session alive',
        {
          sessionId: this.host.config.sessionId,
          operation,
          action: 'protocol_timeout_wa_runtime_healthy',
        },
      );

      return;
    }

    /*
    * Both probes failed.
    *
    * Do NOT kill the browser on the first occurrence. Count consecutive
    * failures and only escalate after repeated evidence of a wedged session.
    */
    this.consecutiveProtocolTimeouts += 1;

    this.host.logger.error(
  `Protocol timeout followed by failed browser and WhatsApp liveness probes ` +
    `(sessionId=${this.host.config.sessionId}, operation=${operation}, ` +
    `consecutiveProtocolTimeouts=${this.consecutiveProtocolTimeouts}, ` +
    `recoveryThreshold=${MAX_PROTOCOL_TIMEOUT_RECOVERY_ATTEMPTS}, ` +
    `action=protocol_timeout_health_failed)`,
);
  

    if (
      this.consecutiveProtocolTimeouts <
      MAX_PROTOCOL_TIMEOUT_RECOVERY_ATTEMPTS
    ) {
      this.host.logger.warn(
        'Keeping the session alive after the first failed protocol-timeout recovery check',
        {
          sessionId: this.host.config.sessionId,
          operation,
          consecutiveProtocolTimeouts: this.consecutiveProtocolTimeouts,
          action: 'protocol_timeout_recovery_deferred',
        },
      );

      return;
    }

    this.host.logger.error(
  `Repeated protocol timeouts with failed health checks; forcing browser recovery ` +
    `(sessionId=${this.host.config.sessionId}, operation=${operation}, ` +
    `consecutiveProtocolTimeouts=${this.consecutiveProtocolTimeouts}, ` +
    `action=protocol_timeout_force_destroy)`,
);

    this.consecutiveProtocolTimeouts = 0;

    await this.forceDestroy();
  }








}




  









