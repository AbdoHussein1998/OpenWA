




import {
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

import {
  AuditService,
  type AuditQueryOptions,
} from './audit.service';
import {
  AuditListResponseDto,
} from './dto/audit-response.dto';
import {
  AuditAction,
  type AuditLog,
  AuditSeverity,
} from './entities/audit-log.entity';

@ApiTags('audit')
@Controller('audit')
@RequireCapability(ApiCapability.AUDIT_READ)
export class AuditController {
  constructor(
    private readonly auditService: AuditService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List audit logs with optional filters',
    description:
      'Requires AUDIT_READ. If the calling API key is session-scoped, results remain limited to that key\'s allowed Sessions.',
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
  ): Promise<{
    data: AuditLog[];
    total: number;
  }> {
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

    /*
     * allowedSessions remains authoritative for scoped administrative keys.
     * AuditService intersects this ceiling with an optional sessionId query,
     * preventing a scoped ADMIN/OPERATOR credential from reading another
     * tenant's audit rows through a query-string filter.
     */
    return this.auditService.findAll(
      options,
      apiKey?.allowedSessions,
    );
  }
}




