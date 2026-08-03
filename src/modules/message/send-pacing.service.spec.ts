import { HttpException } from '@nestjs/common';
import { SendPacingService, SEND_PACING_LIMITED } from './send-pacing.service';
import { computeSendPacingConfig, type SendPacingConfig } from './send-pacing.config';
import { getSendPacingRefusals, resetSendPacingRefusals } from '../../common/metrics/send-pacing-metrics';
import { MessageDirection, type Message } from './entities/message.entity';
import type { Session } from '../session/entities/session.entity';
import type { Repository } from 'typeorm';
import type { ConfigService } from '@nestjs/config';
import { MessageService } from './message.service';
import { BulkMessageService } from './bulk-message.service';
import { StatusService } from '../status/status.service';
import { CatalogService } from '../catalog/catalog.service';

const DAY_MS = 86_400_000;

/** A session that first existed `ageDays` whole UTC days ago. */
const sessionAged = (ageDays: number): Session =>
  ({ id: 's1', createdAt: new Date(Date.now() - ageDays * DAY_MS) }) as Session;

interface Harness {
  service: SendPacingService;
  count: jest.Mock;
  findOne: jest.Mock;
}

const build = (
  config: Partial<SendPacingConfig> = {},
  sentToday = 0,
  session: Session | null = sessionAged(0),
): Harness => {
  const count = jest.fn().mockResolvedValue(sentToday);
  const findOne = jest.fn().mockResolvedValue(session);
  const configService = {
    get: (key: string) =>
      key === 'sendPacing' ? { ...computeSendPacingConfig({}), enabled: true, ...config } : undefined,
  } as unknown as ConfigService;
  const service = new SendPacingService(
    { count } as unknown as Repository<Message>,
    { findOne } as unknown as Repository<Session>,
    configService,
  );
  return { service, count, findOne };
};

/** Assert the throw is the pacing 429 and hand back its body for further checks. */
const expectPacingRefusal = async (promise: Promise<unknown>): Promise<Record<string, unknown>> => {
  await expect(promise).rejects.toBeInstanceOf(HttpException);
  const error = await promise.then(
    () => null,
    (e: HttpException) => e,
  );
  expect(error?.getStatus()).toBe(429);
  return error?.getResponse() as Record<string, unknown>;
};

