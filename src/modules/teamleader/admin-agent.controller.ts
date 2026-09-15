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
import { AssignAgentSessionDto } from './dto/assign-agent-session.dto';
import { BulkReassignAdminAgentsDto } from './dto/bulk-reassignment.dto';
import { ReassignAdminAgentDto } from './dto/reassign-agent.dto';
import {
  TeamLeaderService,
  type AdminAgentOverview,
} from './teamleader.service';

// Preserve the existing public type export used by controller specs/consumers
// while keeping the service as the single source of truth for the shape.
export type { AdminAgentOverview } from './teamleader.service';

/**
 * Global Agent administration.
 *
 * These routes require PRINCIPAL_MANAGE, which is granted to ADMIN and
 * OPERATOR but not to Team Leaders. TEAM_MANAGE remains reserved for the
 * Team Leader self-service surface.
 *
 * Session-scoped API keys are also rejected because these operations can span
 * multiple Sessions and Team Leaders and therefore have no single Session
 * dimension to which allowedSessions can safely be applied.
 */
@ApiTags('admin/agents')
@Controller('admin/agents')
@RequireCapability(ApiCapability.PRINCIPAL_MANAGE)
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
    description: 'Caller is not an unscoped ADMIN/OPERATOR.',
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
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Caller is not an unscoped ADMIN/OPERATOR.',
  })
  async findOne(
    @Param('id', ParseUUIDPipe)
    id: string,
  ): Promise<AdminAgentOverview> {
    return this.teamLeaderService.getAdminAgent(id);
  }

  /**
   * Assign or unassign a Session as ADMIN.
   *
   * A non-null assignment is ownership-authoritative:
   *
   *   Session.ownerTeamLeaderId = Agent.teamLeaderId
   *
   * If another Agent currently owns the assignment, that Agent is unassigned
   * as part of the same main-database transaction. This preserves the
   * one-Agent-per-Session invariant while making the Agent's Team Leader the
   * effective Session owner.
   */
  @Patch(':id/assignment')
  @ApiOperation({
    summary: 'Assign or unassign a Session for an Agent',
    description:
      'Assigns a Session to the selected Agent and automatically makes that Agent\'s Team Leader the Session owner. Send sessionId:null to remove only the Agent assignment; Team Leader ownership is preserved.',
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
    status: HttpStatus.BAD_REQUEST,
    description: 'sessionId is not a valid UUID or null.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Agent or Session not found.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'The assignment could not be completed safely because ownership or assignment state changed concurrently.',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Caller is not an unscoped ADMIN/OPERATOR.',
  })
  async assignSession(
    @Param('id', ParseUUIDPipe)
    id: string,
    @Body()
    dto: AssignAgentSessionDto,
  ): Promise<AdminAgentOverview> {
    return this.teamLeaderService.assignAdminAgentSession(
      id,
      dto.sessionId,
    );
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
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Caller is not an unscoped ADMIN/OPERATOR.',
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
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Caller is not an unscoped ADMIN/OPERATOR.',
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
      'Deletes the Agent principal and its AGENT credentials. Any assigned Session remains intact and keeps its Team Leader owner.',
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
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Caller is not an unscoped ADMIN/OPERATOR.',
  })
  async delete(
    @Param('id', ParseUUIDPipe)
    id: string,
  ): Promise<void> {
    await this.teamLeaderService.deleteAdminAgent(id);
  }
}
