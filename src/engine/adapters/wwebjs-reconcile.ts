


import { type Client, WAState } from 'whatsapp-web.js';
import { type EngineEventCallbacks, EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { type createLogger } from '../../common/services/logger.service';
import { type WhatsAppWebJsConfig } from './whatsapp-web-js.adapter';
import {
  DEFAULT_WWEBJS_READY_TIMEOUT_MS,
  resolveReadyTimeoutMs,
} from '../engine-init-timeout';

/**
 * Readiness reconciliation extracted from WhatsAppWebJsAdapter: the post-authentication window that
 * promotes a session the library's own `ready` event missed (or failed to attach the inbound bridge
 * for), and the one-shot page reload for a CONNECTED-but-bridge-dead session. The adapter keeps the
 * methods as thin forwarders and injects the host surface via closures, so the delegate never
 * touches lifecycle state directly.
 */
export interface WwebjsReadyReconcileHost {
  readonly logger: ReturnType<typeof createLogger>;
  readonly config: WhatsAppWebJsConfig;
  getClient(): Client | null;
  getStatus(): EngineStatus;
  setStatus(status: EngineStatus): void;
  /** Live callbacks bag — read per event, since initialize() installs it after delegates are built. */
  getCallbacks(): EngineEventCallbacks;
  /** Promote to READY off the live client's info — the lifecycle's own ready path. */
  markReadyFromClientInfo(): void;
  /** The deadline's non-bridge branch: clear the broken auth and let the lifecycle re-pair. */
  recoverFromStuckAuth(): Promise<void>;
}

const AUTH_RECONCILE_INTERVAL_MS = 2000;
const AUTH_RECONCILE_REPLAY_BACKOFF_MS = 10_000;
// Give the normal page->Node authentication pipeline one replay-only turn. Later successful replays
// fall through to direct runtime probing in the same reconciliation tick instead of trusting an edge
// that has already failed to advance OpenWA once.
const AUTH_RECONCILE_REPLAY_FALLBACK_THRESHOLD = 2;
/**
 * A reconciliation probe must never own the in-flight latch indefinitely. Puppeteer/CDP calls can
 * remain pending when a renderer is half-alive, which is exactly the state this reconciler exists
 * to recover from. The wrapper times out our WAIT only; the underlying Puppeteer promise may still
 * settle later, so the replay backoff prevents a tight pile-up of replacement probes.
 */
const RECONCILE_PROBE_TIMEOUT_MS = 5_000;
const READY_RECONCILE_INTERVAL_MS = 2000;
/**
 * Backward-compatible export for code/tests that referenced the old fixed constant.
 *
 * This is now the DEFAULT only. Each readiness-reconciliation run resolves the live
 * WWEBJS_READY_TIMEOUT_MS value through resolveReadyTimeoutMs().
 */
export const READY_RECONCILE_TIMEOUT_MS = DEFAULT_WWEBJS_READY_TIMEOUT_MS;

// How long after `authenticated` the event bridge is allowed to still be attaching before a reload is
// considered. whatsapp-web.js clears `eventsAttached` in its constructor (Client.js:109) and sets it
// only once attachEventListeners() resolves (Client.js:373); in between it evaluates LoadUtils, polls
// up to 30s for window.WWebJS (Client.js:334), then builds ClientInfo and InterfaceController. So a
// false flag is the NORMAL reading for most of a minute on a loaded host, and reloading on it aborts
// a healthy attach — the page navigates out from under the in-flight inject(), which then dies before
// re-exposing the bridge and cannot be retried (#1081). Must exceed upstream's own 30s poll with room
// for the rest of the pipeline, and stay well under READY_RECONCILE_TIMEOUT_MS so a reload that IS
// warranted still has time to reinject before the deadline.
export const READY_RECONCILE_BRIDGE_RELOAD_GRACE_MS = 45_000;

/**
 * A QR scan can succeed while whatsapp-web.js misses its `authenticated` / `hasSynced` handoff.
 * Once the page itself proves CONNECTED + identity, keep the saved pairing and allow the normal
 * post-auth pipeline time to settle before doing one page reload/reinjection. This is deliberately
 * longer than the bridge-only grace because slow phones/accounts can spend a while syncing after
 * they first become linked.
 */
export const QR_CONNECTED_REINJECT_GRACE_MS = 90_000;

interface QrPageAuthenticationProbe {
  connected: boolean;
  hasSynced: boolean;
  hasIdentity: boolean;
  replayed: boolean;
}

export class WwebjsReadyReconcile {
  // Pre-authentication backstop. The normal path is whatsapp-web.js emitting `authenticated`.
  // A warm/persistent profile can already have Socket.hasSynced=true before its edge listener is
  // attached, leaving OpenWA stuck in QR_READY even though the phone shows the device as linked.
  private authReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private authReconcileProbeInFlight = false;
  private lastAuthReplayAt = 0;
  private authReplayCount = 0;

  private readyReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private readyReconcileStartedAt = 0;
  private readyReconcileTimeoutMs = READY_RECONCILE_TIMEOUT_MS;
  private readyReconcileProbeInFlight = false;

  // Current Node-side getState() observation. This remains separate from hasObservedConnected because
  // maybeReloadDeadBridge() should only operate on a page that is connected NOW, while the timeout
  // decision must remember that pairing succeeded at least once during this auth generation.
  private lastProbeStateConnected = false;
  private hasObservedConnected = false;

  // When QR_READY page probing proves CONNECTED + identity even though whatsapp-web.js missed its
  // authenticated handoff. That evidence moves OpenWA to AUTHENTICATING and starts a bounded one-shot
  // reinjection grace rather than leaving a successfully linked phone staring at a QR forever.
  private qrConnectedObservedAt = 0;

  // Bridge-dead observation is phase-local but timestamped from the FIRST confirmed
  // CONNECTED + identity + eventsAttached=false probe.
  private bridgeDeadObservedAt = 0;

  // Shared one-reload budget for this reconciliation generation. Both the dead-bridge path and the
  // QR-connected-but-runtime-incomplete path reinject the same browser page, so they must not each
  // get an independent reload.
  private runtimeReloadAttempted = false;

  constructor(private readonly host: WwebjsReadyReconcileHost) {}

  /**
   * Watch the QR_READY phase for a missed `authenticated` edge.
   *
   * This watcher is intentionally unbounded: QR_READY is also the legitimate "waiting for the
   * operator to scan" state, so a fixed deadline would fail sessions merely because nobody scanned
   * yet. It only does work while QR_READY remains the current status and all timers are unref'd.
   *
   * Recovery has two safe paths:
   *  1. if the entire runtime is already usable (CONNECTED + identity + bridge + WWebJS), promote
   *     through AUTHENTICATING and the normal markReadyFromClientInfo() path;
   *  2. otherwise, when the page reports Socket.hasSynced=true, replay the page-side
   *     onAppStateHasSyncedEvent binding that whatsapp-web.js normally calls from the missed edge.
   */
  scheduleAuthReconcile(): void {
    // QR events rotate while the operator is still looking at the code. Do not restart the watcher
    // (and its replay backoff) on every replacement QR; one watcher covers the whole QR_READY phase.
    if (this.authReconcileTimer || this.authReconcileProbeInFlight) return;
    this.lastAuthReplayAt = 0;
    this.authReplayCount = 0;

    const tick = (): void => {
      if (!this.host.getClient() || this.host.getStatus() !== EngineStatus.QR_READY) {
        this.clearAuthReconcile();
        return;
      }

      // Schedule first so a hung page probe cannot stop future deadline-free checks. At most one
      // probe is in flight, preventing an unhealthy renderer from accumulating evaluate promises.
      this.authReconcileTimer = setTimeout(tick, AUTH_RECONCILE_INTERVAL_MS);
      this.authReconcileTimer.unref?.();

      if (this.authReconcileProbeInFlight) return;
      this.authReconcileProbeInFlight = true;

      void this.reconcileQrReadyAuthentication()
        .catch(error =>
          this.host.logger.debug('QR authentication reconciliation probe failed', {
            sessionId: this.host.config.sessionId,
            error: String(error),
          }),
        )
        .finally(() => {
          this.authReconcileProbeInFlight = false;
        });
    };

    this.authReconcileTimer = setTimeout(tick, AUTH_RECONCILE_INTERVAL_MS);
    this.authReconcileTimer.unref?.();
  }

  clearAuthReconcile(): void {
    if (this.authReconcileTimer) {
      clearTimeout(this.authReconcileTimer);
      this.authReconcileTimer = null;
    }
    this.authReconcileProbeInFlight = false;
    this.lastAuthReplayAt = 0;
    this.authReplayCount = 0;
    this.lastProbeStateConnected = false;
    this.hasObservedConnected = false;
    this.qrConnectedObservedAt = 0;
    this.runtimeReloadAttempted = false;
    this.resetBridgeRecoveryObservation();
  }

  private async reconcileQrReadyAuthentication(): Promise<void> {
    const sourceClient = this.client();
    if (!sourceClient || this.host.getStatus() !== EngineStatus.QR_READY) return;

    /*
     * Do not rely only on whatsapp-web.js's `change:hasSynced` edge here.
     *
     * Some phones/accounts successfully finish the QR link while that edge/handoff is missed. In
     * that state the phone says "linked", the Brave profile contains valid credentials, but OpenWA
     * remains QR_READY until the browser is manually restarted. Probe the same live page modules
     * whatsapp-web.js itself uses so CONNECTED + an own identity can prove pairing independently of
     * the missed Node-side event.
     *
     * We still replay onAppStateHasSyncedEvent when hasSynced=true, preserving the normal upstream
     * path whenever possible. The replay is backoff-limited; the read-only state probe runs every
     * reconciliation tick so a slow first pairing can leave QR_READY as soon as the page is truly
     * linked.
     */
    const now = Date.now();
    const shouldReplaySyncedEdge =
      now - this.lastAuthReplayAt >= AUTH_RECONCILE_REPLAY_BACKOFF_MS;

    if (shouldReplaySyncedEdge) {
      // Stamp BEFORE awaiting the Puppeteer call. A timed-out CDP request may continue underneath
      // Promise.race, and this prevents replacement replays every two seconds.
      this.lastAuthReplayAt = now;
    }

    const pageProbe = await this.withProbeTimeout(
      this.probeQrPageAuthentication(sourceClient, shouldReplaySyncedEdge),
      'QR authentication page-state probe',
    );

    if (this.host.getClient() !== sourceClient || this.host.getStatus() !== EngineStatus.QR_READY) {
      return;
    }

    if (pageProbe.replayed) {
      this.authReplayCount += 1;
      this.host.logger.warn(
        this.authReplayCount === 1
          ? 'WhatsApp Web has already synced while OpenWA is QR_READY; replaying the missed authentication edge'
          : 'WhatsApp Web is still QR_READY after a synced-edge replay; retrying the authentication handoff',
        {
          sessionId: this.host.config.sessionId,
          action: 'qr_auth_synced_edge_replayed',
          replayCount: this.authReplayCount,
        },
      );
    }

    if (pageProbe.connected && pageProbe.hasIdentity) {
      const observedAt = Date.now();

      this.host.logger.warn(
        'WhatsApp Web page is CONNECTED with an identity while OpenWA is still QR_READY; ' +
          'treating the QR as consumed and continuing readiness reconciliation without clearing credentials',
        {
          sessionId: this.host.config.sessionId,
          action: 'qr_auth_page_connected_reconciled',
          hasSynced: pageProbe.hasSynced,
          replayed: pageProbe.replayed,
        },
      );

      /*
       * Do NOT mark READY here. CONNECTED proves the phone/account pairing succeeded, but the
       * whatsapp-web.js message bridge may still be attaching. Move only to AUTHENTICATING and let
       * the existing readiness reconciler enforce identity/bridge/WWebJS readiness.
       *
       * scheduleReadyReconcile() intentionally resets phase-local evidence, so restore the strong
       * page-side connected proof immediately afterwards. The deadline may then preserve credentials
       * even if client.getState() is the exact call that remains wedged.
       */
      this.clearAuthReconcile();
      this.host.setStatus(EngineStatus.AUTHENTICATING);
      this.scheduleReadyReconcile();
      this.hasObservedConnected = true;
      this.qrConnectedObservedAt = observedAt;
      return;
    }

    if (
      pageProbe.replayed &&
      this.authReplayCount < AUTH_RECONCILE_REPLAY_FALLBACK_THRESHOLD
    ) {
      // Give the normal exposed binding one replay-only turn when page-level CONNECTED+identity has
      // not independently proven the link yet.
      return;
    }

    if (
      pageProbe.replayed &&
      this.authReplayCount >= AUTH_RECONCILE_REPLAY_FALLBACK_THRESHOLD
    ) {
      this.host.logger.warn(
        'Synced-edge replay still did not advance QR_READY; falling through to direct runtime reconciliation',
        {
          sessionId: this.host.config.sessionId,
          action: 'qr_auth_replay_runtime_fallback',
          replayCount: this.authReplayCount,
        },
      );
    }

    if (this.host.getClient() !== sourceClient || this.host.getStatus() !== EngineStatus.QR_READY) {
      return;
    }

    /*
     * Final fallback for an already-usable Node-side runtime. This remains useful for patched or
     * older WhatsApp Web builds where the page-level identity module differs but client.info and the
     * event bridge are already complete.
     */
    const runtimeReady = await this.isClientRuntimeReady();
    if (
      runtimeReady &&
      this.host.getClient() === sourceClient &&
      this.host.getStatus() === EngineStatus.QR_READY
    ) {
      this.host.logger.warn(
        'WhatsApp Web is already connected while OpenWA is still QR_READY; reconciling missed authentication',
        {
          sessionId: this.host.config.sessionId,
          action: 'qr_auth_runtime_reconciled',
        },
      );
      this.clearAuthReconcile();
      this.host.setStatus(EngineStatus.AUTHENTICATING);
      this.host.markReadyFromClientInfo();
      return;
    }

    if (
      this.host.getClient() === sourceClient &&
      this.host.getStatus() === EngineStatus.QR_READY
    ) {
      this.maybeReloadDeadBridge();
    }
  }

  /**
   * Probe the live page for the authentication LEVEL, not only the edge.
   *
   * These are the same modules current whatsapp-web.js uses in Client.initialize():
   *   - WAWebSocketModel.Socket for state / hasSynced
   *   - WAWebUserPrefsMeUser for the current PN/LID identity
   *
   * When requested and safe, also replay the exposed onAppStateHasSyncedEvent binding. The replay is
   * fire-and-forget inside the page so this probe never waits for the whole post-auth pipeline.
   */
  private async probeQrPageAuthentication(
    sourceClient: Client,
    replaySyncedEdge: boolean,
  ): Promise<QrPageAuthenticationProbe> {
    const page = (
      sourceClient as unknown as {
        pupPage?: {
          evaluate: <T>(
            fn: (shouldReplay: boolean) => T,
            shouldReplay: boolean,
          ) => Promise<T>;
        };
      }
    ).pupPage;

    if (!page) {
      return {
        connected: false,
        hasSynced: false,
        hasIdentity: false,
        replayed: false,
      };
    }

    return page.evaluate((shouldReplay: boolean) => {
      const browserWindow = window as unknown as {
        require?: (moduleName: string) => unknown;
        onAppStateHasSyncedEvent?: () => unknown;
      };

      if (typeof browserWindow.require !== 'function') {
        return {
          connected: false,
          hasSynced: false,
          hasIdentity: false,
          replayed: false,
        };
      }

      let socket:
        | {
            state?: string;
            hasSynced?: boolean;
          }
        | undefined;

      let hasIdentity = false;

      try {
        const socketModule = browserWindow.require('WAWebSocketModel') as {
          Socket?: {
            state?: string;
            hasSynced?: boolean;
          };
        };
        socket = socketModule?.Socket;
      } catch {
        // A module rename during a WhatsApp Web rollout must not break the reconciliation loop.
      }

      try {
        const meModule = browserWindow.require('WAWebUserPrefsMeUser') as {
          getMaybeMePnUser?: () => unknown;
          getMaybeMeLidUser?: () => unknown;
        };
        hasIdentity = Boolean(
          meModule?.getMaybeMePnUser?.() ??
            meModule?.getMaybeMeLidUser?.(),
        );
      } catch {
        // Keep probing other readiness signals if this module is temporarily unavailable.
      }

      const connected = socket?.state === 'CONNECTED';
      const hasSynced = socket?.hasSynced === true;
      let replayed = false;

      if (
        shouldReplay &&
        hasSynced &&
        typeof browserWindow.onAppStateHasSyncedEvent === 'function'
      ) {
        try {
          const result = browserWindow.onAppStateHasSyncedEvent();
          void Promise.resolve(result).catch(() => undefined);
          replayed = true;
        } catch {
          replayed = false;
        }
      }

      return {
        connected,
        hasSynced,
        hasIdentity,
        replayed,
      };
    }, replaySyncedEdge);
  }

  /**
   * Bound one Puppeteer/wwjs reconciliation wait.
   *
   * Promise.race cannot cancel the losing Puppeteer operation, but it guarantees this reconciler's
   * own in-flight latch is released. The pre-auth replay backoff limits replacement probes when the
   * underlying transport is genuinely wedged.
   */
  private async withProbeTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${RECONCILE_PROBE_TIMEOUT_MS}ms`)),
            RECONCILE_PROBE_TIMEOUT_MS,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  scheduleReadyReconcile(): void {
    this.clearAuthReconcile();
    this.clearReadyReconcile();
    this.readyReconcileTimeoutMs = resolveReadyTimeoutMs();
    this.readyReconcileStartedAt = Date.now();

    const tick = (): void => {
      if (!this.host.getClient() || this.host.getStatus() !== EngineStatus.AUTHENTICATING) {
        this.clearReadyReconcile();
        return;
      }

      // Deadline checked at the TOP of every tick (not after the probe) so a slow/hung getState() — a
      // wedged page can make it never resolve, the very #251/#273 condition — cannot defeat the
      // configured readiness ceiling.
      if (Date.now() - this.readyReconcileStartedAt >= this.readyReconcileTimeoutMs) {
        const liveClient = this.host.getClient();
        const eventsAttached = (liveClient as Client & { eventsAttached?: boolean } | null)?.eventsAttached;

        // A CONNECTED page is proof that the phone/account pairing itself succeeded. Never wipe
        // credentials merely because the browser-side runtime or event bridge is still incomplete:
        // slow phones and large accounts can legitimately spend minutes in this post-scan phase.
        if (this.hasObservedConnected) {
          const bridgeDead = eventsAttached === false;

          this.host.logger.error(
            bridgeDead
              ? 'WhatsApp Web stayed connected but its event bridge never attached within the readiness ' +
                  'deadline — inbound messages would be silently lost, so the session is marked failed. ' +
                  'The saved credentials were kept; restart the session to relaunch the browser.'
              : 'WhatsApp Web reached CONNECTED but the browser runtime did not become fully ready within ' +
                  'the readiness deadline. The saved credentials were kept because pairing succeeded; ' +
                  'restart the session to relaunch the browser instead of forcing a new phone pairing.',
            undefined,
            {
              sessionId: this.host.config.sessionId,
              action: bridgeDead
                ? 'ready_reconcile_bridge_dead'
                : 'ready_reconcile_connected_incomplete',
              timeoutMs: this.readyReconcileTimeoutMs,
            },
          );

          this.clearReadyReconcile();
          this.host.setStatus(EngineStatus.FAILED);
          this.host
            .getCallbacks()
            .onError?.(
              bridgeDead
                ? 'WhatsApp Web is connected but its event bridge never attached, so inbound messages ' +
                    'would be lost. The saved session was kept — restart the session to relaunch the browser.'
                : 'WhatsApp Web connected, but browser readiness did not finish in time. The saved session ' +
                    'was kept — restart the session to continue without pairing the phone again.',
            );
          return;
        }

        this.host.logger.warn(
          'Timed out waiting for WhatsApp Web runtime readiness after authentication before the page ever ' +
            'reached CONNECTED. Clearing the stuck authentication so the lifecycle can offer a fresh QR. ' +
            'If this is a consistently slow phone/account, increase WWEBJS_READY_TIMEOUT_MS; if it keeps ' +
            'recurring at generous timeouts, pin a known-good WWEBJS_WEB_VERSION.',
          {
            sessionId: this.host.config.sessionId,
            action: 'ready_reconcile_timeout',
            timeoutMs: this.readyReconcileTimeoutMs,
          },
        );

        this.clearReadyReconcile();

        // Only the never-CONNECTED branch is allowed to clear auth. Once CONNECTED has been observed,
        // pairing is known-good and destroying credentials would turn a restart-fixable browser fault
        // into an unnecessary re-pair.
        void this.host.recoverFromStuckAuth();
        return;
      }

      // Schedule the next tick up front, independent of the probe, so a hung probe can never stall the
      // loop. The probe runs fire-and-forget with at-most-one in flight: if the previous one is still
      // pending (hung), skip this round — the loop keeps ticking and gives up at the deadline above.
      this.readyReconcileTimer = setTimeout(tick, READY_RECONCILE_INTERVAL_MS);
      this.readyReconcileTimer.unref?.();

      if (this.readyReconcileProbeInFlight) return;
      this.readyReconcileProbeInFlight = true;
      void this.isClientRuntimeReady()
        .then(ready => {
          if (ready && this.host.getClient() && this.host.getStatus() === EngineStatus.AUTHENTICATING) {
            this.host.logger.warn('WhatsApp Web ready event was missed; reconciling from connected runtime state');
            this.host.markReadyFromClientInfo();
          } else if (this.host.getStatus() === EngineStatus.AUTHENTICATING) {
            this.maybeReloadDeadBridge();
            this.maybeReloadQrConnectedRuntime();
          }
        })
        .catch(error => {
          this.host.logger.debug('Ready reconciliation probe failed', { error: String(error) });
          if (this.host.getStatus() === EngineStatus.AUTHENTICATING) {
            this.maybeReloadQrConnectedRuntime();
          }
        })
        .finally(() => {
          this.readyReconcileProbeInFlight = false;
        });
    };

    this.readyReconcileTimer = setTimeout(tick, READY_RECONCILE_INTERVAL_MS);
    this.readyReconcileTimer.unref?.();
  }

  clearReadyReconcile(): void {
    if (this.readyReconcileTimer) {
      clearTimeout(this.readyReconcileTimer);
      this.readyReconcileTimer = null;
    }
    this.readyReconcileStartedAt = 0;
    this.readyReconcileTimeoutMs = READY_RECONCILE_TIMEOUT_MS;
    this.readyReconcileProbeInFlight = false;
    this.lastProbeStateConnected = false;
    this.hasObservedConnected = false;
    this.qrConnectedObservedAt = 0;
    this.runtimeReloadAttempted = false;
    this.resetBridgeRecoveryObservation();
  }

  /** Live client handle — re-read per use like the adapter's own reads, never cached across awaits. */
  private client(): Client | null {
    return this.host.getClient();
  }

  private async isClientRuntimeReady(): Promise<boolean> {
    const client = this.client();
    if (!client) {
      this.resetBridgeRecoveryObservation();
      return false;
    }

    const state = await this.withProbeTimeout(client.getState(), 'WhatsApp runtime state probe');
    const connected = state === WAState.CONNECTED;
    this.lastProbeStateConnected = connected;
    if (connected) {
      this.hasObservedConnected = true;
    }

    if (!connected || this.client() !== client) {
      this.resetBridgeRecoveryObservation();
      return false;
    }

    if (!client.info?.wid?.user) {
      this.resetBridgeRecoveryObservation();
      return false;
    }

    // The patched whatsapp-web.js client (scripts/patch-wwebjs-ready-sync.js) reports whether
    // attachEventListeners resolved. `false` means the page->Node message bridge is dead even
    // though the page reports CONNECTED — promoting that session to READY masks the loss of every
    // inbound event. Start the reload grace from the FIRST observation of this exact condition.
    // `undefined` is an unpatched tree: keep the legacy WWebJS checks rather than refusing readiness
    // on a tree that cannot ever expose the flag.
    if ((client as Client & { eventsAttached?: boolean }).eventsAttached === false) {
      if (this.bridgeDeadObservedAt === 0) {
        this.bridgeDeadObservedAt = Date.now();
        this.host.logger.warn(
          'WhatsApp Web is connected with an identity but its event bridge is not attached yet; starting bridge grace window',
          {
            sessionId: this.host.config.sessionId,
            status: this.host.getStatus(),
            action: 'event_bridge_dead_observed',
          },
        );
      }
      return false;
    }

    // The bridge recovered/attached on its own. Forget any earlier slow-attach observation so a
    // later independent navigation or auth generation receives a fresh grace/reload budget.
    this.resetBridgeRecoveryObservation();

    const page = (client as unknown as { pupPage?: { evaluate: <T>(fn: () => T) => Promise<T> } }).pupPage;
    if (!page) return false;

    const hasWWebJS = await this.withProbeTimeout(
      page.evaluate(() => typeof (window as unknown as { WWebJS?: unknown }).WWebJS !== 'undefined'),
      'WhatsApp runtime bridge probe',
    );

    return this.client() === client && hasWWebJS === true;
  }

  private resetBridgeRecoveryObservation(): void {
    this.bridgeDeadObservedAt = 0;
  }

  /**
   * One-shot reinjection for the exact first-pairing failure observed in production:
   *
   * the phone is already linked and the page proved CONNECTED + identity, but whatsapp-web.js never
   * completed its Node-side authenticated/ready pipeline. A manual stop/start fixes that because the
   * persisted profile reopens authenticated. Reloading the existing page after a generous grace
   * gives us the same reinjection effect without killing the browser or clearing credentials.
   */
  private maybeReloadQrConnectedRuntime(): void {
    if (
      this.runtimeReloadAttempted ||
      this.qrConnectedObservedAt === 0 ||
      this.host.getStatus() !== EngineStatus.AUTHENTICATING
    ) {
      return;
    }

    if (Date.now() - this.qrConnectedObservedAt < QR_CONNECTED_REINJECT_GRACE_MS) {
      return;
    }

    const client = this.host.getClient();
    if (!client) return;

    const page = (
      client as unknown as {
        pupPage?: { reload?: () => Promise<unknown> };
      }
    ).pupPage;

    if (!page?.reload) {
      this.runtimeReloadAttempted = true;
      this.host.logger.warn(
        'QR pairing was confirmed by the page but the runtime is still incomplete and the Puppeteer page cannot be reloaded',
        {
          sessionId: this.host.config.sessionId,
          status: this.host.getStatus(),
          action: 'qr_connected_reinject_unavailable',
        },
      );
      return;
    }

    this.runtimeReloadAttempted = true;
    this.host.logger.warn(
      'QR pairing succeeded but whatsapp-web.js did not finish its authenticated runtime; ' +
        'reloading the page once to reinject while preserving the saved pairing',
      {
        sessionId: this.host.config.sessionId,
        observedForMs: Date.now() - this.qrConnectedObservedAt,
        action: 'qr_connected_runtime_reinject',
      },
    );

    void page.reload().catch((error: unknown) =>
      this.host.logger.warn('QR-connected runtime reinjection failed', {
        sessionId: this.host.config.sessionId,
        error: String(error),
        action: 'qr_connected_runtime_reinject_failed',
      }),
    );
  }

  /**
   * One-shot self-heal for a CONNECTED page whose event bridge never attached: reload the page.
   * whatsapp-web.js re-runs its injection on every `framenavigated`, and a fresh page walks the
   * whole auth->synced->attach pipeline again (with the level-check patch closing the missed-edge
   * race), so a reload is the cheapest full reinjection that keeps the saved session intact.
   */
  private maybeReloadDeadBridge(): void {
    if (this.runtimeReloadAttempted || this.bridgeDeadObservedAt === 0) return;

    const client = this.host.getClient();
    const status = this.host.getStatus();
    if (!client || (status !== EngineStatus.QR_READY && status !== EngineStatus.AUTHENTICATING)) return;
    if (!this.lastProbeStateConnected || !client.info?.wid?.user) return;
    if ((client as Client & { eventsAttached?: boolean }).eventsAttached !== false) {
      this.resetBridgeRecoveryObservation();
      return;
    }

    // attachEventListeners() can legitimately spend ~30s waiting for window.WWebJS. The timer starts
    // at the first confirmed CONNECTED+identity+bridge-false observation in EITHER auth phase, so
    // QR_READY never accidentally computes Date.now() - 0 and reloads immediately.
    if (Date.now() - this.bridgeDeadObservedAt < READY_RECONCILE_BRIDGE_RELOAD_GRACE_MS) return;

    const page = (client as unknown as { pupPage?: { reload?: () => Promise<unknown> } }).pupPage;
    if (!page?.reload) {
      this.host.logger.warn('Event bridge is still unattached but the Puppeteer page cannot be reloaded', {
        sessionId: this.host.config.sessionId,
        status,
        action: 'event_bridge_reload_unavailable',
      });
      return;
    }

    this.runtimeReloadAttempted = true;
    this.host.logger.warn(
      'WhatsApp Web is connected but its event bridge never attached; reloading the page once to reinject',
      {
        sessionId: this.host.config.sessionId,
        status,
        observedForMs: Date.now() - this.bridgeDeadObservedAt,
        action: 'event_bridge_reload',
      },
    );

    void page.reload().catch((error: unknown) =>
      this.host.logger.warn('Event-bridge reload failed', {
        sessionId: this.host.config.sessionId,
        status,
        error: String(error),
        action: 'event_bridge_reload_failed',
      }),
    );
  }
}



