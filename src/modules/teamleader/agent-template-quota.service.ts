


import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
} from 'typeorm';

import {
  ApiKey,
  ApiKeyRole,
} from '../auth/entities/api-key.entity';

import { createLogger } from '../../common/services/logger.service';

import { Agent } from './entities/agent.entity';
import {
  AgentTemplateSendUsage,
  AgentTemplateSendUsageStatus,
} from './entities/agent-template-send-usage.entity';

const QUOTA_WINDOW_MS =
  24 * 60 * 60 * 1000;

/**
 * Recovery window for an orphaned RESERVED row.
 *
 * Normal sends complete far sooner than one hour. Keeping the lease generous
 * prevents a slow but still-live send from losing its reservation, while still
 * recovering automatically after a process crash.
 */
const RESERVATION_LEASE_MS =
  60 * 60 * 1000;

const SQLITE_BUSY_MAX_ATTEMPTS = 6;
const SQLITE_BUSY_BASE_DELAY_MS = 25;

export interface AgentTemplateQuotaReservation {
  usageId: string;
  agentId: string;
  sessionId: string;
  limit: number;
  used24h: number;
}

export interface AgentTemplateQuotaSnapshot {
  templateSendLimit24h: number | null;
  used24h: number;
  remaining24h: number | null;
  retryAfterSeconds: number | null;
}

/**
 * Enforces the Agent-only rolling 24-hour stored-template quota.
 *
 * Important boundaries:
 *
 * - This service does NOT authorize session ownership/assignment. The global
 *   ApiKeyGuard + SessionTenantAccessService already enforce the WHERE scope.
 * - This service does NOT apply to normal text/media/message actions.
 * - Non-Agent principals bypass this quota entirely.
 * - The caller should wrap ONLY POST /sessions/:sessionId/messages/send-template
 *   with executeForApiKey().
 *
 * Concurrency model (main DB is SQLite):
 *
 * 1. BEGIN IMMEDIATE obtains the SQLite write reservation before reading usage.
 * 2. Expired/orphaned reservations and old consumed rows are removed.
 * 3. Current usage is counted.
 * 4. If a slot exists, a RESERVED row is inserted before the DB transaction
 *    commits.
 * 5. A concurrent request cannot observe the same slot. If SQLite reports
 *    SQLITE_BUSY/SQLITE_LOCKED, the whole short reservation transaction retries.
 * 6. Successful sends mark the reservation CONSUMED. Failed sends delete it.
 */
@Injectable()
export class AgentTemplateQuotaService {
  private readonly logger =
    createLogger('AgentTemplateQuotaService');

  constructor(
    @InjectDataSource('main')
    private readonly mainDataSource: DataSource,
  ) {}

  /**
   * Execute one stored-template send under the authenticated principal's quota.
   *
   * ADMIN / OPERATOR / TEAM_LEADER and other non-Agent roles are not subject to
   * Agent quota accounting and execute immediately.
   *
   * For Agents, a reservation is taken before invoking operation(). A rejected
   * operation releases the reservation; a successful operation marks it
   * consumed.
   *
   * The operation result is never replaced by a post-send accounting error.
   * Once the WhatsApp send succeeded, returning an error to the client would
   * encourage a retry and could duplicate the message. Accounting-finalization
   * failures are logged; the RESERVED row continues to count until its lease
   * expires, which is the conservative failure mode.
   */
  async executeForApiKey<T>(
    apiKey: ApiKey,
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (
      apiKey.role !==
      ApiKeyRole.AGENT
    ) {
      return operation();
    }

    if (!apiKey.agentId) {
      throw new ForbiddenException(
        'A valid Agent principal is required',
      );
    }

    const reservation =
      await this.reserveForAgent(
        apiKey.agentId,
        sessionId,
      );

    /**
     * null means the Agent is configured as unlimited.
     */
    if (!reservation) {
      return operation();
    }

    let result: T;

    try {
      result =
        await operation();
    } catch (error) {
      try {
        await this.releaseReservation(
          reservation,
        );
      } catch (releaseError) {
        this.logger.warn(
          'Failed to release Agent template quota reservation after send failure',
          {
            usageId:
              reservation.usageId,
            agentId:
              reservation.agentId,
            sessionId:
              reservation.sessionId,
            error:
              this.errorMessage(
                releaseError,
              ),
          },
        );
      }

      throw error;
    }

    try {
      await this.commitReservation(
        reservation,
      );
    } catch (commitError) {
      /**
       * Do not turn a successful WhatsApp send into an HTTP failure. The still
       * RESERVED row remains conservative and continues consuming quota until
       * its safety lease expires.
       */
      this.logger.warn(
        'Stored-template send succeeded but quota reservation could not be marked consumed',
        {
          usageId:
            reservation.usageId,
          agentId:
            reservation.agentId,
          sessionId:
            reservation.sessionId,
          error:
            this.errorMessage(
              commitError,
            ),
        },
      );
    }

    return result;
  }

