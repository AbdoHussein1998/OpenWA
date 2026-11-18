import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { EntityManager, Repository } from 'typeorm';
import { createLogger } from '../../../common/services/logger.service';
import { ApiKey } from '../entities/api-key.entity';
import { ApiKeyRole } from '../auth.levels.constants';
import type { CreateApiKeyDto } from '../dto';
import { ApiKeyRoleRules } from './api-key-role-rules';
import { createCredentialMaterial } from './api-key-material';
import { assertApiKeyManager } from './api-key-management-authorization';

/** Create API keys, including in an existing transaction owned by TeamLeaderService. */
@Injectable()
export class ApiKeyProvisioningService {
  private readonly logger = createLogger('ApiKeyProvisioningService');
  constructor(
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeyRepository: Repository<ApiKey>
  ) { }

  async seedApiKey(rawKey: string, name: string, role: ApiKeyRole, isPrimaryAdminKey = false,): Promise<ApiKey> {
    const { keyHash, keyPrefix } = createCredentialMaterial(rawKey);

    const apiKey =
      this.apiKeyRepository.create({
        name,
        keyHash,
        keyPrefix,
        role,
        isPrimaryAdminKey,
      });

    return this.apiKeyRepository.save(
      apiKey,
    );
  }
  /**
   * Generic API-key creation.
   *
   * TEAM_LEADER and AGENT credentials are intentionally excluded.
   * Those identities must be provisioned atomically alongside their
   * principal rows by TeamLeaderService.
   */
  async createApiKey(dto: CreateApiKeyDto, actor: ApiKey | undefined): Promise<{ apiKey: ApiKey; rawKey: string; }> {
    assertApiKeyManager(actor);
    const requestedRole = dto.role ?? ApiKeyRole.OPERATOR;

    /**
     * DTO validation rejects management roles, but the service is the
     * authoritative security boundary and must also fail closed for direct
     * callers.
     */
    ApiKeyRoleRules.assertGenericApiKeyRole(requestedRole,);

    const { rawKey, keyHash, keyPrefix } = createCredentialMaterial();

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
    ApiKeyRoleRules.assertManagementPrincipalBinding(
      input,
    );

    const { rawKey, keyHash, keyPrefix } = createCredentialMaterial();

    const repository =
      manager.getRepository(ApiKey);

    const apiKey =
      repository.create({
        name: input.name,

        keyHash,

        keyPrefix,

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

}
