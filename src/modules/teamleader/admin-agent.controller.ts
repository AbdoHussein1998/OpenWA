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
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsUUID,
} from 'class-validator';

import {
  RequireRole,
  RequireUnscopedKey,
} from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import {
  TeamLeaderService,
  type AdminAgentOverview,
} from './teamleader.service';

// Preserve the existing public type export used by controller specs/consumers
// while keeping the service as the single source of truth for the shape.
export type { AdminAgentOverview } from './teamleader.service';

export class ReassignAdminAgentDto {
  @ApiProperty({
    description: 'Team Leader UUID that will own the Agent after the move.',
    format: 'uuid',
  })
  @IsUUID()
  targetTeamLeaderId!: string;

  @ApiPropertyOptional({
    description:
      'When true, explicitly clear the Agent Session assignment while moving the Agent. Required when the current Session is not owned by the target Team Leader.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  unassignSession = false;
}

export class BulkReassignAdminAgentsDto {
  @ApiProperty({
    description: 'Agent UUIDs to move.',
    type: [String],
    format: 'uuid',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  agentIds!: string[];

  @ApiProperty({
    description: 'Team Leader UUID that will own all selected Agents.',
    format: 'uuid',
  })
  @IsUUID()
  targetTeamLeaderId!: string;

  @ApiPropertyOptional({
    description:
      'When true, clear the selected Agents\' Session assignments as part of the main-database transaction.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  unassignSession = false;
}

/**
 * Global Agent administration.
 *
 * Every endpoint is ADMIN-only and unavailable to session-scoped API keys
 * because these operations have no single Session dimension to which an
 * allowedSessions ceiling can safely be applied.
 */
@ApiTags('admin/agents')
@Controller('admin/agents')
@RequireRole(ApiKeyRole.ADMIN)
@RequireUnscopedKey()
export class AdminAgentController {
  constructor(
    private readonly teamLeaderService: TeamLeaderService,
  ) {}

  /** List every Agent with Team Leader and assigned Session metadata. */
  @Get()
  @ApiOperation({
    summary: 'List all Agents for administration',
    description:
      'Returns every Agent with its Team Leader and assigned Session overview. Plaintext API keys are never returned.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description:
      'All Agent principals with Team Leader and assigned Session information.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Caller is not an unscoped ADMIN.',
  })
  async findAll(): Promise<AdminAgentOverview[]> {
    return this.teamLeaderService.getAdminAgents();
  }

  /**
   * Resolve one Agent before reassignment/deletion so the Admin UI can show
   * exactly which Team Leader and Session relationship will be affected.
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get an Agent for administration',
  })
  @ApiParam({
    name: 'id',
    description: 'Agent UUID',
    format: 'uuid',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Agent, Team Leader, and assigned Session overview.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Agent not found.',
  })
  async findOne(
    @Param('id', ParseUUIDPipe)
    id: string,
  ): Promise<AdminAgentOverview> {
    return this.teamLeaderService.getAdminAgent(id);
  }

  /** Move one Agent to another Team Leader. */
  @Patch(':id/team-leader')
  @ApiOperation({
    summary: 'Reassign an Agent to another Team Leader',
    description:
      'Moves the Agent in the main database. If the existing assigned Session is not owned by the target Team Leader, send unassignSession=true so the move cannot create an invalid cross-tenant assignment.',
  })
  @ApiParam({
    name: 'id',
    description: 'Agent UUID',
    format: 'uuid',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Updated Agent overview.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Agent or target Team Leader not found.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'The Agent has a Session assignment that cannot remain valid under the target Team Leader.',
  })
  async reassign(
    @Param('id', ParseUUIDPipe)
    id: string,
    @Body()
    dto: ReassignAdminAgentDto,
  ): Promise<AdminAgentOverview> {
    return this.teamLeaderService.reassignAdminAgent(
      id,
      dto.targetTeamLeaderId,
      dto.unassignSession,
    );
  }

  /** Bulk-move Agents to one Team Leader. */
  @Post('bulk-reassign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bulk reassign Agents to another Team Leader',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Updated Agent overviews in the same order as agentIds.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'One or more Agents or the target Team Leader were not found.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'One or more Session assignments cannot remain valid under the target Team Leader.',
  })
  async bulkReassign(
    @Body()
    dto: BulkReassignAdminAgentsDto,
  ): Promise<AdminAgentOverview[]> {
    return this.teamLeaderService.reassignAdminAgents(
      dto.agentIds,
      dto.targetTeamLeaderId,
      dto.unassignSession,
    );
  }

  /**
   * Delete an Agent as ADMIN.
   *
   * The Agent's assigned Session is not deleted because the Session is owned
   * by its Team Leader, not by the Agent.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an Agent',
    description:
      'Deletes the Agent principal and its AGENT credentials. Any assigned Session remains intact.',
  })
  @ApiParam({
    name: 'id',
    description: 'Agent UUID',
    format: 'uuid',
  })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'Agent deleted successfully.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Agent not found.',
  })
  async delete(
    @Param('id', ParseUUIDPipe)
    id: string,
  ): Promise<void> {
    await this.teamLeaderService.deleteAdminAgent(id);
  }
}
