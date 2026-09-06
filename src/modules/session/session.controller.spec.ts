import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';

import type { SessionController } from './session.controller';
import {
  SessionController as SessionControllerClass,
} from './session.controller';

import {
  SessionStatus,
} from './entities/session.entity';

import type {
  Session,
} from './entities/session.entity';

import type {
  SessionService,
} from './session.service';

import type {
  AuditService,
} from '../audit/audit.service';

import {
  AuditAction,
} from '../audit/entities/audit-log.entity';

import type {
  SessionTenantAccessService,
} from '../access-control/session-tenant-access.service';

import {
  SessionScopes,
} from '../access-control/session-scope';

import type {
  SessionScope,
} from '../access-control/session-scope';

import {
  ApiKeyRole,
} from '../auth/entities/api-key.entity';

import type {
  ApiKey,
} from '../auth/entities/api-key.entity';

/**
 * Produce a complete enough API-key fixture for controller-unit tests.
 *
 * The cast keeps these tests focused on controller behavior rather than
 * every persistence-only ApiKey field.
 */
function createApiKey(
  overrides: Partial<ApiKey> = {},
): ApiKey {
  return {
    id: 'api-key-1',
    name: 'Test Key',
    keyHash: 'hash',
    keyPrefix: 'owa_k1_test',
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

    createdAt:
      new Date('2026-01-01T00:00:00Z'),

    updatedAt:
      new Date('2026-01-01T00:00:00Z'),

    ...overrides,
  } as ApiKey;
}

/**
 * Produce a valid Session fixture containing the tenancy fields added
 * to the Session entity.
 */
function createSession(
  overrides: Partial<Session> = {},
): Session {
  return {
    id: 'sess-uuid-1',
    name: 'test-session',

    ownerTeamLeaderId: null,

    status:
      SessionStatus.CREATED,

    targetPhone: null,
    phone: null,
    pushName: null,

    config: {},

    proxyUrl: null,
    proxyType: null,

    connectedAt: null,
    lastActiveAt: null,

    nodeId: null,
    claimedAt: null,
    nodeUrl: null,
    leaseExpiresAt: null,

    createdAt:
      new Date('2026-01-01T00:00:00Z'),

    updatedAt:
      new Date('2026-01-01T00:00:00Z'),

    ...overrides,
  };
}

function createTenantAccessMock(): {
  getEffectiveSessionScope: jest.Mock;
} {
  return {
    getEffectiveSessionScope:
      jest.fn(),
  };
}

/**
 * POST /sessions declared SessionResponseDto in Swagger metadata and
 * must return the public DTO rather than leaking the raw TypeORM entity.
 */
