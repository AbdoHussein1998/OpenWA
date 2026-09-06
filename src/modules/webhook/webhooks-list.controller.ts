

import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';

import { WebhookService } from './webhook.service';
import { WebhookResponseDto, WebhookDeliveryFailureDto } from './dto';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';

import {
  RequireRole,
  CurrentApiKey,
} from '../auth/decorators/auth.decorators';
import {
  ApiKey,
  ApiKeyRole,
} from '../auth/entities/api-key.entity';

import { SessionTenantAccessService } from '../access-control/session-tenant-access.service';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksListController {
  constructor(
    private readonly webhookService: WebhookService,
    private readonly sessionTenantAccessService: SessionTenantAccessService,
  ) {}

  @Get('delivery-failures')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({
    summary:
      'List recently-failed webhook deliveries (all retries exhausted)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Permanently-failed webhook deliveries, most recent first',
    type: [WebhookDeliveryFailureDto],
  })
  @ApiQuery({
    name: 'sessionId',
    required: false,
    description: 'Filter to a single session',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max records to return (1-1000, default 1000)',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    description: 'Number of records to skip (for paging)',
  })
  async deliveryFailures(
    @CurrentApiKey() apiKey: ApiKey,
    @Query('sessionId') sessionId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<WebhookDeliveryFailure[]> {
    /*
     * Phase H:
     *
     * Do not rely only on apiKey.allowedSessions.
     *
     * Effective scope may be:
     *
     * ADMIN / legacy:
     *   ALL
     *   IDS(...)
     *
     * TEAM_LEADER:
     *   OWNER(teamLeaderId)
     *   OWNER_AND_IDS(...) when allowedSessions is also restricted
     *
     * AGENT:
     *   OWNER_AND_IDS(teamLeaderId, [assignedSessionId])
     *
     * The optional ?sessionId= query must be intersected with this
     * effective scope inside the service/query layer.
     */
    const sessionScope =
      await this.sessionTenantAccessService.getEffectiveSessionScope(apiKey);

    return this.webhookService.listDeliveryFailures(
      {
        sessionId,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      },
      sessionScope,
    );
  }

  @Get()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({
    summary:
      'List webhooks visible to the calling key within its effective session scope',
  })
  @ApiResponse({
    status: 200,
    description: 'List of webhooks',
    type: [WebhookResponseDto],
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max webhooks to return (1-1000, default 1000)',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    description: 'Number of webhooks to skip (for paging)',
  })
  async findAll(
    @CurrentApiKey() apiKey: ApiKey,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<WebhookResponseDto[]> {
    /*
     * Aggregate/global route.
     *
     * GET /webhooks has no :sessionId, so the guard cannot perform
     * a single-session tenant check for us.
     *
     * Build the effective SessionScope and pass it to the query layer
     * so another Team Leader's / Agent's sessions cannot be enumerated.
     */
    const sessionScope =
      await this.sessionTenantAccessService.getEffectiveSessionScope(apiKey);

    const webhooks = await this.webhookService.findAll(sessionScope, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });

    return WebhookResponseDto.fromEntities(webhooks);
  }
}


