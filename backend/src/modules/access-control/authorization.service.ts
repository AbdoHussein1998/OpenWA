import { ForbiddenException, Injectable } from '@nestjs/common';
import { ApiCapability } from '../auth/capabilities/api-capability';
import { ApiKey } from '../auth/entities/api-key.entity';
import { ApiKeyRole } from "../auth/auth.levels.constants"
import { RoleCapabilityPolicy } from './policies/role-capability.policy';
import { SessionTenantAccessService } from './session-tenant-access.service';

export interface AuthorizationRequirements {
  requiredRole?: ApiKeyRole;
  requiredCapability?: ApiCapability;
  requireUnscoped?: boolean;
  sessionId?: string;
  historicalSessionRead?: boolean;
}

/** One authorization decision for action + scope + session ownership. */
@Injectable()
export class AuthorizationService {
  constructor(private readonly tenantAccess: SessionTenantAccessService) { }

  hasPermission(apiKey: ApiKey, role: ApiKeyRole): boolean {
    return RoleCapabilityPolicy.hasPermission(apiKey, role);
  }

  hasCapability(apiKey: ApiKey, capability: ApiCapability): boolean {
    return RoleCapabilityPolicy.hasCapability(apiKey, capability);
  }

  async assertAuthorized(apiKey: ApiKey, requirements: AuthorizationRequirements): Promise<void> {
    const { requiredRole, requiredCapability, requireUnscoped,
      sessionId, historicalSessionRead } =
      requirements;

    if (requiredRole && !this.hasPermission(apiKey, requiredRole)) {
      throw new ForbiddenException(`Insufficient permissions. Required: ${requiredRole}`);
    }
    if (requiredCapability && !this.hasCapability(apiKey, requiredCapability)) {
      throw new ForbiddenException(
        `Insufficient permissions. Required capability: ${requiredCapability}`,
      );
    }
    if (requireUnscoped && (apiKey.allowedSessions?.length ?? 0) > 0) {
      throw new ForbiddenException('Session-scoped API keys are not permitted on this route');
    }

    if (!sessionId) return;
    if (historicalSessionRead) {
      await this.tenantAccess.assertHistoricalSessionAccess(apiKey, sessionId);
    } else {
      await this.tenantAccess.assertSessionAccess(apiKey, sessionId);
    }
  }
}
