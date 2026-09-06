


import { Injectable, NotImplementedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { SearchProviderRegistry } from './search-provider.registry';
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_LIMIT_MAX,
  SEARCH_OFFSET_MAX,
} from './search.constants';

import type { SearchQuery, SearchResults } from './search.types';
import type { SessionScope } from '../access-control/session-scope';

import { Session } from '../session/entities/session.entity';

@Injectable()
export class SearchService {
  constructor(
    private readonly registry: SearchProviderRegistry,

    @InjectDataSource('data')
    private readonly dataSource: DataSource,
  ) {}

  async search(
    query: SearchQuery,
    sessionScope: SessionScope,
  ): Promise<SearchResults> {
    const provider = this.registry.active();

    if (!provider) {
      throw new NotImplementedException(
        'Search is not configured (no active search provider).',
      );
    }

    /*
     * Phase H — aggregate/global route tenancy.
     *
     * Resolve the authenticated principal's effective SessionScope into
     * concrete session IDs BEFORE crossing the provider boundary.
     *
     * undefined:
     *   unrestricted / ALL
     *
     * []:
     *   explicitly no accessible sessions / NONE
     */
    const effectiveSessionIds =
      await this.resolveSessionScope(sessionScope);

    /*
     * `query.sessionId` comes from the HTTP query and is therefore only
     * allowed to NARROW the authenticated scope.
     *
     * It must never replace or widen SessionScope.
     */
    const providerSessionIds = this.intersectRequestedSession(
      effectiveSessionIds,
      query.sessionId,
    );

    /*
     * Fail closed.
     *
     * Do not send an empty scope to a provider. Some providers may treat
     * an empty sessionIds array the same as "no filter", which could turn
     * NONE into global access.
     *
     * Returning locally also prevents plugin search providers from seeing
     * a query belonging to a tenant with no accessible sessions.
     */
    if (
      providerSessionIds !== undefined &&
      providerSessionIds.length === 0
    ) {
      return {
        hits: [],
        total: 0,
        tookMs: 0,
        provider: provider.id,
      };
    }

    /*
     * Auth scoping is authoritative.
     *
     * Spread the caller query first, then overwrite sessionIds so transport
     * input can never control the provider's tenant boundary.
     *
     * Pagination is still capped host-side for every provider.
     */
    const scoped: SearchQuery = {
      ...query,

      sessionIds: providerSessionIds,

      limit: Math.min(
        query.limit ?? SEARCH_DEFAULT_LIMIT,
        SEARCH_LIMIT_MAX,
      ),

      offset: Math.min(
        query.offset ?? 0,
        SEARCH_OFFSET_MAX,
      ),
    };

    return provider.search(scoped);
  }

  private async resolveSessionScope(
    scope: SessionScope,
  ): Promise<string[] | undefined> {
    const sessionRepository =
      this.dataSource.getRepository(Session);

    switch (scope.kind) {
      /*
       * Global legacy/admin scope.
       *
       * undefined intentionally means "do not add a sessionIds filter".
       */
      case 'ALL':
        return undefined;

      /*
       * Legacy allowedSessions scope.
       */
      case 'IDS':
        return [...scope.ids];

      /*
       * Team Leader scope:
       *
       * only sessions owned by this Team Leader.
       */
      case 'OWNER': {
        const sessions = await sessionRepository.find({
          select: {
            id: true,
          },
          where: {
            ownerTeamLeaderId: scope.ownerTeamLeaderId,
          },
        });

        return sessions.map((session) => session.id);
      }

      /*
       * OWNER_AND_IDS is an intersection, NEVER a union.
       *
       * Required rule:
       *
       * ownerTeamLeaderId = owner
       * AND
       * id IN (...)
       *
       * Used for:
       * - Team Leader + allowedSessions ceiling
       * - Agent assigned-session scope
       */
      case 'OWNER_AND_IDS': {
        if (scope.ids.length === 0) {
          return [];
        }

        const rows = await sessionRepository
          .createQueryBuilder('session')
          .select('session.id', 'id')
          .where(
            'session.ownerTeamLeaderId = :ownerTeamLeaderId',
            {
              ownerTeamLeaderId:
                scope.ownerTeamLeaderId,
            },
          )
          .andWhere(
            'session.id IN (:...sessionIds)',
            {
              sessionIds: scope.ids,
            },
          )
          .getRawMany<{ id: string }>();

        return rows.map((row) => row.id);
      }

      /*
       * Explicit fail-closed scope.
       */
      case 'NONE':
        return [];

      default: {
        /*
         * Compile-time exhaustiveness protection.
         *
         * Adding a new SessionScope variant later must force this service
         * to decide how that variant maps to search authorization rather
         * than accidentally treating it as ALL.
         */
        const exhaustiveCheck: never = scope;
        return exhaustiveCheck;
      }
    }
  }

  private intersectRequestedSession(
    effectiveSessionIds: string[] | undefined,
    requestedSessionId?: string,
  ): string[] | undefined {
    /*
     * No ?sessionId= supplied:
     *
     * preserve the caller's complete effective scope.
     */
    if (!requestedSessionId) {
      return effectiveSessionIds;
    }

    /*
     * ALL + ?sessionId=x
     *
     * The caller is globally authorized but voluntarily narrows the search
     * to one session.
     */
    if (effectiveSessionIds === undefined) {
      return [requestedSessionId];
    }

    /*
     * Scoped principal + ?sessionId=x
     *
     * x survives ONLY when it is already inside the authenticated scope.
     *
     * Foreign session:
     *   -> []
     *   -> fail closed before provider.search()
     */
    return effectiveSessionIds.includes(requestedSessionId)
      ? [requestedSessionId]
      : [];
  }

  async health() {
    const provider = this.registry.active();

    if (!provider) {
      return {
        ok: false,
        detail: 'no provider',
      };
    }

    return provider.health();
  }
}


