import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  ApiKey,
  ApiKeyRole,
} from '../auth/entities/api-key.entity';

import {
  AgentTemplateQuotaReservation,
  AgentTemplateQuotaService,
} from './agent-template-quota.service';

import { Agent } from './entities/agent.entity';
import {
  AgentTemplateSendUsage,
  AgentTemplateSendUsageStatus,
} from './entities/agent-template-send-usage.entity';
import { TeamLeader } from './entities/team-leader.entity';

function createApiKey(
  overrides: Partial<ApiKey> = {},
): ApiKey {
  return {
    id: 'api-key-1',
    name: 'Agent API Key',
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

    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),

    ...overrides,
  } as ApiKey;
}

function createReservation(
  overrides: Partial<AgentTemplateQuotaReservation> = {},
): AgentTemplateQuotaReservation {
  return {
    usageId: 'usage-1',
    agentId: 'agent-1',
    sessionId: 'session-1',
    limit: 10,
    used24h: 1,
    ...overrides,
  };
}

function quotaResponse(
  error: unknown,
): Record<string, unknown> {
  expect(error).toBeInstanceOf(HttpException);

  const exception = error as HttpException;
  expect(exception.getStatus()).toBe(
    HttpStatus.TOO_MANY_REQUESTS,
  );

  const response = exception.getResponse();
  expect(typeof response).toBe('object');
  expect(response).not.toBeNull();

  return response as Record<string, unknown>;
}

