


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
import { EventsGateway } from '../events/events.gateway';
import { Session } from '../session/entities/session.entity';
import { SessionService } from '../session/session.service';

import { Agent } from './entities/agent.entity';
import { TeamLeader } from './entities/team-leader.entity';
import { TeamLeaderService } from './teamleader.service';

function createTeamLeader(
  overrides: Partial<TeamLeader> = {},
): TeamLeader {
  return {
    id: 'team-leader-1',
    name: 'Ahmed Hassan',
    email: 'ahmed@example.com',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
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
    teamLeaderId: 'team-leader-1',
    teamLeader: createTeamLeader(),
    assignedSessionId: null,
    templateSendLimit24h: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createSession(
  overrides: Partial<Session> = {},
): Session {
  return {
    id: 'session-1',
    name: 'team-session',
    ownerTeamLeaderId: 'team-leader-1',
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
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
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
    keyPrefix: 'owa_k1_test1',
    role: ApiKeyRole.OPERATOR,
    isPrimaryAdminKey: false,
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

describe('TeamLeaderService', () => {
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
    count: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
    delete: jest.Mock;
  };

  let apiKeyRepository: {
    find: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
  };

  let sessionRepository: {
    count: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    manager: {
      transaction: jest.Mock;
    };
  };

  let sessionTransactionalRepository: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
  };

  let authService: {
    createApiKeyInTransaction: jest.Mock;
  };

  let sessionService: {
    delete: jest.Mock;
  };

  let eventsGateway: {
    evictApiKey: jest.Mock;
  };

  let moduleRef: {
    get: jest.Mock;
  };

  let mainTransactionManager: {
    getRepository: jest.Mock;
  };

  let sessionTransactionManager: {
    getRepository: jest.Mock;
  };

  beforeEach(() => {
    teamLeaderRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
    };

    agentRepository = {
      count: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
      delete: jest.fn(),
    };

    apiKeyRepository = {
      find: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
    };

    sessionTransactionalRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
    };

    sessionTransactionManager = {
      getRepository: jest.fn().mockImplementation(
        (entity: typeof Session) => {
          if (entity === Session) {
            return sessionTransactionalRepository;
          }

          throw new Error('Unexpected data DB repository requested');
        },
      ),
    };

    sessionRepository = {
      count: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      manager: {
        transaction: jest.fn().mockImplementation(
          async (
            callback: (
              manager: typeof sessionTransactionManager,
            ) => Promise<unknown>,
          ) => callback(sessionTransactionManager),
        ),
      },
    };

    authService = {
      createApiKeyInTransaction: jest.fn(),
    };

    sessionService = {
      delete: jest.fn(),
    };

    eventsGateway = {
      evictApiKey: jest.fn(),
    };

    moduleRef = {
      get: jest.fn().mockReturnValue(eventsGateway),
    };

    mainTransactionManager = {
      getRepository: jest.fn().mockImplementation(
        (
          entity:
            | typeof TeamLeader
            | typeof Agent
            | typeof ApiKey,
        ) => {
          if (entity === TeamLeader) {
            return teamLeaderRepository;
          }

          if (entity === Agent) {
            return agentRepository;
          }

          if (entity === ApiKey) {
            return apiKeyRepository;
          }

          throw new Error('Unexpected main DB repository requested');
        },
      ),
    };

    mainDataSource = {
      transaction: jest.fn().mockImplementation(
        async (
          callback: (
            manager: typeof mainTransactionManager,
          ) => Promise<unknown>,
        ) => callback(mainTransactionManager),
      ),
    };

    service = new TeamLeaderService(
      mainDataSource as unknown as DataSource,
      teamLeaderRepository as unknown as Repository<TeamLeader>,
      agentRepository as unknown as Repository<Agent>,
      apiKeyRepository as unknown as Repository<ApiKey>,
      sessionRepository as unknown as Repository<Session>,
      authService as unknown as AuthService,
      moduleRef as unknown as ModuleRef,
      sessionService as unknown as SessionService,
    );
  });

  describe('createTeamLeader', () => {
    it('creates the Team Leader and API key in one main DB transaction', async () => {
      const savedTeamLeader = createTeamLeader();

      teamLeaderRepository.findOne.mockResolvedValue(null);
      teamLeaderRepository.create.mockImplementation(
        (input: Partial<TeamLeader>) => createTeamLeader(input),
      );
      teamLeaderRepository.save.mockResolvedValue(savedTeamLeader);
      authService.createApiKeyInTransaction.mockResolvedValue({
        apiKey: createApiKey({
          role: ApiKeyRole.TEAM_LEADER,
          teamLeaderId: savedTeamLeader.id,
        }),
        rawKey: 'owa_k1_plaintext_team_leader',
      });

      const result = await service.createTeamLeader({
        name: '  Ahmed Hassan  ',
        email: '  AHMED@EXAMPLE.COM  ',
      });

      expect(mainDataSource.transaction).toHaveBeenCalledTimes(1);
      expect(teamLeaderRepository.findOne).toHaveBeenCalledWith({
        where: {
          email: 'ahmed@example.com',
        },
      });
      expect(teamLeaderRepository.create).toHaveBeenCalledWith({
        name: 'Ahmed Hassan',
        email: 'ahmed@example.com',
      });
      expect(authService.createApiKeyInTransaction).toHaveBeenCalledWith(
        mainTransactionManager,
        {
          name: 'Team Leader: Ahmed Hassan',
          role: ApiKeyRole.TEAM_LEADER,
          teamLeaderId: savedTeamLeader.id,
          agentId: null,
          allowedSessions: null,
        },
      );
      expect(result).toEqual({
        teamLeader: savedTeamLeader,
        apiKey: 'owa_k1_plaintext_team_leader',
      });
    });

    it('stores a missing Team Leader email as null', async () => {
      const savedTeamLeader = createTeamLeader({
        email: null,
      });

      teamLeaderRepository.create.mockImplementation(
        (input: Partial<TeamLeader>) => createTeamLeader(input),
      );
      teamLeaderRepository.save.mockResolvedValue(savedTeamLeader);
      authService.createApiKeyInTransaction.mockResolvedValue({
        apiKey: createApiKey(),
        rawKey: 'owa_k1_team_leader',
      });

      await service.createTeamLeader({
        name: 'Ahmed Hassan',
      });

      expect(teamLeaderRepository.findOne).not.toHaveBeenCalled();
      expect(teamLeaderRepository.create).toHaveBeenCalledWith({
        name: 'Ahmed Hassan',
        email: null,
      });
    });

    it('returns 409 for an already-used normalized email', async () => {
      teamLeaderRepository.findOne.mockResolvedValue(createTeamLeader());

      await expect(
        service.createTeamLeader({
          name: 'Another Leader',
          email: 'AHMED@EXAMPLE.COM',
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(teamLeaderRepository.save).not.toHaveBeenCalled();
      expect(authService.createApiKeyInTransaction).not.toHaveBeenCalled();
    });
  });

  describe('Team Leader reads', () => {
    it('lists Team Leaders newest first', async () => {
      const teamLeaders = [
        createTeamLeader({ id: 'tl-2' }),
        createTeamLeader({ id: 'tl-1' }),
      ];

      teamLeaderRepository.find.mockResolvedValue(teamLeaders);

      await expect(service.listTeamLeaders()).resolves.toBe(teamLeaders);
      expect(teamLeaderRepository.find).toHaveBeenCalledWith({
        order: {
          createdAt: 'DESC',
        },
      });
    });

    it('resolves a Team Leader by id', async () => {
      const teamLeader = createTeamLeader();
      teamLeaderRepository.findOne.mockResolvedValue(teamLeader);

      await expect(
        service.getTeamLeader('team-leader-1'),
      ).resolves.toBe(teamLeader);
    });

    it('returns 404 when a Team Leader does not exist', async () => {
      teamLeaderRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getTeamLeader('missing-team-leader'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getAdminTeamLeaderResources', () => {
    it('returns the Team Leader resource graph and blocks deletion while resources exist', async () => {
      const teamLeader = createTeamLeader();
      const session = createSession();
      const agent = createAgent({
        assignedSessionId: session.id,
      });

      teamLeaderRepository.findOne.mockResolvedValue(teamLeader);
      sessionRepository.find.mockResolvedValue([session]);
      agentRepository.find.mockResolvedValue([agent]);

      await expect(
        service.getAdminTeamLeaderResources(teamLeader.id),
      ).resolves.toEqual({
        teamLeader,
        sessions: [
          {
            id: session.id,
            name: session.name,
            ownerTeamLeaderId: session.ownerTeamLeaderId,
            status: session.status,
            phone: session.phone,
            targetPhone: session.targetPhone,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          },
        ],
        agents: [
          {
            id: agent.id,
            name: agent.name,
            email: agent.email,
            assignedSessionId: agent.assignedSessionId,
            templateSendLimit24h: agent.templateSendLimit24h,
            createdAt: agent.createdAt,
            updatedAt: agent.updatedAt,
          },
        ],
        canDelete: false,
      });

      expect(sessionRepository.find).toHaveBeenCalledWith({
        where: {
          ownerTeamLeaderId: teamLeader.id,
        },
        order: {
          createdAt: 'DESC',
        },
      });
      expect(agentRepository.find).toHaveBeenCalledWith({
        where: {
          teamLeaderId: teamLeader.id,
        },
        order: {
          createdAt: 'DESC',
        },
      });
    });

    it('reports canDelete=true when the Team Leader owns no Sessions or Agents', async () => {
      const teamLeader = createTeamLeader();

      teamLeaderRepository.findOne.mockResolvedValue(teamLeader);
      sessionRepository.find.mockResolvedValue([]);
      agentRepository.find.mockResolvedValue([]);

      const result = await service.getAdminTeamLeaderResources(teamLeader.id);

      expect(result.canDelete).toBe(true);
      expect(result.sessions).toEqual([]);
      expect(result.agents).toEqual([]);
    });
  });


  describe('setAdminSessionOwner', () => {
    it('assigns an ADMIN-created unowned Session to the target Team Leader', async () => {
      const targetTeamLeader = createTeamLeader({
        id: 'team-leader-2',
        name: 'Target Leader',
      });
      const session = createSession({
        id: 'admin-created-session',
        ownerTeamLeaderId: null,
      });
      const savedSession = createSession({
        ...session,
        ownerTeamLeaderId: targetTeamLeader.id,
      });

      teamLeaderRepository.findOne.mockResolvedValue(targetTeamLeader);
      sessionRepository.findOne.mockResolvedValue(session);
      agentRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      sessionTransactionalRepository.findOne.mockResolvedValue(session);
      sessionTransactionalRepository.save.mockResolvedValue(savedSession);
      apiKeyRepository.find.mockResolvedValue([
        createApiKey({
          id: 'target-team-leader-key',
          role: ApiKeyRole.TEAM_LEADER,
          teamLeaderId: targetTeamLeader.id,
        }),
      ]);

      const result = await service.setAdminSessionOwner(
        session.id,
        targetTeamLeader.id,
      );

      expect(sessionTransactionalRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: session.id,
          ownerTeamLeaderId: targetTeamLeader.id,
        }),
      );
      expect(result.ownerTeamLeaderId).toBe(targetTeamLeader.id);
      expect(eventsGateway.evictApiKey).toHaveBeenCalledWith(
        'target-team-leader-key',
        'authorization_changed',
      );
    });

    it('allows direct ownership when the assigned Agent already belongs to the target Team Leader', async () => {
      const targetTeamLeader = createTeamLeader({
        id: 'team-leader-2',
      });
      const session = createSession({
        ownerTeamLeaderId: null,
      });
      const assignedAgent = createAgent({
        id: 'agent-2',
        teamLeaderId: targetTeamLeader.id,
        assignedSessionId: session.id,
      });
      const savedSession = createSession({
        ...session,
        ownerTeamLeaderId: targetTeamLeader.id,
      });

      teamLeaderRepository.findOne.mockResolvedValue(targetTeamLeader);
      sessionRepository.findOne.mockResolvedValue(session);
      agentRepository.findOne
        .mockResolvedValueOnce(assignedAgent)
        .mockResolvedValueOnce(assignedAgent);
      sessionTransactionalRepository.findOne.mockResolvedValue(session);
      sessionTransactionalRepository.save.mockResolvedValue(savedSession);
      apiKeyRepository.find
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await expect(
        service.setAdminSessionOwner(session.id, targetTeamLeader.id),
      ).resolves.toEqual(
        expect.objectContaining({
          ownerTeamLeaderId: targetTeamLeader.id,
        }),
      );
    });

    it('rejects direct ownership that conflicts with the assigned Agent Team Leader', async () => {
      const targetTeamLeader = createTeamLeader({
        id: 'team-leader-2',
      });
      const session = createSession({
        ownerTeamLeaderId: null,
      });

      teamLeaderRepository.findOne.mockResolvedValue(targetTeamLeader);
      sessionRepository.findOne.mockResolvedValue(session);
      agentRepository.findOne.mockResolvedValue(
        createAgent({
          teamLeaderId: 'team-leader-1',
          assignedSessionId: session.id,
        }),
      );

      await expect(
        service.setAdminSessionOwner(session.id, targetTeamLeader.id),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(sessionRepository.manager.transaction).not.toHaveBeenCalled();
    });

    it('is idempotent when the Session already has the requested owner', async () => {
      const teamLeader = createTeamLeader();
      const session = createSession({
        ownerTeamLeaderId: teamLeader.id,
      });

      teamLeaderRepository.findOne.mockResolvedValue(teamLeader);
      sessionRepository.findOne.mockResolvedValue(session);
      agentRepository.findOne.mockResolvedValue(null);

      await expect(
        service.setAdminSessionOwner(session.id, teamLeader.id),
      ).resolves.toEqual(
        expect.objectContaining({
          id: session.id,
          ownerTeamLeaderId: teamLeader.id,
        }),
      );

      expect(sessionRepository.manager.transaction).not.toHaveBeenCalled();
    });
  });

  describe('assignAdminAgentSession', () => {
    it('assigns a Session to an Agent and automatically transfers Session ownership to the Agent Team Leader', async () => {
      const targetTeamLeader = createTeamLeader({
        id: 'team-leader-2',
        name: 'Target Leader',
      });
      const targetAgent = createAgent({
        id: 'agent-target',
        teamLeaderId: targetTeamLeader.id,
        teamLeader: targetTeamLeader,
        assignedSessionId: null,
      });
      const session = createSession({
        id: 'session-admin-created',
        ownerTeamLeaderId: null,
      });
      const finalSession = createSession({
        ...session,
        ownerTeamLeaderId: targetTeamLeader.id,
      });
      const finalAgent = createAgent({
        ...targetAgent,
        assignedSessionId: session.id,
      });

      agentRepository.findOne
        .mockResolvedValueOnce(targetAgent)
        .mockResolvedValueOnce(targetAgent)
        .mockResolvedValueOnce(finalAgent);
      teamLeaderRepository.findOne.mockResolvedValue(targetTeamLeader);
      sessionRepository.findOne
        .mockResolvedValueOnce(session)
        .mockResolvedValueOnce(finalSession);
      sessionRepository.find.mockResolvedValue([finalSession]);
      agentRepository.find
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([finalAgent]);
      sessionTransactionalRepository.findOne.mockResolvedValue(session);
      sessionTransactionalRepository.save.mockResolvedValue(finalSession);
      agentRepository.save.mockImplementation(async (agents: Agent[]) => agents);
      apiKeyRepository.find
        .mockResolvedValueOnce([
          createApiKey({
            id: 'agent-key',
            role: ApiKeyRole.AGENT,
            agentId: targetAgent.id,
          }),
        ])
        .mockResolvedValueOnce([
          createApiKey({
            id: 'team-leader-key',
            role: ApiKeyRole.TEAM_LEADER,
            teamLeaderId: targetTeamLeader.id,
          }),
        ]);

      const result = await service.assignAdminAgentSession(
        targetAgent.id,
        session.id,
      );

      expect(sessionTransactionalRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: session.id,
          ownerTeamLeaderId: targetTeamLeader.id,
        }),
      );
      expect(agentRepository.save).toHaveBeenCalledWith([
        expect.objectContaining({
          id: targetAgent.id,
          assignedSessionId: session.id,
        }),
      ]);
      expect(result).toEqual(
        expect.objectContaining({
          id: targetAgent.id,
          teamLeaderId: targetTeamLeader.id,
          assignedSessionId: session.id,
        }),
      );
      expect(eventsGateway.evictApiKey).toHaveBeenCalledWith(
        'agent-key',
        'authorization_changed',
      );
      expect(eventsGateway.evictApiKey).toHaveBeenCalledWith(
        'team-leader-key',
        'authorization_changed',
      );
    });

    it('unassigns the previous Agent when the Session is moved to another Agent', async () => {
      const targetTeamLeader = createTeamLeader({
        id: 'team-leader-2',
      });
      const targetAgent = createAgent({
        id: 'agent-target',
        teamLeaderId: targetTeamLeader.id,
        teamLeader: targetTeamLeader,
        assignedSessionId: null,
      });
      const previousAgent = createAgent({
        id: 'agent-previous',
        teamLeaderId: 'team-leader-1',
        assignedSessionId: 'session-1',
      });
      const session = createSession({
        id: 'session-1',
        ownerTeamLeaderId: 'team-leader-1',
      });
      const finalSession = createSession({
        ...session,
        ownerTeamLeaderId: targetTeamLeader.id,
      });
      const finalAgent = createAgent({
        ...targetAgent,
        assignedSessionId: session.id,
      });

      agentRepository.findOne
        .mockResolvedValueOnce(targetAgent)
        .mockResolvedValueOnce(targetAgent)
        .mockResolvedValueOnce(finalAgent);
      teamLeaderRepository.findOne.mockResolvedValue(targetTeamLeader);
      sessionRepository.findOne
        .mockResolvedValueOnce(session)
        .mockResolvedValueOnce(finalSession);
      sessionRepository.find.mockResolvedValue([finalSession]);
      agentRepository.find
        .mockResolvedValueOnce([previousAgent])
        .mockResolvedValueOnce([previousAgent])
        .mockResolvedValueOnce([finalAgent]);
      sessionTransactionalRepository.findOne.mockResolvedValue(session);
      sessionTransactionalRepository.save.mockResolvedValue(finalSession);
      agentRepository.save.mockImplementation(async (agents: Agent[]) => agents);
      apiKeyRepository.find.mockResolvedValue([]);

      await service.assignAdminAgentSession(targetAgent.id, session.id);

      expect(agentRepository.save).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: previousAgent.id,
            assignedSessionId: null,
          }),
          expect.objectContaining({
            id: targetAgent.id,
            assignedSessionId: session.id,
          }),
        ]),
      );
    });

    it('unassigns an Agent while preserving Session Team Leader ownership', async () => {
      const agent = createAgent({
        assignedSessionId: 'session-1',
      });
      const unassignedAgent = createAgent({
        ...agent,
        assignedSessionId: null,
      });

      agentRepository.findOne
        .mockResolvedValueOnce(agent)
        .mockResolvedValueOnce(agent)
        .mockResolvedValueOnce(unassignedAgent);
      agentRepository.find.mockResolvedValue([unassignedAgent]);
      agentRepository.save.mockImplementation(async (value: Agent) => value);
      apiKeyRepository.find.mockResolvedValue([]);

      const result = await service.assignAdminAgentSession(agent.id, null);

      expect(result.assignedSessionId).toBeNull();
      expect(sessionRepository.findOne).not.toHaveBeenCalled();
      expect(sessionRepository.manager.transaction).not.toHaveBeenCalled();
    });

    it('returns 404 when the Agent does not exist', async () => {
      agentRepository.findOne.mockResolvedValue(null);

      await expect(
        service.assignAdminAgentSession('missing-agent', 'session-1'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(sessionRepository.findOne).not.toHaveBeenCalled();
    });

    it('returns 404 when the Session does not exist', async () => {
      const agent = createAgent();
      agentRepository.findOne.mockResolvedValue(agent);
      sessionRepository.findOne.mockResolvedValue(null);

      await expect(
        service.assignAdminAgentSession(agent.id, 'missing-session'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('reassignAdminSessions', () => {
    function mockTeamLeaders(
      sourceId = 'team-leader-1',
      targetId = 'team-leader-2',
    ): void {
      teamLeaderRepository.findOne.mockImplementation(
        ({ where }: { where: { id: string } }) => {
          if (where.id === sourceId) {
            return Promise.resolve(
              createTeamLeader({
                id: sourceId,
                name: 'Source Leader',
              }),
            );
          }

          if (where.id === targetId) {
            return Promise.resolve(
              createTeamLeader({
                id: targetId,
                name: 'Target Leader',
                email: 'target@example.com',
              }),
            );
          }

          return Promise.resolve(null);
        },
      );
    }

    it('transfers unassigned Sessions in the data DB and evicts affected Team Leader keys', async () => {
      const sourceId = 'team-leader-1';
      const targetId = 'team-leader-2';
      const sessionA = createSession({
        id: 'session-a',
        ownerTeamLeaderId: sourceId,
      });
      const sessionB = createSession({
        id: 'session-b',
        ownerTeamLeaderId: sourceId,
      });

      mockTeamLeaders(sourceId, targetId);
      sessionRepository.find.mockResolvedValue([sessionA, sessionB]);
      agentRepository.find
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      sessionTransactionalRepository.find.mockResolvedValue([
        sessionA,
        sessionB,
      ]);
      sessionTransactionalRepository.save.mockImplementation(
        async (sessions: Session[]) => sessions,
      );
      apiKeyRepository.find.mockResolvedValue([
        createApiKey({
          id: 'source-key',
          role: ApiKeyRole.TEAM_LEADER,
          teamLeaderId: sourceId,
        }),
        createApiKey({
          id: 'target-key',
          role: ApiKeyRole.TEAM_LEADER,
          teamLeaderId: targetId,
        }),
      ]);

      const result = await service.reassignAdminSessions(
        sourceId,
        [sessionA.id, sessionB.id],
        targetId,
      );

      expect(sessionRepository.manager.transaction).toHaveBeenCalledTimes(1);
      expect(sessionTransactionManager.getRepository).toHaveBeenCalledWith(
        Session,
      );
      expect(sessionTransactionalRepository.save).toHaveBeenCalledWith([
        expect.objectContaining({
          id: sessionA.id,
          ownerTeamLeaderId: targetId,
        }),
        expect.objectContaining({
          id: sessionB.id,
          ownerTeamLeaderId: targetId,
        }),
      ]);
      expect(result.map(item => item.ownerTeamLeaderId)).toEqual([
        targetId,
        targetId,
      ]);
      expect(eventsGateway.evictApiKey).toHaveBeenCalledWith(
        'source-key',
        'authorization_changed',
      );
      expect(eventsGateway.evictApiKey).toHaveBeenCalledWith(
        'target-key',
        'authorization_changed',
      );
    });

    it('returns Sessions in caller order and treats duplicate ids as one transfer', async () => {
      const sourceId = 'team-leader-1';
      const targetId = 'team-leader-2';
      const session = createSession({
        id: 'session-a',
        ownerTeamLeaderId: sourceId,
      });

      mockTeamLeaders(sourceId, targetId);
      sessionRepository.find.mockResolvedValue([session]);
      agentRepository.find
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      sessionTransactionalRepository.find.mockResolvedValue([session]);
      sessionTransactionalRepository.save.mockImplementation(
        async (sessions: Session[]) => sessions,
      );
      apiKeyRepository.find.mockResolvedValue([]);

      const result = await service.reassignAdminSessions(
        sourceId,
        [session.id, session.id],
        targetId,
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(session.id);
    });

    it('rejects a transfer when any Session is assigned to an Agent', async () => {
      mockTeamLeaders();

      const session = createSession({
        id: 'session-a',
      });

      sessionRepository.find.mockResolvedValue([session]);
      agentRepository.find.mockResolvedValue([
        createAgent({
          id: 'agent-a',
          assignedSessionId: session.id,
        }),
      ]);

      await expect(
        service.reassignAdminSessions(
          'team-leader-1',
          [session.id],
          'team-leader-2',
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(sessionRepository.manager.transaction).not.toHaveBeenCalled();
    });

    it('returns 404 when a requested Session is not owned by the source Team Leader', async () => {
      mockTeamLeaders();
      sessionRepository.find.mockResolvedValue([]);

      await expect(
        service.reassignAdminSession(
          'team-leader-1',
          'foreign-session',
          'team-leader-2',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('does not write when source and target Team Leader are the same', async () => {
      const teamLeader = createTeamLeader();
      const session = createSession();

      teamLeaderRepository.findOne.mockResolvedValue(teamLeader);
      sessionRepository.find.mockResolvedValue([session]);

      const result = await service.reassignAdminSession(
        teamLeader.id,
        session.id,
        teamLeader.id,
      );

      expect(result.ownerTeamLeaderId).toBe(teamLeader.id);
      expect(sessionRepository.manager.transaction).not.toHaveBeenCalled();
      expect(agentRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('deleteTeamLeader', () => {
    it('returns 409 when the Team Leader still owns Sessions', async () => {
      teamLeaderRepository.findOne.mockResolvedValue(createTeamLeader());
      sessionRepository.count.mockResolvedValue(1);
      agentRepository.count.mockResolvedValue(0);

      await expect(
        service.deleteTeamLeader('team-leader-1'),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(mainDataSource.transaction).not.toHaveBeenCalled();
    });

    it('returns 409 when the Team Leader still owns Agents', async () => {
      teamLeaderRepository.findOne.mockResolvedValue(createTeamLeader());
      sessionRepository.count.mockResolvedValue(0);
      agentRepository.count.mockResolvedValue(1);

      await expect(
        service.deleteTeamLeader('team-leader-1'),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(mainDataSource.transaction).not.toHaveBeenCalled();
    });

    it('deletes an empty Team Leader and evicts its Team Leader API keys', async () => {
      const teamLeader = createTeamLeader();

      teamLeaderRepository.findOne.mockResolvedValue(teamLeader);
      sessionRepository.count.mockResolvedValue(0);
      agentRepository.count.mockResolvedValue(0);
      agentRepository.find.mockResolvedValue([]);
      apiKeyRepository.find.mockResolvedValue([
        createApiKey({
          id: 'team-leader-key',
          role: ApiKeyRole.TEAM_LEADER,
          teamLeaderId: teamLeader.id,
        }),
      ]);
      teamLeaderRepository.remove.mockResolvedValue(teamLeader);

      await expect(
        service.deleteTeamLeader(teamLeader.id),
      ).resolves.toBeUndefined();

      expect(teamLeaderRepository.remove).toHaveBeenCalledWith(teamLeader);
      expect(eventsGateway.evictApiKey).toHaveBeenCalledWith(
        'team-leader-key',
        'deleted',
      );
    });

    it('returns 404 when the Team Leader does not exist', async () => {
      teamLeaderRepository.findOne.mockResolvedValue(null);

      await expect(
        service.deleteTeamLeader('missing-team-leader'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(sessionRepository.count).not.toHaveBeenCalled();
      expect(agentRepository.count).not.toHaveBeenCalled();
    });
  });

  describe('retireTeamLeader', () => {
    it('deletes an already-empty Team Leader through the safe principal lifecycle', async () => {
      const teamLeader = createTeamLeader();

      teamLeaderRepository.findOne.mockResolvedValue(teamLeader);
      sessionRepository.find.mockResolvedValue([]);
      agentRepository.find.mockResolvedValue([]);
      sessionRepository.count.mockResolvedValue(0);
      agentRepository.count.mockResolvedValue(0);
      apiKeyRepository.find.mockResolvedValue([]);
      teamLeaderRepository.remove.mockResolvedValue(teamLeader);

      await expect(
        service.retireTeamLeader(teamLeader.id, {
          sessionReassignments: [],
          agentReassignments: [],
        }),
      ).resolves.toEqual({
        teamLeaderId: teamLeader.id,
        teamLeaderName: teamLeader.name,
        delegatedSessionIds: [],
        delegatedAgentIds: [],
        preservedAgentSessionAssignments: 0,
      });

      expect(teamLeaderRepository.remove).toHaveBeenCalledWith(teamLeader);
    });

    it('rejects a retirement plan that omits current resources', async () => {
      const teamLeader = createTeamLeader();
      const session = createSession();

      teamLeaderRepository.findOne.mockResolvedValue(teamLeader);
      sessionRepository.find.mockResolvedValue([session]);
      agentRepository.find.mockResolvedValue([]);

      await expect(
        service.retireTeamLeader(teamLeader.id, {
          sessionReassignments: [],
          agentReassignments: [],
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(mainDataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('forceDeleteTeamLeader', () => {
    it('deletes owned Sessions through SessionService before deleting Agents and the Team Leader', async () => {
      const teamLeader = createTeamLeader();
      const sessionA = createSession({
        id: 'session-a',
        ownerTeamLeaderId: teamLeader.id,
      });
      const sessionB = createSession({
        id: 'session-b',
        ownerTeamLeaderId: teamLeader.id,
      });
      const agentA = createAgent({
        id: 'agent-a',
        teamLeaderId: teamLeader.id,
        assignedSessionId: sessionA.id,
      });
      const agentB = createAgent({
        id: 'agent-b',
        teamLeaderId: teamLeader.id,
        assignedSessionId: null,
      });

      teamLeaderRepository.findOne
        .mockResolvedValueOnce(teamLeader)
        .mockResolvedValueOnce(teamLeader);

      sessionRepository.find
        .mockResolvedValueOnce([
          sessionA,
          sessionB,
        ])
        .mockResolvedValueOnce([]);

      sessionService.delete.mockResolvedValue(undefined);
      sessionRepository.count.mockResolvedValue(0);

      agentRepository.find.mockResolvedValue([
        agentA,
        agentB,
      ]);

      apiKeyRepository.find.mockResolvedValue([
        createApiKey({
          id: 'team-leader-key',
          role: ApiKeyRole.TEAM_LEADER,
          teamLeaderId: teamLeader.id,
        }),
        createApiKey({
          id: 'agent-a-key',
          role: ApiKeyRole.AGENT,
          agentId: agentA.id,
        }),
      ]);

      agentRepository.delete.mockResolvedValue({
        affected: 2,
        raw: [],
      });
      teamLeaderRepository.remove.mockResolvedValue(teamLeader);

      const result =
        await service.forceDeleteTeamLeader(
          teamLeader.id,
        );

      expect(
        sessionService.delete,
      ).toHaveBeenNthCalledWith(
        1,
        sessionA.id,
      );
      expect(
        sessionService.delete,
      ).toHaveBeenNthCalledWith(
        2,
        sessionB.id,
      );

      expect(
        agentRepository.delete,
      ).toHaveBeenCalledWith({
        id: expect.anything(),
      });

      expect(
        teamLeaderRepository.remove,
      ).toHaveBeenCalledWith(
        teamLeader,
      );

      expect(result).toEqual({
        teamLeaderId:
          teamLeader.id,
        teamLeaderName:
          teamLeader.name,
        deletedSessionIds: [
          sessionA.id,
          sessionB.id,
        ],
        deletedAgentIds: [
          agentA.id,
          agentB.id,
        ],
      });

      expect(
        eventsGateway.evictApiKey,
      ).toHaveBeenCalledWith(
        'team-leader-key',
        'deleted',
      );
      expect(
        eventsGateway.evictApiKey,
      ).toHaveBeenCalledWith(
        'agent-a-key',
        'deleted',
      );
    });

    it('does not delete Agents or the Team Leader if a Session lifecycle deletion fails', async () => {
      const teamLeader = createTeamLeader();
      const session = createSession({
        id: 'session-a',
        ownerTeamLeaderId:
          teamLeader.id,
      });
      const error =
        new Error(
          'Session teardown failed',
        );

      teamLeaderRepository.findOne.mockResolvedValue(
        teamLeader,
      );
      sessionRepository.find.mockResolvedValue([
        session,
      ]);
      sessionService.delete.mockRejectedValue(
        error,
      );

      await expect(
        service.forceDeleteTeamLeader(
          teamLeader.id,
        ),
      ).rejects.toBe(error);

      expect(
        mainDataSource.transaction,
      ).not.toHaveBeenCalled();
      expect(
        agentRepository.delete,
      ).not.toHaveBeenCalled();
      expect(
        teamLeaderRepository.remove,
      ).not.toHaveBeenCalled();
    });

    it('returns 404 when the Team Leader does not exist', async () => {
      teamLeaderRepository.findOne.mockResolvedValue(
        null,
      );

      await expect(
        service.forceDeleteTeamLeader(
          'missing-team-leader',
        ),
      ).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(
        sessionService.delete,
      ).not.toHaveBeenCalled();
    });
  });

  describe('createAgent', () => {
    it('creates an Agent and API key in the same main DB transaction', async () => {
      const teamLeader = createTeamLeader();
      const savedAgent = createAgent();

      teamLeaderRepository.findOne.mockResolvedValue(teamLeader);
      agentRepository.create.mockImplementation(
        (input: Partial<Agent>) => createAgent(input),
      );
      agentRepository.save.mockResolvedValue(savedAgent);
      authService.createApiKeyInTransaction.mockResolvedValue({
        apiKey: createApiKey({
          role: ApiKeyRole.AGENT,
          agentId: savedAgent.id,
        }),
        rawKey: 'owa_k1_plaintext_agent',
      });

      const result = await service.createAgent(teamLeader.id, {
        name: '  Mohamed Ali  ',
        email: '  MOHAMED@EXAMPLE.COM ',
        templateSendLimit24h: 25,
      });

      expect(agentRepository.create).toHaveBeenCalledWith({
        name: 'Mohamed Ali',
        email: 'mohamed@example.com',
        teamLeaderId: teamLeader.id,
        assignedSessionId: null,
        templateSendLimit24h: 25,
      });
      expect(result).toEqual({
        agent: savedAgent,
        apiKey: 'owa_k1_plaintext_agent',
      });
    });

    it('returns 404 when the owning Team Leader does not exist', async () => {
      teamLeaderRepository.findOne.mockResolvedValue(null);

      await expect(
        service.createAgent('missing-team-leader', {
          name: 'Agent',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(agentRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('rotateAgentApiKey', () => {
    it('atomically replaces previous Agent keys and evicts them after commit', async () => {
      const agent = createAgent();
      const oldKey = createApiKey({
        id: 'old-agent-key',
        role: ApiKeyRole.AGENT,
        agentId: agent.id,
      });

      agentRepository.findOne.mockResolvedValue(agent);
      apiKeyRepository.find.mockResolvedValue([oldKey]);
      apiKeyRepository.remove.mockResolvedValue([oldKey]);
      authService.createApiKeyInTransaction.mockResolvedValue({
        apiKey: createApiKey({
          id: 'new-agent-key',
          role: ApiKeyRole.AGENT,
          agentId: agent.id,
        }),
        rawKey: 'owa_k1_replacement',
      });

      await expect(
        service.rotateAgentApiKey(agent.teamLeaderId, agent.id),
      ).resolves.toEqual({
        agent,
        apiKey: 'owa_k1_replacement',
      });

      expect(apiKeyRepository.remove).toHaveBeenCalledWith([oldKey]);
      expect(eventsGateway.evictApiKey).toHaveBeenCalledWith(
        oldKey.id,
        'revoked',
      );
    });
  });

  describe('ADMIN Agent reads', () => {
    it('returns all Agents with Team Leader and assigned Session metadata', async () => {
      const teamLeader = createTeamLeader();
      const session = createSession({
        status: 'ready' as Session['status'],
      });
      const agent = createAgent({
        teamLeader,
        assignedSessionId: session.id,
      });

      agentRepository.find.mockResolvedValue([agent]);
      sessionRepository.find.mockResolvedValue([session]);

      const result = await service.getAdminAgents();

      expect(result).toEqual([
        {
          id: agent.id,
          name: agent.name,
          email: agent.email,
          teamLeaderId: agent.teamLeaderId,
          teamLeader: {
            id: teamLeader.id,
            name: teamLeader.name,
            email: teamLeader.email,
          },
          assignedSessionId: session.id,
          assignedSession: {
            id: session.id,
            name: session.name,
            status: session.status,
            phone: session.phone,
            targetPhone: session.targetPhone,
          },
          templateSendLimit24h: agent.templateSendLimit24h,
          createdAt: agent.createdAt,
          updatedAt: agent.updatedAt,
        },
      ]);
    });

    it('preserves a stale assignedSessionId while returning null Session metadata', async () => {
      const agent = createAgent({
        assignedSessionId: 'missing-session',
      });

      agentRepository.find.mockResolvedValue([agent]);
      sessionRepository.find.mockResolvedValue([]);

      const [result] = await service.getAdminAgents();

      expect(result.assignedSessionId).toBe('missing-session');
      expect(result.assignedSession).toBeNull();
    });

    it('returns one Agent by id', async () => {
      const agent = createAgent();
      agentRepository.findOne.mockResolvedValue(agent);

      await expect(service.getAdminAgent(agent.id)).resolves.toEqual(
        expect.objectContaining({
          id: agent.id,
          teamLeaderId: agent.teamLeaderId,
        }),
      );
    });

    it('returns 404 for an unknown Admin Agent id', async () => {
      agentRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getAdminAgent('missing-agent'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('reassignAdminAgents', () => {
    it('moves an unassigned Agent to another Team Leader and evicts its key', async () => {
      const sourceTeamLeader = createTeamLeader();
      const targetTeamLeader = createTeamLeader({
        id: 'team-leader-2',
        name: 'Target Leader',
        email: 'target@example.com',
      });
      const originalAgent = createAgent({
        teamLeaderId: sourceTeamLeader.id,
        teamLeader: sourceTeamLeader,
        assignedSessionId: null,
      });
      const movedAgent = createAgent({
        id: originalAgent.id,
        teamLeaderId: targetTeamLeader.id,
        teamLeader: targetTeamLeader,
        assignedSessionId: null,
      });

      teamLeaderRepository.findOne.mockResolvedValue(targetTeamLeader);
      agentRepository.find
        .mockResolvedValueOnce([originalAgent])
        .mockResolvedValueOnce([originalAgent])
        .mockResolvedValueOnce([movedAgent]);
      agentRepository.save.mockResolvedValue([originalAgent]);
      apiKeyRepository.find.mockResolvedValue([
        createApiKey({
          id: 'agent-key',
          role: ApiKeyRole.AGENT,
          agentId: originalAgent.id,
        }),
      ]);

      const result = await service.reassignAdminAgent(
        originalAgent.id,
        targetTeamLeader.id,
        false,
      );

      expect(agentRepository.save).toHaveBeenCalledWith([
        expect.objectContaining({
          id: originalAgent.id,
          teamLeaderId: targetTeamLeader.id,
          assignedSessionId: null,
        }),
      ]);
      expect(result.teamLeaderId).toBe(targetTeamLeader.id);
      expect(eventsGateway.evictApiKey).toHaveBeenCalledWith(
        'agent-key',
        'authorization_changed',
      );
    });

    it('requires explicit unassignment when the target Team Leader does not own the Agent Session', async () => {
      const targetTeamLeader = createTeamLeader({
        id: 'team-leader-2',
      });
      const agent = createAgent({
        assignedSessionId: 'session-1',
      });

      teamLeaderRepository.findOne.mockResolvedValue(targetTeamLeader);
      agentRepository.find.mockResolvedValue([agent]);
      sessionRepository.find.mockResolvedValue([]);

      await expect(
        service.reassignAdminAgent(
          agent.id,
          targetTeamLeader.id,
          false,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(mainDataSource.transaction).not.toHaveBeenCalled();
    });

    it('can explicitly unassign the Session while moving the Agent', async () => {
      const sourceTeamLeader = createTeamLeader();
      const targetTeamLeader = createTeamLeader({
        id: 'team-leader-2',
        name: 'Target Leader',
      });
      const originalAgent = createAgent({
        teamLeaderId: sourceTeamLeader.id,
        teamLeader: sourceTeamLeader,
        assignedSessionId: 'session-1',
      });
      const movedAgent = createAgent({
        id: originalAgent.id,
        teamLeaderId: targetTeamLeader.id,
        teamLeader: targetTeamLeader,
        assignedSessionId: null,
      });

      teamLeaderRepository.findOne.mockResolvedValue(targetTeamLeader);
      agentRepository.find
        .mockResolvedValueOnce([originalAgent])
        .mockResolvedValueOnce([originalAgent])
        .mockResolvedValueOnce([movedAgent]);
      agentRepository.save.mockResolvedValue([originalAgent]);
      apiKeyRepository.find.mockResolvedValue([]);

      const result = await service.reassignAdminAgent(
        originalAgent.id,
        targetTeamLeader.id,
        true,
      );

      expect(agentRepository.save).toHaveBeenCalledWith([
        expect.objectContaining({
          id: originalAgent.id,
          teamLeaderId: targetTeamLeader.id,
          assignedSessionId: null,
        }),
      ]);
      expect(result.assignedSessionId).toBeNull();
      expect(sessionRepository.find).not.toHaveBeenCalled();
    });

    it('preserves an assignment when the target Team Leader already owns that Session', async () => {
      const targetTeamLeader = createTeamLeader({
        id: 'team-leader-2',
      });
      const originalAgent = createAgent({
        assignedSessionId: 'session-target-owned',
      });
      const movedAgent = createAgent({
        id: originalAgent.id,
        teamLeaderId: targetTeamLeader.id,
        teamLeader: targetTeamLeader,
        assignedSessionId: 'session-target-owned',
      });

      teamLeaderRepository.findOne.mockResolvedValue(targetTeamLeader);
      agentRepository.find
        .mockResolvedValueOnce([originalAgent])
        .mockResolvedValueOnce([originalAgent])
        .mockResolvedValueOnce([movedAgent]);
      sessionRepository.find
        .mockResolvedValueOnce([
          createSession({
            id: 'session-target-owned',
            ownerTeamLeaderId: targetTeamLeader.id,
          }),
        ])
        .mockResolvedValueOnce([
          createSession({
            id: 'session-target-owned',
            ownerTeamLeaderId: targetTeamLeader.id,
          }),
        ])
        .mockResolvedValueOnce([
          createSession({
            id: 'session-target-owned',
            ownerTeamLeaderId: targetTeamLeader.id,
          }),
        ]);
      agentRepository.save.mockResolvedValue([originalAgent]);
      apiKeyRepository.find.mockResolvedValue([]);

      const result = await service.reassignAdminAgent(
        originalAgent.id,
        targetTeamLeader.id,
        false,
      );

      expect(result.assignedSessionId).toBe('session-target-owned');
    });
  });

  describe('deleteAdminAgent', () => {
    it('deletes an Agent without deleting its Session and evicts the Agent key', async () => {
      const agent = createAgent({
        assignedSessionId: 'session-1',
      });

      agentRepository.findOne.mockResolvedValue(agent);
      apiKeyRepository.find.mockResolvedValue([
        createApiKey({
          id: 'agent-key',
          role: ApiKeyRole.AGENT,
          agentId: agent.id,
        }),
      ]);
      agentRepository.remove.mockResolvedValue(agent);

      await expect(
        service.deleteAdminAgent(agent.id),
      ).resolves.toBeUndefined();

      expect(agentRepository.remove).toHaveBeenCalledWith(agent);
      expect(sessionRepository.findOne).not.toHaveBeenCalled();
      expect(sessionRepository.find).not.toHaveBeenCalled();
      expect(eventsGateway.evictApiKey).toHaveBeenCalledWith(
        'agent-key',
        'deleted',
      );
    });

    it('returns 404 for an unknown Agent', async () => {
      agentRepository.findOne.mockResolvedValue(null);

      await expect(
        service.deleteAdminAgent('missing-agent'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(mainDataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('Agent self-service operations', () => {
    it('lists only Agents belonging to the Team Leader', async () => {
      const teamLeader = createTeamLeader();
      const agents = [createAgent()];

      teamLeaderRepository.findOne.mockResolvedValue(teamLeader);
      agentRepository.find.mockResolvedValue(agents);

      await expect(service.listAgents(teamLeader.id)).resolves.toBe(agents);
      expect(agentRepository.find).toHaveBeenCalledWith({
        where: {
          teamLeaderId: teamLeader.id,
        },
        order: {
          createdAt: 'DESC',
        },
      });
    });

    it('assigns only a Session owned by the Agent Team Leader and evicts old authorization', async () => {
      const agent = createAgent({
        assignedSessionId: null,
      });
      const session = createSession();

      agentRepository.findOne
        .mockResolvedValueOnce(agent)
        .mockResolvedValueOnce(null);
      sessionRepository.findOne.mockResolvedValue(session);
      agentRepository.save.mockImplementation(async (value: Agent) => value);
      apiKeyRepository.find.mockResolvedValue([
        createApiKey({
          id: 'agent-key',
          role: ApiKeyRole.AGENT,
          agentId: agent.id,
        }),
      ]);

      const result = await service.assignAgentSession(
        agent.teamLeaderId,
        agent.id,
        session.id,
      );

      expect(sessionRepository.findOne).toHaveBeenCalledWith({
        where: {
          id: session.id,
          ownerTeamLeaderId: agent.teamLeaderId,
        },
      });
      expect(result.assignedSessionId).toBe(session.id);
      expect(eventsGateway.evictApiKey).toHaveBeenCalledWith(
        'agent-key',
        'authorization_changed',
      );
    });

    it('rejects assigning a Session already assigned to another Agent', async () => {
      const agent = createAgent({
        id: 'agent-1',
      });
      const otherAgent = createAgent({
        id: 'agent-2',
        assignedSessionId: 'session-1',
      });

      agentRepository.findOne
        .mockResolvedValueOnce(agent)
        .mockResolvedValueOnce(otherAgent);
      sessionRepository.findOne.mockResolvedValue(createSession());

      await expect(
        service.assignAgentSession(
          agent.teamLeaderId,
          agent.id,
          'session-1',
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(agentRepository.save).not.toHaveBeenCalled();
    });

    it('unassigns an Agent without querying the Session database', async () => {
      const agent = createAgent({
        assignedSessionId: 'session-1',
      });

      agentRepository.findOne.mockResolvedValue(agent);
      agentRepository.save.mockImplementation(async (value: Agent) => value);
      apiKeyRepository.find.mockResolvedValue([]);

      const result = await service.unassignAgentSession(
        agent.teamLeaderId,
        agent.id,
      );

      expect(result.assignedSessionId).toBeNull();
      expect(sessionRepository.findOne).not.toHaveBeenCalled();
    });

    it('deletes only an Agent owned by the caller Team Leader', async () => {
      const agent = createAgent();

      agentRepository.findOne.mockResolvedValue(agent);
      apiKeyRepository.find.mockResolvedValue([]);
      agentRepository.remove.mockResolvedValue(agent);

      await expect(
        service.deleteAgent(agent.teamLeaderId, agent.id),
      ).resolves.toBeUndefined();

      expect(agentRepository.remove).toHaveBeenCalledWith(agent);
    });
  });

  describe('WebSocket eviction resilience', () => {
    it('does not fail a committed authorization change when EventsGateway is unavailable', async () => {
      const agent = createAgent({
        assignedSessionId: 'session-1',
      });

      agentRepository.findOne.mockResolvedValue(agent);
      agentRepository.save.mockImplementation(async (value: Agent) => value);
      apiKeyRepository.find.mockResolvedValue([
        createApiKey({
          id: 'agent-key',
          role: ApiKeyRole.AGENT,
          agentId: agent.id,
        }),
      ]);
      moduleRef.get.mockImplementation(() => {
        throw new Error('Gateway unavailable');
      });

      await expect(
        service.unassignAgentSession(agent.teamLeaderId, agent.id),
      ).resolves.toEqual(
        expect.objectContaining({
          assignedSessionId: null,
        }),
      );
    });

    it('does not resolve EventsGateway when no API keys were affected', async () => {
      const agent = createAgent({
        assignedSessionId: 'session-1',
      });

      agentRepository.findOne.mockResolvedValue(agent);
      agentRepository.save.mockImplementation(async (value: Agent) => value);
      apiKeyRepository.find.mockResolvedValue([]);

      await service.unassignAgentSession(agent.teamLeaderId, agent.id);

      expect(moduleRef.get).not.toHaveBeenCalled();
    });
  });
});



