





import {
  HttpException,
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  OnModuleDestroy,
  OnModuleInit,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InjectRepository,
  InjectDataSource,
} from '@nestjs/typeorm';
import {
  Repository,
  In,
  Not,
  IsNull,
  DataSource,
  SelectQueryBuilder,
} from 'typeorm';
import {
  SessionScope,
  SessionScopeType,
} from '../access-control/session-scope';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { setTimeout } from 'node:timers/promises';

import { EngineTransportError } from '../../common/errors/engine-transport.error';

import {
  Session,
  SessionStatus,
} from './entities/session.entity';

import {
  CreateSessionDto,
  SessionConfigResponseDto,
  UpdateSessionConfigDto,
} from './dto';

import {
  Agent,
} from '../teamleader/entities/agent.entity';

import { EngineRegistry } from '../../engine/engine-registry.service';
import { SessionLivenessWatchdog } from './session-liveness-watchdog.service';
import { SessionErrorStore } from './session-error-store.service';
import { SessionRestrictionStore } from './session-restriction-store.service';
import {
  PresenceStore,
  type ChatPresence,
} from './presence-store.service';
import {
  SessionEngineLifecycle,
  resolveReconnectConfig,
} from './session-engine-lifecycle.service';
import { SessionOwnershipService } from './session-ownership.service';

import {
  paginate,
  ListOptions,
  resolveListWindow,
} from '../../common/utils/paginate';

import { isUniqueViolation } from '../../common/utils/db-errors';
import { resolveFeatureFlags } from '../../config/feature-flags';

import {
  IWhatsAppEngine,
  EngineStatus,
  ChatSummary,
  ChatState,
} from '../../engine/interfaces/whatsapp-engine.interface';

import { createLogger } from '../../common/services/logger.service';
import { HookManager } from '../../core/hooks';

// Type-only: the module binds this class to PLUGIN_SESSION_PORT with a `useExisting` alias, which
// TypeScript does not check, so `implements` is what keeps the two in step.
import type {
  PluginSessionPort,
} from '../../core/plugins/plugin-host-ports';

/**
 * Stagger before the single transient-launch retry; short -
 * the claim is held while it waits.
 */
const SESSION_START_RETRY_DELAY_MS =
  2_000;

/**
 * Driver codes meaning "locked, try again", not "your query is wrong".
 *
 * These are unreachable through the message regex below, which is why the code is read separately.
 * better-sqlite3 reports lock contention as `code: 'SQLITE_BUSY'` with the message `database is
 * locked`, and TypeORM's QueryFailedError copies the driver's own properties onto itself while
 * rewriting the message to `SqliteError: database is locked`. So the code survives the wrap and the
 * token never appears in any message: matching `SQLITE_BUSY` as text could not fire on either shape.
 */
const TRANSIENT_DB_CODES =
  new Set([
    'SQLITE_BUSY',
    'SQLITE_LOCKED',
  ]);

/**
 * A launch failure worth one retry: infrastructure said "not now" (a 5xx, a transport death, a
 * database error while persisting status), not the session or the caller being refused. HTTP 4xx
 * and the documented 409 not-ready are deliberate answers, and a lost-claim ConflictException is a
 * real conflict.
 */
function isTransientLaunchFailure(
  error: unknown,
): boolean {
  // EngineTransportError (503) is the one mapped HTTP shape that means infrastructure died
  // mid-launch (dead page/socket at initialize). Every OTHER HttpException is a deliberate
  // answer: the 409 not-ready family reflects session state, the 504 auth-timeout family
  // reflects the account/proxy, and a 4xx is a refusal. The explicit early-exit (not a message
  // regex relying on the 504 texts never containing 'connection') pins that intent.
  if (
    error instanceof
    EngineTransportError
  ) {
    return true;
  }

  if (
    error instanceof
    HttpException
  ) {
    return false;
  }

  // TypeORM QueryFailedError and driver errors carry no HttpException shape.
  if (!(error instanceof Error)) {
    return false;
  }

  const code: unknown =
    (
      error as {
        code?: unknown;
      }
    ).code;

  if (
    typeof code === 'string' &&
    TRANSIENT_DB_CODES.has(code)
  ) {
    return true;
  }

  return /connection|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|terminating connection/i.test(
    error.message,
  );
}

/**
 * Pause between sequential auto-start launches so a burst of Chromium boots does not spike the host.
 */
export const AUTOSTART_THROTTLE_MS =
  2_000;

export interface CreateSessionOptions {
  /**
   * Tenant owner supplied from authenticated server context.
   *
   * null means a legacy/non-Team-Leader-owned session.
   */
  ownerTeamLeaderId?: string | null;
}

/**
 * The session-record API: CRUD over the sessions table, aggregate stats, and the thin engine query
 * proxies (QR/pairing/chats/groups/chat-state) behind the controller routes. Every engine LIFECYCLE
 * verb (start/stop/logout/forceKill/delete/stopOrphanEngines), the reconnect machinery, the engine
 * event wiring, and the status broadcast live in SessionEngineLifecycle — the sole writer of the
 * shared EngineRegistry. This service delegates those verbs one-directionally (no forwardRef), so
 * its public surface toward the controller and the feature modules is unchanged by the split.
 */
