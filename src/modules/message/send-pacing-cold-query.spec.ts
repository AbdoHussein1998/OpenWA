import { DataSource } from 'typeorm';
import { SendPacingService } from './send-pacing.service';
import { Message, MessageDirection } from './entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { computeSendPacingConfig } from './send-pacing.config';
import type { ConfigService } from '@nestjs/config';

/**
 * The cold-reachout count is the one piece of this feature that cannot be proven with a mocked
 * repository: it is a hand-written `NOT EXISTS` subquery, so a wrong column name, a wrong join
 * predicate or an unquoted identifier compiles, passes every mocked test, and then throws on the
 * first cold send in production.
 *
 * (It did: the subquery was first written against `session_id` / `chat_id` / `created_at`. Those
 * columns do not exist — this connection has no snake_case naming strategy and the real columns are
 * quoted camelCase — and nothing but a real database was ever going to say so.)
 *
 * So this spec drives an actual SQLite schema and asserts on rows, not on calls.
 */
describe('cold-reachout counting against a real database', () => {
  let ds: DataSource;
  let service: SendPacingService;

  const DAY_MS = 86_400_000;
  const NOW = new Date('2026-08-03T12:00:00.000Z');
  const TODAY = '2026-08-03T09:00:00.000Z';
  const YESTERDAY = '2026-08-02T09:00:00.000Z';

  const config = (over: Record<string, unknown> = {}): ConfigService =>
    ({
      get: (key: string) =>
        key === 'sendPacing'
          ? { ...computeSendPacingConfig({}), enabled: true, warmupSchedule: [10_000], coldSchedule: [3], ...over }
          : undefined,
    }) as unknown as ConfigService;

  const addMessage = (chatId: string, at: string, direction = MessageDirection.OUTGOING): Promise<unknown> =>
    ds.query(
      `INSERT INTO "messages" ("id","sessionId","chatId","from","to","type","direction","createdAt")
       VALUES (?,?,?,'a','b','text',?,?)`,
      [`${chatId}-${at}-${direction}`, 's1', chatId, direction, at],
    );

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message, Session],
      synchronize: true,
    });
    await ds.initialize();
    // The session is old enough that only the cold rule can refuse anything.
    await ds.getRepository(Session).save({ name: 'bot', id: 's1', createdAt: new Date(NOW.getTime() - 30 * DAY_MS) });
    service = new SendPacingService(ds.getRepository(Message), ds.getRepository(Session), config());
  });

  afterEach(async () => {
    jest.useRealTimers();
    await ds.destroy();
  });

  it('counts a chat first written to today, and stops counting it once it has history', async () => {
    await addMessage('new-1@c.us', TODAY);
    await addMessage('new-2@c.us', TODAY);
    // Written to today but known since yesterday — an ongoing conversation, not a reachout.
    await addMessage('known@c.us', YESTERDAY);
    await addMessage('known@c.us', TODAY);

    // Two cold reachouts used of three: a third stranger is still allowed.
    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).resolves.toBeUndefined();

    await addMessage('new-3@c.us', TODAY);
    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).rejects.toMatchObject({ status: 429 });
  });

  // The direction asymmetry is the whole point: someone writing to us first makes the chat warm,
  // but their inbound message is not itself a reachout we made.
  it('treats an inbound-first chat as warm without counting it as a reachout', async () => {
    await addMessage('inbound-1@c.us', TODAY, MessageDirection.INCOMING);
    await addMessage('inbound-2@c.us', TODAY, MessageDirection.INCOMING);
    await addMessage('inbound-3@c.us', TODAY, MessageDirection.INCOMING);
    await addMessage('inbound-4@c.us', TODAY, MessageDirection.INCOMING);

    // Replying to any of them is never refused, however many there are…
    await expect(service.assertSendAllowed('s1', 'inbound-1@c.us')).resolves.toBeUndefined();
    // …and none of them consumed the cold budget, so a stranger is still allowed.
    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).resolves.toBeUndefined();
  });

  it("does not count another session's reachouts", async () => {
    await ds.query(
      `INSERT INTO "messages" ("id","sessionId","chatId","from","to","type","direction","createdAt")
       VALUES ('other-1','s2','a@c.us','a','b','text','outgoing',?),
              ('other-2','s2','b@c.us','a','b','text','outgoing',?),
              ('other-3','s2','c@c.us','a','b','text','outgoing',?)`,
      [TODAY, TODAY, TODAY],
    );

    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).resolves.toBeUndefined();
  });

  // Whether a chat is new is a question about THIS account, not the deployment: another session
  // knowing the number says nothing about this one's relationship with it. If the history lookup
  // were not scoped per session, a second session's older message would make this session's very
  // first approach look like an ongoing conversation and free up budget it never earned.
  it("does not let another session's older history make a chat look warm", async () => {
    await addMessage('cold-a@c.us', TODAY);
    await addMessage('cold-b@c.us', TODAY);
    await addMessage('shared@c.us', TODAY);
    await ds.query(
      `INSERT INTO "messages" ("id","sessionId","chatId","from","to","type","direction","createdAt")
       VALUES ('s2-older','s2','shared@c.us','a','b','text','outgoing',?)`,
      [YESTERDAY],
    );

    // Three cold reachouts today, `shared@c.us` among them — the budget of three is spent.
    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).rejects.toMatchObject({ status: 429 });
  });

  it("forgets yesterday's reachouts when the UTC day rolls over", async () => {
    await addMessage('y1@c.us', YESTERDAY);
    await addMessage('y2@c.us', YESTERDAY);
    await addMessage('y3@c.us', YESTERDAY);
    await addMessage('y4@c.us', YESTERDAY);

    await expect(service.assertSendAllowed('s1', 'stranger@c.us')).resolves.toBeUndefined();
  });
});
