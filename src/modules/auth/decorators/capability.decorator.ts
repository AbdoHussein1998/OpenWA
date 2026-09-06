import { SetMetadata } from '@nestjs/common';
import { ApiCapability } from '../capabilities/api-capability';

/**
 * Metadata key used by ApiKeyGuard to determine whether a route
 * requires a fine-grained authorization capability.
 */
export const REQUIRED_CAPABILITY_KEY = 'requiredCapability';

/**
 * Require a fine-grained capability for a controller or route.
 *
 * Capabilities define WHAT an authenticated principal may do.
 * They do not determine WHICH sessions/resources the principal
 * may access.
 *
 * Session/tenant authorization is handled separately by
 * SessionTenantAccessService.
 *
 * @example
 * @RequireCapability(ApiCapability.MESSAGE_SEND)
 *
 * @example
 * @RequireCapability(ApiCapability.TEAM_MANAGE)
 */
export const RequireCapability = (capability: ApiCapability) =>
  SetMetadata(REQUIRED_CAPABILITY_KEY, capability);



