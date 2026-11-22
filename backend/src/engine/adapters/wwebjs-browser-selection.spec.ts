import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { BrowserProfileManager } from '../browser/browser-profile.manager';
import { BrowserManager } from '../browser/browser.manager';

/** Offline construction-only tests: no Puppeteer or WhatsApp sessions are initialized. */
describe('WhatsAppWebJsAdapter browser selection', () => {
  const base = { sessionId: 'selection-test', sessionDataPath: '/tmp/sessions' };

  it('defaults to Brave with its original standalone profile root', () => {
    const adapter = new WhatsAppWebJsAdapter(base);
    const config = (adapter as unknown as { config: {
      browser: { type: string }; browserDriver: { type: string };
      browserProfileManager: BrowserProfileManager; braveProfileManager: BrowserProfileManager;
    } }).config;
    expect(config.browser.type).toBe('brave');
    expect(config.browserDriver.type).toBe('brave');
    expect(config.browserProfileManager).toBe(config.braveProfileManager);
    expect(config.browserProfileManager.getProfilePath(base.sessionId)).toContain('brave-profiles');
  });

  it('uses the supplied driver and manager without substituting either', () => {
    const driver = new BrowserManager().getBrowser('brave');
    const manager = new BrowserProfileManager('/persisted/existing', [driver]);
    const adapter = new WhatsAppWebJsAdapter({
      ...base, browser: { type: 'brave', profileBasePath: '/persisted/existing' },
      browserDriver: driver, browserProfileManager: manager,
    });
    const config = (adapter as unknown as { config: {
      browserDriver: typeof driver; browserProfileManager: BrowserProfileManager;
      braveProfileManager: BrowserProfileManager;
    } }).config;
    expect(config.browserDriver).toBe(driver);
    expect(config.browserProfileManager).toBe(manager);
    expect(config.braveProfileManager).toBe(manager);
  });

  it('rejects conflicting profile manager aliases', () => {
    expect(() => new WhatsAppWebJsAdapter({
      ...base, browserProfileManager: new BrowserProfileManager('/one'),
      braveProfileManager: new BrowserProfileManager('/two'),
    })).toThrow(/Conflicting browser profile manager/);
  });

  it('rejects a browser driver whose type disagrees with the selected browser', () => {
    const driver = new BrowserManager().getBrowser('brave');
    const mismatched = { ...driver, type: 'chrome' as typeof driver.type };
    expect(() => new WhatsAppWebJsAdapter({ ...base, browserDriver: mismatched }))
      .toThrow(/Browser driver mismatch/);
  });
});

describe('Phase 7 browser override propagation', () => {
  const base = { sessionId: 'phase7-override', sessionDataPath: '/tmp/sessions' };

  it('preserves strict executable provenance in the adapter config', () => {
    const adapter = new WhatsAppWebJsAdapter({
      ...base,
      browser: { type: 'brave', executablePath: '/opt/brave', profileBasePath: '/profiles', strictExecutablePath: true },
    });
    const cfg = (adapter as unknown as { config: { browser: { strictExecutablePath: boolean } } }).config;
    expect(cfg.browser.strictExecutablePath).toBe(true);
  });

  it('does not promote a legacy Brave fallback into an explicit strict override', () => {
    const adapter = new WhatsAppWebJsAdapter({ ...base, brave: { executablePath: '/legacy/brave' } });
    const cfg = (adapter as unknown as { config: { browser: { strictExecutablePath: boolean } } }).config;
    expect(cfg.browser.strictExecutablePath).toBe(false);
  });
});
