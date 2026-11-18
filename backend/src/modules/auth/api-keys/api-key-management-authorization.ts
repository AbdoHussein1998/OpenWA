import { ForbiddenException } from '@nestjs/common';
import { RoleCapabilityPolicy } from '../../access-control/policies/role-capability.policy';
import { ApiCapability } from '../capabilities/api-capability';
import type { ApiKey } from '../entities/api-key.entity';

/**
 * Application-layer check for sensitive API-key lifecycle operations.
 *
 * `actor` must be the *authenticated* API key supplied by an adapter, not an
 * arbitrary client-provided ID. This is deliberately independent of HTTP
 * decorators, allowing direct service callers to be tested and denied.
 * The authenticator/transport still owns digest and client-IP validation.
 */
export function assertApiKeyManager(
  actor: ApiKey | undefined,
): asserts actor is ApiKey {
  if (!actor || !RoleCapabilityPolicy.hasCapability(actor, ApiCapability.API_KEY_MANAGE)) {
    throw new ForbiddenException('API key management permission is required');
  }
  if (!actor.isActive || (actor.expiresAt && actor.expiresAt <= new Date())) {
    throw new ForbiddenException('An active, unexpired API key is required');
  }
  if ((actor.allowedSessions?.length ?? 0) > 0) {
    throw new ForbiddenException('Session-scoped API keys cannot manage API keys');
  }
}
