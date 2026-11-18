import { ApiCapability } from '../../auth/capabilities/api-capability';
import { ApiKey, } from '../../auth/entities/api-key.entity';
import { ApiKeyRole } from '../../auth/auth.levels.constants'
/**
 * Single role policy for every authentication surface (REST, WS, MCP).
 * WHAT the actor may do is separate from WHICH session they may access.
 * Preserve the existing five-role matrix during migration.
 */
/**
 * Compatibility authorization for legacy @RequireRole(...) routes.
 *
 * Do not infer privilege from enum ordering.
 *
 * New authorization-sensitive routes should prefer ApiCapability.
 */
const ROLE_PERMISSIONS: Readonly<Record<ApiKeyRole, ReadonlySet<ApiKeyRole>>> = {
  [ApiKeyRole.ADMIN]: new Set([
    ApiKeyRole.ADMIN,
    ApiKeyRole.OPERATOR,
    ApiKeyRole.VIEWER,
  ]),

  [ApiKeyRole.OPERATOR]: new Set([
    ApiKeyRole.OPERATOR,
    ApiKeyRole.VIEWER,
  ]),

  [ApiKeyRole.VIEWER]: new Set([
    ApiKeyRole.VIEWER,
  ]),

  /**
   * Team Leaders retain compatibility with legacy routes that still
   * require OPERATOR while those routes are progressively converted
   * to explicit capabilities.
   *
   * Session tenancy is enforced separately.
   */
  [ApiKeyRole.TEAM_LEADER]: new Set([
    ApiKeyRole.OPERATOR,
    ApiKeyRole.VIEWER,
  ]),

  /**
   * Agents deliberately do NOT inherit OPERATOR.
   *
   * Agent-approved message/chat write routes must use explicit
   * capabilities instead of @RequireRole(OPERATOR).
   */
  [ApiKeyRole.AGENT]: new Set([
    ApiKeyRole.VIEWER,
  ]),
};

/**
 * Fine-grained capabilities answer:
 *
 *     WHAT may this authenticated principal do?
 *
 * They deliberately do NOT answer:
 *
 *     WHERE may this principal do it?
 *
 * Session/tenant authorization belongs to SessionTenantAccessService.
 */
const ROLE_CAPABILITIES: Readonly<Record<ApiKeyRole, ReadonlySet<ApiCapability>>> = {
  [ApiKeyRole.ADMIN]: new Set([
    ApiCapability.SESSION_READ,
    ApiCapability.SESSION_CREATE,
    ApiCapability.SESSION_MANAGE,
    ApiCapability.SESSION_CONFIGURE,
    ApiCapability.SESSION_START,
    ApiCapability.SESSION_SHUTDOWN,

    ApiCapability.CHAT_READ,
    ApiCapability.CHAT_OPERATE,

    ApiCapability.MESSAGE_SEND,
    ApiCapability.MESSAGE_OPERATE,
    ApiCapability.MESSAGE_BULK,

    ApiCapability.WEBHOOK_MANAGE,
    ApiCapability.TEMPLATE_READ,
    ApiCapability.TEMPLATE_MANAGE,
    ApiCapability.SEARCH_MESSAGES,

    ApiCapability.TEAM_MANAGE,
    ApiCapability.PRINCIPAL_READ,
    ApiCapability.PRINCIPAL_MANAGE,

    ApiCapability.API_KEY_MANAGE,
    ApiCapability.AUDIT_READ,
    ApiCapability.STATS_READ,
    ApiCapability.INFRA_MANAGE,
    ApiCapability.PLUGIN_MANAGE,
    // Central residential proxy infrastructure is administrator-only.
    ApiCapability.PROXY_READ,
    ApiCapability.PROXY_CREATE,
    ApiCapability.PROXY_UPDATE,
    ApiCapability.PROXY_TEST,
    ApiCapability.PROXY_DELETE,
  ]),

  /**
   * OPERATOR is intentionally "Admin minus Infrastructure" at the
   * capability layer.
   *
   * It does NOT inherit the ADMIN role through ROLE_PERMISSIONS. This keeps
   * legacy ADMIN-only endpoints closed until they are deliberately migrated
   * to a capability that Operator should receive.
   */
  [ApiKeyRole.OPERATOR]: new Set([
    ApiCapability.SESSION_READ,
    ApiCapability.SESSION_CREATE,
    ApiCapability.SESSION_MANAGE,
    ApiCapability.SESSION_CONFIGURE,
    ApiCapability.SESSION_START,
    ApiCapability.SESSION_SHUTDOWN,

    ApiCapability.CHAT_READ,
    ApiCapability.CHAT_OPERATE,

    ApiCapability.MESSAGE_SEND,
    ApiCapability.MESSAGE_OPERATE,
    ApiCapability.MESSAGE_BULK,

    ApiCapability.WEBHOOK_MANAGE,
    ApiCapability.TEMPLATE_READ,
    ApiCapability.TEMPLATE_MANAGE,
    ApiCapability.SEARCH_MESSAGES,

    ApiCapability.TEAM_MANAGE,
    ApiCapability.PRINCIPAL_READ,
    ApiCapability.PRINCIPAL_MANAGE,

    ApiCapability.API_KEY_MANAGE,
    ApiCapability.AUDIT_READ,
    ApiCapability.STATS_READ,
    ApiCapability.PLUGIN_MANAGE,

    // Deliberately excluded:
    // ApiCapability.INFRA_MANAGE,
  ]),

  [ApiKeyRole.VIEWER]: new Set([
    ApiCapability.SESSION_READ,
    ApiCapability.CHAT_READ,

    // Global Team Leader / Agent inventory is visible read-only.
    ApiCapability.PRINCIPAL_READ,
  ]),

  [ApiKeyRole.TEAM_LEADER]: new Set([
    ApiCapability.SESSION_READ,
    ApiCapability.SESSION_CREATE,
    ApiCapability.SESSION_MANAGE,
    ApiCapability.SESSION_CONFIGURE,
    ApiCapability.SESSION_START,
    ApiCapability.SESSION_SHUTDOWN,

    ApiCapability.CHAT_READ,
    ApiCapability.CHAT_OPERATE,

    ApiCapability.MESSAGE_SEND,
    ApiCapability.MESSAGE_OPERATE,

    ApiCapability.TEMPLATE_READ,
    ApiCapability.TEMPLATE_MANAGE,
    ApiCapability.SEARCH_MESSAGES,

    /**
     * Self-service Team Leader management only.
     *
     * Global Team Leader / Agent inventory and administration use
     * PRINCIPAL_READ / PRINCIPAL_MANAGE respectively. TEAM_LEADER
     * credentials receive neither global capability.
     */
    ApiCapability.TEAM_MANAGE,
  ]),

  [ApiKeyRole.AGENT]: new Set([
    ApiCapability.SESSION_READ,
    ApiCapability.SESSION_START,
    ApiCapability.SESSION_SHUTDOWN,

    ApiCapability.CHAT_READ,
    ApiCapability.CHAT_OPERATE,

    ApiCapability.MESSAGE_SEND,
    ApiCapability.MESSAGE_OPERATE,

    ApiCapability.TEMPLATE_READ,
  ]),
};


export class RoleCapabilityPolicy {
  static hasPermission(apiKey: Pick<ApiKey, 'role'>, requiredRole: ApiKeyRole): boolean {
    return ROLE_PERMISSIONS[apiKey.role]?.has(requiredRole) ?? false;
  }

  static hasCapability(apiKey: Pick<ApiKey, 'role'>, capability: ApiCapability): boolean {
    return ROLE_CAPABILITIES[apiKey.role]?.has(capability) ?? false;
  }
}
