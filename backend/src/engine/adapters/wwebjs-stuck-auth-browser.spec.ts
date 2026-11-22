import { EventEmitter } from 'node:events';
import type { Client } from 'whatsapp-web.js';
import { EngineStatus, type EngineEventCallbacks } from '../interfaces/whatsapp-engine.interface';
import type { BrowserProfileManager } from '../browser/browser-profile.manager';
import { WwebjsStuckAuth, type WwebjsStuckAuthHost } from './wwebjs-stuck-auth';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function harness() {
  const operations: string[] = [];
  const manager = {
    getProfilePath: jest.fn((sessionId: string) => `/profiles/${sessionId}`),
    assertNoConflictingBrowserProcesses: jest.fn(async () => { operations.push('verify'); }),
    killOrphanedBraveProcesses: jest.fn(async () => { throw new Error('legacy verifier must not run'); }),
    deleteProfile: jest.fn(async () => { operations.push('delete'); }),
  } as unknown as BrowserProfileManager;
  const client = Object.assign(new EventEmitter(), {
    destroy: jest.fn(async () => { operations.push('destroy'); }),
  }) as unknown as Client;
  let live: Client | null = client;
  let tracked: Promise<void> | undefined;
  const onDisconnected = jest.fn(() => { operations.push('disconnected'); });
  const onError = jest.fn();
  const callbacks: EngineEventCallbacks = {
    claimStuckAuthRecovery: () => true,
    onCredentialTeardownStarted: op => { tracked = op; void op.catch(() => undefined); operations.push('tracked'); },
    onDisconnected,
    onError,
  };
  const statuses: EngineStatus[] = [];
  const logger = { warn: jest.fn(), error: jest.fn() };
  const host = {
    config: { sessionId: 'account-a', sessionDataPath: '/sessions', browserProfileManager: manager },
    logger,
    getClient: () => live,
    setClient: (next: Client | null) => { live = next; },
    setStatus: (value: EngineStatus) => { statuses.push(value); },
    getCallbacks: () => callbacks,
  } as unknown as WwebjsStuckAuthHost;
  return {
    operations, manager, client, host, callbacks, statuses, logger, onDisconnected, onError,
    get live() { return live; },
    get tracked() { return tracked; },
  };
}

describe('Phase 6: browser-neutral stuck-auth profile reset', () => {
  it('uses neutral process verification, deletes one profile, and reports readiness for re-pairing', async () => {
    const h = harness();
    const recovering = new WwebjsStuckAuth(h.host).recoverFromStuckAuth();
    expect(h.live).toBeNull();
    expect(h.tracked).toBeDefined();
    await recovering;
    await h.tracked;
    expect(h.operations).toEqual(['tracked', 'destroy', 'verify', 'delete', 'disconnected']);
    expect(h.manager.assertNoConflictingBrowserProcesses).toHaveBeenCalledWith('account-a', h.logger);
    expect(h.manager.killOrphanedBraveProcesses).not.toHaveBeenCalled();
    expect(h.manager.deleteProfile).toHaveBeenCalledWith('account-a');
    expect(h.statuses).toContain(EngineStatus.DISCONNECTED);
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('/profiles/account-a'),
      expect.objectContaining({ sessionId: 'account-a', eventType: 'engine.browser.auth_cleared' }),
    );
  });

  it('retains the lease and prevents deletion when the lifecycle cannot stop the browser', async () => {
    const h = harness();
    const stop = jest.fn().mockRejectedValue(new Error('browser still running'));
    const complete = jest.fn();
    Object.assign(h.host, {
      beginProfileReset: jest.fn(), stopClientForProfileReset: stop, completeProfileReset: complete,
    });
    await new WwebjsStuckAuth(h.host).recoverFromStuckAuth();
    expect(h.manager.deleteProfile).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(h.onDisconnected).not.toHaveBeenCalled();
    expect(h.statuses).toContain(EngineStatus.FAILED);
    expect(h.onError).toHaveBeenCalledWith(expect.stringContaining('could not safely reset'));
  });

  it('keeps the reset fenced while teardown and profile deletion are pending; releases last', async () => {
    const h = harness();
    const pendingStop = deferred();
    const pendingDelete = deferred();
    (h.manager.deleteProfile as jest.Mock).mockImplementation(async () => {
      h.operations.push('delete-start');
      await pendingDelete.promise;
      h.operations.push('delete-finished');
    });
    Object.assign(h.host, {
      beginProfileReset: () => { h.operations.push('begin'); },
      stopClientForProfileReset: async () => { h.operations.push('stop-start'); await pendingStop.promise; h.operations.push('stop-finished'); },
      completeProfileReset: async () => { h.operations.push('lease-released'); },
    });
    const recovering = new WwebjsStuckAuth(h.host).recoverFromStuckAuth();
    expect(h.live).toBeNull();
    expect(h.tracked).toBeDefined();
    expect(h.operations).toEqual(['begin', 'stop-start', 'tracked']);
    expect(h.manager.deleteProfile).not.toHaveBeenCalled();
    pendingStop.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.manager.deleteProfile).toHaveBeenCalledTimes(1);
    expect(h.operations).not.toContain('lease-released');
    pendingDelete.resolve();
    await recovering;
    await h.tracked;
    expect(h.operations.indexOf('lease-released')).toBeGreaterThan(h.operations.indexOf('delete-finished'));
    expect(h.operations.indexOf('disconnected')).toBeGreaterThan(h.operations.indexOf('lease-released'));
  });

  it('does not release the lease or reconnect after profile deletion fails', async () => {
    const h = harness();
    (h.manager.deleteProfile as jest.Mock).mockRejectedValue(new Error('EIO disk error'));
    const complete = jest.fn();
    Object.assign(h.host, { stopClientForProfileReset: jest.fn().mockResolvedValue(undefined), completeProfileReset: complete });
    await new WwebjsStuckAuth(h.host).recoverFromStuckAuth();
    expect(complete).not.toHaveBeenCalled();
    expect(h.onDisconnected).not.toHaveBeenCalled();
    expect(h.statuses).toContain(EngineStatus.FAILED);
  });

  it('rejects conflicting manager aliases rather than choosing an arbitrary profile root', async () => {
    const h = harness();
    h.host.config.braveProfileManager = {} as BrowserProfileManager;
    await new WwebjsStuckAuth(h.host).recoverFromStuckAuth();
    expect(h.manager.deleteProfile).not.toHaveBeenCalled();
    expect(h.onDisconnected).not.toHaveBeenCalled();
    expect(h.statuses).toContain(EngineStatus.FAILED);
  });

  it('retains the legacy public clearBraveProfile and clearLocalAuth aliases', async () => {
    const h = harness();
    const recovery = new WwebjsStuckAuth(h.host);
    await recovery.clearBraveProfile();
    await recovery.clearLocalAuth();
    expect(h.manager.deleteProfile).toHaveBeenCalledTimes(2);
  });

  it('will not perform a second destructive reset in one reconnect episode', async () => {
    const h = harness();
    h.callbacks.claimStuckAuthRecovery = undefined;
    const recovery = new WwebjsStuckAuth(h.host);
    await recovery.recoverFromStuckAuth();
    await recovery.recoverFromStuckAuth();
    expect(h.manager.deleteProfile).toHaveBeenCalledTimes(1);
    expect(h.statuses).toContain(EngineStatus.FAILED);
  });
});
