jest.mock('../../adapters/whatsapp-web-js.adapter', () => ({
  WhatsAppWebJsAdapter: jest.fn().mockImplementation((config: unknown) => ({ config })),
}));

import { WhatsAppWebJsPlugin } from './index';
import { WhatsAppWebJsAdapter } from '../../adapters/whatsapp-web-js.adapter';
import { PluginContext } from '../../../core/plugins';
import { BrowserManager } from '../../browser/browser.manager';

describe('WhatsAppWebJsPlugin.createEngine (opaque config)', () => {
  beforeEach(() => {
    (WhatsAppWebJsAdapter as unknown as jest.Mock).mockClear();
  });

  function withContext(plugin: WhatsAppWebJsPlugin, config: Record<string, unknown>): void {
    // onLoad sets this.context synchronously; the returned promise can be ignored here.
    void plugin.onLoad({ config, logger: { log: jest.fn() } } as unknown as PluginContext);
  }

  it('reads browser config from context.config (the opaque engine blob), not per-call', () => {
    const plugin = new WhatsAppWebJsPlugin();
    withContext(plugin, {
      sessionDataPath: '/data/sessions',
      puppeteer: {
        headless: false,
        args: ['--single-process'],
        executablePath: '/usr/bin/chromium',
        protocolTimeoutMs: 300_000,
      },
    });

    plugin.createEngine({ sessionId: 'sess-1', proxyUrl: 'http://p', proxyType: 'http' });

    expect(WhatsAppWebJsAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        sessionDataPath: '/data/sessions',
        // protocolTimeoutMs is asserted with a value, not just carried: an object with the key
        // present-but-undefined equals one without it, so a dropped hop would pass unnoticed.
        puppeteer: {
          headless: false,
          args: ['--single-process'],
          executablePath: '/usr/bin/chromium',
          protocolTimeoutMs: 300_000,
        },
        proxy: { url: 'http://p', type: 'http' },
      }),
    );
  });

  it('falls back to safe defaults when context has no config', () => {
    const plugin = new WhatsAppWebJsPlugin();

    plugin.createEngine({ sessionId: 'sess-2' });

    expect(WhatsAppWebJsAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-2',
        sessionDataPath: './data/sessions',
        puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'], executablePath: undefined },
      }),
    );
  });

  it('Uses the constructor-supplied engine config when onLoad never ran (enable-failure path)', () => {
    // EngineFactory now also passes the engine blob at construction. If enablePlugin fails before
    // onLoad runs, this.context is never set — the ctor blob must still supply operator config
    // instead of silently degrading to defaults (which dropped sessionDataPath/executablePath).
    const plugin = new WhatsAppWebJsPlugin({
      sessionDataPath: '/op/sessions',
      puppeteer: { headless: false, args: ['--flag'], executablePath: '/usr/bin/chromium' },
    });

    plugin.createEngine({ sessionId: 'sess-3' });

    expect(WhatsAppWebJsAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-3',
        sessionDataPath: '/op/sessions',
        puppeteer: { headless: false, args: ['--flag'], executablePath: '/usr/bin/chromium' },
      }),
    );
  });

  it('injects the same selected driver and profile manager into the adapter', () => {
    const browserManager = new BrowserManager();
    const plugin = new WhatsAppWebJsPlugin(undefined, undefined, browserManager);
    withContext(plugin, {
      browser: { type: 'brave', executablePath: '/custom/browser', profileBasePath: '/existing/profiles' },
      brave: { executablePath: '/old/brave', profileBasePath: '/old/profiles' },
    });
    plugin.createEngine({ sessionId: 'driver-1' });
    const config = (WhatsAppWebJsAdapter as jest.Mock).mock.calls[0][0];
    expect(config.browser).toEqual({
      type: 'brave', executablePath: '/custom/browser', profileBasePath: '/existing/profiles',
      strictExecutablePath: true,
    });
    expect(config.browserDriver).toBe(browserManager.getBrowser('brave'));
    expect(config.browserProfileManager).toBe(config.braveProfileManager);
    expect(config.browserProfileManager.getProfilePath('driver-1')).toContain('/existing/profiles/driver-1');
  });

  it('exposes the effective profile root used for safe credential purge', () => {
    const plugin = new WhatsAppWebJsPlugin({ browser: { profileBasePath: '/registered' } });
    withContext(plugin, { browser: { profileBasePath: '/effective' } });
    expect(plugin.getEffectiveProfileBasePath()).toBe('/effective');
  });

  it('rejects an unregistered browser before creating a WhatsApp adapter', () => {
    const plugin = new WhatsAppWebJsPlugin({ browser: { type: 'chrome' } });
    expect(() => plugin.createEngine({ sessionId: 'driver-2' })).toThrow(/Unsupported browser type/);
    expect(WhatsAppWebJsAdapter).not.toHaveBeenCalled();
  });

  it('prefers context browser selection over registered configuration', () => {
    const plugin = new WhatsAppWebJsPlugin({ browser: { type: 'chrome' } });
    withContext(plugin, { browser: { type: 'brave' } });
    expect(() => plugin.createEngine({ sessionId: 'driver-3' })).not.toThrow();
  });

  it('Prefers context.config over the constructor blob on the healthy enable path', () => {
    const plugin = new WhatsAppWebJsPlugin({ sessionDataPath: '/ctor/path' });
    withContext(plugin, { sessionDataPath: '/context/path' });

    plugin.createEngine({ sessionId: 'sess-4' });

    expect(WhatsAppWebJsAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-4', sessionDataPath: '/context/path' }),
    );
  });
});

describe('WhatsAppWebJsPlugin.getFeatures', () => {
  it('does not advertise catalog — the wwjs adapter 501s every catalog method', () => {
    const features = new WhatsAppWebJsPlugin().getFeatures();
    expect(features).not.toContain('catalog');
    expect(features).toEqual(
      expect.arrayContaining(['text-messages', 'media-messages', 'group-management', 'labels', 'channels']),
    );
  });
});
