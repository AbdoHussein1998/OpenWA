import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BraveProfileManager,
  isSessionOwnedBraveRoot,
  type BraveProcessRecord,
} from './brave-profile.manager';

/**
 * Phase 6: filesystem-level acceptance tests across the Phase 1–5 ownership flows.
 * These tests operate ONLY on freshly allocated OS-temp directories. No real Brave
 * processes, real WhatsApp credentials, or existing user-data directories are touched.
 */
describe('Phase 6 — browser profile ownership acceptance', () => {
  let base: string;
  let manager: BraveProfileManager;
  const leaseDir = (name: string) => path.join(base, '.openwa-profile-locks', name);
  const ownerFile = (name: string) => path.join(leaseDir(name), 'owner.json');
  const readOwner = async (name: string): Promise<{ token: string; pid: number; host: string }> =>
    JSON.parse(await fs.readFile(ownerFile(name), 'utf8')) as {
      token: string; pid: number; host: string;
    };

  // The OS process-enumeration boundary is stubbed, not the lock implementation.
  function setInventory(
    instance: BraveProfileManager,
    pids: (session: string) => number[] = () => [],
    records: () => BraveProcessRecord[] = () => [],
  ): void {
    const target = instance as unknown as {
      findSessionBravePids: (session: string) => Promise<number[]>;
      inspectAllProcessRecords: () => Promise<BraveProcessRecord[]>;
    };
    target.findSessionBravePids = jest.fn(async (session: string) => pids(session));
    target.inspectAllProcessRecords = jest.fn(async () => records());
  }

  async function abandoned(name: string, overrides: Record<string, unknown> = {}) {
    await fs.mkdir(leaseDir(name), { recursive: true });
    const previous = {
      token: randomUUID(), pid: 99999999, host: os.hostname(),
      acquiredAt: new Date().toISOString(), ...overrides,
    };
    await fs.writeFile(ownerFile(name), JSON.stringify(previous), { flag: 'wx' });
    return previous;
  }

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'alhakim-phase6-'));
    manager = new BraveProfileManager(base);
    setInventory(manager);
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('runs ten independent sessions with ten distinct profiles, leases and preserved data', async () => {
    const names = Array.from({ length: 10 }, (_, i) => `whatsapp-${i + 1}`);
    const profiles = names.map(name => manager.getProfilePath(name));
    expect(new Set(profiles).size).toBe(10);
    const releases = await Promise.all(names.map(name => manager.acquireProfileLease(name)));
    const tokens = await Promise.all(names.map(async name => (await readOwner(name)).token));
    expect(new Set(tokens).size).toBe(10);

    for (const name of names) {
      await manager.ensureProfile(name);
      await fs.writeFile(path.join(manager.getProfilePath(name), 'auth-canary'), name);
    }
    await releases[0]();
    await expect(manager.assertProfileUnlocked(names[0])).resolves.toBeUndefined();
    // Stopping session 1 must not unlock or disturb sessions 2–10.
    for (const name of names.slice(1)) {
      await expect(manager.assertProfileUnlocked(name)).rejects.toThrow(/ownership lock/);
      expect(await fs.readFile(path.join(manager.getProfilePath(name), 'auth-canary'), 'utf8')).toBe(name);
    }
    await Promise.all(releases.slice(1).map(release => release()));
    for (const name of names) {
      await expect(manager.assertProfileUnlocked(name)).resolves.toBeUndefined();
      expect(await fs.readFile(path.join(manager.getProfilePath(name), 'auth-canary'), 'utf8')).toBe(name);
    }
  });

  it('allows exactly one winner among simultaneous starts of the same session', async () => {
    const instances = Array.from({ length: 8 }, () => new BraveProfileManager(base));
    instances.forEach(instance => setInventory(instance));
    const attempts = await Promise.allSettled(instances.map(instance => instance.acquireProfileLease('one')));
    const winners = attempts.filter(result => result.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(7);
    if (winners[0].status === 'fulfilled') await winners[0].value();
    await expect(manager.assertProfileUnlocked('one')).resolves.toBeUndefined();
  });

  it('recovers a dead backend with no browser and preserves existing login data', async () => {
    const profile = manager.getProfilePath('recover-a');
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(path.join(profile, 'auth-canary'), 'unchanged');
    const old = await abandoned('recover-a');
    const release = await manager.acquireProfileLease('recover-a');
    const latest = await readOwner('recover-a');
    expect(latest.token).not.toBe(old.token);
    expect(latest.pid).toBe(process.pid);
    expect(await fs.readFile(path.join(profile, 'auth-canary'), 'utf8')).toBe('unchanged');
    await release();
  });

  it('recovers only a verified orphan for A while B keeps its lock and profile', async () => {
    const tokenA = randomUUID();
    await abandoned('session-a', { token: tokenA });
    const releaseB = await manager.acquireProfileLease('session-b');
    const ownerB = await readOwner('session-b');
    await manager.ensureProfile('session-a');
    await manager.ensureProfile('session-b');
    await fs.writeFile(path.join(manager.getProfilePath('session-b'), 'auth-canary'), 'B');

    let aliveA = true;
    const records = (): BraveProcessRecord[] => [
      ...(aliveA ? [
        { pid: 731001, parentPid: 1, commandLine:
          `/usr/bin/brave --al-hakim-session=session-a --al-hakim-lease=${tokenA} --user-data-dir=${manager.getProfilePath('session-a')}` },
        { pid: 731002, parentPid: 731001, commandLine: '/usr/bin/brave --type=renderer' },
      ] : []),
      { pid: 742001, parentPid: 1, commandLine:
        `/usr/bin/brave --al-hakim-session=session-b --al-hakim-lease=${ownerB.token} --user-data-dir=${manager.getProfilePath('session-b')}` },
    ];
    setInventory(manager, session => session === 'session-a' && aliveA ? [731001] :
      session === 'session-b' ? [742001] : [], records);
    const reap = jest.fn(async () => { aliveA = false; });
    (manager as unknown as { terminateVerifiedAbandonedTree: typeof reap }).terminateVerifiedAbandonedTree = reap;

    const releaseA = await manager.acquireProfileLease('session-a');
    expect(reap).toHaveBeenCalledTimes(1);
    expect((await readOwner('session-b')).token).toBe(ownerB.token);
    expect(await fs.readFile(path.join(manager.getProfilePath('session-b'), 'auth-canary'), 'utf8')).toBe('B');
    await expect(manager.assertProfileUnlocked('session-b')).rejects.toThrow(/ownership lock/);
    await releaseA();
    // No implicit teardown of B: its simulated browser must be removed by its own lifecycle.
    setInventory(manager);
    await releaseB();
  });

  it('rejects a surviving browser with an incorrect lease generation without terminating it', async () => {
    await abandoned('unsafe');
    let invoked = false;
    const records: BraveProcessRecord[] = [
      { pid: 731001, parentPid: 1, commandLine:
        `/usr/bin/brave --al-hakim-session=unsafe --al-hakim-lease=${randomUUID()} --user-data-dir=${manager.getProfilePath('unsafe')}` },
    ];
    setInventory(manager, session => session === 'unsafe' ? [731001] : [], () => records);
    (manager as unknown as { terminateVerifiedAbandonedTree: () => Promise<void> })
      .terminateVerifiedAbandonedTree = async () => { invoked = true; };
    await expect(manager.acquireProfileLease('unsafe')).rejects.toThrow(/BROWSER_ORPHAN_RECOVERY_UNSAFE/);
    expect(invoked).toBe(false);
    expect(await readOwner('unsafe')).toBeDefined();
  });

  it('refuses recovery when process inventory is unavailable, leaving the lock intact', async () => {
    const original = await abandoned('inventory-down');
    (manager as unknown as { inspectAllProcessRecords: () => Promise<BraveProcessRecord[]> })
      .inspectAllProcessRecords = async () => { throw new Error('CIM unavailable'); };
    await expect(manager.acquireProfileLease('inventory-down')).rejects.toThrow(/CIM unavailable/);
    expect((await readOwner('inventory-down')).token).toBe(original.token);
  });

  it('does not recover an existing owner PID or an owner from another machine', async () => {
    const live = await abandoned('live-owner', { pid: process.pid });
    const remote = await abandoned('remote-owner', { host: 'different-backend-host' });
    await expect(manager.acquireProfileLease('live-owner')).rejects.toThrow(/locked/);
    await expect(manager.acquireProfileLease('remote-owner')).rejects.toThrow(/locked/);
    expect((await readOwner('live-owner')).token).toBe(live.token);
    expect((await readOwner('remote-owner')).token).toBe(remote.token);
  });

  it('retains a lock after incomplete browser shutdown and permits a verified retry', async () => {
    const release = await manager.acquireProfileLease('release-retry');
    let running = true;
    setInventory(manager, session => session === 'release-retry' && running ? [901101] : []);
    await expect(release()).rejects.toThrow(/still live/);
    await expect(manager.assertProfileUnlocked('release-retry')).rejects.toThrow(/ownership lock/);
    running = false;
    await release();
    await expect(manager.assertProfileUnlocked('release-retry')).resolves.toBeUndefined();
  });

  it('requires exact session and profile identity, including on Windows command lines', () => {
    const pathA = 'C:\\Profiles with spaces\\session-a';
    const cmd = '"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" ' +
      '--al-hakim-session=session-a --user-data-dir="C:\\Profiles with spaces\\session-a"';
    expect(isSessionOwnedBraveRoot(cmd, 'session-a', pathA, true)).toBe(true);
    expect(isSessionOwnedBraveRoot(cmd, 'session', pathA, true)).toBe(false);
    expect(isSessionOwnedBraveRoot(cmd, 'session-a', 'C:\\Profiles with spaces\\session-b', true)).toBe(false);
  });
});
