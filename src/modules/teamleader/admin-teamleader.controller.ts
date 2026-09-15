import {
  Body,
  Controller,
  Delete,
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
  RequireUnscopedKey,
} from '../auth/decorators/auth.decorators';
import {
  RequireCapability,
} from '../auth/decorators/capability.decorator';
import {
  ApiCapability,
} from '../auth/capabilities/api-capability';
import { BulkReassignAdminSessionsDto } from './dto/bulk-reassignment.dto';
import { CreateAgentDto } from './dto/create-agent.dto';
import { CreateTeamLeaderDto } from './dto/create-team-leader.dto';
import { ReassignAdminSessionDto } from './dto/reassign-session-owner.dto';
import { TeamLeader } from './entities/team-leader.entity';
import {
  TeamLeaderService,
  type AdminSessionOverview,
  type AdminTeamLeaderResources,
  type CreateAgentResult,
  type CreateTeamLeaderResult,
  type ForceDeleteTeamLeaderResult,
} from './teamleader.service';

/**
 * Administrative Team Leader management.
 *
 * These routes require the global PRINCIPAL_MANAGE capability. ADMIN and OPERATOR receive it; Team Leaders do not, even though they retain TEAM_MANAGE for their own self-service surface.
 *
 * Session-scoped API keys are rejected because these operations can span
 * multiple Team Leaders and Sessions.
 */
@ApiTags('admin/team-leaders')
@Controller('admin/team-leaders')
@RequireCapability(ApiCapability.PRINCIPAL_MANAGE)
@RequireUnscopedKey()
export class AdminTeamLeaderController {
  constructor(
    private readonly teamLeaderService: TeamLeaderService,
  ) {}

