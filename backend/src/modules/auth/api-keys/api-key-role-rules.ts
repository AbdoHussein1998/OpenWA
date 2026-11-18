import { BadRequestException } from '@nestjs/common';
import { ApiKeyRole } from '../auth.levels.constants';
import type { ApiKey } from '../entities/api-key.entity';

/** Role/binding *integrity* rules. Access permissions live in RoleCapabilityPolicy. */
export class ApiKeyRoleRules {
  /**
   * Whether a role belongs to a management principal.
   */
  static isManagementRole(role: ApiKeyRole,): boolean {
    return (role === ApiKeyRole.TEAM_LEADER || role === ApiKeyRole.AGENT);
  }

  /**
   * A management credential is identified fail-closed.
   *
   * Normally the role and principal binding agree:
   *
   * TEAM_LEADER:
   *   role = TEAM_LEADER
   *   teamLeaderId != null
   *   agentId == null
   *
   * AGENT:
   *   role = AGENT
   *   agentId != null
   *   teamLeaderId == null
   *
   * Checking principal bindings as well as role prevents generic key
   * management from changing the role of a malformed stored row that still
   * points at a management principal.
   */
  static isManagementCredential(apiKey: Pick<ApiKey, 'role' | 'teamLeaderId' | 'agentId'>,): boolean {
    return (ApiKeyRoleRules.isManagementRole(apiKey.role,) || Boolean(apiKey.teamLeaderId,) || Boolean(apiKey.agentId,));
  }

  /**
   * Generic /auth/api-keys management may only create or assign legacy
   * ADMIN / OPERATOR / VIEWER roles.
   */
  static assertGenericApiKeyRole(role: ApiKeyRole): void {
    if (ApiKeyRoleRules.isManagementRole(role)) {
      throw new BadRequestException('Team Leader and Agent API keys must be managed through principal management',);
    }
    // Service-level allowlist: direct callers bypassing class-validator must fail closed.
    if (![ApiKeyRole.ADMIN, ApiKeyRole.OPERATOR, ApiKeyRole.VIEWER].includes(role)) {
      throw new BadRequestException('Unsupported API key role');
    }
  }
  
  /**
   * Enforce the invariant between management roles and their principal
   * bindings.
   *
   * TEAM_LEADER:
   *   teamLeaderId != null
   *   agentId == null
   *
   * AGENT:
   *   agentId != null
   *   teamLeaderId == null
   */
  static assertManagementPrincipalBinding(input: { role: ApiKeyRole; teamLeaderId?: | string | null; agentId?: | string | null; },): void {
    /**
     * Compile-time narrowing on createApiKeyInTransaction() is useful, but
     * this method is also a runtime security boundary. Reject unexpected
     * enum values explicitly rather than treating every non-TEAM_LEADER
     * value as AGENT.
     */
    if (!ApiKeyRoleRules.isManagementRole(input.role,)) {
      throw new BadRequestException('Management principal API-key provisioning requires TEAM_LEADER or AGENT role',);
    }

    if (input.role === ApiKeyRole.TEAM_LEADER) {
      if (!input.teamLeaderId || input.agentId) {
        throw new BadRequestException('TEAM_LEADER API key requires teamLeaderId and must not contain agentId',);
      }

      return;
    }

    /**
     * The only remaining valid management role is AGENT.
     */
    if (
      !input.agentId ||
      input.teamLeaderId
    ) {
      throw new BadRequestException(
        'AGENT API key requires agentId and must not contain teamLeaderId',
      );
    }
  }

}
