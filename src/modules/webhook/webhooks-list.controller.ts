


import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { SessionTenantAccessService } from '../access-control/session-tenant-access.service';
import { ApiCapability } from '../auth/capabilities/api-capability';
import {
  CurrentApiKey,
  RequireRole,
} from '../auth/decorators/auth.decorators';
import { RequireCapability } from '../auth/decorators/capability.decorator';
import {
  ApiKey,
  ApiKeyRole,
} from '../auth/entities/api-key.entity';
import {
  WebhookDeliveryFailureDto,
  WebhookResponseDto,
} from './dto';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { WebhookService } from './webhook.service';

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
    const sessionScope =
      await this.sessionTenantAccessService.getEffectiveSessionScope(
        apiKey,
      );

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
  @RequireCapability(ApiCapability.WEBHOOK_MANAGE)
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
    const sessionScope =
      await this.sessionTenantAccessService.getEffectiveSessionScope(
        apiKey,
      );

    const webhooks = await this.webhookService.findAll(
      sessionScope,
      {
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      },
    );

    return WebhookResponseDto.fromEntities(webhooks);
  }
}




