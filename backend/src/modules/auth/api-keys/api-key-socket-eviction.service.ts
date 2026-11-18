import { Inject, Injectable, Optional } from '@nestjs/common';
import { createLogger } from '../../../common/services/logger.service';
import {
  ACTIVE_CREDENTIAL_CONNECTION_EVICTOR,
  type ActiveCredentialConnectionEvictor,
  type CredentialEvictionReason,
} from './active-credential-connection-evictor';

/** Coordinates best-effort connection invalidation through a narrow port. */
@Injectable()
export class ApiKeySocketEvictionService {
  private readonly logger = createLogger('ApiKeySocketEvictionService');

  constructor(
    @Optional()
    @Inject(ACTIVE_CREDENTIAL_CONNECTION_EVICTOR)
    private readonly evictor?: ActiveCredentialConnectionEvictor,
  ) {}

  /** Database revocation is authoritative; socket eviction is an urgent side effect. */
  evictActiveSockets(
    keyId: string,
    reason: CredentialEvictionReason = 'revoked',
  ): void {
    try {
      if (!this.evictor) {
        throw new Error('No active-credential connection evictor was configured');
      }
      this.evictor.evictApiKey(keyId, reason);
    } catch (error) {
      this.logger.warn(`Failed to evict WebSocket sockets for key ${keyId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
