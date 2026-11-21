


import { type Client } from 'whatsapp-web.js';
import { type EngineEventCallbacks, EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { type createLogger } from '../../common/services/logger.service';
import { type WhatsAppWebJsConfig } from './whatsapp-web-js.adapter';
import { boundedBrowserOperation, BROWSER_TEARDOWN_BUDGETS } from '../brave/brave-browser-teardown';

/**
 * Stuck-auth detection and recovery for the NoAuth + persistent-Brave architecture.
 *
 * The WhatsApp credentials are no longer owned by LocalAuth under sessionDataPath. They live inside
 * the per-session Brave user-data directory managed by BraveProfileManager. Recovery therefore has
 * to retire the current browser generation completely before removing that profile; deleting files
 * underneath a live Chromium/Brave process risks a partial profile and an endless re-pair loop.
 */
export interface WwebjsStuckAuthHost {
  readonly logger: ReturnType<typeof createLogger>;
  readonly config: WhatsAppWebJsConfig;
  getClient(): Client | null;
  setClient(client: Client | null): void;
  setStatus(status: EngineStatus): void;
  /** Live callbacks bag — read per event, since initialize() installs it after delegates are built. */
  getCallbacks(): EngineEventCallbacks;
  /** Lease-aware supervision from WwebjsLifecycle, when constructed through the real adapter. */
  beginProfileReset?(): void;
  stopClientForProfileReset?(client: Client | null): Promise<void>;
  completeProfileReset?(): Promise<void>;
}

export class WwebjsStuckAuth {
  /**
   * Standalone-adapter fallback for the session-owned recovery budget. In normal session lifecycle
   * use, claimStuckAuthRecovery is authoritative and survives automatic reconnect generations.
   */
  private recoveryAttempted = false;

  constructor(private readonly host: WwebjsStuckAuthHost) {}

  /**
   * Recover a session that authenticated but never reached a usable runtime.
   *
   * One destructive recovery is allowed for the whole reconnect episode. The current client is
   * detached first so late whatsapp-web.js events cannot resurrect it; then the Brave process is
   * stopped and independently verified gone; only then is the dedicated Brave profile deleted.
   * A failed/unsafe profile reset is terminal and does NOT emit onDisconnected, because reconnecting
   * onto a profile that may still be owned by a live process would make the situation worse.
   */
  async recoverFromStuckAuth(): Promise<void> {
    const claim = this.host.getCallbacks().claimStuckAuthRecovery;
    let granted: boolean;

    if (claim) {
      try {
        granted = claim();
      } catch {
        granted = false;
      }
    } else {
      granted = !this.recoveryAttempted;
      this.recoveryAttempted = true;
    }

    if (!granted) {
      this.host.setStatus(EngineStatus.FAILED);
      this.host.getCallbacks().onError?.(
        'WhatsApp Web could not reach readiness after re-pairing. ' +
          'The one allowed re-pair recovery has already been used. ' +
          'Pin WWEBJS_WEB_VERSION to a known-good build and try again.',
      );
      return;
    }

    const client = this.host.getClient();

    // Retire this generation before any await. A late qr/authenticated/ready/disconnected from this
    // Client must not mutate lifecycle state while its browser/profile is being removed.
    this.host.beginProfileReset?.();
    this.host.setClient(null);
    client?.removeAllListeners?.();

    // Register BEFORE awaiting anything: reconnect/start/delete must see the same-name profile
    // removal in the SessionLifecycleFences map even if the browser teardown exceeds its timeout.
    // This promise includes both process termination and file deletion. A failed reset is still
    // tracked until it settles, and the error remains fatal to this engine generation.
    const resetOperation = (async (): Promise<void> => {
      await this.stopClientForProfileReset(client);
      await this.clearBraveProfile();
      // Release only AFTER the destructive operation has fully finished.
      await this.host.completeProfileReset?.();
    })();
    this.host.getCallbacks().onCredentialTeardownStarted?.(resetOperation);
    try {
      await resetOperation;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.host.logger.error(
        `Stuck-auth recovery could not safely reset the Brave profile: ${reason}`,
        undefined,
        {
          sessionId: this.host.config.sessionId,
          action: 'stuck_auth_profile_reset_failed',
        },
      );
      this.host.setStatus(EngineStatus.FAILED);
      this.host.getCallbacks().onError?.(
        'WhatsApp Web authentication is stuck, but al-hakim could not safely reset the Brave profile. ' +
          'The session was stopped to avoid corrupting its browser data. Check the server logs and restart it manually.',
      );
      return;
    }

    this.host.setStatus(EngineStatus.DISCONNECTED);
    this.host.getCallbacks().onDisconnected?.(
      'Saved Brave session could not be restored; profile cleared for re-pairing',
    );
  }

  /**
   * Stop the live whatsapp-web.js/Brave generation with a bounded graceful destroy. Regardless of
   * whether destroy succeeds, BraveProfileManager then verifies that no process carrying this
   * session's --al-hakim-session marker remains. That verification is the safety gate before deletion.
   */
  private async stopClientForProfileReset(client: Client | null): Promise<void> {
    if (this.host.stopClientForProfileReset) {
      await this.host.stopClientForProfileReset(client);
      return;
    }

    // Standalone/test host fallback. Never kill an unverified PID directly or authorize
    // marker-wide orphan reaping. A graceful timeout is a terminal recovery failure.
    if (client && typeof client.destroy === 'function') {
      await boundedBrowserOperation(
        () => client.destroy(), BROWSER_TEARDOWN_BUDGETS.graceMs,
        'stuck-auth client.destroy()',
      );
    }
    const manager = this.host.config.braveProfileManager;
    if (!manager) throw new Error('Brave profile manager is unavailable');
    await boundedBrowserOperation(
      () => manager.killOrphanedBraveProcesses(this.host.config.sessionId, this.host.logger, false),
      BROWSER_TEARDOWN_BUDGETS.leaseMs,
      'stuck-auth process verification',
    );
  }

  /**
   * Delete the complete per-session Brave user-data directory. Do not selectively remove only
   * Cookies/IndexedDB/Local Storage: WhatsApp/Chromium state spans multiple stores and a partial wipe
   * can leave a half-linked profile that reproduces the same failure on the next generation.
   */
  async clearBraveProfile(): Promise<void> {
    const manager = this.host.config.braveProfileManager;
    if (!manager) {
      throw new Error('Brave profile manager is unavailable');
    }

    const profilePath = manager.getProfilePath(this.host.config.sessionId);

    await manager.deleteProfile(this.host.config.sessionId);

    this.host.logger.warn(
      `Deleted this session's persistent Brave profile at ${profilePath}. That profile contained the ` +
        'stored WhatsApp Web link, so the next start will require a fresh QR scan.',
      {
        sessionId: this.host.config.sessionId,
        dir: profilePath,
        action: 'brave_auth_cleared',
      },
    );
  }

  /**
   * Backward-compatible method name for older adapter/tests that still forward clearLocalAuth().
   * In the Brave/NoAuth architecture it intentionally clears the Brave profile instead.
   */
  async clearLocalAuth(): Promise<void> {
    await this.clearBraveProfile();
  }
}



