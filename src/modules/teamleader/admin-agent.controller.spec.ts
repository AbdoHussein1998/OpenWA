import 'reflect-metadata';

import {
  ApiKeyRole,
} from '../auth/entities/api-key.entity';

import {
  REQUIRED_ROLE_KEY,
  UNSCOPED_KEY,
} from '../auth/decorators/auth.decorators';

import {
  AdminAgentController,
  type AdminAgentOverview,
} from './admin-agent.controller';

import {
  TeamLeaderService,
} from './teamleader.service';

function createAdminAgentOverview(
  overrides: Partial<AdminAgentOverview> = {},
): AdminAgentOverview {
  return {
    id:
      'agent-1',

    name:
      'Mohamed Ali',

    email:
      'mohamed@example.com',

    teamLeaderId:
      'team-leader-1',

    teamLeader: {
      id:
        'team-leader-1',

      name:
        'Ahmed Hassan',

      email:
        'ahmed@example.com',
    },

    assignedSessionId:
      'session-1',

    assignedSession: {
      id:
        'session-1',

      name:
        'support-session',

      status:
        'ready',

      phone:
        '201001234567',

      targetPhone:
        '201001234567',
    },

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

describe(
  'AdminAgentController',
  () => {
    let controller:
      AdminAgentController;

    let teamLeaderService: {
      getAdminAgents:
        jest.Mock;
    };

    beforeEach(() => {
      teamLeaderService = {
        getAdminAgents:
          jest.fn(),
      };

      controller =
        new AdminAgentController(
          teamLeaderService as unknown as TeamLeaderService,
        );
    });

    describe(
      'authorization metadata',
      () => {
        it(
          'requires ADMIN role at the controller level',
          () => {
            expect(
              Reflect.getMetadata(
                REQUIRED_ROLE_KEY,
                AdminAgentController,
              ),
            ).toBe(
              ApiKeyRole.ADMIN,
            );
          },
        );

        it(
          'requires an unscoped API key at the controller level',
          () => {
            expect(
              Reflect.getMetadata(
                UNSCOPED_KEY,
                AdminAgentController,
              ),
            ).toBe(
              true,
            );
          },
        );
      },
    );

    describe(
      'findAll',
      () => {
        it(
          'returns the global Admin Agent overview from TeamLeaderService',
          async () => {
            const agents = [
              createAdminAgentOverview(),

              createAdminAgentOverview({
                id:
                  'agent-2',

                name:
                  'Sara Agent',

                email:
                  null,

                teamLeaderId:
                  'team-leader-2',

                teamLeader: {
                  id:
                    'team-leader-2',

                  name:
                    'Sara Leader',

                  email:
                    null,
                },

                assignedSessionId:
                  null,

                assignedSession:
                  null,

                templateSendLimit24h:
                  25,
              }),
            ];

            teamLeaderService
              .getAdminAgents
              .mockResolvedValue(
                agents,
              );

            const result =
              await controller.findAll();

            expect(
              teamLeaderService.getAdminAgents,
            ).toHaveBeenCalledTimes(
              1,
            );

            expect(
              result,
            ).toBe(
              agents,
            );

            expect(
              result[0].assignedSession,
            ).toEqual(
              expect.objectContaining({
                id:
                  'session-1',

                status:
                  'ready',
              }),
            );

            expect(
              result[1].email,
            ).toBeNull();

            expect(
              result[1].teamLeader.email,
            ).toBeNull();

            expect(
              result[1].assignedSession,
            ).toBeNull();
          },
        );

        it(
          'returns an empty array when no Agents exist',
          async () => {
            teamLeaderService
              .getAdminAgents
              .mockResolvedValue(
                [],
              );

            await expect(
              controller.findAll(),
            ).resolves.toEqual(
              [],
            );

            expect(
              teamLeaderService.getAdminAgents,
            ).toHaveBeenCalledTimes(
              1,
            );
          },
        );

        it(
          'forwards service failures without converting or hiding them',
          async () => {
            const error =
              new Error(
                'Agent overview lookup failed',
              );

            teamLeaderService
              .getAdminAgents
              .mockRejectedValue(
                error,
              );

            await expect(
              controller.findAll(),
            ).rejects.toBe(
              error,
            );
          },
        );
      },
    );
  },
);
