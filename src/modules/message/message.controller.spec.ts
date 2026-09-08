


import {
  HttpException,
  HttpStatus,
  StreamableFile,
} from '@nestjs/common';
import { RESPONSE_PASSTHROUGH_METADATA } from '@nestjs/common/constants';
import type { Response } from 'express';

import {
  ApiKey,
  ApiKeyRole,
} from '../auth/entities/api-key.entity';
import {
  AgentTemplateQuotaService,
} from '../teamleader/agent-template-quota.service';
import type { BulkMessageService } from './bulk-message.service';
import { MessageController } from './message.controller';
import type { MessageService } from './message.service';

function createApiKey(
  overrides: Partial<ApiKey> = {},
): ApiKey {
  return {
    id: 'agent-key-1',
    name: 'Agent Key',
    keyHash:
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    keyPrefix: 'owa_k1_agent',
    role: ApiKeyRole.AGENT,
    teamLeaderId: null,
    teamLeader: null,
    agentId: 'agent-1',
    agent: null,
    allowedIps: null,
    allowedSessions: null,
    isActive: true,
    expiresAt: null,
    lastUsedAt: null,
    usageCount: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as ApiKey;
}

/**
 * `getChatMedia` serves third-party bytes from the API origin. The route shape, the capabilities and
 * the status codes are already held by the OpenAPI snapshot and route-fence gates; these tests lock
 * the response behavior that keeps the bytes inert in a browser.
 */
describe('MessageController — stored media download', () => {
  const getChatMedia = jest
    .fn()
    .mockResolvedValue({
      buffer: Buffer.from('GIF89a'),
      mimetype: 'image/gif',
    });

  const controller = new MessageController(
    {
      getChatMedia,
    } as unknown as MessageService,
    {} as unknown as BulkMessageService,
    {} as unknown as AgentTemplateQuotaService,
  );

  /**
   * Express merges the object form of `res.set` into the header bag, so accumulating is both closer
   * to the real thing than recording the last call and independent of how many calls the handler
   * splits its headers across.
   */
  const mediaResponseHeaders = async (): Promise<
    Record<string, string>
  > => {
    const headers: Record<string, string> = {};

    const res = {
      set: (fields: Record<string, string>) =>
        Object.assign(headers, fields),
    } as unknown as Response;

    await controller.getChatMedia(
      'session-1',
      '628123@c.us',
      'msg-1',
      res,
    );

    return headers;
  };

  it('sends nosniff, so a wrong Content-Type cannot be re-interpreted as active content', async () => {
    expect(
      (await mediaResponseHeaders())[
        'X-Content-Type-Options'
      ],
    ).toBe('nosniff');
  });

  it('sends the media as an attachment, so it is never rendered on the API origin', async () => {
    expect(
      (await mediaResponseHeaders())[
        'Content-Disposition'
      ],
    ).toBe('attachment');
  });

  /**
   * The headers above are set on the response object directly, so they survive a handler that sends
   * no body at all — a `404` with a perfect `Content-Disposition` would satisfy both. What actually
   * carries the bytes is the returned `StreamableFile`, and Nest only sends that when the response
   * parameter is declared passthrough: without it Nest treats the handler as having taken the
   * response over and discards the return value entirely.
   */
  it('declares the response passthrough, so Nest sends the returned file rather than discarding it', () => {
    expect(
      Reflect.getMetadata(
        RESPONSE_PASSTHROUGH_METADATA,
        MessageController,
        'getChatMedia',
      ),
    ).toBe(true);
  });

  it('returns the stored bytes as the response body', async () => {
    const res = {
      set: () => undefined,
    } as unknown as Response;

    const body = await controller.getChatMedia(
      'session-1',
      '628123@c.us',
      'msg-1',
      res,
    );

    expect(body).toBeInstanceOf(StreamableFile);
    expect(body.getStream().read()).toEqual(
      Buffer.from('GIF89a'),
    );
  });
});

/**
 * Regression locks for the Agent rolling-24h stored-template quota boundary.
 *
 * The controller is intentionally the only HTTP layer that combines:
 *
 *   authenticated ApiKey
 *      +
 *   sessionId
 *      +
 *   stored-template send operation
 *
 * MessageService remains principal-agnostic. Normal/free-text sends must never
 * pass through AgentTemplateQuotaService.
 */
describe('MessageController — stored-template quota boundary', () => {
  let controller: MessageController;

  let messageService: {
    sendTemplate: jest.Mock;
    sendText: jest.Mock;
  };

  let quotaService: {
    executeForApiKey: jest.Mock;
  };

  beforeEach(() => {
    messageService = {
      sendTemplate: jest.fn(),
      sendText: jest.fn(),
    };

    quotaService = {
      executeForApiKey: jest
        .fn()
        .mockImplementation(
          async (
            _apiKey: ApiKey,
            _sessionId: string,
            operation: () => Promise<unknown>,
          ) => operation(),
        ),
    };

    controller = new MessageController(
      messageService as unknown as MessageService,
      {} as unknown as BulkMessageService,
      quotaService as unknown as AgentTemplateQuotaService,
    );
  });

  it('routes send-template through AgentTemplateQuotaService with the authenticated key and session id', async () => {
    const apiKey = createApiKey();

    const dto = {
      chatId: '628123@c.us',
      templateId: 'template-1',
      vars: {
        name: 'Mohamed',
      },
    };

    const response = {
      messageId: 'wa-msg-1',
      timestamp: 1706868000,
    };

    messageService.sendTemplate.mockResolvedValue(
      response,
    );

    await expect(
      controller.sendTemplate(
        'session-1',
        apiKey,
        dto,
      ),
    ).resolves.toEqual(response);

    expect(
      quotaService.executeForApiKey,
    ).toHaveBeenCalledTimes(1);

    expect(
      quotaService.executeForApiKey,
    ).toHaveBeenCalledWith(
      apiKey,
      'session-1',
      expect.any(Function),
    );

    expect(
      messageService.sendTemplate,
    ).toHaveBeenCalledTimes(1);

    expect(
      messageService.sendTemplate,
    ).toHaveBeenCalledWith(
      'session-1',
      dto,
    );
  });

  it('does not call MessageService.sendTemplate when quota admission rejects the request', async () => {
    const quotaError = new HttpException(
      {
        statusCode:
          HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        code:
          'AGENT_TEMPLATE_SEND_LIMIT_REACHED',
        message:
          'Template send limit reached for the rolling 24-hour window.',
        templateSendLimit24h: 10,
        used24h: 10,
        remaining24h: 0,
        retryAfterSeconds: 3600,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );

    quotaService.executeForApiKey.mockRejectedValue(
      quotaError,
    );

    await expect(
      controller.sendTemplate(
        'session-1',
        createApiKey(),
        {
          chatId: '628123@c.us',
          templateId: 'template-1',
        },
      ),
    ).rejects.toBe(quotaError);

    expect(
      messageService.sendTemplate,
    ).not.toHaveBeenCalled();
  });

  it('does not apply stored-template quota to normal text sends', async () => {
    const dto = {
      chatId: '628123@c.us',
      text: 'Normal editable text',
    };

    const response = {
      messageId: 'wa-msg-2',
      timestamp: 1706868001,
    };

    messageService.sendText.mockResolvedValue(
      response,
    );

    await expect(
      controller.sendText(
        'session-1',
        dto,
      ),
    ).resolves.toEqual(response);

    expect(
      messageService.sendText,
    ).toHaveBeenCalledWith(
      'session-1',
      dto,
    );

    expect(
      quotaService.executeForApiKey,
    ).not.toHaveBeenCalled();
  });
});



