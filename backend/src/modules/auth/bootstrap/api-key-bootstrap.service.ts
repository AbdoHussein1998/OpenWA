import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { createLogger } from '../../../common/services/logger.service';
import { ApiKey } from '../entities/api-key.entity';
import { ApiKeyRole } from '../auth.levels.constants';
import { ApiKeyProvisioningService } from '../api-keys/api-key-provisioning.service';
import { ApiKeyAdminSafetyService } from '../api-keys/api-key-admin-safety.service';
import { hashCredential } from '../api-keys/api-key-material';
import { readBootstrapKey, writeBootstrapKey, removeBootstrapKey } from './bootstrap-key-file';
import { resolveSeedApiKey, bannerKeyLine } from './bootstrap-key-policy';

/** Startup bootstrap only. Never validates client requests or checks route permissions. */
@Injectable()
export class ApiKeyBootstrapService implements OnModuleInit {
  private readonly logger = createLogger('ApiKeyBootstrapService');
  constructor(
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeyRepository: Repository<ApiKey>,
    private readonly provisioning: ApiKeyProvisioningService,
    private readonly adminSafety: ApiKeyAdminSafetyService,
  ) { }
  async onModuleInit(): Promise<void> {
    const count =
      await this.apiKeyRepository.count();

    let displayKey: string;
    let isNewKey = false;

    if (count === 0) {
      displayKey =
        resolveSeedApiKey();

      await this.provisioning.seedApiKey(
        displayKey,
        'Default Admin Key',
        ApiKeyRole.ADMIN,
        true,
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

    /**
     * Existing installations predate the durable primary-key marker. Backfill
     * it at startup after migrations/synchronization have created the column.
     */
    await this.adminSafety.ensurePrimaryAdminKey(readBootstrapKey(this.logger));

    const apiBaseUrl =
      process.env.BASE_URL ||
      `http://localhost:${process.env.PORT || 2785
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
      '  🟢 Welcome to al-hakim - WhatsApp API Gateway',
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
          keyHash: hashCredential(rawKey),
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
   * Remove the bootstrap key file when it contains a credential that has
   * just been invalidated.
   *
   * Reissue needs the previous hash rather than the mutable entity object:
   * the database row keeps the same id while keyHash/keyPrefix are replaced.
   */
  removeBootstrapKeyFileIfHashMatches(
    keyHash: string,
    reason: string,
  ): void {
    const fileKey =
      readBootstrapKey(this.logger);

    if (
      !fileKey ||
      hashCredential(fileKey) !== keyHash
    ) {
      return;
    }

    removeBootstrapKey(
      reason,
      this.logger,
    );
  }

  /** Reconcile the durable primary marker after deleting the previous primary key. */
  async reconcilePrimaryAdminAfterDeletion(): Promise<void> {
    await this.adminSafety.ensurePrimaryAdminKey(readBootstrapKey(this.logger));
  }

  removeBootstrapKeyFileIfMatching(
    apiKey: ApiKey,
  ): void {
    this.removeBootstrapKeyFileIfHashMatches(
      apiKey.keyHash,
      'its key was revoked or deleted',
    );
  }

}
