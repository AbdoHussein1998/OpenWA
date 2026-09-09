


import {
  useCallback,
  useMemo,
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
  getRoleCapabilities,
} from '../utils/roleAccess';

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

  /**
   * Capabilities are resolved from one centralized matrix instead of
   * being duplicated in this provider. That keeps route visibility and
   * component-level permission checks in sync.
   */
  const capabilities =
    getRoleCapabilities(role);

  const value =
    useMemo<RoleContextType>(
      () => ({
        role,

        setRole,

        isAdmin:
          role === 'admin',

        isOperator:
          role === 'operator',

        isViewer:
          role === 'viewer',

        isTeamLeader:
          role === 'team_leader',

        isAgent:
          role === 'agent',

        ...capabilities,
      }),
      [
        capabilities,
        role,
        setRole,
      ],
    );

  return (
    <RoleContext.Provider value={value}>
      {children}
    </RoleContext.Provider>
  );
}