describe(
  'SessionController — create() response contract',
  () => {
    const entity: Session =
      createSession({
        config: {
          engine: 'whatsapp-web.js',
          webhook:
            'https://internal.example/hook',
        },

        proxyUrl:
          'http://user:pass@proxy.internal:8080',

        proxyType: 'http',
      });

    const adminKey =
      createApiKey({
        role:
          ApiKeyRole.ADMIN,
      });

    let sessionService: {
      create: jest.Mock;
      isActive: jest.Mock;
    };

    let auditService: {
      logInfo: jest.Mock;
    };

    let sessionTenantAccessService: {
      getEffectiveSessionScope: jest.Mock;
    };

    let controller: SessionController;

    beforeEach(() => {
      sessionService = {
        create:
          jest
            .fn()
            .mockResolvedValue({
              ...entity,
            }),

        isActive:
          jest
            .fn()
            .mockReturnValue(false),
      };

      auditService = {
        logInfo:
          jest
            .fn()
            .mockResolvedValue(undefined),
      };

      sessionTenantAccessService =
        createTenantAccessMock();

      controller =
        new SessionControllerClass(
          sessionService as unknown as SessionService,

          auditService as unknown as AuditService,

          sessionTenantAccessService as unknown as SessionTenantAccessService,
        );
    });

    it(
      'strips internal entity fields from the response',
      async () => {
        const result =
          await controller.create(
            adminKey,
            {
              name:
                'test-session',
            },
          );

        expect(
          result,
        ).not.toHaveProperty(
          'config',
        );

        expect(
          result,
        ).not.toHaveProperty(
          'proxyUrl',
        );

        expect(
          result,
        ).not.toHaveProperty(
          'proxyType',
        );

        expect(
          result,
        ).not.toHaveProperty(
          'lastActiveAt',
        );

        /**
         * ownerTeamLeaderId is internal authorization state and must
         * never leak through SessionResponseDto.
         */
        expect(
          result,
        ).not.toHaveProperty(
          'ownerTeamLeaderId',
        );
      },
    );

    it(
      'keeps every documented SessionResponseDto field',
      async () => {
        const result =
          await controller.create(
            adminKey,
            {
              name:
                'test-session',
            },
          );

        expect(
          result,
        ).toEqual({
          id:
            entity.id,

          name:
            entity.name,

          status:
            entity.status,

          targetPhone:
            entity.targetPhone,

          phone:
            entity.phone,

          pushName:
            entity.pushName,

          connectedAt:
            entity.connectedAt,

          lastActive:
            entity.lastActiveAt,

          createdAt:
            entity.createdAt,

          updatedAt:
            entity.updatedAt,

          lastError: null,

          restriction: null,

          engineLoaded: false,
        });
      },
    );

    it(
      'creates legacy/admin sessions without a Team Leader owner',
      async () => {
        await controller.create(
          adminKey,
          {
            name:
              'test-session',
          },
        );

        expect(
          sessionService.create,
        ).toHaveBeenCalledWith(
          {
            name:
              'test-session',
          },
          {
            ownerTeamLeaderId:
              null,
          },
        );
      },
    );

    it(
      'creates Team Leader sessions with the authenticated Team Leader as owner',
      async () => {
        const teamLeaderKey =
          createApiKey({
            role:
              ApiKeyRole.TEAM_LEADER,

            teamLeaderId:
              'team-leader-1',
          });

        await controller.create(
          teamLeaderKey,
          {
            name:
              'test-session',
          },
        );

        expect(
          sessionService.create,
        ).toHaveBeenCalledWith(
          {
            name:
              'test-session',
          },
          {
            ownerTeamLeaderId:
              'team-leader-1',
          },
        );
      },
    );

    it(
      'fails closed when a Team Leader key is missing its principal binding',
      async () => {
        const malformedKey =
          createApiKey({
            role:
              ApiKeyRole.TEAM_LEADER,

            teamLeaderId:
              null,
          });

        await expect(
          controller.create(
            malformedKey,
            {
              name:
                'test-session',
            },
          ),
        ).rejects.toBeInstanceOf(
          ForbiddenException,
        );

        expect(
          sessionService.create,
        ).not.toHaveBeenCalled();
      },
    );

    /**
     * engineLoaded is live process state rather than a persisted
     * Session field.
     */
    it(
      'reports engineLoaded from the live engine map, not from the row status',
      async () => {
        sessionService.isActive
          .mockReturnValue(
            true,
          );

        const result =
          await controller.create(
            adminKey,
            {
              name:
                'test-session',
            },
          );

        expect(
          result.engineLoaded,
        ).toBe(
          true,
        );

        expect(
          sessionService.isActive,
        ).toHaveBeenCalledWith(
          entity.id,
        );
      },
    );

    it(
      'still audits creation with the session id and name',
      async () => {
        await controller.create(
          adminKey,
          {
            name:
              'test-session',
          },
        );

        expect(
          auditService.logInfo,
        ).toHaveBeenCalledWith(
          AuditAction.SESSION_CREATED,
          expect.objectContaining({
            sessionId:
              entity.id,

            sessionName:
              entity.name,
          }),
        );
      },
    );
  },
);

/**
 * GET /sessions and GET /sessions/stats/overview are aggregate routes
 * without a concrete :sessionId.
 *
 * The controller must resolve the effective tenant scope first and pass
 * that exact scope into SessionService.
 *
 * The controller does not implement tenancy itself.
 */
