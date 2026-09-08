

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { ApiCapability } from '../auth/capabilities/api-capability';
import { RequireCapability } from '../auth/decorators/capability.decorator';
import {
  CreateWebhookDto,
  UpdateWebhookDto,
  WebhookResponseDto,
  WebhookTestResponseDto,
} from './dto';
import { WebhookService } from './webhook.service';

@ApiTags('webhooks')
@Controller('sessions/:sessionId/webhooks')
@RequireCapability(ApiCapability.WEBHOOK_MANAGE)
export class WebhookController {
  constructor(
    private readonly webhookService: WebhookService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Create a webhook for the session',
  })
  @ApiParam({
    name: 'sessionId',
    description: 'Session ID',
  })
  @ApiResponse({
    status: 201,
    description: 'Webhook created',
    type: WebhookResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Session not found',
  })
  async create(
    @Param('sessionId') sessionId: string,
    @Body() dto: CreateWebhookDto,
  ): Promise<WebhookResponseDto> {
    const webhook =
      await this.webhookService.create(
        sessionId,
        dto,
      );

    return WebhookResponseDto.fromEntity(
      webhook,
    );
  }

  @Get()
  @ApiOperation({
    summary: 'List all webhooks for a session',
  })
  @ApiParam({
    name: 'sessionId',
    description: 'Session ID',
  })
  @ApiResponse({
    status: 200,
    description: 'List of webhooks',
    type: [WebhookResponseDto],
  })
  async findBySession(
    @Param('sessionId') sessionId: string,
  ): Promise<WebhookResponseDto[]> {
    const webhooks =
      await this.webhookService.findBySession(
        sessionId,
      );

    return WebhookResponseDto.fromEntities(
      webhooks,
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a webhook by ID',
  })
  @ApiParam({
    name: 'sessionId',
    description: 'Session ID',
  })
  @ApiParam({
    name: 'id',
    description: 'Webhook ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Webhook details',
    type: WebhookResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Webhook not found',
  })
  async findOne(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
  ): Promise<WebhookResponseDto> {
    const webhook =
      await this.webhookService.findOne(
        sessionId,
        id,
      );

    return WebhookResponseDto.fromEntity(
      webhook,
    );
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Update a webhook',
  })
  @ApiParam({
    name: 'sessionId',
    description: 'Session ID',
  })
  @ApiParam({
    name: 'id',
    description: 'Webhook ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Webhook updated',
    type: WebhookResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Webhook not found',
  })
  async update(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Body() dto: UpdateWebhookDto,
  ): Promise<WebhookResponseDto> {
    const webhook =
      await this.webhookService.update(
        sessionId,
        id,
        dto,
      );

    return WebhookResponseDto.fromEntity(
      webhook,
    );
  }

  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Test a webhook by sending a test payload',
  })
  @ApiParam({
    name: 'sessionId',
    description: 'Session ID',
  })
  @ApiParam({
    name: 'id',
    description: 'Webhook ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Test result',
    type: WebhookTestResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Webhook not found',
  })
  async test(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
  ): Promise<{
    success: boolean;
    statusCode?: number;
    error?: string;
  }> {
    return this.webhookService.test(
      sessionId,
      id,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a webhook',
  })
  @ApiParam({
    name: 'sessionId',
    description: 'Session ID',
  })
  @ApiParam({
    name: 'id',
    description: 'Webhook ID',
  })
  @ApiResponse({
    status: 204,
    description: 'Webhook deleted',
  })
  @ApiResponse({
    status: 404,
    description: 'Webhook not found',
  })
  async delete(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.webhookService.delete(
      sessionId,
      id,
    );
  }
}


