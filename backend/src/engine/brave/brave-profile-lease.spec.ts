import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { BraveProfileManager } from './brave-profile.manager';

describe('BraveProfileManager exclusive profile lease', () => {
  let root: string;
  let manager: BraveProfileManager;

  const lockDir = (id: string) => path.join(root, '.openwa-profile-locks', id);

  const setPidScan = (instance: BraveProfileManager, pids: number[] = []) => {
    (instance as unknown as { findSessionBravePids: jest.Mock }).findSessionBravePids =
      jest.fn().mockResolvedValue(pids);
  };

  const addAbandonedLease = async (id: string, overrides: Record<string, unknown> = {}) => {
    const dir = lockDir(id);
    await fs.mkdir(dir, { recursive: true });
    const record = {
      token: randomUUID(),
      pid: 99999999, // not a real process on the test host
      host: os.hostname(),
      acquiredAt: '2026-11-18T12:00:37.541Z',
      ...overrides,
    };
    await fs.writeFile(path.join(dir, 'owner.json'), JSON.stringify(record));
    return record;
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'openwa-profile-lease-'));
    manager = new BraveProfileManager(root);
    setPidScan(manager);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('grants one owner, rejects a live competitor and allows reacquire only after release', async () => {
    const release = await manager.acquireProfileLease('one-session');
    const competitor = new BraveProfileManager(root);
    setPidScan(competitor);
    await expect(competitor.acquireProfileLease('one-session')).rejects.toThrow(/locked by another owner/);
    await expect(manager.assertProfileUnlocked('one-session')).rejects.toThrow(/ownership lock/);
    await release();
    await expect(manager.assertProfileUnlocked('one-session')).resolves.toBeUndefined();
    const releaseAgain = await competitor.acquireProfileLease('one-session');
    await releaseAgain();
  });

  it('never releases the profile lock if a browser PID still exists', async () => {
    const release = await manager.acquireProfileLease('session-1');
    (manager as unknown as { findSessionBravePids: jest.Mock }).findSessionBravePids.mockResolvedValueOnce([111]);
    await expect(release()).rejects.toThrow(/still live/);
    await expect(manager.acquireProfileLease('session-1')).rejects.toThrow(/locked/);
    await release();
  });

  it('automatically recovers a verified abandoned LOCAL lease without deleting its browser profile', async () => {
    const profile = manager.getProfilePath('abandoned');
    await fs.mkdir(profile);
    await fs.writeFile(path.join(profile, 'keep-auth.txt'), 'preserve this');
    const old = await addAbandonedLease('abandoned');
    const release = await manager.acquireProfileLease('abandoned');
    const current = JSON.parse(await fs.readFile(path.join(lockDir('abandoned'), 'owner.json'), 'utf8'));
    expect(current.token).not.toEqual(old.token);
    expect(current.pid).toEqual(process.pid);
    expect(await fs.readFile(path.join(profile, 'keep-auth.txt'), 'utf8')).toEqual('preserve this');
    await release();
  });

  it('rejects an abandoned lock while any marked Brave process is still alive', async () => {
    await addAbandonedLease('browser-survives');
    setPidScan(manager, [2345]);
    await expect(manager.acquireProfileLease('browser-survives')).rejects.toThrow(/BROWSER_ORPHAN_RECOVERY_UNSAFE/);
    expect(await fs.stat(lockDir('browser-survives'))).toBeDefined();
  });

  it('rejects remote-host locks even when the recorded PID is absent locally', async () => {
    await addAbandonedLease('remote', { host: 'ANOTHER-HOST' });
    await expect(manager.acquireProfileLease('remote')).rejects.toThrow(/locked by another owner/);
  });

  it('rejects a live-PID lock (including a PID that might have been reused)', async () => {
    await addAbandonedLease('live-pid', { pid: process.pid });
    await expect(manager.acquireProfileLease('live-pid')).rejects.toThrow(/locked by another owner/);
  });

  it('rejects missing, malformed or partial owner metadata', async () => {
    await fs.mkdir(lockDir('no-owner'), { recursive: true });
    await expect(manager.acquireProfileLease('no-owner')).rejects.toThrow(/locked by another owner/);
    await addAbandonedLease('bad-owner', { pid: 'not-a-pid' });
    await expect(manager.acquireProfileLease('bad-owner')).rejects.toThrow(/locked by another owner/);
  });

  it('fails closed when process enumeration throws', async () => {
    await addAbandonedLease('enum-failure');
    (manager as unknown as { findSessionBravePids: jest.Mock }).findSessionBravePids =
      jest.fn().mockRejectedValue(new Error('process inspection unavailable'));
    await expect(manager.acquireProfileLease('enum-failure')).rejects.toThrow(/process inspection unavailable/);
    expect(await fs.stat(lockDir('enum-failure'))).toBeDefined();
  });

  it('does not auto-steal an abandoned recovery claim of uncertain ownership', async () => {
    await addAbandonedLease('recovering');
    await fs.mkdir(path.join(lockDir('recovering'), '.recovery-claim'));
    await expect(manager.acquireProfileLease('recovering')).rejects.toThrow(/locked by another owner/);
  });

  it('only allows one winner when concurrent backends recover the same abandoned lock', async () => {
    await addAbandonedLease('race');
    const second = new BraveProfileManager(root);
    setPidScan(second);
    const results = await Promise.allSettled([
      manager.acquireProfileLease('race'),
      second.acquireProfileLease('race'),
    ]);
    const winners = results.filter((result) => result.status === 'fulfilled');
    const losers = results.filter((result) => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    if (winners[0].status === 'fulfilled') await winners[0].value();
  });

  it('keeps separate locks for different session names', async () => {
    const first = await manager.acquireProfileLease('session-a');
    const second = await manager.acquireProfileLease('session-b');
    await expect(fs.stat(lockDir('session-a'))).resolves.toBeDefined();
    await expect(fs.stat(lockDir('session-b'))).resolves.toBeDefined();
    await first();
    await second();
  });

  it('refuses to kill a merely matching process during normal startup', async () => {
    setPidScan(manager, [4321]);
    const logger = { warn: jest.fn(), log: jest.fn() };
    await expect(manager.killOrphanedBraveProcesses('account1', logger as never)).rejects.toThrow(/does not prove/);
  });

  it('rejects unsafe filesystem keys even when not passed through REST validation', () => {
    expect(() => manager.getProfilePath('../escape')).toThrow(/Unsafe/);
    expect(() => manager.getProfilePath('foo/bar')).toThrow(/Unsafe/);
    expect(() => manager.getProfilePath('valid-name')).not.toThrow();
  });
});
