import { EventEmitter } from 'events';
import { BraveProcessSupervisor } from './brave-process-supervisor';
import { isSessionOwnedBraveRoot, planOwnedBraveTree } from './brave-profile.manager';

describe('Phase 2: isolated Brave process supervision', () => {
  const profileA = '/data/brave-profiles/account-a';
  const commandA = `/usr/bin/brave-browser --al-hakim-session=account-a --user-data-dir=${profileA}`;
  const commandB = '/usr/bin/brave-browser --al-hakim-session=account-b --user-data-dir=/data/brave-profiles/account-b';

  it('requires exact session and exact profile (not a similarly named session)', () => {
    expect(isSessionOwnedBraveRoot(commandA, 'account-a', profileA, false)).toBe(true);
    expect(isSessionOwnedBraveRoot(commandA, 'account', profileA, false)).toBe(false);
    expect(isSessionOwnedBraveRoot(commandB, 'account-a', profileA, false)).toBe(false);
    expect(isSessionOwnedBraveRoot(commandA, 'account-a', '/data/brave-profiles/account', false)).toBe(false);
  });

  it('handles Windows command lines with quoted paths', () => {
    const command = '"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" ' +
      '--al-hakim-session=account-a --user-data-dir="C:\\Data Files\\brave-profiles\\account-a"';
    expect(isSessionOwnedBraveRoot(command, 'account-a', 'C:\\Data Files\\brave-profiles\\account-a', true)).toBe(true);
    expect(isSessionOwnedBraveRoot(command, 'account-a', 'C:\\Data Files\\brave-profiles\\account-b', true)).toBe(false);
  });

  it('plans only the captured Brave tree, ordered leaves first', () => {
    const records = [
      { pid: 200, parentPid: 1, commandLine: commandA },
      { pid: 201, parentPid: 200, commandLine: 'brave --type=renderer' },
      { pid: 202, parentPid: 201, commandLine: 'brave --type=utility' },
      { pid: 300, parentPid: 1, commandLine: commandB },
      { pid: 301, parentPid: 300, commandLine: 'brave --type=renderer' },
    ];
    expect(planOwnedBraveTree(records, 200, 'account-a', profileA, false).map(x => x.pid))
      .toEqual([202, 201, 200]);
  });

  it('refuses wrong owner and cross-session descendants', () => {
    expect(() => planOwnedBraveTree([
      { pid: 300, parentPid: 1, commandLine: commandB },
    ], 300, 'account-a', profileA, false)).toThrow(/identity mismatch/);
    expect(() => planOwnedBraveTree([
      { pid: 200, parentPid: 1, commandLine: commandA },
      { pid: 201, parentPid: 200, commandLine: commandB },
    ], 200, 'account-a', profileA, false)).toThrow(/different session/);
  });

  it('never acts on a PID that already disappeared', () => {
    expect(planOwnedBraveTree([], 200, 'account-a', profileA, false)).toEqual([]);
  });

  it('observes exit with captured PID, and isolates an old engine generation', () => {
    const supervisor = new BraveProcessSupervisor();
    const previous = Object.assign(new EventEmitter(), { pid: 201, exitCode: null, signalCode: null });
    const current = Object.assign(new EventEmitter(), { pid: 301, exitCode: null, signalCode: null });
    const oldCallback = jest.fn();
    const newCallback = jest.fn();
    const previousOwner = {};
    const currentOwner = {};
    expect(supervisor.observe(previousOwner, previous, oldCallback)).toBe(201);
    expect(supervisor.observe(currentOwner, current, newCallback)).toBe(301);
    previous.emit('exit', 1, null);
    expect(oldCallback).not.toHaveBeenCalled();
    current.emit('exit', 9, null);
    expect(newCallback).toHaveBeenCalledWith(expect.stringContaining('PID 301'), 301);
    expect(supervisor.getPid(previousOwner)).toBeNull();
    expect(supervisor.getPid(currentOwner)).toBe(301);
    supervisor.detach(currentOwner);
    current.emit('exit', 9, null);
    expect(newCallback).toHaveBeenCalledTimes(1);
  });

  it('does not classify a ChildProcess error as a confirmed exit', () => {
    const supervisor = new BraveProcessSupervisor();
    const child = Object.assign(new EventEmitter(), { pid: 222, exitCode: null, signalCode: null });
    const onExit = jest.fn();
    const onError = jest.fn();
    supervisor.observe({}, child, onExit, onError);
    child.emit('error', new Error('failed to send signal'));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('observes exits that occurred before listeners attached', () => {
    const supervisor = new BraveProcessSupervisor();
    const child = Object.assign(new EventEmitter(), { pid: 225, exitCode: 1, signalCode: null });
    const onExit = jest.fn();
    supervisor.observe({}, child, onExit);
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

describe('Phase 2: verified manager termination boundaries', () => {
  it('refuses to terminate a captured PID whose command line belongs to another session', async () => {
    const { BraveProfileManager } = await import('./brave-profile.manager');
    const manager = new BraveProfileManager('/data/brave-profiles');
    (manager as unknown as { inspectProcessTree: jest.Mock }).inspectProcessTree = jest.fn().mockResolvedValue([
      { pid: 400, parentPid: 1,
        commandLine: '/usr/bin/brave --al-hakim-session=other --user-data-dir=/data/brave-profiles/other' },
    ]);
    await expect(manager.terminateOwnedBrowserTree('account-a', 400, { warn: jest.fn() } as never, ''))
      .rejects.toThrow(/no verified owner token/);
  });

  it('rejects a mismatched captured Brave PID even if the current lock token is valid', async () => {
    const { BraveProfileManager } = await import('./brave-profile.manager');
    // Use an isolated per-test temporary filesystem instead of touching real sessions.
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'brave-phase2-mismatch-'));
    try {
      const isolated = new BraveProfileManager(temp);
      const release = await isolated.acquireProfileLease('account-a');
      (isolated as unknown as { inspectProcessTree: jest.Mock }).inspectProcessTree = jest.fn().mockResolvedValue([
        { pid: 400, parentPid: 1, commandLine:
          '/usr/bin/brave --al-hakim-session=other --user-data-dir=/tmp/other' },
      ]);
      await expect(isolated.terminateOwnedBrowserTree('account-a', 400, {warn:jest.fn()} as never, release.ownerToken))
        .rejects.toThrow(/identity mismatch/);
      await release();
    } finally { await fs.rm(temp, { recursive:true, force:true }); }
  });

  it('does not invoke a machine-wide kill when the captured PID has already exited', async () => {
    const { BraveProfileManager } = await import('./brave-profile.manager');
    const manager = new BraveProfileManager('/data/brave-profiles');
    (manager as unknown as { inspectProcessTree: jest.Mock }).inspectProcessTree = jest.fn().mockResolvedValue([]);
    // With a valid locally owned lease, a vanished PID requires no system-wide kill.
    const release = await manager.acquireProfileLease('account-a');
    await expect(manager.terminateOwnedBrowserTree('account-a', 400, { warn: jest.fn() } as never, release.ownerToken))
      .resolves.toBeUndefined();
    await release();
  });
});
