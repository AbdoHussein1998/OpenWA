


import {
  Controller,
  ForbiddenException,
  Get,
  HttpStatus,
} from '@nestjs/common';

import {
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import {
  CurrentApiKey,
} from '../auth/decorators/auth.decorators';

import {
  RequireCapability,
} from '../auth/decorators/capability.decorator';

import {
  ApiCapability,
} from '../auth/capabilities/api-capability';

import {
  ApiKey,
  ApiKeyRole,
} from '../auth/entities/api-key.entity';

import {
  Agent,
} from './entities/agent.entity';

import {
  TeamLeaderService,
} from './teamleader.service';

/**
 * Self-service surface for an authenticated Agent.
 *
 * Important authorization rules:
 *
 * 1. The Agent identity always comes from the authenticated API key.
 * 2. agentId is never accepted from route params or request bodies.
 * 3. The API key must actually be an AGENT credential.
 * 4. The API key must contain a valid agentId principal binding.
 *
 * This controller does not perform session operations itself.
 *
 * Session-specific Agent access remains:
 *
 *   Agent.assignedSessionId === requestedSessionId
 *
 * AND
 *
 *   Session.ownerTeamLeaderId === Agent.teamLeaderId
 *
 * AND
 *
 *   allowedSessions contains the session when allowedSessions is
 *   non-empty.
 *
 * That session tenancy policy is enforced by
 * SessionTenantAccessService on session-scoped REST/WebSocket/MCP
 * operations.
 */
@ApiTags('agent')
@Controller('agent')
@RequireCapability(ApiCapability.SESSION_READ)
export class AgentController {
  constructor(
    private readonly teamLeaderService: TeamLeaderService,
  ) {}

  /**
   * Return the Agent principal represented by the authenticated API key.
   *
   * No agentId is accepted from the client. This prevents an Agent from
   * requesting another Agent's identity by changing a URL parameter.
   */
  @Get('me')
  @ApiOperation({
    summary:
      'Get the authenticated Agent',
    description:
      'Returns the Agent identity bound to the authenticated AGENT API key, including the owning Team Leader, current session assignment, and stored-template send limit.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description:
      'Authenticated Agent identity.',
    schema: {
      type: 'object',
      required: [
        'id',
        'name',
        'teamLeaderId',
        'assignedSessionId',
        'templateSendLimit24h',
        'createdAt',
        'updatedAt',
      ],
      properties: {
        id: {
          type: 'string',
          format: 'uuid',
          description:
            'Agent principal ID.',
        },

        name: {
          type: 'string',
          example:
            'Mohamed Ali',
        },

        email: {
          type: 'string',
          format: 'email',
          nullable: true,
          example:
            'mohamed.ali@example.com',
        },

        teamLeaderId: {
          type: 'string',
          format: 'uuid',
          description:
            'Team Leader that owns this Agent.',
        },

        assignedSessionId: {
          type: 'string',
          format: 'uuid',
          nullable: true,
          description:
            'Currently assigned WhatsApp session, or null when the Agent is unassigned.',
          example:
            '0a941dac-a965-45e7-b318-74ae8be134f0',
        },

        templateSendLimit24h: {
          type: 'integer',
          minimum: 0,
          nullable: true,
          description:
            'Maximum stored-template sends allowed in a rolling 24-hour window. Null means unlimited; 0 means stored-template sending is disabled.',
          example: 20,
        },

        createdAt: {
          type: 'string',
          format: 'date-time',
        },

        updatedAt: {
          type: 'string',
          format: 'date-time',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description:
      'API key is missing, invalid, revoked, or expired.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description:
      'Caller is not a valid Agent principal.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description:
      'The Agent principal bound to this API key no longer exists.',
  })
  async getMe(
    @CurrentApiKey()
    apiKey: ApiKey,
  ): Promise<Agent> {
    const agentId =
      this.requireAgentId(apiKey);

    return this.teamLeaderService.getAgentIdentity(
      agentId,
    );
  }

  /**
   * Resolve the Agent principal binding from the authenticated key.
   *
   * SESSION_READ by itself is deliberately insufficient because
   * ADMIN, OPERATOR, VIEWER and TEAM_LEADER may also possess that
   * capability.
   *
   * /agent/* is a self-service identity surface, therefore the caller
   * must specifically be:
   *
   *   role === AGENT
   *
   * AND
   *
   *   agentId != null
   */
  private requireAgentId(
    apiKey: ApiKey,
  ): string {
    if (
      apiKey.role !== ApiKeyRole.AGENT ||
      !apiKey.agentId
    ) {
      throw new ForbiddenException(
        'A valid Agent principal is required',
      );
    }

    return apiKey.agentId;
  }
}


