


import { type Client } from 'whatsapp-web.js';
import { type EngineEventCallbacks, EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { type createLogger } from '../../common/services/logger.service';
import { type WhatsAppWebJsConfig } from './whatsapp-web-js.adapter';
import { boundedBrowserOperation, BROWSER_TEARDOWN_BUDGETS } from '../browser/browser-teardown';
import type { BrowserProfileManager } from '../browser/browser-profile.manager';

/**
 * Stuck-auth detection and recovery for NoAuth + a persistent browser profile.
 *
 * The WhatsApp credentials are no longer owned by LocalAuth under sessionDataPath. They live inside
 * the per-session browser user-data directory managed by BrowserProfileManager. Recovery therefore has
 * to retire the current browser generation completely before removing that profile; deleting files
 * underneath a live browser process risks a partial profile and an endless re-pair loop.
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
   * detached first so late whatsapp-web.js events cannot resurrect it; then the browser process is
   * stopped and independently verified gone; only then is the dedicated browser profile deleted.
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
      await this.clearBrowserProfile();
      // Release only AFTER the destructive operation has fully finished.
      await this.host.completeProfileReset?.();
    })();
    this.host.getCallbacks().onCredentialTeardownStarted?.(resetOperation);
    try {
      await resetOperation;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.host.logger.error(
        `Stuck-auth recovery could not safely reset the browser profile: ${reason}`,
        undefined,
        {
          sessionId: this.host.config.sessionId,
          action: 'stuck_auth_profile_reset_failed',
        },
      );
      this.host.setStatus(EngineStatus.FAILED);
      this.host.getCallbacks().onError?.(
        'WhatsApp Web authentication is stuck, but al-hakim could not safely reset the browser profile. ' +
          'The session was stopped to avoid corrupting its browser data. Check the server logs and restart it manually.',
      );
      return;
    }

    this.host.setStatus(EngineStatus.DISCONNECTED);
    this.host.getCallbacks().onDisconnected?.(
      'Saved browser session could not be restored; profile cleared for re-pairing',
    );
  }

  /**
   * Stop the live whatsapp-web.js/browser generation with a bounded graceful destroy. In the
   * lifecycle path, teardown verifies process exit while retaining the profile lease. In the
   * standalone fallback, BrowserProfileManager verifies the absence of any conflicting browser
   * process before destructive deletion. Uncertain process state must fail closed.
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
    const manager = this.getProfileManager();
    await boundedBrowserOperation(
      () => this.assertNoConflictingProcesses(manager),
      BROWSER_TEARDOWN_BUDGETS.leaseMs,
      'stuck-auth process verification',
    );
  }

  /**
   * Resolve the shared manager. The Brave-named config property is a deprecated
   * compatibility alias; production adapter construction always populates the
   * browser-neutral property and makes both refer to the same instance.
   */
  private getProfileManager(): BrowserProfileManager {
    const manager = this.host.config.browserProfileManager ?? this.host.config.braveProfileManager;
    if (!manager) throw new Error('Browser profile manager is unavailable');
    if (this.host.config.browserProfileManager && this.host.config.braveProfileManager &&
        this.host.config.browserProfileManager !== this.host.config.braveProfileManager) {
      throw new Error('Conflicting browser profile managers; refusing credential deletion');
    }
    return manager;
  }

  /**
   * Prefer the browser-neutral check. Old standalone test hosts may inject a
   * legacy manager double that only implements killOrphanedBraveProcesses().
   * The production BrowserProfileManager always implements the neutral method.
   */
  private async assertNoConflictingProcesses(manager: BrowserProfileManager): Promise<void> {
    if (typeof manager.assertNoConflictingBrowserProcesses === 'function') {
      await manager.assertNoConflictingBrowserProcesses(this.host.config.sessionId, this.host.logger);
      return;
    }
    await manager.killOrphanedBraveProcesses(this.host.config.sessionId, this.host.logger, false);
  }

  /**
   * Delete the COMPLETE session-specific browser user-data directory, never
   * individual cookies or storage files. The caller must first stop and verify
   * the old browser, while WwebjsLifecycle retains the profile lease.
   * Releasing the lease before deleting the profile would permit a new launch
   * against partially removed credentials.
   */
  async clearBrowserProfile(): Promise<void> {
    const manager = this.getProfileManager();
    const profilePath = manager.getProfilePath(this.host.config.sessionId);

    await manager.deleteProfile(this.host.config.sessionId);

    this.host.logger.warn(
      `Deleted this session's persistent browser profile at ${profilePath}. That profile contained the ` +
        'stored WhatsApp Web link, so the next start will require a fresh QR scan.',
      {
        sessionId: this.host.config.sessionId,
        dir: profilePath,
        // Retain the old action for downstream logging dashboards until an
        // explicitly coordinated observability migration.
        action: 'brave_auth_cleared',
        eventType: 'engine.browser.auth_cleared',
      },
    );
  }

  /** @deprecated Legacy API used by older tests/callers; use clearBrowserProfile(). */
  async clearBraveProfile(): Promise<void> {
    await this.clearBrowserProfile();
  }

  /**
   * Legacy NoAuth alias. Kept for the adapter's existing private proxy;
   * callers must not invoke it against a running browser outside the
   * lifecycle-controlled reset flow.
   */
  async clearLocalAuth(): Promise<void> {
    await this.clearBrowserProfile();
  }

}



