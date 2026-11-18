





import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';

import {
  ApiOperation,
  ApiParam,
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
  TeamLeader,
} from './entities/team-leader.entity';

import {
  Agent,
} from './entities/agent.entity';

import {
  CreateAgentDto,
} from './dto/create-agent.dto';

import {
  AssignAgentSessionDto,
} from './dto/assign-agent-session.dto';

import {
  CreateAgentResult,
  TeamLeaderService,
} from './teamleader.service';

/**
 * Self-service management surface for authenticated Team Leaders.
 *
 * Security model:
 *
 * - TEAM_MANAGE answers WHAT this principal may do.
 * - The authenticated API-key binding determines WHICH Team Leader
 *   principal the caller represents.
 * - teamLeaderId is never accepted from request params or request body.
 *
 * Although ADMIN also has TEAM_MANAGE, these routes intentionally
 * require a real TEAM_LEADER principal binding.
 */
@ApiTags('team-leader')
@Controller('team-leader')
@RequireCapability(ApiCapability.TEAM_MANAGE)
export class TeamLeaderController {
  constructor(
    private readonly teamLeaderService: TeamLeaderService,
  ) {}

  /**
   * Return the authenticated Team Leader identity.
   */
  @Get('me')
  @ApiOperation({
    summary:
      'Get the authenticated Team Leader',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description:
      'Authenticated Team Leader identity.',
    schema: {
      type: 'object',
      required: [
        'id',
        'name',
        'email',
        'createdAt',
        'updatedAt',
      ],
      properties: {
        id: {
          type: 'string',
          format: 'uuid',
        },

        name: {
          type: 'string',
          example: 'Ahmed Hassan',
        },

        email: {
          type: 'string',
          format: 'email',
          example:
            'ahmed.hassan@example.com',
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
    status: HttpStatus.FORBIDDEN,
    description:
      'Caller is not a valid Team Leader principal.',
  })
  async getMe(
    @CurrentApiKey()
    apiKey: ApiKey,
  ): Promise<TeamLeader> {
    const teamLeaderId =
      this.requireTeamLeaderId(apiKey);

    return this.teamLeaderService.getTeamLeaderIdentity(
      teamLeaderId,
    );
  }

  /**
   * List Agents belonging to the authenticated Team Leader.
   */
  @Get('agents')
  @ApiOperation({
    summary:
      'List Team Leader Agents',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description:
      'Agents belonging to the authenticated Team Leader.',
    schema: {
      type: 'array',
      items: {
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
          },

          name: {
            type: 'string',
          },

          email: {
            type: 'string',
            format: 'email',
            nullable: true,
          },

          teamLeaderId: {
            type: 'string',
            format: 'uuid',
          },

          assignedSessionId: {
            type: 'string',
            format: 'uuid',
            nullable: true,
          },

          templateSendLimit24h: {
            type: 'integer',
            minimum: 0,
            nullable: true,
            example: 20,
            description:
              'Maximum stored-template sends allowed in a rolling 24-hour window. Null means unlimited; 0 disables stored-template sending.',
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
    },
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description:
      'Caller is not a valid Team Leader principal.',
  })
  async listAgents(
    @CurrentApiKey()
    apiKey: ApiKey,
  ): Promise<Agent[]> {
    const teamLeaderId =
      this.requireTeamLeaderId(apiKey);

    return this.teamLeaderService.listAgents(
      teamLeaderId,
    );
  }

  /**
   * Create an Agent belonging to the authenticated Team Leader.
   *
   * teamLeaderId does not come from CreateAgentDto.
   *
   * Agent + API key creation is performed atomically by
   * TeamLeaderService.
   */
  @Post('agents')
  @ApiOperation({
    summary:
      'Create an Agent',
    description:
      'Creates an Agent for the authenticated Team Leader and provisions its AGENT API key atomically. The plaintext API key is returned only once.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description:
      'Agent created successfully.',
    schema: {
      type: 'object',
      required: [
        'agent',
        'apiKey',
      ],
      properties: {
        agent: {
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
            },

            assignedSessionId: {
              type: 'string',
              format: 'uuid',
              nullable: true,
              example: null,
            },

            templateSendLimit24h: {
              type: 'integer',
              minimum: 0,
              nullable: true,
              example: 20,
              description:
                'Maximum stored-template sends allowed in a rolling 24-hour window. Null means unlimited; 0 disables stored-template sending.',
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

        apiKey: {
          type: 'string',
          description:
            'Plaintext Agent API key. Returned only once and never stored in plaintext.',
          example:
            'owa_k1_0123456789abcdef...',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'Invalid Agent data.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description:
      'Caller is not a valid Team Leader principal.',
  })
  async createAgent(
    @CurrentApiKey()
    apiKey: ApiKey,

    @Body()
    dto: CreateAgentDto,
  ): Promise<CreateAgentResult> {
    const teamLeaderId =
      this.requireTeamLeaderId(apiKey);

    return this.teamLeaderService.createAgent(
      teamLeaderId,
      dto,
    );
  }

  /**
   * Replace an Agent's API key.
   *
   * The previous AGENT credential(s) are revoked atomically with
   * provisioning the replacement. The plaintext replacement key is
   * returned only in this response.
   */
  @Post(
    'agents/:agentId/api-key/rotate',
  )
  @HttpCode(
    HttpStatus.OK,
  )
  @ApiOperation({
    summary:
      'Rotate an Agent API key',
    description:
      'Revokes the Agent\'s previous AGENT credential(s), creates a replacement credential, disconnects sessions authenticated with the previous key, and returns the replacement plaintext key exactly once.',
  })
  @ApiParam({
    name: 'agentId',
    description:
      'Agent UUID',
    format: 'uuid',
  })
  @ApiResponse({
    status:
      HttpStatus.OK,
    description:
      'Agent API key rotated successfully.',
    schema: {
      type: 'object',
      required: [
        'agent',
        'apiKey',
      ],
      properties: {
        agent: {
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
              type:
                'string',
              format:
                'uuid',
            },

            name: {
              type:
                'string',
            },

            email: {
              type:
                'string',
              format:
                'email',
              nullable:
                true,
            },

            teamLeaderId: {
              type:
                'string',
              format:
                'uuid',
            },

            assignedSessionId: {
              type:
                'string',
              format:
                'uuid',
              nullable:
                true,
            },

            templateSendLimit24h: {
              type:
                'integer',
              minimum:
                0,
              nullable:
                true,
            },

            createdAt: {
              type:
                'string',
              format:
                'date-time',
            },

            updatedAt: {
              type:
                'string',
              format:
                'date-time',
            },
          },
        },

        apiKey: {
          type:
            'string',
          description:
            'Replacement plaintext Agent API key. Returned only once and never stored in plaintext.',
          example:
            'owa_k1_0123456789abcdef...',
        },
      },
    },
  })
  @ApiResponse({
    status:
      HttpStatus.NOT_FOUND,
    description:
      'Agent does not exist or does not belong to this Team Leader.',
  })
  @ApiResponse({
    status:
      HttpStatus.FORBIDDEN,
    description:
      'Caller is not a valid Team Leader principal.',
  })
  async rotateAgentApiKey(
    @CurrentApiKey()
    apiKey: ApiKey,

    @Param(
      'agentId',
      ParseUUIDPipe,
    )
    agentId: string,
  ): Promise<CreateAgentResult> {
    const teamLeaderId =
      this.requireTeamLeaderId(
        apiKey,
      );

    return this.teamLeaderService.rotateAgentApiKey(
      teamLeaderId,
      agentId,
    );
  }

  /**
   * Delete one Agent belonging to the authenticated Team Leader.
   *
   * Foreign Agent IDs intentionally return 404 from the service rather
   * than revealing that another Team Leader owns the principal.
   */
  @Delete('agents/:agentId')
  @HttpCode(
    HttpStatus.NO_CONTENT,
  )
  @ApiOperation({
    summary:
      'Delete an Agent',
  })
  @ApiParam({
    name: 'agentId',
    description:
      'Agent UUID',
    format: 'uuid',
  })
  @ApiResponse({
    status:
      HttpStatus.NO_CONTENT,
    description:
      'Agent deleted successfully.',
  })
  @ApiResponse({
    status:
      HttpStatus.NOT_FOUND,
    description:
      'Agent does not exist or does not belong to this Team Leader.',
  })
  @ApiResponse({
    status:
      HttpStatus.FORBIDDEN,
    description:
      'Caller is not a valid Team Leader principal.',
  })
  async deleteAgent(
    @CurrentApiKey()
    apiKey: ApiKey,

    @Param(
      'agentId',
      ParseUUIDPipe,
    )
    agentId: string,
  ): Promise<void> {
    const teamLeaderId =
      this.requireTeamLeaderId(apiKey);

    await this.teamLeaderService.deleteAgent(
      teamLeaderId,
      agentId,
    );
  }

  /**
   * Assign or unassign an Agent's session.
   *
   * Body:
   *
   * Assign:
   *
   * {
   *   "sessionId": "<uuid>"
   * }
   *
   * Unassign:
   *
   * {
   *   "sessionId": null
   * }
   *
   * TeamLeaderService enforces:
   *
   *   Agent.teamLeaderId === authenticated Team Leader
   *
   * AND, for assignment:
   *
   *   Session.ownerTeamLeaderId === authenticated Team Leader
   *
   * Foreign Agents and Sessions intentionally return 404.
   */
  @Patch(
    'agents/:agentId/assignment',
  )
  @ApiOperation({
    summary:
      'Assign or unassign an Agent session',
    description:
      'Assign a Team Leader-owned WhatsApp session to an Agent, or send sessionId:null to remove the current assignment.',
  })
  @ApiParam({
    name: 'agentId',
    description:
      'Agent UUID',
    format: 'uuid',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description:
      'Updated Agent assignment.',
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
        },

        name: {
          type: 'string',
        },

        email: {
          type: 'string',
          format: 'email',
          nullable: true,
        },

        teamLeaderId: {
          type: 'string',
          format: 'uuid',
        },

        assignedSessionId: {
          type: 'string',
          format: 'uuid',
          nullable: true,
        },

        templateSendLimit24h: {
          type: 'integer',
          minimum: 0,
          nullable: true,
          example: 20,
          description:
            'Maximum stored-template sends allowed in a rolling 24-hour window. Null means unlimited; 0 disables stored-template sending.',
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
    status: HttpStatus.BAD_REQUEST,
    description:
      'sessionId is not a valid UUID or null.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description:
      'Agent or Session does not exist within this Team Leader tenant.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description:
      'Caller is not a valid Team Leader principal.',
  })
  async assignAgentSession(
    @CurrentApiKey()
    apiKey: ApiKey,

    @Param(
      'agentId',
      ParseUUIDPipe,
    )
    agentId: string,

    @Body()
    dto: AssignAgentSessionDto,
  ): Promise<Agent> {
    const teamLeaderId =
      this.requireTeamLeaderId(apiKey);

    return this.teamLeaderService.assignAgentSession(
      teamLeaderId,
      agentId,
      dto.sessionId,
    );
  }

  /**
   * Resolve the authenticated Team Leader binding.
   *
   * TEAM_MANAGE alone is deliberately insufficient here because ADMIN
   * also possesses TEAM_MANAGE.
   *
   * These endpoints represent "my Team Leader account", so the key must
   * actually be a TEAM_LEADER credential with a principal binding.
   *
   * We cannot currently rely on:
   *
   *   @RequireRole(ApiKeyRole.TEAM_LEADER)
   *
   * because the legacy ROLE_PERMISSIONS compatibility matrix was not
   * designed as a management-principal role hierarchy.
   */
  private requireTeamLeaderId(
    apiKey: ApiKey,
  ): string {
    if (
      apiKey.role !==
        ApiKeyRole.TEAM_LEADER ||
      !apiKey.teamLeaderId
    ) {
      throw new ForbiddenException(
        'A valid Team Leader principal is required',
      );
    }

    return apiKey.teamLeaderId;
  }
}