describe('SendPacingService', () => {
  beforeEach(() => resetSendPacingRefusals());

  describe('when disabled', () => {
    // The disabled path must cost nothing and change nothing — a deployment that has not opted in
    // has to behave exactly as it did before this feature existed, including doing no DB work.
    it('allows the send without touching the database', async () => {
      const { service, count, findOne } = build({ enabled: false }, 999_999);

      await expect(service.assertSendAllowed('s1')).resolves.toBeUndefined();

      expect(count).not.toHaveBeenCalled();
      expect(findOne).not.toHaveBeenCalled();
    });

    it('ignores failures, so enabling it later does not start with a pre-tripped breaker', async () => {
      const { service } = build({ enabled: false });
      for (let i = 0; i < 50; i++) service.recordSendFailure('s1');

      const enabled = build({ breakerThreshold: 1 });
      await expect(enabled.service.assertSendAllowed('s1')).resolves.toBeUndefined();
    });
  });

  describe('the warm-up daily cap', () => {
    it('allows a send while the session is under its allowance', async () => {
      const { service } = build({ warmupSchedule: [10] }, 9);

      await expect(service.assertSendAllowed('s1')).resolves.toBeUndefined();
    });

    // The boundary is the whole point of a cap: at exactly the allowance the budget is spent.
    it('refuses the send that would exceed the allowance', async () => {
      const { service } = build({ warmupSchedule: [10] }, 10);

      const body = await expectPacingRefusal(service.assertSendAllowed('s1'));

      expect(body.code).toBe(SEND_PACING_LIMITED);
      expect(body.message).toContain('10');
    });

    // The ramp is the anti-ban mechanism: a day-old account must not get a mature account's budget.
    it('grows the allowance with the session age', async () => {
      const young = build({ warmupSchedule: [10, 100] }, 20, sessionAged(0));
      await expectPacingRefusal(young.service.assertSendAllowed('s1'));

      const older = build({ warmupSchedule: [10, 100] }, 20, sessionAged(1));
      await expect(older.service.assertSendAllowed('s1')).resolves.toBeUndefined();
    });

    // Beyond the schedule the last rung applies forever, rather than falling off the end into
    // undefined (which would compare as NaN and let everything through).
    it('saturates at the final rung for a session older than the schedule', async () => {
      const { service } = build({ warmupSchedule: [10, 100] }, 99, sessionAged(365));

      await expect(service.assertSendAllowed('s1')).resolves.toBeUndefined();
    });

    it("counts only this session's outgoing messages since the start of the UTC day", async () => {
      const { service, count } = build({ warmupSchedule: [10] }, 0);

      await service.assertSendAllowed('s1');

      const [[options]] = count.mock.calls as [[{ where: Record<string, unknown> }]];
      const where = options.where;
      expect(where.sessionId).toBe('s1');
      expect(where.direction).toBe(MessageDirection.OUTGOING);
      expect(where.createdAt).toBeDefined();
    });

    // A send for a session with no row is about to fail for a better reason than pacing; the
    // governor must not be the thing that reports it.
    it('stays out of the way when the session row is missing', async () => {
      const { service, count } = build({ warmupSchedule: [1] }, 99, null);

      await expect(service.assertSendAllowed('s1')).resolves.toBeUndefined();
      expect(count).not.toHaveBeenCalled();
    });

    it('tells the caller how long the refusal lasts', async () => {
      const { service } = build({ warmupSchedule: [1] }, 5);

      const body = await expectPacingRefusal(service.assertSendAllowed('s1'));

      // Until the next UTC midnight — never zero, or a client would retry immediately in a loop.
      expect(body.retryAfterSeconds).toBeGreaterThan(0);
      expect(body.retryAfterSeconds).toBeLessThanOrEqual(86_400);
    });
  });

  describe('the failure-streak breaker', () => {
    it('stays closed below the threshold', async () => {
      const { service } = build({ breakerThreshold: 3, warmupSchedule: [1000] });
      service.recordSendFailure('s1');
      service.recordSendFailure('s1');

      await expect(service.assertSendAllowed('s1')).resolves.toBeUndefined();
    });

    it('opens on the threshold failure and refuses further sends', async () => {
      const { service } = build({ breakerThreshold: 3, warmupSchedule: [1000] });
      service.recordSendFailure('s1');
      service.recordSendFailure('s1');
      service.recordSendFailure('s1');

      const body = await expectPacingRefusal(service.assertSendAllowed('s1'));
      expect(body.code).toBe(SEND_PACING_LIMITED);
    });

    // A success proves WhatsApp is still serving this account, so a streak that never completed
    // must not accumulate across unrelated failures hours apart.
    it('a success resets the streak', async () => {
      const { service } = build({ breakerThreshold: 3, warmupSchedule: [1000] });
      service.recordSendFailure('s1');
      service.recordSendFailure('s1');
      service.recordSendSuccess('s1');
      service.recordSendFailure('s1');

      await expect(service.assertSendAllowed('s1')).resolves.toBeUndefined();
    });

    it('closes again once the cooldown has elapsed', async () => {
      jest.useFakeTimers();
      try {
        const { service } = build({ breakerThreshold: 1, breakerCooldownMs: 60_000, warmupSchedule: [1000] });
        service.recordSendFailure('s1');
        await expectPacingRefusal(service.assertSendAllowed('s1'));

        jest.advanceTimersByTime(60_001);

        await expect(service.assertSendAllowed('s1')).resolves.toBeUndefined();
      } finally {
        jest.useRealTimers();
      }
    });

    // One session's trouble must not stop another's traffic — they are different WhatsApp accounts.
    it('is per session', async () => {
      const { service } = build({ breakerThreshold: 1, warmupSchedule: [1000] });
      service.recordSendFailure('s1');

      await expectPacingRefusal(service.assertSendAllowed('s1'));
      await expect(service.assertSendAllowed('s2')).resolves.toBeUndefined();
    });

    // The breaker is checked before the cap so an account WhatsApp is already refusing does not pay
    // for a DB count on every attempt.
    it('refuses without querying the daily count', async () => {
      const { service, count } = build({ breakerThreshold: 1, warmupSchedule: [1000] });
      service.recordSendFailure('s1');

      await expectPacingRefusal(service.assertSendAllowed('s1'));

      expect(count).not.toHaveBeenCalled();
    });
  });

  describe('metrics', () => {
    it('counts refusals by the rule that caused them', async () => {
      const capped = build({ warmupSchedule: [1] }, 5);
      await expectPacingRefusal(capped.service.assertSendAllowed('s1'));

      const tripped = build({ breakerThreshold: 1, warmupSchedule: [1000] });
      tripped.service.recordSendFailure('s1');
      await expectPacingRefusal(tripped.service.assertSendAllowed('s1'));

      expect(getSendPacingRefusals().get('daily_cap')).toBe(1);
      expect(getSendPacingRefusals().get('breaker_open')).toBe(1);
    });

    it('records nothing when sends are allowed', async () => {
      const { service } = build({ warmupSchedule: [10] }, 0);
      await service.assertSendAllowed('s1');

      expect(getSendPacingRefusals().size).toBe(0);
    });
  });
});

