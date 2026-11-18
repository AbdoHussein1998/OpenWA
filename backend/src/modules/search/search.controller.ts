


import {
  BadRequestException,
  Controller,
  Get,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { SearchResultsResponseDto } from './dto/search-response.dto';
import { SearchQueryDto } from './dto/search-query.dto';
import { SearchService } from './search.service';

import {
  RequireRole,
  CurrentApiKey,
} from '../auth/decorators/auth.decorators';
import {
  ApiKey,
  ApiKeyRole,
} from '../auth/entities/api-key.entity';

import { SessionTenantAccessService } from '../access-control/session-tenant-access.service';

import type { SearchResults } from './search.types';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(
    private readonly searchService: SearchService,
    private readonly sessionTenantAccessService: SessionTenantAccessService,
  ) {}

  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({
    summary:
      'Search messages across sessions visible to the calling key',
  })
  @ApiResponse({
    status: 200,
    description: 'Search results from the active provider',
    type: SearchResultsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Empty or whitespace-only "q"',
  })
  @ApiResponse({
    status: 501,
    description: 'No search provider configured',
  })
  @ApiResponse({
    status: 502,
    description:
      'The active plugin search provider returned a result shape that failed validation, so nothing ' +
      'trustworthy could be forwarded. The built-in provider never returns this.',
  })
  @ApiResponse({
    status: 503,
    description:
      'The active plugin search provider did not answer: its worker is not running, timed out, or reported ' +
      'a failure. The built-in provider never returns this. Retryable.',
  })
  @ApiQuery({
    name: 'q',
    required: true,
    description: 'Search term (required, non-empty)',
  })
  @ApiQuery({
    name: 'sessionId',
    required: false,
    description: 'Restrict to a single session',
  })
  @ApiQuery({
    name: 'chatId',
    required: false,
    description: 'Restrict to a single chat id',
  })
  @ApiQuery({
    name: 'direction',
    required: false,
    description: 'incoming | outgoing',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    description: 'Message type filter',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'Sender filter',
  })
  @ApiQuery({
    name: 'dateFrom',
    required: false,
    description: 'Epoch-ms lower bound (inclusive)',
  })
  @ApiQuery({
    name: 'dateTo',
    required: false,
    description: 'Epoch-ms upper bound (inclusive)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max hits to return',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Pagination offset',
  })
  async search(
    @Query() dto: SearchQueryDto,
    @CurrentApiKey() apiKey: ApiKey,
  ): Promise<SearchResults> {
    if (!dto.q || !dto.q.trim()) {
      throw new BadRequestException(
        'Query parameter "q" is required and must be non-empty.',
      );
    }

    /*
     * Phase H — aggregate/global route tenancy.
     *
     * GET /search does not contain a :sessionId route parameter, so the
     * ApiKeyGuard cannot perform a single-session tenant check.
     *
     * Do NOT use apiKey.allowedSessions directly here.
     *
     * Effective scope can be:
     *
     *   legacy unrestricted key
     *     -> ALL
     *
     *   legacy restricted key
     *     -> IDS(...)
     *
     *   TEAM_LEADER
     *     -> OWNER(teamLeaderId)
     *
     *   TEAM_LEADER + allowedSessions ceiling
     *     -> OWNER_AND_IDS(teamLeaderId, [...])
     *
     *   AGENT
     *     -> OWNER_AND_IDS(teamLeaderId, [assignedSessionId])
     *
     *   inaccessible identity
     *     -> NONE
     *
     * The optional dto.sessionId must never become authoritative.
     * SearchService/provider logic must INTERSECT dto.sessionId with the
     * effective SessionScope rather than replacing or widening that scope.
     */
    const sessionScope =
      await this.sessionTenantAccessService.getEffectiveSessionScope(apiKey);

    return this.searchService.search(dto, sessionScope);
  }
}


