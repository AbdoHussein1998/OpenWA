import { type Client } from 'whatsapp-web.js';
import { type EngineEventCallbacks, EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { type createLogger } from '../../common/services/logger.service';
import { type WhatsAppWebJsConfig } from './whatsapp-web-js.adapter';

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
}

const CLIENT_DESTROY_TIMEOUT_MS = 5_000;

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
      this.host
        .getCallbacks()
        .onError?.(
          'WhatsApp Web could not reach readiness after the one allowed re-pair recovery. ' +
            'Pin WWEBJS_WEB_VERSION to a known-good build and try again.',
        );
      return;
    }

    const client = this.host.getClient();

    // Retire this generation before any await. A late qr/authenticated/ready/disconnected from this
    // Client must not mutate lifecycle state while its browser/profile is being removed.
    this.host.setClient(null);
    client?.removeAllListeners?.();

    try {
      await this.stopClientForProfileReset(client);
      await this.clearBraveProfile();
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
      this.host
        .getCallbacks()
        .onError?.(
          'WhatsApp Web authentication is stuck, but OpenWA could not safely reset the Brave profile. ' +
            'The session was stopped to avoid corrupting its browser data. Check the server logs and restart it manually.',
        );
      return;
    }

    this.host.setStatus(EngineStatus.DISCONNECTED);
    this.host
      .getCallbacks()
      .onDisconnected?.('Saved Brave session could not be restored; profile cleared for re-pairing');
  }

  /**
   * Stop the live whatsapp-web.js/Brave generation with a bounded graceful destroy. Regardless of
   * whether destroy succeeds, BraveProfileManager then verifies that no process carrying this
   * session's --openwa-session marker remains. That verification is the safety gate before deletion.
   */
  private async stopClientForProfileReset(client: Client | null): Promise<void> {
    if (client && typeof client.destroy === 'function') {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          client.destroy(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`client.destroy() timed out after ${CLIENT_DESTROY_TIMEOUT_MS}ms`)),
              CLIENT_DESTROY_TIMEOUT_MS,
            );
            timeout.unref?.();
          }),
        ]);
      } catch (error) {
        this.host.logger.warn('Graceful client destroy did not complete during stuck-auth recovery', {
          sessionId: this.host.config.sessionId,
          action: 'stuck_auth_destroy_incomplete',
          error: error instanceof Error ? error.message : String(error),
        });

        // Best-effort direct kill of this client's browser process. The manager verification below is
        // still authoritative and will fail closed if any marked Brave process survives.
        try {
          const proc = (
            client as unknown as {
              pupBrowser?: { process?: () => { kill?: (signal: string) => void } | null };
            }
          ).pupBrowser?.process?.();
          proc?.kill?.('SIGKILL');
        } catch (killError) {
          this.host.logger.warn('Direct Brave kill failed during stuck-auth recovery', {
            sessionId: this.host.config.sessionId,
            action: 'stuck_auth_direct_kill_failed',
            error: killError instanceof Error ? killError.message : String(killError),
          });
        }
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }

    // This is not merely cleanup: it independently proves the profile has no live Brave owner.
    await this.host.config.braveProfileManager.killOrphanedBraveProcesses(
      this.host.config.sessionId,
      this.host.logger,
    );
  }

  /**
   * Delete the complete per-session Brave user-data directory. Do not selectively remove only
   * Cookies/IndexedDB/Local Storage: WhatsApp/Chromium state spans multiple stores and a partial wipe
   * can leave a half-linked profile that reproduces the same failure on the next generation.
   */
  async clearBraveProfile(): Promise<void> {
    const manager = this.host.config.braveProfileManager;
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
