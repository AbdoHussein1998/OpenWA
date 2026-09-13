


import {
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import {
  AdminTeamLeaderController,
} from './admin-teamleader.controller';

import {
  TeamLeaderService,
} from './teamleader.service';

import {
  Agent,
} from './entities/agent.entity';

import {
  TeamLeader,
} from './entities/team-leader.entity';

function createTeamLeader(
  overrides: Partial<TeamLeader> = {},
): TeamLeader {
  return {
    id:
      'team-leader-1',

    name:
      'Ahmed Hassan',

    email:
      'ahmed@example.com',

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
    id:
      'agent-1',

    name:
      'Mohamed Ali',

    email:
      'mohamed@example.com',

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

describe(
  'AdminTeamLeaderController',
  () => {
    let controller:
      AdminTeamLeaderController;

    let teamLeaderService: {
      createTeamLeader:
        jest.Mock;

      createAgent:
        jest.Mock;

      listTeamLeaders:
        jest.Mock;

      getTeamLeader:
        jest.Mock;

      deleteTeamLeader:
        jest.Mock;
    };

    beforeEach(() => {
      teamLeaderService = {
        createTeamLeader:
          jest.fn(),

        createAgent:
          jest.fn(),

        listTeamLeaders:
          jest.fn(),

        getTeamLeader:
          jest.fn(),

        deleteTeamLeader:
          jest.fn(),
      };

      controller =
        new AdminTeamLeaderController(
          teamLeaderService as unknown as TeamLeaderService,
        );
    });

    // -------------------------------------------------------------------------
    // POST /admin/team-leaders
    // -------------------------------------------------------------------------

    describe(
      'create',
      () => {
        it(
          'creates a Team Leader with an email and returns the one-time plaintext API key',
          async () => {
            const teamLeader =
              createTeamLeader();

            teamLeaderService
              .createTeamLeader
              .mockResolvedValue({
                teamLeader,

                apiKey:
                  'owa_k1_plaintext_team_leader',
              });

            const dto = {
              name:
                'Ahmed Hassan',

              email:
                'ahmed@example.com',
            };

            const result =
              await controller.create(
                dto,
              );

            expect(
              teamLeaderService.createTeamLeader,
            ).toHaveBeenCalledTimes(
              1,
            );

            expect(
              teamLeaderService.createTeamLeader,
            ).toHaveBeenCalledWith(
              dto,
            );

            expect(
              result,
            ).toEqual({
              teamLeader,

              apiKey:
                'owa_k1_plaintext_team_leader',
            });
          },
        );

        it(
          'creates a Team Leader without an email and returns email as null from the service result',
          async () => {
            const teamLeader =
              createTeamLeader({
                email:
                  null,
              });

            teamLeaderService
              .createTeamLeader
              .mockResolvedValue({
                teamLeader,

                apiKey:
                  'owa_k1_plaintext_no_email',
              });

            const dto = {
              name:
                'Ahmed Hassan',
            };

            const result =
              await controller.create(
                dto,
              );

            expect(
              teamLeaderService.createTeamLeader,
            ).toHaveBeenCalledTimes(
              1,
            );

            expect(
              teamLeaderService.createTeamLeader,
            ).toHaveBeenCalledWith(
              dto,
            );

            expect(
              result.teamLeader.email,
            ).toBeNull();

            expect(
              result.apiKey,
            ).toBe(
              'owa_k1_plaintext_no_email',
            );
          },
        );

        it(
          'forwards duplicate-email conflicts from the service',
          async () => {
            const conflict =
              new ConflictException(
                'A Team Leader with this email already exists',
              );

            teamLeaderService
              .createTeamLeader
              .mockRejectedValue(
                conflict,
              );

            await expect(
              controller.create({
                name:
                  'Ahmed Hassan',

                email:
                  'ahmed@example.com',
              }),
            ).rejects.toBe(
              conflict,
            );
          },
        );

        it(
          'does not alter the DTO before passing it to the service',
          async () => {
            const dto = {
              name:
                '  Ahmed Hassan  ',

              email:
                'AHMED@EXAMPLE.COM',
            };

            teamLeaderService
              .createTeamLeader
              .mockResolvedValue({
                teamLeader:
                  createTeamLeader(),

                apiKey:
                  'owa_k1_key',
              });

            await controller.create(
              dto,
            );

            /**
             * Normalization belongs to TeamLeaderService.
             *
             * The controller should not duplicate domain behavior.
             */
            expect(
              teamLeaderService.createTeamLeader,
            ).toHaveBeenCalledWith(
              dto,
            );
          },
        );

        it(
          'does not add an email property when the request omits it',
          async () => {
            const dto = {
              name:
                'No Email Leader',
            };

            teamLeaderService
              .createTeamLeader
              .mockResolvedValue({
                teamLeader:
                  createTeamLeader({
                    name:
                      'No Email Leader',

                    email:
                      null,
                  }),

                apiKey:
                  'owa_k1_key',
              });

            await controller.create(
              dto,
            );

            expect(
              teamLeaderService.createTeamLeader,
            ).toHaveBeenCalledWith(
              dto,
            );

            expect(
              Object.prototype.hasOwnProperty.call(
                dto,
                'email',
              ),
            ).toBe(
              false,
            );
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // POST /admin/team-leaders/:teamLeaderId/agents
    // -------------------------------------------------------------------------

    describe(
      'createAgent',
      () => {
        it(
          'creates an Agent for the requested Team Leader and returns its one-time plaintext API key',
          async () => {
            const agent =
              createAgent();

            teamLeaderService
              .createAgent
              .mockResolvedValue({
                agent,

                apiKey:
                  'owa_k1_plaintext_agent',
              });

            const dto = {
              name:
                'Mohamed Ali',

              email:
                'mohamed@example.com',
            };

            const result =
              await controller.createAgent(
                'team-leader-1',
                dto,
              );

            expect(
              teamLeaderService.createAgent,
            ).toHaveBeenCalledTimes(
              1,
            );

            expect(
              teamLeaderService.createAgent,
            ).toHaveBeenCalledWith(
              'team-leader-1',
              dto,
            );

            expect(
              result,
            ).toEqual({
              agent,

              apiKey:
                'owa_k1_plaintext_agent',
            });
          },
        );

        it(
          'supports creating an Agent without an email',
          async () => {
            const agent =
              createAgent({
                email:
                  null,
              });

            teamLeaderService
              .createAgent
              .mockResolvedValue({
                agent,

                apiKey:
                  'owa_k1_plaintext_agent',
              });

            const dto = {
              name:
                'Agent Without Email',
            };

            const result =
              await controller.createAgent(
                'team-leader-1',
                dto,
              );

            expect(
              teamLeaderService.createAgent,
            ).toHaveBeenCalledWith(
              'team-leader-1',
              dto,
            );

            expect(
              result.agent.email,
            ).toBeNull();
          },
        );

        it(
          'forwards 404 when the Team Leader does not exist',
          async () => {
            const notFound =
              new NotFoundException(
                'Team Leader not found',
              );

            teamLeaderService
              .createAgent
              .mockRejectedValue(
                notFound,
              );

            await expect(
              controller.createAgent(
                'missing-team-leader',
                {
                  name:
                    'Mohamed Ali',
                },
              ),
            ).rejects.toBe(
              notFound,
            );
          },
        );

        it(
          'does not alter the Agent DTO before passing it to the service',
          async () => {
            const dto = {
              name:
                '  Mohamed Ali  ',

              email:
                'MOHAMED@EXAMPLE.COM',
            };

            teamLeaderService
              .createAgent
              .mockResolvedValue({
                agent:
                  createAgent(),

                apiKey:
                  'owa_k1_agent',
              });

            await controller.createAgent(
              'team-leader-1',
              dto,
            );

            expect(
              teamLeaderService.createAgent,
            ).toHaveBeenCalledWith(
              'team-leader-1',
              dto,
            );
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // GET /admin/team-leaders
    // -------------------------------------------------------------------------

    describe(
      'findAll',
      () => {
        it(
          'returns all Team Leaders from the service',
          async () => {
            const teamLeaders = [
              createTeamLeader({
                id:
                  'team-leader-1',
              }),

              createTeamLeader({
                id:
                  'team-leader-2',

                name:
                  'Sara Ali',

                email:
                  'sara@example.com',
              }),

              createTeamLeader({
                id:
                  'team-leader-3',

                name:
                  'No Email Leader',

                email:
                  null,
              }),
            ];

            teamLeaderService
              .listTeamLeaders
              .mockResolvedValue(
                teamLeaders,
              );

            const result =
              await controller.findAll();

            expect(
              teamLeaderService.listTeamLeaders,
            ).toHaveBeenCalledTimes(
              1,
            );

            expect(
              result,
            ).toBe(
              teamLeaders,
            );

            expect(
              result[2].email,
            ).toBeNull();
          },
        );

        it(
          'returns an empty array when no Team Leaders exist',
          async () => {
            teamLeaderService
              .listTeamLeaders
              .mockResolvedValue(
                [],
              );

            await expect(
              controller.findAll(),
            ).resolves.toEqual(
              [],
            );
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // GET /admin/team-leaders/:id
    // -------------------------------------------------------------------------

    describe(
      'findOne',
      () => {
        it(
          'returns the requested Team Leader',
          async () => {
            const teamLeader =
              createTeamLeader();

            teamLeaderService
              .getTeamLeader
              .mockResolvedValue(
                teamLeader,
              );

            const result =
              await controller.findOne(
                'team-leader-1',
              );

            expect(
              teamLeaderService.getTeamLeader,
            ).toHaveBeenCalledWith(
              'team-leader-1',
            );

            expect(
              result,
            ).toBe(
              teamLeader,
            );
          },
        );

        it(
          'returns a Team Leader whose email is null',
          async () => {
            const teamLeader =
              createTeamLeader({
                email:
                  null,
              });

            teamLeaderService
              .getTeamLeader
              .mockResolvedValue(
                teamLeader,
              );

            const result =
              await controller.findOne(
                'team-leader-1',
              );

            expect(
              result.email,
            ).toBeNull();
          },
        );

        it(
          'forwards 404 when the Team Leader does not exist',
          async () => {
            const notFound =
              new NotFoundException(
                'Team Leader not found',
              );

            teamLeaderService
              .getTeamLeader
              .mockRejectedValue(
                notFound,
              );

            await expect(
              controller.findOne(
                'missing-team-leader',
              ),
            ).rejects.toBe(
              notFound,
            );
          },
        );
      },
    );

    // -------------------------------------------------------------------------
    // DELETE /admin/team-leaders/:id
    // -------------------------------------------------------------------------

    describe(
      'delete',
      () => {
        it(
          'delegates Team Leader deletion to the service',
          async () => {
            teamLeaderService
              .deleteTeamLeader
              .mockResolvedValue(
                undefined,
              );

            await expect(
              controller.delete(
                'team-leader-1',
              ),
            ).resolves.toBeUndefined();

            expect(
              teamLeaderService.deleteTeamLeader,
            ).toHaveBeenCalledTimes(
              1,
            );

            expect(
              teamLeaderService.deleteTeamLeader,
            ).toHaveBeenCalledWith(
              'team-leader-1',
            );
          },
        );

        it(
          'forwards the 409 conflict when the Team Leader still owns sessions',
          async () => {
            const conflict =
              new ConflictException(
                'Cannot delete Team Leader while they still own sessions',
              );

            teamLeaderService
              .deleteTeamLeader
              .mockRejectedValue(
                conflict,
              );

            await expect(
              controller.delete(
                'team-leader-1',
              ),
            ).rejects.toBe(
              conflict,
            );
          },
        );

        it(
          'forwards 404 when deleting an unknown Team Leader',
          async () => {
            const notFound =
              new NotFoundException(
                'Team Leader not found',
              );

            teamLeaderService
              .deleteTeamLeader
              .mockRejectedValue(
                notFound,
              );

            await expect(
              controller.delete(
                'missing-team-leader',
              ),
            ).rejects.toBe(
              notFound,
            );
          },
        );
      },
    );
  },
);


