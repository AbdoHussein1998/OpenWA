import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  ApiKey,
  ApiKeyRole,
} from '../auth/entities/api-key.entity';
import { Session } from '../session/entities/session.entity';
import { Agent } from '../teamleader/entities/agent.entity';

import {
  SessionScope,
  SessionScopeType,
  SessionScopes,
} from './session-scope';

/**
 * Central authority for tenant-aware WhatsApp session access.
 *
 * This service answers two related questions:
 *
 * 1. What is the effective set of sessions this API key may access?
 * 2. May this API key access this specific session?
 *
 * The effective scope is always:
 *
 *   role / tenant scope
 *   INTERSECT
 *   allowedSessions, when allowedSessions is non-empty
 *
 * REST, WebSocket and MCP adapters should all use this service rather
 * than implementing their own Team Leader / Agent ownership checks.
 */
@Injectable()
export class SessionTenantAccessService {
  constructor(
    @InjectRepository(Agent, 'main')
    private readonly agentRepository: Repository<Agent>,

    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
  ) {}

  /**
   * Resolve the effective session scope for an authenticated API key.
   *
   * Legacy roles preserve the existing allowedSessions behavior:
   *
   *   ADMIN / OPERATOR / VIEWER
   *     no allowedSessions -> ALL
   *     allowedSessions    -> IDS(...)
   *
   * Team Leader:
   *
   *     no allowedSessions -> OWNER(teamLeaderId)
   *     allowedSessions    -> OWNER_AND_IDS(teamLeaderId, ...)
   *
   * Agent:
   *
   *     no assignment      -> NONE
   *     assignment         -> OWNER_AND_IDS(teamLeaderId, [assignment])
   *
   * An Agent's assignment is never copied into allowedSessions.
   */
  async getEffectiveSessionScope(apiKey: ApiKey): Promise<SessionScope> {
    const allowedSessionIds = this.getAllowedSessionIds(apiKey);

    switch (apiKey.role) {
      case ApiKeyRole.ADMIN:
      case ApiKeyRole.OPERATOR:
      case ApiKeyRole.VIEWER:
        return allowedSessionIds
          ? SessionScopes.ids(allowedSessionIds)
          : SessionScopes.all();

      case ApiKeyRole.TEAM_LEADER:
        return this.getTeamLeaderScope(apiKey, allowedSessionIds);

      case ApiKeyRole.AGENT:
        return this.getAgentScope(apiKey, allowedSessionIds);

      default:
        // Fail closed if the database ever contains an unknown role.
        throw new ForbiddenException('Unsupported API key role');
    }
  }

  /**
   * Assert that the caller may access one concrete session.
   *
   * Returns the already-loaded Session so callers that need the entity
   * do not have to immediately perform the same database lookup again.
   *
   * Tenant/session mismatches intentionally return 404 so callers cannot
   * distinguish a foreign session from a nonexistent session.
   */
  async assertSessionAccess(
    apiKey: ApiKey,
    sessionId: string,
  ): Promise<Session> {
    const scope = await this.getEffectiveSessionScope(apiKey);

    switch (scope.type) {
      case SessionScopeType.NONE:
        throw this.sessionNotFound();

      case SessionScopeType.ALL:
        return this.findSessionOrThrow(sessionId);

      case SessionScopeType.IDS:
        if (!scope.sessionIds.includes(sessionId)) {
          throw this.sessionNotFound();
        }

        return this.findSessionOrThrow(sessionId);

      case SessionScopeType.OWNER: {
        const session = await this.findSessionOrThrow(sessionId);

        if (
          session.ownerTeamLeaderId !== scope.ownerTeamLeaderId
        ) {
          throw this.sessionNotFound();
        }

        return session;
      }

      case SessionScopeType.OWNER_AND_IDS: {
        // Check the explicit ID ceiling first.
        if (!scope.sessionIds.includes(sessionId)) {
          throw this.sessionNotFound();
        }

        const session = await this.findSessionOrThrow(sessionId);

        // Defense-in-depth: satisfying the ID restriction alone is not
        // sufficient. Ownership must also match.
        if (
          session.ownerTeamLeaderId !== scope.ownerTeamLeaderId
        ) {
          throw this.sessionNotFound();
        }

        return session;
      }

      default:
        return this.assertNever(scope);
    }
  }

