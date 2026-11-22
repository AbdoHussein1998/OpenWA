import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { BrowserProfileManager } from './browser-profile.manager';
import { boundedBrowserOperation, BrowserTeardownTimeoutError } from './browser-teardown';

/** Offline Phase 8 tests use a disposable profile root and mocked process enumeration. */
describe('Phase 8: per-session browser lock and deadlock acceptance', () => {
  let base: string;
  let manager: BrowserProfileManager;

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-phase8-'));
    manager = new BrowserProfileManager(base);
    (manager as unknown as { findSessionBravePids: () => Promise<number[]> }).findSessionBravePids =
      async () => [];
    (manager as unknown as { inspectAllProcessRecords: () => Promise<unknown[]> }).inspectAllProcessRecords =
      async () => [];
  });
  afterEach(async () => { await fs.rm(base, { recursive: true, force: true }); });

  it('Session A holding its lock does not block Session B from acquiring/releasing its own lock', async () => {
    const a = await manager.acquireProfileLease('account-a');
    const b = await manager.acquireProfileLease('account-b');
    try {
      await expect(manager.assertProfileUnlocked('account-a')).rejects.toThrow(/ownership lock/);
      await b();
      await expect(manager.assertProfileUnlocked('account-b')).resolves.toBeUndefined();
    } finally {
      await a();
    }
  });

  it('two managers cannot simultaneously own one session profile', async () => {
    const second = new BrowserProfileManager(base);
    const firstRelease = await manager.acquireProfileLease('account-a');
    try {
      await expect(second.acquireProfileLease('account-a')).rejects.toThrow(/locked by another owner/);
    } finally {
      await firstRelease();
    }
    const nextRelease = await second.acquireProfileLease('account-a');
    await nextRelease();
  });

  it('unknown browser process using the profile retains the lock and refuses unsafe release', async () => {
    const release = await manager.acquireProfileLease('account-a');
    const profile = manager.getProfilePath('account-a');
    (manager as unknown as { inspectAllProcessRecords: () => Promise<unknown[]> }).inspectAllProcessRecords =
      async () => [{ pid: 88444, parentPid: 1, commandLine: `/usr/bin/chrome --user-data-dir=${profile}` }];
    await expect(release()).rejects.toThrow(/BROWSER_PROFILE_IN_USE/);
    await expect(manager.assertProfileUnlocked('account-a')).rejects.toThrow(/ownership lock/);
    (manager as unknown as { inspectAllProcessRecords: () => Promise<unknown[]> }).inspectAllProcessRecords =
      async () => [];
    await release();
  });

  it('a rejected process scan must never authorize lease release', async () => {
    const release = await manager.acquireProfileLease('account-a');
    (manager as unknown as { findSessionBravePids: () => Promise<number[]> }).findSessionBravePids =
      async () => { throw Error('OS process enumeration timed out'); };
    await expect(release()).rejects.toThrow(/enumeration timed out/);
    await expect(manager.assertProfileUnlocked('account-a')).rejects.toThrow(/ownership lock/);
    (manager as unknown as { findSessionBravePids: () => Promise<number[]> }).findSessionBravePids =
      async () => [];
    await release();
  });

  it('a hung teardown is bounded; its underlying promise is not mistaken for successful termination', async () => {
    jest.useFakeTimers();
    try {
      const pending = boundedBrowserOperation(
        () => new Promise<void>(() => undefined),
        100,
        'hung CDP destroy',
      );
      const rejection = expect(pending).rejects.toBeInstanceOf(BrowserTeardownTimeoutError);
      await jest.advanceTimersByTimeAsync(100);
      await rejection;
    } finally {
      jest.useRealTimers();
    }
  });
});
