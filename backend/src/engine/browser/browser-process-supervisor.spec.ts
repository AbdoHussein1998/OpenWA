import { EventEmitter } from 'events';
import { BrowserProcessSupervisor } from './browser-process-supervisor';
import { BraveProcessSupervisor } from '../brave/brave-process-supervisor';

function child(pid: number, exitCode: number | null = null) {
  return Object.assign(new EventEmitter(), { pid, exitCode, signalCode: null as string | null });
}

describe('Phase 3: browser-neutral process supervisor', () => {
  it('observes the current generation only, and ignores a retired child exit', () => {
    const supervisor = new BrowserProcessSupervisor();
    const oldProcess = child(110);
    const newProcess = child(220);
    const oldOwner = {};
    const newOwner = {};
    const oldExit = jest.fn();
    const newExit = jest.fn();
    expect(supervisor.observe(oldOwner, oldProcess, oldExit)).toBe(110);
    expect(supervisor.observe(newOwner, newProcess, newExit)).toBe(220);
    oldProcess.emit('exit', 1, null);
    expect(oldExit).not.toHaveBeenCalled();
    newProcess.emit('exit', 2, 'SIGKILL');
    expect(newExit).toHaveBeenCalledWith('Browser PID 220 exited (code=2, signal=SIGKILL)', 220);
    expect(supervisor.getPid(oldOwner)).toBeNull();
    expect(supervisor.getPid(newOwner)).toBe(220);
    supervisor.detach(oldOwner); // Must not detach new owner's observation.
    newProcess.emit('exit', 3, null);
    expect(newExit).toHaveBeenCalledTimes(2);
    supervisor.detach(newOwner);
    newProcess.emit('exit', 4, null);
    expect(newExit).toHaveBeenCalledTimes(2);
  });

  it('reports a ChildProcess error without mistaking it for process exit', () => {
    const supervisor = new BrowserProcessSupervisor();
    const p = child(300);
    const onExit = jest.fn();
    const onError = jest.fn();
    supervisor.observe({}, p, onExit, onError);
    const error = new Error('kill signal failed');
    p.emit('error', error);
    expect(onError).toHaveBeenCalledWith(error, 300);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('reports exit that happened before observation was attached', () => {
    const supervisor = new BrowserProcessSupervisor();
    const exited = child(400, 1);
    const onExit = jest.fn();
    expect(supervisor.observe({}, exited, onExit)).toBe(400);
    expect(onExit).toHaveBeenCalledWith('Browser PID 400 exited (code=1, signal=null)', 400);
  });

  it('does not attach to invalid PIDs and detaches the previous generation', () => {
    const supervisor = new BrowserProcessSupervisor();
    const p = child(500);
    const onExit = jest.fn();
    supervisor.observe({}, p, onExit);
    expect(supervisor.observe({}, child(0), jest.fn())).toBeNull();
    p.emit('exit', 0, null);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('preserves legacy Brave process-exit text and public methods', () => {
    const supervisor = new BraveProcessSupervisor();
    const onExit = jest.fn();
    const p = child(600);
    expect(supervisor).toBeInstanceOf(BrowserProcessSupervisor);
    supervisor.observe({}, p, onExit);
    p.emit('exit', 1, null);
    expect(onExit).toHaveBeenCalledWith('Brave browser PID 600 exited (code=1, signal=null)', 600);
  });
});
