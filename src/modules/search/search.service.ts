


import {
  Injectable,
  NotImplementedException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { SearchProviderRegistry } from './search-provider.registry';
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_LIMIT_MAX,
  SEARCH_OFFSET_MAX,
} from './search.constants';

import type {
  SearchQuery,
  SearchResults,
} from './search.types';

import {
  SessionScopeType,
  type SessionScope,
} from '../access-control/session-scope';

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
    const provider =
      this.registry.active();

    if (!provider) {
      throw new NotImplementedException(
        'Search is not configured (no active search provider).',
      );
    }

    /*
     * Phase H — aggregate/global route tenancy.
     *
     * Resolve the authenticated principal's effective SessionScope
     * into concrete session IDs BEFORE crossing the provider
     * boundary.
     *
     * undefined:
     *   unrestricted / ALL
     *
     * []:
     *   explicitly no accessible sessions / NONE
     */
    const effectiveSessionIds =
      await this.resolveSessionScope(
        sessionScope,
      );

    /*
     * query.sessionId comes from the transport layer.
     *
     * It is allowed only to NARROW the already-authenticated
     * effective tenant scope.
     *
     * It must never replace or widen SessionScope.
     */
    const providerSessionIds =
      this.intersectRequestedSession(
        effectiveSessionIds,
        query.sessionId,
      );

    /*
     * Fail closed.
     *
     * Do not send an empty sessionIds array to the provider.
     *
     * A provider could potentially interpret:
     *
     * []
     *
     * as:
     *
     * "no filter"
     *
     * which would accidentally turn NONE into global access.
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
     * Authorization scoping is authoritative.
     *
     * Spread the caller query first and overwrite sessionIds
     * afterwards so caller-controlled transport data can never
     * broaden the provider's tenant boundary.
     */
    const scoped: SearchQuery = {
      ...query,

      sessionIds:
        providerSessionIds,

      limit: Math.min(
        query.limit ??
          SEARCH_DEFAULT_LIMIT,
        SEARCH_LIMIT_MAX,
      ),

      offset: Math.min(
        query.offset ?? 0,
        SEARCH_OFFSET_MAX,
      ),
    };

    return provider.search(
      scoped,
    );
  }

  /**
   * Convert tenant-aware SessionScope into the concrete session IDs
   * that may be passed to a search provider.
   *
   * Return semantics:
   *
   * undefined:
   *   ALL / unrestricted
   *
   * []:
   *   NONE / no accessible sessions
   *
   * string[]:
   *   concrete effective tenant scope
   */
  private async resolveSessionScope(
    scope: SessionScope,
  ): Promise<string[] | undefined> {
    const sessionRepository =
      this.dataSource.getRepository(
        Session,
      );

    switch (scope.type) {
      /*
       * ADMIN / unrestricted legacy scope.
       *
       * undefined intentionally means that no sessionIds
       * filter should be applied at the provider boundary.
       */
      case SessionScopeType.ALL:
        return undefined;

      /*
       * Legacy allowedSessions ceiling.
       */
      case SessionScopeType.IDS:
        return [
          ...scope.sessionIds,
        ];

      /*
       * Team Leader ownership scope.
       *
       * Only sessions owned by this Team Leader are visible.
       */
      case SessionScopeType.OWNER: {
        const sessions =
          await sessionRepository.find({
            select: {
              id: true,
            },

            where: {
              ownerTeamLeaderId:
                scope.ownerTeamLeaderId,
            },
          });

        return sessions.map(
          sessionEntity =>
            sessionEntity.id,
        );
      }

      /*
       * OWNER_AND_IDS is an INTERSECTION.
       *
       * NEVER change this into a union.
       *
       * Required authorization rule:
       *
       * ownerTeamLeaderId = :ownerTeamLeaderId
       *
       * AND
       *
       * session.id IN (:...sessionIds)
       *
       * This supports:
       *
       * - Team Leader ownership + allowedSessions ceiling
       * - Agent ownership + assigned-session ceiling
       */
      case SessionScopeType
        .OWNER_AND_IDS: {
        if (
          scope.sessionIds.length === 0
        ) {
          return [];
        }

        const rows =
          await sessionRepository
            .createQueryBuilder(
              'session',
            )
            .select(
              'session.id',
              'id',
            )
            .where(
              'session.ownerTeamLeaderId = :ownerTeamLeaderId',
              {
                ownerTeamLeaderId:
                  scope
                    .ownerTeamLeaderId,
              },
            )
            .andWhere(
              'session.id IN (:...sessionIds)',
              {
                sessionIds:
                  scope.sessionIds,
              },
            )
            .getRawMany<{
              id: string;
            }>();

        return rows.map(
          row => row.id,
        );
      }

      /*
       * Explicit no-access scope.
       */
      case SessionScopeType.NONE:
        return [];

      default: {
        /*
         * Compile-time exhaustiveness protection.
         *
         * If another SessionScope variant is introduced,
         * TypeScript should force this service to explicitly
         * define how that variant behaves.
         */
        const exhaustiveCheck:
          never = scope;

        return exhaustiveCheck;
      }
    }
  }

  /**
   * An optional requested sessionId can only NARROW the
   * authenticated tenant scope.
   *
   * It can never expand it.
   */
  private intersectRequestedSession(
    effectiveSessionIds:
      | string[]
      | undefined,
    requestedSessionId?: string,
  ): string[] | undefined {
    /*
     * No explicit requested session.
     *
     * Preserve the full authenticated scope.
     */
    if (!requestedSessionId) {
      return effectiveSessionIds;
    }

    /*
     * ALL + requested session.
     *
     * An unrestricted principal voluntarily narrows the operation
     * to one session.
     */
    if (
      effectiveSessionIds ===
      undefined
    ) {
      return [
        requestedSessionId,
      ];
    }

    /*
     * Restricted principal + requested session.
     *
     * The requested ID survives only when it is already contained
     * within the authenticated effective scope.
     *
     * Foreign session:
     *
     * -> []
     * -> fail closed before provider.search()
     */
    return effectiveSessionIds.includes(
      requestedSessionId,
    )
      ? [
          requestedSessionId,
        ]
      : [];
  }

  async health() {
    const provider =
      this.registry.active();

    if (!provider) {
      return {
        ok: false,
        detail: 'no provider',
      };
    }

    return provider.health();
  }
}


