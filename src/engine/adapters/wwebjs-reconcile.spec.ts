


import {
  type Client,
  WAState,
} from 'whatsapp-web.js';

import {
  EngineStatus,
  type EngineEventCallbacks,
} from '../interfaces/whatsapp-engine.interface';

import type {
  WhatsAppWebJsConfig,
} from './whatsapp-web-js.adapter';

import {
  QR_CONNECTED_REINJECT_GRACE_MS,
  READY_RECONCILE_TIMEOUT_MS,
  WwebjsReadyReconcile,
  type WwebjsReadyReconcileHost,
} from './wwebjs-reconcile';

interface TestPage {
  evaluate: jest.Mock<
    Promise<unknown>,
    [unknown, ...unknown[]]
  >;
  reload: jest.Mock<
    Promise<unknown>,
    []
  >;
}

type TestClient =
  Client & {
    eventsAttached?: boolean;
    pupPage?: TestPage;
  };

interface PageAuthProbeResult {
  connected: boolean;
  hasSynced: boolean;
  hasIdentity: boolean;
  replayed: boolean;
}

function flushPromises(
  turns = 12,
): Promise<void> {
  return new Promise(resolve => {
    const run =
      async () => {
        for (
          let index = 0;
          index < turns;
          index += 1
        ) {
          await Promise.resolve();
        }

        resolve();
      };

    void run();
  });
}

function createClient({
  state = WAState.OPENING,
  hasIdentity = true,
  eventsAttached = true,
  hasWWebJS = true,
  evaluateResults = [],
}: {
  state?: WAState;
  hasIdentity?: boolean;
  eventsAttached?: boolean;
  hasWWebJS?: boolean;
  evaluateResults?: unknown[];
} = {}): TestClient {
  const evaluate =
    jest.fn<
      Promise<unknown>,
      [unknown, ...unknown[]]
    >();

  for (const result of evaluateResults) {
    evaluate.mockResolvedValueOnce(result);
  }

  evaluate.mockResolvedValue(
    hasWWebJS,
  );

  const page: TestPage = {
    evaluate,
    reload:
      jest.fn().mockResolvedValue(
        undefined,
      ),
  };

  return {
    getState:
      jest.fn().mockResolvedValue(
        state,
      ),
    info:
      hasIdentity
        ? {
            wid: {
              user:
                '201000000000',
            },
          }
        : undefined,
    eventsAttached,
    pupPage:
      page,
  } as unknown as TestClient;
}

function createHost(
  client: TestClient,
  initialStatus =
    EngineStatus.AUTHENTICATING,
) {
  let status =
    initialStatus;

  const callbacks: EngineEventCallbacks = {
    onError:
      jest.fn(),
  };

  const logger = {
    debug:
      jest.fn(),
    warn:
      jest.fn(),
    error:
      jest.fn(),
  } as unknown as
    WwebjsReadyReconcileHost['logger'];

  const markReadyFromClientInfo =
    jest.fn(() => {
      status =
        EngineStatus.READY;
    });

  const recoverFromStuckAuth =
    jest.fn().mockResolvedValue(
      undefined,
    );

  const setStatus =
    jest.fn(
      (
        nextStatus:
          EngineStatus,
      ) => {
        status =
          nextStatus;
      },
    );

  const beginNavigationReinjectWindow =
    jest.fn();

  const host:
    WwebjsReadyReconcileHost = {
      logger,
      config: {
        sessionId:
          'session-1',
      } as WhatsAppWebJsConfig,
      getClient:
        () => client,
      getStatus:
        () => status,
      setStatus,
      getCallbacks:
        () => callbacks,
      markReadyFromClientInfo,
      recoverFromStuckAuth,
      beginNavigationReinjectWindow,
    };

  return {
    host,
    callbacks,
    markReadyFromClientInfo,
    recoverFromStuckAuth,
    beginNavigationReinjectWindow,
    setStatus,
    getStatus:
      () => status,
  };
}