  /**
   * Reserve one quota slot for an Agent.
   *
   * Returns null when templateSendLimit24h is null (unlimited).
   * Throws HTTP 429 when the limit is 0 or the rolling window is full.
   */
  async reserveForAgent(
    agentId: string,
    sessionId: string,
  ): Promise<AgentTemplateQuotaReservation | null> {
    return this.withImmediateMainTransaction(
      async manager => {
        const agentRepository =
          manager.getRepository(
            Agent,
          );

        const usageRepository =
          manager.getRepository(
            AgentTemplateSendUsage,
          );

        const agent =
          await agentRepository.findOne({
            where: {
              id: agentId,
            },
          });

        if (!agent) {
          throw new NotFoundException(
            'Agent not found',
          );
        }

        const limit =
          agent.templateSendLimit24h;

        if (limit === null) {
          return null;
        }

        /**
         * The DTO and DB migration should already guarantee this invariant.
         * Keep a defensive runtime check because a corrupt/manual DB write must
         * never silently disable quota enforcement.
         */
        if (
          !Number.isInteger(limit) ||
          limit < 0
        ) {
          throw new Error(
            `Invalid templateSendLimit24h for Agent ${agent.id}`,
          );
        }

        const now =
          new Date();

        const cutoff =
          new Date(
            now.getTime() -
            QUOTA_WINDOW_MS,
          );

        await this.cleanupUsage(
          manager,
          agent.id,
          now,
          cutoff,
        );

        const used24h =
          await usageRepository.count({
            where: {
              agentId:
                agent.id,
            },
          });

        if (
          limit === 0 ||
          used24h >= limit
        ) {
          const retryAfterSeconds =
            limit === 0
              ? null
              : await this.calculateRetryAfterSeconds(
                  manager,
                  agent.id,
                  now,
                );

          this.throwQuotaExceeded(
            limit,
            used24h,
            retryAfterSeconds,
          );
        }

        const usage =
          usageRepository.create({
            agentId:
              agent.id,
            sessionId,
            status:
              AgentTemplateSendUsageStatus.RESERVED,
            reservationExpiresAt:
              new Date(
                now.getTime() +
                RESERVATION_LEASE_MS,
              ),
            consumedAt:
              null,
          });

        const saved =
          await usageRepository.save(
            usage,
          );

        return {
          usageId:
            saved.id,
          agentId:
            saved.agentId,
          sessionId:
            saved.sessionId,
          limit,
          used24h:
            used24h + 1,
        };
      },
    );
  }

  /**
   * Mark a reservation as a successful stored-template send.
   */
  async commitReservation(
    reservation: AgentTemplateQuotaReservation,
  ): Promise<void> {
    await this.withSqliteBusyRetry(
      async () => {
        const repository =
          this.mainDataSource.getRepository(
            AgentTemplateSendUsage,
          );

        const result =
          await repository.update(
            {
              id:
                reservation.usageId,
              agentId:
                reservation.agentId,
              status:
                AgentTemplateSendUsageStatus.RESERVED,
            },
            {
              status:
                AgentTemplateSendUsageStatus.CONSUMED,
              consumedAt:
                new Date(),
              reservationExpiresAt:
                null,
            },
          );

        if (result.affected !== 1) {
          throw new Error(
            `Template quota reservation ${reservation.usageId} was not found or was already finalized`,
          );
        }
      },
    );
  }

