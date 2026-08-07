import type { WASocket } from '@whiskeysockets/baileys';
import { Channel } from '../interfaces/whatsapp-engine.interface';
import { ChannelNotFoundError } from '../../common/errors/channel-not-found.error';
import { mapServerRefusal } from './baileys-groups';
import { BAILEYS_QUERY_BUDGET_MS, withQueryDeadline } from './baileys-query-deadline';

/**
 * Channel-domain operations extracted from BaileysAdapter. The adapter keeps the public
 * methods as thin forwarders and injects this narrow host surface via closures, so the
 * delegate never touches lifecycle state directly.
 */
export interface BaileysChannelsHost {
  ensureReady(): void;
  /** Post-ensureReady socket handle — call host.ensureReady() first. */
  getSocket(): WASocket;
}

export class BaileysChannels {
  constructor(
    private readonly host: BaileysChannelsHost,
    private readonly queryBudgetMs: number = BAILEYS_QUERY_BUDGET_MS,
  ) {}

  /**
   * Bound a channel call. executeWMexQuery throws Boom(..., { statusCode: 400, data: result }) when
   * nothing came back, and with result undefined Boom normalises data to null — so the refusal
   * classifier cannot place it and the raw Boom escapes as a bare 500.
   */
  private bounded<T>(work: Promise<T>, operation: string): Promise<T> {
    return withQueryDeadline(work, this.queryBudgetMs, `WhatsApp did not answer ${operation} in time`);
  }

  /** Post-ensureReady socket handle. */
  private sock(): WASocket {
    return this.host.getSocket();
  }

  async getChannelById(channelId: string): Promise<Channel | null> {
    this.host.ensureReady();
    // newsletterMetadata resolves ANY channel by jid (richer than the wwjs subscribed-list lookup).
    const meta = await this.bounded(this.sock().newsletterMetadata('jid', channelId), 'the channel lookup');
    return meta ? this.toChannel(meta) : null;
  }

  async subscribeToChannel(inviteCode: string): Promise<Channel> {
    this.host.ensureReady();
    const meta = await this.bounded(this.sock().newsletterMetadata('invite', inviteCode), 'the invite lookup');
    if (!meta) {
      throw new ChannelNotFoundError(inviteCode);
    }
    await this.bounded(this.sock().newsletterFollow(meta.id), 'the channel subscribe');
    return this.toChannel(meta);
  }

  /**
   * Deliberately NOT bounded, unlike every other call here: creating a channel is non-idempotent,
   * and 503 is a backpressure status the Go SDK retries three times for POST (sdk/go/retry.go).
   * A deadline abandons without cancelling, so a slow-but-succeeding create could leave duplicates.
   */
  async createChannel(name: string, description?: string): Promise<Channel> {
    this.host.ensureReady();
    const meta = await mapServerRefusal('Creating the channel', () => this.sock().newsletterCreate(name, description));
    return this.toChannel(meta);
  }

  async deleteChannel(channelId: string): Promise<void> {
    this.host.ensureReady();
    await mapServerRefusal('Deleting the channel', () =>
      this.bounded(this.sock().newsletterDelete(channelId), 'the channel delete'),
    );
  }

  async muteChannel(channelId: string, mute: boolean): Promise<void> {
    this.host.ensureReady();
    await mapServerRefusal(mute ? 'Muting the channel' : 'Unmuting the channel', () =>
      this.bounded(
        mute ? this.sock().newsletterMute(channelId) : this.sock().newsletterUnmute(channelId),
        mute ? 'the channel mute' : 'the channel unmute',
      ),
    );
  }

  async unsubscribeFromChannel(channelId: string): Promise<void> {
    this.host.ensureReady();
    await this.bounded(this.sock().newsletterUnfollow(channelId), 'the channel unsubscribe');
  }

  /** Map a Baileys NewsletterMetadata to the neutral Channel shape (optionals only when present). */
  private toChannel(meta: {
    id: string;
    name: string;
    description?: string;
    invite?: string;
    creation_time?: number;
    subscribers?: number;
    picture?: { url?: string };
    verification?: string;
    thread_metadata?: { creation_time?: number };
  }): Channel {
    const createdAt = meta.creation_time ?? meta.thread_metadata?.creation_time;
    return {
      id: meta.id,
      name: meta.name,
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.invite ? { inviteCode: meta.invite } : {}),
      ...(meta.subscribers !== undefined ? { subscriberCount: meta.subscribers } : {}),
      ...(meta.picture?.url ? { picture: meta.picture.url } : {}),
      ...(meta.verification ? { verified: meta.verification === 'VERIFIED' } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
    };
  }
}
