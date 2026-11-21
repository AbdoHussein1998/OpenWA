import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { BraveProfileManager, type BraveProcessRecord } from './brave-profile.manager';

/** Phase 4: crash recovery must never kill based on a session marker alone. */
describe('Phase 4: verified abandoned browser recovery', () => {
  let root: string;
  let manager: BraveProfileManager;
  let ownerToken: string;
  const session = 'account-a';
  const stalePid = 99999999;
  const lockDir = () => path.join(root, '.openwa-profile-locks', session);

  const records = (leaseToken: string, profile = manager.getProfilePath(session),
    markedSession = session): BraveProcessRecord[] => [
    { pid: 23456789, parentPid: 1, commandLine:
      `/usr/bin/brave --al-hakim-session=${markedSession} --al-hakim-lease=${leaseToken} --user-data-dir=${profile}` },
    { pid: 23456790, parentPid: 23456789, commandLine: '/usr/bin/brave --type=renderer' },
  ];

  const arrange = (processRecords: BraveProcessRecord[], onReap?: () => void) => {
    let alive = true;
    (manager as unknown as { findSessionBravePids: jest.Mock }).findSessionBravePids =
      jest.fn(async () => alive ? [23456789] : []);
    (manager as unknown as { inspectAllProcessRecords: jest.Mock }).inspectAllProcessRecords =
      jest.fn(async () => alive ? processRecords : []);
    (manager as unknown as { inspectProcessTree: jest.Mock }).inspectProcessTree =
      jest.fn(async () => alive ? processRecords : []);
    // Unit tests replace the OS-signal boundary; the implementation still runs
    // all claim, old-owner, root/profile and generation checks before calling it.
    (manager as unknown as { terminateVerifiedAbandonedTree: jest.Mock }).terminateVerifiedAbandonedTree =
      jest.fn(async () => { onReap?.(); alive = false; });
    return (manager as unknown as { terminateVerifiedAbandonedTree: jest.Mock }).terminateVerifiedAbandonedTree;
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'brave-phase4-'));
    manager = new BraveProfileManager(root);
    ownerToken = randomUUID();
    await fs.mkdir(lockDir(), { recursive: true });
    await fs.writeFile(path.join(lockDir(), 'owner.json'), JSON.stringify({
      token: ownerToken, pid: stalePid, host: os.hostname(), acquiredAt: '2026-11-18T12:00:37.541Z',
    }));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reaps only a browser labelled with the dead owners exact lease, then preserves the profile', async () => {
    const profile = manager.getProfilePath(session);
    await fs.mkdir(profile);
    await fs.writeFile(path.join(profile, 'whatsapp-credentials.txt'), 'preserved');
    const terminate = arrange(records(ownerToken));
    const newRelease = await manager.acquireProfileLease(session);
    expect(terminate).toHaveBeenCalledTimes(1);
    const after = JSON.parse(await fs.readFile(path.join(lockDir(), 'owner.json'), 'utf8'));
    expect(after.token).not.toEqual(ownerToken);
    expect(after.pid).toEqual(process.pid);
    expect(await fs.readFile(path.join(profile, 'whatsapp-credentials.txt'), 'utf8')).toEqual('preserved');
    await newRelease();
  });

  it('refuses to reap a pre-Phase-4 browser that has no lease generation marker', async () => {
    const old = records(ownerToken);
    old[0].commandLine = old[0].commandLine.replace(` --al-hakim-lease=${ownerToken}`, '');
    const terminate = arrange(old);
    await expect(manager.acquireProfileLease(session)).rejects.toThrow(/BROWSER_ORPHAN_RECOVERY_UNSAFE/);
    expect(terminate).not.toHaveBeenCalled();
    expect(await fs.stat(lockDir())).toBeDefined();
  });

  it('refuses to reap a browser launched with a different lease generation', async () => {
    const terminate = arrange(records(randomUUID()));
    await expect(manager.acquireProfileLease(session)).rejects.toThrow(/BROWSER_ORPHAN_RECOVERY_UNSAFE/);
    expect(terminate).not.toHaveBeenCalled();
    expect(await fs.stat(lockDir())).toBeDefined();
  });

  it('refuses a session-matching browser with a different user-data directory', async () => {
    const terminate = arrange(records(ownerToken, path.join(root, 'other-profile')));
    await expect(manager.acquireProfileLease(session)).rejects.toThrow(/BROWSER_ORPHAN_RECOVERY_UNSAFE/);
    expect(terminate).not.toHaveBeenCalled();
  });

  it('refuses a browser tree containing a different sessions child', async () => {
    const mixed = records(ownerToken);
    mixed[1].commandLine = '/usr/bin/brave --al-hakim-session=account-b --type=renderer';
    const terminate = arrange(mixed);
    await expect(manager.acquireProfileLease(session)).rejects.toThrow(/different session/);
    expect(terminate).not.toHaveBeenCalled();
  });

  it('does not unlock a profile used by an unmarked external Brave process', async () => {
    const profile = manager.getProfilePath(session);
    (manager as unknown as { findSessionBravePids: jest.Mock }).findSessionBravePids =
      jest.fn().mockResolvedValue([]);
    (manager as unknown as { inspectAllProcessRecords: jest.Mock }).inspectAllProcessRecords =
      jest.fn().mockResolvedValue([{ pid: 344444, parentPid: 1,
        commandLine: `/usr/bin/brave --user-data-dir=${profile}` }]);
    await expect(manager.acquireProfileLease(session)).rejects.toThrow(/still in use/);
    expect(await fs.stat(lockDir())).toBeDefined();
  });

  it('rejects a live old-owner PID even when a browser carries a matching token', async () => {
    const owner = JSON.parse(await fs.readFile(path.join(lockDir(), 'owner.json'), 'utf8'));
    owner.pid = process.pid;
    await fs.writeFile(path.join(lockDir(), 'owner.json'), JSON.stringify(owner));
    const terminate = arrange(records(ownerToken));
    await expect(manager.acquireProfileLease(session)).rejects.toThrow(/locked by another owner/);
    expect(terminate).not.toHaveBeenCalled();
  });

  it('refuses remote owners regardless of process markers', async () => {
    const owner = JSON.parse(await fs.readFile(path.join(lockDir(), 'owner.json'), 'utf8'));
    owner.host = 'some-other-machine';
    await fs.writeFile(path.join(lockDir(), 'owner.json'), JSON.stringify(owner));
    const terminate = arrange(records(ownerToken));
    await expect(manager.acquireProfileLease(session)).rejects.toThrow(/locked by another owner/);
    expect(terminate).not.toHaveBeenCalled();
  });

  it('serializes simultaneous orphan recovery across two backend managers', async () => {
    const second = new BraveProfileManager(root);
    let alive = true;
    let reaps = 0;
    for (const instance of [manager, second]) {
      (instance as unknown as { findSessionBravePids: jest.Mock }).findSessionBravePids =
        jest.fn(async () => alive ? [23456789] : []);
      (instance as unknown as { inspectAllProcessRecords: jest.Mock }).inspectAllProcessRecords =
        jest.fn(async () => alive ? records(ownerToken) : []);
      (instance as unknown as { terminateVerifiedAbandonedTree: jest.Mock }).terminateVerifiedAbandonedTree =
        jest.fn(async () => { reaps++; alive = false; });
    }
    const result = await Promise.allSettled([
      manager.acquireProfileLease(session),
      second.acquireProfileLease(session),
    ]);
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter(item => item.status === 'rejected')).toHaveLength(1);
    expect(reaps).toEqual(1);
    const winner = result.find(item => item.status === 'fulfilled');
    if (winner?.status === 'fulfilled') await winner.value();
  });

  it('retains ownership if process inventory fails', async () => {
    const terminate = arrange(records(ownerToken));
    (manager as unknown as { inspectAllProcessRecords: jest.Mock }).inspectAllProcessRecords =
      jest.fn().mockRejectedValue(new Error('CIM unavailable'));
    await expect(manager.acquireProfileLease(session)).rejects.toThrow(/CIM unavailable/);
    expect(terminate).not.toHaveBeenCalled();
    expect(await fs.stat(lockDir())).toBeDefined();
  });

  it('does not release a lock when the recovered process survives termination', async () => {
    arrange(records(ownerToken));
    (manager as unknown as { findSessionBravePids: jest.Mock }).findSessionBravePids =
      jest.fn().mockResolvedValue([23456789]);
    await expect(manager.acquireProfileLease(session)).rejects.toThrow(/survived termination/);
    expect(await fs.stat(lockDir())).toBeDefined();
  });
});
