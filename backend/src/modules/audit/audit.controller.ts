




import {
  Controller,
  Get,
  Query,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiQuery,
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
  CurrentApiKey,
} from '../auth/decorators/auth.decorators';
import type {
  ApiKey,
} from '../auth/entities/api-key.entity';

import { SessionTenantAccessService } from '../access-control/session-tenant-access.service';

import {
  AuditService,
  type AuditQueryOptions,
} from './audit.service';
import {
  AuditListResponseDto,
} from './dto/audit-response.dto';
import { toAuditLogResponse } from './dto/audit-response.mapper';
import {
  AuditAction,
  AuditSeverity,
} from './entities/audit-log.entity';

@ApiTags('audit')
@Controller('audit')
@RequireCapability(ApiCapability.AUDIT_READ)
export class AuditController {
  constructor(
    private readonly auditService: AuditService,
    private readonly tenantAccess: SessionTenantAccessService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List audit logs with optional filters',
    description:
      'Requires AUDIT_READ. Results are restricted to the caller\'s effective historical session scope.',
  })
  @ApiQuery({
    name: 'action',
    required: false,
    enum: AuditAction,
  })
  @ApiQuery({
    name: 'severity',
    required: false,
    enum: AuditSeverity,
  })
  @ApiQuery({
    name: 'sessionId',
    required: false,
  })
  @ApiQuery({
    name: 'apiKeyId',
    required: false,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of audit logs.',
    type: AuditListResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not have AUDIT_READ.',
  })
  async findAll(
    @CurrentApiKey()
    apiKey?: ApiKey,

    @Query('action')
    action?: AuditAction,

    @Query('severity')
    severity?: AuditSeverity,

    @Query('sessionId')
    sessionId?: string,

    @Query('apiKeyId')
    apiKeyId?: string,

    @Query('limit')
    limit?: string,

    @Query('offset')
    offset?: string,
  ): Promise<AuditListResponseDto> {
    const options: AuditQueryOptions = {};

    if (action) {
      options.action = action;
    }

    if (severity) {
      options.severity = severity;
    }

    if (sessionId) {
      options.sessionId = sessionId;
    }

    if (apiKeyId) {
      options.apiKeyId = apiKeyId;
    }

    if (limit !== undefined) {
      const parsedLimit = Number.parseInt(limit, 10);

      if (Number.isFinite(parsedLimit)) {
        options.limit = parsedLimit;
      }
    }

    if (offset !== undefined) {
      const parsedOffset = Number.parseInt(offset, 10);

      if (Number.isFinite(parsedOffset)) {
        options.offset = parsedOffset;
      }
    }

    // No client-supplied `allowedSessions`: derive the complete effective
    // tenant scope, including Team Leader ownership and Agent assignments.
    if (!apiKey) {
      throw new ForbiddenException('An authenticated API key is required');
    }
    const scope = await this.tenantAccess.getHistoricalSessionQueryScope(apiKey);
    const result = await this.auditService.findAll(options, scope);
    return {
      data: result.data.map(toAuditLogResponse),
      total: result.total,
    };
  }
}




