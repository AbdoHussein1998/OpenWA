import { Repository } from 'typeorm';

import { MessageService } from './message.service';
import { MessageSendService } from './message-send.service';
import { Message } from './entities/message.entity';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { MessageProjector } from '../session/message-projector.service';
import { HookManager } from '../../core/hooks';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { SendPacingService } from './send-pacing.service';
import type {
  IWhatsAppEngine,
  IncomingMessage,
} from '../../engine/interfaces/whatsapp-engine.interface';

function historyMessage(
  overrides: Partial<IncomingMessage> = {},
): IncomingMessage {
  return {
    id: 'history-1',
    from: '201000000001@c.us',
    to: '201000000002@c.us',
    chatId: '201000000001@c.us',
    body: 'loaded from WhatsApp',
    type: 'chat',
    timestamp: 1_726_400_000,
    fromMe: false,
    hasMedia: false,
    hasQuotedMsg: false,
    ...overrides,
  } as IncomingMessage;
}

describe('MessageService chat-history persistence', () => {
  let engines: EngineRegistry;
  let engine: {
    getChatHistory: jest.Mock;
  };
  let projector: {
    persistHistoryMessages: jest.Mock;
    recordOutboundMessageEdit: jest.Mock;
  };
  let service: MessageService;

  beforeEach(() => {
    engines = new EngineRegistry();
    engine = {
      getChatHistory: jest.fn().mockResolvedValue([]),
    };
    engines.set('session-1', engine as unknown as IWhatsAppEngine);

    projector = {
      persistHistoryMessages: jest.fn().mockResolvedValue(undefined),
      recordOutboundMessageEdit: jest.fn().mockResolvedValue(undefined),
    };

    service = new MessageService(
      {} as Repository<Message>,
      engines,
      projector as unknown as MessageProjector,
      {} as HookManager,
      {
        lidsForPhone: jest.fn().mockReturnValue([]),
        getCached: jest.fn().mockReturnValue(undefined),
      } as unknown as LidMappingStoreService,
      {
        assertSendAllowed: jest.fn().mockResolvedValue(undefined),
      } as unknown as SendPacingService,
      {} as MessageSendService,
    );
  });

  it('persists the exact live-history batch before returning it', async () => {
    const history = [
      historyMessage(),
      historyMessage({
        id: 'history-2',
        body: 'outgoing history',
        fromMe: true,
      }),
    ];
    engine.getChatHistory.mockResolvedValue(history);

    const result = await service.getChatHistory(
      'session-1',
      '201000000001@c.us',
    );

    expect(engine.getChatHistory).toHaveBeenCalledWith(
      '201000000001@c.us',
      50,
      false,
    );
    expect(projector.persistHistoryMessages).toHaveBeenCalledTimes(1);
    expect(projector.persistHistoryMessages).toHaveBeenCalledWith(
      'session-1',
      history,
    );
    expect(result).toBe(history);
  });

  it('does not invoke the projector for an empty history batch', async () => {
    engine.getChatHistory.mockResolvedValue([]);

    await expect(
      service.getChatHistory('session-1', '201000000001@c.us'),
    ).resolves.toEqual([]);

    expect(projector.persistHistoryMessages).not.toHaveBeenCalled();
  });

  it('keeps history persistence best-effort and returns fetched messages when the DB projection fails', async () => {
    const history = [historyMessage()];
    engine.getChatHistory.mockResolvedValue(history);
    projector.persistHistoryMessages.mockRejectedValue(
      new Error('database is temporarily busy'),
    );

    await expect(
      service.getChatHistory('session-1', '201000000001@c.us'),
    ).resolves.toBe(history);

    expect(projector.persistHistoryMessages).toHaveBeenCalledWith(
      'session-1',
      history,
    );
  });

  it('does not attempt persistence when the engine history read fails', async () => {
    engine.getChatHistory.mockRejectedValue(
      new Error('WhatsApp page unavailable'),
    );

    await expect(
      service.getChatHistory('session-1', '201000000001@c.us'),
    ).rejects.toThrow('WhatsApp page unavailable');

    expect(projector.persistHistoryMessages).not.toHaveBeenCalled();
  });

  it('preserves the deep-history contract while persisting the fetched result', async () => {
    const history = [historyMessage()];
    engine.getChatHistory.mockResolvedValue(history);

    await service.getChatHistory(
      'session-1',
      '201000000001@c.us',
      50_000,
      true,
      true,
    );

    expect(engine.getChatHistory).toHaveBeenCalledWith(
      '201000000001@c.us',
      2_000,
      false,
    );
    expect(projector.persistHistoryMessages).toHaveBeenCalledWith(
      'session-1',
      history,
    );
  });

  it('preserves the abort-signal engine call shape and persists a successful signal-aware read', async () => {
    const history = [historyMessage()];
    const controller = new AbortController();
    engine.getChatHistory.mockResolvedValue(history);

    const result = await service.getChatHistory(
      'session-1',
      '201000000001@c.us',
      25,
      false,
      false,
      controller.signal,
    );

    expect(engine.getChatHistory).toHaveBeenCalledWith(
      '201000000001@c.us',
      25,
      false,
      undefined,
      controller.signal,
    );
    expect(projector.persistHistoryMessages).toHaveBeenCalledWith(
      'session-1',
      history,
    );
    expect(result).toBe(history);
  });
});
