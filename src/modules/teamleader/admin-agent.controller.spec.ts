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
    id: 'agent-1',
    name: 'Mohamed Ali',
    email: 'mohamed@example.com',
    teamLeaderId: 'team-leader-1',
    teamLeader: {
      id: 'team-leader-1',
      name: 'Ahmed Hassan',
      email: 'ahmed@example.com',
    },
    assignedSessionId: 'session-1',
    assignedSession: {
      id: 'session-1',
      name: 'support-session',
      status: 'ready',
      phone: '201001234567',
      targetPhone: '201001234567',
    },
    templateSendLimit24h: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('AdminAgentController', () => {
  let controller: AdminAgentController;

  let teamLeaderService: {
    getAdminAgents: jest.Mock;
    getAdminAgent: jest.Mock;
    assignAdminAgentSession: jest.Mock;
    reassignAdminAgent: jest.Mock;
    reassignAdminAgents: jest.Mock;
    deleteAdminAgent: jest.Mock;
  };

  beforeEach(() => {
    teamLeaderService = {
      getAdminAgents: jest.fn(),
      getAdminAgent: jest.fn(),
      assignAdminAgentSession: jest.fn(),
      reassignAdminAgent: jest.fn(),
      reassignAdminAgents: jest.fn(),
      deleteAdminAgent: jest.fn(),
    };

    controller = new AdminAgentController(
      teamLeaderService as unknown as TeamLeaderService,
    );
  });

  describe('authorization metadata', () => {
    it('keeps the controller capability-neutral so handlers can split read and write access', () => {
      expect(
        Reflect.getMetadata(
          REQUIRED_CAPABILITY_KEY,
          AdminAgentController,
        ),
      ).toBeUndefined();
    });

    it('requires PRINCIPAL_READ for read-only Agent inventory handlers', () => {
      expect(
        Reflect.getMetadata(
          REQUIRED_CAPABILITY_KEY,
          AdminAgentController.prototype.findAll,
        ),
      ).toBe(ApiCapability.PRINCIPAL_READ);

      expect(
        Reflect.getMetadata(
          REQUIRED_CAPABILITY_KEY,
          AdminAgentController.prototype.findOne,
        ),
      ).toBe(ApiCapability.PRINCIPAL_READ);
    });

    it('requires PRINCIPAL_MANAGE for Agent mutations', () => {
      expect(
        Reflect.getMetadata(
          REQUIRED_CAPABILITY_KEY,
          AdminAgentController.prototype.assignSession,
        ),
      ).toBe(ApiCapability.PRINCIPAL_MANAGE);

      expect(
        Reflect.getMetadata(
          REQUIRED_CAPABILITY_KEY,
          AdminAgentController.prototype.reassign,
        ),
      ).toBe(ApiCapability.PRINCIPAL_MANAGE);

      expect(
        Reflect.getMetadata(
          REQUIRED_CAPABILITY_KEY,
          AdminAgentController.prototype.bulkReassign,
        ),
      ).toBe(ApiCapability.PRINCIPAL_MANAGE);

      expect(
        Reflect.getMetadata(
          REQUIRED_CAPABILITY_KEY,
          AdminAgentController.prototype.delete,
        ),
      ).toBe(ApiCapability.PRINCIPAL_MANAGE);
    });

    it('requires an unscoped API key at the controller level', () => {
      expect(
        Reflect.getMetadata(
          UNSCOPED_KEY,
          AdminAgentController,
        ),
      ).toBe(true);
    });
  });

  describe('findAll', () => {
    it('returns the global Admin Agent overview from TeamLeaderService', async () => {
      const agents = [
        createAdminAgentOverview(),
        createAdminAgentOverview({
          id: 'agent-2',
          name: 'Sara Agent',
          email: null,
          teamLeaderId: 'team-leader-2',
          teamLeader: {
            id: 'team-leader-2',
            name: 'Sara Leader',
            email: null,
          },
          assignedSessionId: null,
          assignedSession: null,
          templateSendLimit24h: 25,
        }),
      ];

      teamLeaderService.getAdminAgents.mockResolvedValue(agents);

      await expect(controller.findAll()).resolves.toBe(agents);
      expect(teamLeaderService.getAdminAgents).toHaveBeenCalledTimes(1);
    });

    it('returns an empty array when no Agents exist', async () => {
      teamLeaderService.getAdminAgents.mockResolvedValue([]);

      await expect(controller.findAll()).resolves.toEqual([]);
    });

    it('forwards service failures', async () => {
      const error = new Error('Agent overview lookup failed');
      teamLeaderService.getAdminAgents.mockRejectedValue(error);

      await expect(controller.findAll()).rejects.toBe(error);
    });
  });

  describe('findOne', () => {
    it('returns one Agent overview', async () => {
      const agent = createAdminAgentOverview();
      teamLeaderService.getAdminAgent.mockResolvedValue(agent);

      await expect(controller.findOne(agent.id)).resolves.toBe(agent);
      expect(teamLeaderService.getAdminAgent).toHaveBeenCalledWith(agent.id);
    });

    it('forwards 404 for an unknown Agent', async () => {
      const error = new NotFoundException('Agent not found');
      teamLeaderService.getAdminAgent.mockRejectedValue(error);

      await expect(
        controller.findOne('missing-agent'),
      ).rejects.toBe(error);
    });
  });

  describe('assignSession', () => {
    it('delegates Session assignment to the Admin service flow', async () => {
      const updated = createAdminAgentOverview({
        assignedSessionId: 'session-2',
        assignedSession: {
          id: 'session-2',
          name: 'sales',
          status: 'ready',
          phone: null,
          targetPhone: null,
        },
      });

      teamLeaderService.assignAdminAgentSession.mockResolvedValue(updated);

      await expect(
        controller.assignSession('agent-1', {
          sessionId: 'session-2',
        }),
      ).resolves.toBe(updated);

      expect(
        teamLeaderService.assignAdminAgentSession,
      ).toHaveBeenCalledWith(
        'agent-1',
        'session-2',
      );
    });

    it('delegates explicit unassignment with sessionId=null', async () => {
      const updated = createAdminAgentOverview({
        assignedSessionId: null,
        assignedSession: null,
      });

      teamLeaderService.assignAdminAgentSession.mockResolvedValue(updated);

      await expect(
        controller.assignSession('agent-1', {
          sessionId: null,
        }),
      ).resolves.toBe(updated);

      expect(
        teamLeaderService.assignAdminAgentSession,
      ).toHaveBeenCalledWith(
        'agent-1',
        null,
      );
    });

    it('forwards assignment conflicts without altering them', async () => {
      const conflict = new ConflictException(
        'Session ownership changed concurrently',
      );
      teamLeaderService.assignAdminAgentSession.mockRejectedValue(conflict);

      await expect(
        controller.assignSession('agent-1', {
          sessionId: 'session-2',
        }),
      ).rejects.toBe(conflict);
    });
  });

  describe('reassign', () => {
    it('moves one Agent to another Team Leader', async () => {
      const updated = createAdminAgentOverview({
        teamLeaderId: 'team-leader-2',
        teamLeader: {
          id: 'team-leader-2',
          name: 'Target Leader',
          email: null,
        },
        assignedSessionId: null,
        assignedSession: null,
      });

      teamLeaderService.reassignAdminAgent.mockResolvedValue(updated);

      await expect(
        controller.reassign('agent-1', {
          targetTeamLeaderId: 'team-leader-2',
          unassignSession: true,
        }),
      ).resolves.toBe(updated);

      expect(teamLeaderService.reassignAdminAgent).toHaveBeenCalledWith(
        'agent-1',
        'team-leader-2',
        true,
      );
    });

    it('preserves the default unassignSession=false value supplied by the DTO instance', async () => {
      const updated = createAdminAgentOverview();
      teamLeaderService.reassignAdminAgent.mockResolvedValue(updated);

      await controller.reassign('agent-1', {
        targetTeamLeaderId: 'team-leader-1',
        unassignSession: false,
      });

      expect(teamLeaderService.reassignAdminAgent).toHaveBeenCalledWith(
        'agent-1',
        'team-leader-1',
        false,
      );
    });
  });

  describe('bulkReassign', () => {
    it('delegates the bulk Agent move in input order', async () => {
      const updated = [
        createAdminAgentOverview({ id: 'agent-1' }),
        createAdminAgentOverview({ id: 'agent-2' }),
      ];
      teamLeaderService.reassignAdminAgents.mockResolvedValue(updated);

      const dto = {
        agentIds: ['agent-1', 'agent-2'],
        targetTeamLeaderId: 'team-leader-2',
        unassignSession: true,
      };

      await expect(
        controller.bulkReassign(dto),
      ).resolves.toBe(updated);

      expect(teamLeaderService.reassignAdminAgents).toHaveBeenCalledWith(
        dto.agentIds,
        dto.targetTeamLeaderId,
        true,
      );
    });
  });

  describe('delete', () => {
    it('deletes the Agent principal through TeamLeaderService', async () => {
      teamLeaderService.deleteAdminAgent.mockResolvedValue(undefined);

      await expect(
        controller.delete('agent-1'),
      ).resolves.toBeUndefined();

      expect(teamLeaderService.deleteAdminAgent).toHaveBeenCalledWith(
        'agent-1',
      );
    });

    it('forwards 404 when deleting an unknown Agent', async () => {
      const error = new NotFoundException('Agent not found');
      teamLeaderService.deleteAdminAgent.mockRejectedValue(error);

      await expect(
        controller.delete('missing-agent'),
      ).rejects.toBe(error);
    });
  });
});