  /**
   * Whether this identity truly has unrestricted access to every session.
   *
   * This will later be useful for WebSocket wildcard subscriptions.
   *
   * TEAM_LEADER and AGENT can never resolve to ALL.
   */
  async hasGlobalSessionAccess(apiKey: ApiKey): Promise<boolean> {
    const scope = await this.getEffectiveSessionScope(apiKey);

    return scope.type === SessionScopeType.ALL;
  }

  private getTeamLeaderScope(
    apiKey: ApiKey,
    allowedSessionIds: readonly string[] | null,
  ): SessionScope {
    if (!apiKey.teamLeaderId) {
      throw new ForbiddenException(
        'Team Leader API key is missing its principal binding',
      );
    }

    if (allowedSessionIds) {
      return SessionScopes.ownerAndIds(
        apiKey.teamLeaderId,
        allowedSessionIds,
      );
    }

    return SessionScopes.owner(apiKey.teamLeaderId);
  }

  private async getAgentScope(
    apiKey: ApiKey,
    allowedSessionIds: readonly string[] | null,
  ): Promise<SessionScope> {
    if (!apiKey.agentId) {
      throw new ForbiddenException(
        'Agent API key is missing its principal binding',
      );
    }

    const agent = await this.agentRepository.findOne({
      where: {
        id: apiKey.agentId,
      },
    });

    if (!agent) {
      // The credential points at a principal that no longer exists.
      // Treat this as an invalid authorization binding, not as a tenant
      // lookup failure.
      throw new ForbiddenException(
        'Agent API key has an invalid principal binding',
      );
    }

    if (!agent.assignedSessionId) {
      return SessionScopes.none();
    }

    /*
     * allowedSessions remains a hard ceiling.
     *
     * Example:
     *
     *   Agent assigned B
     *   allowedSessions = [A]
     *
     * Effective scope = NONE
     *
     * We intentionally do NOT mutate allowedSessions to reflect the
     * Agent assignment; assignedSessionId remains the single source
     * of truth.
     */
    if (
      allowedSessionIds &&
      !allowedSessionIds.includes(agent.assignedSessionId)
    ) {
      return SessionScopes.none();
    }

    /*
     * Always preserve BOTH Agent restrictions:
     *
     *   session.id = assignedSessionId
     *   AND
     *   session.ownerTeamLeaderId = agent.teamLeaderId
     *
     * This prevents a corrupt/mistaken assignment from bridging
     * Team Leaders.
     */
    return SessionScopes.ownerAndIds(
      agent.teamLeaderId,
      [agent.assignedSessionId],
    );
  }

  /**
   * Normalize allowedSessions.
   *
   * null / undefined / [] means "no additional ceiling".
   *
   * A non-empty array means the caller's effective tenant scope must
   * be intersected with these IDs.
   */
  private getAllowedSessionIds(
    apiKey: ApiKey,
  ): readonly string[] | null {
    const sessionIds = (apiKey.allowedSessions ?? []).filter(
      sessionId => Boolean(sessionId),
    );

    return sessionIds.length > 0
      ? [...new Set(sessionIds)]
      : null;
  }

  /**
   * Load a session without revealing whether authorization failed
   * because the ID was nonexistent or belonged to another tenant.
   */
  private async findSessionOrThrow(
    sessionId: string,
  ): Promise<Session> {
    const session = await this.sessionRepository.findOne({
      where: {
        id: sessionId,
      },
    });

    if (!session) {
      throw this.sessionNotFound();
    }

    return session;
  }

  private sessionNotFound(): NotFoundException {
    return new NotFoundException('Session not found');
  }

  /**
   * Compile-time exhaustiveness protection.
   *
   * Adding another SessionScope variant without handling it in
   * assertSessionAccess() will produce a TypeScript error here.
   */
  private assertNever(value: never): never {
    throw new ForbiddenException(
      `Unsupported session scope: ${JSON.stringify(value)}`,
    );
  }
}