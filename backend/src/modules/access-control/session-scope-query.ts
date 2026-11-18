import { ForbiddenException } from '@nestjs/common';
import { SessionScopeType, type SessionScope } from './session-scope';

/**
 * Translate a fully resolved effective scope into an ID predicate for queries
 * whose underlying rows only store sessionId (e.g. audit_logs).
 *
 * null = no ID filter; [] = deny; nonempty array = allowed session IDs.
 * Owner scopes MUST be materialized by the tenant-access service first: such
 * tables do not themselves contain an authoritative owner column.
 */
export function allowedSessionIdsForQuery(
  scope: SessionScope,
  requestedSessionId?: string,
): readonly string[] | null {
  if (!scope) {
    throw new ForbiddenException('An effective session scope is required');
  }
  switch (scope.type) {
    case SessionScopeType.ALL:
      return requestedSessionId ? [requestedSessionId] : null;
    case SessionScopeType.NONE:
      return [];
    case SessionScopeType.IDS:
      return requestedSessionId
        ? (scope.sessionIds.includes(requestedSessionId) ? [requestedSessionId] : [])
        : scope.sessionIds;
    case SessionScopeType.OWNER:
    case SessionScopeType.OWNER_AND_IDS:
      throw new ForbiddenException('Owner-scoped queries require verified historical session IDs');
    default:
      return assertNever(scope);
  }
}

function assertNever(value: never): never {
  throw new ForbiddenException(`Unsupported session scope: ${JSON.stringify(value)}`);
}
