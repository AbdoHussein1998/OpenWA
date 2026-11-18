import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { QueryDeepPartialEntity, Repository } from 'typeorm';
import { createLogger } from '../../../common/services/logger.service';
import { ApiKey } from '../entities/api-key.entity';
import { ApiKeyRole } from '../auth.levels.constants';
import type { UpdateApiKeyDto } from '../dto';
import { ApiKeyUsageTracker } from '../api-key-usage-tracker.service';
import { ApiKeyAdminSafetyService } from './api-key-admin-safety.service';
import { ApiKeyRoleRules } from './api-key-role-rules';
import { ApiKeySocketEvictionService } from './api-key-socket-eviction.service';
import { createCredentialMaterial } from './api-key-material';
import { ApiKeyBootstrapService } from '../bootstrap/api-key-bootstrap.service';
import { assertApiKeyManager } from './api-key-management-authorization';

/** Credential metadata and lifecycle operations, excluding creation and authentication. */
@Injectable()
export class ApiKeyManagementService {
  private readonly logger = createLogger('ApiKeyManagementService');
  constructor(
    @InjectRepository(ApiKey, 'main') private readonly apiKeyRepository: Repository<ApiKey>,
    private readonly usageTracker: ApiKeyUsageTracker,
    private readonly adminSafety: ApiKeyAdminSafetyService,
    private readonly bootstrap: ApiKeyBootstrapService,
    private readonly socketEviction: ApiKeySocketEvictionService,
  ) {}
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

  /**
   * Reissue an existing API key in place.
   *
   * The database row itself is preserved so every authorization and
   * principal-binding field remains unchanged:
   *
   * - id
   * - name
   * - role
   * - teamLeaderId / agentId
   * - allowedIps / allowedSessions
   * - isActive
   * - expiresAt
   * - usage metadata
   *
   * Only keyHash and keyPrefix are replaced. The new plaintext key is
   * returned exactly once and is never persisted.
   *
   * This operation intentionally supports principal-bound TEAM_LEADER and
   * AGENT credentials: rotating the credential must not destroy or recreate
   * the principal relationship.
   */
  async reissueApiKey(
    id: string,
    actor: ApiKey | undefined,
  ): Promise<{
    apiKey: ApiKey;
    rawKey: string;
  }> {
    assertApiKeyManager(actor);
    const current =
      await this.findOne(id);

    /**
     * Keep the old hash independently from the loaded entity. A partial
     * UPDATE keeps the row id stable, and some test/in-memory repository
     * implementations may mutate the same object instance after the write.
     */
    const previousKeyHash =
      current.keyHash;

    const { rawKey, keyHash, keyPrefix } = createCredentialMaterial();

    /**
     * Write only the credential material.
     *
     * Using a partial UPDATE instead of save(current) prevents a stale
     * pre-read from overwriting concurrent authorization/metadata changes.
     */
    await this.adminSafety.applyUnguardedUpdate(
      {
        keyHash,
        keyPrefix,
      },
      id,
    );

    const saved =
      await this.findOne(id);

    /**
     * The old bootstrap plaintext, if this was the seeded key, no longer
     * authenticates after a successful rotation and must not remain on disk.
     */
    this.bootstrap.removeBootstrapKeyFileIfHashMatches(
      previousKeyHash,
      'its key was reissued',
    );

    /**
     * Connections authenticated with the old plaintext credential must be
     * disconnected. The row id is unchanged, so key-id based socket tracking
     * still identifies exactly the affected connections.
     */
    this.socketEviction.evictActiveSockets(
      id,
      'revoked',
    );

    this.logger.log(
      `API key reissued: ${saved.name}`,
      {
        keyId:
          saved.id,

        role:
          saved.role,

        action:
          'api_key_reissued',
      },
    );

    return {
      apiKey:
        saved,

      rawKey,
    };
  }

  async update(
    id: string,
    dto: UpdateApiKeyDto,
    actor: ApiKey | undefined,
  ): Promise<ApiKey> {
    assertApiKeyManager(actor);
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
      ApiKeyRoleRules.assertGenericApiKeyRole(
        dto.role,
      );

      if (
        ApiKeyRoleRules.isManagementCredential(
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
      await this.adminSafety.guardedUpdate(id, patch);

      saved =
        await this.findOne(id);
    } else {
      await this.adminSafety.applyUnguardedUpdate(
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
      this.socketEviction.evictActiveSockets(
        id,
        'authorization_changed',
      );
    }

    return saved;
  }

  /**
   * Delete an API key as an authenticated API-key manager.
   *
   * ADMIN may delete any key subject to the last-usable-admin invariant.
   * OPERATOR may delete every key except the durable primary Admin key.
   *
   * The restriction is enforced here as well as by the controller capability
   * guard so direct service callers cannot bypass it.
   */
  async delete(
    id: string,
    actor: ApiKey,
  ): Promise<void> {
    assertApiKeyManager(actor);
    const apiKey =
      await this.findOne(id);

    this.adminSafety.assertApiKeyDeletionAuthorized(
      actor,
      apiKey,
    );

    const deletedPrimary =
      apiKey.isPrimaryAdminKey;

    if (
      apiKey.role ===
      ApiKeyRole.ADMIN
    ) {
      await this.adminSafety.guardedDelete(id);
    } else {
      await this.apiKeyRepository.remove(
        apiKey,
      );
    }

    this.usageTracker.forget(id);

    this.bootstrap.removeBootstrapKeyFileIfMatching(
      apiKey,
    );

    this.socketEviction.evictActiveSockets(
      id,
      'deleted',
    );

    /**
     * If ADMIN deliberately deletes the primary credential, promote another
     * existing ADMIN credential so Operator protection continues to have a
     * stable target. The last-admin guard guarantees that a usable ADMIN
     * remains when the deleted primary itself was the last usable ADMIN.
     */
    if (deletedPrimary) {
      await this.bootstrap.reconcilePrimaryAdminAfterDeletion();
    }

    this.logger.log(
      `API key deleted: ${apiKey.name}`,
      {
        keyId: id,
        actorKeyId: actor.id,
        actorRole: actor.role,
        wasPrimaryAdminKey: deletedPrimary,
        action:
          'api_key_deleted',
      },
    );
  }
  async revoke(
    id: string,
    actor: ApiKey | undefined,
  ): Promise<ApiKey> {
    assertApiKeyManager(actor);
    const apiKey =
      await this.findOne(id);

    let saved: ApiKey;

    if (
      apiKey.role ===
      ApiKeyRole.ADMIN
    ) {
      await this.adminSafety.guardedUpdate(id, { isActive: false });

      saved =
        await this.findOne(id);
    } else {
      await this.adminSafety.applyUnguardedUpdate(
        {
          isActive: false,
        },
        id,
      );

      saved =
        await this.findOne(id);
    }

    this.usageTracker.forget(id);

    this.bootstrap.removeBootstrapKeyFileIfMatching(
      apiKey,
    );

    this.socketEviction.evictActiveSockets(
      id,
      'revoked',
    );

    return saved;
  }

}
