





import {
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  DataSource,
  Repository,
} from 'typeorm';

import { AuthService } from '../auth/auth.service';
import {
  ApiKey,
  ApiKeyRole,
} from '../auth/entities/api-key.entity';

import { Session } from '../session/entities/session.entity';

import { EventsGateway } from '../events/events.gateway';

import { TeamLeaderService } from './teamleader.service';

import { TeamLeader } from './entities/team-leader.entity';
import { Agent } from './entities/agent.entity';

/**
 * These tests deliberately mock the `main` and `data` database
 * boundaries separately.
 *
 * main:
 *   TeamLeader
 *   Agent
 *   ApiKey
 *
 * data:
 *   Session
 *
 * This mirrors the production architecture where there cannot be
 * database foreign keys between Agent/TeamLeader and Session.
 */

function createTeamLeader(
  overrides: Partial<TeamLeader> = {},
): TeamLeader {
  return {
    id: 'team-leader-1',
    name: 'Ahmed Hassan',
    email: 'ahmed@example.com',

    createdAt:
      new Date(
        '2026-01-01T00:00:00Z',
      ),

    updatedAt:
      new Date(
        '2026-01-01T00:00:00Z',
      ),

    ...overrides,
  };
}

function createAgent(
  overrides: Partial<Agent> = {},
): Agent {
  return {
    id: 'agent-1',
    name: 'Mohamed Ali',
    email: 'mohamed@example.com',

    teamLeaderId:
      'team-leader-1',

    teamLeader:
      createTeamLeader(),

    assignedSessionId:
      null,

    templateSendLimit24h:
      null,

    createdAt:
      new Date(
        '2026-01-01T00:00:00Z',
      ),

    updatedAt:
      new Date(
        '2026-01-01T00:00:00Z',
      ),

    ...overrides,
  };
}

function createSession(
  overrides: Partial<Session> = {},
): Session {
  return {
    id: 'session-1',
    name: 'team-session',

    ownerTeamLeaderId:
      'team-leader-1',

    status: 'created' as Session['status'],

    phone: null,
    targetPhone: null,
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
      new Date(
        '2026-01-01T00:00:00Z',
      ),

    updatedAt:
      new Date(
        '2026-01-01T00:00:00Z',
      ),

    ...overrides,
  };
}

function createApiKey(
  overrides: Partial<ApiKey> = {},
): ApiKey {
  return {
    id: 'api-key-1',

    name: 'Test API Key',

    keyHash:
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',

    keyPrefix:
      'owa_k1_test1',

    role:
      ApiKeyRole.OPERATOR,

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
      new Date(
        '2026-01-01T00:00:00Z',
      ),

    updatedAt:
      new Date(
        '2026-01-01T00:00:00Z',
      ),

    ...overrides,
  };
}

