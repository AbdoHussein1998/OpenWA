import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { hashApiKey } from '../api-key-hash';
import { ApiKey } from '../entities/api-key.entity';
import { ApiKeyUsageTracker } from '../api-key-usage-tracker.service';
import { ipMatches } from '../../../common/utils/ip';
import { createLogger } from '../../../common/services/logger.service';

/** Validate credential, activation, expiration, and source-IP restrictions.
 * Does NOT decide session ownership or action permissions.
 */
@Injectable()
export class ApiKeyAuthenticator {
  private readonly logger = createLogger('ApiKeyAuthenticator');

  constructor(
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeyRepository: Repository<ApiKey>,
    private readonly usageTracker: ApiKeyUsageTracker,
  ) {}

  async validateApiKey(rawKey: string, clientIp?: string): Promise<ApiKey> {
    const normalizedKey = rawKey?.trim();
    if (!normalizedKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    const keyHash = hashApiKey(normalizedKey, process.env.API_KEY_PEPPER);
    const apiKey = await this.apiKeyRepository.findOne({ where: { keyHash } });
    if (!apiKey) {
      throw new UnauthorizedException('Invalid API key');
    }
    if (!apiKey.isActive) {
      throw new UnauthorizedException('API key is revoked');
    }
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      throw new UnauthorizedException('API key has expired');
    }

    if (apiKey.allowedIps?.length) {
      if (!clientIp) {
        throw new UnauthorizedException('Client IP could not be determined');
      }
      if (!apiKey.allowedIps.some(entry => ipMatches(clientIp, entry))) {
        this.logger.warn(`IP not allowed: ${clientIp}`, {
          keyId: apiKey.id,
          action: 'ip_rejected',
        });
        throw new UnauthorizedException('IP address not allowed');
      }
    }

    // NEVER interpret allowedSessions here: it is an authorization ceiling.
    await this.usageTracker.record(apiKey);
    return apiKey;
  }
}
