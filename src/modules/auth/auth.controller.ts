


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
  Req,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';

import { AuthService } from './auth.service';
import {
  CurrentApiKey,
  RequireRole,
  RequireUnscopedKey,
} from './decorators/auth.decorators';
import {
  ApiKeyCreatedResponseDto,
  ApiKeyResponseDto,
  CreateApiKeyDto,
  UpdateApiKeyDto,
} from './dto';
import {
  type ApiKey,
  ApiKeyRole,
} from './entities/api-key.entity';

@ApiTags('auth')
@Controller('auth/api-keys')
// Key lifecycle routes have no session dimension, so a session-scoped ADMIN
// key could otherwise escape its confinement here (for example by minting an
// unrestricted key or widening another key's allowedSessions).
@RequireUnscopedKey()
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Build the request-context block for an API-key lifecycle audit entry.
   */
  private auditContext(
    req: Request,
    actor?: ApiKey,
  ): {
    apiKey?: ApiKey;
    ipAddress?: string;
    method?: string;
    path?: string;
  } {
    return {
      apiKey: actor,
      ipAddress:
        (
          req as Request & {
            clientIp?: string;
          }
        ).clientIp ?? undefined,
      method: req.method,
      path: req.path,
    };
  }

  /**
   * Map the persistence entity to the public API-key response shape.
   *
   * The plaintext key/hash are intentionally never exposed here.
   *
   * Principal binding ids are safe management metadata and allow the
   * Admin UI to navigate Team Leader / Agent lifecycle operations without
   * attempting to infer principal identity from credential names.
   */
  private toResponse(
    apiKey: ApiKey,
  ): ApiKeyResponseDto {
    return {
      id: apiKey.id,
      name: apiKey.name,
      keyPrefix: apiKey.keyPrefix,
      role: apiKey.role,

      teamLeaderId:
        apiKey.teamLeaderId ?? null,

      agentId:
        apiKey.agentId ?? null,

      allowedIps:
        apiKey.allowedIps ?? undefined,

      allowedSessions:
        apiKey.allowedSessions ?? undefined,

      isActive: apiKey.isActive,

      expiresAt:
        apiKey.expiresAt ?? undefined,

      lastUsedAt:
        apiKey.lastUsedAt ?? undefined,

      usageCount:
        apiKey.usageCount,

      createdAt:
        apiKey.createdAt,
    };
  }

  @Post()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({
    summary:
      'Create a new API key (admin only)',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description:
      'API key created',
    type: ApiKeyCreatedResponseDto,
  })
  async create(
    @Body() dto: CreateApiKeyDto,
    @Req() req: Request,
    @CurrentApiKey() actor?: ApiKey,
  ): Promise<ApiKeyCreatedResponseDto> {
    const {
      apiKey,
      rawKey,
    } =
      await this.authService.createApiKey(
        dto,
      );

    await this.auditService.logInfo(
      AuditAction.API_KEY_CREATED,
      {
        ...this.auditContext(
          req,
          actor,
        ),

        metadata: {
          targetKeyId:
            apiKey.id,

          targetKeyName:
            apiKey.name,

          role:
            apiKey.role,
        },
      },
    );

    return {
      ...this.toResponse(
        apiKey,
      ),

      /**
       * The full plaintext credential is returned only on creation.
       *
       * It is never read back from the database.
       */
      apiKey: rawKey,
    };
  }

  @Get()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({
    summary:
      'List all API keys (admin only)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description:
      'All API keys. Plaintext keys are never returned; only keyPrefix is exposed.',
    type: [
      ApiKeyResponseDto,
    ],
  })
  async findAll(): Promise<
    ApiKeyResponseDto[]
  > {
    const keys =
      await this.authService.findAll();

    return keys.map(
      key =>
        this.toResponse(
          key,
        ),
    );
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({
    summary:
      'Get API key details (admin only)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description:
      'API key metadata. Plaintext is never returned; only keyPrefix is exposed.',
    type: ApiKeyResponseDto,
  })
  async findOne(
    @Param('id')
    id: string,
  ): Promise<ApiKeyResponseDto> {
    const apiKey =
      await this.authService.findOne(
        id,
      );

    return this.toResponse(
      apiKey,
    );
  }

  @Put(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({
    summary:
      'Update API key (admin only)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description:
      'The updated API key.',
    type: ApiKeyResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'The change would remove the last usable admin key.',
  })
  async update(
    @Param('id')
    id: string,

    @Body()
    dto: UpdateApiKeyDto,

    @Req()
    req: Request,

    @CurrentApiKey()
    actor?: ApiKey,
  ): Promise<ApiKeyResponseDto> {
    const before =
      await this.authService.findOne(
        id,
      );

    const apiKey =
      await this.authService.update(
        id,
        dto,
      );

    const authzSnapshot = (
      key: ApiKey,
    ) => ({
      role:
        key.role,

      allowedIps:
        key.allowedIps,

      allowedSessions:
        key.allowedSessions,

      expiresAt:
        key.expiresAt,
    });

    await this.auditService.logInfo(
      AuditAction.API_KEY_UPDATED,
      {
        ...this.auditContext(
          req,
          actor,
        ),

        metadata: {
          targetKeyId:
            apiKey.id,

          targetKeyName:
            apiKey.name,

          before:
            authzSnapshot(
              before,
            ),

          after:
            authzSnapshot(
              apiKey,
            ),
        },
      },
    );

    return this.toResponse(
      apiKey,
    );
  }

  /**
   * Reissue an API key in place.
   *
   * AuthService preserves the row id, role, principal bindings,
   * restrictions, active state, expiration, and usage metadata while
   * rotating only keyHash/keyPrefix.
   *
   * The replacement plaintext credential is returned exactly once.
   */
  @Post(':id/reissue')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(
    HttpStatus.OK,
  )
  @ApiOperation({
    summary:
      'Reissue API key (admin only)',
    description:
      'Rotates the credential material for an existing API-key row while preserving its id, role, principal bindings, restrictions, active state, and expiration. The replacement plaintext API key is returned only once.',
  })
  @ApiResponse({
    status:
      HttpStatus.OK,

    description:
      'API key reissued successfully. The plaintext replacement credential is returned only once.',

    type:
      ApiKeyCreatedResponseDto,
  })
  @ApiResponse({
    status:
      HttpStatus.NOT_FOUND,

    description:
      'API key not found.',
  })
  async reissue(
    @Param('id')
    id: string,

    @Req()
    req: Request,

    @CurrentApiKey()
    actor?: ApiKey,
  ): Promise<ApiKeyCreatedResponseDto> {
    const {
      apiKey,
      rawKey,
    } =
      await this.authService.reissueApiKey(
        id,
      );

    /**
     * There is no dedicated API_KEY_REISSUED enum value yet.
     *
     * Record the operation as an API_KEY_UPDATED event and distinguish the
     * credential rotation explicitly in metadata. Never include rawKey.
     */
    await this.auditService.logInfo(
      AuditAction.API_KEY_UPDATED,
      {
        ...this.auditContext(
          req,
          actor,
        ),

        metadata: {
          action:
            'reissue',

          targetKeyId:
            apiKey.id,

          targetKeyName:
            apiKey.name,

          role:
            apiKey.role,

          teamLeaderId:
            apiKey.teamLeaderId,

          agentId:
            apiKey.agentId,
        },
      },
    );

    return {
      ...this.toResponse(
        apiKey,
      ),

      apiKey:
        rawKey,
    };
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(
    HttpStatus.NO_CONTENT,
  )
  @ApiOperation({
    summary:
      'Delete API key (admin only)',
  })
  @ApiResponse({
    status:
      HttpStatus.NO_CONTENT,

    description:
      'API key deleted',
  })
  @ApiResponse({
    status:
      HttpStatus.CONFLICT,

    description:
      'The key is the last usable admin key.',
  })
  async delete(
    @Param('id')
    id: string,

    @Req()
    req: Request,

    @CurrentApiKey()
    actor?: ApiKey,
  ): Promise<void> {
    /**
     * Resolve the target before deletion so its identifying metadata can
     * still be written to the audit record after the row has disappeared.
     */
    const target =
      await this.authService.findOne(
        id,
      );

    await this.authService.delete(
      id,
    );

    await this.auditService.logInfo(
      AuditAction.API_KEY_DELETED,
      {
        ...this.auditContext(
          req,
          actor,
        ),

        metadata: {
          targetKeyId:
            target.id,

          targetKeyName:
            target.name,
        },
      },
    );
  }

  @Post(':id/revoke')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(
    HttpStatus.OK,
  )
  @ApiOperation({
    summary:
      'Revoke API key (admin only)',
  })
  @ApiResponse({
    status:
      HttpStatus.OK,

    description:
      'The revoked API key (isActive is now false).',

    type:
      ApiKeyResponseDto,
  })
  @ApiResponse({
    status:
      HttpStatus.CONFLICT,

    description:
      'The key is the last usable admin key.',
  })
  async revoke(
    @Param('id')
    id: string,

    @Req()
    req: Request,

    @CurrentApiKey()
    actor?: ApiKey,
  ): Promise<ApiKeyResponseDto> {
    const apiKey =
      await this.authService.revoke(
        id,
      );

    await this.auditService.logInfo(
      AuditAction.API_KEY_REVOKED,
      {
        ...this.auditContext(
          req,
          actor,
        ),

        metadata: {
          targetKeyId:
            apiKey.id,

          targetKeyName:
            apiKey.name,
        },
      },
    );

    return this.toResponse(
      apiKey,
    );
  }
}