describe(
  'TeamLeaderService',
  () => {
    let service: TeamLeaderService;

    let mainDataSource: {
      transaction: jest.Mock;
    };

    let teamLeaderRepository: {
      find: jest.Mock;
      findOne: jest.Mock;
      create: jest.Mock;
      save: jest.Mock;
      remove: jest.Mock;
    };

    let agentRepository: {
      find: jest.Mock;
      findOne: jest.Mock;
      create: jest.Mock;
      save: jest.Mock;
      remove: jest.Mock;
    };

    let apiKeyRepository: {
      find: jest.Mock;
      save: jest.Mock;
    };

    let sessionRepository: {
      count: jest.Mock;
      findOne: jest.Mock;
    };

    let authService: {
      createApiKeyInTransaction: jest.Mock;
    };

    let eventsGateway: {
      evictApiKey: jest.Mock;
    };

    let moduleRef: {
      get: jest.Mock;
    };

    let transactionManager: {
      getRepository: jest.Mock;
    };

    beforeEach(() => {
      teamLeaderRepository = {
        find:
          jest.fn(),

        findOne:
          jest.fn(),

        create:
          jest.fn(),

        save:
          jest.fn(),

        remove:
          jest.fn(),
      };

      agentRepository = {
        find:
          jest.fn(),

        findOne:
          jest.fn(),

        create:
          jest.fn(),

        save:
          jest.fn(),

        remove:
          jest.fn(),
      };

      apiKeyRepository = {
        find:
          jest.fn(),

        save:
          jest.fn(),
      };

      sessionRepository = {
        count:
          jest.fn(),

        findOne:
          jest.fn(),
      };

      authService = {
        createApiKeyInTransaction:
          jest.fn(),
      };

      eventsGateway = {
        evictApiKey:
          jest.fn(),
      };

      moduleRef = {
        get:
          jest
            .fn()
            .mockReturnValue(
              eventsGateway,
            ),
      };

      /**
       * Transactional repositories deliberately point at the same
       * mocks as the injected repositories.
       *
       * The important distinction being tested is that the service
       * obtains them through manager.getRepository() inside
       * DataSource.transaction().
       */
      transactionManager = {
        getRepository:
          jest
            .fn()
            .mockImplementation(
              (
                entity:
                  | typeof TeamLeader
                  | typeof Agent
                  | typeof ApiKey,
              ) => {
                if (
                  entity ===
                  TeamLeader
                ) {
                  return teamLeaderRepository;
                }

                if (
                  entity === Agent
                ) {
                  return agentRepository;
                }

                if (
                  entity === ApiKey
                ) {
                  return apiKeyRepository;
                }

                throw new Error(
                  'Unexpected repository requested',
                );
              },
            ),
      };

      mainDataSource = {
        transaction:
          jest
            .fn()
            .mockImplementation(
              async (
                callback: (
                  manager: typeof transactionManager,
                ) => Promise<unknown>,
              ) =>
                callback(
                  transactionManager,
                ),
            ),
      };

      service =
        new TeamLeaderService(
          mainDataSource as unknown as DataSource,

          teamLeaderRepository as unknown as Repository<TeamLeader>,

          agentRepository as unknown as Repository<Agent>,

          apiKeyRepository as unknown as Repository<ApiKey>,

          sessionRepository as unknown as Repository<Session>,

          authService as unknown as AuthService,

          moduleRef as unknown as ModuleRef,
        );
    });

    // -------------------------------------------------------------------------
    // createTeamLeader()
    // -------------------------------------------------------------------------

    describe(
      'createTeamLeader',
      () => {
        it(
          'creates the Team Leader and TEAM_LEADER API key inside one main DB transaction',
          async () => {
            const savedTeamLeader =
              createTeamLeader();

            const apiKey =
              createApiKey({
                id:
                  'team-leader-key-1',

                role:
                  ApiKeyRole.TEAM_LEADER,

                teamLeaderId:
                  savedTeamLeader.id,
              });

            teamLeaderRepository.findOne
              .mockResolvedValue(
                null,
              );

            teamLeaderRepository.create
              .mockImplementation(
                (
                  input: Partial<TeamLeader>,
                ) =>
                  createTeamLeader({
                    ...input,
                  }),
              );

            teamLeaderRepository.save
              .mockResolvedValue(
                savedTeamLeader,
              );

            authService
              .createApiKeyInTransaction
              .mockResolvedValue({
                apiKey,

                rawKey:
                  'owa_k1_plaintext_team_leader',
              });

            const result =
              await service.createTeamLeader(
                {
                  name:
                    '  Ahmed Hassan  ',

                  email:
                    '  AHMED@EXAMPLE.COM  ',
                },
              );

            expect(
              mainDataSource.transaction,
            ).toHaveBeenCalledTimes(
              1,
            );

            expect(
              transactionManager.getRepository,
            ).toHaveBeenCalledWith(
              TeamLeader,
            );

            /**
             * Email identity is canonicalized before uniqueness
             * checking.
             */
            expect(
              teamLeaderRepository.findOne,
            ).toHaveBeenCalledWith({
              where: {
                email:
                  'ahmed@example.com',
              },
            });

            expect(
              teamLeaderRepository.create,
            ).toHaveBeenCalledWith({
              name:
                'Ahmed Hassan',

              email:
                'ahmed@example.com',
            });

            expect(
              authService
                .createApiKeyInTransaction,
            ).toHaveBeenCalledWith(
              transactionManager,
              {
                name:
                  'Team Leader: Ahmed Hassan',

                role:
                  ApiKeyRole.TEAM_LEADER,

                teamLeaderId:
                  savedTeamLeader.id,

                agentId: null,

                allowedSessions:
                  null,
              },
            );

            expect(
              result,
            ).toEqual({
              teamLeader:
                savedTeamLeader,

              apiKey:
                'owa_k1_plaintext_team_leader',
            });
          },
        );

        it(
          'returns 409 when a Team Leader with the normalized email already exists',
          async () => {
            teamLeaderRepository.findOne
              .mockResolvedValue(
                createTeamLeader(),
              );

            await expect(
              service.createTeamLeader(
                {
                  name:
                    'Another Leader',

                  email:
                    'AHMED@EXAMPLE.COM',
                },
              ),
            ).rejects.toBeInstanceOf(
              ConflictException,
            );

            expect(
              teamLeaderRepository.save,
            ).not.toHaveBeenCalled();

            expect(
              authService
                .createApiKeyInTransaction,
            ).not.toHaveBeenCalled();
          },
        );

        it(
          'propagates credential provisioning failure from the transaction',
          async () => {
            teamLeaderRepository.findOne
              .mockResolvedValue(
                null,
              );

            const teamLeader =
              createTeamLeader();

            teamLeaderRepository.create
              .mockReturnValue(
                teamLeader,
              );

            teamLeaderRepository.save
              .mockResolvedValue(
                teamLeader,
              );

            authService
              .createApiKeyInTransaction
              .mockRejectedValue(
                new Error(
                  'credential creation failed',
                ),
              );

            await expect(
              service.createTeamLeader(
                {
                  name:
                    'Ahmed Hassan',

                  email:
                    'ahmed@example.com',
                },
              ),
            ).rejects.toThrow(
              'credential creation failed',
            );

            /**
             * The creation path must remain inside DataSource.transaction
             * so the real database rolls back the Team Leader row too.
             */
            expect(
              mainDataSource.transaction,
            ).toHaveBeenCalledTimes(
              1,
            );
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // Team Leader reads
    // -------------------------------------------------------------------------

    describe(
      'Team Leader reads',
      () => {
        it(
          'lists Team Leaders newest first',
          async () => {
            const teamLeaders = [
              createTeamLeader({
                id: 'tl-2',
              }),

              createTeamLeader({
                id: 'tl-1',
              }),
            ];

            teamLeaderRepository.find
              .mockResolvedValue(
                teamLeaders,
              );

            await expect(
              service.listTeamLeaders(),
            ).resolves.toBe(
              teamLeaders,
            );

            expect(
              teamLeaderRepository.find,
            ).toHaveBeenCalledWith({
              order: {
                createdAt:
                  'DESC',
              },
            });
          },
        );

        it(
          'returns a Team Leader by id',
          async () => {
            const teamLeader =
              createTeamLeader();

            teamLeaderRepository.findOne
              .mockResolvedValue(
                teamLeader,
              );

            await expect(
              service.getTeamLeader(
                'team-leader-1',
              ),
            ).resolves.toBe(
              teamLeader,
            );

            expect(
              teamLeaderRepository.findOne,
            ).toHaveBeenCalledWith({
              where: {
                id:
                  'team-leader-1',
              },
            });
          },
        );

        it(
          'returns 404 when the Team Leader does not exist',
          async () => {
            teamLeaderRepository.findOne
              .mockResolvedValue(
                null,
              );

            await expect(
              service.getTeamLeader(
                'missing-team-leader',
              ),
            ).rejects.toBeInstanceOf(
              NotFoundException,
            );
          },
        );

        it(
          'getTeamLeaderIdentity resolves the same principal',
          async () => {
            const teamLeader =
              createTeamLeader();

            teamLeaderRepository.findOne
              .mockResolvedValue(
                teamLeader,
              );

            await expect(
              service.getTeamLeaderIdentity(
                'team-leader-1',
              ),
            ).resolves.toBe(
              teamLeader,
            );
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // deleteTeamLeader()
    // -------------------------------------------------------------------------

    describe(
      'deleteTeamLeader',
      () => {
        it(
          'returns 409 when the Team Leader still owns sessions',
          async () => {
            teamLeaderRepository.findOne
              .mockResolvedValue(
                createTeamLeader(),
              );

            sessionRepository.count
              .mockResolvedValue(
                2,
              );

            await expect(
              service.deleteTeamLeader(
                'team-leader-1',
              ),
            ).rejects.toBeInstanceOf(
              ConflictException,
            );

            expect(
              sessionRepository.count,
            ).toHaveBeenCalledWith({
              where: {
                ownerTeamLeaderId:
                  'team-leader-1',
              },
            });

            expect(
              mainDataSource.transaction,
            ).not.toHaveBeenCalled();

            expect(
              teamLeaderRepository.remove,
            ).not.toHaveBeenCalled();
          },
        );

        it(
          'deletes a Team Leader with no owned sessions and evicts Team Leader and Agent API keys',
          async () => {
            const teamLeader =
              createTeamLeader();

            teamLeaderRepository.findOne
              .mockResolvedValue(
                teamLeader,
              );

            sessionRepository.count
              .mockResolvedValue(
                0,
              );

            agentRepository.find
              .mockResolvedValue([
                createAgent({
                  id: 'agent-1',
                }),

                createAgent({
                  id: 'agent-2',
                }),
              ]);

            /**
             * First ApiKey query:
             *   Team Leader credentials.
             *
             * Second:
             *   Agent credentials.
             */
            apiKeyRepository.find
              .mockResolvedValueOnce([
                createApiKey({
                  id:
                    'team-leader-key',

                  role:
                    ApiKeyRole.TEAM_LEADER,

                  teamLeaderId:
                    'team-leader-1',
                }),
              ])
              .mockResolvedValueOnce([
                createApiKey({
                  id:
                    'agent-key-1',

                  role:
                    ApiKeyRole.AGENT,

                  agentId:
                    'agent-1',
                }),

                createApiKey({
                  id:
                    'agent-key-2',

                  role:
                    ApiKeyRole.AGENT,

                  agentId:
                    'agent-2',
                }),
              ]);

            teamLeaderRepository.remove
              .mockResolvedValue(
                teamLeader,
              );

            await expect(
              service.deleteTeamLeader(
                'team-leader-1',
              ),
            ).resolves.toBeUndefined();

            expect(
              mainDataSource.transaction,
            ).toHaveBeenCalledTimes(
              1,
            );

            expect(
              teamLeaderRepository.remove,
            ).toHaveBeenCalledWith(
              teamLeader,
            );

            expect(
              eventsGateway.evictApiKey,
            ).toHaveBeenCalledTimes(
              3,
            );

            expect(
              eventsGateway.evictApiKey,
            ).toHaveBeenCalledWith(
              'team-leader-key',
              'deleted',
            );

            expect(
              eventsGateway.evictApiKey,
            ).toHaveBeenCalledWith(
              'agent-key-1',
              'deleted',
            );

            expect(
              eventsGateway.evictApiKey,
            ).toHaveBeenCalledWith(
              'agent-key-2',
              'deleted',
            );
          },
        );

        it(
          'returns 404 when the Team Leader does not exist',
          async () => {
            teamLeaderRepository.findOne
              .mockResolvedValue(
                null,
              );

            await expect(
              service.deleteTeamLeader(
                'missing-team-leader',
              ),
            ).rejects.toBeInstanceOf(
              NotFoundException,
            );

            expect(
              sessionRepository.count,
            ).not.toHaveBeenCalled();
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // createAgent()
    // -------------------------------------------------------------------------

    describe(
      'createAgent',
      () => {
        it(
          'creates an Agent and AGENT API key in the same main DB transaction',
          async () => {
            const teamLeader =
              createTeamLeader();

            const savedAgent =
              createAgent();

            teamLeaderRepository.findOne
              .mockResolvedValue(
                teamLeader,
              );

            agentRepository.create
              .mockImplementation(
                (
                  input:
                    Partial<Agent>,
                ) =>
                  createAgent({
                    ...input,
                  }),
              );

            agentRepository.save
              .mockResolvedValue(
                savedAgent,
              );

            authService
              .createApiKeyInTransaction
              .mockResolvedValue({
                apiKey:
                  createApiKey({
                    id:
                      'agent-key',

                    role:
                      ApiKeyRole.AGENT,

                    agentId:
                      savedAgent.id,
                  }),

                rawKey:
                  'owa_k1_plaintext_agent',
              });

            const result =
              await service.createAgent(
                'team-leader-1',
                {
                  name:
                    '  Mohamed Ali  ',

                  email:
                    '  MOHAMED@EXAMPLE.COM ',
                },
              );

            expect(
              mainDataSource.transaction,
            ).toHaveBeenCalledTimes(
              1,
            );

            expect(
              teamLeaderRepository.findOne,
            ).toHaveBeenCalledWith({
              where: {
                id:
                  'team-leader-1',
              },
            });

            expect(
              agentRepository.create,
            ).toHaveBeenCalledWith({
              name:
                'Mohamed Ali',

              email:
                'mohamed@example.com',

              teamLeaderId:
                'team-leader-1',

              assignedSessionId:
                null,

              templateSendLimit24h:
                null,
            });

            expect(
              authService
                .createApiKeyInTransaction,
            ).toHaveBeenCalledWith(
              transactionManager,
              {
                name:
                  'Agent: Mohamed Ali',

                role:
                  ApiKeyRole.AGENT,

                agentId:
                  savedAgent.id,

                teamLeaderId:
                  null,

                allowedSessions:
                  null,
              },
            );

            expect(
              result,
            ).toEqual({
              agent:
                savedAgent,

              apiKey:
                'owa_k1_plaintext_agent',
            });
          },
        );

        it(
          'allows an Agent to be created without an email',
          async () => {
            const teamLeader =
              createTeamLeader();

            const savedAgent =
              createAgent({
                email: null,
              });

            teamLeaderRepository.findOne
              .mockResolvedValue(
                teamLeader,
              );

            agentRepository.create
              .mockReturnValue(
                savedAgent,
              );

            agentRepository.save
              .mockResolvedValue(
                savedAgent,
              );

            authService
              .createApiKeyInTransaction
              .mockResolvedValue({
                apiKey:
                  createApiKey(),

                rawKey:
                  'owa_k1_agent',
              });

            await service.createAgent(
              'team-leader-1',
              {
                name:
                  'Agent Without Email',
              },
            );

            expect(
              agentRepository.create,
            ).toHaveBeenCalledWith({
              name:
                'Agent Without Email',

              email: null,

              teamLeaderId:
                'team-leader-1',

              assignedSessionId:
                null,

              templateSendLimit24h:
                null,
            });
          },
        );

        it.each([
          {
            label:
              'explicit null as unlimited',
            input:
              null,
            expected:
              null,
          },

          {
            label:
              'zero as stored-template sending disabled',
            input:
              0,
            expected:
              0,
          },

          {
            label:
              'a positive rolling 24-hour limit',
            input:
              25,
            expected:
              25,
          },
        ])(
          'persists $label without changing its semantics',
          async ({
            input,
            expected,
          }) => {
            const teamLeader =
              createTeamLeader();

            teamLeaderRepository.findOne
              .mockResolvedValue(
                teamLeader,
              );

            agentRepository.create
              .mockImplementation(
                (
                  value:
                    Partial<Agent>,
                ) =>
                  createAgent({
                    ...value,
                  }),
              );

            agentRepository.save
              .mockImplementation(
                async (
                  value: Agent,
                ) => value,
              );

            authService
              .createApiKeyInTransaction
              .mockResolvedValue({
                apiKey:
                  createApiKey({
                    role:
                      ApiKeyRole.AGENT,
                  }),

                rawKey:
                  'owa_k1_agent_quota',
              });

            const result =
              await service.createAgent(
                'team-leader-1',
                {
                  name:
                    'Quota Agent',

                  templateSendLimit24h:
                    input,
                },
              );

            expect(
              agentRepository.create,
            ).toHaveBeenCalledWith({
              name:
                'Quota Agent',

              email: null,

              teamLeaderId:
                'team-leader-1',

              assignedSessionId:
                null,

              templateSendLimit24h:
                expected,
            });

            expect(
              result.agent.templateSendLimit24h,
            ).toBe(
              expected,
            );
          },
        );

        it(
          'returns 404 if the owning Team Leader no longer exists',
          async () => {
            teamLeaderRepository.findOne
              .mockResolvedValue(
                null,
              );

            await expect(
              service.createAgent(
                'missing-team-leader',
                {
                  name:
                    'Mohamed Ali',
                },
              ),
            ).rejects.toBeInstanceOf(
              NotFoundException,
            );

            expect(
              agentRepository.save,
            ).not.toHaveBeenCalled();

            expect(
              authService
                .createApiKeyInTransaction,
            ).not.toHaveBeenCalled();
          },
        );

        it(
          'propagates Agent credential provisioning failure from the transaction',
          async () => {
            const teamLeader =
              createTeamLeader();

            const agent =
              createAgent();

            teamLeaderRepository.findOne
              .mockResolvedValue(
                teamLeader,
              );

            agentRepository.create
              .mockReturnValue(
                agent,
              );

            agentRepository.save
              .mockResolvedValue(
                agent,
              );

            authService
              .createApiKeyInTransaction
              .mockRejectedValue(
                new Error(
                  'agent key failed',
                ),
              );

            await expect(
              service.createAgent(
                'team-leader-1',
                {
                  name:
                    'Mohamed Ali',
                },
              ),
            ).rejects.toThrow(
              'agent key failed',
            );

            expect(
              mainDataSource.transaction,
            ).toHaveBeenCalledTimes(
              1,
            );
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // Agent reads
    // -------------------------------------------------------------------------

    describe(
      'Agent reads',
      () => {
        it(
          'lists only Agents belonging to the Team Leader',
          async () => {
            const teamLeader =
              createTeamLeader();

            const agents = [
              createAgent({
                id: 'agent-1',
              }),

              createAgent({
                id: 'agent-2',
              }),
            ];

            teamLeaderRepository.findOne
              .mockResolvedValue(
                teamLeader,
              );

            agentRepository.find
              .mockResolvedValue(
                agents,
              );

            const result =
              await service.listAgents(
                'team-leader-1',
              );

            expect(
              result,
            ).toBe(
              agents,
            );

            expect(
              agentRepository.find,
            ).toHaveBeenCalledWith({
              where: {
                teamLeaderId:
                  'team-leader-1',
              },

              order: {
                createdAt:
                  'DESC',
              },
            });
          },
        );

        it(
          'returns 404 when listing Agents for a nonexistent Team Leader',
          async () => {
            teamLeaderRepository.findOne
              .mockResolvedValue(
                null,
              );

            await expect(
              service.listAgents(
                'missing-team-leader',
              ),
            ).rejects.toBeInstanceOf(
              NotFoundException,
            );

            expect(
              agentRepository.find,
            ).not.toHaveBeenCalled();
          },
        );

        it(
          'resolves an Agent only when it belongs to the requested Team Leader',
          async () => {
            const agent =
              createAgent();

            agentRepository.findOne
              .mockResolvedValue(
                agent,
              );

            await expect(
              service.getAgentForTeamLeader(
                'team-leader-1',
                'agent-1',
              ),
            ).resolves.toBe(
              agent,
            );

            expect(
              agentRepository.findOne,
            ).toHaveBeenCalledWith({
              where: {
                id:
                  'agent-1',

                teamLeaderId:
                  'team-leader-1',
              },
            });
          },
        );

        it(
          'returns 404 for a foreign Agent',
          async () => {
            agentRepository.findOne
              .mockResolvedValue(
                null,
              );

            await expect(
              service.getAgentForTeamLeader(
                'team-leader-a',
                'agent-owned-by-b',
              ),
            ).rejects.toBeInstanceOf(
              NotFoundException,
            );
          },
        );

        it(
          'resolves the authenticated Agent identity by principal id',
          async () => {
            const agent =
              createAgent();

            agentRepository.findOne
              .mockResolvedValue(
                agent,
              );

            await expect(
              service.getAgentIdentity(
                'agent-1',
              ),
            ).resolves.toBe(
              agent,
            );

            expect(
              agentRepository.findOne,
            ).toHaveBeenCalledWith({
              where: {
                id:
                  'agent-1',
              },
            });
          },
        );

        it(
          'returns 404 when the bound Agent identity no longer exists',
          async () => {
            agentRepository.findOne
              .mockResolvedValue(
                null,
              );

            await expect(
              service.getAgentIdentity(
                'missing-agent',
              ),
            ).rejects.toBeInstanceOf(
              NotFoundException,
            );
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // deleteAgent()
    // -------------------------------------------------------------------------

    describe(
      'deleteAgent',
      () => {
        it(
          'deletes only an Agent belonging to the caller Team Leader and evicts its API key',
          async () => {
            const agent =
              createAgent();

            /**
             * First findOne:
             * getAgentForTeamLeader()
             *
             * Second findOne:
             * transactional ownership re-check.
             */
            agentRepository.findOne
              .mockResolvedValue(
                agent,
              );

            apiKeyRepository.find
              .mockResolvedValue([
                createApiKey({
                  id:
                    'agent-api-key',

                  role:
                    ApiKeyRole.AGENT,

                  agentId:
                    agent.id,
                }),
              ]);

            agentRepository.remove
              .mockResolvedValue(
                agent,
              );

            await expect(
              service.deleteAgent(
                'team-leader-1',
                'agent-1',
              ),
            ).resolves.toBeUndefined();

            expect(
              agentRepository.findOne,
            ).toHaveBeenCalledWith({
              where: {
                id:
                  'agent-1',

                teamLeaderId:
                  'team-leader-1',
              },
            });

            expect(
              mainDataSource.transaction,
            ).toHaveBeenCalledTimes(
              1,
            );

            expect(
              agentRepository.remove,
            ).toHaveBeenCalledWith(
              agent,
            );

            expect(
              eventsGateway.evictApiKey,
            ).toHaveBeenCalledWith(
              'agent-api-key',
              'deleted',
            );
          },
        );

        it(
          'returns 404 for a foreign Agent and performs no deletion',
          async () => {
            agentRepository.findOne
              .mockResolvedValue(
                null,
              );

            await expect(
              service.deleteAgent(
                'team-leader-a',
                'agent-owned-by-b',
              ),
            ).rejects.toBeInstanceOf(
              NotFoundException,
            );

            expect(
              apiKeyRepository.find,
            ).not.toHaveBeenCalled();

            expect(
              agentRepository.remove,
            ).not.toHaveBeenCalled();

            expect(
              eventsGateway.evictApiKey,
            ).not.toHaveBeenCalled();
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // assignAgentSession()
    // -------------------------------------------------------------------------

    describe(
      'assignAgentSession',
      () => {
        it(
          'assigns a session only when the Agent belongs to the Team Leader AND the Session is owned by that Team Leader',
          async () => {
            const agent =
              createAgent({
                assignedSessionId:
                  null,
              });

            const session =
              createSession({
                id:
                  'session-owned-by-a',

                ownerTeamLeaderId:
                  'team-leader-1',
              });

            agentRepository.findOne
              .mockResolvedValue(
                agent,
              );

            sessionRepository.findOne
              .mockResolvedValue(
                session,
              );

            agentRepository.save
              .mockImplementation(
                async (
                  value: Agent,
                ) => value,
              );

            apiKeyRepository.find
              .mockResolvedValue([
                createApiKey({
                  id:
                    'agent-key',

                  role:
                    ApiKeyRole.AGENT,

                  agentId:
                    agent.id,
                }),
              ]);

            const result =
              await service.assignAgentSession(
                'team-leader-1',
                'agent-1',
                'session-owned-by-a',
              );

            /**
             * This query is the critical tenant fence.
             *
             * It is deliberately AND, not:
             *
             * session.id = id OR ownerTeamLeaderId = owner
             */
            expect(
              sessionRepository.findOne,
            ).toHaveBeenCalledWith({
              where: {
                id:
                  'session-owned-by-a',

                ownerTeamLeaderId:
                  'team-leader-1',
              },
            });

            expect(
              agentRepository.save,
            ).toHaveBeenCalledWith(
              expect.objectContaining({
                id:
                  'agent-1',

                teamLeaderId:
                  'team-leader-1',

                assignedSessionId:
                  'session-owned-by-a',
              }),
            );

            expect(
              result.assignedSessionId,
            ).toBe(
              'session-owned-by-a',
            );

            /**
             * Assignment must NOT be copied into ApiKey.allowedSessions.
             */
            expect(
              apiKeyRepository.save,
            ).not.toHaveBeenCalled();

            /**
             * A live socket authenticated under the old assignment must
             * be disconnected.
             */
            expect(
              eventsGateway.evictApiKey,
            ).toHaveBeenCalledWith(
              'agent-key',
              'authorization_changed',
            );
          },
        );

        it(
          'returns 404 when the Agent does not belong to the caller Team Leader',
          async () => {
            agentRepository.findOne
              .mockResolvedValue(
                null,
              );

            await expect(
              service.assignAgentSession(
                'team-leader-a',
                'agent-owned-by-b',
                'session-a',
              ),
            ).rejects.toBeInstanceOf(
              NotFoundException,
            );

            expect(
              sessionRepository.findOne,
            ).not.toHaveBeenCalled();

            expect(
              agentRepository.save,
            ).not.toHaveBeenCalled();
          },
        );

        it(
          'returns 404 for a foreign Team Leader session',
          async () => {
            const agent =
              createAgent({
                teamLeaderId:
                  'team-leader-a',
              });

            agentRepository.findOne
              .mockResolvedValue(
                agent,
              );

            /**
             * The service queries by BOTH session id and owner.
             *
             * Therefore another Team Leader's session appears exactly
             * like a nonexistent session.
             */
            sessionRepository.findOne
              .mockResolvedValue(
                null,
              );

            await expect(
              service.assignAgentSession(
                'team-leader-a',
                'agent-1',
                'session-owned-by-b',
              ),
            ).rejects.toBeInstanceOf(
              NotFoundException,
            );

            expect(
              sessionRepository.findOne,
            ).toHaveBeenCalledWith({
              where: {
                id:
                  'session-owned-by-b',

                ownerTeamLeaderId:
                  'team-leader-a',
              },
            });

            expect(
              agentRepository.save,
            ).not.toHaveBeenCalled();

            expect(
              eventsGateway.evictApiKey,
            ).not.toHaveBeenCalled();
          },
        );

        it(
          'does not change or evict authorization when the requested assignment is already current',
          async () => {
            const agent =
              createAgent({
                assignedSessionId:
                  'session-1',
              });

            agentRepository.findOne
              .mockResolvedValue(
                agent,
              );

            sessionRepository.findOne
              .mockResolvedValue(
                createSession({
                  id:
                    'session-1',
                }),
              );

            const result =
              await service.assignAgentSession(
                'team-leader-1',
                'agent-1',
                'session-1',
              );

            expect(
              result,
            ).toBe(
              agent,
            );

            expect(
              agentRepository.save,
            ).not.toHaveBeenCalled();

            expect(
              apiKeyRepository.find,
            ).not.toHaveBeenCalled();

            expect(
              eventsGateway.evictApiKey,
            ).not.toHaveBeenCalled();
          },
        );

        it(
          'reassigns an Agent from one owned session to another and invalidates the old socket authorization',
          async () => {
            const agent =
              createAgent({
                assignedSessionId:
                  'old-session',
              });

            agentRepository.findOne
              .mockResolvedValue(
                agent,
              );

            sessionRepository.findOne
              .mockResolvedValue(
                createSession({
                  id:
                    'new-session',
                }),
              );

            agentRepository.save
              .mockImplementation(
                async (
                  value: Agent,
                ) => value,
              );

            apiKeyRepository.find
              .mockResolvedValue([
                createApiKey({
                  id:
                    'agent-key',

                  role:
                    ApiKeyRole.AGENT,

                  agentId:
                    'agent-1',
                }),
              ]);

            const result =
              await service.assignAgentSession(
                'team-leader-1',
                'agent-1',
                'new-session',
              );

            expect(
              result.assignedSessionId,
            ).toBe(
              'new-session',
            );

            expect(
              eventsGateway.evictApiKey,
            ).toHaveBeenCalledWith(
              'agent-key',
              'authorization_changed',
            );
          },
        );

        it(
          'unassigns an Agent when sessionId is null without querying the Session database',
          async () => {
            const agent =
              createAgent({
                assignedSessionId:
                  'session-1',
              });

            agentRepository.findOne
              .mockResolvedValue(
                agent,
              );

            agentRepository.save
              .mockImplementation(
                async (
                  value: Agent,
                ) => value,
              );

            apiKeyRepository.find
              .mockResolvedValue([
                createApiKey({
                  id:
                    'agent-key',

                  role:
                    ApiKeyRole.AGENT,

                  agentId:
                    'agent-1',
                }),
              ]);

            const result =
              await service.assignAgentSession(
                'team-leader-1',
                'agent-1',
                null,
              );

            expect(
              sessionRepository.findOne,
            ).not.toHaveBeenCalled();

            expect(
              result.assignedSessionId,
            ).toBeNull();

            expect(
              agentRepository.save,
            ).toHaveBeenCalledWith(
              expect.objectContaining({
                assignedSessionId:
                  null,
              }),
            );

            expect(
              eventsGateway.evictApiKey,
            ).toHaveBeenCalledWith(
              'agent-key',
              'authorization_changed',
            );
          },
        );

        it(
          'treats unassigning an already-unassigned Agent as an idempotent no-op',
          async () => {
            const agent =
              createAgent({
                assignedSessionId:
                  null,
              });

            agentRepository.findOne
              .mockResolvedValue(
                agent,
              );

            const result =
              await service.assignAgentSession(
                'team-leader-1',
                'agent-1',
                null,
              );

            expect(
              result,
            ).toBe(
              agent,
            );

            expect(
              sessionRepository.findOne,
            ).not.toHaveBeenCalled();

            expect(
              agentRepository.save,
            ).not.toHaveBeenCalled();

            expect(
              apiKeyRepository.find,
            ).not.toHaveBeenCalled();

            expect(
              eventsGateway.evictApiKey,
            ).not.toHaveBeenCalled();
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // unassignAgentSession()
    // -------------------------------------------------------------------------

    describe(
      'unassignAgentSession',
      () => {
        it(
          'delegates to assignAgentSession with null',
          async () => {
            const agent =
              createAgent({
                assignedSessionId:
                  'session-1',
              });

            agentRepository.findOne
              .mockResolvedValue(
                agent,
              );

            agentRepository.save
              .mockImplementation(
                async (
                  value: Agent,
                ) => value,
              );

            apiKeyRepository.find
              .mockResolvedValue([]);

            const result =
              await service.unassignAgentSession(
                'team-leader-1',
                'agent-1',
              );

            expect(
              result.assignedSessionId,
            ).toBeNull();

            expect(
              sessionRepository.findOne,
            ).not.toHaveBeenCalled();

            expect(
              agentRepository.save,
            ).toHaveBeenCalledWith(
              expect.objectContaining({
                assignedSessionId:
                  null,
              }),
            );
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // WebSocket eviction resilience
    // -------------------------------------------------------------------------

    describe(
      'WebSocket authorization eviction',
      () => {
        it(
          'does not fail an assignment when EventsGateway is unavailable',
          async () => {
            const agent =
              createAgent({
                assignedSessionId:
                  null,
              });

            agentRepository.findOne
              .mockResolvedValue(
                agent,
              );

            sessionRepository.findOne
              .mockResolvedValue(
                createSession(),
              );

            agentRepository.save
              .mockImplementation(
                async (
                  value: Agent,
                ) => value,
              );

            apiKeyRepository.find
              .mockResolvedValue([
                createApiKey({
                  id:
                    'agent-key',
                }),
              ]);

            moduleRef.get
              .mockImplementation(
                () => {
                  throw new Error(
                    'Gateway unavailable',
                  );
                },
              );

            await expect(
              service.assignAgentSession(
                'team-leader-1',
                'agent-1',
                'session-1',
              ),
            ).resolves.toEqual(
              expect.objectContaining({
                assignedSessionId:
                  'session-1',
              }),
            );

            /**
             * The DB authorization state is authoritative.
             * Socket eviction is best effort only.
             */
            expect(
              agentRepository.save,
            ).toHaveBeenCalled();
          },
        );

        it(
          'does not resolve EventsGateway when there are no affected API keys',
          async () => {
            const agent =
              createAgent({
                assignedSessionId:
                  'session-1',
              });

            agentRepository.findOne
              .mockResolvedValue(
                agent,
              );

            agentRepository.save
              .mockImplementation(
                async (
                  value: Agent,
                ) => value,
              );

            apiKeyRepository.find
              .mockResolvedValue([]);

            await service.assignAgentSession(
              'team-leader-1',
              'agent-1',
              null,
            );

            expect(
              moduleRef.get,
            ).not.toHaveBeenCalled();
          },
        );
      },
    );
  },
);