  /**
   * Remove an in-flight reservation when the stored-template send fails.
   */
  async releaseReservation(
    reservation: AgentTemplateQuotaReservation,
  ): Promise<void> {
    await this.withSqliteBusyRetry(
      async () => {
        const repository =
          this.mainDataSource.getRepository(
            AgentTemplateSendUsage,
          );

        await repository.delete({
          id:
            reservation.usageId,
          agentId:
            reservation.agentId,
          status:
            AgentTemplateSendUsageStatus.RESERVED,
        });
      },
    );
  }

  /**
   * Remove rows that no longer participate in quota accounting.
   *
   * - orphaned RESERVED rows are removed after the safety lease
   * - CONSUMED rows leave the rolling window after 24 hours
   */
  private async cleanupUsage(
    manager: EntityManager,
    agentId: string,
    now: Date,
    cutoff: Date,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .delete()
      .from(
        AgentTemplateSendUsage,
      )
      .where(
        'agentId = :agentId',
        {
          agentId,
        },
      )
      .andWhere(
        'status = :status',
        {
          status:
            AgentTemplateSendUsageStatus.RESERVED,
        },
      )
      .andWhere(
        'reservationExpiresAt IS NOT NULL',
      )
      .andWhere(
        'reservationExpiresAt <= :now',
        {
          now,
        },
      )
      .execute();

    await manager
      .createQueryBuilder()
      .delete()
      .from(
        AgentTemplateSendUsage,
      )
      .where(
        'agentId = :agentId',
        {
          agentId,
        },
      )
      .andWhere(
        'status = :status',
        {
          status:
            AgentTemplateSendUsageStatus.CONSUMED,
        },
      )
      .andWhere(
        'consumedAt IS NOT NULL',
      )
      .andWhere(
        'consumedAt < :cutoff',
        {
          cutoff,
        },
      )
      .execute();
  }

  /**
   * Compute when the next currently-counted row will stop consuming quota.
   *
   * For a CONSUMED row this is consumedAt + 24h.
   * For a RESERVED row this is the reservation safety-lease expiry.
   */
  private async calculateRetryAfterSeconds(
    manager: EntityManager,
    agentId: string,
    now: Date,
  ): Promise<number | null> {
    const repository =
      manager.getRepository(
        AgentTemplateSendUsage,
      );

    const usages =
      await repository.find({
        where: {
          agentId,
        },
      });

    if (usages.length === 0) {
      return null;
    }

    let earliestReleaseAt:
      Date | null = null;

    for (const usage of usages) {
      let releaseAt: Date | null =
        null;

      if (
        usage.status ===
        AgentTemplateSendUsageStatus.CONSUMED
      ) {
        /**
         * consumedAt should always be populated for CONSUMED rows. Fall back to
         * createdAt only as a defensive recovery path for malformed legacy data.
         */
        const consumedAt =
          usage.consumedAt ??
          usage.createdAt;

        releaseAt =
          new Date(
            consumedAt.getTime() +
            QUOTA_WINDOW_MS,
          );
      } else if (
        usage.status ===
          AgentTemplateSendUsageStatus.RESERVED
      ) {
        releaseAt =
          usage.reservationExpiresAt;
      }

      if (!releaseAt) {
        continue;
      }

      if (
        !earliestReleaseAt ||
        releaseAt.getTime() <
          earliestReleaseAt.getTime()
      ) {
        earliestReleaseAt =
          releaseAt;
      }
    }

    if (!earliestReleaseAt) {
      return null;
    }

    return Math.max(
      1,
      Math.ceil(
        (
          earliestReleaseAt.getTime() -
          now.getTime()
        ) /
          1000,
      ),
    );
  }

