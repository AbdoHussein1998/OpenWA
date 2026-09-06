





import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DeleteQueryBuilder,
  EntityManager,
  QueryDeepPartialEntity,
  Repository,
  UpdateQueryBuilder,
} from 'typeorm';
import { randomBytes } from 'crypto';

import { ipMatches } from '../../common/utils/ip';
import { createLogger } from '../../common/services/logger.service';

import { hashApiKey } from './api-key-hash';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { CreateApiKeyDto, UpdateApiKeyDto } from './dto';
import {
  readBootstrapKey,
  removeBootstrapKey,
  writeBootstrapKey,
} from './bootstrap-key-file';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { ApiCapability } from './capabilities/api-capability';

import {
  EventsGateway,
  type ApiKeyEvictionReason,
} from '../events/events.gateway';

/**
 * Resolves the API key to seed on first boot (when no keys exist yet).
 *
 * Precedence:
 *
 * 1. API_MASTER_KEY
 * 2. Explicit ALLOW_DEV_API_KEY=true
 * 3. Secure random generated key
 */
export function resolveSeedApiKey(): string {
  if (process.env.API_MASTER_KEY) {
    return process.env.API_MASTER_KEY;
  }

  if (process.env.ALLOW_DEV_API_KEY === 'true') {
    return 'dev-admin-key';
  }

  return `owa_k1_${randomBytes(32).toString('hex')}`;
}

/**
 * The line printed for the API key in the startup banner.
 *
 * The complete plaintext API key is shown only when it has just been
 * created. On later boots only a short fingerprint is displayed.
 */
export function bannerKeyLine(
  displayKey: string,
  isNewKey: boolean,
): string {
  if (isNewKey) {
    return displayKey;
  }

  if (displayKey.startsWith('(')) {
    return displayKey;
  }

  return `${displayKey.slice(
    0,
    8,
  )}… (full key in data/.api-key or the dashboard)`;
}

/**
 * Compatibility authorization for legacy @RequireRole(...) routes.
 *
 * Do not infer privilege from enum ordering.
 *
 * New authorization-sensitive routes should prefer ApiCapability.
 */
const ROLE_PERMISSIONS: Readonly<
  Record<ApiKeyRole, ReadonlySet<ApiKeyRole>>
> = {
  [ApiKeyRole.ADMIN]: new Set([
    ApiKeyRole.ADMIN,
    ApiKeyRole.OPERATOR,
    ApiKeyRole.VIEWER,
  ]),

  [ApiKeyRole.OPERATOR]: new Set([
    ApiKeyRole.OPERATOR,
    ApiKeyRole.VIEWER,
  ]),

  [ApiKeyRole.VIEWER]: new Set([
    ApiKeyRole.VIEWER,
  ]),

  /**
   * Team Leaders retain compatibility with legacy routes that still
   * require OPERATOR while those routes are progressively converted
   * to explicit capabilities.
   *
   * Session tenancy is enforced separately.
   */
  [ApiKeyRole.TEAM_LEADER]: new Set([
    ApiKeyRole.OPERATOR,
    ApiKeyRole.VIEWER,
  ]),

  /**
   * Agents deliberately do NOT inherit OPERATOR.
   *
   * Agent-approved message/chat write routes must use explicit
   * capabilities instead of @RequireRole(OPERATOR).
   */
  [ApiKeyRole.AGENT]: new Set([
    ApiKeyRole.VIEWER,
  ]),
};

/**
 * Fine-grained capabilities answer:
 *
 *     WHAT may this authenticated principal do?
 *
 * They deliberately do NOT answer:
 *
 *     WHERE may this principal do it?
 *
 * Session/tenant authorization belongs to SessionTenantAccessService.
 */
const ROLE_CAPABILITIES: Readonly<
  Record<ApiKeyRole, ReadonlySet<ApiCapability>>
