



import {
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import {
  ApiCapability,
} from '../auth/capabilities/api-capability';
import {
  RequireCapability,
} from '../auth/decorators/capability.decorator';
import {
  RequireUnscopedKey,
  SessionScoped,
} from '../auth/decorators/auth.decorators';

import {
  StatsQueryDto,
} from './dto/stats-query.dto';
import {
  MessageStatsResponseDto,
  OverviewStatsResponseDto,
  SessionStatsResponseDto,
} from './dto/stats-response.dto';
import {
  StatsService,
} from './stats.service';

@ApiTags('statistics')
@Controller('stats')
/*
 * :sessionId in this controller always represents a WhatsApp Session ID.
 *
 * ApiKeyGuard therefore applies the normal tenant fence to:
 *
 *   GET /stats/sessions/:sessionId
 *
 * Aggregate routes do not contain a Session id and are protected separately
 * by STATS_READ + RequireUnscopedKey().
 */
@SessionScoped()
export class StatsController {
  constructor(
    private readonly statsService: StatsService,
  ) {}

  /**
   * Deliberately global.
   *
   * ADMIN and OPERATOR receive STATS_READ. RequireUnscopedKey prevents a
   * session-restricted administrative credential from using this aggregate
   * endpoint to bypass its allowedSessions ceiling.
   */
  @Get('overview')
  @RequireCapability(ApiCapability.STATS_READ)
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
  @ApiResponse({
    status: 403,
    description:
      'Caller lacks STATS_READ or is using a session-scoped API key.',
  })
  async getOverview() {
    return this.statsService.getOverview();
  }

  /**
   * Global message aggregate using the same authorization boundary as the
   * overview endpoint.
   */
  @Get('messages')
  @RequireCapability(ApiCapability.STATS_READ)
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
  @ApiResponse({
    status: 403,
    description:
      'Caller lacks STATS_READ or is using a session-scoped API key.',
  })
  async getMessageStats(
    @Query()
    query: StatsQueryDto,
  ) {
    return this.statsService.getMessageStats(
      query.period || '24h',
    );
  }

  /**
   * Per-session statistics.
   *
   * SESSION_READ answers WHAT the caller may do while ApiKeyGuard and
   * SessionTenantAccessService enforce WHERE the caller may do it:
   *
   * - ADMIN / OPERATOR / VIEWER: normal allowedSessions ceiling
   * - TEAM_LEADER: must own the Session
   * - AGENT: must be assigned and the Session owner must match
   * - foreign/nonexistent Session: 404
   */
  @Get('sessions/:sessionId')
  @RequireCapability(ApiCapability.SESSION_READ)
  @ApiOperation({
    summary: 'Get statistics for a specific session',
  })
  @ApiResponse({
    status: 200,
    description:
      'Per-session statistics for the requested Session.',
    type: SessionStatsResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Caller lacks SESSION_READ.',
  })
  @ApiResponse({
    status: 404,
    description:
      'Session does not exist or is outside the caller\'s tenant scope.',
  })
  async getSessionStats(
    @Param('sessionId')
    sessionId: string,
  ) {
    return this.statsService.getSessionStats(
      sessionId,
    );
  }
}



