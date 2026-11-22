import { Client } from 'whatsapp-web.js';
import { WwebjsLifecycle, type WwebjsLifecycleHost } from './wwebjs-lifecycle';
import type { BrowserProfileManager } from '../browser/browser-profile.manager';
import type { BrowserInterface } from '../browser/interfaces/browser.interface';

/**
 * Offline Phase 4 contract tests: no browser is launched and no filesystem
 * profile is created. The driver is injected directly into the lifecycle;
 * Phase 5 will supply it through EngineFactory / the plugin registry.
 */
describe('WwebjsLifecycle browser-neutral driver integration', () => {
  const sessionId = 'test-browser-driver';
  let initialize: jest.SpyInstance;

  beforeEach(() => {
    initialize = jest.spyOn(Client.prototype, 'initialize').mockResolvedValue(undefined);
  });
  afterEach(() => initialize.mockRestore());

  function makeFixture(options: { conflicting?: boolean; driverArgs?: string[] } = {}) {
    const calls: string[] = [];
    const release = Object.assign(jest.fn(async () => undefined), { ownerToken: 'lease-generation-1' });
    const getProfilePath = jest.fn((id: string) => `/already-mounted/brave-profiles/${id}`);
    const manager = {
      getProfilePath,
      ensureProfile: jest.fn(async () => { calls.push('profile'); }),
      acquireProfileLease: jest.fn(async () => { calls.push('lease'); return release; }),
      assertNoConflictingBrowserProcesses: jest.fn(async () => {
        calls.push('verified');
        if (options.conflicting) throw new Error('PROFILE_RECOVERY_UNSAFE: browser still owns the profile');
      }),
      removeStaleSingletonFiles: jest.fn(async () => { calls.push('singleton'); }),
    } as unknown as BrowserProfileManager;
    const driver: BrowserInterface = {
      type: 'brave',
      resolveExecutablePath: jest.fn(async () => {
        calls.push('executable');
        return process.execPath;
      }),
      getBrowserSpecificArgs: jest.fn(() => options.driverArgs ?? ['--disable-gpu']),
      matchesExecutable: jest.fn(() => true),
    };
    const host = {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), event: jest.fn() },
      config: {
        sessionId,
        sessionDataPath: '/already-mounted/sessions',
        brave: { executablePath: process.execPath },
        puppeteer: { headless: true, protocolTimeoutMs: 50_000 },
      },
      getCallbacks: () => ({}),
      emitState: jest.fn(),
      scheduleAuthReconcile: jest.fn(), clearAuthReconcile: jest.fn(),
      scheduleReadyReconcile: jest.fn(), clearReadyReconcile: jest.fn(),
      startOnboardingWatcher: jest.fn(), clearOnboardingWatcher: jest.fn(),
      clearLiveCalls: jest.fn(), closeInboundMedia: jest.fn(),
      attachDomainEvents: jest.fn(),
    } as unknown as WwebjsLifecycleHost;
    const lifecycle = new WwebjsLifecycle(host, manager, driver);
    const attempt = () => (
      lifecycle as unknown as {
        runInitAttempt(args: string[], authTimeout: undefined, proxy: undefined, versionPin: null): Promise<void>;
      }
    ).runInitAttempt(['--no-sandbox', '--al-hakim-session=forged', '--user-data-dir=/wrong'], undefined, undefined, null);
    return { lifecycle, host, manager, driver, release, attempt, calls };
  }

  it('uses injected executable, keeps the existing profile, and owns the lease markers', async () => {
    const fixture = makeFixture();
    await fixture.attempt();
    const options = fixture.lifecycle.client!.options.puppeteer!;
    expect(options.executablePath).toBe(process.execPath);
    expect(options.userDataDir).toBe(`/already-mounted/brave-profiles/${sessionId}`);
    expect(options.args).toEqual([
      '--no-sandbox', '--disable-gpu',
      `--al-hakim-session=${sessionId}`, '--al-hakim-lease=lease-generation-1',
    ]);
    expect(options.protocolTimeout).toBe(50_000);
    expect(fixture.calls).toEqual(['profile', 'lease', 'executable', 'verified', 'singleton']);
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('refuses to initialize when another process still owns the profile', async () => {
    const fixture = makeFixture({ conflicting: true });
    await expect(fixture.attempt()).rejects.toThrow('PROFILE_RECOVERY_UNSAFE');
    expect(fixture.manager.removeStaleSingletonFiles).not.toHaveBeenCalled();
    expect(initialize).not.toHaveBeenCalled();
  });

  it('fails closed when a driver tries to override profile or ownership markers', async () => {
    const fixture = makeFixture({ driverArgs: ['--al-hakim-lease=forged'] });
    await expect(fixture.attempt()).rejects.toThrow(/must not override/);
    expect(initialize).not.toHaveBeenCalled();
  });
});

describe('Phase 7 explicit executable path reaches the lifecycle driver', () => {
  it('does not discard the strict executable flag before resolving the binary', async () => {
    const driver: BrowserInterface = {
      type: 'brave',
      resolveExecutablePath: jest.fn(async () => process.execPath),
      getBrowserSpecificArgs: () => [],
      matchesExecutable: () => true,
    };
    const release = Object.assign(jest.fn(async () => undefined), { ownerToken: 'phase7-lease' });
    const manager = {
      getProfilePath: () => '/persisted/brave/phase7',
      ensureProfile: jest.fn(async () => undefined),
      acquireProfileLease: jest.fn(async () => release),
      assertNoConflictingBrowserProcesses: jest.fn(async () => undefined),
      removeStaleSingletonFiles: jest.fn(async () => undefined),
    } as unknown as BrowserProfileManager;
    const host = {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), event: jest.fn() },
      config: {
        sessionId: 'phase7', sessionDataPath: '/persisted/sessions',
        browser: { type: 'brave', executablePath: '/opt/brave', strictExecutablePath: true },
        puppeteer: { headless: true },
      },
      getCallbacks: () => ({}), emitState: jest.fn(),
      scheduleAuthReconcile: jest.fn(), clearAuthReconcile: jest.fn(),
      scheduleReadyReconcile: jest.fn(), clearReadyReconcile: jest.fn(),
      startOnboardingWatcher: jest.fn(), clearOnboardingWatcher: jest.fn(),
      clearLiveCalls: jest.fn(), closeInboundMedia: jest.fn(), attachDomainEvents: jest.fn(),
    } as unknown as WwebjsLifecycleHost;
    const initialize = jest.spyOn(Client.prototype, 'initialize').mockResolvedValue(undefined);
    try {
      const lifecycle = new WwebjsLifecycle(host, manager, driver);
      await (lifecycle as unknown as {
        runInitAttempt(args: string[], authTimeout: undefined, proxy: undefined, versionPin: null): Promise<void>;
      }).runInitAttempt([], undefined, undefined, null);
      expect(driver.resolveExecutablePath).toHaveBeenCalledWith(expect.objectContaining({
        executablePath: '/opt/brave', strictExecutablePath: true,
      }));
    } finally {
      initialize.mockRestore();
    }
  });
});
