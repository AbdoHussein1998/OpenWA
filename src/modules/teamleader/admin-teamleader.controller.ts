



import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Body,
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
  CreateTeamLeaderDto,
} from './dto/create-team-leader.dto';

import {
  TeamLeaderService,
  type CreateTeamLeaderResult,
} from './teamleader.service';

import {
  TeamLeader,
} from './entities/team-leader.entity';

/**
 * Administrative Team Leader management.
 *
 * These endpoints are intentionally:
 *
 * - ADMIN only
 * - unavailable to session-scoped API keys
 *
 * A scoped ADMIN key must not be able to create or remove management
 * principals because those operations have no concrete session
 * dimension to which its allowedSessions ceiling could safely apply.
 */
@ApiTags('admin/team-leaders')
@Controller('admin/team-leaders')
@RequireRole(ApiKeyRole.ADMIN)
@RequireUnscopedKey()
export class AdminTeamLeaderController {
  constructor(
    private readonly teamLeaderService: TeamLeaderService,
  ) {}

  /**
   * Create a Team Leader principal together with its API key.
   *
   * Principal + credential creation is transactional inside
   * TeamLeaderService.
   *
   * The plaintext API key is returned only once.
   */
  @Post()
  @ApiOperation({
    summary:
      'Create a Team Leader',
    description:
      'Creates a Team Leader and its TEAM_LEADER API key atomically. The plaintext API key is returned only once.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description:
      'Team Leader created successfully.',
    schema: {
      type: 'object',
      required: [
        'teamLeader',
        'apiKey',
      ],
      properties: {
        teamLeader: {
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

        apiKey: {
          type: 'string',
          example:
            'owa_k1_0123456789abcdef...',
          description:
            'Plaintext API key. Returned only once and never persisted in plaintext.',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'Invalid request body.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description:
      'Caller is not an unscoped ADMIN.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'A Team Leader with the supplied email already exists.',
  })
  async create(
    @Body()
    dto: CreateTeamLeaderDto,
  ): Promise<CreateTeamLeaderResult> {
    return this.teamLeaderService.createTeamLeader(
      dto,
    );
  }

  /**
   * List all Team Leaders.
   *
   * Plaintext API keys are never available from this endpoint.
   */
  @Get()
  @ApiOperation({
    summary:
      'List Team Leaders',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description:
      'All Team Leader principals.',
    schema: {
      type: 'array',
      items: {
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
          },
          email: {
            type: 'string',
            format: 'email',
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
      'Caller is not an unscoped ADMIN.',
  })
  async findAll(): Promise<TeamLeader[]> {
    return this.teamLeaderService.listTeamLeaders();
  }

  /**
   * Get one Team Leader by UUID.
   */
  @Get(':id')
  @ApiOperation({
    summary:
      'Get a Team Leader',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description:
      'Team Leader details.',
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
        },
        email: {
          type: 'string',
          format: 'email',
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
    status: HttpStatus.NOT_FOUND,
    description:
      'Team Leader not found.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description:
      'Caller is not an unscoped ADMIN.',
  })
  async findOne(
    @Param(
      'id',
      new ParseUUIDPipe(),
    )
    id: string,
  ): Promise<TeamLeader> {
    return this.teamLeaderService.getTeamLeader(
      id,
    );
  }

  /**
   * Delete a Team Leader.
   *
   * Deletion is refused while the Team Leader owns one or more
   * WhatsApp sessions.
   *
   * We intentionally do NOT silently detach those sessions because
   * doing so would erase tenant ownership information.
   */
  @Delete(':id')
  @HttpCode(
    HttpStatus.NO_CONTENT,
  )
  @ApiOperation({
    summary:
      'Delete a Team Leader',
  })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description:
      'Team Leader deleted successfully.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description:
      'Team Leader not found.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'Team Leader still owns one or more sessions.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description:
      'Caller is not an unscoped ADMIN.',
  })
  async delete(
    @Param(
      'id',
      new ParseUUIDPipe(),
    )
    id: string,
  ): Promise<void> {
    await this.teamLeaderService.deleteTeamLeader(
      id,
    );
  }
}



