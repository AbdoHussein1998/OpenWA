import { SetMetadata } from '@nestjs/common';

import { ApiCapability } from '../capabilities/api-capability';

/**
 * Metadata key used by ApiKeyGuard to determine the capability
 * required by a controller or route handler.
 */
export const REQUIRED_CAPABILITY_KEY = 'requiredCapability';

/**
 * Mark a controller or route as requiring a specific capability.
 *
 * Capability checks answer WHAT the authenticated principal may do.
 * Session/tenant checks are enforced separately by
 * SessionTenantAccessService.
 *
 * @example
 * @RequireCapability(ApiCapability.MESSAGE_SEND)
 *
 * @example
 * @RequireCapability(ApiCapability.SESSION_MANAGE)
 */
export const RequireCapability = (capability: ApiCapability) =>
  SetMetadata(REQUIRED_CAPABILITY_KEY, capability);