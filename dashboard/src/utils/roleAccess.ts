import type {
  RoleCapabilities,
  UserRole,
} from '../types/role';

/**
 * Frontend UX capabilities.
 *
 * IMPORTANT:
 * These capabilities do NOT replace backend authorization. NestJS
 * guards/services remain authoritative for role, tenant, ownership, and
 * assignment checks.
 *
 * The frontend distinctions intentionally mirror the backend capability
 * model:
 *
 * - TEAM_MANAGE -> Team Leader/Agent domain self-service.
 * - PRINCIPAL_READ -> global read-only Team Leader/Agent inventory access.
 * - PRINCIPAL_MANAGE -> global Team Leader/Agent administration.
 * - API_KEY_MANAGE -> API-key lifecycle administration.
 * - AUDIT_READ -> global audit-log access.
 * - STATS_READ -> system-wide aggregate statistics.
 * - PLUGIN_MANAGE -> plugin administration.
 * - INFRA_MANAGE -> infrastructure administration.
 *
 * ADMIN receives all of these.
 *
 * OPERATOR receives the administrative capabilities above except
 * INFRA_MANAGE. The backend still remains responsible for the special rule
 * that an OPERATOR cannot delete the primary Admin API key.
 */
export const ROLE_CAPABILITIES: Readonly<
  Record<UserRole, Readonly<RoleCapabilities>>
> = {
  admin: {
    canWrite: true,

    canManageSessions: true,
    canReadSessions: true,
    canStartSessions: true,
    canShutdownSessions: true,

    canOperateChats: true,
    canSendMessages: true,

    canReadTemplates: true,
    canManageTemplates: true,

    canManageWebhooks: true,

    canManageTeam: true,
    canReadPrincipals: true,
    canManagePrincipals: true,

    canManageApiKeys: true,

    canReadAudit: true,
    canReadGlobalStats: true,

    canManagePlugins: true,

    canManageInfrastructure: true,
  },

  operator: {
    canWrite: true,

    canManageSessions: true,
    canReadSessions: true,
    canStartSessions: true,
    canShutdownSessions: true,

    canOperateChats: true,
    canSendMessages: true,

    canReadTemplates: true,
    canManageTemplates: true,

    canManageWebhooks: true,

    canManageTeam: true,
    canReadPrincipals: true,
    canManagePrincipals: true,

    canManageApiKeys: true,

    canReadAudit: true,
    canReadGlobalStats: true,

    canManagePlugins: true,

    /**
     * Operator deliberately does not receive infrastructure administration.
     * This is the primary frontend distinction between ADMIN and OPERATOR.
     */
    canManageInfrastructure: false,
  },

  viewer: {
    canWrite: false,

    canManageSessions: false,
    canReadSessions: true,
    canStartSessions: false,
    canShutdownSessions: false,

    canOperateChats: false,
    canSendMessages: false,

    canReadTemplates: false,
    canManageTemplates: false,

    canManageWebhooks: false,

    canManageTeam: false,
    canReadPrincipals: true,
    canManagePrincipals: false,

    canManageApiKeys: false,

    canReadAudit: false,
    canReadGlobalStats: false,

    canManagePlugins: false,

    canManageInfrastructure: false,
  },

  team_leader: {
    /**
     * Keep the legacy broad write flag false.
     *
     * Team Leaders may perform specific writes, but `canWrite` historically
     * exposes wider Admin/Operator UI. Team Leader UI must use the explicit
     * capabilities below instead.
     */
    canWrite: false,

    canManageSessions: true,
    canReadSessions: true,
    canStartSessions: true,
    canShutdownSessions: true,

    canOperateChats: true,
    canSendMessages: true,

    canReadTemplates: true,
    canManageTemplates: true,

    canManageWebhooks: false,

    /**
     * Team Leaders may manage their own Agents through the self-service
     * `/team-leader` surface, but may not enter global `/admin/*` principal
     * management.
     */
    canManageTeam: true,
    canReadPrincipals: false,
    canManagePrincipals: false,

    canManageApiKeys: false,

    canReadAudit: false,
    canReadGlobalStats: false,

    canManagePlugins: false,

    canManageInfrastructure: false,
  },

  agent: {
    /**
     * Agents are assignment-scoped operators.
     *
     * `canManageSessions` remains false because that flag represents broad
     * Session management such as create/delete/configure. Agents instead
     * receive only the explicit operational capabilities below, while the
     * backend assignment fence limits them to their assigned Session.
     */
    canWrite: false,

    canManageSessions: false,
    canReadSessions: true,
    canStartSessions: true,
    canShutdownSessions: true,

    canOperateChats: true,
    canSendMessages: true,

    canReadTemplates: true,
    canManageTemplates: false,

    canManageWebhooks: false,

    canManageTeam: false,
    canReadPrincipals: false,
    canManagePrincipals: false,

    canManageApiKeys: false,

    canReadAudit: false,
    canReadGlobalStats: false,

    canManagePlugins: false,

    canManageInfrastructure: false,
  },
};

/**
 * Null means there is no authenticated/known dashboard role yet, so every
 * capability is false.
 */
const NO_CAPABILITIES: Readonly<RoleCapabilities> = {
  canWrite: false,

  canManageSessions: false,
  canReadSessions: false,
  canStartSessions: false,
  canShutdownSessions: false,

  canOperateChats: false,
  canSendMessages: false,

  canReadTemplates: false,
  canManageTemplates: false,

  canManageWebhooks: false,

  canManageTeam: false,
  canReadPrincipals: false,
  canManagePrincipals: false,

  canManageApiKeys: false,

  canReadAudit: false,
  canReadGlobalStats: false,

  canManagePlugins: false,

  canManageInfrastructure: false,
};

