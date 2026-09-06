

import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import {
  AgentController,
} from './agent.controller';

import {
  TeamLeaderService,
} from './teamleader.service';

import {
  Agent,
} from './entities/agent.entity';

import {
  TeamLeader,
} from './entities/team-leader.entity';

import {
  ApiKey,
  ApiKeyRole,
} from '../auth/entities/api-key.entity';

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

    name:
      'Mohamed Ali',

    email:
      'mohamed@example.com',

    teamLeaderId:
      'team-leader-1',

    teamLeader:
      createTeamLeader(),

    assignedSessionId:
      'session-1',

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
    id:
      'agent-key-1',

    name:
      'Agent Key',

    keyHash:
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',

    keyPrefix:
      'owa_k1_agent',

    role:
      ApiKeyRole.AGENT,

    teamLeaderId:
      null,

    teamLeader:
      null,

    agentId:
      'agent-1',

    agent:
      null,

    allowedIps:
      null,

    allowedSessions:
      null,

    isActive:
      true,

    expiresAt:
      null,

    lastUsedAt:
      null,

    usageCount:
      0,

    createdAt:
      new Date(
        '2026-01-01T00:00:00Z',
      ),

    updatedAt:
      new Date(
        '2026-01-01T00:00:00Z',
      ),

    ...overrides,
  } as ApiKey;
}

