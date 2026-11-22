import { EventEmitter } from 'events';
import type { Client } from 'whatsapp-web.js';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import type { BraveProfileLeaseRelease } from '../brave/brave-profile.manager';
import { BraveTeardownTimeoutError, boundedBrowserOperation } from '../brave/brave-browser-teardown';
import { WwebjsLifecycle, type WwebjsLifecycleHost } from './wwebjs-lifecycle';
import type { BraveProfileManager } from '../brave/brave-profile.manager';

function createFixture(options: { destroy?: () => Promise<void>; pid?: number | null; release?: () => Promise<void> } = {}) {
  const ordered: string[] = [];
  const terminateOwnedBrowserTree = jest.fn(async () => { ordered.push('terminate'); });
  const manager = {
    terminateOwnedBrowserTree,
    killOrphanedBraveProcesses: jest.fn(async () => undefined),
    assertNoConflictingBrowserProcesses: jest.fn(async () => undefined),
  } as unknown as BraveProfileManager;
  const release = jest.fn(async () => { ordered.push('release'); await options.release?.(); });
  const host = {
    logger: { event: jest.fn(), warn: jest.fn(), log: jest.fn() },
    config: { sessionId: 'session-a' },
    getCallbacks: () => ({}), emitState: jest.fn(),
    clearLiveCalls: jest.fn(), closeInboundMedia: jest.fn(),
    clearAuthReconcile: jest.fn(), clearReadyReconcile: jest.fn(),
    clearOnboardingWatcher: jest.fn(),
  } as unknown as WwebjsLifecycleHost;
  const lifecycle = new WwebjsLifecycle(host, manager);
  const destroy = jest.fn(options.destroy ?? (async () => undefined));
  const client = Object.assign(new EventEmitter(), {
    destroy,
    pupBrowser: { process: () => options.pid === null ? null : { pid: options.pid ?? 1234 } },
  }) as unknown as Client;
  lifecycle.client = client;
  const owner = Object.assign(release, { ownerToken: 'owner-a' }) as BraveProfileLeaseRelease;
  (lifecycle as unknown as { profileLeaseRelease: BraveProfileLeaseRelease }).profileLeaseRelease = owner;
  return { lifecycle, manager, host, client, destroy, release, ordered, terminateOwnedBrowserTree };
}

describe('Phase 3: Brave teardown and profile ownership', () => {
  it('Phase 5: emits structured teardown duration and success outcome', async () => {
    const { lifecycle, host } = createFixture();
    await lifecycle.disconnect();
    const events = (host.logger.event as jest.Mock).mock.calls;
    const started = events.find(args => args[1] === 'engine.browser.teardown_started');
    const completed = events.find(args => args[1] === 'engine.browser.teardown_succeeded');
    expect(started?.[4]).toMatchObject({ sessionId: 'session-a', status: 'started' });
    expect(completed?.[4]).toMatchObject({
      sessionId: 'session-a', status: 'succeeded', forced: false,
      elapsedMs: expect.any(Number),
    });
  });

  it('Phase 5: emits a stable failure reason and retains the client on unsafe cleanup', async () => {
    const { lifecycle, host, client } = createFixture({
      release: async () => { throw new Error('browser still live'); },
    });
    await expect(lifecycle.disconnect()).rejects.toThrow(/BROWSER_TEARDOWN_INCOMPLETE/);
    const events = (host.logger.event as jest.Mock).mock.calls;
    const failure = events.find(args => args[1] === 'engine.browser.teardown_failed');
    expect(failure?.[4]).toMatchObject({
      sessionId: 'session-a', status: 'failed', reasonCode: 'BROWSER_TEARDOWN_INCOMPLETE',
      elapsedMs: expect.any(Number),
    });
    expect(lifecycle.client).toBe(client);
  });

  it('gracefully closes and verifies lock release before reporting a clean disconnect', async () => {
    const { lifecycle, release, terminateOwnedBrowserTree } = createFixture();
    await lifecycle.disconnect();
    expect(release).toHaveBeenCalledTimes(1);
    expect(terminateOwnedBrowserTree).not.toHaveBeenCalled();
    expect(lifecycle.client).toBeNull();
    expect(lifecycle.status).toBe(EngineStatus.DISCONNECTED);
  });

  it('escalates a failed CDP destroy to the exact captured session PID before releasing the lease', async () => {
    const { lifecycle, ordered, terminateOwnedBrowserTree } = createFixture({
      destroy: async () => { throw new Error('CDP session closed'); }, pid: 5678,
    });
    await lifecycle.disconnect();
    expect(terminateOwnedBrowserTree).toHaveBeenCalledWith('session-a', 5678, expect.anything(), 'owner-a');
    expect(ordered).toEqual(['terminate', 'release']);
  });

  it('propagates failure and retains the captured client when lease release is unsafe', async () => {
    const { lifecycle, client, release } = createFixture({
      release: async () => { throw new Error('browser PID still alive'); },
    });
    await expect(lifecycle.destroy()).rejects.toThrow(/BROWSER_TEARDOWN_INCOMPLETE/);
    expect(release).toHaveBeenCalledTimes(1);
    expect(lifecycle.client).toBe(client);
  });

  it('forceDestroy can retry after graceful teardown failed without losing the captured PID', async () => {
    let failRelease = true;
    const { lifecycle, terminateOwnedBrowserTree } = createFixture({
      release: async () => { if (failRelease) throw new Error('browser alive'); },
    });
    await expect(lifecycle.disconnect()).rejects.toThrow(/BROWSER_TEARDOWN_INCOMPLETE/);
    failRelease = false;
    await lifecycle.forceDestroy();
    expect(terminateOwnedBrowserTree).toHaveBeenCalledWith('session-a', 1234, expect.anything(), 'owner-a');
    expect(lifecycle.client).toBeNull();
  });

  it('does not delete or unlock an in-use profile before stuck-auth reset finishes', async () => {
    const { lifecycle, client, release } = createFixture();
    await lifecycle.stopClientForProfileReset(client);
    expect(release).not.toHaveBeenCalled();
    await lifecycle.completeProfileReset();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('concurrent forceDestroy cannot unlock a profile during an active stuck-auth reset', async () => {
    const { lifecycle, release } = createFixture();
    const client = lifecycle.client!;
    lifecycle.beginProfileReset();
    lifecycle.client = null; // same early detach as WwebjsStuckAuth
    await expect(lifecycle.forceDestroy()).rejects.toThrow(/BROWSER_PROFILE_RESET_IN_PROGRESS/);
    expect(release).not.toHaveBeenCalled();
    await lifecycle.stopClientForProfileReset(client);
    await lifecycle.completeProfileReset();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('only verifies the current session during forced teardown', async () => {
    const a = createFixture({ pid: 333 });
    const b = createFixture({ pid: 444 });
    await a.lifecycle.forceDestroy();
    expect(a.terminateOwnedBrowserTree).toHaveBeenCalledWith('session-a', 333, expect.anything(), 'owner-a');
    expect(b.terminateOwnedBrowserTree).not.toHaveBeenCalled();
    expect(b.lifecycle.client).not.toBeNull();
  });

  it('bounds an unresponsive operation and consumes its late rejection', async () => {
    jest.useFakeTimers();
    try {
      const pending = boundedBrowserOperation(() => new Promise<void>(() => undefined), 50, 'hanging CDP');
      const result = expect(pending).rejects.toBeInstanceOf(BraveTeardownTimeoutError);
      await jest.advanceTimersByTimeAsync(50);
      await result;
    } finally {
      jest.useRealTimers();
    }
  });
});
