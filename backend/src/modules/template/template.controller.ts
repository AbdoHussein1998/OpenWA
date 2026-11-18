

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
  CreateTemplateDto,
  TemplateResponseDto,
  UpdateTemplateDto,
} from './dto';
import { Template } from './entities/template.entity';
import { TemplateService } from './template.service';

@ApiTags('templates')
@Controller('sessions/:sessionId/templates')
export class TemplateController {
  constructor(
    private readonly templateService: TemplateService,
  ) {}

  @Post()
  @RequireCapability(ApiCapability.TEMPLATE_MANAGE)
  @ApiOperation({
    summary: 'Create a message template for the session',
  })
  @ApiParam({
    name: 'sessionId',
    description: 'Session ID',
  })
  @ApiResponse({
    status: 201,
    description: 'Template created',
    type: TemplateResponseDto,
  })
  @ApiResponse({
    status: 409,
    description:
      'A template with that name already exists for the session',
  })
  async create(
    @Param('sessionId') sessionId: string,
    @Body() dto: CreateTemplateDto,
  ): Promise<Template> {
    return this.templateService.create(
      sessionId,
      dto,
    );
  }

  @Get()
  @RequireCapability(ApiCapability.TEMPLATE_READ)
  @ApiOperation({
    summary: 'List all templates for a session',
  })
  @ApiParam({
    name: 'sessionId',
    description: 'Session ID',
  })
  @ApiResponse({
    status: 200,
    description: 'List of templates',
    type: [TemplateResponseDto],
  })
  async findBySession(
    @Param('sessionId') sessionId: string,
  ): Promise<Template[]> {
    return this.templateService.findBySession(
      sessionId,
    );
  }

  @Get(':id')
  @RequireCapability(ApiCapability.TEMPLATE_READ)
  @ApiOperation({
    summary: 'Get a template by ID',
  })
  @ApiParam({
    name: 'sessionId',
    description: 'Session ID',
  })
  @ApiParam({
    name: 'id',
    description: 'Template ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Template details',
    type: TemplateResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Template not found',
  })
  async findOne(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
  ): Promise<Template> {
    return this.templateService.findOne(
      sessionId,
      id,
    );
  }

  @Put(':id')
  @RequireCapability(ApiCapability.TEMPLATE_MANAGE)
  @ApiOperation({
    summary: 'Update a template',
  })
  @ApiParam({
    name: 'sessionId',
    description: 'Session ID',
  })
  @ApiParam({
    name: 'id',
    description: 'Template ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Template updated',
    type: TemplateResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Template not found',
  })
  @ApiResponse({
    status: 409,
    description:
      'A template with that name already exists for the session',
  })
  async update(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
    @Body() dto: UpdateTemplateDto,
  ): Promise<Template> {
    return this.templateService.update(
      sessionId,
      id,
      dto,
    );
  }

  @Delete(':id')
  @RequireCapability(ApiCapability.TEMPLATE_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a template',
  })
  @ApiParam({
    name: 'sessionId',
    description: 'Session ID',
  })
  @ApiParam({
    name: 'id',
    description: 'Template ID',
  })
  @ApiResponse({
    status: 204,
    description: 'Template deleted',
  })
  @ApiResponse({
    status: 404,
    description: 'Template not found',
  })
  async delete(
    @Param('sessionId') sessionId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.templateService.delete(
      sessionId,
      id,
    );
  }
}