describe('computeSendPacingConfig', () => {
  it('is off unless explicitly enabled', () => {
    expect(computeSendPacingConfig({}).enabled).toBe(false);
    expect(computeSendPacingConfig({ SEND_PACING_ENABLED: 'TRUE' }).enabled).toBe(false);
    expect(computeSendPacingConfig({ SEND_PACING_ENABLED: 'true' }).enabled).toBe(true);
  });

  it('parses a warm-up schedule', () => {
    expect(computeSendPacingConfig({ SEND_PACING_WARMUP_SCHEDULE: '5, 10,20' }).warmupSchedule).toEqual([5, 10, 20]);
  });

  // A schedule with one bad entry falls back WHOLESALE rather than skipping the entry: a ramp with a
  // hole in it would apply a different policy than the operator wrote, and quietly sending more than
  // intended is the one outcome this feature exists to prevent.
  it.each(['5,abc,20', '5,0,20', '', '   ', '5,-1'])('falls back to the default schedule for %p', raw => {
    const parsed = computeSendPacingConfig({ SEND_PACING_WARMUP_SCHEDULE: raw }).warmupSchedule;
    expect(parsed).toEqual(computeSendPacingConfig({}).warmupSchedule);
  });

  it.each([
    ['SEND_PACING_BREAKER_THRESHOLD', 'breakerThreshold'],
    ['SEND_PACING_BREAKER_COOLDOWN_MS', 'breakerCooldownMs'],
  ])('falls back on a nonsensical %s', (envKey, field) => {
    const withGarbage = computeSendPacingConfig({ [envKey]: 'nonsense' });
    const withZero = computeSendPacingConfig({ [envKey]: '0' });
    const defaults = computeSendPacingConfig({});
    expect(withGarbage[field as 'breakerThreshold']).toBe(defaults[field as 'breakerThreshold']);
    expect(withZero[field as 'breakerThreshold']).toBe(defaults[field as 'breakerThreshold']);
  });
});