export function getRoleCapabilities(
  role: UserRole | null,
): Readonly<RoleCapabilities> {
  if (!role) {
    return NO_CAPABILITIES;
  }

  return ROLE_CAPABILITIES[role];
}

/**
 * Default authenticated landing page for each role.
 *
 * ADMIN, OPERATOR, and VIEWER continue to use the existing dashboard home.
 * Team Leaders and Agents use their dedicated workspaces.
 */
export function getRoleHome(
  role: UserRole | null,
): string {
  switch (role) {
    case 'team_leader':
      return '/team-leader';

    case 'agent':
      return '/agent';

    case 'admin':
    case 'operator':
    case 'viewer':
    default:
      return '/';
  }
}

/**
 * Normalize a browser location before applying route rules.
 *
 * This allows callers to pass values such as:
 *
 *   /chats?session=...
 *   /sessions/
 *
 * while matching against the route itself.
 */
function normalizePath(path: string): string {
  const pathname =
    path.split('?')[0]?.split('#')[0] ?? '/';

  if (pathname === '/') {
    return '/';
  }

  return pathname.replace(/\/+$/, '') || '/';
}

function matchesRoute(
  pathname: string,
  route: string,
): boolean {
  return (
    pathname === route ||
    pathname.startsWith(`${route}/`)
  );
}

/**
 * Dashboard route access.
 *
 * This is a navigation/UX guard only. It must never be treated as the
 * security boundary for Session ownership, Team Leader tenancy, Agent
 * assignment, messages, templates, API-key protection, or WebSocket access.
 *
 * Unknown routes return false so a newly-added page is not exposed merely
 * because it has not yet been classified here.
 */
export function canAccessRoute(
  role: UserRole | null,
  path: string,
): boolean {
  if (!role) {
    return false;
  }

  const pathname =
    normalizePath(path);

  const capabilities =
    getRoleCapabilities(role);

  /**
   * Existing dashboard home.
   *
   * Team Leaders and Agents use their dedicated workspaces instead of the
   * legacy general-purpose home.
   */
  if (pathname === '/') {
    return (
      role === 'admin' ||
      role === 'operator' ||
      role === 'viewer'
    );
  }

  /**
   * Dedicated management/workspace pages.
   */
  if (matchesRoute(pathname, '/team-leader')) {
    return role === 'team_leader';
  }

  if (
    matchesRoute(pathname, '/agent') ||
    matchesRoute(pathname, '/spg-agents')
  ) {
    return role === 'agent';
  }

  /**
   * Global Team Leader and Agent inventories.
   *
   * Route visibility uses canReadPrincipals so VIEWER can inspect the global
   * inventory without receiving mutation rights. Mutating controls use
   * canManagePrincipals separately. Team Leaders legitimately have
   * canManageTeam for self-service but do not receive either global principal
   * capability.
   */
  if (
    matchesRoute(pathname, '/admin/team-leaders') ||
    matchesRoute(pathname, '/admin/agents')
  ) {
    return capabilities.canReadPrincipals;
  }

  /**
   * Generic Sessions stays unavailable to Agents.
   *
   * Agents still have canReadSessions/canStartSessions/canShutdownSessions
   * because Agent.tsx uses those capabilities for the single backend-assigned
   * Session. They do not receive the generic Session inventory.
   */
  if (matchesRoute(pathname, '/sessions')) {
    return (
      capabilities.canReadSessions &&
      role !== 'agent'
    );
  }

  /**
   * Generic Chats remains unavailable to Agents because their current chat
   * workflow is assignment-driven through /agent.
   */
  if (matchesRoute(pathname, '/chats')) {
    return (
      capabilities.canReadSessions &&
      role !== 'agent'
    );
  }

  if (matchesRoute(pathname, '/webhooks')) {
    return capabilities.canManageWebhooks;
  }

  /**
   * Stored templates are readable by every role with template-read access.
   * The page should use canManageTemplates separately for mutating controls.
   */
  if (matchesRoute(pathname, '/templates')) {
    return capabilities.canReadTemplates;
  }

  /**
   * The generic message tester needs send permission, but Agents stay on
   * their assignment-driven /agent workspace to avoid a free Session selector.
   */
  if (matchesRoute(pathname, '/message-tester')) {
    return (
      capabilities.canSendMessages &&
      role !== 'agent'
    );
  }

  if (
    matchesRoute(pathname, '/api-keys') ||
    matchesRoute(pathname, '/apikeys')
  ) {
    return capabilities.canManageApiKeys;
  }

  if (matchesRoute(pathname, '/logs')) {
    return capabilities.canReadAudit;
  }

  /**
   * Keep Plugins and Infrastructure separate.
   *
   * OPERATOR receives plugin administration but deliberately does not receive
   * infrastructure administration.
   */
  if (matchesRoute(pathname, '/plugins')) {
    return capabilities.canManagePlugins;
  }

  if (matchesRoute(pathname, '/infrastructure')) {
    return capabilities.canManageInfrastructure;
  }

  /**
   * Reserved for a dedicated global statistics page if/when one is mounted.
   * The current dashboard home may consume the same capability directly.
   */
  if (matchesRoute(pathname, '/stats')) {
    return capabilities.canReadGlobalStats;
  }

  return false;
}