describe('AgentTemplateQuotaService', () => {
  describe('executeForApiKey()', () => {
    let service: AgentTemplateQuotaService;

    beforeEach(() => {
      service = new AgentTemplateQuotaService(
        {} as DataSource,
      );
    });

    it.each([
      ApiKeyRole.ADMIN,
      ApiKeyRole.OPERATOR,
      ApiKeyRole.VIEWER,
      ApiKeyRole.TEAM_LEADER,
    ])(
      'bypasses Agent quota accounting for %s',
      async role => {
        const operation = jest
          .fn()
          .mockResolvedValue('sent');

        const reserve = jest.spyOn(
          service,
          'reserveForAgent',
        );

        await expect(
          service.executeForApiKey(
            createApiKey({
              role,
              agentId: null,
            }),
            'session-1',
            operation,
          ),
        ).resolves.toBe('sent');

        expect(operation).toHaveBeenCalledTimes(1);
        expect(reserve).not.toHaveBeenCalled();
      },
    );

    it('fails closed for an AGENT key without agentId', async () => {
      const operation = jest.fn();

      await expect(
        service.executeForApiKey(
          createApiKey({
            role: ApiKeyRole.AGENT,
            agentId: null,
          }),
          'session-1',
          operation,
        ),
      ).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      expect(operation).not.toHaveBeenCalled();
    });

    it('executes without usage accounting when the Agent is unlimited', async () => {
      const operation = jest
        .fn()
        .mockResolvedValue({ messageId: 'wa-1' });

      jest
        .spyOn(service, 'reserveForAgent')
        .mockResolvedValue(null);

      const commit = jest.spyOn(
        service,
        'commitReservation',
      );
      const release = jest.spyOn(
        service,
        'releaseReservation',
      );

      await expect(
        service.executeForApiKey(
          createApiKey(),
          'session-1',
          operation,
        ),
      ).resolves.toEqual({ messageId: 'wa-1' });

      expect(operation).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    });

    it('commits a reservation after a successful stored-template send', async () => {
      const reservation = createReservation();

      jest
        .spyOn(service, 'reserveForAgent')
        .mockResolvedValue(reservation);

      const commit = jest
        .spyOn(service, 'commitReservation')
        .mockResolvedValue(undefined);

      const release = jest
        .spyOn(service, 'releaseReservation')
        .mockResolvedValue(undefined);

      const operation = jest
        .fn()
        .mockResolvedValue('sent');

      await expect(
        service.executeForApiKey(
          createApiKey(),
          'session-1',
          operation,
        ),
      ).resolves.toBe('sent');

      expect(commit).toHaveBeenCalledTimes(1);
      expect(commit).toHaveBeenCalledWith(
        reservation,
      );
      expect(release).not.toHaveBeenCalled();
    });

    it('releases the reservation and rethrows the original send error', async () => {
      const reservation = createReservation();
      const sendError = new Error(
        'WhatsApp send failed',
      );

      jest
        .spyOn(service, 'reserveForAgent')
        .mockResolvedValue(reservation);

      const release = jest
        .spyOn(service, 'releaseReservation')
        .mockResolvedValue(undefined);

      const commit = jest.spyOn(
        service,
        'commitReservation',
      );

      const operation = jest
        .fn()
        .mockRejectedValue(sendError);

      await expect(
        service.executeForApiKey(
          createApiKey(),
          'session-1',
          operation,
        ),
      ).rejects.toBe(sendError);

      expect(release).toHaveBeenCalledWith(
        reservation,
      );
      expect(commit).not.toHaveBeenCalled();
    });

    it('does not turn a successful WhatsApp send into a failure when quota finalization fails', async () => {
      const reservation = createReservation();

      jest
        .spyOn(service, 'reserveForAgent')
        .mockResolvedValue(reservation);

      jest
        .spyOn(service, 'commitReservation')
        .mockRejectedValue(
          new Error('quota update failed'),
        );

      const operation = jest
        .fn()
        .mockResolvedValue({ messageId: 'wa-1' });

      await expect(
        service.executeForApiKey(
          createApiKey(),
          'session-1',
          operation,
        ),
      ).resolves.toEqual({ messageId: 'wa-1' });
    });

    it('still rethrows the original send error when reservation release also fails', async () => {
      const reservation = createReservation();
      const sendError = new Error(
        'upstream send failed',
      );

      jest
        .spyOn(service, 'reserveForAgent')
        .mockResolvedValue(reservation);

      jest
        .spyOn(service, 'releaseReservation')
        .mockRejectedValue(
          new Error('quota release failed'),
        );

      await expect(
        service.executeForApiKey(
          createApiKey(),
          'session-1',
          async () => {
            throw sendError;
          },
        ),
      ).rejects.toBe(sendError);
    });
  });

  describe('real main SQLite quota behavior', () => {
    let dataSource: DataSource;
    let service: AgentTemplateQuotaService;
    let agentSequence = 0;

    beforeEach(async () => {
      dataSource = new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: [
          TeamLeader,
          Agent,
          AgentTemplateSendUsage,
        ],
        synchronize: true,
        logging: false,
      });

      await dataSource.initialize();
      await dataSource.query(
        'PRAGMA foreign_keys = ON',
      );

      service = new AgentTemplateQuotaService(
        dataSource,
      );
    });

    afterEach(async () => {
      if (dataSource.isInitialized) {
        await dataSource.destroy();
      }
    });

    const createDbAgent = async (
      templateSendLimit24h: number | null,
    ): Promise<Agent> => {
      agentSequence += 1;

      const teamLeaderRepository =
        dataSource.getRepository(TeamLeader);
      const agentRepository =
        dataSource.getRepository(Agent);

      const teamLeader =
        await teamLeaderRepository.save(
          teamLeaderRepository.create({
            name: `Team Leader ${agentSequence}`,
            email:
              `tl-${agentSequence}@example.com`,
          }),
        );

      return agentRepository.save(
        agentRepository.create({
          name: `Agent ${agentSequence}`,
          email: null,
          teamLeaderId: teamLeader.id,
          assignedSessionId: 'session-1',
          templateSendLimit24h,
        }),
      );
    };

    it('returns 404 when the bound Agent no longer exists', async () => {
      await expect(
        service.reserveForAgent(
          'missing-agent',
          'session-1',
        ),
      ).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('treats templateSendLimit24h=null as unlimited and creates no usage row', async () => {
      const agent = await createDbAgent(null);

      const operation = jest
        .fn()
        .mockResolvedValue('sent');

      await expect(
        service.executeForApiKey(
          createApiKey({
            agentId: agent.id,
          }),
          'session-1',
          operation,
        ),
      ).resolves.toBe('sent');

      expect(operation).toHaveBeenCalledTimes(1);

      await expect(
        dataSource
          .getRepository(
            AgentTemplateSendUsage,
          )
          .count({
            where: {
              agentId: agent.id,
            },
          }),
      ).resolves.toBe(0);
    });

    it('treats templateSendLimit24h=0 as disabled and returns the stable 429 contract', async () => {
      const agent = await createDbAgent(0);
      const operation = jest.fn();

      let caught: unknown;

      try {
        await service.executeForApiKey(
          createApiKey({
            agentId: agent.id,
          }),
          'session-1',
          operation,
        );
      } catch (error) {
        caught = error;
      }

      const response = quotaResponse(caught);

      expect(response).toMatchObject({
        statusCode:
          HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        code:
          'AGENT_TEMPLATE_SEND_LIMIT_REACHED',
        templateSendLimit24h: 0,
        used24h: 0,
        remaining24h: 0,
        retryAfterSeconds: null,
      });

      expect(operation).not.toHaveBeenCalled();
    });

    it('reserves and then consumes one slot after a successful send', async () => {
      const agent = await createDbAgent(2);

      await expect(
        service.executeForApiKey(
          createApiKey({
            agentId: agent.id,
          }),
          'session-1',
          async () => 'sent',
        ),
      ).resolves.toBe('sent');

      const rows =
        await dataSource
          .getRepository(
            AgentTemplateSendUsage,
          )
          .find({
            where: {
              agentId: agent.id,
            },
          });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        agentId: agent.id,
        sessionId: 'session-1',
        status:
          AgentTemplateSendUsageStatus.CONSUMED,
        reservationExpiresAt: null,
      });
      expect(rows[0].consumedAt).toBeInstanceOf(
        Date,
      );
    });

    it('releases the reserved slot after a failed send so a later send can use it', async () => {
      const agent = await createDbAgent(1);
      const key = createApiKey({
        agentId: agent.id,
      });

      await expect(
        service.executeForApiKey(
          key,
          'session-1',
          async () => {
            throw new Error('send failed');
          },
        ),
      ).rejects.toThrow('send failed');

      await expect(
        dataSource
          .getRepository(
            AgentTemplateSendUsage,
          )
          .count({
            where: {
              agentId: agent.id,
            },
          }),
      ).resolves.toBe(0);

      await expect(
        service.executeForApiKey(
          key,
          'session-1',
          async () => 'second-send',
        ),
      ).resolves.toBe('second-send');
    });

    it('returns 429 when all rolling-window slots are already consumed', async () => {
      const agent = await createDbAgent(1);
      const key = createApiKey({
        agentId: agent.id,
      });

      await service.executeForApiKey(
        key,
        'session-1',
        async () => 'first',
      );

      let caught: unknown;

      try {
        await service.executeForApiKey(
          key,
          'session-1',
          async () => 'second',
        );
      } catch (error) {
        caught = error;
      }

      const response = quotaResponse(caught);

      expect(response).toMatchObject({
        code:
          'AGENT_TEMPLATE_SEND_LIMIT_REACHED',
        templateSendLimit24h: 1,
        used24h: 1,
        remaining24h: 0,
      });

      expect(
        response.retryAfterSeconds,
      ).toEqual(expect.any(Number));
      expect(
        response.retryAfterSeconds as number,
      ).toBeGreaterThan(0);
    });

    it('removes consumed rows older than 24 hours before counting usage', async () => {
      const agent = await createDbAgent(1);
      const usageRepository =
        dataSource.getRepository(
          AgentTemplateSendUsage,
        );

      const oldConsumedAt = new Date(
        Date.now() -
          25 * 60 * 60 * 1000,
      );

      await usageRepository.save(
        usageRepository.create({
          agentId: agent.id,
          sessionId: 'session-1',
          status:
            AgentTemplateSendUsageStatus.CONSUMED,
          reservationExpiresAt: null,
          consumedAt: oldConsumedAt,
          createdAt: oldConsumedAt,
        }),
      );

      await expect(
        service.executeForApiKey(
          createApiKey({
            agentId: agent.id,
          }),
          'session-1',
          async () => 'allowed',
        ),
      ).resolves.toBe('allowed');

      const rows = await usageRepository.find({
        where: {
          agentId: agent.id,
        },
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe(
        AgentTemplateSendUsageStatus.CONSUMED,
      );
      expect(
        rows[0].consumedAt!.getTime(),
      ).toBeGreaterThan(
        oldConsumedAt.getTime(),
      );
    });

    it('removes expired RESERVED rows before counting usage', async () => {
      const agent = await createDbAgent(1);
      const usageRepository =
        dataSource.getRepository(
          AgentTemplateSendUsage,
        );

      await usageRepository.save(
        usageRepository.create({
          agentId: agent.id,
          sessionId: 'session-1',
          status:
            AgentTemplateSendUsageStatus.RESERVED,
          reservationExpiresAt: new Date(
            Date.now() - 60_000,
          ),
          consumedAt: null,
        }),
      );

      await expect(
        service.executeForApiKey(
          createApiKey({
            agentId: agent.id,
          }),
          'session-1',
          async () => 'allowed',
        ),
      ).resolves.toBe('allowed');

      const rows = await usageRepository.find({
        where: {
          agentId: agent.id,
        },
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe(
        AgentTemplateSendUsageStatus.CONSUMED,
      );
    });

    it('bases retryAfterSeconds on the earliest currently-counted release time', async () => {
      const agent = await createDbAgent(2);
      const usageRepository =
        dataSource.getRepository(
          AgentTemplateSendUsage,
        );

      const now = Date.now();

      await usageRepository.save([
        usageRepository.create({
          agentId: agent.id,
          sessionId: 'session-1',
          status:
            AgentTemplateSendUsageStatus.CONSUMED,
          reservationExpiresAt: null,
          consumedAt: new Date(
            now -
              23 * 60 * 60 * 1000,
          ),
        }),
        usageRepository.create({
          agentId: agent.id,
          sessionId: 'session-1',
          status:
            AgentTemplateSendUsageStatus.RESERVED,
          reservationExpiresAt: new Date(
            now + 30 * 60 * 1000,
          ),
          consumedAt: null,
        }),
      ]);

      let caught: unknown;

      try {
        await service.reserveForAgent(
          agent.id,
          'session-1',
        );
      } catch (error) {
        caught = error;
      }

      const response = quotaResponse(caught);
      const retry =
        response.retryAfterSeconds as number;

      // The active reservation expires in ~30 minutes, earlier than the
      // consumed row leaving its 24-hour window in ~1 hour.
      expect(retry).toBeGreaterThanOrEqual(29 * 60);
      expect(retry).toBeLessThanOrEqual(31 * 60);
    });

    it('fails closed when the persisted quota value is corrupt', async () => {
      const agent = await createDbAgent(1);

      await dataSource.query(
        `UPDATE "agents" ` +
          `SET "templateSendLimit24h" = -1 ` +
          `WHERE "id" = ?`,
        [agent.id],
      );

      await expect(
        service.reserveForAgent(
          agent.id,
          'session-1',
        ),
      ).rejects.toThrow(
        `Invalid templateSendLimit24h for Agent ${agent.id}`,
      );
    });

    it('admits exactly one of two simultaneous sends when the limit is 1', async () => {
      const agent = await createDbAgent(1);
      const key = createApiKey({
        agentId: agent.id,
      });

      const results =
        await Promise.allSettled([
          service.executeForApiKey(
            key,
            'session-1',
            async () => 'send-a',
          ),
          service.executeForApiKey(
            key,
            'session-1',
            async () => 'send-b',
          ),
        ]);

      const fulfilled = results.filter(
        result =>
          result.status === 'fulfilled',
      );
      const rejected = results.filter(
        result =>
          result.status === 'rejected',
      ) as PromiseRejectedResult[];

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const response = quotaResponse(
        rejected[0].reason,
      );

      expect(response).toMatchObject({
        code:
          'AGENT_TEMPLATE_SEND_LIMIT_REACHED',
        templateSendLimit24h: 1,
        used24h: 1,
        remaining24h: 0,
      });

      const rows =
        await dataSource
          .getRepository(
            AgentTemplateSendUsage,
          )
          .find({
            where: {
              agentId: agent.id,
            },
          });

      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe(
        AgentTemplateSendUsageStatus.CONSUMED,
      );
    });
  });
});
