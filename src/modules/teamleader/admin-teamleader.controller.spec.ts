import 'reflect-metadata';

import {
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import {
  ApiCapability,
} from '../auth/capabilities/api-capability';
import {
  REQUIRED_CAPABILITY_KEY,
} from '../auth/decorators/capability.decorator';
import {
  UNSCOPED_KEY,
} from '../auth/decorators/auth.decorators';

import {
  AdminTeamLeaderController,
} from './admin-teamleader.controller';
import { Agent } from './entities/agent.entity';
import { TeamLeader } from './entities/team-leader.entity';
import {
  TeamLeaderService,
} from './teamleader.service';

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

describe('AdminTeamLeaderController', () => {
  let controller: AdminTeamLeaderController;

  let teamLeaderService: {
    createTeamLeader: jest.Mock;
    createAgent: jest.Mock;
    listTeamLeaders: jest.Mock;
    getAdminTeamLeaderResources: jest.Mock;
    setAdminSessionOwner: jest.Mock;
    reassignAdminSession: jest.Mock;
    reassignAdminSessions: jest.Mock;
    getTeamLeader: jest.Mock;
    retireTeamLeader: jest.Mock;
    forceDeleteTeamLeader: jest.Mock;
    deleteTeamLeader: jest.Mock;
  };

  beforeEach(() => {
    teamLeaderService = {
      createTeamLeader: jest.fn(),
      createAgent: jest.fn(),
      listTeamLeaders: jest.fn(),
      getAdminTeamLeaderResources: jest.fn(),
      setAdminSessionOwner: jest.fn(),
      reassignAdminSession: jest.fn(),
      reassignAdminSessions: jest.fn(),
      getTeamLeader: jest.fn(),
      retireTeamLeader: jest.fn(),
      forceDeleteTeamLeader: jest.fn(),
      deleteTeamLeader: jest.fn(),
    };

    controller = new AdminTeamLeaderController(
      teamLeaderService as unknown as TeamLeaderService,
    );
  });

  describe('authorization metadata', () => {
    it('requires PRINCIPAL_MANAGE at the controller level', () => {
      expect(
        Reflect.getMetadata(
          REQUIRED_CAPABILITY_KEY,
          AdminTeamLeaderController,
        ),
      ).toBe(
        ApiCapability.PRINCIPAL_MANAGE,
      );
    });

    it('requires an unscoped API key at the controller level', () => {
      expect(
        Reflect.getMetadata(
          UNSCOPED_KEY,
          AdminTeamLeaderController,
        ),
      ).toBe(true);
    });
  });

  describe('create', () => {
    it('creates a Team Leader and returns the one-time plaintext API key', async () => {
      const teamLeader = createTeamLeader();
      const dto = {
        name: 'Ahmed Hassan',
        email: 'ahmed@example.com',
      };

      teamLeaderService.createTeamLeader.mockResolvedValue({
        teamLeader,
        apiKey: 'owa_k1_plaintext_team_leader',
      });

      await expect(controller.create(dto)).resolves.toEqual({
        teamLeader,
        apiKey: 'owa_k1_plaintext_team_leader',
      });
      expect(teamLeaderService.createTeamLeader).toHaveBeenCalledWith(dto);
    });

    it('does not alter the DTO before passing it to the service', async () => {
      const dto = {
        name: '  Ahmed Hassan  ',
        email: 'AHMED@EXAMPLE.COM',
      };

      teamLeaderService.createTeamLeader.mockResolvedValue({
        teamLeader: createTeamLeader(),
        apiKey: 'owa_k1_key',
      });

      await controller.create(dto);

      expect(teamLeaderService.createTeamLeader).toHaveBeenCalledWith(dto);
    });

    it('forwards duplicate-email conflicts', async () => {
      const conflict = new ConflictException(
        'A Team Leader with this email already exists',
      );
      teamLeaderService.createTeamLeader.mockRejectedValue(conflict);

      await expect(
        controller.create({
          name: 'Ahmed Hassan',
          email: 'ahmed@example.com',
        }),
      ).rejects.toBe(conflict);
    });
  });

  describe('createAgent', () => {
    it('creates an Agent under the selected Team Leader', async () => {
      const agent = createAgent();
      const dto = {
        name: 'Mohamed Ali',
        email: 'mohamed@example.com',
      };

      teamLeaderService.createAgent.mockResolvedValue({
        agent,
        apiKey: 'owa_k1_plaintext_agent',
      });

      await expect(
        controller.createAgent('team-leader-1', dto),
      ).resolves.toEqual({
        agent,
        apiKey: 'owa_k1_plaintext_agent',
      });
      expect(teamLeaderService.createAgent).toHaveBeenCalledWith(
        'team-leader-1',
        dto,
      );
    });

    it('forwards 404 when the Team Leader does not exist', async () => {
      const notFound = new NotFoundException('Team Leader not found');
      teamLeaderService.createAgent.mockRejectedValue(notFound);

      await expect(
        controller.createAgent('missing-team-leader', {
          name: 'Agent',
        }),
      ).rejects.toBe(notFound);
    });
  });

  describe('findAll', () => {
    it('returns all Team Leaders from the service', async () => {
      const teamLeaders = [
        createTeamLeader({ id: 'team-leader-1' }),
        createTeamLeader({
          id: 'team-leader-2',
          name: 'Sara Ali',
          email: 'sara@example.com',
        }),
      ];

      teamLeaderService.listTeamLeaders.mockResolvedValue(teamLeaders);

      await expect(controller.findAll()).resolves.toBe(teamLeaders);
      expect(teamLeaderService.listTeamLeaders).toHaveBeenCalledTimes(1);
    });
  });

  describe('resources', () => {
    it('returns the complete Team Leader resource graph', async () => {
      const teamLeader = createTeamLeader();
      const resources = {
        teamLeader,
        sessions: [
          {
            id: 'session-1',
            name: 'support',
            ownerTeamLeaderId: teamLeader.id,
            status: 'ready' as const,
            phone: '201001234567',
            targetPhone: '201001234567',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ],
        agents: [
          {
            id: 'agent-1',
            name: 'Mohamed Ali',
            email: 'mohamed@example.com',
            assignedSessionId: 'session-1',
            templateSendLimit24h: 25,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ],
        canDelete: false,
      };

      teamLeaderService.getAdminTeamLeaderResources.mockResolvedValue(
        resources,
      );

      await expect(
        controller.resources(teamLeader.id),
      ).resolves.toBe(resources);
      expect(
        teamLeaderService.getAdminTeamLeaderResources,
      ).toHaveBeenCalledWith(teamLeader.id);
    });

    it('forwards 404 for an unknown Team Leader', async () => {
      const notFound = new NotFoundException('Team Leader not found');
      teamLeaderService.getAdminTeamLeaderResources.mockRejectedValue(
        notFound,
      );

      await expect(
        controller.resources('missing-team-leader'),
      ).rejects.toBe(notFound);
    });
  });


  describe('setSessionOwner', () => {
    it('assigns an unowned ADMIN-created Session directly to a Team Leader', async () => {
      const updated = {
        id: 'session-1',
        name: 'support',
        ownerTeamLeaderId: 'team-leader-2',
        status: 'created' as const,
        phone: null,
        targetPhone: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      };

      teamLeaderService.setAdminSessionOwner.mockResolvedValue(updated);

      await expect(
        controller.setSessionOwner(
          'session-1',
          {
            targetTeamLeaderId: 'team-leader-2',
          },
        ),
      ).resolves.toBe(updated);

      expect(teamLeaderService.setAdminSessionOwner).toHaveBeenCalledWith(
        'session-1',
        'team-leader-2',
      );
    });

    it('forwards conflicts when the Session is assigned to an Agent under another Team Leader', async () => {
      const conflict = new ConflictException(
        'Session is assigned to an Agent belonging to another Team Leader',
      );
      teamLeaderService.setAdminSessionOwner.mockRejectedValue(conflict);

      await expect(
        controller.setSessionOwner(
          'session-1',
          {
            targetTeamLeaderId: 'team-leader-2',
          },
        ),
      ).rejects.toBe(conflict);
    });

    it('forwards 404 when the Session or target Team Leader does not exist', async () => {
      const notFound = new NotFoundException('Session not found');
      teamLeaderService.setAdminSessionOwner.mockRejectedValue(notFound);

      await expect(
        controller.setSessionOwner(
          'missing-session',
          {
            targetTeamLeaderId: 'team-leader-2',
          },
        ),
      ).rejects.toBe(notFound);
    });
  });

  describe('reassignSession', () => {
    it('delegates one Session ownership transfer to the service', async () => {
      const updated = {
        id: 'session-1',
        name: 'support',
        ownerTeamLeaderId: 'team-leader-2',
        status: 'ready' as const,
        phone: null,
        targetPhone: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      };

      teamLeaderService.reassignAdminSession.mockResolvedValue(updated);

      await expect(
        controller.reassignSession(
          'team-leader-1',
          'session-1',
          {
            targetTeamLeaderId: 'team-leader-2',
          },
        ),
      ).resolves.toBe(updated);

      expect(teamLeaderService.reassignAdminSession).toHaveBeenCalledWith(
        'team-leader-1',
        'session-1',
        'team-leader-2',
      );
    });

    it('forwards conflicts for an assigned Session', async () => {
      const conflict = new ConflictException(
        'Cannot transfer assigned Sessions',
      );
      teamLeaderService.reassignAdminSession.mockRejectedValue(conflict);

      await expect(
        controller.reassignSession(
          'team-leader-1',
          'session-1',
          {
            targetTeamLeaderId: 'team-leader-2',
          },
        ),
      ).rejects.toBe(conflict);
    });
  });

  describe('bulkReassignSessions', () => {
    it('delegates a bulk Session ownership transfer to the service', async () => {
      const updated = [
        {
          id: 'session-1',
          name: 'support-1',
          ownerTeamLeaderId: 'team-leader-2',
          status: 'ready' as const,
          phone: null,
          targetPhone: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          id: 'session-2',
          name: 'support-2',
          ownerTeamLeaderId: 'team-leader-2',
          status: 'created' as const,
          phone: null,
          targetPhone: null,
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
          updatedAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      ];

      teamLeaderService.reassignAdminSessions.mockResolvedValue(updated);

      const dto = {
        sessionIds: ['session-1', 'session-2'],
        targetTeamLeaderId: 'team-leader-2',
      };

      await expect(
        controller.bulkReassignSessions('team-leader-1', dto),
      ).resolves.toBe(updated);

      expect(teamLeaderService.reassignAdminSessions).toHaveBeenCalledWith(
        'team-leader-1',
        dto.sessionIds,
        dto.targetTeamLeaderId,
      );
    });
  });

  describe('findOne', () => {
    it('returns the requested Team Leader', async () => {
      const teamLeader = createTeamLeader();
      teamLeaderService.getTeamLeader.mockResolvedValue(teamLeader);

      await expect(
        controller.findOne(teamLeader.id),
      ).resolves.toBe(teamLeader);
      expect(teamLeaderService.getTeamLeader).toHaveBeenCalledWith(
        teamLeader.id,
      );
    });

    it('forwards 404 when the Team Leader does not exist', async () => {
      const notFound = new NotFoundException('Team Leader not found');
      teamLeaderService.getTeamLeader.mockRejectedValue(notFound);

      await expect(
        controller.findOne('missing-team-leader'),
      ).rejects.toBe(notFound);
    });
  });

  describe('retire', () => {
    it('delegates the complete retirement plan to TeamLeaderService', async () => {
      const dto = {
        sessionReassignments: [
          {
            sessionId: 'session-1',
            targetTeamLeaderId: 'team-leader-2',
          },
        ],
        agentReassignments: [
          {
            agentId: 'agent-1',
            targetTeamLeaderId: 'team-leader-2',
            unassignSession: false,
          },
        ],
      };
      const result = {
        teamLeaderId: 'team-leader-1',
        teamLeaderName: 'Ahmed Hassan',
        delegatedSessionIds: ['session-1'],
        delegatedAgentIds: ['agent-1'],
        preservedAgentSessionAssignments: 1,
      };

      teamLeaderService.retireTeamLeader.mockResolvedValue(result);

      await expect(
        controller.retire('team-leader-1', dto),
      ).resolves.toBe(result);

      expect(teamLeaderService.retireTeamLeader).toHaveBeenCalledWith(
        'team-leader-1',
        dto,
      );
    });

    it('forwards retirement conflicts', async () => {
      const conflict = new ConflictException(
        'Retirement plan must include every Session',
      );
      teamLeaderService.retireTeamLeader.mockRejectedValue(conflict);

      await expect(
        controller.retire('team-leader-1', {
          sessionReassignments: [],
          agentReassignments: [],
        }),
      ).rejects.toBe(conflict);
    });
  });

  describe('forceDelete', () => {
    it('delegates destructive Team Leader retirement to the service', async () => {
      const result = {
        teamLeaderId:
          'team-leader-1',
        teamLeaderName:
          'Ahmed Hassan',
        deletedSessionIds: [
          'session-1',
          'session-2',
        ],
        deletedAgentIds: [
          'agent-1',
        ],
      };

      teamLeaderService.forceDeleteTeamLeader.mockResolvedValue(
        result,
      );

      await expect(
        controller.forceDelete(
          'team-leader-1',
        ),
      ).resolves.toEqual(result);

      expect(
        teamLeaderService.forceDeleteTeamLeader,
      ).toHaveBeenCalledWith(
        'team-leader-1',
      );
    });

    it('forwards force-delete conflicts without altering them', async () => {
      const conflict =
        new ConflictException(
          'Team Leader resources changed repeatedly during force deletion',
        );

      teamLeaderService.forceDeleteTeamLeader.mockRejectedValue(
        conflict,
      );

      await expect(
        controller.forceDelete(
          'team-leader-1',
        ),
      ).rejects.toBe(
        conflict,
      );
    });

    it('forwards 404 for an unknown Team Leader', async () => {
      const notFound =
        new NotFoundException(
          'Team Leader not found',
        );

      teamLeaderService.forceDeleteTeamLeader.mockRejectedValue(
        notFound,
      );

      await expect(
        controller.forceDelete(
          'missing-team-leader',
        ),
      ).rejects.toBe(
        notFound,
      );
    });
  });

  describe('delete', () => {
    it('delegates deletion after resources have been handled', async () => {
      teamLeaderService.deleteTeamLeader.mockResolvedValue(undefined);

      await expect(
        controller.delete('team-leader-1'),
      ).resolves.toBeUndefined();
      expect(teamLeaderService.deleteTeamLeader).toHaveBeenCalledWith(
        'team-leader-1',
      );
    });

    it('forwards 409 while Sessions or Agents remain assigned', async () => {
      const conflict = new ConflictException(
        'Cannot delete Team Leader while they still own Sessions or Agents; reassign or delete those resources first',
      );
      teamLeaderService.deleteTeamLeader.mockRejectedValue(conflict);

      await expect(
        controller.delete('team-leader-1'),
      ).rejects.toBe(conflict);
    });

    it('forwards 404 when deleting an unknown Team Leader', async () => {
      const notFound = new NotFoundException('Team Leader not found');
      teamLeaderService.deleteTeamLeader.mockRejectedValue(notFound);

      await expect(
        controller.delete('missing-team-leader'),
      ).rejects.toBe(notFound);
    });
  });
});



