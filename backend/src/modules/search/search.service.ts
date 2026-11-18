import {
  Injectable,
  NotImplementedException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  DataSource,
  In,
} from 'typeorm';

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
import { SessionTombstone } from '../session/entities/session-tombstone.entity';

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
     * Aggregate/global route tenancy.
     *
     * Resolve the authenticated principal's effective SessionScope
     * into concrete session IDs BEFORE crossing the provider
     * boundary. Historical message rows whose live Session has been
     * deleted remain eligible through session_tombstones.
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
       *
       * The ceiling is already authoritative and may legitimately
       * refer to a deleted Session whose historical rows still exist.
       */
      case SessionScopeType.IDS:
        return [
          ...scope.sessionIds,
        ];

      /*
       * Team Leader ownership scope.
       *
       * Include live Sessions owned by the Team Leader plus deleted
       * Session identities retained in session_tombstones. A live
       * Session always wins over a stale tombstone with the same id.
       */
      case SessionScopeType.OWNER:
        return this.resolveOwnedSessionIds(
          scope.ownerTeamLeaderId,
        );

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

        return this.resolveOwnedSessionIds(
          scope.ownerTeamLeaderId,
          scope.sessionIds,
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
   * Resolve Team Leader ownership across both the live Session table and the durable deleted-session
   * identity table.
   *
   * Live Session ownership is authoritative. A tombstone is admitted only when no live Session with
   * the same UUID exists, which prevents an old owner from regaining search access after a restore or
   * re-import recreates that UUID under a different Team Leader.
   */
  private async resolveOwnedSessionIds(
    ownerTeamLeaderId: string,
    ceiling?: readonly string[],
  ): Promise<string[]> {
    const sessionRepository =
      this.dataSource.getRepository(
        Session,
      );

    const tombstoneRepository =
      this.dataSource.getRepository(
        SessionTombstone,
      );

    const liveWhere = ceiling
      ? {
          ownerTeamLeaderId,
          id: In([...ceiling]),
        }
      : {
          ownerTeamLeaderId,
        };

    const tombstoneWhere = ceiling
      ? {
          ownerTeamLeaderId,
          sessionId: In([...ceiling]),
        }
      : {
          ownerTeamLeaderId,
        };

    const [ownedLiveSessions, ownedTombstones] =
      await Promise.all([
        sessionRepository.find({
          select: {
            id: true,
          },
          where: liveWhere,
        }),
        tombstoneRepository.find({
          select: {
            sessionId: true,
          },
          where: tombstoneWhere,
        }),
      ]);

    const ownedLiveIds =
      new Set(
        ownedLiveSessions.map(
          sessionEntity =>
            sessionEntity.id,
        ),
      );

    if (
      ownedTombstones.length === 0
    ) {
      return [
        ...ownedLiveIds,
      ];
    }

    const tombstoneIds = [
      ...new Set(
        ownedTombstones.map(
          tombstone =>
            tombstone.sessionId,
        ),
      ),
    ];

    /*
     * Query live existence irrespective of owner. These rows are excluded from tombstone ownership
     * even when the current live owner is different from ownerTeamLeaderId.
     */
    const liveRowsForTombstones =
      await sessionRepository.find({
        select: {
          id: true,
        },
        where: {
          id: In(tombstoneIds),
        },
      });

    const allLiveTombstoneIds =
      new Set(
        liveRowsForTombstones.map(
          sessionEntity =>
            sessionEntity.id,
        ),
      );

    for (const tombstoneId of tombstoneIds) {
      if (
        !allLiveTombstoneIds.has(
          tombstoneId,
        )
      ) {
        ownedLiveIds.add(
          tombstoneId,
        );
      }
    }

    return [
      ...ownedLiveIds,
    ];
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
