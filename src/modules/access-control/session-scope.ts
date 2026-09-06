/**
 * Describes the effective set of WhatsApp sessions an authenticated
 * principal may access.
 *
 * This is intentionally independent from HTTP, WebSocket, MCP and TypeORM.
 * Protocol adapters and services consume this scope and translate it into
 * the appropriate authorization/query constraints.
 *
 * IMPORTANT:
 * OWNER_AND_IDS always means:
 *
 *   ownerTeamLeaderId = :owner
 *   AND
 *   id IN (:...sessionIds)
 *
 * It must never be translated into an OR query.
 */

export enum SessionScopeType {
  ALL = 'all',
  NONE = 'none',
  IDS = 'ids',
  OWNER = 'owner',
  OWNER_AND_IDS = 'owner_and_ids',
}

/**
 * Unrestricted session access.
 *
 * Intended for identities whose effective scope is truly global.
 */
export interface AllSessionScope {
  type: SessionScopeType.ALL;
}

/**
 * No session access.
 *
 * Examples:
 * - unassigned Agent;
 * - Agent whose allowedSessions excludes their assignment;
 * - an effective intersection that results in zero sessions.
 */
export interface NoSessionScope {
  type: SessionScopeType.NONE;
}

/**
 * Access is restricted to an explicit set of session IDs.
 *
 * Primarily represents the existing allowedSessions ceiling for
 * legacy identities.
 */
export interface SessionIdsScope {
  type: SessionScopeType.IDS;
  sessionIds: readonly string[];
}

/**
 * Access is restricted to sessions owned by one Team Leader.
 */
export interface SessionOwnerScope {
  type: SessionScopeType.OWNER;
  ownerTeamLeaderId: string;
}

/**
 * Access is restricted by BOTH Team Leader ownership and an explicit
 * set of session IDs.
 *
 * This represents:
 *
 *   tenant ownership
 *   INTERSECT
 *   allowedSessions
 */
export interface SessionOwnerAndIdsScope {
  type: SessionScopeType.OWNER_AND_IDS;
  ownerTeamLeaderId: string;
  sessionIds: readonly string[];
}

/**
 * Complete tenant-aware session scope.
 */
export type SessionScope =
  | AllSessionScope
  | NoSessionScope
  | SessionIdsScope
  | SessionOwnerScope
  | SessionOwnerAndIdsScope;

/**
 * Small constructors keep scope creation consistent throughout the
 * authorization layer.
 */
export const SessionScopes = {
  all(): AllSessionScope {
    return {
      type: SessionScopeType.ALL,
    };
  },

  none(): NoSessionScope {
    return {
      type: SessionScopeType.NONE,
    };
  },

  ids(sessionIds: readonly string[]): SessionIdsScope | NoSessionScope {
    if (sessionIds.length === 0) {
      return this.none();
    }

    return {
      type: SessionScopeType.IDS,
      sessionIds: [...new Set(sessionIds)],
    };
  },

  owner(ownerTeamLeaderId: string): SessionOwnerScope {
    return {
      type: SessionScopeType.OWNER,
      ownerTeamLeaderId,
    };
  },

  ownerAndIds(
    ownerTeamLeaderId: string,
    sessionIds: readonly string[],
  ): SessionOwnerAndIdsScope | NoSessionScope {
    if (sessionIds.length === 0) {
      return this.none();
    }

    return {
      type: SessionScopeType.OWNER_AND_IDS,
      ownerTeamLeaderId,
      sessionIds: [...new Set(sessionIds)],
    };
  },
} as const;