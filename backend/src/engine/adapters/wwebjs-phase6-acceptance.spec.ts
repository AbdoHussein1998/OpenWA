import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Client } from 'whatsapp-web.js';
import { BraveProfileManager, type BraveProfileLeaseRelease } from '../brave/brave-profile.manager';
import { WwebjsLifecycle, type WwebjsLifecycleHost } from './wwebjs-lifecycle';

/**
 * Phase 6: real filesystem leases + real WwebjsLifecycle teardown, with a fake
 * WhatsApp Client and mocked OS process inventory. Never launches or kills Brave.
 */
describe('Phase 6 — lifecycle / filesystem lock integration', () => {
  let root: string;
  let manager: BraveProfileManager;
  let browserAlive = false;
  let targetSession = '';
  let terminate: jest.Mock;

  const lockPath = (session: string) => path.join(root, '.openwa-profile-locks', session);

  function makeLifecycle(
    session: string,
    release: BraveProfileLeaseRelease,
    destroy: () => Promise<void> = async () => undefined,
    pid = 900001,
  ) {
    const logger = { event: jest.fn(), warn: jest.fn(), log: jest.fn(), error: jest.fn() };
    const host = {
      logger, config: { sessionId: session }, getCallbacks: () => ({}),
      emitState: jest.fn(), clearLiveCalls: jest.fn(), closeInboundMedia: jest.fn(),
      clearAuthReconcile: jest.fn(), clearReadyReconcile: jest.fn(),
      clearOnboardingWatcher: jest.fn(),
    } as unknown as WwebjsLifecycleHost;
    const lifecycle = new WwebjsLifecycle(host, manager);
    const client = Object.assign(new EventEmitter(), {
      destroy: jest.fn(destroy),
      pupBrowser: { process: () => ({ pid }) },
    }) as unknown as Client;
    lifecycle.client = client;
    (lifecycle as unknown as { profileLeaseRelease: BraveProfileLeaseRelease }).profileLeaseRelease = release;
    return { lifecycle, client, logger };
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'alhakim-phase6-teardown-'));
    manager = new BraveProfileManager(root);
    browserAlive = false;
    targetSession = '';
    (manager as unknown as { findSessionBravePids: (session: string) => Promise<number[]> })
      .findSessionBravePids = jest.fn(async (session: string) =>
        browserAlive && session === targetSession ? [900001] : []);
    terminate = jest.fn(async () => { browserAlive = false; });
    (manager as unknown as { terminateOwnedBrowserTree: typeof terminate })
      .terminateOwnedBrowserTree = terminate;
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('stops A, releases only A filesystem lock, and leaves B live and authenticated', async () => {
    const releaseA = await manager.acquireProfileLease('account-a');
    const releaseB = await manager.acquireProfileLease('account-b');
    await manager.ensureProfile('account-a');
    await manager.ensureProfile('account-b');
    await fs.writeFile(path.join(manager.getProfilePath('account-b'), 'auth-canary'), 'B');
    const a = makeLifecycle('account-a', releaseA);
    const b = makeLifecycle('account-b', releaseB);

    await a.lifecycle.disconnect();
    await expect(manager.assertProfileUnlocked('account-a')).resolves.toBeUndefined();
    await expect(fs.stat(lockPath('account-b'))).resolves.toBeDefined();
    expect(b.lifecycle.client).toBe(b.client);
    expect(await fs.readFile(path.join(manager.getProfilePath('account-b'), 'auth-canary'), 'utf8')).toBe('B');
    expect(terminate).not.toHaveBeenCalled();

    await b.lifecycle.disconnect();
    await expect(manager.assertProfileUnlocked('account-b')).resolves.toBeUndefined();
  });

  it('escalates a CDP failure for A, then releases A only after verified termination', async () => {
    const release = await manager.acquireProfileLease('account-a');
    targetSession = 'account-a';
    browserAlive = true;
    const a = makeLifecycle('account-a', release, async () => {
      throw new Error('CDP socket closed');
    });
    await a.lifecycle.disconnect();
    expect(terminate).toHaveBeenCalledWith('account-a', 900001, expect.anything(), release.ownerToken);
    await expect(manager.assertProfileUnlocked('account-a')).resolves.toBeUndefined();
    expect(a.lifecycle.client).toBeNull();
  });

  it('retains lock and client on unsafe termination, then succeeds on a force retry', async () => {
    const release = await manager.acquireProfileLease('account-a');
    targetSession = 'account-a';
    browserAlive = true;
    let terminateSafe = false;
    terminate.mockImplementation(async () => {
      if (!terminateSafe) throw new Error('OS refused termination');
      browserAlive = false;
    });
    const a = makeLifecycle('account-a', release, async () => {
      throw new Error('CDP socket closed');
    });
    await expect(a.lifecycle.disconnect()).rejects.toThrow(/BROWSER_TEARDOWN_INCOMPLETE/);
    expect(a.lifecycle.client).toBe(a.client);
    await expect(manager.assertProfileUnlocked('account-a')).rejects.toThrow(/ownership lock/);
    terminateSafe = true;
    await a.lifecycle.forceDestroy();
    await expect(manager.assertProfileUnlocked('account-a')).resolves.toBeUndefined();
    expect(a.lifecycle.client).toBeNull();
  });

  it('does not release a lock while stuck-auth profile reset is in progress', async () => {
    const release = await manager.acquireProfileLease('account-a');
    const a = makeLifecycle('account-a', release);
    a.lifecycle.beginProfileReset();
    a.lifecycle.client = null;
    await expect(a.lifecycle.forceDestroy()).rejects.toThrow(/BROWSER_PROFILE_RESET_IN_PROGRESS/);
    await expect(manager.assertProfileUnlocked('account-a')).rejects.toThrow(/ownership lock/);
    await a.lifecycle.completeProfileReset();
    await expect(manager.assertProfileUnlocked('account-a')).resolves.toBeUndefined();
  });
});