@Injectable()
export class SessionService
  implements
    OnModuleDestroy,
    OnModuleInit,
    OnApplicationBootstrap,
    PluginSessionPort
{
  private readonly logger =
    createLogger(
      'SessionService',
    );

  // Live engine instances, owned by the shared EngineRegistry (the narrow port feature modules
  // inject instead of this whole service). SessionEngineLifecycle is the only writer; the query
  // proxies below read through this alias.
  private get engines(): EngineRegistry {
    return this.engineRegistry;
  }

  /**
   * The detached auto-start run; see onApplicationBootstrap.
   * Awaited by onModuleDestroy.
   */
  private autoStartRun:
    Promise<void> =
      Promise.resolve();

  /**
   * Set at the top of onModuleDestroy so the detached run stops
   * launching further sessions.
   */
  private shuttingDown =
    false;

  constructor(
    @InjectRepository(
      Session,
      'data',
    )
    private readonly sessionRepository:
      Repository<Session>,

    /**
     * Agent identities live in the `main` database.
     *
     * There intentionally cannot be a database FK from Agent to
     * Session because Session lives in the separate `data` database.
     *
     * This repository is therefore used to clear stale
     * assignedSessionId references after successful Session deletion.
     */
    @InjectRepository(
      Agent,
      'main',
    )
    private readonly agentRepository:
      Repository<Agent>,

    @InjectDataSource('data')
    private readonly dataSource:
      DataSource,

    private readonly engineRegistry:
      EngineRegistry,

    private readonly watchdog:
      SessionLivenessWatchdog,

    private readonly sessionErrors:
      SessionErrorStore,

    private readonly sessionRestrictions:
      SessionRestrictionStore,

    private readonly presence:
      PresenceStore,

    private readonly hookManager:
      HookManager,

    private readonly engineLifecycle:
      SessionEngineLifecycle,

    @Optional()
    private readonly configService?:
      ConfigService,

    // Trailing @Optional, like configService: the running app always provides it, while the
    // direct-construction unit tests omit it — every use below is `?.`-guarded, so a session simply
    // behaves as unowned there, which is what a single-process deployment is anyway.
    @Optional()
    private readonly ownership?:
      SessionOwnershipService,
  ) {}

  /**
   * On startup, mark as disconnected the sessions whose engines this process was running, since no
   * engine survives a restart.
   *
   * Scoped to what this process may claim. An active status means "an engine is running somewhere",
   * and resetting all of them assumed that somewhere was always here — true of a single process,
   * and wrong beside a live peer, whose sessions would be reported disconnected while they are
   * serving traffic. A row held by another node with an unexpired lease is therefore left alone.
   */
  async onModuleInit():
    Promise<void> {
    const activeStatuses = [
      SessionStatus.READY,
      SessionStatus.INITIALIZING,
      SessionStatus.QR_READY,
      SessionStatus.AUTHENTICATING,
      SessionStatus.ACTION_REQUIRED,
    ];

    const claimable =
      this.ownership
        ?.claimableWhere() ??
      [{}];

    const result =
      await this.sessionRepository.update(
        claimable.map(
          clause => ({
            ...clause,

            status:
              In(
                activeStatuses,
              ),
          }),
        ),

        {
          status:
            SessionStatus.DISCONNECTED,
        },
      );

    if (
      result.affected &&
      result.affected > 0
    ) {
      this.logger.log(
        `Reset ${result.affected} session(s) to disconnected on startup`,
        {
          action:
            'startup_reset',

          affected:
            result.affected,

          nodeId:
            this.ownership
              ?.nodeId,
        },
      );
    }
  }

  onApplicationBootstrap():
    void {
    // Start the liveness watchdog FIRST: it must run even when auto-start is disabled (sessions can
    // be started via the API at any time), so it can't sit behind the auto-start early-return below.
    // The watchdog owns the probe cadence and failure counting; a session it proves dead comes
    // back through the same disconnect path an engine-reported drop uses.
    this.watchdog.start(
      (
        id,
        engine,
        reason,
      ) =>
        this.engineLifecycle
          .handleEngineDisconnected(
            id,
            engine,
            reason,
          ),
    );

    // A session this node has lost belongs to a peer now, which is free to start its own engine.
    // Leaving ours running would put two engines on one WhatsApp account — the thing the claim
    // exists to prevent — so the engine goes down. stopOrphanEngines is the right verb: it tears
    // down locally and leaves the row alone, because the row is no longer ours to write.
    // The teardown report is not consulted here: losing a claim is not a request anyone is waiting
    // on, and stopOrphanEngines already logs what it could not stop.
    this.ownership
      ?.onLeaseLoss(
        async ids =>
          void (
            await this
              .engineLifecycle
              .stopOrphanEngines(
                ids,
              )
          ),
      );

    // Claims are only renewed while something still runs for them here, so a claim left behind by
    // an untracked teardown path lapses instead of pinning the session to this node forever.
    this.ownership
      ?.setEngineLiveness(
        id =>
          this.engineLifecycle
            .isEngineActive(
              id,
            ),
      );

    // Renewal runs regardless of auto-start: a session started through the API later is claimed the
    // same way and must keep its lease alive.
    this.ownership
      ?.startHeartbeat();

    if (
      !resolveFeatureFlags(
        this.configService,
      ).autoStartSessions
    ) {
      return;
    }

    // DETACHED, deliberately. Nest binds the HTTP listener only after every onApplicationBootstrap
    // hook has settled, and this loop's duration is unbounded: one engine initialization is at least
    // 60s (resolveEngineInitTimeoutMs) and there is a 2s throttle between sessions, so a host with
    // ten authenticated sessions kept the port CLOSED — not unhealthy, closed — for ten minutes.
    // Every liveness probe in that window is a connection refusal, and no probe budget can cover a
    // bound that scales with the session count: the chart's is ~50s and the Dockerfile HEALTHCHECK
    // encodes the same expectation. Awaited on shutdown so a launch in flight is accounted for.
    this.autoStartRun =
      this.autoStartSessions()
        .catch(
          (
            error:
              unknown,
          ) => {
            // Previously this rejected out of the hook and aborted boot, so a transient database error
            // during the session scan took the whole gateway down rather than the auto-start.
            this.logger.error(
              'Auto-start scan failed',

              error instanceof
                Error
                ? error.message
                : String(
                    error,
                  ),

              {
                action:
                  'auto_start_scan_failed',
              },
            );
          },
        );
  }

  /**
   * Launch every previously authenticated session this node may claim, one at a time.
   *
   * Sequential with a throttle by design — these are Chromium launches — which is exactly why it
   * cannot run inside the bootstrap hook. See onApplicationBootstrap.
   */
  private async autoStartSessions():
    Promise<void> {
    // Restricted to sessions this node may claim. Without it every replica scans the same rows and
    // races to launch the same engines, which is a WhatsApp account being opened twice, not merely
    // duplicated work.
    const claimable =
      this.ownership
        ?.claimableWhere() ??
      [{}];

    const sessions =
      await this.sessionRepository.find(
        {
          where:
            claimable.map(
              clause => ({
                ...clause,

                phone:
                  Not(
                    IsNull(),
                  ),

                status:
                  SessionStatus.DISCONNECTED,
              }),
            ),
        },
      );

    if (
      sessions.length === 0
    ) {
      return;
    }

    this.logger.log(
      `Auto-starting ${sessions.length} previously authenticated session(s)`,
      {
        action:
          'auto_start',

        count:
          sessions.length,
      },
    );

    for (
      let i = 0;
      i < sessions.length;
      i++
    ) {
      // A shutdown landing mid-run must not launch anything further: onModuleDestroy tears down what
      // exists, and a browser launched after that point is never destroyed.
      if (
        this.shuttingDown
      ) {
        this.logger.log(
          `Auto-start stopped at ${i} of ${sessions.length} session(s): shutting down`,
          {
            action:
              'auto_start_aborted',
          },
        );

        return;
      }

      const session =
        sessions[i];

      try {
        await this.start(
          session.id,
        );

        this.logger.log(
          `Auto-started session: ${session.name}`,
          {
            sessionId:
              session.id,

            action:
              'auto_start_success',
          },
        );
      } catch (
        error:
          unknown
      ) {
        const errorMessage =
          error instanceof
          Error
            ? error.message
            : 'Unknown error';

        this.logger.error(
          `Auto-start failed for session: ${session.name}`,
          errorMessage,
          {
            sessionId:
              session.id,

            action:
              'auto_start_failed',
          },
        );
      }

      // Throttle between sequential Chromium launches; no need to wait after the last one.
      if (
        i <
        sessions.length - 1
      ) {
        await setTimeout(
          AUTOSTART_THROTTLE_MS,
        );
      }
    }
  }

  async onModuleDestroy():
    Promise<void> {
    // Stop the watchdog FIRST (before any teardown below can hang): no new probe/disconnect handling
    // may start mid-shutdown. stop() is idempotent, so a second onModuleDestroy call stays safe.
    this.shuttingDown =
      true;

    this.watchdog.stop();

    this.ownership
      ?.stopHeartbeat();

    // A SIGTERM during boot can land while the detached auto-start is mid-launch. Let that one
    // settle — the flag above stops the loop taking another — so the engine it registers is torn
    // down below instead of outliving the process as an orphaned browser. Bounded by the launch
    // already in flight, never by the whole run.
    await this.autoStartRun;

    // Reconnect timers + engine teardown belong to the lifecycle owner.
    await this.engineLifecycle
      .shutdown();

    // Released only after the engines are actually down, so a peer never claims a session this
    // process is still holding open.
    await this.ownership
      ?.releaseAll();
  }

  async create(
    dto: CreateSessionDto,
    options:
      CreateSessionOptions = {},
  ): Promise<Session> {
    // Check if session with same name exists.
    const existing =
      await this.sessionRepository
        .findOne({
          where: {
            name:
              dto.name,
          },
        });

    if (existing) {
      throw new ConflictException(
        `Session with name '${dto.name}' already exists`,
      );
    }

    const session =
      this.sessionRepository.create(
        {
          name:
            dto.name,

          /**
           * Tenant ownership comes only from authenticated
           * server context, never from CreateSessionDto.
           */
          ownerTeamLeaderId:
            options
              .ownerTeamLeaderId ??
            null,

          /**
           * Optional display/intention metadata.
           * Never use targetPhone for authorization.
           */
          targetPhone:
            dto.targetPhone ??
            null,

          config:
            dto.config ||
            {},

          proxyUrl:
            dto.proxyUrl ||
            null,

          proxyType:
            dto.proxyType ||
            null,

          status:
            SessionStatus.CREATED,
        },
      );

    /**
     * The findOne pre-check above is only the common fast path.
     * Concurrent requests may still hit the unique constraint,
     * so preserve the existing 409 translation.
     */
    let saved:
      Session;

    try {
      saved =
        await this.dataSource
          .transaction(
            async manager =>
              manager.save(
                session,
              ),
          );
    } catch (err) {
      if (
        isUniqueViolation(
          err,
        )
      ) {
        throw new ConflictException(
          `Session with name '${dto.name}' already exists`,
        );
      }

      throw err;
    }

    this.logger.log(
      `Session created: ${saved.name}`,
      {
        sessionId:
          saved.id,

        action:
          'create',
      },
    );

    // Hooks run outside the DB transaction because they perform I/O.
    await this.hookManager
      .execute(
        'session:created',
        saved,
        {
          sessionId:
            saved.id,

          source:
            'SessionService',
        },
      );

    return saved;
  }

  async findAll(
    scope:
      SessionScope,
    opts:
      ListOptions = {},
  ): Promise<Session[]> {
    const {
      limit,
      offset,
    } =
      resolveListWindow(
        opts.limit,
        opts.offset,
      );

    const query =
      this.sessionRepository
        .createQueryBuilder(
          'session',
        )
        .orderBy(
          'session.createdAt',
          'DESC',
        )
        .take(limit)
        .skip(offset);

    this.applySessionScope(
      query,
      scope,
    );

    const sessions =
      await query.getMany();

    return sessions.map(
      session =>
        this.attachRuntimeState(
          session,
        ),
    );
  }

  /**
   * Apply an effective tenant session scope to a SQL query.
   *
   * IMPORTANT:
   *
   * OWNER_AND_IDS means:
   *
   *   ownerTeamLeaderId = :owner
   *   AND
   *   id IN (...)
   *
   * Never convert it to TypeORM:
   *
   *   where: [
   *     { ownerTeamLeaderId: ... },
   *     { id: In(...) },
   *   ]
   *
   * because an array of where objects is OR.
   */
  private applySessionScope(
    query:
      SelectQueryBuilder<Session>,
    scope:
      SessionScope,
  ): void {
    switch (
      scope.type
    ) {
      case SessionScopeType.ALL:
        return;

      case SessionScopeType.NONE:
        /**
         * Always false, without relying on an empty IN().
         */
        query.andWhere(
          '1 = 0',
        );
        return;

      case SessionScopeType.IDS:
        query.andWhere(
          'session.id IN (:...scopeSessionIds)',
          {
            scopeSessionIds:
              [
                ...scope.sessionIds,
              ],
          },
        );
        return;

      case SessionScopeType.OWNER:
        query.andWhere(
          'session.ownerTeamLeaderId = :scopeOwnerTeamLeaderId',
          {
            scopeOwnerTeamLeaderId:
              scope.ownerTeamLeaderId,
          },
        );
        return;

      case SessionScopeType.OWNER_AND_IDS:
        query
          .andWhere(
            'session.ownerTeamLeaderId = :scopeOwnerTeamLeaderId',
            {
              scopeOwnerTeamLeaderId:
                scope.ownerTeamLeaderId,
            },
          )
          .andWhere(
            'session.id IN (:...scopeSessionIds)',
            {
              scopeSessionIds:
                [
                  ...scope.sessionIds,
                ],
            },
          );
        return;

      default: {
        const exhaustiveCheck:
          never =
            scope;

        throw new Error(
          `Unsupported session scope: ${JSON.stringify(
            exhaustiveCheck,
          )}`,
        );
      }
    }
  }

  async findOne(
    id:
      string,
  ): Promise<Session> {
    const session =
      await this.sessionRepository
        .findOne({
          where: {
            id,
          },
        });

    if (!session) {
      throw new NotFoundException(
        `Session with id '${id}' not found`,
      );
    }

    return this.attachRuntimeState(
      session,
    );
  }

  /**
   * Attach the transient fields no column carries: why the session last failed, and whether
   * WhatsApp is restricting its account. See SessionErrorStore / SessionRestrictionStore — each map
   * and its projection live together.
   */
  private attachRuntimeState(
    session:
      Session,
  ): Session {
    return this.sessionRestrictions
      .attachTo(
        this.sessionErrors
          .attachTo(
            session,
          ),
      );
  }

  /**
   * Project the opaque `config` column onto the three keys the engine actually reads, resolved
   * through the same clamp the engine uses — so a legacy row holding an out-of-range value reports
   * what will really happen rather than what someone once wrote.
   */
  private projectConfig(
    config:
      Record<
        string,
        unknown
      >,
  ):
    SessionConfigResponseDto {
    const {
      maxAttempts,
      baseDelay,
    } =
      resolveReconnectConfig(
        config,
      );

    return {
      // Strict `=== true` mirrors maybeAutoRejectCall: a truthy string or 1 left in the opaque blob
      // must not read as opted in here when it would not opt in there.
      autoRejectCalls:
        config
          ?.autoRejectCalls ===
        true,

      maxReconnectAttempts:
        Number.isFinite(
          maxAttempts,
        )
          ? maxAttempts
          : null,

      reconnectBaseDelay:
        baseDelay,
    };
  }

  async getConfig(
    id:
      string,
  ):
    Promise<SessionConfigResponseDto> {
    const session =
      await this.findOne(
        id,
      );

    return this.projectConfig(
      session.config ??
        {},
    );
  }

  /**
   * Merge the supplied keys into `config` and persist. Merge rather than replace: the column is
   * documented as an opaque blob, so a key this endpoint does not know about belongs to the
   * operator and must survive a write that never mentioned it.
   *
   * An explicit `null` deletes the key, which is the only way back to a default that no in-range
   * value can express (`maxReconnectAttempts` unlimited). `undefined` — the key simply absent from
   * the request — leaves the stored value alone.
   *
   * No restart, and deliberately no engine call: `autoRejectCalls` is re-read from this row on
   * every incoming call, so the write alone is what takes effect. The reconnect pair is read once
   * per start() into reconnectStates, so it lands on the next start; that asymmetry is documented
   * on the DTO rather than papered over by forcing a reconnect nobody asked for.
   */
  async updateConfig(
    id:
      string,
    dto:
      UpdateSessionConfigDto,
  ):
    Promise<SessionConfigResponseDto> {
    const session =
      await this.findOne(
        id,
      );

    const config = {
      ...(
        session.config ??
        {}
      ),
    };

    for (
      const key of [
        'autoRejectCalls',
        'maxReconnectAttempts',
        'reconnectBaseDelay',
      ] as const
    ) {
      const value =
        dto[key];

      if (
        value ===
        undefined
      ) {
        continue;
      }

      if (
        value ===
        null
      ) {
        delete config[key];
      } else {
        config[key] =
          value;
      }
    }

    // update() with an explicit object rather than save() on the loaded entity: the entity carries
    // runtime-attached fields (lastError, restriction) that no column backs, and save() would try to
    // write the whole row back from a snapshot taken before this await.
    await this.sessionRepository
      .update(
        id,
        {
          config:
            config as QueryDeepPartialEntity<
              Record<
                string,
                unknown
              >
            >,
        },
      );

    return this.projectConfig(
      config,
    );
  }

  /**
   * Record removal + engine retirement + credential purge.
   *
   * Session deletion itself is owned by SessionEngineLifecycle.
   *
   * After that data-DB deletion succeeds, stale Agent assignments are
   * cleared from the separate main database.
   */
  async delete(
    id:
      string,
  ): Promise<void> {
    // Set the tearing-down mark SYNCHRONOUSLY, before the ownership fence's awaited query. The
    // pre-initialize retirement race needs this mark visible to an in-flight start()'s
    // post-INITIALIZING check by the time that write settles; awaiting anything first — the fence's
    // COUNT, or delete()'s own requireSession — would let the mark land after that window. A mark
    // left behind when the fence refuses (409) is harmless and is cleared by the next start().
    this.engineLifecycle
      .markStopping(
        id,
      );

    try {
      if (
        this.ownership
      ) {
        await this
          .assertNotHeldElsewhere(
            id,
          );
      }

      /**
       * This performs the actual Session lifecycle deletion.
       *
       * Agent cleanup must NOT happen before this resolves.
       */
      await this.engineLifecycle
        .delete(
          id,
        );

      /**
       * Preserve the existing ownership release semantics.
       */
      await this.ownership
        ?.release(
          id,
        );

      /**
       * Session lives in `data`, while Agent lives in `main`.
       *
       * Cross-database FK / ON DELETE SET NULL cannot be used, so
       * clear stale assignments explicitly after successful deletion.
       */
      await this
        .clearAgentAssignmentsForDeletedSession(
          id,
        );
    } catch (error) {
      this.discardStopMarkForMissingSession(
        id,
        error,
      );

      throw error;
    }
  }

  /**
   * Clear every Agent assignment referencing a Session that has just
   * been successfully deleted.
   *
   * This is intentionally a single set-based UPDATE rather than
   * loading and saving Agents individually.
   *
   * Security remains fail-closed even if this main-DB operation fails:
   * SessionTenantAccessService still requires the referenced Session
   * row to exist. However, surfacing the cleanup error prevents the
   * deletion workflow from falsely reporting complete success while
   * stale identity state remains.
   */
  private async clearAgentAssignmentsForDeletedSession(
    sessionId:
      string,
  ): Promise<void> {
    try {
      const result =
        await this.agentRepository
          .update(
            {
              assignedSessionId:
                sessionId,
            },
            {
              assignedSessionId:
                null,
            },
          );

      if (
        result.affected &&
        result.affected > 0
      ) {
        this.logger.log(
          `Cleared ${result.affected} Agent assignment(s) for deleted session ${sessionId}`,
          {
            sessionId,

            affected:
              result.affected,

            action:
              'session_agent_assignments_cleared',
          },
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to clear Agent assignments for deleted session ${sessionId}`,

        error instanceof
          Error
          ? error.message
          : String(
              error,
            ),

        {
          sessionId,

          action:
            'session_agent_assignment_cleanup_failed',
        },
      );

      throw error;
    }
  }

  /**
   * Reclaim the entry-time stop mark when the id turns out to have no session row.
   *
   * The mark is set synchronously, before the awaited existence check — deliberately, and the
   * comments above say why. A mark left behind by a refusal is harmless because the next start()
   * clears it, but that presupposes a row: start() and delete() both clear the mark only after
   * their own requireSession, so for an id that never had one the entry is unreachable by every
   * reclamation path and survives for the life of the process. A 404 also means there is no engine
   * and no in-flight start() for the mark to guard, so dropping it is safe as well as necessary.
   */
  private discardStopMarkForMissingSession(
    id:
      string,
    error:
      unknown,
  ): void {
    if (
      error instanceof
      NotFoundException
    ) {
      this.engineLifecycle
        .clearStopping(
          id,
        );
    }
  }

  /**
   * Refuse a lifecycle write for a session a LIVE peer is running.
   *
   * start() is fenced by the claim itself, and logout/force-kill require a local engine, so they
   * cannot act on a peer's session. stop() and delete() can: neither needs an engine here, so
   * without this a request landing on the wrong node — routine when ownership is configured but
   * request routing is not — writes DISCONNECTED over a peer's live session, or deletes its row and
   * credentials outright, while the peer's engine keeps running. A LAPSED claim is not fenced: the
   * holder may be gone, and taking over is exactly what the claim rule allows.
   */
  private async assertNotHeldElsewhere(
    id:
      string,
  ):
    Promise<void> {
    if (
      await this.ownership
        ?.isHeldByOtherNode(
          id,
        )
    ) {
      throw new ConflictException(
        `Session ${id} is running on another node`,
      );
    }
  }

  async start(
    id:
      string,
  ):
    Promise<Session> {
    // Claimed before the engine is launched, never after: launching first and discovering the
    // session belongs elsewhere would already have opened a second connection to the account.
    if (
      this.ownership &&
      !(
        await this.ownership
          .claim(
            id,
          )
      )
    ) {
      // The claim is a conditional UPDATE, so an id that does not exist also matches zero rows —
      // surface the route's documented 404 for that case instead of a misleading 409.
      await this.findOne(
        id,
      );

      throw new ConflictException(
        `Session ${id} is running on another node`,
      );
    }

    try {
      return await this
        .startWithTransientRetry(
          id,
        );
    } catch (error) {
      // A failed or refused start must not leave the claim pinned here — the heartbeat would renew
      // it and the session could never be started anywhere else. Released only when nothing is
      // actually alive locally: an "already starting/started" refusal means this node genuinely
      // runs the engine, and releasing then would invite a peer to open a second connection.
      await this
        .releaseUnlessEngineActive(
          id,
        );

      throw error;
    }
  }

  /**
   * One bounded retry for a TRANSIENT launch failure (a database hiccup while persisting the
   * initial status, a transport blip while the adapter boots). A transient failure during adopt or
   * boot auto-start used to release the claim and end the story: nothing ever retried, so the
   * session stayed down until some process restarted. The retry keeps the claim held (the outer
   * catch only runs when this gives up), and re-claims it if the retry window outlived the lease -
   * a lapsed claim must not turn the retry into a 409.
   *
   * Bounded to one retry on a short stagger: a persistent failure is a real fault, and an
   * unbounded loop here would hold the concurrency slot hostage. HTTP-shaped refusals (409
   * not-ready, 4xx) are NOT transient - they propagate immediately.
   */
  private async startWithTransientRetry(
    id:
      string,
  ):
    Promise<Session> {
    try {
      return await this
        .engineLifecycle
        .start(
          id,
        );
    } catch (error) {
      if (
        !isTransientLaunchFailure(
          error,
        )
      ) {
        throw error;
      }

      this.logger.warn(
        `Transient launch failure for session ${id}; retrying once`,
        {
          sessionId:
            id,

          action:
            'session_start_transient_retry',

          error:
            error instanceof
              Error
              ? error.message
              : String(
                  error,
                ),
        },
      );

      await setTimeout(
        SESSION_START_RETRY_DELAY_MS,
      );

      // The lease may have lapsed while the first attempt ran; the retry must keep holding the
      // claim, never 409 on the session it already owns.
      if (
        this.ownership &&
        !(
          await this.ownership
            .claim(
              id,
            )
        )
      ) {
        await this.findOne(
          id,
        );

        throw new ConflictException(
          `Session ${id} is running on another node`,
        );
      }

      return this
        .engineLifecycle
        .start(
          id,
        );
    }
  }

  async stop(
    id:
      string,
  ):
    Promise<Session> {
    // Synchronous stop-mark before the awaited fence — see delete() for why.
    this.engineLifecycle
      .markStopping(
        id,
      );

    let session:
      Session;

    try {
      if (
        this.ownership
      ) {
        await this
          .assertNotHeldElsewhere(
            id,
          );
      }

      session =
        await this.engineLifecycle
          .stop(
            id,
          );
    } catch (error) {
      // Deliberately no release here, unlike logout()/forceKill(): this catch also carries the
      // foreign-node 409, where the claim is the peer's and a blanket release would delete it. The
      // local-502 path keeps the claim, and only claims with a live engine are renewed — it lapses
      // at lease TTL instead of pinning the session here.
      this.discardStopMarkForMissingSession(
        id,
        error,
      );

      throw error;
    }

    // Handed back on the way out so a peer can pick it up immediately rather than waiting for the
    // lease to lapse. Stop is the deliberate end of this process's ownership — but a start() that
    // began before this stop and is still mid-launch owns the claim now, so the same
    // engine-liveness guard the failure paths use applies here: releasing under an in-flight start
    // would leave a live engine on an unclaimed row that no heartbeat renews and any peer may
    // start a second time.
    await this
      .releaseUnlessEngineActive(
        id,
      );

    return session;
  }

  /** See SessionEngineLifecycle.logout() for the full unlink/502 contract. */
  async logout(
    id:
      string,
  ):
    Promise<Session> {
    try {
      const session =
        await this
          .engineLifecycle
          .logout(
            id,
          );

      // Torn down locally on the 200 path — hand the claim back the way stop() does.
      await this
        .releaseUnlessEngineActive(
          id,
        );

      return session;
    } catch (error) {
      // The 502-incomplete path tears the engine down too, and a "not started" refusal never had
      // one — either way a claim that no longer covers an engine must not survive the call.
      await this
        .releaseUnlessEngineActive(
          id,
        );

      throw error;
    }
  }

  async forceKill(
    id:
      string,
  ):
    Promise<Session> {
    try {
      const session =
        await this
          .engineLifecycle
          .forceKill(
            id,
          );

      await this
        .releaseUnlessEngineActive(
          id,
        );

      return session;
    } catch (error) {
      await this
        .releaseUnlessEngineActive(
          id,
        );

      throw error;
    }
  }

  /**
   * Hand the claim back unless something still runs here
   * (engine, in-flight start, pending reconnect).
   */
  private async releaseUnlessEngineActive(
    id:
      string,
  ):
    Promise<void> {
    if (
      !this.ownership ||
      this.engineLifecycle
        .isEngineActive(
          id,
        )
    ) {
      return;
    }

    await this.ownership
      .release(
        id,
      );
  }

  async getQRCode(
    id:
      string,
  ): Promise<{
    qrCode: string;
    status: SessionStatus;
  }> {
    const session =
      await this.findOne(
        id,
      );

    const engine =
      this.engines.require(
        id,

        () =>
          new BadRequestException(
            'Session is not started. Call POST /sessions/:sessionId/start first.',
          ),
      );

    const qrCode =
      engine.getQRCode();

    if (!qrCode) {
      const engineStatus =
        engine.getStatus();

      // The browser/engine state changes before the asynchronous DB status write necessarily
      // settles. Once a scanned QR has been consumed, prefer that live state so this endpoint does
      // not keep telling the dashboard to wait for/scan a QR while the same engine is already
      // authenticating or ready.
      if (
        engineStatus ===
          EngineStatus.READY ||
        session.status ===
          SessionStatus.READY
      ) {
        throw new BadRequestException(
          'Session is already authenticated, no QR code needed',
        );
      }

      if (
        engineStatus ===
        EngineStatus.AUTHENTICATING
      ) {
        throw new BadRequestException(
          'Session is authenticating. The QR code has already been consumed; please wait for the session to become ready.',
        );
      }

      throw new BadRequestException(
        'QR code is not ready yet. Please wait...',
      );
    }

    return {
      qrCode,
      status:
        session.status,
    };
  }

  /**
   * Request an 8-char pairing code (link via phone number) as an alternative to scanning the QR.
   * The session must be started but not yet authenticated.
   */
  async requestPairingCode(
    id:
      string,
    phoneNumber:
      string,
  ): Promise<{
    pairingCode: string;
    status: SessionStatus;
  }> {
    const session =
      await this.findOne(
        id,
      );

    const engine =
      this.engines.require(
        id,

        () =>
          new BadRequestException(
            'Session is not started. Call POST /sessions/:sessionId/start first.',
          ),
      );

    if (
      session.status ===
      SessionStatus.READY
    ) {
      throw new BadRequestException(
        'Session is already authenticated, no pairing needed',
      );
    }

    const pairingCode =
      await engine
        .requestPairingCode(
          phoneNumber,
        );

    return {
      pairingCode,
      status:
        session.status,
    };
  }

  getEngine(
    id:
      string,
  ):
    IWhatsAppEngine |
    undefined {
    return this.engines
      .get(
        id,
      );
  }

  /**
   * The engine for a started session, or the documented 400. Routes through engines.require's
   * default onMissing so the wire contract stays byte-identical to the hand-rolled guards this
   * replaces ('Session is not started', exactly as each API surface documented it).
   */
  private requireEngine(
    id:
      string,
  ):
    IWhatsAppEngine {
    return this.engines
      .require(
        id,
      );
  }

  async getGroups(
    id:
      string,
    opts:
      ListOptions = {},
  ): Promise<
    {
      id: string;
      name: string;
      linkedParentJID?:
        string | null;
    }[]
  > {
    await this.findOne(
      id,
    );

    const engine =
      this.requireEngine(
        id,
      );

    const groups =
      await engine
        .getGroups();

    const mapped =
      groups.map(
        g => ({
          id:
            g.id,

          name:
            g.name,

          linkedParentJID:
            g.linkedParentJID,
        }),
      );

    return paginate(
      mapped,
      opts.limit,
      opts.offset,
    );
  }

  async getChats(
    id:
      string,
    opts:
      ListOptions = {},
  ):
    Promise<ChatSummary[]> {
    await this.findOne(
      id,
    );

    const engine =
      this.requireEngine(
        id,
      );

    // Most-recent first, then bound the response window. Sorting before the cap means a capped
    // response is the N newest chats (what clients show first) rather than an arbitrary slice.
    const chats = [
      ...(
        await engine
          .getChats()
      ),
    ].sort(
      (
        a,
        b,
      ) =>
        (
          b.timestamp ||
          0
        ) -
        (
          a.timestamp ||
          0
        ),
    );

    return paginate(
      chats,
      opts.limit,
      opts.offset,
    );
  }

  /**
   * Ask WhatsApp to start reporting a chat's presence. Updates arrive as `presence.update` events;
   * there is no synchronous answer to give here, because presence cannot be queried from either
   * library — only received.
   *
   * The subscription belongs to the connection, so it does not survive a restart or an automatic
   * reconnect and has to be re-issued. That is the engine's contract, not a gateway choice, and the
   * API documents it rather than pretending otherwise by silently replaying subscriptions.
   */
  async subscribeToPresence(
    id:
      string,
    chatId:
      string,
  ):
    Promise<void> {
    await this.findOne(
      id,
    );

    const engine =
      this.requireEngine(
        id,
      );

    return engine
      .subscribeToPresence(
        chatId,
      );
  }

  /**
   * Publish the account's own global presence (appear online/offline). Connection-scoped: the
   * setting resets on reconnect, so callers re-issue it after `session.status` reports one.
   */
  async setOnlinePresence(
    id:
      string,
    available:
      boolean,
  ):
    Promise<void> {
    await this.findOne(
      id,
    );

    const engine =
      this.requireEngine(
        id,
      );

    return engine
      .setOnlinePresence(
        available,
      );
  }

  /**
   * The last presence WhatsApp reported for a chat, or null when none has been — either because the
   * chat was never subscribed, or because nothing has changed since the subscription was made.
   * Deliberately not an error: "nothing reported yet" is a normal state, not a missing resource.
   */
  async getPresence(
    id:
      string,
    chatId:
      string,
  ):
    Promise<
      ChatPresence |
      null
    > {
    await this.findOne(
      id,
    );

    return this.presence
      .get(
        id,
        chatId,
      );
  }

  async sendSeen(
    id:
      string,
    chatId:
      string,
    messageIds?:
      string[],
  ):
    Promise<boolean> {
    await this.findOne(
      id,
    );

    const engine =
      this.requireEngine(
        id,
      );

    return engine.sendSeen(
      chatId,
      messageIds,
    );
  }

  async markUnread(
    id:
      string,
    chatId:
      string,
  ):
    Promise<boolean> {
    await this.findOne(
      id,
    );

    const engine =
      this.requireEngine(
        id,
      );

    return engine
      .markUnread(
        chatId,
      );
  }

  /**
   * Delete every message in a chat, keeping the chat itself. Resolves false when the engine could
   * not act — an unknown chat, or on Baileys a chat with no known history to key the change to.
   */
  async clearChatMessages(
    id:
      string,
    chatId:
      string,
  ):
    Promise<boolean> {
    await this.findOne(
      id,
    );

    const engine =
      this.requireEngine(
        id,
      );

    return engine
      .clearChatMessages(
        chatId,
      );
  }

  /**
   * Archive or unarchive a chat. Resolves false when the engine could not act — on Baileys a chat
   * with no known history has no last message to key the app-state modification to. That is a
   * defined outcome, not an error, so it is reported as `success: false` rather than a 500.
   */
  async archiveChat(
    id:
      string,
    chatId:
      string,
    archive:
      boolean,
  ):
    Promise<boolean> {
    await this.findOne(
      id,
    );

    const engine =
      this.requireEngine(
        id,
      );

    return engine
      .archiveChat(
        chatId,
        archive,
      );
  }

  /**
   * Mute a chat until `muteUntil` (absolute epoch milliseconds), or unmute it with `null`. Unlike
   * archiveChat there is no "engine declined" outcome — the Baileys mute patch is not keyed to the
   * chat's last message — so this resolves void and a failure surfaces as an error.
   */
  async muteChat(
    id:
      string,
    chatId:
      string,
    muteUntil:
      number | null,
  ):
    Promise<void> {
    await this.findOne(
      id,
    );

    const engine =
      this.requireEngine(
        id,
      );

    return engine
      .muteChat(
        chatId,
        muteUntil,
      );
  }

  /**
   * Pin or unpin a chat. Resolves false only when the engine declined — whatsapp-web.js reports
   * WhatsApp's three-pin cap; Baileys cannot see it and always resolves true.
   */
  async pinChat(
    id:
      string,
    chatId:
      string,
    pin:
      boolean,
  ):
    Promise<boolean> {
    await this.findOne(
      id,
    );

    const engine =
      this.requireEngine(
        id,
      );

    return engine
      .pinChat(
        chatId,
        pin,
      );
  }

  async deleteChat(
    id:
      string,
    chatId:
      string,
  ):
    Promise<boolean> {
    await this.findOne(
      id,
    );

    const engine =
      this.requireEngine(
        id,
      );

    return engine
      .deleteChat(
        chatId,
      );
  }

  async sendChatState(
    id:
      string,
    chatId:
      string,
    state:
      ChatState,
  ):
    Promise<void> {
    await this.findOne(
      id,
    );

    const engine =
      this.requireEngine(
        id,
      );

    await engine
      .sendChatState(
        chatId,
        state,
      );
  }

  /**
   * Get overall session statistics for multi-session monitoring.
   *
   * Aggregate endpoints must use the same effective session scope
   * as GET /sessions because they do not contain a :sessionId that
   * ApiKeyGuard can authorize individually.
   */
  async getStats(
    scope:
      SessionScope,
  ): Promise<{
    total: number;
    active: number;
    ready: number;
    disconnected: number;
    byStatus:
      Record<
        string,
        number
      >;
    memoryUsage: {
      heapUsed: number;
      heapTotal: number;
      rss: number;
    };
  }> {
    /**
     * Aggregate in SQL instead of going through findAll(), because
     * findAll() is paginated and therefore cannot safely calculate
     * global counts.
     */
    const query =
      this.sessionRepository
        .createQueryBuilder(
          'session',
        )
        .select(
          'session.status',
          'status',
        )
        .addSelect(
          'COUNT(session.id)',
          'count',
        );

    this.applySessionScope(
      query,
      scope,
    );

    const rows =
      await query
        .groupBy(
          'session.status',
        )
        .getRawMany<{
          status:
            string;
          count:
            string;
        }>();

    const byStatus:
      Record<
        string,
        number
      > = {};

    let total =
      0;

    for (
      const row
      of rows
    ) {
      const count =
        Number(
          row.count,
        ) ||
        0;

      byStatus[
        row.status
      ] =
        count;

      total +=
        count;
    }

    const active =
      await this
        .countActiveSessionsInScope(
          scope,
        );

    const memory =
      process.memoryUsage();

    return {
      total,
      active,

      ready:
        byStatus[
          SessionStatus.READY
        ] ||
        0,

      disconnected:
        byStatus[
          SessionStatus.DISCONNECTED
        ] ||
        0,

      byStatus,

      memoryUsage: {
        heapUsed:
          Math.round(
            memory.heapUsed /
              1024 /
              1024,
          ),

        heapTotal:
          Math.round(
            memory.heapTotal /
              1024 /
              1024,
          ),

        rss:
          Math.round(
            memory.rss /
              1024 /
              1024,
          ),
      },
    };
  }

  /**
   * Count live engines that also fall inside the effective database
   * tenant scope.
   *
   * For OWNER scopes we cannot determine access from the engine ID
   * alone, so the live IDs are intersected with the scoped Session
   * query in the database.
   */
  private async countActiveSessionsInScope(
    scope:
      SessionScope,
  ):
    Promise<number> {
    const activeIds = [
      ...this.engines
        .keys(),
    ];

    if (
      scope.type ===
      SessionScopeType.ALL
    ) {
      return activeIds.length;
    }

    if (
      scope.type ===
        SessionScopeType.NONE ||
      activeIds.length ===
        0
    ) {
      return 0;
    }

    const query =
      this.sessionRepository
        .createQueryBuilder(
          'session',
        )
        .select(
          'session.id',
          'id',
        )
        .where(
          'session.id IN (:...activeSessionIds)',
          {
            activeSessionIds:
              activeIds,
          },
        );

    /**
     * This adds the tenant restrictions using AND.
     *
     * For example OWNER_AND_IDS becomes:
     *
     * active ID
     * AND owner
     * AND allowed session ID
     */
    this.applySessionScope(
      query,
      scope,
    );

    const rows =
      await query
        .getRawMany<{
          id:
            string;
        }>();

    return rows.length;
  }

  /**
   * Check if session is currently active (engine running).
   */
  isActive(
    id:
      string,
  ):
    boolean {
    return this.engines
      .has(
        id,
      );
  }

  /**
   * Ids of every session with a live engine — including ones mid-initialization (their engine is not
   * in `engines` yet but will register when start() completes). The infra import pre-flight uses this
   * to refuse a full-replace restore that would orphan a running engine.
   */
  getActiveSessionIds():
    string[] {
    return this.engines
      .activeIds();
  }

  /**
   * Stop engines for session ids whose DB row is about to be replaced by an infra import.
   * Owned by the lifecycle service; see SessionEngineLifecycle.stopOrphanEngines().
   */
  async stopOrphanEngines(
    sessionIds:
      string[],
  ): Promise<{
    stopped:
      string[];
    notRunning:
      string[];
    failed:
      string[];
  }> {
    return this.engineLifecycle
      .stopOrphanEngines(
        sessionIds,
      );
  }
}