describe(
  'SessionController — aggregate SessionScope forwarding',
  () => {
    const statsResult = {
      total: 0,
      active: 0,
      ready: 0,
      disconnected: 0,

      byStatus: {},

      memoryUsage: {
        heapUsed: 0,
        heapTotal: 0,
        rss: 0,
      },
    };

    let sessionService: {
      findAll: jest.Mock;
      getStats: jest.Mock;
      isActive: jest.Mock;
    };

    let auditService: {
      logInfo: jest.Mock;
    };

    let sessionTenantAccessService: {
      getEffectiveSessionScope: jest.Mock;
    };

    let controller: SessionController;

    beforeEach(() => {
      sessionService = {
        findAll:
          jest
            .fn()
            .mockResolvedValue([]),

        getStats:
          jest
            .fn()
            .mockResolvedValue(
              statsResult,
            ),

        isActive:
          jest
            .fn()
            .mockReturnValue(false),
      };

      auditService = {
        logInfo:
          jest
            .fn()
            .mockResolvedValue(undefined),
      };

      sessionTenantAccessService =
        createTenantAccessMock();

      controller =
        new SessionControllerClass(
          sessionService as unknown as SessionService,

          auditService as unknown as AuditService,

          sessionTenantAccessService as unknown as SessionTenantAccessService,
        );
    });

    const cases: Array<{
      name: string;
      apiKey: ApiKey;
      scope: SessionScope;
    }> = [
      {
        name:
          'Admin -> ALL',

        apiKey:
          createApiKey({
            id:
              'admin-key',

            role:
              ApiKeyRole.ADMIN,
          }),

        scope:
          SessionScopes.all(),
      },

      {
        name:
          'legacy scoped Operator -> IDS',

        apiKey:
          createApiKey({
            id:
              'operator-key',

            role:
              ApiKeyRole.OPERATOR,

            allowedSessions: [
              'session-a',
              'session-b',
            ],
          }),

        scope:
          SessionScopes.ids([
            'session-a',
            'session-b',
          ]),
      },

      {
        name:
          'Team Leader -> OWNER',

        apiKey:
          createApiKey({
            id:
              'team-leader-key',

            role:
              ApiKeyRole.TEAM_LEADER,

            teamLeaderId:
              'team-leader-1',
          }),

        scope:
          SessionScopes.owner(
            'team-leader-1',
          ),
      },

      {
        name:
          'Agent -> OWNER_AND_IDS',

        apiKey:
          createApiKey({
            id:
              'agent-key',

            role:
              ApiKeyRole.AGENT,

            agentId:
              'agent-1',
          }),

        scope:
          SessionScopes.ownerAndIds(
            'team-leader-1',
            [
              'assigned-session-1',
            ],
          ),
      },

      {
        name:
          'empty effective scope -> NONE',

        apiKey:
          createApiKey({
            id:
              'unassigned-agent-key',

            role:
              ApiKeyRole.AGENT,

            agentId:
              'agent-unassigned',
          }),

        scope:
          SessionScopes.none(),
      },
    ];

    it.each(
      cases,
    )(
      '$name: findAll passes the effective scope into SessionService',
      async ({
        apiKey,
        scope,
      }) => {
        sessionTenantAccessService
          .getEffectiveSessionScope
          .mockResolvedValue(
            scope,
          );

        await controller.findAll(
          apiKey,
        );

        expect(
          sessionTenantAccessService
            .getEffectiveSessionScope,
        ).toHaveBeenCalledWith(
          apiKey,
        );

        expect(
          sessionService.findAll,
        ).toHaveBeenCalledWith(
          scope,
          {
            limit:
              undefined,

            offset:
              undefined,
          },
        );
      },
    );

    it.each(
      cases,
    )(
      '$name: getStats passes the effective scope into SessionService',
      async ({
        apiKey,
        scope,
      }) => {
        sessionTenantAccessService
          .getEffectiveSessionScope
          .mockResolvedValue(
            scope,
          );

        const result =
          await controller.getStats(
            apiKey,
          );

        expect(
          sessionTenantAccessService
            .getEffectiveSessionScope,
        ).toHaveBeenCalledWith(
          apiKey,
        );

        expect(
          sessionService.getStats,
        ).toHaveBeenCalledWith(
          scope,
        );

        expect(
          result,
        ).toEqual(
          statsResult,
        );
      },
    );

    it(
      'forwards parsed pagination together with the effective scope',
      async () => {
        const apiKey =
          createApiKey({
            role:
              ApiKeyRole.ADMIN,
          });

        const scope =
          SessionScopes.all();

        sessionTenantAccessService
          .getEffectiveSessionScope
          .mockResolvedValue(
            scope,
          );

        await controller.findAll(
          apiKey,
          '25',
          '50',
        );

        expect(
          sessionService.findAll,
        ).toHaveBeenCalledWith(
          scope,
          {
            limit: 25,
            offset: 50,
          },
        );
      },
    );
  },
);

