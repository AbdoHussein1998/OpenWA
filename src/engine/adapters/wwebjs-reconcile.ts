


import { type Client, WAState } from 'whatsapp-web.js';
import { type EngineEventCallbacks, EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { type createLogger } from '../../common/services/logger.service';
import { type WhatsAppWebJsConfig } from './whatsapp-web-js.adapter';

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
export const READY_RECONCILE_TIMEOUT_MS = 90_000;

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
  private readyReconcileProbeInFlight = false;
  // What the last reconcile probe observed, driving the bridge-dead self-heal and the deadline
  // decision (a CONNECTED session must never have its credentials wiped).
  private lastProbeStateConnected = false;

  // Bridge-dead observation is phase-local but timestamped from the FIRST confirmed
  // CONNECTED + identity + eventsAttached=false probe. Using readyReconcileStartedAt here is unsafe
  // in QR_READY because that clock is zero until authenticated has been accepted.
  private bridgeDeadObservedAt = 0;
  private bridgeReloadAttempted = false;

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
    this.resetBridgeRecoveryObservation();
  }

  private async reconcileQrReadyAuthentication(): Promise<void> {
    const sourceClient = this.client();
    if (!sourceClient || this.host.getStatus() !== EngineStatus.QR_READY) return;

    /*
     * IMPORTANT ORDERING:
     *
     * Probe the page-side Socket.hasSynced LEVEL before calling client.getState().
     *
     * In the failure this reconciler is designed for, the phone has already linked but OpenWA is
     * still QR_READY because whatsapp-web.js missed the `change:hasSynced` edge. During that
     * half-transition client.getState() can reject or hang. If getState() runs first, the recovery
     * binding below is never reached and one hung promise can keep the session stuck forever.
     *
     * The replay attempt is backoff-limited. Stamp the attempt BEFORE awaiting it so a timed-out CDP
     * call cannot cause a new evaluate every two seconds while its original Puppeteer promise is
     * still unresolved in the background.
     */
    const now = Date.now();
    if (now - this.lastAuthReplayAt >= AUTH_RECONCILE_REPLAY_BACKOFF_MS) {
      this.lastAuthReplayAt = now;

      const replayed = await this.withProbeTimeout(
        this.replayHasSyncedHandler(sourceClient),
        'QR hasSynced replay probe',
      );

      if (this.host.getClient() !== sourceClient || this.host.getStatus() !== EngineStatus.QR_READY) {
        return;
      }

      if (replayed) {
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

        // Give the normal exposed binding one replay-only turn. If the same condition survives a
        // second replay, do not keep trusting the missed edge: fall through to the direct runtime
        // probe below in this same tick. (The intervening 2s ticks also probe during the 10s replay
        // backoff, so this is an extra guarantee rather than the only fallback.)
        if (this.authReplayCount < AUTH_RECONCILE_REPLAY_FALLBACK_THRESHOLD) {
          return;
        }

        this.host.logger.warn(
          'Synced-edge replay still did not advance QR_READY; falling through to direct runtime reconciliation',
          {
            sessionId: this.host.config.sessionId,
            action: 'qr_auth_replay_runtime_fallback',
            replayCount: this.authReplayCount,
          },
        );
      }
    }

    if (this.host.getClient() !== sourceClient || this.host.getStatus() !== EngineStatus.QR_READY) {
      return;
    }

    /*
     * Fallback for the even rarer case where the entire runtime is already usable but the exposed
     * hasSynced binding is unavailable/missed. This probe is ALSO bounded, so a stuck getState()
     * cannot hold authReconcileProbeInFlight forever.
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

    // A persistent Brave profile can be fully CONNECTED with an identity while the patched
    // whatsapp-web.js event bridge is still false. QR_READY used to have no self-heal for that
    // condition, so it could stay on the scan screen forever. Use the same one-shot reinjection
    // strategy as AUTHENTICATING, but with a grace clock that starts from the first dead-bridge
    // observation rather than readyReconcileStartedAt.
    if (
      this.host.getClient() === sourceClient &&
      this.host.getStatus() === EngineStatus.QR_READY
    ) {
      this.maybeReloadDeadBridge();
    }
  }

  /**
   * Replay whatsapp-web.js's page->Node hasSynced handoff only when the page level proves it is
   * already synced. The binding is invoked fire-and-forget inside the page: waiting for its returned
   * promise here would let the long post-auth pipeline pin this probe and defeat later retries.
   */
  private async replayHasSyncedHandler(sourceClient: Client): Promise<boolean> {
    const page = (
      sourceClient as unknown as {
        pupPage?: { evaluate: <T>(fn: () => T) => Promise<T> };
      }
    ).pupPage;
    if (!page) return false;

    return page.evaluate(() => {
      const browserWindow = window as unknown as {
        require?: (moduleName: string) => {
          Socket?: { hasSynced?: boolean };
        };
        onAppStateHasSyncedEvent?: () => unknown;
      };

      if (typeof browserWindow.require !== 'function') return false;

      let socket: { hasSynced?: boolean } | undefined;
      try {
        socket = browserWindow.require('WAWebSocketModel')?.Socket;
      } catch {
        return false;
      }

      if (socket?.hasSynced !== true || typeof browserWindow.onAppStateHasSyncedEvent !== 'function') {
        return false;
      }

      try {
        const result = browserWindow.onAppStateHasSyncedEvent();
        void Promise.resolve(result).catch(() => undefined);
        return true;
      } catch {
        return false;
      }
    });
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
    this.readyReconcileStartedAt = Date.now();

    const tick = (): void => {
      if (!this.host.getClient() || this.host.getStatus() !== EngineStatus.AUTHENTICATING) {
        this.clearReadyReconcile();
        return;
      }

      // Deadline checked at the TOP of every tick (not after the probe) so a slow/hung getState() — a
      // wedged page can make it never resolve, the very #251/#273 condition — can't defeat the 90s ceiling.
      if (Date.now() - this.readyReconcileStartedAt >= READY_RECONCILE_TIMEOUT_MS) {
        // A CONNECTED page whose event bridge never attached (even after the one-shot reload) is a
        // different animal from a stuck-after-QR session: the link and the credentials are fine,
        // only this browser instance is broken. Wiping the only copy of the credentials would trade
        // a restart-fixable fault for a forced re-pair — fail loudly and keep the auth instead.
        const bridgeDead =
          this.lastProbeStateConnected &&
          (this.host.getClient() as Client & { eventsAttached?: boolean })?.eventsAttached === false;
        if (bridgeDead) {
          this.host.logger.error(
            'WhatsApp Web stayed connected but its event bridge never attached within the readiness ' +
              'deadline — inbound messages would be silently lost, so the session is marked failed. ' +
              'The saved credentials were kept; restart the session to relaunch the browser.',
            undefined,
            { sessionId: this.host.config.sessionId, action: 'ready_reconcile_bridge_dead' },
          );
          this.clearReadyReconcile();
          this.host.setStatus(EngineStatus.FAILED);
          this.host
            .getCallbacks()
            .onError?.(
              'WhatsApp Web is connected but its event bridge never attached, so inbound messages would be ' +
                'lost. The saved session was kept — restart the session to relaunch the browser.',
            );
          return;
        }
        this.host.logger.warn(
          'Timed out waiting for WhatsApp Web runtime readiness after authentication — the saved session ' +
            'is stuck after the QR scan (usually the auto-selected WhatsApp Web build is incompatible). ' +
            'Clearing it to re-pair; pin a known-good version via WWEBJS_WEB_VERSION (see ' +
            'docs/12-troubleshooting-faq.md) if it keeps recurring.',
          // Name the session: on a multi-session host this warning is the only way to tell whether one
          // session timed out or every one of them did, and the two have very different causes.
          { sessionId: this.host.config.sessionId, action: 'ready_reconcile_timeout' },
        );
        this.clearReadyReconcile();
        // Self-heal: don't leave the session stuck at "authenticating" forever — clear the broken auth
        // and disconnect so the lifecycle re-pairs (a fresh QR) instead of hanging.
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
          }
        })
        .catch(error => this.host.logger.debug('Ready reconciliation probe failed', { error: String(error) }))
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
    this.readyReconcileProbeInFlight = false;
    this.lastProbeStateConnected = false;
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
        this.bridgeReloadAttempted = false;
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
    this.bridgeReloadAttempted = false;
  }

  /**
   * One-shot self-heal for a CONNECTED page whose event bridge never attached: reload the page.
   * whatsapp-web.js re-runs its injection on every `framenavigated`, and a fresh page walks the
   * whole auth->synced->attach pipeline again (with the level-check patch closing the missed-edge
   * race), so a reload is the cheapest full reinjection that keeps the saved session intact.
   */
  private maybeReloadDeadBridge(): void {
    if (this.bridgeReloadAttempted || this.bridgeDeadObservedAt === 0) return;

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

    this.bridgeReloadAttempted = true;
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
