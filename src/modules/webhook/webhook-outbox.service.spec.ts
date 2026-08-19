import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookOutboxEvent } from './entities/webhook-outbox-event.entity';

const base = {
  webhookId: 'wh-1',
  sessionId: 'sess-1',
  event: 'message.received',
  idempotencyKey: 'key_wh-1',
  deliveryId: 'del-1',
  payload: { from: '628123456789@c.us' },
};

describe('WebhookOutboxService', () => {
  let repo: { save: jest.Mock; create: jest.Mock; update: jest.Mock; find: jest.Mock };
  let service: WebhookOutboxService;

  beforeEach(() => {
    repo = {
      create: jest.fn((v: unknown) => v),
      save: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      find: jest.fn().mockResolvedValue([]),
    };
    service = new WebhookOutboxService(repo as never);
  });

  it('records the delivery as pending, carrying the payload a replay needs', async () => {
    await service.open(base);

    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ ...base, state: 'pending', attempts: 0 }));
  });

  it('treats a duplicate as the replay it is, keeping the existing row', async () => {
    const conflict = Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
    repo.save.mockRejectedValue(conflict);

    // A conflict on (webhookId, idempotencyKey) means this delivery is already recorded. Throwing
    // would surface as an unhandled rejection on a fire-and-forget path.
    await expect(service.open(base)).resolves.toBeUndefined();
  });

  it('never lets a repository failure reach a fire-and-forget caller', async () => {
    repo.save.mockRejectedValue(new Error('disk full'));
    await expect(service.open(base)).resolves.toBeUndefined();

    repo.update.mockRejectedValue(new Error('disk full'));
    await expect(service.close('wh-1', 'key_wh-1', 'dispatched')).resolves.toBeUndefined();
    await expect(service.countAttempt('row-1', 0)).resolves.toBeUndefined();
  });

  it('retires the payload when recording an outcome, so a settled row stops carrying a message body', async () => {
    await service.close('wh-1', 'key_wh-1', 'dispatched');

    expect(repo.update).toHaveBeenCalledWith(
      { webhookId: 'wh-1', idempotencyKey: 'key_wh-1' },
      expect.objectContaining({ state: 'dispatched', payload: null }),
    );
  });

  it('returns only rows that still carry a payload: a retired row is not replayable', async () => {
    const row = (over: Partial<WebhookOutboxEvent>): WebhookOutboxEvent => ({
      id: 'r',
      ...base,
      attempts: 0,
      state: 'pending',
      lastAttemptAt: null,
      createdAt: new Date(),
      ...over,
    });
    repo.find.mockResolvedValue([row({ id: 'keep' }), row({ id: 'retired', payload: null })]);

    const stale = await service.findStale(new Date(), 50);

    expect(stale.map(r => r.id)).toEqual(['keep']);
  });

  it('counts an attempt by incrementing the stored number, not by recomputing it', async () => {
    await service.countAttempt('row-1', 2);

    expect(repo.update).toHaveBeenCalledWith({ id: 'row-1' }, expect.objectContaining({ attempts: 3 }));
  });
});