/**
 * POST /sessions/:sessionId/logout audits SESSION_LOGGED_OUT only after
 * the service resolves.
 *
 * An incomplete engine-backed attempt must not emit a success audit.
 */
describe(
  'SessionController — logout() audit + error forwarding contract',
  () => {
    const loggedOutEntity: Session =
      createSession({
        status:
          SessionStatus.DISCONNECTED,

        phone: null,
      });

    let sessionService: {
      logout: jest.Mock;
      isActive: jest.Mock;
    };

    let auditService: {
      logInfo: jest.Mock;
    };

    let sessionTenantAccessService: {
      getEffectiveSessionScope: jest.Mock;
    };

    let controller: SessionController;

    beforeEach(() => {
      sessionService = {
        logout:
          jest.fn(),

        isActive:
          jest
            .fn()
            .mockReturnValue(false),
      };

      auditService = {
        logInfo:
          jest
            .fn()
            .mockResolvedValue(undefined),
      };

      sessionTenantAccessService =
        createTenantAccessMock();

      controller =
        new SessionControllerClass(
          sessionService as unknown as SessionService,

          auditService as unknown as AuditService,

          sessionTenantAccessService as unknown as SessionTenantAccessService,
        );
    });

    it(
      'on a completed engine-backed unlink: returns phone:null and writes exactly one SESSION_LOGGED_OUT audit row',
      async () => {
        sessionService.logout
          .mockResolvedValue({
            ...loggedOutEntity,

            phone: null,
          });

        const result =
          await controller.logout(
            'sess-uuid-1',
          );

        expect(
          result.phone,
        ).toBeNull();

        expect(
          auditService.logInfo,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          auditService.logInfo,
        ).toHaveBeenCalledWith(
          AuditAction.SESSION_LOGGED_OUT,
          expect.objectContaining({
            sessionId:
              loggedOutEntity.id,

            sessionName:
              loggedOutEntity.name,
          }),
        );
      },
    );

    it(
      'on an incomplete engine-backed unlink: forwards the 502 and does not write SESSION_LOGGED_OUT',
      async () => {
        const incomplete =
          new BadGatewayException({
            code:
              'SESSION_LOGOUT_INCOMPLETE',

            message:
              'Session was stopped locally, but the logout operation did not complete.',
          });

        sessionService.logout
          .mockRejectedValue(
            incomplete,
          );

        await expect(
          controller.logout(
            'sess-uuid-1',
          ),
        ).rejects.toBe(
          incomplete,
        );

        expect(
          auditService.logInfo,
        ).not.toHaveBeenCalled();
      },
    );
  },
);

/**
 * POST /sessions/:sessionId/start, /stop and /force-kill.
 *
 * Success audit rows are written only after the service resolves.
 */
