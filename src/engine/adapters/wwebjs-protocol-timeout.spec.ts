import { Client } from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';

/**
 * The per-CDP-command budget handed to Puppeteer, and the one error it produces.
 *
 * Two invariants worth pinning: the option must never reach Puppeteer falsy (that arms no timer at
 * all, so a wedged renderer hangs the request — see wwebjs-lifecycle.ts), and a protocol timeout
 * must never be read as a dead page.
 */
describe('whatsapp-web.js protocol timeout', () => {
  const SESSION_ID = 'sess-protocol-timeout';
  let clientInitSpy: jest.SpyInstance;
  let savedWebVersion: string | undefined;

  const launchedPuppeteerOptions = async (
    protocolTimeoutMs?: number,
  ): Promise<{ protocolTimeout?: number } | undefined> => {
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: SESSION_ID,
      sessionDataPath: './data/sessions',
      puppeteer: { protocolTimeoutMs },
    });
    await adapter.initialize({});
    return (adapter as unknown as { client: { options: { puppeteer?: { protocolTimeout?: number } } } }).client.options
      .puppeteer;
  };

  beforeEach(() => {
    // Keep initialize() offline: 'off' skips the wa-version registry fetch in resolveWebVersionPin.
    savedWebVersion = process.env.WWEBJS_WEB_VERSION;
    process.env.WWEBJS_WEB_VERSION = 'off';
    // Build the real wwebjs Client — that is what carries the launch options — but launch no browser.
    clientInitSpy = jest
      .spyOn(Client.prototype as unknown as { initialize: () => Promise<void> }, 'initialize')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    clientInitSpy.mockRestore();
    if (savedWebVersion === undefined) {
      delete process.env.WWEBJS_WEB_VERSION;
    } else {
      process.env.WWEBJS_WEB_VERSION = savedWebVersion;
    }
  });

  it('hands a configured budget to the Client as puppeteer.protocolTimeout', async () => {
    expect(await launchedPuppeteerOptions(300_000)).toMatchObject({ protocolTimeout: 300_000 });
  });

  it('omits the option when unset, leaving Puppeteer its own 180 000 ms default', async () => {
    const options = await launchedPuppeteerOptions(undefined);

    // Absent, not zero: passing 0 through would DISABLE the timer rather than fall back.
    expect(options).not.toHaveProperty('protocolTimeout');
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN, e.g. from a malformed env value', Number.NaN],
  ])('omits the option for a %s value rather than arming no timer', async (_label, value) => {
    expect(await launchedPuppeteerOptions(value)).not.toHaveProperty('protocolTimeout');
  });

  describe('the transport classifier', () => {
    const classify = (message: string): boolean => {
      const adapter = new WhatsAppWebJsAdapter({
        sessionId: SESSION_ID,
        sessionDataPath: './data/sessions',
        puppeteer: {},
      });
      return (adapter as unknown as { isPageTransportError: (error: unknown) => boolean }).isPageTransportError(
        new Error(message),
      );
    };

    /**
     * Verbatim from Puppeteer 24.38.0 `common/CallbackRegistry.js`, where the leading label is the
     * CDP method name. Pinning the real string is the point: a paraphrase would keep passing while
     * the message the library actually throws drifted out from under the guard.
     */
    const PUPPETEER_PROTOCOL_TIMEOUT =
      "Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed.";

    it('does not treat a protocol timeout as a dead page', () => {
      // The renderer is slower than the budget, not gone — the next command may well succeed.
      // Reporting death here would tear down a live session and answer 503 for a working page.
      expect(classify(PUPPETEER_PROTOCOL_TIMEOUT)).toBe(false);
    });

    it.each([
      'Protocol error (Runtime.callFunctionOn): Session closed.',
      'Protocol error (Page.navigate): Target closed',
      'Attempted to use detached Frame',
      'Connection closed',
    ])('still reports a genuine transport death: %s', message => {
      // The 503-on-dead-page contract, pinned from the other side: narrowing the classifier for
      // timeouts must not cost a single real death signature.
      expect(classify(message)).toBe(true);
    });

    it('reports a death whose message also mentions a timeout', () => {
      // Why the guard matches Puppeteer's full phrase instead of a bare /timed out/: the broad
      // version swallows this, turning a reportable dead page into a silent one.
      expect(classify('Protocol error (Runtime.callFunctionOn): Session closed. Request timed out')).toBe(true);
    });
  });
});
