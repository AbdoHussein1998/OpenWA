


import { SetMetadata } from '@nestjs/common';

import { ApiCapability } from '../capabilities/api-capability';

export const REQUIRED_CAPABILITY_KEY =
  'requiredCapability';

/**
 * Mark a route/controller as requiring one fine-grained capability.
 *
 * Capability checks answer WHAT the authenticated principal may do.
 * SessionTenantAccessService separately answers WHERE they may do it.
 */
export const RequireCapability = (
  capability: ApiCapability,
) =>
  SetMetadata(
    REQUIRED_CAPABILITY_KEY,
    capability,
  );


