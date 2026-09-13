import {
  Controller,
  Get,
  HttpStatus,
} from '@nestjs/common';

import {
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import {
  RequireRole,
  RequireUnscopedKey,
} from '../auth/decorators/auth.decorators';

import {
  ApiKeyRole,
} from '../auth/entities/api-key.entity';

import {
  TeamLeaderService,
} from './teamleader.service';

/**
 * Public response shape for the ADMIN Agent overview.
 *
 * Agent / Team Leader identity data lives in the `main` database while
 * Session data lives in the separate `data` database. TeamLeaderService
 * owns that cross-database merge; this controller only exposes the result.
 */
export interface AdminAgentOverview {
  id: string;
  name: string;
  email: string | null;

  teamLeaderId: string;

  teamLeader: {
    id: string;
    name: string;
    email: string | null;
  };

  assignedSessionId: string | null;

  assignedSession: {
    id: string;
    name: string;
    status: string;
    phone: string | null;
    targetPhone: string | null;
  } | null;

  templateSendLimit24h: number | null;

  createdAt: Date;
  updatedAt: Date;
}

/**
 * Global Agent overview for administrators.
 *
 * This endpoint is intentionally:
 *
 * - ADMIN only
 * - unavailable to session-scoped API keys
 *
 * The endpoint has no single session dimension, so a session-scoped ADMIN
 * credential must not be able to use it to inspect principals outside its
 * allowedSessions ceiling.
 */
@ApiTags('admin/agents')
@Controller('admin/agents')
@RequireRole(ApiKeyRole.ADMIN)
@RequireUnscopedKey()
export class AdminAgentController {
  constructor(
    private readonly teamLeaderService: TeamLeaderService,
  ) {}

  /**
   * List every Agent together with its owning Team Leader and currently
   * assigned Session, when one exists.
   *
   * TeamLeaderService performs the cross-database lookup:
   *
   * main DB:
   *   Agent + TeamLeader
   *
   * data DB:
   *   Session
   *
   * No plaintext API key is returned by this endpoint.
   */
  @Get()
  @ApiOperation({
    summary:
      'List all Agents for administration',
    description:
      'Returns every Agent with its Team Leader and assigned Session overview. Plaintext API keys are never returned.',
  })
  @ApiResponse({
    status:
      HttpStatus.OK,

    description:
      'All Agent principals with Team Leader and assigned Session information.',

    schema: {
      type:
        'array',

      items: {
        type:
          'object',

        required: [
          'id',
          'name',
          'email',
          'teamLeaderId',
          'teamLeader',
          'assignedSessionId',
          'assignedSession',
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
            example:
              'Mohamed Ali',
          },

          email: {
            type:
              'string',
            format:
              'email',
            nullable:
              true,
            example:
              'mohamed.ali@example.com',
          },

          teamLeaderId: {
            type:
              'string',
            format:
              'uuid',
          },

          teamLeader: {
            type:
              'object',

            required: [
              'id',
              'name',
              'email',
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
                example:
                  'Ahmed Hassan',
              },

              email: {
                type:
                  'string',
                format:
                  'email',
                nullable:
                  true,
                example:
                  'ahmed.hassan@example.com',
              },
            },
          },

          assignedSessionId: {
            type:
              'string',
            format:
              'uuid',
            nullable:
              true,
          },

          assignedSession: {
            type:
              'object',
            nullable:
              true,

            required: [
              'id',
              'name',
              'status',
              'phone',
              'targetPhone',
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

              status: {
                type:
                  'string',
              },

              phone: {
                type:
                  'string',
                nullable:
                  true,
              },

              targetPhone: {
                type:
                  'string',
                nullable:
                  true,
              },
            },
          },

          templateSendLimit24h: {
            type:
              'integer',
            nullable:
              true,
            minimum:
              0,
            description:
              'Rolling 24-hour stored-template send limit. Null means unlimited.',
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
    },
  })
  @ApiResponse({
    status:
      HttpStatus.FORBIDDEN,

    description:
      'Caller is not an unscoped ADMIN.',
  })
  async findAll(): Promise<AdminAgentOverview[]> {
    return this.teamLeaderService.getAdminAgents();
  }
}
