import type { WASocket } from '@whiskeysockets/baileys';
import type { Client } from 'whatsapp-web.js';
import { WwebjsChats } from './wwebjs-chats';
import { BaileysContacts, type BaileysContactsHost } from './baileys-contacts';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { type WwebjsMessaging } from './wwebjs-messaging';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * Chat pin/unpin — the second of the §29.5.3 "supported by BOTH libraries, missing only in OpenWA"
 * backlog. Chat-level, distinct from `pinMessage`, which pins a message inside a chat.
 *
 * The whole difficulty is the return value, and it is the same trap `archiveChat` already carries:
 * whatsapp-web.js's `pinChat`/`unpinChat` resolve the chat's NEW PIN STATE, not a success flag
 * (`Client.js:2046-2084`). `unpinChat` therefore returns `false` on every successful unpin — both
 * on its early-out for an already-unpinned chat and after actually unpinning. Forwarding that
 * verbatim would report every successful unpin as "the engine declined".
 *
 * But `pinChat`'s `false` is NOT noise: WhatsApp allows at most three pinned chats
 * (`MAX_PIN_COUNT = 3`), and the page returns `false` without pinning when that is already met.
 * That is a real refusal a caller needs to see. So the two directions are asymmetric, and only the
 * pin direction can decline.
 *
 * Baileys has no refusal signal at all — `chatModify({pin})` writes a `pinAction` app-state patch
 * and that is the end of it — and, like `mute` and unlike `archive`, the patch carries no
 * `lastMessages`, so a chat with no known history pins fine.
 */

const logger = createLogger('chat-pin.spec');

describe('WwebjsChats.pinChat', () => {
  function makeChats(): { chats: WwebjsChats; client: { [k: string]: jest.Mock } } {
    const client = {
      pinChat: jest.fn().mockResolvedValue(true),
      unpinChat: jest.fn().mockResolvedValue(false),
    };
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      logger,
    } as unknown as WwebjsEngineHost;
    return { chats: new WwebjsChats(host, {} as unknown as WwebjsMessaging), client };
  }

  it('pinning a chat calls pinChat and reports success', async () => {
    const { chats, client } = makeChats();
    await expect(chats.pinChat('628123@c.us', true)).resolves.toBe(true);
    expect(client.pinChat).toHaveBeenCalledWith('628123@c.us');
    expect(client.unpinChat).not.toHaveBeenCalled();
  });

  // The pin limit is the one case where whatsapp-web.js's return value carries real information.
  it('reports false when WhatsApp refuses the pin because three chats are already pinned', async () => {
    const { chats, client } = makeChats();
    client.pinChat.mockResolvedValue(false);
    await expect(chats.pinChat('628123@c.us', true)).resolves.toBe(false);
  });

  // The archiveChat trap, in the pin direction: unpinChat resolves the NEW pin state, which is
  // false for every successful unpin. Forwarding it would report success as refusal.
  it('unpinning reports success even though unpinChat resolves false', async () => {
    const { chats, client } = makeChats();
    await expect(chats.pinChat('628123@c.us', false)).resolves.toBe(true);
    expect(client.unpinChat).toHaveBeenCalledWith('628123@c.us');
    expect(client.pinChat).not.toHaveBeenCalled();
  });
});

describe('BaileysContacts.pinChat', () => {
  const never = (): Promise<never> => new Promise<never>(() => undefined);

  function makeContacts(
    sock: Record<string, jest.Mock>,
    opts: { lastMessage?: unknown; budgetMs?: number } = {},
  ): BaileysContacts {
    const host = {
      ensureReady: () => undefined,
      getSocket: () => sock as unknown as WASocket,
      logger,
      normalizedSelfJid: () => '628177@s.whatsapp.net',
      listContacts: () => [],
      findContact: () => null,
      resolvePhone: () => null,
      listChats: () => [],
      lastMessage: () => opts.lastMessage ?? null,
      toEngineJid: (j: string) => j.replace('@c.us', '@s.whatsapp.net'),
    } as unknown as BaileysContactsHost;
    return new BaileysContacts(host, opts.budgetMs ?? 500);
  }

  it('pinning writes the pin app-state patch for that chat', async () => {
    const chatModify = jest.fn().mockResolvedValue(undefined);
    await expect(makeContacts({ chatModify }).pinChat('628123@c.us', true)).resolves.toBe(true);
    expect(chatModify).toHaveBeenCalledWith({ pin: true }, '628123@s.whatsapp.net');
  });

  it('unpinning writes the same patch with pin false', async () => {
    const chatModify = jest.fn().mockResolvedValue(undefined);
    await expect(makeContacts({ chatModify }).pinChat('628123@c.us', false)).resolves.toBe(true);
    expect(chatModify).toHaveBeenCalledWith({ pin: false }, '628123@s.whatsapp.net');
  });

  it('works on a chat with NO known history, unlike archive/clear/delete', async () => {
    const chatModify = jest.fn().mockResolvedValue(undefined);
    const contacts = makeContacts({ chatModify }, { lastMessage: null });
    await expect(contacts.pinChat('628123@c.us', true)).resolves.toBe(true);
    expect(chatModify).toHaveBeenCalledTimes(1);
  });

  it('reports an unconfirmed write rather than resolving on a silent socket', async () => {
    const contacts = makeContacts({ chatModify: jest.fn(never) }, { budgetMs: 15 });
    await expect(contacts.pinChat('628123@c.us', true)).rejects.toBeInstanceOf(EngineTransportError);
  });
});
