import { HttpException, HttpStatus, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { Message, MessageDirection } from './entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { resolveSendPacingConfig, type SendPacingConfig } from './send-pacing.config';
import { incrementSendPacingRefusals, type SendPacingRefusalReason } from '../../common/metrics/send-pacing-metrics';
import { createLogger } from '../../common/services/logger.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';

/** Body code on a pacing refusal. The throttler's own 429 carries no `code`, which is what tells the two apart. */
export const SEND_PACING_LIMITED = 'SEND_PACING_LIMITED';

/** Per-session breaker state. Deliberately in memory — see the class doc. */
interface BreakerState {
  consecutiveFailures: number;
  /** Epoch ms the breaker opened, or null while it is closed. */
  openedAt: number | null;
}

/** Refusals suppressed since the last audited one, per session. */
interface RefusalSample {
  count: number;
  since: number;
}

/**
 * At most one `SEND_PACING_BLOCKED` row per session per window. A session that hits its daily cap
 * goes on being refused for the rest of the day, so one row per refused send would turn enforcing
 * the limit into an audit flood of its own — the same problem, and the same answer, as the
 * websocket rate limiter's `RATE_LIMIT_EXCEEDED` sampling.
 */
const REFUSAL_AUDIT_WINDOW_MS = 60_000;
/** Bound on the sampling map, so a churn of session ids cannot grow it without limit. */
const MAX_REFUSAL_KEYS = 1000;

/**
 * Refuses outbound sends that a young or misbehaving session should not be making.
 *
 * Two rules, both aimed at the way WhatsApp actually bans automated accounts:
 *
 *  - a **warm-up daily cap**, because a new account that immediately sends at volume is the pattern
 *    that gets numbers banned. The allowance grows with the session's age.
 *  - a **failure-streak breaker**, because a run of consecutive send failures usually means WhatsApp
 *    has already started refusing this account, and continuing to push makes its standing worse.
 *
 * It is plain code called from the send paths, NOT a `message:sending` hook subscriber. That is
 * load-bearing: `runGuarded` (plugin-capability-context.ts) suppresses `message:sending` when a
 * plugin sends from inside its own handler, so a hook-based governor would be silently bypassed on
 * exactly the automated traffic it exists to pace.
 *
 * The daily count is read from the `messages` table rather than a counter of its own. That table is
 * already the durable record of every send — bulk included, which persists through the same
 * `saveOutgoingMessage` — and it already carries the `(sessionId, createdAt)` index the count needs.
 * So the cap survives restarts with no table, no migration, and no way to drift from what was really
 * sent. The breaker, by contrast, is in memory on purpose: it describes live conditions, and a
 * restart clearing it is the correct behaviour.
 */
@Injectable()
export class SendPacingService {
  private readonly logger = createLogger('SendPacingService');
  private readonly breakers = new Map<string, BreakerState>();
  private readonly refusalSamples = new Map<string, RefusalSample>();

  constructor(
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    @Optional()
    private readonly configService?: ConfigService,
    // @Optional so the standalone constructions in specs keep working. AuditModule is @Global, so in
    // a running gateway it is always present; absent means the console log is the only record.
    @Optional()
    private readonly auditService?: AuditService,
  ) {}

  /**
   * Throw unless this session may send right now. Called at the top of every outbound send path.
   *
   * When the feature is off this returns before doing anything at all — no query, no map lookup — so
   * a deployment that has not opted in behaves exactly as it did before the governor existed.
   */
  async assertSendAllowed(sessionId: string, chatId?: string): Promise<void> {
    const config = resolveSendPacingConfig(this.configService);
    if (!config.enabled) return;

    this.assertBreakerClosed(sessionId, config);
    await this.assertUnderDailyCap(sessionId, config);
    await this.assertUnderColdCap(sessionId, chatId, config);
  }

  /**
   * Record a send that failed. A run of these trips the breaker.
   *
   * Only called on failures that reached WhatsApp and came back refused — a validation error thrown
   * before the engine is asked says nothing about the account's standing and must not count, or a
   * client sending malformed requests could trip the breaker on a perfectly healthy session.
   */
  recordSendFailure(sessionId: string): void {
    const config = resolveSendPacingConfig(this.configService);
    if (!config.enabled) return;

    const breaker = this.breakerFor(sessionId);
    breaker.consecutiveFailures += 1;
    if (breaker.openedAt === null && breaker.consecutiveFailures >= config.breakerThreshold) {
      breaker.openedAt = Date.now();
      this.logger.warn(`Send breaker tripped after ${breaker.consecutiveFailures} consecutive failures`, {
        sessionId,
        consecutiveFailures: breaker.consecutiveFailures,
        cooldownMs: config.breakerCooldownMs,
        action: 'send_breaker_tripped',
      });
      // Never sampled: a trip is rare and is the event an operator most wants to find afterwards.
      void this.auditService?.logWarn(AuditAction.SEND_BREAKER_TRIPPED, {
        sessionId,
        metadata: { consecutiveFailures: breaker.consecutiveFailures, cooldownMs: config.breakerCooldownMs },
        errorMessage: `Send breaker tripped after ${breaker.consecutiveFailures} consecutive send failures`,
      });
    }
  }

  /** Record a send that succeeded, which ends any streak in progress. */
  recordSendSuccess(sessionId: string): void {
    const config = resolveSendPacingConfig(this.configService);
    if (!config.enabled) return;

    const breaker = this.breakers.get(sessionId);
    if (!breaker) return;
    // A success proves the account is being served, so the streak resets AND an open breaker closes.
    // Nothing else closes it early: the cooldown is what normally lets traffic back through.
    this.breakers.delete(sessionId);
  }

  /** The allowance for a session this many whole days old, saturating at the schedule's last entry. */
  private allowanceForAge(schedule: number[], ageDays: number): number {
    const index = Math.min(Math.max(ageDays, 0), schedule.length - 1);
    return schedule[index];
  }

  private breakerFor(sessionId: string): BreakerState {
    const existing = this.breakers.get(sessionId);
    if (existing) return existing;
    const created: BreakerState = { consecutiveFailures: 0, openedAt: null };
    this.breakers.set(sessionId, created);
    return created;
  }

  private assertBreakerClosed(sessionId: string, config: SendPacingConfig): void {
    const breaker = this.breakers.get(sessionId);
    if (!breaker?.openedAt) return;

    const elapsed = Date.now() - breaker.openedAt;
    if (elapsed >= config.breakerCooldownMs) {
      // Cooldown served. Dropping the entry rather than zeroing it is what keeps the map bounded by
      // the number of sessions currently in trouble instead of every session that ever failed — and
      // it is equivalent, since the next failure recreates it at a count of one either way.
      this.breakers.delete(sessionId);
      return;
    }
    this.refuse('breaker_open', sessionId, Math.ceil((config.breakerCooldownMs - elapsed) / 1000), {
      reason: 'Sends are paused after a run of consecutive send failures',
    });
  }

  private async assertUnderDailyCap(sessionId: string, config: SendPacingConfig): Promise<void> {
    const session = await this.sessionRepository.findOne({ where: { id: sessionId } });
    // No row means the send is about to fail on its own for a better reason than pacing; let it.
    if (!session) return;

    const dayStart = startOfUtcDay(new Date());
    // Age from createdAt, NOT connectedAt: connectedAt is overwritten on every connect, so a session
    // that reconnects would look one day old forever and never leave the first rung of the ramp.
    const ageDays = Math.floor((dayStart.getTime() - startOfUtcDay(session.createdAt).getTime()) / DAY_MS);
    const allowance = this.allowanceForAge(config.warmupSchedule, ageDays);

    const sentToday = await this.messageRepository.count({
      where: { sessionId, direction: MessageDirection.OUTGOING, createdAt: MoreThanOrEqual(dayStart) },
    });
    if (sentToday < allowance) return;

    this.refuse('daily_cap', sessionId, secondsUntilNextUtcDay(), {
      reason: `Daily send allowance of ${allowance} reached for a session ${ageDays} day(s) old`,
      allowance,
      sentToday,
    });
  }

  /**
   * Write one audit row per session per window, folding the refusals suppressed in between into the
   * next row's `suppressed` metadata — so the trail stays accurate without one write per refused
   * send. Modelled on the websocket limiter's own sampling, which exists for the same reason.
   */
  private auditRefusal(
    sessionId: string,
    rule: SendPacingRefusalReason,
    retryAfterSeconds: number,
    message: string,
  ): void {
    const now = Date.now();
    const prior = this.refusalSamples.get(sessionId);
    if (prior && now - prior.since < REFUSAL_AUDIT_WINDOW_MS) {
      prior.count += 1;
      return;
    }
    const suppressed = prior?.count ?? 0;
    // Re-insert rather than mutate, so the map stays in insertion order and the eviction below
    // really does drop the least recently audited session.
    this.refusalSamples.delete(sessionId);
    this.refusalSamples.set(sessionId, { count: 0, since: now });
    while (this.refusalSamples.size > MAX_REFUSAL_KEYS) {
      const oldest = this.refusalSamples.keys().next().value;
      if (oldest === undefined) break;
      this.refusalSamples.delete(oldest);
    }
    void this.auditService?.logWarn(AuditAction.SEND_PACING_BLOCKED, {
      sessionId,
      metadata: { rule, retryAfterSeconds, suppressed },
      errorMessage: message,
    });
  }

  /**
   * Refuse a cold reachout once the day's allowance for them is spent.
   *
   * "Cold" means this account has no history with the chat in EITHER direction: answering someone
   * who wrote to you first is not a reachout, and counting it as one would throttle exactly the
   * traffic WhatsApp wants to see. A chat with no `chatId` (a status post) is not addressed to
   * anyone, so the rule does not apply to it.
   *
   * The cheap probe runs first and settles most sends in one indexed lookup; the aggregate that
   * counts the day's cold reachouts only runs when this send is itself cold.
   */
  private async assertUnderColdCap(
    sessionId: string,
    chatId: string | undefined,
    config: SendPacingConfig,
  ): Promise<void> {
    if (!chatId || config.coldSchedule.length === 0) return;

    // Any row at all, either direction, any time: one message from them, or one from us last month,
    // and this is an existing relationship rather than a reachout. The send being checked has not
    // persisted its own row yet — the gate runs before saveOutgoingMessage — so this cannot see it.
    const hasHistory = await this.messageRepository.exists({ where: { sessionId, chatId } });
    if (hasHistory) return;

    const session = await this.sessionRepository.findOne({ where: { id: sessionId } });
    if (!session) return;

    const dayStart = startOfUtcDay(new Date());
    const ageDays = Math.floor((dayStart.getTime() - startOfUtcDay(session.createdAt).getTime()) / DAY_MS);
    const allowance = this.allowanceForAge(config.coldSchedule, ageDays);
    const coldToday = await this.countColdReachoutsToday(sessionId, dayStart);
    if (coldToday < allowance) return;

    this.refuse('cold_daily_cap', sessionId, secondsUntilNextUtcDay(), {
      reason: `Daily allowance of ${allowance} new conversation(s) reached for a session ${ageDays} day(s) old`,
      allowance,
      coldToday,
    });
  }

  /**
   * Distinct chats this session started today: it sent to them today, and nothing in the chat
   * predates today. Expressed as a NOT EXISTS rather than a `MIN(createdAt)` group-by so it stays on
   * the `(sessionId, createdAt)` and `chatId` indexes instead of grouping the whole table.
   */
  private countColdReachoutsToday(sessionId: string, dayStart: Date): Promise<number> {
    return (
      this.messageRepository
        .createQueryBuilder('m')
        .select('COUNT(DISTINCT m.chatId)', 'count')
        .where('m.sessionId = :sessionId', { sessionId })
        .andWhere('m.direction = :direction', { direction: MessageDirection.OUTGOING })
        .andWhere('m.createdAt >= :dayStart', { dayStart })
        // Identifiers are quoted because the columns really are camelCase (`"chatId"`, not `chat_id`)
        // — there is no snake_case naming strategy on this connection. Unquoted, Postgres would fold
        // them to lowercase and the query would fail at runtime on the very first cold send.
        .andWhere(
          'NOT EXISTS (SELECT 1 FROM "messages" p WHERE p."sessionId" = :sessionId AND p."chatId" = m."chatId" AND p."createdAt" < :dayStart)',
        )
        .getRawOne<{ count: string | number }>()
        .then(row => Number(row?.count ?? 0))
    );
  }

  private refuse(
    reason: SendPacingRefusalReason,
    sessionId: string,
    retryAfterSeconds: number,
    detail: { reason: string } & Record<string, unknown>,
  ): never {
    incrementSendPacingRefusals(reason);
    this.logger.warn(`Send refused by the pacing governor: ${detail.reason}`, {
      ...detail,
      sessionId,
      rule: reason,
      retryAfterSeconds,
      action: 'send_paced',
    });
    this.auditRefusal(sessionId, reason, retryAfterSeconds, detail.reason);
    // 429 with a body `code`, which is what distinguishes this from the global throttler's own 429 —
    // a client that retries blindly on 429 would otherwise treat a day-long cap like a one-second
    // rate limit. `retryAfterSeconds` says how long the refusal actually lasts.
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message: detail.reason,
        code: SEND_PACING_LIMITED,
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

const DAY_MS = 86_400_000;

/**
 * The cap's day boundary is UTC, not the server's local midnight: a deployment that moves timezone,
 * or replicas in different ones, must not disagree about when the allowance resets.
 */
function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

function secondsUntilNextUtcDay(): number {
  const now = Date.now();
  return Math.max(1, Math.ceil((startOfUtcDay(new Date(now)).getTime() + DAY_MS - now) / 1000));
}
