// Role types for RBAC

export type UserRole =
  | 'admin'
  | 'operator'
  | 'viewer'
  | 'team_leader'
  | 'agent';

/**
 * Frontend UX capabilities.
 *
 * These flags control dashboard behavior, route visibility, and action
 * availability only. Backend NestJS guards/services remain authoritative.
 *
 * `canWrite` is retained for backwards compatibility with existing
 * dashboard components and deliberately remains limited to the legacy
 * Admin/Operator behavior. New code should prefer the most specific
 * capability available.
 *
 * `canManageTeam` represents the existing Team Leader/Agent domain-management
 * capability used by Team Leader self-service flows. It must not be used to
 * authorize global `/admin/*` principal-management pages because Team Leaders
 * legitimately have this capability for their own team.
 *
 * `canManagePrincipals` represents global Team Leader/Agent administration and
 * mirrors the backend PRINCIPAL_MANAGE capability intended for ADMIN/OPERATOR.
 */
export interface RoleCapabilities {
  canWrite: boolean;

  canManageSessions: boolean;
  canReadSessions: boolean;
  canStartSessions: boolean;
  canShutdownSessions: boolean;

  canOperateChats: boolean;
  canSendMessages: boolean;

  canReadTemplates: boolean;
  canManageTemplates: boolean;

  canManageWebhooks: boolean;

  /** Team Leader/Agent domain-management capability, including self-service. */
  canManageTeam: boolean;

  /** Global Team Leader/Agent principal administration. */
  canManagePrincipals: boolean;

  canManageApiKeys: boolean;

  canReadAudit: boolean;

  /** Read system-wide aggregate statistics. */
  canReadGlobalStats: boolean;

  canManagePlugins: boolean;

  canManageInfrastructure: boolean;
}

export interface RoleContextType extends RoleCapabilities {
  role: UserRole | null;

  setRole: (role: UserRole | null) => void;

  isAdmin: boolean;
  isOperator: boolean;
  isViewer: boolean;
  isTeamLeader: boolean;
  isAgent: boolean;
}
