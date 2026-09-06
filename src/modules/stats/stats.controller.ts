

import {
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';

import {
  ApiTags,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';

import {
  MessageStatsResponseDto,
  OverviewStatsResponseDto,
  SessionStatsResponseDto,
} from './dto/stats-response.dto';

import { StatsService } from './stats.service';
import { StatsQueryDto } from './dto/stats-query.dto';

import {
  RequireRole,
  RequireUnscopedKey,
  SessionScoped,
} from '../auth/decorators/auth.decorators';

import {
  ApiKeyRole,
} from '../auth/entities/api-key.entity';

@ApiTags('statistics')
@Controller('stats')

/*
 * :sessionId in this controller always represents a WhatsApp Session ID.
 *
 * This allows ApiKeyGuard to apply the normal tenant fence to:
 *
 *   GET /stats/sessions/:sessionId
 *
 * Aggregate routes below do not contain :sessionId and remain protected
 * independently by ADMIN + RequireUnscopedKey.
 */
@SessionScoped()
export class StatsController {
  constructor(
    private readonly statsService: StatsService,
  ) {}

  /*
   * Deliberately GLOBAL.
   *
   * This endpoint is not converted to effective SessionScope because its
   * contract is explicitly a system-wide ADMIN aggregate.
   *
   * RequireUnscopedKey prevents a session-restricted ADMIN credential from
   * using this route to bypass its allowedSessions ceiling.
   *
   * TEAM_LEADER / AGENT cannot reach this route because of the ADMIN role
   * requirement.
   */
  @Get('overview')
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @ApiOperation({
    summary: 'Get overall statistics',
  })
  @ApiResponse({
    status: 200,
    description:
      'Cross-session aggregate statistics (sessions, messages, etc.).',
    type: OverviewStatsResponseDto,
  })
  async getOverview() {
    return this.statsService.getOverview();
  }

  /*
   * Same reasoning as /stats/overview:
   *
   * this is intentionally a global ADMIN-only aggregate.
   */
  @Get('messages')
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @ApiOperation({
    summary: 'Get message statistics with time series',
  })
  @ApiResponse({
    status: 200,
    description:
      'Message statistics with a time series for the requested period.',
    type: MessageStatsResponseDto,
  })
  async getMessageStats(
    @Query() query: StatsQueryDto,
  ) {
    return this.statsService.getMessageStats(
      query.period || '24h',
    );
  }

  /*
   * Per-session route.
   *
   * @SessionScoped() on the controller tells ApiKeyGuard that this
   * :sessionId is a tenant-scoped WhatsApp Session ID.
   *
   * Therefore:
   *
   * ADMIN / legacy       -> normal allowedSessions rules
   * TEAM_LEADER          -> must own the session
   * AGENT                -> must be assigned + owner must match
   * foreign/nonexistent  -> 404
   */
  @Get('sessions/:sessionId')
  @ApiOperation({
    summary: 'Get statistics for a specific session',
  })
  @ApiResponse({
    status: 200,
    description:
      'Per-session statistics for the requested session.',
    type: SessionStatsResponseDto,
  })
  async getSessionStats(
    @Param('sessionId') sessionId: string,
  ) {
    return this.statsService.getSessionStats(
      sessionId,
    );
  }
}



