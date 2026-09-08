
import type { UserRole } from '../types/role';

/**
 * Frontend UX capabilities.
 *
 * IMPORTANT:
 * These capabilities do NOT replace backend authorization.
 * The NestJS guards/services remain authoritative for tenant and
 * assignment access. This file only controls what the dashboard shows
 * and which client-side routes it allows a role to enter.
 */
export interface RoleCapabilities {
  canWrite: boolean;
  canManageSessions: boolean;
  canReadSessions: boolean;
  canOperateChats: boolean;
  canSendMessages: boolean;
  canManageTeam: boolean;
  canManageApiKeys: boolean;
  canManageInfrastructure: boolean;
}

/**
 * Keep every role's frontend capabilities in one place.
 *
 * `canWrite` is retained for backwards compatibility with existing
 * dashboard components. New code should prefer the specific capability
 * that matches the operation being rendered.
 */
export const ROLE_CAPABILITIES: Readonly<
  Record<UserRole, Readonly<RoleCapabilities>>
> = {
  admin: {
    canWrite: true,
    canManageSessions: true,
    canReadSessions: true,
    canOperateChats: true,
    canSendMessages: true,
    canManageTeam: true,
    canManageApiKeys: true,
    canManageInfrastructure: true,
  },

  operator: {
    canWrite: true,
    canManageSessions: true,
    canReadSessions: true,
    canOperateChats: true,
    canSendMessages: true,
    canManageTeam: false,
    canManageApiKeys: false,
    canManageInfrastructure: false,
  },

  viewer: {
    canWrite: false,
    canManageSessions: false,
    canReadSessions: true,
    canOperateChats: true,
    canSendMessages: false,
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
    canOperateChats: true,
    canSendMessages: true,
    canManageTeam: true,
    canManageApiKeys: false,
    canManageInfrastructure: false,
  },

  agent: {
    /**
     * Agents can send messages, but they cannot manage session
     * lifecycle. Keeping `canWrite` false prevents old broad write gates
     * from accidentally exposing management controls.
     */
    canWrite: false,
    canManageSessions: false,
    canReadSessions: true,
    canOperateChats: true,
    canSendMessages: true,
    canManageTeam: false,
    canManageApiKeys: false,
    canManageInfrastructure: false,
  },
};

/**
 * Return the capability set for a role.
 *
 * Null means there is no authenticated/known dashboard role yet, so
 * every capability is false.
 */
const NO_CAPABILITIES: Readonly<RoleCapabilities> = {
  canWrite: false,
  canManageSessions: false,
  canReadSessions: false,
  canOperateChats: false,
  canSendMessages: false,
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
   * Sessions are visible to legacy dashboard roles and Team Leaders.
   *
   * Agents should use the assignment-driven /agent workspace instead of
   * browsing or selecting arbitrary sessions.
   */
  if (matchesRoute(pathname, '/sessions')) {
    return (
      role === 'admin' ||
      role === 'operator' ||
      role === 'viewer' ||
      role === 'team_leader'
    );
  }

  /**
   * Generic Chats remains available to the legacy dashboard roles and
   * Team Leaders. Agents use /agent so they cannot choose another
   * session from a generic session selector.
   */
  if (matchesRoute(pathname, '/chats')) {
    return (
      role === 'admin' ||
      role === 'operator' ||
      role === 'viewer' ||
      role === 'team_leader'
    );
  }

  /**
   * Team Leaders are expected to retain access to their tenant-scoped
   * operational tools. The backend must scope every returned resource.
   */
  if (
    matchesRoute(pathname, '/webhooks') ||
    matchesRoute(pathname, '/templates') ||
    matchesRoute(pathname, '/message-tester')
  ) {
    return (
      role === 'admin' ||
      role === 'operator' ||
      role === 'viewer' ||
      role === 'team_leader'
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
    return role === 'admin';
  }

  /**
   * Infrastructure and plugin management remain administrative.
   */
  if (
    matchesRoute(pathname, '/infrastructure') ||
    matchesRoute(pathname, '/plugins')
  ) {
    return role === 'admin';
  }

  return false;
}


