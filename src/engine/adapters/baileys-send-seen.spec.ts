import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysContacts, BaileysContactsHost } from './baileys-contacts';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * `readMessages` reaches `fetchPrivacySettings`, whose body is
 * `const { content } = await query({...})`. On an unanswered query that destructure throws a raw
 * TypeError — no Boom, so nothing can classify it — and the caller gets a bare 500.
 *
 * Marking a chat read is idempotent in effect, so bounding it is safe: a repeat costs nothing.
 * The media send path is deliberately NOT bounded the same way — see the PR.
 */
const never = (): Promise<never> => new Promise<never>(() => undefined);

function contacts(sock: Record<string, jest.Mock>, budgetMs: number): BaileysContacts {
  const host = {
    ensureReady: () => undefined,
    getSocket: () => sock as unknown as WASocket,
    logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
    normalizedSelfJid: () => '628177@s.whatsapp.net',
    listContacts: () => [],
    findContact: () => null,
    resolvePhone: () => null,
    listChats: () => [],
    lastMessage: () => ({ key: { id: 'M1', remoteJid: '628123@s.whatsapp.net' }, timestamp: 1 }),
    toEngineJid: (j: string) => j,
  } as unknown as BaileysContactsHost;
  return new BaileysContacts(host, budgetMs);
}

describe('sendSeen', () => {
  it('reports an unanswered read receipt instead of a bare 500', async () => {
    await expect(contacts({ readMessages: jest.fn(never) }, 15).sendSeen('628123@c.us')).rejects.toBeInstanceOf(
      EngineTransportError,
    );
  });

  it('still resolves when WhatsApp answers inside the budget', async () => {
    const readMessages = jest.fn().mockResolvedValue(undefined);
    await expect(contacts({ readMessages }, 500).sendSeen('628123@c.us')).resolves.toBe(true);
  });

  it('acknowledges every supplied message, not just the newest one', async () => {
    // The whole point of the caller-supplied list: a burst of three inbound messages used to leave
    // the first two unread forever, because only lastMessage() was ever acknowledged.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    await expect(contacts({ readMessages }, 500).sendSeen('628123@c.us', ['M1', 'M2', 'M3'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([
      { remoteJid: '628123@c.us', id: 'M1', fromMe: false },
      { remoteJid: '628123@c.us', id: 'M2', fromMe: false },
      { remoteJid: '628123@c.us', id: 'M3', fromMe: false },
    ]);
  });

  it('marks supplied messages even when the store has nothing cached', async () => {
    // The restart case: the in-memory store is empty, so the old code returned false under a 200
    // and no receipt was ever sent. A caller that persisted the IDs is not subject to that.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = {
      ensureReady: () => undefined,
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
      lastMessage: () => null,
      toEngineJid: (j: string) => j,
    } as unknown as BaileysContactsHost;
    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['M9'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([{ remoteJid: '628123@c.us', id: 'M9', fromMe: false }]);
  });

  it('falls back to the cached last message when the caller supplies an empty list', async () => {
    const readMessages = jest.fn().mockResolvedValue(undefined);
    await expect(contacts({ readMessages }, 500).sendSeen('628123@c.us', [])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([{ id: 'M1', remoteJid: '628123@s.whatsapp.net' }]);
  });

  it('still short-circuits when there is no last message to mark', async () => {
    const host = {
      ensureReady: () => undefined,
      getSocket: () => ({}) as unknown as WASocket,
      logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
      lastMessage: () => null,
    } as unknown as BaileysContactsHost;
    await expect(new BaileysContacts(host, 15).sendSeen('628123@c.us')).resolves.toBe(false);
  });
});
