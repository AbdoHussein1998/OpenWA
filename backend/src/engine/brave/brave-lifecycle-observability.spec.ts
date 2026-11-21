import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { BraveProfileManager } from './brave-profile.manager';

/** The test never starts Brave and never mutates a real user profile. */
describe('Phase 5: Brave ownership observability', () => {
  let root: string;
  let manager: BraveProfileManager;
  let logger: { log: jest.Mock; warn: jest.Mock };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'brave-phase5-'));
    manager = new BraveProfileManager(root);
    logger = { log: jest.fn(), warn: jest.fn() };
    (manager as unknown as { findSessionBravePids: jest.Mock }).findSessionBravePids =
      jest.fn().mockResolvedValue([]);
  });

  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('records lease acquire/release without logging generation tokens', async () => {
    const release = await manager.acquireProfileLease('session-a', logger as never);
    const { token } = JSON.parse(await fs.readFile(
      path.join(root, '.openwa-profile-locks', 'session-a', 'owner.json'), 'utf8')) as {token: string};
    await release();
    expect(logger.log).toHaveBeenCalledTimes(2);
    const entries = JSON.stringify(logger.log.mock.calls);
    expect(entries.includes(token)).toBe(false);
    expect(entries.includes('engine.browser.lease_acquired')).toBe(true);
    expect(entries.includes('engine.browser.lease_released')).toBe(true);
    expect(entries.includes('elapsedMs')).toBe(true);
  });

  it('reports an incomplete release without deleting its lock', async () => {
    const release = await manager.acquireProfileLease('session-c', logger as never);
    (manager as unknown as { findSessionBravePids: jest.Mock }).findSessionBravePids =
      jest.fn().mockResolvedValueOnce([4567]).mockResolvedValue([]);
    await expect(release()).rejects.toThrow(/still live/);
    const warnings = JSON.stringify(logger.warn.mock.calls);
    expect(warnings.includes('engine.browser.lease_retained')).toBe(true);
    expect(warnings.includes('BROWSER_TEARDOWN_INCOMPLETE')).toBe(true);
    expect(await fs.stat(path.join(root, '.openwa-profile-locks', 'session-c'))).toBeDefined();
    await release();
  });

  it('retains the existing PROFILE_LOCKED error and does not expose old owner token', async () => {
    const release = await manager.acquireProfileLease('session-b', logger as never);
    const owner = await fs.readFile(path.join(root, '.openwa-profile-locks', 'session-b', 'owner.json'), 'utf8');
    const token = (JSON.parse(owner) as { token: string }).token;
    let message = '';
    try { await manager.acquireProfileLease('session-b', logger as never); }
    catch (error) { message = (error as Error).message; }
    expect(message.includes('PROFILE_LOCKED')).toBe(true);
    expect(message.includes('locked by another owner')).toBe(true);
    expect(message.includes(token)).toBe(false);
    const entries = JSON.stringify(logger.warn.mock.calls);
    expect(entries.includes(token)).toBe(false);
    expect(entries.includes('PROFILE_LOCKED')).toBe(true);
    await release();
  });

  it('reports a recovery failure without logging the abandoned generation token', async () => {
    const lock = path.join(root, '.openwa-profile-locks', 'abandoned');
    await fs.mkdir(lock, { recursive: true });
    const token = randomUUID();
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({
      token, pid: 99999999, host: os.hostname(), acquiredAt: new Date().toISOString(),
    }));
    (manager as unknown as { findSessionBravePids: jest.Mock }).findSessionBravePids =
      jest.fn().mockRejectedValue(new Error('CIM unavailable'));
    await expect(manager.acquireProfileLease('abandoned', logger as never)).rejects.toThrow(/CIM unavailable/);
    const entries = JSON.stringify(logger.warn.mock.calls);
    expect(entries.includes('engine.browser.recovery_failed')).toBe(true);
    expect(entries.includes(token)).toBe(false);
    expect(await fs.stat(lock)).toBeDefined();
  });
});