  /** Create a Team Leader principal together with its API key. */
  @Post()
  @ApiOperation({
    summary: 'Create a Team Leader',
    description:
      'Creates a Team Leader and its TEAM_LEADER API key atomically. Email is optional. The plaintext API key is returned only once.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Team Leader created successfully.',
    schema: {
      type: 'object',
      required: ['teamLeader', 'apiKey'],
      properties: {
        teamLeader: {
          type: 'object',
          required: ['id', 'name', 'email', 'createdAt', 'updatedAt'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string', example: 'Ahmed Hassan' },
            email: {
              type: 'string',
              format: 'email',
              nullable: true,
              example: 'ahmed.hassan@example.com',
            },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        apiKey: {
          type: 'string',
          example: 'owa_k1_0123456789abcdef...',
          description:
            'Plaintext API key. Returned only once and never persisted in plaintext.',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid request body.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Caller is not an unscoped ADMIN/OPERATOR.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'A Team Leader with the supplied non-null email already exists.',
  })
  async create(
    @Body()
    dto: CreateTeamLeaderDto,
  ): Promise<CreateTeamLeaderResult> {
    return this.teamLeaderService.createTeamLeader(dto);
  }

  /** Create an Agent under a specific Team Leader. */
  @Post(':teamLeaderId/agents')
  @ApiOperation({
    summary: 'Create an Agent for a Team Leader',
    description:
      'Creates an Agent under the selected Team Leader and provisions its AGENT API key atomically. The plaintext API key is returned only once.',
  })
  @ApiParam({
    name: 'teamLeaderId',
    description: 'Team Leader UUID',
    format: 'uuid',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Agent created successfully.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid Team Leader UUID or request body.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Team Leader not found.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Caller is not an unscoped ADMIN/OPERATOR.',
  })
  async createAgent(
    @Param('teamLeaderId', ParseUUIDPipe)
    teamLeaderId: string,
    @Body()
    dto: CreateAgentDto,
  ): Promise<CreateAgentResult> {
    return this.teamLeaderService.createAgent(teamLeaderId, dto);
  }

  /** List all Team Leaders. */
  @Get()
  @ApiOperation({
    summary: 'List Team Leaders',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'All Team Leader principals.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Caller is not an unscoped ADMIN/OPERATOR.',
  })
  async findAll(): Promise<TeamLeader[]> {
    return this.teamLeaderService.listTeamLeaders();
  }

  /**
   * Assign or change the Team Leader owner of a Session directly.
   *
   * This route is especially important for Sessions created by an ADMIN,
   * because those Sessions may initially have ownerTeamLeaderId = null.
   *
   * If the Session is already assigned to an Agent, the requested Team Leader
   * must match that Agent's Team Leader. To move an assigned Session across
   * Team Leaders, use the ADMIN Agent assignment flow so Agent assignment and
   * Session ownership remain consistent.
   */
  @Patch('sessions/:sessionId/owner')
  @ApiOperation({
    summary: 'Assign or change Session Team Leader ownership',
    description:
      'Assigns an unowned or unassigned Session to a Team Leader. If an Agent is already assigned, the target Team Leader must be that Agent\'s Team Leader.',
  })
  @ApiParam({
    name: 'sessionId',
    description: 'Session UUID',
    format: 'uuid',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Updated Session ownership summary.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Session or target Team Leader not found.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'The Session is assigned to an Agent belonging to another Team Leader, or assignment state changed concurrently.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Caller is not an unscoped ADMIN/OPERATOR.',
  })
  async setSessionOwner(
    @Param('sessionId', ParseUUIDPipe)
    sessionId: string,
    @Body()
    dto: ReassignAdminSessionDto,
  ): Promise<AdminSessionOverview> {
    return this.teamLeaderService.setAdminSessionOwner(
      sessionId,
      dto.targetTeamLeaderId,
    );
  }

  /**
   * Inspect every resource that must be handled before this Team Leader can
   * be deleted.
   */
  @Get(':id/resources')
  @ApiOperation({
    summary: 'Inspect Team Leader resources before reassignment or deletion',
    description:
      'Returns the Team Leader, owned Sessions, owned Agents, and whether the principal is currently safe to delete.',
  })
  @ApiParam({
    name: 'id',
    description: 'Team Leader UUID',
    format: 'uuid',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Current Team Leader resource graph.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Team Leader not found.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Caller is not an unscoped ADMIN/OPERATOR.',
  })
  async resources(
    @Param('id', ParseUUIDPipe)
    id: string,
  ): Promise<AdminTeamLeaderResources> {
    return this.teamLeaderService.getAdminTeamLeaderResources(id);
  }

  /** Transfer one unassigned Session to another Team Leader. */
  @Patch(':id/sessions/:sessionId/owner')
  @ApiOperation({
    summary: 'Reassign Session ownership from a known Team Leader',
    description:
      'Transfers an unassigned Session from this Team Leader to another Team Leader. If an Agent is currently assigned, use the Agent assignment flow instead.',
  })
  @ApiParam({
    name: 'id',
    description: 'Current owner Team Leader UUID',
    format: 'uuid',
  })
  @ApiParam({
    name: 'sessionId',
    description: 'Session UUID',
    format: 'uuid',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Updated Session ownership summary.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description:
      'Source/target Team Leader not found, or Session does not belong to the source Team Leader.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'The Session is still assigned to an Agent or ownership changed concurrently.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Caller is not an unscoped ADMIN/OPERATOR.',
  })
  async reassignSession(
    @Param('id', ParseUUIDPipe)
    id: string,
    @Param('sessionId', ParseUUIDPipe)
    sessionId: string,
    @Body()
    dto: ReassignAdminSessionDto,
  ): Promise<AdminSessionOverview> {
    return this.teamLeaderService.reassignAdminSession(
      id,
      sessionId,
      dto.targetTeamLeaderId,
    );
  }

  /** Bulk-transfer unassigned Sessions to another Team Leader. */
  @Post(':id/sessions/bulk-reassign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bulk reassign Session ownership',
    description:
      'Transfers all selected unassigned Sessions from the source Team Leader to one target Team Leader.',
  })
  @ApiParam({
    name: 'id',
    description: 'Current owner Team Leader UUID',
    format: 'uuid',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Updated Session ownership summaries.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description:
      'Source/target Team Leader not found, or one or more Sessions do not belong to the source Team Leader.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'One or more Sessions are still assigned to Agents or ownership changed concurrently.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Caller is not an unscoped ADMIN/OPERATOR.',
  })
  async bulkReassignSessions(
    @Param('id', ParseUUIDPipe)
    id: string,
    @Body()
    dto: BulkReassignAdminSessionsDto,
  ): Promise<AdminSessionOverview[]> {
    return this.teamLeaderService.reassignAdminSessions(
      id,
      dto.sessionIds,
      dto.targetTeamLeaderId,
    );
  }

  /** Get one Team Leader by UUID. */
  @Get(':id')
  @ApiOperation({
    summary: 'Get a Team Leader',
  })
  @ApiParam({
    name: 'id',
    description: 'Team Leader UUID',
    format: 'uuid',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Team Leader details.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Team Leader not found.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Caller is not an unscoped ADMIN/OPERATOR.',
  })
  async findOne(
    @Param('id', ParseUUIDPipe)
    id: string,
  ): Promise<TeamLeader> {
    return this.teamLeaderService.getTeamLeader(id);
  }


  /**
   * Permanently delete a Team Leader together with every owned Session,
   * Agent, and principal-bound credential.
   *
   * This endpoint is intentionally separate from DELETE /:id, which remains
   * the safe deletion path and refuses non-empty principals.
   */
  @Delete(':id/force')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Force delete a Team Leader and all owned resources',
    description:
      'Permanently deletes every Session owned by the Team Leader through the normal Session lifecycle, then deletes all Agents, Agent/Team-Leader credentials, and the Team Leader principal. This operation is destructive and cannot be undone.',
  })
  @ApiParam({
    name: 'id',
    description: 'Team Leader UUID',
    format: 'uuid',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Team Leader and owned resources deleted successfully.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Team Leader not found.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'A Session could not be retired safely or resources kept changing concurrently.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Caller lacks global principal-management permission.',
  })
  async forceDelete(
    @Param('id', ParseUUIDPipe)
    id: string,
  ): Promise<ForceDeleteTeamLeaderResult> {
    return this.teamLeaderService.forceDeleteTeamLeader(id);
  }

  /**
   * Delete a Team Leader only when no Sessions or Agents remain.
   *
   * The Admin should first inspect /:id/resources and then explicitly move or
   * delete every blocking resource. This prevents silent cascade deletion of
   * Agents and prevents orphaned Session ownership.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an empty Team Leader',
  })
  @ApiParam({
    name: 'id',
    description: 'Team Leader UUID',
    format: 'uuid',
  })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'Team Leader deleted successfully.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Team Leader not found.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'Team Leader still owns Sessions or Agents. Reassign/delete those resources first.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Caller is not an unscoped ADMIN/OPERATOR.',
  })
  async delete(
    @Param('id', ParseUUIDPipe)
    id: string,
  ): Promise<void> {
    await this.teamLeaderService.deleteTeamLeader(id);
  }
}