describe(
  'AgentController',
  () => {
    let controller: AgentController;

    let teamLeaderService: {
      getAgentIdentity: jest.Mock;
    };

    beforeEach(() => {
      teamLeaderService = {
        getAgentIdentity:
          jest.fn(),
      };

      controller =
        new AgentController(
          teamLeaderService as unknown as TeamLeaderService,
        );
    });

    // -------------------------------------------------------------------------
    // GET /agent/me
    // -------------------------------------------------------------------------

    describe(
      'getMe',
      () => {
        it(
          'returns the Agent identity bound to the authenticated AGENT API key',
          async () => {
            const apiKey =
              createApiKey();

            const agent =
              createAgent();

            teamLeaderService
              .getAgentIdentity
              .mockResolvedValue(
                agent,
              );

            const result =
              await controller.getMe(
                apiKey,
              );

            expect(
              teamLeaderService.getAgentIdentity,
            ).toHaveBeenCalledTimes(
              1,
            );

            expect(
              teamLeaderService.getAgentIdentity,
            ).toHaveBeenCalledWith(
              'agent-1',
            );

            expect(
              result,
            ).toBe(
              agent,
            );
          },
        );

        it(
          'returns the Team Leader binding and assigned session from the Agent principal',
          async () => {
            const agent =
              createAgent({
                teamLeaderId:
                  'team-leader-a',

                assignedSessionId:
                  'session-a',
              });

            teamLeaderService
              .getAgentIdentity
              .mockResolvedValue(
                agent,
              );

            const result =
              await controller.getMe(
                createApiKey(),
              );

            expect(
              result.teamLeaderId,
            ).toBe(
              'team-leader-a',
            );

            expect(
              result.assignedSessionId,
            ).toBe(
              'session-a',
            );
          },
        );

        it(
          'returns assignedSessionId:null for an unassigned Agent',
          async () => {
            const agent =
              createAgent({
                assignedSessionId:
                  null,
              });

            teamLeaderService
              .getAgentIdentity
              .mockResolvedValue(
                agent,
              );

            const result =
              await controller.getMe(
                createApiKey(),
              );

            expect(
              result.assignedSessionId,
            ).toBeNull();
          },
        );

        it(
          'uses agentId from the authenticated API key rather than accepting an Agent id from the request',
          async () => {
            const apiKey =
              createApiKey({
                agentId:
                  'authenticated-agent',
              });

            const agent =
              createAgent({
                id:
                  'authenticated-agent',
              });

            teamLeaderService
              .getAgentIdentity
              .mockResolvedValue(
                agent,
              );

            await controller.getMe(
              apiKey,
            );

            expect(
              teamLeaderService.getAgentIdentity,
            ).toHaveBeenCalledWith(
              'authenticated-agent',
            );
          },
        );

        it(
          'rejects a malformed AGENT API key without agentId',
          async () => {
            const malformedKey =
              createApiKey({
                role:
                  ApiKeyRole.AGENT,

                agentId:
                  null,
              });

            await expect(
              controller.getMe(
                malformedKey,
              ),
            ).rejects.toBeInstanceOf(
              ForbiddenException,
            );

            expect(
              teamLeaderService.getAgentIdentity,
            ).not.toHaveBeenCalled();
          },
        );

        it(
          'rejects a TEAM_LEADER key even though it may have SESSION_READ capability',
          async () => {
            const teamLeaderKey =
              createApiKey({
                role:
                  ApiKeyRole.TEAM_LEADER,

                agentId:
                  null,

                teamLeaderId:
                  'team-leader-1',
              });

            await expect(
              controller.getMe(
                teamLeaderKey,
              ),
            ).rejects.toBeInstanceOf(
              ForbiddenException,
            );

            expect(
              teamLeaderService.getAgentIdentity,
            ).not.toHaveBeenCalled();
          },
        );

        it(
          'rejects an ADMIN key even though ADMIN has SESSION_READ capability',
          async () => {
            const adminKey =
              createApiKey({
                role:
                  ApiKeyRole.ADMIN,

                agentId:
                  null,
              });

            await expect(
              controller.getMe(
                adminKey,
              ),
            ).rejects.toBeInstanceOf(
              ForbiddenException,
            );

            expect(
              teamLeaderService.getAgentIdentity,
            ).not.toHaveBeenCalled();
          },
        );

        it(
          'rejects an OPERATOR key even though OPERATOR has SESSION_READ capability',
          async () => {
            const operatorKey =
              createApiKey({
                role:
                  ApiKeyRole.OPERATOR,

                agentId:
                  null,
              });

            await expect(
              controller.getMe(
                operatorKey,
              ),
            ).rejects.toBeInstanceOf(
              ForbiddenException,
            );

            expect(
              teamLeaderService.getAgentIdentity,
            ).not.toHaveBeenCalled();
          },
        );

        it(
          'rejects a VIEWER key even though VIEWER has SESSION_READ capability',
          async () => {
            const viewerKey =
              createApiKey({
                role:
                  ApiKeyRole.VIEWER,

                agentId:
                  null,
              });

            await expect(
              controller.getMe(
                viewerKey,
              ),
            ).rejects.toBeInstanceOf(
              ForbiddenException,
            );

            expect(
              teamLeaderService.getAgentIdentity,
            ).not.toHaveBeenCalled();
          },
        );

        it(
          'rejects a non-Agent role even if an agentId was incorrectly attached to the key',
          async () => {
            const malformedAdminKey =
              createApiKey({
                role:
                  ApiKeyRole.ADMIN,

                agentId:
                  'agent-1',
              });

            await expect(
              controller.getMe(
                malformedAdminKey,
              ),
            ).rejects.toBeInstanceOf(
              ForbiddenException,
            );

            expect(
              teamLeaderService.getAgentIdentity,
            ).not.toHaveBeenCalled();
          },
        );

        it(
          'forwards 404 when the Agent principal bound to the key no longer exists',
          async () => {
            const notFound =
              new NotFoundException(
                'Agent not found',
              );

            teamLeaderService
              .getAgentIdentity
              .mockRejectedValue(
                notFound,
              );

            await expect(
              controller.getMe(
                createApiKey(),
              ),
            ).rejects.toBe(
              notFound,
            );

            expect(
              teamLeaderService.getAgentIdentity,
            ).toHaveBeenCalledWith(
              'agent-1',
            );
          },
        );

        it(
          'does not perform session authorization inside the Agent identity controller',
          async () => {
            const apiKey =
              createApiKey({
                allowedSessions: [
                  'session-other',
                ],
              });

            const agent =
              createAgent({
                assignedSessionId:
                  'session-1',
              });

            teamLeaderService
              .getAgentIdentity
              .mockResolvedValue(
                agent,
              );

            const result =
              await controller.getMe(
                apiKey,
              );

            /**
             * /agent/me is identity lookup only.
             *
             * Actual session access is enforced separately by
             * SessionTenantAccessService.
             */
            expect(
              result,
            ).toBe(
              agent,
            );

            expect(
              teamLeaderService.getAgentIdentity,
            ).toHaveBeenCalledWith(
              'agent-1',
            );
          },
        );
      },
    );
  },
);
