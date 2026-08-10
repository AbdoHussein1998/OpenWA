import { type Client } from 'whatsapp-web.js';
import { CallLinkType, MediaInput } from '../interfaces/whatsapp-engine.interface';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { toMessageMedia } from './wwebjs-messaging';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * Own-account profile operations extracted from WhatsAppWebJsAdapter. The adapter keeps the public
 * methods as thin forwarders and injects the shared host surface (./wwebjs-host) via closures, so
 * the delegate never touches lifecycle state directly.
 */
export class WwebjsProfile {
  constructor(private readonly host: WwebjsEngineHost) {}

  /** Post-ensureReady client handle. */
  private client(): Client {
    return this.host.getClient();
  }

  async createCallLink(type: CallLinkType, startTime: number): Promise<string> {
    this.host.ensureReady();
    // whatsapp-web.js rejects any callType outside 'voice' | 'video', so the neutral 'audio' maps
    // here. It floors the Date to seconds itself, so the epoch-milliseconds the contract takes goes
    // straight into the Date.
    const link = await this.client().createCallLink(new Date(startTime), type === 'video' ? 'video' : 'voice');
    if (!link) {
      // Documented as "the link, or an empty string if a generation failed" — returning that empty
      // string would hand the caller a success with nothing in it.
      throw new EngineRefusedError('WhatsApp did not return a call link');
    }
    return link;
  }

  async setProfileName(name: string): Promise<void> {
    this.host.ensureReady();
    // setDisplayName resolves false (rather than throwing) when WhatsApp refuses the rename.
    const ok = await this.client().setDisplayName(name);
    if (!ok) {
      throw new EngineRefusedError('the engine rejected the profile name change');
    }
    this.host.logger.log('Updated profile name');
  }

  async setProfileStatus(status: string): Promise<void> {
    this.host.ensureReady();
    await this.client().setStatus(status);
    this.host.logger.log('Updated profile status');
  }

  async setProfilePicture(media: MediaInput): Promise<void> {
    this.host.ensureReady();
    const messageMedia = await toMessageMedia(media);
    // setProfilePicture resolves false (rather than throwing) when the upload is refused.
    const ok = await this.client().setProfilePicture(messageMedia);
    if (!ok) {
      throw new EngineRefusedError('the engine rejected the profile picture change');
    }
    this.host.logger.log('Updated profile picture');
  }
}
