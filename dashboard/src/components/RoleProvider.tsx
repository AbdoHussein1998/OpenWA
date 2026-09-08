

import {
  useCallback,
  useState,
  type ReactNode,
} from 'react';

import type {
  RoleContextType,
  UserRole,
} from '../types/role';

import {
  isUserRole,
} from '../utils/authLifecycle';

import {
  RoleContext,
} from '../hooks/useRole';

export function RoleProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [role, setRoleState] =
    useState<UserRole | null>(() => {
      const saved =
        localStorage.getItem(
          'openwa_user_role',
        );

      if (!saved) {
        return null;
      }

      if (isUserRole(saved)) {
        return saved;
      }

      /**
       * Do not trust arbitrary/stale values from localStorage.
       *
       * This also cleans up roles left behind by an older or malformed
       * dashboard build.
       */
      localStorage.removeItem(
        'openwa_user_role',
      );

      return null;
    });

  const setRole = useCallback(
    (newRole: UserRole | null) => {
      setRoleState(newRole);

      if (newRole) {
        localStorage.setItem(
          'openwa_user_role',
          newRole,
        );
      } else {
        localStorage.removeItem(
          'openwa_user_role',
        );
      }
    },
    [],
  );

  const isAdmin =
    role === 'admin';

  const isOperator =
    role === 'operator';

  const isViewer =
    role === 'viewer';

  const isTeamLeader =
    role === 'team_leader';

  const isAgent =
    role === 'agent';

  const value: RoleContextType = {
    role,

    setRole,

    isAdmin,

    isOperator,

    isViewer,

    isTeamLeader,

    isAgent,

    /**
     * Preserve the legacy meaning of canWrite.
     *
     * Team Leaders and Agents use the more specific capabilities below,
     * preventing an Agent from accidentally receiving session-lifecycle
     * controls simply because they are allowed to send messages.
     */
    canWrite:
      isAdmin ||
      isOperator,

    canManageSessions:
      isAdmin ||
      isOperator ||
      isTeamLeader,

    canReadSessions:
      isAdmin ||
      isOperator ||
      isViewer ||
      isTeamLeader ||
      isAgent,

    canOperateChats:
      isAdmin ||
      isOperator ||
      isTeamLeader ||
      isAgent,

    canSendMessages:
      isAdmin ||
      isOperator ||
      isTeamLeader ||
      isAgent,

    canManageTeam:
      isAdmin ||
      isTeamLeader,

    canManageApiKeys:
      isAdmin,

    canManageInfrastructure:
      isAdmin,
  };

  return (
    <RoleContext.Provider value={value}>
      {children}
    </RoleContext.Provider>
  );
}


