
// Role types for RBAC

export type UserRole =
  | 'admin'
  | 'operator'
  | 'viewer'
  | 'team_leader'
  | 'agent';

export interface RoleContextType {
  role: UserRole | null;

  setRole: (role: UserRole | null) => void;

  isAdmin: boolean;

  isOperator: boolean;

  isViewer: boolean;

  isTeamLeader: boolean;

  isAgent: boolean;

  /**
   * Legacy broad write flag.
   *
   * Keep this limited to the existing admin/operator behavior.
   * New Team Leader and Agent features should use the explicit
   * capability flags below instead.
   */
  canWrite: boolean;

  canManageSessions: boolean;

  canReadSessions: boolean;

  canOperateChats: boolean;

  canSendMessages: boolean;

  canManageTeam: boolean;

  canManageApiKeys: boolean;

  canManageInfrastructure: boolean;
}