describe(
  'SessionController — start/stop lifecycle',
  () => {
    const runningEntity: Session =
      createSession({
        status:
          SessionStatus.READY,

        phone:
          '628123',

        connectedAt:
          new Date(
            '2026-01-01T01:00:00Z',
          ),

        updatedAt:
          new Date(
            '2026-01-01T01:00:00Z',
          ),
      });

    let sessionService: {
      start: jest.Mock;
      stop: jest.Mock;
      forceKill: jest.Mock;
      isActive: jest.Mock;
    };

    let auditService: {
      logInfo: jest.Mock;
    };

    let sessionTenantAccessService: {
      getEffectiveSessionScope: jest.Mock;
    };

    let controller: SessionController;

    beforeEach(() => {
      sessionService = {
        start:
          jest.fn(),

        stop:
          jest.fn(),

        forceKill:
          jest.fn(),

        isActive:
          jest
            .fn()
            .mockReturnValue(false),
      };

      auditService = {
        logInfo:
          jest
            .fn()
            .mockResolvedValue(undefined),
      };

      sessionTenantAccessService =
        createTenantAccessMock();

      controller =
        new SessionControllerClass(
          sessionService as unknown as SessionService,

          auditService as unknown as AuditService,

          sessionTenantAccessService as unknown as SessionTenantAccessService,
        );
    });

    it(
      'start returns the session with engineLoaded read from the live engine map',
      async () => {
        sessionService.start
          .mockResolvedValue({
            ...runningEntity,
          });

        sessionService.isActive
          .mockReturnValue(
            true,
          );

        const result =
          await controller.start(
            'sess-uuid-1',
          );

        expect(
          result.status,
        ).toBe(
          SessionStatus.READY,
        );

        expect(
          result.engineLoaded,
        ).toBe(
          true,
        );

        expect(
          sessionService.isActive,
        ).toHaveBeenCalledWith(
          'sess-uuid-1',
        );
      },
    );

    it(
      'start audits SESSION_STARTED once the service has resolved',
      async () => {
        sessionService.start
          .mockResolvedValue({
            ...runningEntity,
          });

        await controller.start(
          'sess-uuid-1',
        );

        expect(
          auditService.logInfo,
        ).toHaveBeenCalledTimes(
          1,
        );

        expect(
          auditService.logInfo,
        ).toHaveBeenCalledWith(
          AuditAction.SESSION_STARTED,
          expect.objectContaining({
            sessionId:
              runningEntity.id,

            sessionName:
              runningEntity.name,
          }),
        );
      },
    );

    it(
      'start forwards the service 400 and writes no audit row when the engine cannot start',
      async () => {
        const notStarted =
          new BadRequestException(
            'Session is not started',
          );

        sessionService.start
          .mockRejectedValue(
            notStarted,
          );

        await expect(
          controller.start(
            'sess-uuid-1',
          ),
        ).rejects.toBe(
          notStarted,
        );

        expect(
          auditService.logInfo,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      'stop returns the stopped session and audits SESSION_STOPPED',
      async () => {
        sessionService.stop
          .mockResolvedValue({
            ...runningEntity,

            status:
              SessionStatus.DISCONNECTED,
          });

        const result =
          await controller.stop(
            'sess-uuid-1',
          );

        expect(
          result.status,
        ).toBe(
          SessionStatus.DISCONNECTED,
        );

        expect(
          result.engineLoaded,
        ).toBe(
          false,
        );

        expect(
          auditService.logInfo,
        ).toHaveBeenCalledWith(
          AuditAction.SESSION_STOPPED,
          expect.objectContaining({
            sessionId:
              runningEntity.id,

            sessionName:
              runningEntity.name,
          }),
        );
      },
    );

    it(
      'stop forwards a refusal and writes no audit row',
      async () => {
        const refused =
          new ConflictException(
            'Another node holds this session',
          );

        sessionService.stop
          .mockRejectedValue(
            refused,
          );

        await expect(
          controller.stop(
            'sess-uuid-1',
          ),
        ).rejects.toBe(
          refused,
        );

        expect(
          auditService.logInfo,
        ).not.toHaveBeenCalled();
      },
    );

    it(
      'forceKill audits SESSION_FORCE_KILLED after teardown resolves',
      async () => {
        sessionService.forceKill
          .mockResolvedValue({
            ...runningEntity,

            status:
              SessionStatus.DISCONNECTED,
          });

        const result =
          await controller.forceKill(
            'sess-uuid-1',
          );

        expect(
          result.engineLoaded,
        ).toBe(
          false,
        );

        expect(
          auditService.logInfo,
        ).toHaveBeenCalledWith(
          AuditAction.SESSION_FORCE_KILLED,
          expect.objectContaining({
            sessionId:
              runningEntity.id,

            sessionName:
              runningEntity.name,
          }),
        );
      },
    );

    it(
      'forceKill forwards the not-started 400 and writes no audit row',
      async () => {
        const notStarted =
          new BadRequestException(
            'Session is not started',
          );

        sessionService.forceKill
          .mockRejectedValue(
            notStarted,
          );

        await expect(
          controller.forceKill(
            'sess-uuid-1',
          ),
        ).rejects.toBe(
          notStarted,
        );

        expect(
          auditService.logInfo,
        ).not.toHaveBeenCalled();
      },
    );
  },
);

/**
 * Chat mute carries a nullable argument.
 *
 * null means unmute and must be forwarded unchanged.
 */
describe(
  'SessionController — muteChat',
  () => {
    let sessionService: {
      muteChat: jest.Mock;
    };

    let auditService: {
      logInfo: jest.Mock;
    };

    let sessionTenantAccessService: {
      getEffectiveSessionScope: jest.Mock;
    };

    let controller: SessionController;

    beforeEach(() => {
      sessionService = {
        muteChat:
          jest
            .fn()
            .mockResolvedValue(undefined),
      };

      auditService = {
        logInfo:
          jest
            .fn()
            .mockResolvedValue(undefined),
      };

      sessionTenantAccessService =
        createTenantAccessMock();

      controller =
        new SessionControllerClass(
          sessionService as unknown as SessionService,

          auditService as unknown as AuditService,

          sessionTenantAccessService as unknown as SessionTenantAccessService,
        );
    });

    it(
      'forwards the expiry second to the service',
      async () => {
        const result =
          await controller.muteChat(
            'sess-uuid-1',
            {
              chatId:
                '628123@c.us',

              muteUntil:
                1_800_000_000,
            },
          );

        expect(
          sessionService.muteChat,
        ).toHaveBeenCalledWith(
          'sess-uuid-1',
          '628123@c.us',
          1_800_000_000,
        );

        expect(
          result,
        ).toEqual({
          success: true,
        });
      },
    );

    it(
      'forwards a null expiry as null because that is the unmute instruction',
      async () => {
        await controller.muteChat(
          'sess-uuid-1',
          {
            chatId:
              '628123@c.us',

            muteUntil:
              null,
          },
        );

        expect(
          sessionService.muteChat,
        ).toHaveBeenCalledWith(
          'sess-uuid-1',
          '628123@c.us',
          null,
        );
      },
    );
  },
);

/**
 * The pin route must preserve the boolean result returned by the engine.
 */
describe(
  'SessionController — pinChat',
  () => {
    let sessionService: {
      pinChat: jest.Mock;
    };

    let auditService: {
      logInfo: jest.Mock;
    };

    let sessionTenantAccessService: {
      getEffectiveSessionScope: jest.Mock;
    };

    let controller: SessionController;

    beforeEach(() => {
      sessionService = {
        pinChat:
          jest
            .fn()
            .mockResolvedValue(
              true,
            ),
      };

      auditService = {
        logInfo:
          jest
            .fn()
            .mockResolvedValue(undefined),
      };

      sessionTenantAccessService =
        createTenantAccessMock();

      controller =
        new SessionControllerClass(
          sessionService as unknown as SessionService,

          auditService as unknown as AuditService,

          sessionTenantAccessService as unknown as SessionTenantAccessService,
        );
    });

    it(
      'forwards the chat id and the pin flag',
      async () => {
        const result =
          await controller.pinChat(
            'sess-uuid-1',
            {
              chatId:
                '628123@c.us',

              pin: true,
            },
          );

        expect(
          sessionService.pinChat,
        ).toHaveBeenCalledWith(
          'sess-uuid-1',
          '628123@c.us',
          true,
        );

        expect(
          result,
        ).toEqual({
          success: true,
        });
      },
    );

    it(
      'surfaces a refused pin as success:false rather than reporting it done',
      async () => {
        sessionService.pinChat
          .mockResolvedValue(
            false,
          );

        await expect(
          controller.pinChat(
            'sess-uuid-1',
            {
              chatId:
                '628123@c.us',

              pin: true,
            },
          ),
        ).resolves.toEqual({
          success: false,
        });
      },
    );

    it(
      'forwards an unpin as pin:false',
      async () => {
        await controller.pinChat(
          'sess-uuid-1',
          {
            chatId:
              '628123@c.us',

            pin: false,
          },
        );

        expect(
          sessionService.pinChat,
        ).toHaveBeenCalledWith(
          'sess-uuid-1',
          '628123@c.us',
          false,
        );
      },
    );
  },
);

