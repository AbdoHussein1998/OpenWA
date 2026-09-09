

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
 * These flags only control dashboard behavior and visibility. Backend
 * NestJS authorization remains authoritative.
 *
 * `canWrite` is retained for backwards compatibility with existing
 * dashboard components and deliberately remains limited to the legacy
 * Admin/Operator behavior. New code should prefer the specific
 * capability that matches the operation being rendered.
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

  canManageTeam: boolean;

  canManageApiKeys: boolean;

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



