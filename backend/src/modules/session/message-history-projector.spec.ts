import { Repository } from 'typeorm';

import { persistHistoryMessages } from './message-history-projector';
import {
  Message,
  MessageDirection,
  MessageStatus,
} from '../message/entities/message.entity';
import type { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import type { LoggerService } from '../../common/services/logger.service';

function message(
  id: string,
  overrides: Partial<IncomingMessage> = {},
): IncomingMessage {
  return {
    id,
    from: '201000000001@c.us',
    to: '201000000002@c.us',
    chatId: '201000000001@c.us',
    body: `body-${id}`,
    type: 'chat',
    timestamp: 1_726_400_000,
    fromMe: false,
    hasMedia: false,
    hasQuotedMsg: false,
    ...overrides,
  } as IncomingMessage;
}

interface RepositoryHarness {
  repository: Repository<Message>;
  find: jest.Mock;
  create: jest.Mock;
  execute: jest.Mock;
  values: jest.Mock;
  logger: LoggerService;
  log: jest.Mock;
}

function repositoryHarness(
  existingIds: string[] = [],
): RepositoryHarness {
  const find = jest.fn().mockImplementation(
    ({ where }: { where: { waMessageId: unknown } }) => {
      // The exact TypeORM `In(...)` representation is intentionally opaque to this unit test.
      // Existing-id behavior is covered by returning configured rows for every chunk; only ids
      // present in the current batch are used by the production Set/filter step.
      void where;
      return Promise.resolve(
        existingIds.map(waMessageId => ({ waMessageId })),
      );
    },
  );

  const create = jest.fn().mockImplementation(
    (data: Partial<Message>) => ({ ...data }) as Message,
  );
  const execute = jest.fn().mockResolvedValue({});
  const orIgnore = jest.fn().mockReturnValue({ execute });
  const values = jest.fn().mockReturnValue({ orIgnore });
  const insert = jest.fn().mockReturnValue({ values });
  const createQueryBuilder = jest.fn().mockReturnValue({ insert });

  const log = jest.fn();
  const logger = {
    log,
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;

  return {
    repository: {
      find,
      create,
      createQueryBuilder,
    } as unknown as Repository<Message>,
    find,
    create,
    execute,
    values,
    logger,
    log,
  };
}

describe('persistHistoryMessages', () => {
  it('maps inbound and outgoing history rows, preserves timestamps, and inserts with orIgnore', async () => {
    const harness = repositoryHarness();
    const timestamp = 1_726_400_123;

    await persistHistoryMessages(
      harness.repository,
      undefined,
      'session-1',
      [
        message('in-1', {
          timestamp,
          author: '201000000003@c.us',
        }),
        message('out-1', {
          fromMe: true,
          from: '201000000002@c.us',
          to: '201000000001@c.us',
          author: 'must-not-be-stored@c.us',
        }),
      ],
      harness.logger,
    );

    expect(harness.create).toHaveBeenCalledTimes(2);
    expect(harness.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: 'session-1',
        waMessageId: 'in-1',
        direction: MessageDirection.INCOMING,
        status: MessageStatus.SENT,
        author: '201000000003@c.us',
      }),
    );
    expect(harness.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'session-1',
        waMessageId: 'out-1',
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        author: undefined,
      }),
    );

    const inboundRow = harness.create.mock.results[0].value as Message;
    expect(inboundRow.createdAt).toEqual(new Date(timestamp * 1000));
    expect(harness.execute).toHaveBeenCalledTimes(1);
    expect(harness.log).toHaveBeenCalledWith(
      'Persisted 2 history message(s)',
      expect.objectContaining({
        sessionId: 'session-1',
        inserted: 2,
        action: 'history_messages_persisted',
      }),
    );
  });

  it('skips rows already stored under the session/message unique identity', async () => {
    const harness = repositoryHarness(['already-there']);

    await persistHistoryMessages(
      harness.repository,
      undefined,
      'session-1',
      [message('already-there'), message('new-one')],
      harness.logger,
    );

    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(harness.create).toHaveBeenCalledWith(
      expect.objectContaining({ waMessageId: 'new-one' }),
    );
    expect(harness.execute).toHaveBeenCalledTimes(1);
  });

  it('drops non-chat/status/invalid history and collapses duplicate ids before DB work', async () => {
    const harness = repositoryHarness();

    await persistHistoryMessages(
      harness.repository,
      undefined,
      'session-1',
      [
        message('status-1', { isStatusBroadcast: true }),
        message('', { id: '' }),
        message('missing-chat', { chatId: '' }),
        message('dup', { body: 'first copy' }),
        message('dup', { body: 'latest copy' }),
      ],
      harness.logger,
    );

    expect(harness.find).toHaveBeenCalledTimes(1);
    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(harness.create).toHaveBeenCalledWith(
      expect.objectContaining({
        waMessageId: 'dup',
        body: 'latest copy',
      }),
    );
  });

  it('chunks large backfills so SQLite never receives one oversized IN query', async () => {
    const harness = repositoryHarness();
    const messages = Array.from(
      { length: 401 },
      (_, index) => message(`history-${index}`),
    );

    await persistHistoryMessages(
      harness.repository,
      undefined,
      'session-1',
      messages,
      harness.logger,
    );

    expect(harness.find).toHaveBeenCalledTimes(2);
    expect(harness.execute).toHaveBeenCalledTimes(2);
    expect(harness.create).toHaveBeenCalledTimes(401);
  });

  it('does no DB insert work for an empty/fully-invalid batch', async () => {
    const harness = repositoryHarness();

    await persistHistoryMessages(
      harness.repository,
      undefined,
      'session-1',
      [message('status-only', { isStatusBroadcast: true })],
      harness.logger,
    );

    expect(harness.find).not.toHaveBeenCalled();
    expect(harness.create).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.log).not.toHaveBeenCalled();
  });
});
