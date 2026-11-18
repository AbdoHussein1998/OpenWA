


import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { SessionTenantAccessService } from '../access-control/session-tenant-access.service';
import { SessionScopes } from '../access-control/session-scope';
import { ApiCapability } from '../auth/capabilities/api-capability';
import { REQUIRED_ROLE_KEY } from '../auth/decorators/auth.decorators';
import { REQUIRED_CAPABILITY_KEY } from '../auth/decorators/capability.decorator';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { Session } from '../session/entities/session.entity';
import { Webhook } from './entities/webhook.entity';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WebhooksListController } from './webhooks-list.controller';

/**
 * Regression locks for:
 *
 * - secret/header response redaction;
 * - capability-based webhook authorization;
 * - aggregate webhook listing through the effective session scope.
 */
function createSecretWebhook(
  overrides: Partial<Webhook> = {},
): Webhook {
  return {
    id: 'wh-uuid-1',
    sessionId: 'sess-1',
    url: 'https://example.com/webhook',
    events: ['message.received'],
    secret: 's3cr3t-hmac-key',
    headers: {
      Authorization: 'Bearer receiver-token',
    },
    filters: null,
    active: true,
    retryCount: 3,
    lastTriggeredAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    session: undefined as unknown as Session,
    ...overrides,
  };
}

function createMockApiKey(
  overrides: Partial<ApiKey> = {},
): ApiKey {
  return {
    id: 'key-1',
    name: 'Admin key',
    keyHash: 'hash',
    keyPrefix: 'owa_k1_xxxx',
    role: ApiKeyRole.ADMIN,
    teamLeaderId: null,
    teamLeader: null,
    agentId: null,
    agent: null,
    allowedIps: null,
    allowedSessions: null,
    isActive: true,
    expiresAt: null,
    lastUsedAt: null,
    usageCount: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('Webhook controllers (secret leak + capability authz)', () => {
  let controller: WebhookController;
  let listController: WebhooksListController;
  let reflector: Reflector;
  let service: jest.Mocked<Partial<WebhookService>>;
  let sessionTenantAccessService: jest.Mocked<
    Partial<SessionTenantAccessService>
  >;

  beforeEach(async () => {
    service = {
      create: jest.fn(),
      findBySession: jest.fn(),
      findOne: jest.fn(),
      findAll: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      test: jest.fn(),
      listDeliveryFailures: jest.fn(),
    };

    sessionTenantAccessService = {
      getEffectiveSessionScope: jest
        .fn()
        .mockResolvedValue(SessionScopes.all()),
    };

    const module: TestingModule =
      await Test.createTestingModule({
        controllers: [
          WebhookController,
          WebhooksListController,
        ],
        providers: [
          {
            provide: WebhookService,
            useValue: service,
          },
          {
            provide: SessionTenantAccessService,
            useValue: sessionTenantAccessService,
          },
        ],
      }).compile();

    controller =
      module.get<WebhookController>(WebhookController);
    listController =
      module.get<WebhooksListController>(
        WebhooksListController,
      );
    reflector = new Reflector();
  });

  describe('response redaction', () => {
    it('findOne does not return secret or headers, but keeps safe fields', async () => {
      (service.findOne as jest.Mock).mockResolvedValue(
        createSecretWebhook(),
      );

      const result = await controller.findOne(
        'sess-1',
        'wh-uuid-1',
      );

      expect(result).not.toHaveProperty('secret');
      expect(result).not.toHaveProperty('headers');
      expect(JSON.stringify(result)).not.toContain('s3cr3t');
      expect(result.id).toBe('wh-uuid-1');
      expect(result.url).toBe('https://example.com/webhook');
      expect(result.events).toEqual(['message.received']);
      expect(result.active).toBe(true);
    });

    it('findBySession strips secret/headers from every item', async () => {
      (service.findBySession as jest.Mock).mockResolvedValue([
        createSecretWebhook(),
        createSecretWebhook({ id: 'wh-2' }),
      ]);

      const result = await controller.findBySession('sess-1');

      expect(result).toHaveLength(2);

      for (const webhook of result) {
        expect(webhook).not.toHaveProperty('secret');
        expect(webhook).not.toHaveProperty('headers');
      }

      expect(JSON.stringify(result)).not.toContain('s3cr3t');
    });

    it('cross-session findAll strips secret/headers and applies the effective session scope', async () => {
      const apiKey = createMockApiKey();
      const sessionScope = SessionScopes.all();

      sessionTenantAccessService.getEffectiveSessionScope =
        jest.fn().mockResolvedValue(sessionScope);

      (service.findAll as jest.Mock).mockResolvedValue([
        createSecretWebhook(),
      ]);

      const result = await listController.findAll(apiKey);

      expect(
        sessionTenantAccessService.getEffectiveSessionScope,
      ).toHaveBeenCalledWith(apiKey);
      expect(service.findAll).toHaveBeenCalledWith(
        sessionScope,
        {
          limit: undefined,
          offset: undefined,
        },
      );
      expect(result[0]).not.toHaveProperty('secret');
      expect(result[0]).not.toHaveProperty('headers');
      expect(JSON.stringify(result)).not.toContain(
        'Bearer receiver-token',
      );
    });

    it('create response echoes no secret/headers', async () => {
      (service.create as jest.Mock).mockResolvedValue(
        createSecretWebhook(),
      );

      const result = await controller.create('sess-1', {
        url: 'https://example.com/webhook',
        secret: '0123456789abcdef',
      });

      expect(result).not.toHaveProperty('secret');
      expect(result).not.toHaveProperty('headers');
      expect(result.id).toBe('wh-uuid-1');
    });

    it('update response returns no secret/headers', async () => {
      (service.update as jest.Mock).mockResolvedValue(
        createSecretWebhook({
          url: 'https://new.example.com/hook',
        }),
      );

      const result = await controller.update(
        'sess-1',
        'wh-uuid-1',
        {
          url: 'https://new.example.com/hook',
        },
      );

      expect(result).not.toHaveProperty('secret');
      expect(result).not.toHaveProperty('headers');
      expect(result.url).toBe(
        'https://new.example.com/hook',
      );
    });
  });

  describe('authorization metadata', () => {
    it('session-scoped webhook controller requires WEBHOOK_MANAGE', () => {
      const capability = reflector.get<ApiCapability>(
        REQUIRED_CAPABILITY_KEY,
        WebhookController,
      );

      expect(capability).toBe(
        ApiCapability.WEBHOOK_MANAGE,
      );
    });

    it('cross-session findAll requires WEBHOOK_MANAGE', () => {
      const capability = reflector.get<ApiCapability>(
        REQUIRED_CAPABILITY_KEY,
        WebhooksListController.prototype.findAll,
      );

      expect(capability).toBe(
        ApiCapability.WEBHOOK_MANAGE,
      );
    });

    it('delivery-failures remains ADMIN-only', () => {
      const role = reflector.get<ApiKeyRole>(
        REQUIRED_ROLE_KEY,
        WebhooksListController.prototype.deliveryFailures,
      );

      expect(role).toBe(ApiKeyRole.ADMIN);
    });
  });
});



