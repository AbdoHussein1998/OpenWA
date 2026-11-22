import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EngineFactory } from './engine.factory';
import { ConfigService } from '@nestjs/config';
import { PluginLoaderService, PluginType } from '../core/plugins';
import { BaileysMessageStoreService } from './adapters/baileys-message-store.service';
import { LidMappingStoreService } from './identity/lid-mapping-store.service';
import { WhatsAppWebJsAdapter } from './adapters/whatsapp-web-js.adapter';
import { BrowserManager } from './browser/browser.manager';
import { BrowserProfileManager } from './browser/browser-profile.manager';
import { WhatsAppWebJsPlugin } from './builtin/whatsapp-web-js';

describe('EngineFactory', () => {
  const engineBlob = {
    type: 'whatsapp-web.js',
    sessionDataPath: '/var/data/sessions',
    puppeteer: { headless: true, args: ['--no-sandbox'], executablePath: '/usr/bin/chromium-browser' },
  };
  const buildConfigService = (overrides: Record<string, unknown> = {}): ConfigService => {
    const values: Record<string, unknown> = {
      'engine.type': 'whatsapp-web.js',
      'engine.sessionDataPath': '/var/data/sessions',
      'engine.puppeteer.headless': true,
      'engine.puppeteer.args': ['--no-sandbox'],
      'engine.puppeteer.executablePath': '/usr/bin/chromium-browser',
      engine: engineBlob,
      ...overrides,
    };
    return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
  };

  const buildMessageStore = (): BaileysMessageStoreService =>
    ({ put: jest.fn(), getMessage: jest.fn(), clearSession: jest.fn() }) as unknown as BaileysMessageStoreService;

  const buildLidStore = (): LidMappingStoreService =>
    ({
      getCached: jest.fn(),
      lidsForPhone: jest.fn().mockReturnValue([]),
      remember: jest.fn().mockResolvedValue(undefined),
    }) as unknown as LidMappingStoreService;

  it('refuses to create an engine for an unsafe session name (path-traversal into the auth dir)', () => {
    const createEngine = jest.fn().mockReturnValue({});
    const pluginLoader = {
      getPlugin: jest.fn().mockReturnValue({ instance: { type: PluginType.ENGINE, createEngine } }),
    } as unknown as PluginLoaderService;
    const factory = new EngineFactory(buildConfigService(), pluginLoader, buildMessageStore(), buildLidStore());

    expect(() => factory.create({ sessionId: '../../etc', dbSessionId: 'db-1' })).toThrow(/unsafe session name/i);
    expect(() => factory.create({ sessionId: 'a/b', dbSessionId: 'db-1' })).toThrow(/unsafe session name/i);
    expect(createEngine).not.toHaveBeenCalled();
  });

  it('passes ONLY engine-neutral fields to createEngine (no Puppeteer leak)', () => {
    const createEngine = jest.fn().mockReturnValue({});
    const pluginInstance = { type: PluginType.ENGINE, createEngine };
    const pluginLoader = {
      getPlugin: jest.fn().mockReturnValue({ instance: pluginInstance }),
    } as unknown as PluginLoaderService;

    const factory = new EngineFactory(buildConfigService(), pluginLoader, buildMessageStore(), buildLidStore());
    factory.create({ sessionId: 'sess-1', dbSessionId: 'db-1', proxyUrl: 'http://p', proxyType: 'http' });

    // Plain-object (not objectContaining) assertion: any browser key (headless/puppeteerArgs/
    // executablePath/sessionDataPath) leaking into the per-call config would fail this exact match.
    expect(createEngine).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      dbSessionId: 'db-1',
      proxyUrl: 'http://p',
      proxyType: 'http',
    });
  });

  it('registers the built-in engine with the opaque engine config blob (#219 guarantee moves to context.config)', async () => {
    const registerBuiltInPlugin = jest.fn();
    const pluginLoader = {
      registerBuiltInPlugin,
      enablePlugin: jest.fn().mockResolvedValue(undefined),
      getPlugin: jest.fn(),
    } as unknown as PluginLoaderService;

    const factory = new EngineFactory(buildConfigService(), pluginLoader, buildMessageStore(), buildLidStore());
    await factory.onModuleInit();

    expect(registerBuiltInPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'whatsapp-web.js', type: PluginType.ENGINE }),
      expect.anything(),
      engineBlob,
    );
  });

  it('registers the built-in baileys engine alongside whatsapp-web.js with the opaque config blob', async () => {
    const registerBuiltInPlugin = jest.fn();
    const pluginLoader = {
      registerBuiltInPlugin,
      enablePlugin: jest.fn().mockResolvedValue(undefined),
      getPlugin: jest.fn(),
    } as unknown as PluginLoaderService;

    const factory = new EngineFactory(buildConfigService(), pluginLoader, buildMessageStore(), buildLidStore());
    await factory.onModuleInit();

    const registeredIds = registerBuiltInPlugin.mock.calls.map(call => (call as [{ id: string }])[0].id);
    expect(registeredIds).toContain('whatsapp-web.js');
    expect(registeredIds).toContain('baileys');
  });

  it('falls back to the direct adapter when no engine plugin is available', () => {
    const pluginLoader = {
      getPlugin: jest.fn().mockReturnValue(undefined),
    } as unknown as PluginLoaderService;

    const factory = new EngineFactory(buildConfigService(), pluginLoader, buildMessageStore(), buildLidStore());
    expect(() => factory.create({ sessionId: 'sess-2', dbSessionId: 'db-2' })).not.toThrow();
  });

  it('injects the BrowserManager into the registered plugin', async () => {
    const registerBuiltInPlugin = jest.fn();
    const pluginLoader = {
      registerBuiltInPlugin,
      enablePlugin: jest.fn().mockResolvedValue(undefined),
    } as unknown as PluginLoaderService;
    const browserManager = new BrowserManager();
    const factory = new EngineFactory(buildConfigService(), pluginLoader, buildMessageStore(), buildLidStore(), browserManager);
    await factory.onModuleInit();
    const wwjs = registerBuiltInPlugin.mock.calls.find(call => (call as [{ id: string }])[0].id === 'whatsapp-web.js')![1];
    const adapter = wwjs.createEngine({ sessionId: 'sess-selected' }) as WhatsAppWebJsAdapter;
    const config = (adapter as unknown as { config: {
      browserDriver: object; browserProfileManager: BrowserProfileManager; braveProfileManager: BrowserProfileManager;
    } }).config;
    expect(config.browserDriver).toBe(browserManager.getBrowser('brave'));
    expect(config.browserProfileManager).toBe(config.braveProfileManager);
  });

  it('resolves the same Brave driver and profile root in direct fallback as in the plugin', () => {
    const pluginLoader = { getPlugin: jest.fn().mockReturnValue(undefined) } as unknown as PluginLoaderService;
    const browserManager = new BrowserManager();
    const factory = new EngineFactory(buildConfigService({
      'engine.browser.type': 'brave',
      'engine.browser.executablePath': '/configured/browser',
      'engine.browser.profileBasePath': '/persisted/profiles',
    }), pluginLoader, buildMessageStore(), buildLidStore(), browserManager);
    const adapter = factory.create({ sessionId: 'sess-fallback', dbSessionId: 'db-fallback' }) as WhatsAppWebJsAdapter;
    const config = (adapter as unknown as { config: {
      browser: { type: string; executablePath: string; profileBasePath: string };
      browserDriver: object; browserProfileManager: BrowserProfileManager; braveProfileManager: BrowserProfileManager;
    } }).config;
    expect(config.browser).toEqual({
      type: 'brave', executablePath: '/configured/browser', profileBasePath: '/persisted/profiles',
      strictExecutablePath: true,
    });
    expect(config.browserDriver).toBe(browserManager.getBrowser('brave'));
    expect(config.browserProfileManager).toBe(config.braveProfileManager);
    expect(config.browserProfileManager.getProfilePath('sess-fallback')).toContain('/persisted/profiles/sess-fallback');
  });

  it('fails closed when a fallback configuration selects an unregistered browser', () => {
    const pluginLoader = { getPlugin: jest.fn().mockReturnValue(undefined) } as unknown as PluginLoaderService;
    const factory = new EngineFactory(buildConfigService({ 'engine.browser.type': 'chrome' }),
      pluginLoader, buildMessageStore(), buildLidStore());
    expect(() => factory.create({ sessionId: 'not-started', dbSessionId: 'db' })).toThrow(/Unsupported browser type/);
  });

  it('throws instead of silently building whatsapp-web.js when a non-wwebjs engine has no plugin', () => {
    // The legacy fallback only builds wwebjs; reaching it with ENGINE_TYPE=baileys must fail loudly
    // rather than run the wrong engine.
    const pluginLoader = {
      getPlugin: jest.fn().mockReturnValue(undefined),
    } as unknown as PluginLoaderService;

    const factory = new EngineFactory(
      buildConfigService({ 'engine.type': 'baileys' }),
      pluginLoader,
      buildMessageStore(),
      buildLidStore(),
    );
    expect(() => factory.create({ sessionId: 'sess-b', dbSessionId: 'db-b' })).toThrow(/baileys/i);
  });

  describe('create() makes the session credential directories owner-only', () => {
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-create-'));
    });
    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    const buildTmpFactory = (preLoosen?: boolean) => {
      const sessionDataPath = path.join(tmpRoot, 'sessions');
      const authDir = path.join(tmpRoot, 'baileys');
      // An upgrade reuses the dirs a previous install left world-readable (default umask); fresh
      // installs have no dirs at all. Both must end at 0o700 after create().
      if (preLoosen) {
        fs.mkdirSync(path.join(sessionDataPath, 'session-alice'), { recursive: true, mode: 0o755 });
        fs.mkdirSync(path.join(authDir, 'alice'), { recursive: true, mode: 0o755 });
      }
      const createEngine = jest.fn().mockReturnValue({});
      const pluginLoader = {
        getPlugin: jest.fn().mockReturnValue({ instance: { type: PluginType.ENGINE, createEngine } }),
      } as unknown as PluginLoaderService;
      const factory = new EngineFactory(
        buildConfigService({
          'engine.sessionDataPath': sessionDataPath,
          'engine.baileys.authDir': authDir,
          'engine.browser.profileBasePath': path.join(tmpRoot, 'profiles'),
        }),
        pluginLoader,
        buildMessageStore(),
        buildLidStore(),
      );
      return {
        factory,
        wwjsDir: path.join(sessionDataPath, 'session-alice'),
        baileysDir: path.join(authDir, 'alice'),
      };
    };

    const expectOwnerOnlyDir = (dir: string): void => {
      const stat = fs.statSync(dir);
      expect(stat.isDirectory()).toBe(true);

      // POSIX exposes owner/group/other mode bits, so we can verify the exact 0700 hardening.
      // Windows does not implement those distinctions through chmod/stat: Node documents that
      // only the writable bit is mutable there. The production helper still attempts chmod(0700),
      // but asserting a POSIX mode value on Windows would test an unsupported filesystem contract.
      if (process.platform !== 'win32') {
        expect(stat.mode & 0o777).toBe(0o700);
      }
    };

    it.each([false, true])('hardens both engine shapes on a %s install', preLoosen => {
      const { factory, wwjsDir, baileysDir } = buildTmpFactory(preLoosen);

      factory.create({ sessionId: 'alice', dbSessionId: 'db-1' });

      expectOwnerOnlyDir(wwjsDir);
      expectOwnerOnlyDir(baileysDir);
    });
  });

  describe('purgeSessionData (delete fully removes on-disk auth, keyed by session name)', () => {
    const noPluginLoader = () => ({ getPlugin: jest.fn() }) as unknown as PluginLoaderService;
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-purge-'));
    });
    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    // Both auth-dir shapes live under tmpRoot so the tests are hermetic regardless of CWD.
    const buildBothDirFactory = (engineType: string) => {
      const sessionDataPath = path.join(tmpRoot, 'sessions');
      const authDir = path.join(tmpRoot, 'baileys');
      const factory = new EngineFactory(
        buildConfigService({
          'engine.type': engineType,
          'engine.sessionDataPath': sessionDataPath,
          'engine.baileys.authDir': authDir,
        }),
        noPluginLoader(),
        buildMessageStore(),
        buildLidStore(),
      );
      return { factory, wwjsDir: path.join(sessionDataPath, 'session-alice'), baileysDir: path.join(authDir, 'alice') };
    };

    it.each(['whatsapp-web.js', 'baileys'])(
      "removes BOTH engines' auth dirs when the active engine is %s (engine-switch residue)",
      async engineType => {
        const { factory, wwjsDir, baileysDir } = buildBothDirFactory(engineType);
        fs.mkdirSync(wwjsDir, { recursive: true });
        fs.mkdirSync(baileysDir, { recursive: true });
        fs.writeFileSync(path.join(wwjsDir, 'creds.json'), '{}');
        fs.writeFileSync(path.join(baileysDir, 'creds.json'), '{}');

        await factory.purgeSessionData('alice');

        expect(fs.existsSync(wwjsDir)).toBe(false);
        expect(fs.existsSync(baileysDir)).toBe(false);
      },
    );

    it('purges the healthy dirs but reports a failure if any credential dir remains', async () => {
      const { factory, wwjsDir, baileysDir } = buildBothDirFactory('baileys');
      fs.mkdirSync(wwjsDir, { recursive: true });
      fs.mkdirSync(baileysDir, { recursive: true });

      const realRm = fs.promises.rm.bind(fs.promises);
      const spy = jest
        .spyOn(fs.promises, 'rm')
        .mockImplementation(async (...args: Parameters<typeof fs.promises.rm>) => {
          if (String(args[0]) === baileysDir) throw new Error('EIO: simulated disk failure');
          return realRm(...args);
        });
      try {
        await expect(factory.purgeSessionData('alice')).rejects.toThrow('Credential purge incomplete');
      } finally {
        spy.mockRestore();
      }

      // The healthy engine's purge still ran; the failed one remains, so DELETE must not free its name.
      expect(fs.existsSync(wwjsDir)).toBe(false);
      expect(fs.existsSync(baileysDir)).toBe(true);
    });

    it('is a no-op (no throw) when neither auth dir exists', async () => {
      const { factory } = buildBothDirFactory('baileys');
      await expect(factory.purgeSessionData('never-linked')).resolves.toBeUndefined();
    });

    it('uses the plugin effective profile root for purge when it overrides ConfigService', async () => {
      const registeredRoot = path.join(tmpRoot, 'registered-profiles');
      const effectiveRoot = path.join(tmpRoot, 'effective-profiles');
      const plugin = new WhatsAppWebJsPlugin({ browser: { profileBasePath: registeredRoot } });
      void plugin.onLoad({
        config: { browser: { profileBasePath: effectiveRoot } },
        logger: { log: jest.fn() },
      } as unknown as import('../core/plugins').PluginContext);
      const pluginLoader = {
        getPlugin: jest.fn((id: string) => id === 'whatsapp-web.js' ? { instance: plugin } : undefined),
      } as unknown as PluginLoaderService;
      const factory = new EngineFactory(buildConfigService({
        'engine.sessionDataPath': path.join(tmpRoot, 'sessions'),
        'engine.baileys.authDir': path.join(tmpRoot, 'baileys'),
        'engine.browser.profileBasePath': registeredRoot,
      }), pluginLoader, buildMessageStore(), buildLidStore());
      const actualProfile = path.join(effectiveRoot, 'alice');
      fs.mkdirSync(actualProfile, { recursive: true });
      fs.writeFileSync(path.join(actualProfile, 'credentials'), 'test');
      await factory.purgeSessionData('alice');
      expect(fs.existsSync(actualProfile)).toBe(false);
    });

    it('refuses to delete credentials while another browser profile lease exists', async () => {
      const { factory, wwjsDir, baileysDir } = buildBothDirFactory('whatsapp-web.js');
      fs.mkdirSync(wwjsDir, { recursive: true });
      fs.mkdirSync(baileysDir, { recursive: true });
      const lockPath = path.join(tmpRoot, 'profiles', '.openwa-profile-locks', 'alice');
      fs.mkdirSync(lockPath, { recursive: true });

      await expect(factory.purgeSessionData('alice')).rejects.toThrow(/ownership lock/);
      expect(fs.existsSync(wwjsDir)).toBe(true);
      expect(fs.existsSync(baileysDir)).toBe(true);
    });

    it('refuses all credential deletion when process ownership cannot be verified', async () => {
      const { factory, wwjsDir, baileysDir } = buildBothDirFactory('whatsapp-web.js');
      fs.mkdirSync(wwjsDir, { recursive: true });
      fs.mkdirSync(baileysDir, { recursive: true });
      const spy = jest.spyOn(BrowserProfileManager.prototype, 'assertNoConflictingBrowserProcesses')
        .mockRejectedValue(new Error('BROWSER_ORPHAN_RECOVERY_UNSAFE: unmarked browser uses profile'));
      try {
        await expect(factory.purgeSessionData('alice')).rejects.toThrow(/unmarked browser/);
      } finally {
        spy.mockRestore();
      }
      expect(fs.existsSync(wwjsDir)).toBe(true);
      expect(fs.existsSync(baileysDir)).toBe(true);
    });

    it('refuses to purge an unsafe session name (no rm on a traversal path)', async () => {
      // A sibling that a '../' name would resolve to — it must survive the refused purge.
      const sibling = path.join(tmpRoot, 'baileys-evil');
      fs.mkdirSync(sibling, { recursive: true });

      const { factory } = buildBothDirFactory('baileys');
      await expect(factory.purgeSessionData('../baileys-evil')).rejects.toThrow('unsafe session name');

      expect(fs.existsSync(sibling)).toBe(true);
    });
  });
});
