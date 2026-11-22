import configuration from './configuration';
import { validateEnv } from './env.validation';
import { BLANK_SHADOWED_ENV_KEYS, clearBlankEnv } from './env-precedence';
import { resolveBrowserSettings } from '../engine/browser/browser-config';

/** Phase 7 regression coverage for the config -> plugin/fallback resolver boundary. */
describe('Phase 7 — validated browser-neutral environment', () => {
  const keys = [
    'BROWSER_TYPE', 'BROWSER_EXECUTABLE_PATH', 'BROWSER_PROFILE_BASE_PATH',
    'BRAVE_EXECUTABLE', 'BRAVE_PROFILE_PATH', 'PUPPETEER_EXECUTABLE_PATH',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    keys.forEach(key => {
      saved[key] = process.env[key];
      delete process.env[key];
    });
  });
  afterEach(() => {
    keys.forEach(key => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  });

  const resolved = () => resolveBrowserSettings(configuration().engine, {
    profileBasePath: '/data/brave-profiles', executablePath: '/usr/bin/brave',
  });

  it('defaults to Brave and keeps the historical configured profile root', () => {
    const engine = configuration().engine;
    expect(engine.browser).toEqual({ type: 'brave', executablePath: undefined, profileBasePath: undefined });
    expect(engine.brave).toEqual({ executablePath: '/usr/bin/brave', profileBasePath: './data/brave-profiles' });
    expect(resolved()).toEqual({
      type: 'brave', executablePath: '/usr/bin/brave', profileBasePath: './data/brave-profiles',
      strictExecutablePath: false,
    });
  });

  it('reads all three BROWSER_* variables without mutating legacy Brave config', () => {
    process.env.BROWSER_TYPE = 'brave';
    process.env.BROWSER_EXECUTABLE_PATH = '/opt/custom/brave';
    process.env.BROWSER_PROFILE_BASE_PATH = '/persisted/old-profiles';
    expect(resolved()).toEqual({
      type: 'brave', executablePath: '/opt/custom/brave',
      profileBasePath: '/persisted/old-profiles', strictExecutablePath: true,
    });
    expect(configuration().engine.brave.profileBasePath).toBe('./data/brave-profiles');
  });

  it('prefers browser overrides over BRAVE_* and Puppeteer fallback', () => {
    process.env.BRAVE_EXECUTABLE = '/legacy/brave';
    process.env.BRAVE_PROFILE_PATH = '/legacy/profiles';
    process.env.PUPPETEER_EXECUTABLE_PATH = '/legacy/puppeteer';
    expect(resolved()).toMatchObject({ executablePath: '/legacy/brave', profileBasePath: '/legacy/profiles', strictExecutablePath: false });
    process.env.BROWSER_EXECUTABLE_PATH = '/new/brave';
    process.env.BROWSER_PROFILE_BASE_PATH = '/new/profiles';
    expect(resolved()).toMatchObject({ executablePath: '/new/brave', profileBasePath: '/new/profiles', strictExecutablePath: true });
  });

  it('keeps PUPPETEER_EXECUTABLE_PATH in the driver discovery fallback', () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = '/legacy/puppeteer';
    const settings = resolved();
    expect(settings.strictExecutablePath).toBe(false);
    expect(configuration().engine.puppeteer.executablePath).toBe('/legacy/puppeteer');
  });

  it('rejects unregistered browsers before a WhatsApp session is created', () => {
    for (const browser of ['chrome', 'chromium', 'firefox', 'Brave', 'unknown']) {
      expect(() => validateEnv({ BROWSER_TYPE: browser })).toThrow(/BROWSER_TYPE/);
    }
    expect(() => validateEnv({ BROWSER_TYPE: 'brave' })).not.toThrow();
    expect(() => validateEnv({ BROWSER_TYPE: 123 })).toThrow(/BROWSER_TYPE/);
  });

  it('rejects empty, non-string, and NUL-containing explicit paths', () => {
    for (const key of ['BROWSER_EXECUTABLE_PATH', 'BROWSER_PROFILE_BASE_PATH']) {
      for (const invalid of ['', '  ', 123, null, '\0bad']) {
        expect(() => validateEnv({ [key]: invalid })).toThrow(new RegExp(key));
      }
      expect(() => validateEnv({ [key]: '/opt/persisted/path' })).not.toThrow();
    }
  });

  it('clears blank Compose forwards so lower-priority loaded configuration can apply', () => {
    const forwarded: NodeJS.ProcessEnv = {
      BROWSER_TYPE: '', BROWSER_EXECUTABLE_PATH: '   ', BROWSER_PROFILE_BASE_PATH: '',
    };
    clearBlankEnv(forwarded, BLANK_SHADOWED_ENV_KEYS);
    expect(forwarded).toEqual({});
    expect(BLANK_SHADOWED_ENV_KEYS).toEqual(expect.arrayContaining(keys.slice(0, 3)));
  });
});
