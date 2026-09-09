


import type {
  RoleCapabilities,
  UserRole,
} from '../types/role';

/**
 * Frontend UX capabilities.
 *
 * IMPORTANT:
 * These capabilities do NOT replace backend authorization.
 * The NestJS guards/services remain authoritative for tenant and
 * assignment access. This file only controls what the dashboard shows
 * and which client-side routes it allows a role to enter.
 *
 * The specific flags below intentionally mirror the backend distinctions
 * needed by the current dashboard work:
 *
 * - Agents may start/shutdown their assigned session, but may not manage
 *   session configuration/lifecycle broadly.
 * - Agents may read stored templates, but may not manage them.
 * - Team Leaders may manage stored templates.
 * - Team Leaders and Agents may not manage webhooks.
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
    canManageApiKeys: true,
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
    canManageTeam: false,
    canManageApiKeys: false,
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
    canManageApiKeys: false,
    canManageInfrastructure: false,
  },

  team_leader: {
    /**
     * Keep the legacy broad write flag false.
     *
     * Team Leaders are allowed to perform specific write operations,
     * but existing components that rely on `canWrite` may expose broader
     * admin/operator controls. New Team Leader UI should use the explicit
     * capabilities below.
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
    canManageTeam: true,
    canManageApiKeys: false,
    canManageInfrastructure: false,
  },

  agent: {
    /**
     * Agents are assignment-scoped operators.
     *
     * They may read/start/shutdown only the session authorized by the
     * backend assignment fence, operate chats, send messages, and read
     * stored templates. They may not create/delete/configure sessions,
     * manage templates, or manage webhooks.
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
    canManageApiKeys: false,
    canManageInfrastructure: false,
  },
};

/**
 * Null means there is no authenticated/known dashboard role yet, so
 * every capability is false.
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
  canManageApiKeys: false,
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
 * The legacy roles keep the existing dashboard home route.
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
      return '/';

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
 * security boundary for session ownership, Team Leader tenancy, Agent
 * assignment, messages, or WebSocket subscriptions.
 *
 * Unknown routes return false so an authenticated actor is not allowed
 * into a newly-added page merely because the route has not yet been
 * classified here.
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
   * Team Leaders and Agents get dedicated workspaces instead of the
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
   * Generic Sessions remains unavailable to Agents because their
   * workspace is assignment-driven and must not expose a free session
   * selector.
   */
  if (matchesRoute(pathname, '/sessions')) {
    return (
      capabilities.canReadSessions &&
      role !== 'agent'
    );
  }

  /**
   * Generic Chats follows the same rule: Agents use /agent so the
   * selected session always comes from their backend assignment.
   */
  if (matchesRoute(pathname, '/chats')) {
    return (
      capabilities.canReadSessions &&
      role !== 'agent'
    );
  }

  /**
   * Webhook management is available only where the backend grants the
   * corresponding management capability.
   */
  if (matchesRoute(pathname, '/webhooks')) {
    return capabilities.canManageWebhooks;
  }

  /**
   * Stored templates are readable by Admin, Operator, Team Leader and
   * Agent. The Templates page uses canManageTemplates separately to
   * decide whether create/edit/delete controls are enabled.
   */
  if (matchesRoute(pathname, '/templates')) {
    return capabilities.canReadTemplates;
  }

  /**
   * The generic message tester needs send permission, but Agents stay on
   * their assignment-driven /agent workspace to avoid a generic session
   * selector.
   */
  if (matchesRoute(pathname, '/message-tester')) {
    return (
      capabilities.canSendMessages &&
      role !== 'agent'
    );
  }

  /**
   * API-key management is an administrative surface.
   *
   * Team Leaders create/manage their Agents through /team-leader rather
   * than the generic API-key management page.
   */
  if (
    matchesRoute(pathname, '/api-keys') ||
    matchesRoute(pathname, '/apikeys')
  ) {
    return capabilities.canManageApiKeys;
  }

  /**
   * Infrastructure and plugin management remain administrative.
   */
  if (
    matchesRoute(pathname, '/infrastructure') ||
    matchesRoute(pathname, '/plugins')
  ) {
    return capabilities.canManageInfrastructure;
  }

  return false;
}



