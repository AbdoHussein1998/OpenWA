import type { BrowserProfileManager } from '../browser/browser-profile.manager';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { WwebjsLifecycle, type WwebjsLifecycleHost } from './wwebjs-lifecycle';

/** No real browser or profile is touched; these test the recovery concurrency boundaries. */
describe('Phase 8: browser protocol-timeout recovery', () => {
  function fixture() {
    const host = {
      logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn(), event: jest.fn() },
      config: { sessionId: 'phase8' },
    } as unknown as WwebjsLifecycleHost;
    const lifecycle = new WwebjsLifecycle(host, {} as BrowserProfileManager);
    lifecycle.status = EngineStatus.READY;
    lifecycle.client = {} as typeof lifecycle.client;
    return { lifecycle, host };
  }

  it('coalesces simultaneous reports so a single stalled CDP check does not double-count failure', async () => {
    const { lifecycle } = fixture();
    let finish!: (healthy: boolean) => void;
    const pending = new Promise<boolean>(resolve => { finish = resolve; });
    const pageProbe = jest.fn(() => pending);
    const runtimeProbe = jest.fn(async () => false);
    const force = jest.fn(async () => undefined);
    Object.assign(lifecycle, { probeBrowserHealth: pageProbe, probeLiveness: runtimeProbe, forceDestroy: force });
    const first = lifecycle.handleProtocolTimeout('getChats');
    const second = lifecycle.handleProtocolTimeout('getMessages');
    expect(second).toBe(first);
    expect(pageProbe).toHaveBeenCalledTimes(1);
    finish(false);
    await Promise.all([first, second]);
    expect(runtimeProbe).toHaveBeenCalledTimes(1);
    expect(force).not.toHaveBeenCalled();
    // A genuinely new timeout after the first check settled reaches the existing threshold.
    await lifecycle.handleProtocolTimeout('getChats');
    expect(force).toHaveBeenCalledTimes(1);
  });

  it('coalesces browser termination so two simultaneous timeout handlers cannot forceDestroy twice', async () => {
    const { lifecycle } = fixture();
    const force = jest.fn(async () => undefined);
    Object.assign(lifecycle, {
      probeBrowserHealth: jest.fn(async () => false),
      probeLiveness: jest.fn(async () => false),
      forceDestroy: force,
    });
    await lifecycle.handleProtocolTimeout('warmup'); // first failure
    const [a, b, c] = [
      lifecycle.handleProtocolTimeout('sendMessage'),
      lifecycle.handleProtocolTimeout('getState'),
      lifecycle.handleProtocolTimeout('getChats'),
    ];
    expect(a).toBe(b);
    expect(b).toBe(c);
    await Promise.all([a, b, c]);
    expect(force).toHaveBeenCalledTimes(1);
  });

  it('clears the single-flight fence after a probe error so later failures can be evaluated', async () => {
    const { lifecycle } = fixture();
    let failures = 0;
    Object.assign(lifecycle, {
      probeBrowserHealth: jest.fn(async () => { failures++; throw new Error('CDP error'); }),
      probeLiveness: jest.fn(async () => false),
    });
    await expect(lifecycle.handleProtocolTimeout('one')).rejects.toThrow('CDP error');
    await expect(lifecycle.handleProtocolTimeout('two')).rejects.toThrow('CDP error');
    expect(failures).toBe(2);
  });
});