// The governor is only as good as the number of send paths that consult it. These pin the
// wiring itself rather than the policy: each is a path that reaches WhatsApp, and a refactor that
// stops calling the governor from any of them reopens a hole silently.
describe('send paths consult the governor', () => {
  const refusing = (): { assertSendAllowed: jest.Mock } => ({
    assertSendAllowed: jest.fn().mockRejectedValue(new HttpException({ code: SEND_PACING_LIMITED }, 429)),
  });

  it('MessageService refuses before the plugin gate runs and before the engine is asked', async () => {
    const hookManager = { execute: jest.fn() };
    const engine = { sendTextMessage: jest.fn() };
    const pacing = refusing();
    const service = new MessageService(
      { save: jest.fn() } as never,
      { isActive: () => true } as never,
      { get: () => engine, require: () => engine } as never,
      {} as never,
      hookManager as never,
      {} as never,
      {} as never,
      pacing as never,
    );

    await expect(service.sendText('s1', { chatId: 'c@c.us', text: 'hi' })).rejects.toBeInstanceOf(HttpException);

    expect(pacing.assertSendAllowed).toHaveBeenCalledWith('s1');
    // The ordering decision, pinned: a paced-out send is never offered to plugins, so no
    // `message:sending` fires and nothing is persisted or sent.
    expect(hookManager.execute).not.toHaveBeenCalled();
    expect(engine.sendTextMessage).not.toHaveBeenCalled();
  });

  it('StatusService refuses before the plugin gate runs and before the engine is asked', async () => {
    const hookManager = { execute: jest.fn() };
    const engine = { postTextStatus: jest.fn() };
    const pacing = refusing();
    const service = new StatusService(
      { require: () => engine } as never,
      hookManager as never,
      {} as never,
      {} as never,
      pacing as never,
    );

    await expect(service.postTextStatus('s1', 'hi', {})).rejects.toBeInstanceOf(HttpException);

    expect(pacing.assertSendAllowed).toHaveBeenCalledWith('s1');
    expect(hookManager.execute).not.toHaveBeenCalled();
    expect(engine.postTextStatus).not.toHaveBeenCalled();
  });

  // This path does NOT go through MessageService, which is exactly why it needs its own call —
  // sending a product is a real outbound chat message, not a catalog read.
  it('CatalogService.sendProduct refuses before the engine is asked', async () => {
    const engine = { sendProduct: jest.fn(), sendCatalog: jest.fn() };
    const pacing = refusing();
    const service = new CatalogService({ require: () => engine } as never, pacing as never);

    await expect(service.sendProduct('s1', 'c@c.us', 'p1')).rejects.toBeInstanceOf(HttpException);
    await expect(service.sendCatalog('s1', 'c@c.us')).rejects.toBeInstanceOf(HttpException);

    expect(pacing.assertSendAllowed).toHaveBeenCalledTimes(2);
    expect(engine.sendProduct).not.toHaveBeenCalled();
    expect(engine.sendCatalog).not.toHaveBeenCalled();
  });

  // Bulk keeps its own inlined copy of the moderation gate, so it is the classic place for the two
  // to drift apart. A refusal fails just the item, leaving the batch to carry on.
  it('BulkMessageService consults the governor per item, before its own gate copy', async () => {
    const hookManager = { execute: jest.fn() };
    const engine = { sendTextMessage: jest.fn() };
    const pacing = refusing();
    const batch = {
      id: 'b1',
      batchId: 'bx',
      sessionId: 's1',
      status: 'pending',
      currentIndex: 0,
      messages: [{ chatId: 'c@c.us', type: 'text', content: { text: 'hi' } }],
      options: { delayBetweenMessages: 0, randomizeDelay: false, stopOnError: false },
      progress: { total: 1, sent: 0, failed: 0, pending: 1, cancelled: 0 },
      results: [],
    };
    const service = new BulkMessageService(
      {
        findOne: jest.fn().mockResolvedValue(batch),
        save: jest.fn((b: unknown) => Promise.resolve(b)),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      } as never,
      { get: () => engine } as never,
      { saveOutgoingMessage: jest.fn() } as never,
      hookManager as never,
      pacing as never,
    );

    await (service as unknown as { processBatch: (id: string) => Promise<void> }).processBatch('b1');

    expect(pacing.assertSendAllowed).toHaveBeenCalledWith('s1');
    expect(hookManager.execute).not.toHaveBeenCalledWith('message:sending', expect.anything(), expect.anything());
    expect(engine.sendTextMessage).not.toHaveBeenCalled();
  });
});
