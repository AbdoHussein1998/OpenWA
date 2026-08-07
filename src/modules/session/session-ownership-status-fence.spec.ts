import { SessionEngineEventWiring, SessionEngineWiringHost } from './session-engine-event-wiring';
import { SessionOwnershipService, nodeOwnsSession } from './session-ownership.service';
import { SessionStatus } from './entities/session.entity';
import { EngineStatus, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';

/**
 * A lease can lapse while this process is perfectly healthy — a slow query is enough — and the
 * heartbeat only tears the local engine down at its next tick. In that window `isLiveEngine` is
 * still true, so an engine callback could persist a status onto a row a peer already owns.
 *
 * FAILED is the expensive one and the reason this fence exists: it is excluded from the boot reset
 * (session.service's activeStatuses) AND from the takeover sweep (TAKEOVER_STATUSES), both by
 * design, so a session pushed into it leaves every automatic recovery path on every node until an
 * operator restarts it by hand. A node that no longer owns the session must not be able to do that.
 */
describe('engine status writes are fenced by ownership', () => {
  const ENGINE = { destroy: jest.fn() } as unknown as IWhatsAppEngine;

  /** A host that is live by every OTHER measure, so the ownership gate is the only variable. */
  const buildHost = (owns: boolean): { host: SessionEngineWiringHost; updateStatus: jest.Mock } => {
    const updateStatus = jest.fn().mockResolvedValue(undefined);
    const host = {
      isLiveEngine: () => true,
      ownsSession: () => owns,
      updateStatus,
      handleEngineReady: jest.fn(),
      handleEngineDisconnected: jest.fn().mockResolvedValue(undefined),
      cancelReconnect: jest.fn(),
      evictAndForceDestroy: jest.fn(),
      trackPendingCredentialTeardown: jest.fn(),
      reportRestrictionLifted: jest.fn(),
      claimStuckAuthRecovery: () => false,
      sessionErrors: { set: jest.fn(), clear: jest.fn(), get: jest.fn() },
      sessionRestrictions: { set: jest.fn(), clear: jest.fn(), get: jest.fn() },
      presence: { set: jest.fn(), clear: jest.fn() },
      messages: { handleInboundMessage: jest.fn(), handleHistoryMessages: jest.fn() },
      statusStore: { record: jest.fn() },
      webhookService: { dispatch: jest.fn() },
      eventsGateway: { emitQRCode: jest.fn(), emitSessionStatus: jest.fn() },
      hookManager: { execute: jest.fn().mockResolvedValue(undefined) },
    } as unknown as SessionEngineWiringHost;
    return { host, updateStatus };
  };

  const callbacks = (owns: boolean) => {
    const { host, updateStatus } = buildHost(owns);
    const wiring = new SessionEngineEventWiring({ logger: createLogger('test') });
    return { cb: wiring.buildCallbacks('sess-1', ENGINE, 'sess-1-name', host), updateStatus };
  };

  it('persists engine-driven statuses while this node owns the session', () => {
    const { cb, updateStatus } = callbacks(true);

    cb.onQRCode?.('qr-data');
    cb.onStateChanged?.(EngineStatus.READY);
    cb.onError?.('engine blew up');

    expect(updateStatus.mock.calls.map((call: [string, SessionStatus]) => call[1])).toEqual([
      SessionStatus.QR_READY,
      SessionStatus.READY,
      SessionStatus.FAILED,
    ]);
  });

  it('writes NOTHING once the lease is gone — above all not FAILED, which nothing resets', () => {
    const { cb, updateStatus } = callbacks(false);

    cb.onQRCode?.('qr-data');
    cb.onStateChanged?.(EngineStatus.READY);
    cb.onStateChanged?.(EngineStatus.FAILED);
    cb.onError?.('engine blew up');

    expect(updateStatus).not.toHaveBeenCalled();
  });
});

describe('SessionOwnershipService.owns', () => {
  const build = (): SessionOwnershipService =>
    new SessionOwnershipService({ createQueryBuilder: jest.fn() } as never, undefined);

  it('is false for a session this process never claimed', () => {
    expect(build().owns('never-claimed')).toBe(false);
  });

  it('tracks exactly what ownedIds reports, so the fence and the register cannot disagree', () => {
    const svc = build();
    // ownedIds() is the existing test seam; owns() must be its membership test, not a second source
    // of truth that could drift from it.
    for (const id of svc.ownedIds()) expect(svc.owns(id)).toBe(true);
    expect(svc.owns('absent')).toBe(svc.ownedIds().includes('absent'));
  });
});

describe('nodeOwnsSession default', () => {
  // The single most dangerous way to get this wrong: defaulting to false. Every single-process
  // deployment and every direct-construction spec has no ownership service, so a false default would
  // stop persisting engine statuses entirely rather than fencing a rare cross-node write.
  it('is TRUE when no ownership service is wired', () => {
    expect(nodeOwnsSession(undefined, 'any-session')).toBe(true);
  });

  it('delegates to the service when one is wired', () => {
    const owns = jest.fn().mockReturnValue(false);
    expect(nodeOwnsSession({ owns }, 'sess-1')).toBe(false);
    expect(owns).toHaveBeenCalledWith('sess-1');

    expect(nodeOwnsSession({ owns: jest.fn().mockReturnValue(true) }, 'sess-1')).toBe(true);
  });
});
