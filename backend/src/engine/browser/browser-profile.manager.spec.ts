import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { BrowserProfileManager } from './browser-profile.manager';
import { BraveProfileManager } from '../brave/brave-profile.manager';

/** Uses an isolated temporary root; never touches real WhatsApp browser profiles. */
describe('BrowserProfileManager migration (phase 2)', () => {
  let root: string;
  let manager: BrowserProfileManager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'alhakim-phase2-browser-'));
    manager = new BrowserProfileManager(root);
    (manager as unknown as { findSessionBravePids: () => Promise<number[]> }).findSessionBravePids =
      async () => [];
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('preserves existing profile path, lock layout, and lease metadata', async () => {
    expect(manager.getProfilePath('account-a')).toEqual(path.resolve(root, 'account-a'));
    const release = await manager.acquireProfileLease('account-a');
    const owner = JSON.parse(await fs.readFile(
      path.join(root, '.openwa-profile-locks', 'account-a', 'owner.json'), 'utf8',
    )) as {token: string; pid: number; host: string};
    expect(owner.token).toBe(release.ownerToken);
    expect(owner.pid).toBe(process.pid);
    expect(owner.host).toBe(os.hostname());
    await release();
    await expect(manager.assertProfileUnlocked('account-a')).resolves.toBeUndefined();
  });

  it('preserves old construction path and shares the same implementation', () => {
    const legacy = new BraveProfileManager(root);
    expect(legacy).toBeInstanceOf(BrowserProfileManager);
    expect(legacy.getProfilePath('account-a')).toEqual(manager.getProfilePath('account-a'));
  });

  it('does not block an independent session when another lease is held', async () => {
    const releaseA = await manager.acquireProfileLease('account-a');
    const releaseB = await manager.acquireProfileLease('account-b');
    await expect(manager.assertProfileUnlocked('account-a')).rejects.toThrow(/ownership lock/);
    await releaseB();
    await expect(manager.assertProfileUnlocked('account-b')).resolves.toBeUndefined();
    await releaseA();
  });

  it('refuses marker-only termination even when legacy allowOwnedRecovery=true', async () => {
    (manager as unknown as { findSessionBravePids: () => Promise<number[]> }).findSessionBravePids =
      async () => [4321];
    const logger = {warn: jest.fn(), log: jest.fn()};
    await expect(manager.killOrphanedBraveProcesses('account-a', logger as never, true))
      .rejects.toThrow(/BROWSER_ORPHAN_RECOVERY_UNSAFE/);
  });

  it('refuses lease release and singleton cleanup when an unmarked browser owns the profile', async () => {
    const session = 'unmarked';
    const release = await manager.acquireProfileLease(session);
    const profile = manager.getProfilePath(session);
    (manager as unknown as {inspectAllProcessRecords: () => Promise<unknown[]>}).inspectAllProcessRecords =
      async () => [{pid: 71201, parentPid: 1, commandLine: `/usr/bin/chrome --user-data-dir=${profile}`}];
    await expect(release()).rejects.toThrow(/BROWSER_PROFILE_IN_USE/);
    await expect(manager.assertProfileUnlocked(session)).rejects.toThrow(/ownership lock/);
    await expect(manager.assertNoConflictingBrowserProcesses(session, {warn: jest.fn(), log: jest.fn()} as never))
      .rejects.toThrow(/BROWSER_PROFILE_IN_USE/);
    (manager as unknown as {inspectAllProcessRecords: () => Promise<unknown[]>}).inspectAllProcessRecords =
      async () => [];
    await release();
  });

  it('fails closed on process-scan errors when releasing the lease', async () => {
    const release = await manager.acquireProfileLease('account-a');
    (manager as unknown as { findSessionBravePids: () => Promise<number[]> }).findSessionBravePids =
      async () => { throw new Error('process enumeration unavailable'); };
    await expect(release()).rejects.toThrow(/process enumeration unavailable/);
    await expect(manager.assertProfileUnlocked('account-a')).rejects.toThrow(/ownership lock/);
    (manager as unknown as { findSessionBravePids: () => Promise<number[]> }).findSessionBravePids = async () => [];
    await release();
  });
});
