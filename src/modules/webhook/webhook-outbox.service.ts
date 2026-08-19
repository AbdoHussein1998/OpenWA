import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { WebhookOutboxEvent, WebhookOutboxState } from './entities/webhook-outbox-event.entity';
import { createLogger } from '../../common/services/logger.service';
import { isUniqueViolation } from '../../common/utils/db-errors';

/** What a replay needs to redispatch one delivery without deriving a new idempotency key. */
export interface ReplayableDelivery {
  id: string;
  webhookId: string;
  sessionId: string;
  event: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * Row lifecycle for the outbound delivery record.
 *
 * Every write here is best-effort and swallowed: fan-out is fire-and-forget from the projector, so
 * a repository failure must not turn into an unhandled rejection or stop a delivery that would
 * otherwise succeed. Losing the record degrades to the behaviour that existed before it.
 */
@Injectable()
export class WebhookOutboxService {
  private readonly logger = createLogger('WebhookOutboxService');

  constructor(
    @InjectRepository(WebhookOutboxEvent, 'data')
    private readonly outbox: Repository<WebhookOutboxEvent>,
  ) {}

  /**
   * Record the delivery as pending, before anything durable owns it.
   *
   * A conflict on (webhookId, idempotencyKey) means this exact delivery is being replayed, so the
   * existing row is kept rather than duplicated: the stored key is what makes the retry
   * deduplicable at the receiver.
   */
  async open(row: Omit<ReplayableDelivery, 'id' | 'attempts'> & { deliveryId: string }): Promise<void> {
    try {
      await this.outbox.save(
        this.outbox.create({
          webhookId: row.webhookId,
          sessionId: row.sessionId,
          event: row.event,
          idempotencyKey: row.idempotencyKey,
          deliveryId: row.deliveryId,
          payload: row.payload,
          state: 'pending',
          attempts: 0,
        }),
      );
    } catch (error) {
      // A conflict means this exact delivery is already recorded, which is what a replay looks
      // like: keep the existing row rather than duplicating it.
      if (isUniqueViolation(error)) return;
      this.logger.warn(`Could not record outbound delivery ${row.deliveryId}: ${String(error)}`);
    }
  }

  /**
   * Record the outcome and retire the payload.
   *
   * `dispatched` covers both modes: handed to the queue, or completed inline. A failure INSIDE
   * either owner dead-letters through webhook_delivery_failures, so a dispatched row is never the
   * reconciler's concern, and retiring on ENQUEUE is what stops the reconciler duplicating work
   * BullMQ already holds.
   */
  async close(webhookId: string, idempotencyKey: string, state: Exclude<WebhookOutboxState, 'pending'>): Promise<void> {
    try {
      await this.outbox.update({ webhookId, idempotencyKey }, { state, payload: null, lastAttemptAt: new Date() });
    } catch (error) {
      this.logger.warn(`Could not close outbound delivery record: ${String(error)}`);
    }
  }

  /** Pending rows older than the staleness window, oldest first. Only these are replayable. */
  async findStale(olderThan: Date, limit: number): Promise<ReplayableDelivery[]> {
    const rows = await this.outbox.find({
      where: { state: 'pending', createdAt: LessThan(olderThan) },
      order: { createdAt: 'ASC' },
      take: limit,
    });
    // A pending row always carries its payload; the guard is for a row whose payload was retired by
    // a concurrent close between the query and this read.
    return rows
      .filter((r): r is WebhookOutboxEvent & { payload: Record<string, unknown> } => r.payload !== null)
      .map(r => ({
        id: r.id,
        webhookId: r.webhookId,
        sessionId: r.sessionId,
        event: r.event,
        idempotencyKey: r.idempotencyKey,
        payload: r.payload,
        attempts: r.attempts,
      }));
  }

  /** Count one replay attempt against the row's budget. */
  async countAttempt(id: string, attempts: number): Promise<void> {
    try {
      await this.outbox.update({ id }, { attempts: attempts + 1, lastAttemptAt: new Date() });
    } catch (error) {
      this.logger.warn(`Could not count a replay attempt: ${String(error)}`);
    }
  }
}
