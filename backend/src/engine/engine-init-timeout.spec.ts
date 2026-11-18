import {
  DEFAULT_WWEBJS_AUTH_TIMEOUT_MS,
  DEFAULT_WWEBJS_READY_TIMEOUT_MS,
  MIN_WWEBJS_READY_TIMEOUT_MS,
  resolveAuthTimeoutMs,
  resolveEngineInitTimeoutMs,
  resolveReadyTimeoutMs,
} from './engine-init-timeout';

describe('engine timeout configuration', () => {
  const originalAuthTimeout =
    process.env.WWEBJS_AUTH_TIMEOUT_MS;
  const originalReadyTimeout =
    process.env.WWEBJS_READY_TIMEOUT_MS;

  afterEach(() => {
    if (originalAuthTimeout === undefined) {
      delete process.env.WWEBJS_AUTH_TIMEOUT_MS;
    } else {
      process.env.WWEBJS_AUTH_TIMEOUT_MS =
        originalAuthTimeout;
    }

    if (originalReadyTimeout === undefined) {
      delete process.env.WWEBJS_READY_TIMEOUT_MS;
    } else {
      process.env.WWEBJS_READY_TIMEOUT_MS =
        originalReadyTimeout;
    }
  });

  describe('resolveAuthTimeoutMs', () => {
    it('keeps the whatsapp-web.js default when the override is unset', () => {
      delete process.env.WWEBJS_AUTH_TIMEOUT_MS;

      expect(resolveAuthTimeoutMs()).toBeUndefined();
      expect(resolveEngineInitTimeoutMs()).toBe(
        Math.max(
          60_000,
          DEFAULT_WWEBJS_AUTH_TIMEOUT_MS +
            30_000,
        ),
      );
    });

    it('accepts a positive safe integer override and extends the outer init deadline', () => {
      process.env.WWEBJS_AUTH_TIMEOUT_MS =
        '120000';

      expect(resolveAuthTimeoutMs()).toBe(
        120_000,
      );
      expect(resolveEngineInitTimeoutMs()).toBe(
        150_000,
      );
    });

    it.each([
      '',
      '0',
      '-1',
      '1.5',
      'abc',
      '9007199254740992',
    ])(
      'rejects invalid auth timeout %p',
      value => {
        process.env.WWEBJS_AUTH_TIMEOUT_MS =
          value;

        expect(resolveAuthTimeoutMs()).toBeUndefined();
      },
    );
  });

  describe('resolveReadyTimeoutMs', () => {
    it('uses the four-minute readiness default when unset', () => {
      delete process.env.WWEBJS_READY_TIMEOUT_MS;

      expect(resolveReadyTimeoutMs()).toBe(
        DEFAULT_WWEBJS_READY_TIMEOUT_MS,
      );
    });

    it('accepts a configured readiness timeout at or above the minimum', () => {
      process.env.WWEBJS_READY_TIMEOUT_MS =
        '300000';

      expect(resolveReadyTimeoutMs()).toBe(
        300_000,
      );

      process.env.WWEBJS_READY_TIMEOUT_MS =
        String(
          MIN_WWEBJS_READY_TIMEOUT_MS,
        );

      expect(resolveReadyTimeoutMs()).toBe(
        MIN_WWEBJS_READY_TIMEOUT_MS,
      );
    });

    it.each([
      '',
      '89999',
      '0',
      '-1',
      '1.5',
      'abc',
      '9007199254740992',
    ])(
      'falls back to the safe readiness default for invalid value %p',
      value => {
        process.env.WWEBJS_READY_TIMEOUT_MS =
          value;

        expect(resolveReadyTimeoutMs()).toBe(
          DEFAULT_WWEBJS_READY_TIMEOUT_MS,
        );
      },
    );
  });
});
