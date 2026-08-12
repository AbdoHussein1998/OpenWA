import type { Client } from 'whatsapp-web.js';
import { WwebjsMessaging } from './wwebjs-messaging';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * whatsapp-web.js attaches a quote as a plain send option, orthogonal to the content kind:
 * `quotedMessageId` is copied into `internalOptions` (Client.js:1475) BEFORE the content-kind
 * dispatch that moves the payload into `.media` / `.location` / `.poll` / `.contactCard`, so a quote
 * never competes with what is being sent.
 *
 * The reason these tests assert `ignoreQuoteErrors: false` rather than just the id: the library
 * default is TRUE (Client.js:1383 documents `[ignoreQuoteErrors = true]`, applied at :1480), which
 * makes an unresolvable quote send the message ANYWAY, unquoted, and report success. A caller who
 * asked for a reply and got a loose message with a 201 has no way to detect it. Opting out turns
 * that into an error the caller can see.
 */

const logger = createLogger('wwebjs-quoted-send.spec');

const QUOTED = 'true_628111@c.us_3EB0ABCD';

function makeMessaging(): { messaging: WwebjsMessaging; client: { sendMessage: jest.Mock } } {
  const client = {
    sendMessage: jest.fn().mockResolvedValue({ id: { _serialized: 'M1' }, timestamp: 1 }),
  };
  const host = {
    ensureReady: jest.fn(),
    ensureNotChannelRecipient: jest.fn(),
    getClient: () => client as unknown as Client,
    logger,
    config: {},
    getNumberId: jest.fn(),
    capInboundMediaFor: jest.fn(),
    isPageTransportError: () => false,
    reportIfPageTransportError: jest.fn(),
  } as unknown as WwebjsEngineHost;
  return { messaging: new WwebjsMessaging(host), client };
}

const optionsOf = (client: { sendMessage: jest.Mock }): Record<string, unknown> => {
  const [, , options] = client.sendMessage.mock.calls[0] as unknown[];
  return (options ?? {}) as Record<string, unknown>;
};

const CHAT = '628111@c.us';
// Base64 rather than a URL: a URL payload runs the real remote-media loader through the SSRF guard,
// so the test would exercise the network instead of the option plumbing it is about.
const IMAGE = {
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  mimetype: 'image/png',
};

describe('WwebjsMessaging — a quote rides along with every content kind', () => {
  // Each of these builds its own options object (or, for location and poll, had none at all before
  // this change), so covering only the shared media funnel would leave the others silently unquoted.
  it.each([
    ['image', (m: WwebjsMessaging) => m.sendImageMessage(CHAT, { ...IMAGE, quotedMessageId: QUOTED })],
    ['document', (m: WwebjsMessaging) => m.sendDocumentMessage(CHAT, { ...IMAGE, quotedMessageId: QUOTED })],
    ['sticker', (m: WwebjsMessaging) => m.sendStickerMessage(CHAT, { ...IMAGE, quotedMessageId: QUOTED })],
    [
      'location',
      (m: WwebjsMessaging) => m.sendLocationMessage(CHAT, { latitude: 1, longitude: 2, quotedMessageId: QUOTED }),
    ],
    [
      'contact',
      (m: WwebjsMessaging) => m.sendContactMessage(CHAT, { name: 'Alice', number: '628999', quotedMessageId: QUOTED }),
    ],
    [
      'poll',
      (m: WwebjsMessaging) => m.sendPollMessage(CHAT, { name: 'Q', options: ['a', 'b'], quotedMessageId: QUOTED }),
    ],
    ['text', (m: WwebjsMessaging) => m.sendTextMessage(CHAT, 'hi', undefined, { quotedMessageId: QUOTED })],
  ])('%s send forwards the quoted id with quote errors made visible', async (_kind, send) => {
    const { messaging, client } = makeMessaging();

    await send(messaging);

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(optionsOf(client).quotedMessageId).toBe(QUOTED);
    // The library would otherwise send unquoted and report success on a bad id.
    expect(optionsOf(client).ignoreQuoteErrors).toBe(false);
  });

  // Known-negative control: without it an implementation that hardcoded the keys onto every send
  // would satisfy every assertion above while changing behaviour for unquoted callers too.
  it('adds no quote keys at all when no id is supplied', async () => {
    const { messaging, client } = makeMessaging();

    await messaging.sendImageMessage(CHAT, IMAGE);

    expect(optionsOf(client)).not.toHaveProperty('quotedMessageId');
    expect(optionsOf(client)).not.toHaveProperty('ignoreQuoteErrors');
  });

  it('keeps the caption and mentions it already sent alongside the quote', async () => {
    const { messaging, client } = makeMessaging();

    await messaging.sendImageMessage(CHAT, {
      ...IMAGE,
      caption: 'look',
      mentions: ['628222@c.us'],
      quotedMessageId: QUOTED,
    });

    expect(optionsOf(client)).toMatchObject({
      caption: 'look',
      mentions: ['628222@c.us'],
      quotedMessageId: QUOTED,
    });
  });

  it('keeps sendMediaAsDocument, which shares the options object with the quote', async () => {
    const { messaging, client } = makeMessaging();

    await messaging.sendDocumentMessage(CHAT, { ...IMAGE, quotedMessageId: QUOTED });

    expect(optionsOf(client).sendMediaAsDocument).toBe(true);
    expect(optionsOf(client).quotedMessageId).toBe(QUOTED);
  });
});