> = {
  [ApiKeyRole.ADMIN]: new Set([
    ApiCapability.SESSION_READ,
    ApiCapability.SESSION_CREATE,
    ApiCapability.SESSION_MANAGE,
    ApiCapability.SESSION_CONFIGURE,

    ApiCapability.CHAT_READ,
    ApiCapability.CHAT_OPERATE,

    ApiCapability.MESSAGE_SEND,
    ApiCapability.MESSAGE_OPERATE,
    ApiCapability.MESSAGE_BULK,

    ApiCapability.WEBHOOK_MANAGE,
    ApiCapability.TEMPLATE_MANAGE,
    ApiCapability.SEARCH_MESSAGES,

    ApiCapability.TEAM_MANAGE,

    ApiCapability.API_KEY_MANAGE,
    ApiCapability.AUDIT_READ,
    ApiCapability.INFRA_MANAGE,
    ApiCapability.PLUGIN_MANAGE,
  ]),

  [ApiKeyRole.OPERATOR]: new Set([
    ApiCapability.SESSION_READ,
    ApiCapability.SESSION_CREATE,
    ApiCapability.SESSION_MANAGE,
    ApiCapability.SESSION_CONFIGURE,

    ApiCapability.CHAT_READ,
    ApiCapability.CHAT_OPERATE,

    ApiCapability.MESSAGE_SEND,
    ApiCapability.MESSAGE_OPERATE,
    ApiCapability.MESSAGE_BULK,

    ApiCapability.WEBHOOK_MANAGE,
    ApiCapability.TEMPLATE_MANAGE,
    ApiCapability.SEARCH_MESSAGES,
  ]),

  [ApiKeyRole.VIEWER]: new Set([
    ApiCapability.SESSION_READ,
    ApiCapability.CHAT_READ,
  ]),

  [ApiKeyRole.TEAM_LEADER]: new Set([
    ApiCapability.SESSION_READ,
    ApiCapability.SESSION_CREATE,
    ApiCapability.SESSION_MANAGE,
    ApiCapability.SESSION_CONFIGURE,

    ApiCapability.CHAT_READ,
    ApiCapability.CHAT_OPERATE,

    ApiCapability.MESSAGE_SEND,
    ApiCapability.MESSAGE_OPERATE,

    ApiCapability.WEBHOOK_MANAGE,
    ApiCapability.TEMPLATE_MANAGE,
    ApiCapability.SEARCH_MESSAGES,

    ApiCapability.TEAM_MANAGE,
  ]),

  [ApiKeyRole.AGENT]: new Set([
    ApiCapability.SESSION_READ,

    ApiCapability.CHAT_READ,
    ApiCapability.CHAT_OPERATE,

    ApiCapability.MESSAGE_SEND,
    ApiCapability.MESSAGE_OPERATE,
  ]),
};

