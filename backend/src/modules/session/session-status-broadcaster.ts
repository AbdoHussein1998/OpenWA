import { Repository } from 'typeorm';
import { Session, SessionStatus } from './entities/session.entity';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { type createLogger } from '../../common/services/logger.service';

/**
 * The session-status fan-out extracted from SessionEngineLifecycle: persist the status, then
 * mirror it to WS clients and subscribed webhooks, de-duped. Plain class (NOT a NestJS provider —
 * the lifecycle's constructor signature is frozen by specs), built inside the lifecycle's
 * constructor. The de-dup Map is OWNED here; the lifecycle exposes a `lastDispatchedStatus`
 * getter alias returning it by reference (the liveCalls precedent) so the spec's `.set()` pokes
 * land on this exact instance, and keeps `updateStatus` as a public delegate so its 9 call sites
 * stay byte-identical. The method body below moved verbatim, which is why it reads
 * `this.sessionRepository` / `this.eventsGateway` / `this.webhookService` / `this.logger` against
 * the same-named fields assigned here.
 */
export class SessionStatusBroadcaster {
  // Last session.status value broadcast per session. Some engines signal one transition via BOTH
  // onStateChanged and a dedicated callback (onQRCode/onDisconnected), so this guards both the WS emit
  // and the webhook POST against firing the same status twice. Cleared on delete().
  readonly lastDispatchedStatus = new Map<string, SessionStatus>();
  // Serialize every status mutation by UUID. The engine is event-driven and some callers intentionally
  // do not await their write; without this queue a delayed QR/READY write can overtake DISCONNECTED.
  // A rejected write must not poison subsequent updates or strand the queue.
  private readonly pendingWrites = new Map<string, Promise<void>>();

  private readonly sessionRepository: Repository<Session>;
  private readonly eventsGateway: EventsGateway;
  private readonly webhookService: WebhookService;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(deps: {
    sessionRepository: Repository<Session>;
    eventsGateway: EventsGateway;
    webhookService: WebhookService;
    logger: ReturnType<typeof createLogger>;
  }) {
    this.sessionRepository = deps.sessionRepository;
    this.eventsGateway = deps.eventsGateway;
    this.webhookService = deps.webhookService;
    this.logger = deps.logger;
  }

  /** Enqueue synchronously so invocation order, not database completion order, wins. */
  private enqueue(id: string, write: () => Promise<void>): Promise<void> {
    const previous = this.pendingWrites.get(id);
    // Run the first write immediately (preserves the INITIALIZING retirement fence's timing).
    const pending = previous ? previous.catch(() => undefined).then(write) : write();
    this.pendingWrites.set(id, pending);
    // Avoid an unhandled rejection from the cleanup continuation. Never remove a newer task.
    void pending.then(
      () => { if (this.pendingWrites.get(id) === pending) this.pendingWrites.delete(id); },
      () => { if (this.pendingWrites.get(id) === pending) this.pendingWrites.delete(id); },
    );
    return pending;
  }

  updateStatus(id: string, status: SessionStatus): Promise<void> {
    return this.enqueue(id, () => this.persistAndBroadcast(id, status, { status }));
  }

  /** Keep READY identity/timestamps in the SAME per-session queue as status transitions. */
  updateReady(id: string, phone: string, pushName: string, stillCurrent?: () => boolean): Promise<void> {
    return this.enqueue(id, async () => {
      // The engine can retire while waiting for an earlier database write to settle.
      if (stillCurrent && !stillCurrent()) return;
      const at = new Date();
      await this.persistAndBroadcast(id, SessionStatus.READY, {
        status: SessionStatus.READY,
        phone,
        pushName,
        connectedAt: at,
        lastActiveAt: at,
      });
    });
  }

  /** Used by permanent deletion so no old status mutation can land after parent-row removal. */
  async awaitIdle(id: string): Promise<void> {
    // Queue may have a previous rejected write: deletion must still be able to proceed.
    await this.pendingWrites.get(id)?.catch(() => undefined);
  }

  private async persistAndBroadcast(
    id: string,
    status: SessionStatus,
    patch: Parameters<Repository<Session>['update']>[1],
  ): Promise<void> {
    await this.sessionRepository.update(id, patch);
    this.logger.debug(`Session status updated to ${status}`, {
      sessionId: id,
      status,
      action: 'status_update',
    });
    // Never publish a status before its database write settles.
    if (this.lastDispatchedStatus.get(id) !== status) {
      this.lastDispatchedStatus.set(id, status);
      this.eventsGateway.emitSessionStatus(id, status);
      void this.webhookService.dispatch(id, 'session.status', { sessionId: id, status });
    }
  }

  /** Drop the de-dup entry for a session — called from delete()'s committed-delete cleanup. */
  clear(id: string): void {
    this.lastDispatchedStatus.delete(id);
  }
}
