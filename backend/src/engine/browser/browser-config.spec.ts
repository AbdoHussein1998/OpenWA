import { resolveBrowserSettings } from './browser-config';

const defaults = { profileBasePath: '/data/brave-profiles', executablePath: '/usr/bin/brave' };

describe('resolveBrowserSettings — shared plugin/fallback configuration', () => {
  it('preserves the existing Brave defaults', () => {
    expect(resolveBrowserSettings({}, defaults)).toEqual({
      type: 'brave',
      executablePath: '/usr/bin/brave',
      profileBasePath: '/data/brave-profiles',
      strictExecutablePath: false,
    });
  });

  it('preserves legacy Brave and Puppeteer precedence', () => {
    expect(resolveBrowserSettings({
      puppeteer: { executablePath: '/legacy/puppeteer' },
      brave: { executablePath: '/legacy/brave', profileBasePath: '/profiles/legacy' },
    }, defaults)).toEqual({
      type: 'brave',
      executablePath: '/legacy/brave',
      profileBasePath: '/profiles/legacy',
      strictExecutablePath: false,
    });
    expect(resolveBrowserSettings({ puppeteer: { executablePath: '/legacy/puppeteer' } }, defaults)
      .executablePath).toBe('/legacy/puppeteer');
  });

  it('prefers browser-neutral settings without renaming existing storage implicitly', () => {
    expect(resolveBrowserSettings({
      browser: { type: 'brave', executablePath: '/configured/browser', profileBasePath: '/existing/profiles' },
      brave: { executablePath: '/old/brave', profileBasePath: '/old/profiles' },
    }, defaults)).toEqual({
      type: 'brave', executablePath: '/configured/browser', profileBasePath: '/existing/profiles',
      strictExecutablePath: true,
    });
  });

  it('rejects a blank profile base path instead of resolving a profile under CWD', () => {
    expect(() => resolveBrowserSettings({ browser: { profileBasePath: '  ' } }, defaults))
      .toThrow(/profile base path/);
  });

  it.each(['chrome', 'chromium', 'firefox', '', 42, {}])(
    'fails closed on unregistered/invalid browser type %p', (type) => {
      expect(() => resolveBrowserSettings({ browser: { type } }, defaults)).toThrow(/Unsupported browser type/);
    },
  );
});

describe('Phase 7 browser executable provenance', () => {
  const defaults = { profileBasePath: './data/brave-profiles', executablePath: '/usr/bin/brave' };

  it('preserves legacy executable fallback behavior', () => {
    const selected = resolveBrowserSettings({
      brave: { executablePath: '/legacy/brave' }, puppeteer: { executablePath: '/puppeteer' },
    }, defaults);
    expect(selected.strictExecutablePath).toBe(false);
    expect(resolveBrowserSettings({ browser: selected }, defaults).strictExecutablePath).toBe(false);
  });

  it('preserves strict explicit path through the second resolution in the adapter', () => {
    const selected = resolveBrowserSettings({ browser: { executablePath: '/opt/brave' } }, defaults);
    expect(selected.strictExecutablePath).toBe(true);
    expect(resolveBrowserSettings({ browser: selected }, defaults).strictExecutablePath).toBe(true);
  });

  it('rejects blank explicit paths injected via persisted plugin settings', () => {
    expect(() => resolveBrowserSettings({ browser: { executablePath: '    ' } }, defaults))
      .toThrow(/Browser executable path/);
  });
});