@Injectable()
export class AuthService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = createLogger('AuthService');

  constructor(
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeyRepository: Repository<ApiKey>,
    private readonly usageTracker: ApiKeyUsageTracker,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onModuleInit(): Promise<void> {
    const count =
      await this.apiKeyRepository.count();

    let displayKey: string;
    let isNewKey = false;

    if (count === 0) {
      displayKey =
        resolveSeedApiKey();

      await this.seedApiKey(
        displayKey,
        'Default Admin Key',
        ApiKeyRole.ADMIN,
      );

      isNewKey = true;

      try {
        writeBootstrapKey(displayKey);
      } catch (err) {
        this.logger.warn(
          'Could not save API key file',
          {
            error: String(err),
          },
        );
      }
    } else {
      displayKey =
        (await this.readLiveBootstrapKey()) ??
        '(check dashboard for keys)';
    }

    const apiBaseUrl =
      process.env.BASE_URL ||
      `http://localhost:${
        process.env.PORT || 2785
      }`;

    const dashboardUrl =
      process.env.DASHBOARD_URL ||
      apiBaseUrl;

    this.logger.log('');
    this.logger.log(
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    );
    this.logger.log('');
    this.logger.log(
      '  🟢 Welcome to OpenWA - WhatsApp API Gateway',
    );
    this.logger.log('');
    this.logger.log(
      `  📊 Dashboard: ${dashboardUrl}`,
    );
    this.logger.log(
      `  📚 API Docs:  ${apiBaseUrl}/api/docs`,
    );
    this.logger.log('');

    if (isNewKey) {
      this.logger.log(
        '  🔑 API Key (newly created):',
      );
    } else {
      this.logger.log('  🔑 API Key:');
    }

    this.logger.log(
      `     ${bannerKeyLine(
        displayKey,
        isNewKey,
      )}`,
    );

    this.logger.log('');
    this.logger.log(
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    );
    this.logger.log('');
  }

  /**
   * Flush usage counters before the database connection closes.
   */
  async onModuleDestroy(): Promise<void> {
    await this.usageTracker.flushOnShutdown();
  }

  /**
   * Read the bootstrap key only while it still resolves to a live key.
   *
   * A stale bootstrap file is removed automatically.
   */
  private async readLiveBootstrapKey(): Promise<string | null> {
    const rawKey =
      readBootstrapKey(this.logger);

    if (!rawKey) {
      return null;
    }

    const stored =
      await this.apiKeyRepository.findOne({
        where: {
          keyHash: this.hashKey(rawKey),
        },
      });

    const live = Boolean(
      stored &&
        stored.isActive &&
        (!stored.expiresAt ||
          stored.expiresAt > new Date()),
    );

    if (live) {
      return rawKey;
    }

    if (!stored) {
      /**
       * A key-hash miss does not necessarily mean the key row disappeared.
       *
       * API_KEY_PEPPER may have changed since the key was created.
       */
      const byPrefix =
        await this.apiKeyRepository.findOne({
          where: {
            keyPrefix:
              rawKey.substring(0, 12),
          },
        });

      if (byPrefix) {
        this.logger.warn(
          'Bootstrap API key file does not match any stored key hash — API_KEY_PEPPER changed since the key was seeded? The key itself is still live, so the file is kept; restore the original pepper or rotate the key to repair.',
          {
            keyPrefix:
              byPrefix.keyPrefix,
            action:
              'bootstrap_key_pepper_mismatch',
          },
        );

        return null;
      }
    }

    removeBootstrapKey(
      'it no longer resolves to an active key',
      this.logger,
    );

    return null;
  }

  /**
   * Remove the bootstrap key file if it contains the API key that
   * has just been revoked or deleted.
   */
  private removeBootstrapKeyFileIfMatching(
    apiKey: ApiKey,
  ): void {
    const fileKey =
      readBootstrapKey(this.logger);

    if (
      !fileKey ||
      this.hashKey(fileKey) !== apiKey.keyHash
    ) {
      return;
    }

    removeBootstrapKey(
      'its key was revoked or deleted',
      this.logger,
    );
  }

  private async seedApiKey(
    rawKey: string,
    name: string,
    role: ApiKeyRole,
  ): Promise<ApiKey> {
    const keyHash =
      this.hashKey(rawKey);

    const keyPrefix =
      rawKey.substring(0, 12);

    const apiKey =
      this.apiKeyRepository.create({
        name,
        keyHash,
        keyPrefix,
        role,
      });

    return this.apiKeyRepository.save(
      apiKey,
    );
  }

  /**
   * Whether a role belongs to a management principal.
   */
  private isManagementRole(
    role: ApiKeyRole,
  ): boolean {
    return (
      role ===
        ApiKeyRole.TEAM_LEADER ||
      role ===
        ApiKeyRole.AGENT
    );
  }

  /**
   * A management credential is identified fail-closed.
   *
   * Normally the role and principal binding agree:
   *
   * TEAM_LEADER:
   *   role = TEAM_LEADER
   *   teamLeaderId != null
   *   agentId == null
   *
   * AGENT:
   *   role = AGENT
   *   agentId != null
   *   teamLeaderId == null
   *
   * Checking principal bindings as well as role prevents generic key
   * management from changing the role of a malformed stored row that still
   * points at a management principal.
   */
  private isManagementCredential(
    apiKey: Pick<
      ApiKey,
      'role' | 'teamLeaderId' | 'agentId'
    >,
  ): boolean {
    return (
      this.isManagementRole(
        apiKey.role,
      ) ||
      Boolean(
        apiKey.teamLeaderId,
      ) ||
      Boolean(
        apiKey.agentId,
      )
    );
  }

  /**
   * Generic /auth/api-keys management may only create or assign legacy
   * ADMIN / OPERATOR / VIEWER roles.
   */
  private assertGenericApiKeyRole(
    role: ApiKeyRole,
  ): void {
    if (
      this.isManagementRole(
        role,
      )
    ) {
      throw new BadRequestException(
        'Team Leader and Agent API keys must be managed through principal management',
      );
    }
  }

  /**
   * Generic API-key creation.
   *
   * TEAM_LEADER and AGENT credentials are intentionally excluded.
   * Those identities must be provisioned atomically alongside their
   * principal rows by TeamLeaderService.
   */
  async createApiKey(
    dto: CreateApiKeyDto,
  ): Promise<{
    apiKey: ApiKey;
    rawKey: string;
  }> {
    const requestedRole =
      dto.role ?? ApiKeyRole.OPERATOR;

    /**
     * DTO validation rejects management roles, but the service is the
     * authoritative security boundary and must also fail closed for direct
     * callers.
     */
    this.assertGenericApiKeyRole(
      requestedRole,
    );

    const rawKey =
      `owa_k1_${randomBytes(
        32,
      ).toString('hex')}`;

    const keyHash =
      this.hashKey(rawKey);

    const keyPrefix =
      rawKey.substring(0, 12);

    const apiKey =
      this.apiKeyRepository.create({
        name: dto.name,
        keyHash,
        keyPrefix,
        role: requestedRole,

        allowedIps:
          dto.allowedIps || null,

        allowedSessions:
          dto.allowedSessions || null,

        expiresAt:
          dto.expiresAt
            ? new Date(dto.expiresAt)
            : null,
      });

    const saved =
      await this.apiKeyRepository.save(
        apiKey,
      );

    this.logger.log(
      `API key created: ${saved.name}`,
      {
        keyId: saved.id,
        role: saved.role,
        action:
          'api_key_created',
      },
    );

    return {
      apiKey: saved,
      rawKey,
    };
  }

  /**
   * Internal credential provisioning for management principals.
   *
   * TeamLeaderService calls this while already inside a transaction
   * on the main database so principal + credential creation is atomic.
   *
   * Do not expose this through generic API-key management.
   */
  async createApiKeyInTransaction(
    manager: EntityManager,
    input: {
      name: string;

      role:
        | ApiKeyRole.TEAM_LEADER
        | ApiKeyRole.AGENT;

      teamLeaderId?:
        | string
        | null;

      agentId?:
        | string
        | null;

      allowedIps?:
        | string[]
        | null;

      allowedSessions?:
        | string[]
        | null;

      expiresAt?:
        | Date
        | null;
    },
  ): Promise<{
    apiKey: ApiKey;
    rawKey: string;
  }> {
    this.assertManagementPrincipalBinding(
      input,
    );

    const rawKey =
      `owa_k1_${randomBytes(
        32,
      ).toString('hex')}`;

    const repository =
      manager.getRepository(ApiKey);

    const apiKey =
      repository.create({
        name: input.name,

        keyHash:
          this.hashKey(rawKey),

        keyPrefix:
          rawKey.substring(0, 12),

        role:
          input.role,

        teamLeaderId:
          input.teamLeaderId ??
          null,

        agentId:
          input.agentId ??
          null,

        allowedIps:
          input.allowedIps ??
          null,

        allowedSessions:
          input.allowedSessions ??
          null,

        expiresAt:
          input.expiresAt ??
          null,
      });

    const saved =
      await repository.save(apiKey);

    return {
      apiKey: saved,
      rawKey,
    };
  }

  async findAll(): Promise<ApiKey[]> {
    return this.apiKeyRepository.find({
      order: {
        createdAt: 'DESC',
      },
    });
  }

  async findOne(
    id: string,
  ): Promise<ApiKey> {
    const apiKey =
      await this.apiKeyRepository.findOne({
        where: {
          id,
        },
      });

    if (!apiKey) {
      throw new NotFoundException(
        `API key with id '${id}' not found`,
      );
    }

    return apiKey;
  }

  async update(
    id: string,
    dto: UpdateApiKeyDto,
  ): Promise<ApiKey> {
    const apiKey =
      await this.findOne(id);

    /**
     * Generic API-key management may never assign a management role.
     *
     * DTO validation already rejects this, but the service remains the
     * authoritative security boundary.
     *
     * Existing principal-bound credentials also cannot be converted into
     * legacy identities through generic key management.
     */
    if (
      dto.role !== undefined
    ) {
      this.assertGenericApiKeyRole(
        dto.role,
      );

      if (
        this.isManagementCredential(
          apiKey,
        )
      ) {
        throw new BadRequestException(
          'Management identity API-key roles cannot be changed through generic API-key management',
        );
      }
    }

    /**
     * Scoping, expiring or demoting the last unscoped ADMIN removes
     * its ability to manage keys, which can permanently lock out key
     * administration.
     */
    const removesOrSchedulesLastAdmin =
      (
        dto.role !== undefined &&
        dto.role !==
          ApiKeyRole.ADMIN
      ) ||
      (
        dto.expiresAt !== undefined &&
        dto.expiresAt !== null
      ) ||
      (
        dto.allowedSessions !==
          undefined &&
        dto.allowedSessions.length > 0
      );

    /**
     * Authorization-relevant fields before modification.
     *
     * If these change, already authenticated WebSocket connections
     * must be evicted so they cannot retain stale authorization.
     */
    const before = {
      role:
        apiKey.role,

      allowedIps:
        apiKey.allowedIps,

      allowedSessions:
        apiKey.allowedSessions,

      expiresAt:
        apiKey.expiresAt,
    };

    const patch:
      QueryDeepPartialEntity<ApiKey> =
      {};

    if (dto.name) {
      patch.name =
        dto.name;
    }

    if (dto.role) {
      patch.role =
        dto.role;
    }

    if (
      dto.allowedIps !== undefined
    ) {
      patch.allowedIps =
        dto.allowedIps;
    }

    if (
      dto.allowedSessions !==
      undefined
    ) {
      patch.allowedSessions =
        dto.allowedSessions;
    }

    if (
      dto.expiresAt !== undefined
    ) {
      patch.expiresAt =
        dto.expiresAt
          ? new Date(
              dto.expiresAt,
            )
          : null;
    }

    let saved: ApiKey;

    if (
      removesOrSchedulesLastAdmin &&
      apiKey.role ===
        ApiKeyRole.ADMIN
    ) {
      const result =
        await this.withLastAdminGuard(
          this.apiKeyRepository
            .createQueryBuilder()
            .update(ApiKey)
            .set(patch),
          id,
        ).execute();

      await this.assertMutationApplied(
        id,
        result.affected,
      );

      saved =
        await this.findOne(id);
    } else {
      await this.applyUnguardedUpdate(
        patch,
        id,
      );

      saved =
        await this.findOne(id);
    }

    /**
     * allowedIps / allowedSessions are sets for authorization purposes.
     * Reordering them must not count as an authorization change.
     */
    const ordered = (
      value: string[] | null,
    ): string[] | null =>
      value
        ? [...value].sort()
        : value;

    const authzChanged =
      saved.role !==
        before.role ||
      saved.expiresAt?.getTime() !==
        before.expiresAt?.getTime() ||
      JSON.stringify(
        ordered(
          saved.allowedIps,
        ),
      ) !==
        JSON.stringify(
          ordered(
            before.allowedIps,
          ),
        ) ||
      JSON.stringify(
        ordered(
          saved.allowedSessions,
        ),
      ) !==
        JSON.stringify(
          ordered(
            before.allowedSessions,
          ),
        );

    if (authzChanged) {
      this.evictActiveSockets(
        id,
        'authorization_changed',
      );
    }

    return saved;
  }

  async delete(
    id: string,
  ): Promise<void> {
    const apiKey =
      await this.findOne(id);

    if (
      apiKey.role ===
      ApiKeyRole.ADMIN
    ) {
      const result =
        await this.withLastAdminGuard(
          this.apiKeyRepository
            .createQueryBuilder()
            .delete()
            .from(ApiKey),
          id,
        ).execute();

      await this.assertMutationApplied(
        id,
        result.affected,
      );
    } else {
      await this.apiKeyRepository.remove(
        apiKey,
      );
    }

    this.usageTracker.forget(id);

    this.removeBootstrapKeyFileIfMatching(
      apiKey,
    );

    this.evictActiveSockets(
      id,
      'deleted',
    );

    this.logger.log(
      `API key deleted: ${apiKey.name}`,
      {
        keyId: id,
        action:
          'api_key_deleted',
      },
    );
  }

  async revoke(
    id: string,
  ): Promise<ApiKey> {
    const apiKey =
      await this.findOne(id);

    let saved: ApiKey;

    if (
      apiKey.role ===
      ApiKeyRole.ADMIN
    ) {
      const result =
        await this.withLastAdminGuard(
          this.apiKeyRepository
            .createQueryBuilder()
            .update(ApiKey)
            .set({
              isActive: false,
            }),
          id,
        ).execute();

      await this.assertMutationApplied(
        id,
        result.affected,
      );

      saved =
        await this.findOne(id);
    } else {
      await this.applyUnguardedUpdate(
        {
          isActive: false,
        },
        id,
      );

      saved =
        await this.findOne(id);
    }

    this.usageTracker.forget(id);

    this.removeBootstrapKeyFileIfMatching(
      apiKey,
    );

    this.evictActiveSockets(
      id,
      'revoked',
    );

    return saved;
  }

  /**
   * SQL predicate defining a usable administrative key.
   *
   * A usable admin:
   *
   * - has ADMIN role
   * - is active
   * - is unexpired
   * - is not session-scoped
   *
   * Session-scoped admins cannot manage API-key lifecycle because those
   * routes require an unscoped key.
   */
  private static usableAdminCondition(
    prefix: string,
  ): string {
    const col = (
      name: string,
    ) =>
      prefix
        ? `"${prefix}"."${name}"`
        : `"${name}"`;

    return (
      `${col(
        'role',
      )} = :adminRole AND ` +
      `${col(
        'isActive',
      )} = 1 AND ` +
      `(${col(
        'expiresAt',
      )} IS NULL OR ${col(
        'expiresAt',
      )} > :guardNow) AND ` +
      `(${col(
        'allowedSessions',
      )} = '' OR ${col(
        'allowedSessions',
      )} IS NULL)`
    );
  }

  /**
   * SQLite-compatible UTC datetime matching TypeORM's stored datetime
   * representation.
   */
  private static guardNowParam(): string {
    return new Date()
      .toISOString()
      .slice(0, 23)
      .replace(
        'T',
        ' ',
      );
  }

  /**
   * Protect UPDATE/DELETE of an ADMIN key so the last usable admin
   * cannot be removed.
   *
   * The invariant is enforced by the database statement itself rather
   * than a read-then-write check, avoiding races between processes.
   */
  private withLastAdminGuard<
    T extends
      | UpdateQueryBuilder<ApiKey>
      | DeleteQueryBuilder<ApiKey>,
  >(
    qb: T,
    id: string,
  ): T {
    return qb
      .where(
        '"id" = :id',
        {
          id,
        },
      )
      .andWhere(
        `(NOT (${AuthService.usableAdminCondition(
          '',
        )}) OR EXISTS (` +
          `SELECT 1 FROM "api_keys" "other" ` +
          `WHERE "other"."id" <> :id AND ` +
          `${AuthService.usableAdminCondition(
            'other',
          )}))`,
      )
      .setParameters({
        adminRole:
          ApiKeyRole.ADMIN,

        guardNow:
          AuthService.guardNowParam(),
      }) as T;
  }

  /**
   * Determine whether a guarded mutation failed because it was blocked
   * by the last-admin invariant or because the target disappeared.
   */
  private async assertMutationApplied(
    id: string,
    affected:
      | number
      | null
      | undefined,
  ): Promise<void> {
    if (affected) {
      return;
    }

    await this.findOne(id);

    throw new ConflictException(
      'Cannot remove the last active admin key',
    );
  }

  /**
   * Apply an update that does not require last-admin protection.
   */
  private async applyUnguardedUpdate(
    patch:
      QueryDeepPartialEntity<ApiKey>,
    id: string,
  ): Promise<void> {
    const result =
      await this.apiKeyRepository
        .createQueryBuilder()
        .update(ApiKey)
        .set(patch)
        .where(
          '"id" = :id',
          {
            id,
          },
        )
        .execute();

    if (!result.affected) {
      await this.findOne(id);
    }
  }

  /**
   * Disconnect every WebSocket authenticated by the specified API key.
   *
   * EventsGateway is resolved lazily so AuthModule and EventsModule do
   * not need a static circular dependency.
   *
   * This is best effort. Database authorization remains authoritative,
   * while socket eviction prevents already authenticated connections
   * from retaining stale authorization state.
   */
  private evictActiveSockets(
    keyId: string,
    reason:
      ApiKeyEvictionReason =
        'revoked',
  ): void {
    try {
      const gateway =
        this.moduleRef.get(
          EventsGateway,
          {
            strict: false,
          },
        );

      if (gateway) {
        gateway.evictApiKey(
          keyId,
          reason,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to evict WebSocket sockets for key ${keyId}`,
        {
          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
      );
    }
  }

  /**
   * Enforce the invariant between management roles and their principal
   * bindings.
   *
   * TEAM_LEADER:
   *   teamLeaderId != null
   *   agentId == null
   *
   * AGENT:
   *   agentId != null
   *   teamLeaderId == null
   */
  private assertManagementPrincipalBinding(
    input: {
      role: ApiKeyRole;

      teamLeaderId?:
        | string
        | null;

      agentId?:
        | string
        | null;
    },
  ): void {
    /**
     * Compile-time narrowing on createApiKeyInTransaction() is useful, but
     * this method is also a runtime security boundary. Reject unexpected
     * enum values explicitly rather than treating every non-TEAM_LEADER
     * value as AGENT.
     */
    if (
      !this.isManagementRole(
        input.role,
      )
    ) {
      throw new BadRequestException(
        'Management principal API-key provisioning requires TEAM_LEADER or AGENT role',
      );
    }

    if (
      input.role ===
      ApiKeyRole.TEAM_LEADER
    ) {
      if (
        !input.teamLeaderId ||
        input.agentId
      ) {
        throw new BadRequestException(
          'TEAM_LEADER API key requires teamLeaderId and must not contain agentId',
        );
      }

      return;
    }

    /**
     * The only remaining valid management role is AGENT.
     */
    if (
      !input.agentId ||
      input.teamLeaderId
    ) {
      throw new BadRequestException(
        'AGENT API key requires agentId and must not contain teamLeaderId',
      );
    }
  }

  /**
   * Authenticate an API key.
   *
   * IMPORTANT:
   *
   * This method validates CREDENTIAL concerns only:
   *
   * - key exists
   * - key is active
   * - key is not expired
   * - client IP is allowed
   *
   * It deliberately does NOT perform session/tenant authorization.
   *
   * Session authorization must be performed separately through
   * SessionTenantAccessService.
   *
   * This separation is critical because effective session access is:
   *
   *     tenant scope
   *         INTERSECT
   *     allowedSessions when non-empty
   *
   * and Team Leader / Agent ownership rules must be evaluated together.
   */
  async validateApiKey(
    rawKey: string,
    clientIp?: string,
  ): Promise<ApiKey> {
    /**
     * Normalize whitespace consistently across REST, WebSocket and MCP.
     */
    const normalizedKey =
      rawKey?.trim();

    if (!normalizedKey) {
      throw new UnauthorizedException(
        'Invalid API key',
      );
    }

    const keyHash =
      this.hashKey(
        normalizedKey,
      );

    const apiKey =
      await this.apiKeyRepository.findOne({
        where: {
          keyHash,
        },
      });

    if (!apiKey) {
      throw new UnauthorizedException(
        'Invalid API key',
      );
    }

    if (!apiKey.isActive) {
      throw new UnauthorizedException(
        'API key is revoked',
      );
    }

    if (
      apiKey.expiresAt &&
      apiKey.expiresAt <
        new Date()
    ) {
      throw new UnauthorizedException(
        'API key has expired',
      );
    }

    /**
     * Fail closed when an IP whitelist exists but no client IP could
     * be resolved.
     */
    if (
      apiKey.allowedIps &&
      apiKey.allowedIps.length > 0
    ) {
      if (!clientIp) {
        throw new UnauthorizedException(
          'Client IP could not be determined',
        );
      }

      if (
        !this.isIpAllowed(
          clientIp,
          apiKey.allowedIps,
        )
      ) {
        this.logger.warn(
          `IP not allowed: ${clientIp}`,
          {
            keyId:
              apiKey.id,

            action:
              'ip_rejected',
          },
        );

        throw new UnauthorizedException(
          'IP address not allowed',
        );
      }
    }

    /**
     * DO NOT check allowedSessions here.
     *
     * allowedSessions is an authorization ceiling and belongs to
     * SessionTenantAccessService together with ownership / assignment
     * checks.
     */

    await this.usageTracker.record(
      apiKey,
    );

    return apiKey;
  }

  private hashKey(
    rawKey: string,
  ): string {
    return hashApiKey(
      rawKey,
      process.env.API_KEY_PEPPER,
    );
  }

  private isIpAllowed(
    clientIp: string,
    allowedIps: string[],
  ): boolean {
    return allowedIps.some(
      entry =>
        ipMatches(
          clientIp,
          entry,
        ),
    );
  }

  /**
   * Compatibility authorization for existing @RequireRole routes.
   *
   * Do not infer privileges using numeric/enum ordering.
   */
  hasPermission(
    apiKey: ApiKey,
    requiredRole: ApiKeyRole,
  ): boolean {
    return (
      ROLE_PERMISSIONS[
        apiKey.role
      ]?.has(
        requiredRole,
      ) ?? false
    );
  }

  /**
   * Fine-grained capability authorization.
   *
   * Answers WHAT the principal may do.
   *
   * SessionTenantAccessService answers WHERE the principal may do it.
   */
  hasCapability(
    apiKey: ApiKey,
    capability: ApiCapability,
  ): boolean {
    return (
      ROLE_CAPABILITIES[
        apiKey.role
      ]?.has(
        capability,
      ) ?? false
    );
  }
}