  private throwQuotaExceeded(
    limit: number,
    used24h: number,
    retryAfterSeconds: number | null,
  ): never {
    const snapshot:
      AgentTemplateQuotaSnapshot = {
        templateSendLimit24h:
          limit,
        used24h,
        remaining24h:
          0,
        retryAfterSeconds,
      };

    throw new HttpException(
      {
        statusCode:
          HttpStatus.TOO_MANY_REQUESTS,
        error:
          'Too Many Requests',
        code:
          'AGENT_TEMPLATE_SEND_LIMIT_REACHED',
        message:
          limit === 0
            ? 'Stored-template sending is disabled for this Agent.'
            : 'Template send limit reached for the rolling 24-hour window.',
        ...snapshot,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * SQLite's default transaction begins DEFERRED. That is unsafe for the quota
   * check because two requests could both read the same count before either
   * becomes a writer.
   *
   * The main database is explicitly SQLite in this project, so use
   * BEGIN IMMEDIATE to obtain the write reservation before reading usage.
   */
  private async withImmediateMainTransaction<T>(
    operation: (
      manager: EntityManager,
    ) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;

    for (
      let attempt = 0;
      attempt < SQLITE_BUSY_MAX_ATTEMPTS;
      attempt += 1
    ) {
      const queryRunner =
        this.mainDataSource.createQueryRunner();

      let transactionStarted =
        false;

      try {
        await queryRunner.connect();

        await queryRunner.query(
          'BEGIN IMMEDIATE',
        );

        transactionStarted =
          true;

        const result =
          await operation(
            queryRunner.manager,
          );

        await queryRunner.query(
          'COMMIT',
        );

        transactionStarted =
          false;

        return result;
      } catch (error) {
        lastError =
          error;

        if (transactionStarted) {
          try {
            await queryRunner.query(
              'ROLLBACK',
            );
          } catch (rollbackError) {
            this.logger.warn(
              'Failed to roll back Agent template quota transaction',
              {
                error:
                  this.errorMessage(
                    rollbackError,
                  ),
              },
            );
          }
        }

        if (
          !this.isSqliteBusy(error) ||
          attempt ===
            SQLITE_BUSY_MAX_ATTEMPTS - 1
        ) {
          throw error;
        }

        await this.sleep(
          SQLITE_BUSY_BASE_DELAY_MS *
            (attempt + 1),
        );
      } finally {
        await queryRunner.release();
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(
          'Failed to reserve Agent template quota',
        );
  }

  private async withSqliteBusyRetry<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;

    for (
      let attempt = 0;
      attempt < SQLITE_BUSY_MAX_ATTEMPTS;
      attempt += 1
    ) {
      try {
        return await operation();
      } catch (error) {
        lastError =
          error;

        if (
          !this.isSqliteBusy(error) ||
          attempt ===
            SQLITE_BUSY_MAX_ATTEMPTS - 1
        ) {
          throw error;
        }

        await this.sleep(
          SQLITE_BUSY_BASE_DELAY_MS *
            (attempt + 1),
        );
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(
          'SQLite quota operation failed',
        );
  }

  private isSqliteBusy(
    error: unknown,
  ): boolean {
    const candidate =
      error as {
        code?: unknown;
        message?: unknown;
        driverError?: {
          code?: unknown;
          message?: unknown;
        };
      };

    const code =
      candidate?.driverError?.code ??
      candidate?.code;

    if (
      code === 'SQLITE_BUSY' ||
      code === 'SQLITE_LOCKED'
    ) {
      return true;
    }

    const message =
      String(
        candidate?.driverError?.message ??
        candidate?.message ??
        '',
      ).toLowerCase();

    return (
      message.includes(
        'database is locked',
      ) ||
      message.includes(
        'database table is locked',
      )
    );
  }

  private async sleep(
    milliseconds: number,
  ): Promise<void> {
    await new Promise<void>(
      resolve => {
        setTimeout(
          resolve,
          milliseconds,
        );
      },
    );
  }

  private errorMessage(
    error: unknown,
  ): string {
    return error instanceof Error
      ? error.message
      : String(error);
  }
}


