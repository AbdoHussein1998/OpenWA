import {
  SessionLivenessWatchdog,
  SESSION_WATCHDOG_INTERVAL_MS,
  SESSION_WATCHDOG_MAX_FAILURES,
  SESSION_WATCHDOG_PROBE_TIMEOUT_MS,
  SESSION_WATCHDOG_DISCONNECT_TIMEOUT_MS,
} from './session-liveness-watchdog.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { EngineStatus, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import type { ShutdownService } from '../../common/services/shutdown.service';

type FakeEngine = {
  getStatus: jest.Mock;
  probeLiveness?: jest.Mock;
};

const engineOf = (status: EngineStatus, probe?: jest.Mock): FakeEngine => ({
  getStatus: jest.fn().mockReturnValue(status),
  ...(probe ? { probeLiveness: probe } : {}),
});

describe('SessionLivenessWatchdog', () => {
  let engines: EngineRegistry;
  let onDead: jest.Mock;
  let watchdog: SessionLivenessWatchdog;

  const failuresOf = (w: SessionLivenessWatchdog): Map<string, number> =>
    (w as unknown as { failures: Map<string, number> }).failures;

  beforeEach(() => {
    engines = new EngineRegistry();
    onDead = jest.fn().mockResolvedValue(undefined);
    watchdog = new SessionLivenessWatchdog(engines);
  });

  afterEach(() => {
    watchdog.stop();
  });

  describe('probe eligibility', () => {
    it('treats a READY engine that answers as alive', async () => {
      const probe = jest.fn().mockResolvedValue(true);
      const engine = engineOf(EngineStatus.READY, probe);
      engines.set('s1', engine as unknown as IWhatsAppEngine);
      watchdog.start(onDead);

      await watchdog.probe('s1', engine as unknown as IWhatsAppEngine);

      expect(probe).toHaveBeenCalled();
      expect(onDead).not.toHaveBeenCalled();
    });

    it('skips a non-READY engine entirely (owned by the QR/reconnect flows)', async () => {
      const probe = jest.fn().mockResolvedValue(false);
      const engine = engineOf(EngineStatus.INITIALIZING, probe);
      engines.set('s1', engine as unknown as IWhatsAppEngine);

      await watchdog.probe('s1', engine as unknown as IWhatsAppEngine);

      expect(probe).not.toHaveBeenCalled();
    });

    it('clears failures accrued in a previous READY stretch when the status leaves READY', async () => {
      const engine = engineOf(EngineStatus.READY, jest.fn().mockResolvedValue(false));
      engines.set('s1', engine as unknown as IWhatsAppEngine);
      await watchdog.probe('s1', engine as unknown as IWhatsAppEngine);
      expect(failuresOf(watchdog).get('s1')).toBe(1);

      engine.getStatus.mockReturnValue(EngineStatus.DISCONNECTED);
      await watchdog.probe('s1', engine as unknown as IWhatsAppEngine);

      expect(failuresOf(watchdog).has('s1')).toBe(false);
    });

    it('skips an engine without probeLiveness (relies on engine events alone)', async () => {
      const engine = engineOf(EngineStatus.READY);
      engines.set('s1', engine as unknown as IWhatsAppEngine);
      watchdog.start(onDead);

      await watchdog.probe('s1', engine as unknown as IWhatsAppEngine);

      expect(onDead).not.toHaveBeenCalled();
      expect(failuresOf(watchdog).has('s1')).toBe(false);
    });
  });

  describe('failure threshold', () => {
    it(`treats the session as dead after ${SESSION_WATCHDOG_MAX_FAILURES} consecutive failures`, async () => {
      const engine = engineOf(EngineStatus.READY, jest.fn().mockResolvedValue(false));
      engines.set('s1', engine as unknown as IWhatsAppEngine);
      watchdog.start(onDead);

      for (let i = 0; i < SESSION_WATCHDOG_MAX_FAILURES; i++) {
        await watchdog.probe('s1', engine as unknown as IWhatsAppEngine);
      }

      expect(onDead).toHaveBeenCalledTimes(1);
      expect(onDead).toHaveBeenCalledWith('s1', engine, 'liveness probe failed (watchdog)');
    });

    it('does not act on a single failure', async () => {
      const engine = engineOf(EngineStatus.READY, jest.fn().mockResolvedValue(false));
      engines.set('s1', engine as unknown as IWhatsAppEngine);
      watchdog.start(onDead);

      await watchdog.probe('s1', engine as unknown as IWhatsAppEngine);

      expect(onDead).not.toHaveBeenCalled();
      expect(failuresOf(watchdog).get('s1')).toBe(1);
    });

    it('resets the streak on a successful probe, so failures must be CONSECUTIVE', async () => {
      const probe = jest.fn().mockResolvedValue(false);
      const engine = engineOf(EngineStatus.READY, probe);
      engines.set('s1', engine as unknown as IWhatsAppEngine);
      watchdog.start(onDead);

      await watchdog.probe('s1', engine as unknown as IWhatsAppEngine);
      probe.mockResolvedValue(true);
      await watchdog.probe('s1', engine as unknown as IWhatsAppEngine);
      probe.mockResolvedValue(false);
      await watchdog.probe('s1', engine as unknown as IWhatsAppEngine);

      expect(onDead).not.toHaveBeenCalled();
    });

    it('counts a probe that rejects as a failure', async () => {
      const engine = engineOf(EngineStatus.READY, jest.fn().mockRejectedValue(new Error('socket gone')));
      engines.set('s1', engine as unknown as IWhatsAppEngine);
      watchdog.start(onDead);

      await watchdog.probe('s1', engine as unknown as IWhatsAppEngine);

      expect(failuresOf(watchdog).get('s1')).toBe(1);
    });

    it('counts a hung probe as a failure once the deadline passes', async () => {
      jest.useFakeTimers();
      try {
        // A wedged connection can hang the probe itself; without the race the tick would stall.
        const engine = engineOf(EngineStatus.READY, jest.fn().mockReturnValue(new Promise<boolean>(() => {})));
        engines.set('s1', engine as unknown as IWhatsAppEngine);
        watchdog.start(onDead);

        const pending = watchdog.probe('s1', engine as unknown as IWhatsAppEngine);
        await jest.advanceTimersByTimeAsync(SESSION_WATCHDOG_PROBE_TIMEOUT_MS);
        await pending;

        expect(failuresOf(watchdog).get('s1')).toBe(1);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('ACTION_REQUIRED is observe-only', () => {
    it('probes the engine but never acts on a failure (the status is operator-owned)', async () => {
      const probe = jest.fn().mockResolvedValue(false);
      const engine = engineOf(EngineStatus.ACTION_REQUIRED, probe);
      engines.set('s1', engine as unknown as IWhatsAppEngine);
      watchdog.start(onDead);

      for (let i = 0; i < SESSION_WATCHDOG_MAX_FAILURES + 3; i++) {
        await watchdog.probe('s1', engine as unknown as IWhatsAppEngine);
      }

      expect(probe).toHaveBeenCalled();
      // Acting here would silently drop the very status asking for attention.
      expect(onDead).not.toHaveBeenCalled();
      expect(failuresOf(watchdog).get('s1')).toBeGreaterThan(SESSION_WATCHDOG_MAX_FAILURES);
    });

    it('clears the observe-only count when the probe answers again', async () => {
      const probe = jest.fn().mockResolvedValue(false);
      const engine = engineOf(EngineStatus.ACTION_REQUIRED, probe);
      engines.set('s1', engine as unknown as IWhatsAppEngine);
      watchdog.start(onDead);

      await watchdog.probe('s1', engine as unknown as IWhatsAppEngine);
      probe.mockResolvedValue(true);
      await watchdog.probe('s1', engine as unknown as IWhatsAppEngine);

      expect(failuresOf(watchdog).has('s1')).toBe(false);
    });
  });

  describe('stale results', () => {
    it('ignores a probe result for an engine superseded while it was in flight', async () => {
      const engine = engineOf(EngineStatus.READY, jest.fn().mockResolvedValue(false));
      engines.set('s1', engine as unknown as IWhatsAppEngine);
      watchdog.start(onDead);
      failuresOf(watchdog).set('s1', SESSION_WATCHDOG_MAX_FAILURES - 1);

      // A stop()/restart replaces the engine before the probe settles.
      engines.set('s1', engineOf(EngineStatus.READY) as unknown as IWhatsAppEngine);
      await watchdog.probe('s1', engine as unknown as IWhatsAppEngine);

      expect(onDead).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle', () => {
    it('probes every live engine on each tick', async () => {
      jest.useFakeTimers();
      try {
        const a = engineOf(EngineStatus.READY, jest.fn().mockResolvedValue(true));
        const b = engineOf(EngineStatus.READY, jest.fn().mockResolvedValue(true));
        engines.set('a', a as unknown as IWhatsAppEngine);
        engines.set('b', b as unknown as IWhatsAppEngine);
        watchdog.start(onDead);

        await jest.advanceTimersByTimeAsync(SESSION_WATCHDOG_INTERVAL_MS);

        expect(a.probeLiveness).toHaveBeenCalled();
        expect(b.probeLiveness).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('is idempotent: a second start does not add a second interval', () => {
      jest.useFakeTimers();
      try {
        watchdog.start(onDead);
        watchdog.start(onDead);

        expect(jest.getTimerCount()).toBe(1);
      } finally {
        watchdog.stop();
        jest.useRealTimers();
      }
    });

    it('stop() clears the interval and the accrued failures, and is safe to call twice', () => {
      jest.useFakeTimers();
      try {
        watchdog.start(onDead);
        failuresOf(watchdog).set('s1', 1);

        watchdog.stop();
        watchdog.stop();

        expect(jest.getTimerCount()).toBe(0);
        expect(failuresOf(watchdog).size).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('skips the whole tick while shutting down (a reconnect would race teardown)', async () => {
      jest.useFakeTimers();
      const shutdown = { isShuttingDown: () => true } as unknown as ShutdownService;
      const draining = new SessionLivenessWatchdog(engines, shutdown);
      try {
        const engine = engineOf(EngineStatus.READY, jest.fn().mockResolvedValue(false));
        engines.set('s1', engine as unknown as IWhatsAppEngine);
        draining.start(onDead);

        await jest.advanceTimersByTimeAsync(SESSION_WATCHDOG_INTERVAL_MS);

        expect(engine.probeLiveness).not.toHaveBeenCalled();
      } finally {
        draining.stop();
        jest.useRealTimers();
      }
    });

    it('clear() forgets one session without disturbing another', () => {
      failuresOf(watchdog).set('s1', 1);
      failuresOf(watchdog).set('s2', 1);

      watchdog.clear('s1');

      expect(failuresOf(watchdog).has('s1')).toBe(false);
      expect(failuresOf(watchdog).get('s2')).toBe(1);
    });

    it('a failing probe never throws into the timer', async () => {
      jest.useFakeTimers();
      try {
        const engine = engineOf(EngineStatus.READY, jest.fn().mockResolvedValue(false));
        engines.set('s1', engine as unknown as IWhatsAppEngine);
        watchdog.start(() => Promise.reject(new Error('disconnect handler blew up')));

        await expect(
          jest.advanceTimersByTimeAsync(SESSION_WATCHDOG_INTERVAL_MS * (SESSION_WATCHDOG_MAX_FAILURES + 1)),
        ).resolves.not.toThrow();
      } finally {
        jest.useRealTimers();
      }
    });
  });
});

describe('Phase 8: browser deadlock and overlapping-watchdog acceptance', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }

  let engines: EngineRegistry;
  let watchdog: SessionLivenessWatchdog;
  let onDead: jest.Mock;

  beforeEach(() => {
    engines = new EngineRegistry();
    watchdog = new SessionLivenessWatchdog(engines);
    onDead = jest.fn().mockResolvedValue(undefined);
  });
  afterEach(() => watchdog.stop());

  it('runs only one health probe for a session across overlapping ticks', async () => {
    const gate = deferred<boolean>();
    const slow = engineOf(EngineStatus.READY, jest.fn(() => gate.promise));
    const fast = engineOf(EngineStatus.READY, jest.fn().mockResolvedValue(true));
    engines.set('slow', slow as unknown as IWhatsAppEngine);
    engines.set('fast', fast as unknown as IWhatsAppEngine);

    const first = watchdog.tick();
    const second = watchdog.tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(slow.probeLiveness).toHaveBeenCalledTimes(1);
    expect(fast.probeLiveness).toHaveBeenCalledTimes(1);
    gate.resolve(false);
    await Promise.all([first, second]);
    expect((watchdog as unknown as {failures: Map<string, number>}).failures.get('slow')).toBe(1);
  });

  it('does not reconnect an engine that changes from READY to ACTION_REQUIRED during a stalled probe', async () => {
    const gate = deferred<boolean>();
    const engine = engineOf(EngineStatus.READY, jest.fn(() => gate.promise));
    engines.set('a', engine as unknown as IWhatsAppEngine);
    const first = watchdog.probe('a', engine as unknown as IWhatsAppEngine);
    await Promise.resolve();
    engine.getStatus.mockReturnValue(EngineStatus.ACTION_REQUIRED);
    gate.resolve(false);
    await first;
    expect((watchdog as unknown as {failures: Map<string, number>}).failures.has('a')).toBe(false);
    expect(onDead).not.toHaveBeenCalled();
  });

  it('clear() invalidates a probe started before the session became READY again', async () => {
    const gate = deferred<boolean>();
    const engine = engineOf(EngineStatus.READY, jest.fn(() => gate.promise));
    engines.set('a', engine as unknown as IWhatsAppEngine);
    const first = watchdog.probe('a', engine as unknown as IWhatsAppEngine);
    await Promise.resolve();
    watchdog.clear('a');
    gate.resolve(false);
    await first;
    expect((watchdog as unknown as {failures: Map<string, number>}).failures.has('a')).toBe(false);
  });

  it('does not let an older engine generation affect its replacement after a pending probe', async () => {
    const gate = deferred<boolean>();
    const old = engineOf(EngineStatus.READY, jest.fn(() => gate.promise));
    const next = engineOf(EngineStatus.READY, jest.fn().mockResolvedValue(true));
    engines.set('a', old as unknown as IWhatsAppEngine);
    const before = watchdog.probe('a', old as unknown as IWhatsAppEngine);
    await Promise.resolve();
    engines.set('a', next as unknown as IWhatsAppEngine);
    await watchdog.probe('a', next as unknown as IWhatsAppEngine);
    gate.resolve(false);
    await before;
    expect((watchdog as unknown as {failures: Map<string, number>}).failures.has('a')).toBe(false);
  });

  it('a hung disconnect handler cannot be dispatched twice for the same browser', async () => {
    jest.useFakeTimers();
    const gate = deferred<void>();
    const engine = engineOf(EngineStatus.READY, jest.fn().mockResolvedValue(false));
    const onDeadPending = jest.fn(() => gate.promise);
    try {
      engines.set('a', engine as unknown as IWhatsAppEngine);
      watchdog.start(onDeadPending);
      await watchdog.probe('a', engine as unknown as IWhatsAppEngine);
      const pending = watchdog.probe('a', engine as unknown as IWhatsAppEngine);
      await jest.advanceTimersByTimeAsync(SESSION_WATCHDOG_DISCONNECT_TIMEOUT_MS);
      await pending;
      expect(onDeadPending).toHaveBeenCalledTimes(1);
      await watchdog.tick();
      expect(onDeadPending).toHaveBeenCalledTimes(1);
      gate.resolve();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      watchdog.stop();
      jest.useRealTimers();
    }
  });

  it('stop() invalidates an old probe even when its promise resolves afterward', async () => {
    const gate = deferred<boolean>();
    const engine = engineOf(EngineStatus.READY, jest.fn(() => gate.promise));
    engines.set('a', engine as unknown as IWhatsAppEngine);
    const previous = watchdog.probe('a', engine as unknown as IWhatsAppEngine);
    await Promise.resolve();
    watchdog.stop();
    gate.resolve(false);
    await previous;
    expect((watchdog as unknown as {failures: Map<string, number>}).failures.has('a')).toBe(false);
  });
});