describe('WwebjsReadyReconcile', () => {
  const originalReadyTimeout =
    process.env.WWEBJS_READY_TIMEOUT_MS;

  beforeEach(() => {
    jest.useFakeTimers();
    delete process.env.WWEBJS_READY_TIMEOUT_MS;
  });

  afterEach(() => {
    jest.useRealTimers();

    if (originalReadyTimeout === undefined) {
      delete process.env.WWEBJS_READY_TIMEOUT_MS;
    } else {
      process.env.WWEBJS_READY_TIMEOUT_MS =
        originalReadyTimeout;
    }
  });

  it('promotes AUTHENTICATING to READY when the live runtime is usable', async () => {
    const client =
      createClient({
        state:
          WAState.CONNECTED,
        hasIdentity:
          true,
        eventsAttached:
          true,
        hasWWebJS:
          true,
      });

    const {
      host,
      markReadyFromClientInfo,
      recoverFromStuckAuth,
    } =
      createHost(
        client,
      );

    const reconcile =
      new WwebjsReadyReconcile(
        host,
      );

    reconcile.scheduleReadyReconcile();

    jest.advanceTimersByTime(
      2_000,
    );

    await flushPromises();

    expect(
      markReadyFromClientInfo,
    ).toHaveBeenCalledTimes(
      1,
    );

    expect(
      recoverFromStuckAuth,
    ).not.toHaveBeenCalled();

    reconcile.clearReadyReconcile();
  });

  it('moves QR_READY to AUTHENTICATING when the page proves CONNECTED plus identity', async () => {
    const pageProbe:
      PageAuthProbeResult = {
        connected:
          true,
        hasSynced:
          false,
        hasIdentity:
          true,
        replayed:
          false,
      };

    const client =
      createClient({
        state:
          WAState.OPENING,
        hasIdentity:
          false,
        evaluateResults: [
          pageProbe,
        ],
      });

    const {
      host,
      getStatus,
      setStatus,
      markReadyFromClientInfo,
      recoverFromStuckAuth,
    } =
      createHost(
        client,
        EngineStatus.QR_READY,
      );

    const reconcile =
      new WwebjsReadyReconcile(
        host,
      );

    reconcile.scheduleAuthReconcile();

    jest.advanceTimersByTime(
      2_000,
    );

    await flushPromises();

    expect(
      setStatus,
    ).toHaveBeenCalledWith(
      EngineStatus.AUTHENTICATING,
    );

    expect(
      getStatus(),
    ).toBe(
      EngineStatus.AUTHENTICATING,
    );

    // CONNECTED proves pairing, not full message-bridge readiness.
    expect(
      markReadyFromClientInfo,
    ).not.toHaveBeenCalled();

    expect(
      recoverFromStuckAuth,
    ).not.toHaveBeenCalled();

    const internal =
      reconcile as unknown as {
        hasObservedConnected:
          boolean;
        qrConnectedObservedAt:
          number;
      };

    expect(
      internal.hasObservedConnected,
    ).toBe(
      true,
    );

    expect(
      internal.qrConnectedObservedAt,
    ).toBeGreaterThan(
      0,
    );

    reconcile.clearReadyReconcile();
  });

  it('does not leave QR_READY from page CONNECTED alone when own identity is absent', async () => {
    const pageProbe:
      PageAuthProbeResult = {
        connected:
          true,
        hasSynced:
          false,
        hasIdentity:
          false,
        replayed:
          false,
      };

    const client =
      createClient({
        state:
          WAState.OPENING,
        hasIdentity:
          false,
        evaluateResults: [
          pageProbe,
        ],
      });

    const {
      host,
      getStatus,
      setStatus,
    } =
      createHost(
        client,
        EngineStatus.QR_READY,
      );

    const reconcile =
      new WwebjsReadyReconcile(
        host,
      );

    reconcile.scheduleAuthReconcile();

    jest.advanceTimersByTime(
      2_000,
    );

    await flushPromises();

    expect(
      getStatus(),
    ).toBe(
      EngineStatus.QR_READY,
    );

    expect(
      setStatus,
    ).not.toHaveBeenCalledWith(
      EngineStatus.AUTHENTICATING,
    );

    reconcile.clearAuthReconcile();
  });

  it('reinjects once after page-confirmed pairing stays runtime-incomplete beyond the grace window', async () => {
    const pageProbe:
      PageAuthProbeResult = {
        connected:
          true,
        hasSynced:
          false,
        hasIdentity:
          true,
        replayed:
          false,
      };

    const client =
      createClient({
        state:
          WAState.OPENING,
        hasIdentity:
          false,
        evaluateResults: [
          pageProbe,
        ],
      });

    const {
      host,
      getStatus,
      recoverFromStuckAuth,
      beginNavigationReinjectWindow,
    } =
      createHost(
        client,
        EngineStatus.QR_READY,
      );

    const reconcile =
      new WwebjsReadyReconcile(
        host,
      );

    reconcile.scheduleAuthReconcile();

    jest.advanceTimersByTime(
      2_000,
    );

    await flushPromises();

    expect(
      getStatus(),
    ).toBe(
      EngineStatus.AUTHENTICATING,
    );

    const internal =
      reconcile as unknown as {
        qrConnectedObservedAt:
          number;
      };

    internal.qrConnectedObservedAt =
      Date.now() -
      QR_CONNECTED_REINJECT_GRACE_MS -
      1;

    jest.advanceTimersByTime(
      2_000,
    );

    await flushPromises();

    const page =
      client.pupPage as TestPage;

    expect(
      beginNavigationReinjectWindow,
    ).toHaveBeenCalledWith(
      'qr_connected_runtime_reinject',
    );

    expect(
      page.reload,
    ).toHaveBeenCalledTimes(
      1,
    );

    expect(
      beginNavigationReinjectWindow.mock.invocationCallOrder[0],
    ).toBeLessThan(
      page.reload.mock.invocationCallOrder[0],
    );

    expect(
      recoverFromStuckAuth,
    ).not.toHaveBeenCalled();

    // The reload budget is one-shot even if readiness remains incomplete.
    jest.advanceTimersByTime(
      4_000,
    );

    await flushPromises();

    expect(
      page.reload,
    ).toHaveBeenCalledTimes(
      1,
    );

    reconcile.clearReadyReconcile();
  });

  it('resolves WWEBJS_READY_TIMEOUT_MS for each readiness run', () => {
    process.env.WWEBJS_READY_TIMEOUT_MS =
      '300000';

    const client =
      createClient();

    const {
      host,
    } =
      createHost(
        client,
      );

    const reconcile =
      new WwebjsReadyReconcile(
        host,
      );

    reconcile.scheduleReadyReconcile();

    const internal =
      reconcile as unknown as {
        readyReconcileTimeoutMs:
          number;
      };

    expect(
      internal.readyReconcileTimeoutMs,
    ).toBe(
      300_000,
    );

    reconcile.clearReadyReconcile();

    expect(
      internal.readyReconcileTimeoutMs,
    ).toBe(
      READY_RECONCILE_TIMEOUT_MS,
    );
  });

  it('clears stuck auth only when the readiness deadline expires before CONNECTED', () => {
    process.env.WWEBJS_READY_TIMEOUT_MS =
      '90000';

    const client =
      createClient({
        state:
          WAState.OPENING,
      });

    const {
      host,
      recoverFromStuckAuth,
      setStatus,
    } =
      createHost(
        client,
      );

    const reconcile =
      new WwebjsReadyReconcile(
        host,
      );

    reconcile.scheduleReadyReconcile();

    const internal =
      reconcile as unknown as {
        readyReconcileStartedAt:
          number;
        hasObservedConnected:
          boolean;
      };

    internal.hasObservedConnected =
      false;
    internal.readyReconcileStartedAt =
      Date.now() -
      90_001;

    jest.advanceTimersByTime(
      2_000,
    );

    expect(
      recoverFromStuckAuth,
    ).toHaveBeenCalledTimes(
      1,
    );

    expect(
      setStatus,
    ).not.toHaveBeenCalledWith(
      EngineStatus.FAILED,
    );
  });

  it('keeps saved credentials when CONNECTED was reached but runtime readiness is incomplete', () => {
    process.env.WWEBJS_READY_TIMEOUT_MS =
      '90000';

    const client =
      createClient({
        state:
          WAState.CONNECTED,
        hasIdentity:
          true,
        eventsAttached:
          true,
        hasWWebJS:
          false,
      });

    const {
      host,
      callbacks,
      recoverFromStuckAuth,
      setStatus,
      getStatus,
    } =
      createHost(
        client,
      );

    const reconcile =
      new WwebjsReadyReconcile(
        host,
      );

    reconcile.scheduleReadyReconcile();

    const internal =
      reconcile as unknown as {
        readyReconcileStartedAt:
          number;
        hasObservedConnected:
          boolean;
      };

    internal.hasObservedConnected =
      true;
    internal.readyReconcileStartedAt =
      Date.now() -
      90_001;

    jest.advanceTimersByTime(
      2_000,
    );

    expect(
      recoverFromStuckAuth,
    ).not.toHaveBeenCalled();

    expect(
      setStatus,
    ).toHaveBeenCalledWith(
      EngineStatus.FAILED,
    );

    expect(
      getStatus(),
    ).toBe(
      EngineStatus.FAILED,
    );

    expect(
      callbacks.onError,
    ).toHaveBeenCalledTimes(
      1,
    );
  });

  it('keeps page-confirmed QR pairing at timeout even if client.getState never caught up', () => {
    process.env.WWEBJS_READY_TIMEOUT_MS =
      '90000';

    const client =
      createClient({
        state:
          WAState.OPENING,
        hasIdentity:
          false,
      });

    const {
      host,
      recoverFromStuckAuth,
      setStatus,
    } =
      createHost(
        client,
      );

    const reconcile =
      new WwebjsReadyReconcile(
        host,
      );

    reconcile.scheduleReadyReconcile();

    const internal =
      reconcile as unknown as {
        readyReconcileStartedAt:
          number;
        hasObservedConnected:
          boolean;
      };

    // This is the evidence carried forward by the QR page-level CONNECTED+identity fallback.
    internal.hasObservedConnected =
      true;
    internal.readyReconcileStartedAt =
      Date.now() -
      90_001;

    jest.advanceTimersByTime(
      2_000,
    );

    expect(
      recoverFromStuckAuth,
    ).not.toHaveBeenCalled();

    expect(
      setStatus,
    ).toHaveBeenCalledWith(
      EngineStatus.FAILED,
    );
  });

  it('keeps saved credentials when CONNECTED but the event bridge never attached', () => {
    process.env.WWEBJS_READY_TIMEOUT_MS =
      '90000';

    const client =
      createClient({
        state:
          WAState.CONNECTED,
        hasIdentity:
          true,
        eventsAttached:
          false,
        hasWWebJS:
          true,
      });

    const {
      host,
      recoverFromStuckAuth,
      setStatus,
    } =
      createHost(
        client,
      );

    const reconcile =
      new WwebjsReadyReconcile(
        host,
      );

    reconcile.scheduleReadyReconcile();

    const internal =
      reconcile as unknown as {
        readyReconcileStartedAt:
          number;
        hasObservedConnected:
          boolean;
      };

    internal.hasObservedConnected =
      true;
    internal.readyReconcileStartedAt =
      Date.now() -
      90_001;

    jest.advanceTimersByTime(
      2_000,
    );

    expect(
      recoverFromStuckAuth,
    ).not.toHaveBeenCalled();

    expect(
      setStatus,
    ).toHaveBeenCalledWith(
      EngineStatus.FAILED,
    );
  });
});



