


import {
  Injectable,
  NotFoundException,
  BadRequestException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  InjectRepository,
} from '@nestjs/typeorm';
import {
  FindManyOptions,
  In,
  LessThan,
  Repository,
} from 'typeorm';
import {
  ConfigService,
} from '@nestjs/config';

import {
  Webhook,
} from './entities/webhook.entity';
import {
  WebhookDeliveryFailure,
} from './entities/webhook-delivery-failure.entity';
import {
  Session,
} from '../session/entities/session.entity';

import {
  CreateWebhookDto,
  UpdateWebhookDto,
} from './dto';

import {
  createLogger,
} from '../../common/services/logger.service';

import {
  SessionScopeType,
  type SessionScope,
} from '../access-control/session-scope';

import {
  ListOptions,
  resolveListWindow,
} from '../../common/utils/paginate';

import {
  generateIdempotencyKey,
  generateDeliveryId,
} from './utils/idempotency.util';

import {
  assertSafeFetchUrl,
  withSafeFetch,
  isSsrfProtectionEnabled,
  SsrfBlockedError,
  SSRF_BLOCKED_CLIENT_MESSAGE,
  redactSsrfError,
} from '../../common/security/ssrf-guard';

import {
  WebhookDeliveryService,
  WebhookPayload,
} from './webhook-delivery.service';

/*
 * Delivery-engine types live on WebhookDeliveryService.
 *
 * Re-export them here so existing queue/import consumers can continue
 * using WebhookService as their stable import path.
 */
export type {
  WebhookPayload,
  WebhookJobData,
} from './webhook-delivery.service';

/**
 * Maximum number of registered webhooks per session.
 *
 * One inbound event fans out to every active registered webhook,
 * therefore an unbounded number would multiply:
 *
 * - payload clones
 * - outbound sockets
 * - queue jobs
 *
 * Existing rows are grandfathered.
 * The cap affects only new registrations.
 *
 * 0 disables the cap.
 */
const DEFAULT_WEBHOOK_MAX_PER_SESSION =
  16;

@Injectable()
export class WebhookService
  implements
    OnModuleInit,
    OnModuleDestroy
{
  private readonly logger =
    createLogger(
      'WebhookService',
    );

  private cleanupTimer?: ReturnType<
    typeof setInterval
  >;

  constructor(
    @InjectRepository(
      Webhook,
      'data',
    )
    private readonly webhookRepository:
      Repository<Webhook>,

    @InjectRepository(
      WebhookDeliveryFailure,
      'data',
    )
    private readonly failureRepository:
      Repository<WebhookDeliveryFailure>,

    @InjectRepository(
      Session,
      'data',
    )
    private readonly sessionRepository:
      Repository<Session>,

    private readonly configService:
      ConfigService,

    private readonly delivery:
      WebhookDeliveryService,
  ) {}

  /**
   * Periodically prune webhook_delivery_failures older than
   * WEBHOOK_FAILURE_RETENTION_DAYS.
   *
   * Default:
   *   90 days
   *
   * <= 0:
   *   disabled
   *
   * Runs once during startup and then once per day.
   */
  onModuleInit(): void {
    const parsed =
      Number.parseInt(
        process.env
          .WEBHOOK_FAILURE_RETENTION_DAYS ??
          '',
        10,
      );

    const retentionDays =
      Number.isInteger(parsed)
        ? Math.max(
            0,
            parsed,
          )
        : 90;

    if (
      retentionDays <= 0
    ) {
      this.logger.log(
        'Webhook delivery-failure retention disabled ' +
          '(WEBHOOK_FAILURE_RETENTION_DAYS <= 0)',
      );

      return;
    }

    const runPrune =
      (): void => {
        this.pruneDeliveryFailures(
          retentionDays,
        )
          .then(n => {
            if (n > 0) {
              this.logger.log(
                `Pruned ${n} webhook delivery-failure(s) ` +
                  `older than ${retentionDays} day(s)`,
              );
            }
          })
          .catch(err =>
            this.logger.error(
              'Webhook delivery-failure cleanup failed',
              err instanceof Error
                ? err.stack
                : String(err),
            ),
          );
      };

    runPrune();

    this.cleanupTimer =
      setInterval(
        runPrune,
        24 *
          60 *
          60 *
          1000,
      );

    this.cleanupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (
      this.cleanupTimer
    ) {
      clearInterval(
        this.cleanupTimer,
      );
    }
  }

  /**
   * Delete delivery-failure rows older than the retention window.
   */
  async pruneDeliveryFailures(
    olderThanDays: number,
  ): Promise<number> {
    const cutoff =
      new Date();

    cutoff.setDate(
      cutoff.getDate() -
        olderThanDays,
    );

    const result =
      await this.failureRepository.delete(
        {
          createdAt:
            LessThan(
              cutoff,
            ),
        },
      );

    return (
      result.affected ||
      0
    );
  }

  /**
   * Validate a webhook URL before storing it.
   *
   * Unsafe internal URLs are rejected synchronously rather than
   * waiting for delivery-time failure.
   */
  private async validateWebhookUrl(
    url: string,
  ): Promise<void> {
    let parsed:
      | URL
      | null = null;

    try {
      parsed =
        new URL(url);
    } catch {
      /*
       * DTO validation and/or the SSRF guard owns malformed URL
       * rejection.
       */
    }

    /*
     * Never persist embedded URL credentials.
     */
    if (
      parsed &&
      (
        parsed.username !==
          '' ||
        parsed.password !==
          ''
      )
    ) {
      throw new BadRequestException(
        'Webhook URL must not contain credentials (userinfo)',
      );
    }

    if (
      !isSsrfProtectionEnabled()
    ) {
      return;
    }

    try {
      await assertSafeFetchUrl(
        url,
      );
    } catch (error) {
      if (
        error instanceof
        SsrfBlockedError
      ) {
        this.logger.warn(
          `Webhook URL rejected by SSRF guard: ${error.message}`,
        );

        throw new BadRequestException(
          SSRF_BLOCKED_CLIENT_MESSAGE,
        );
      }

      throw error;
    }
  }

  async create(
    sessionId: string,
    dto: CreateWebhookDto,
  ): Promise<Webhook> {
    /*
     * Check explicitly so a missing Session returns a truthful
     * 404 rather than surfacing as a database FK/driver error.
     */
    const sessionExists =
      await this.sessionRepository.exists(
        {
          where: {
            id: sessionId,
          },
        },
      );

    if (
      !sessionExists
    ) {
      throw new NotFoundException(
        `Session with id '${sessionId}' not found`,
      );
    }

    await this.validateWebhookUrl(
      dto.url,
    );

    /*
     * Per-session fan-out cap.
     */
    const maxPerSession =
      this.configService.get<number>(
        'webhook.maxPerSession',
        DEFAULT_WEBHOOK_MAX_PER_SESSION,
      );

    if (
      maxPerSession > 0
    ) {
      const existing =
        await this.webhookRepository.count(
          {
            where: {
              sessionId,
            },
          },
        );

      if (
        existing >=
        maxPerSession
      ) {
        throw new BadRequestException(
          `Webhook limit reached for this session ` +
            `(${existing}/${maxPerSession}); ` +
            'delete one before registering another',
        );
      }
    }

    const webhook =
      this.webhookRepository.create(
        {
          sessionId,

          url:
            dto.url,

          events:
            dto.events ||
            [
              'message.received',
            ],

          secret:
            dto.secret ||
            null,

          headers:
            dto.headers ||
            {},

          filters:
            dto.filters ??
            null,

          retryCount:
            dto.retryCount ??
            3,
        },
      );

    return this.webhookRepository.save(
      webhook,
    );
  }

  async findBySession(
    sessionId: string,
  ): Promise<Webhook[]> {
    return this.webhookRepository.find(
      {
        where: {
          sessionId,
        },

        order: {
          createdAt:
            'DESC',
        },
      },
    );
  }

  /**
   * Aggregate/global webhook listing.
   *
   * The effective SessionScope is authoritative.
   *
   * ALL
   *   -> all webhooks
   *
   * IDS
   *   -> explicit allowed session IDs
   *
   * OWNER
   *   -> sessions owned by the Team Leader
   *
   * OWNER_AND_IDS
   *   -> ownership INTERSECT explicit IDs
   *
   * NONE
   *   -> no rows
   */
  async findAll(
    sessionScope:
      SessionScope,
    opts:
      ListOptions = {},
  ): Promise<Webhook[]> {
    const {
      limit,
      offset,
    } =
      resolveListWindow(
        opts.limit,
        opts.offset,
      );

    const effectiveSessionIds =
      await this.resolveEffectiveSessionIds(
        sessionScope,
      );

    /*
     * Fail closed for NONE or an empty effective intersection.
     */
    if (
      effectiveSessionIds !==
        undefined &&
      effectiveSessionIds.length ===
        0
    ) {
      return [];
    }

    const options:
      FindManyOptions<Webhook> =
      {
        order: {
          createdAt:
            'DESC',
        },

        take:
          limit,

        skip:
          offset,
      };

    /*
     * undefined represents ALL.
     *
     * Any concrete array represents a tenant restriction.
     */
    if (
      effectiveSessionIds !==
      undefined
    ) {
      options.where = {
        sessionId:
          In(
            effectiveSessionIds,
          ),
      };
    }

    return this.webhookRepository.find(
      options,
    );
  }

  /**
   * List permanently failed webhook deliveries.
   *
   * The optional query sessionId may only NARROW the already
   * authenticated SessionScope.
   */
  async listDeliveryFailures(
    opts:
      ListOptions & {
        sessionId?:
          string;
      } = {},
    sessionScope:
      SessionScope,
  ): Promise<
    WebhookDeliveryFailure[]
  > {
    const {
      limit,
      offset,
    } =
      resolveListWindow(
        opts.limit,
        opts.offset,
      );

    const effectiveSessionIds =
      await this.resolveEffectiveSessionIds(
        sessionScope,
      );

    const narrowedSessionIds =
      this.intersectRequestedSession(
        effectiveSessionIds,
        opts.sessionId,
      );

    /*
     * NONE or requested foreign session.
     */
    if (
      narrowedSessionIds !==
        undefined &&
      narrowedSessionIds.length ===
        0
    ) {
      return [];
    }

    return this.failureRepository.find(
      {
        where:
          narrowedSessionIds !==
          undefined
            ? {
                sessionId:
                  In(
                    narrowedSessionIds,
                  ),
              }
            : {},

        order: {
          createdAt:
            'DESC',
        },

        take:
          limit,

        skip:
          offset,
      },
    );
  }

  /**
   * Convert the tenant-aware SessionScope into concrete Session IDs.
   *
   * undefined
   *   -> ALL
   *
   * []
   *   -> NONE
   *
   * string[]
   *   -> concrete accessible sessions
   */
  private async resolveEffectiveSessionIds(
    scope:
      SessionScope,
  ): Promise<
    string[] | undefined
  > {
    switch (scope.type) {
      /*
       * Unrestricted / global.
       */
      case SessionScopeType.ALL:
        return undefined;

      /*
       * Legacy explicit allowedSessions.
       */
      case SessionScopeType.IDS:
        return [
          ...scope.sessionIds,
        ];

      /*
       * Team Leader ownership.
       */
      case SessionScopeType.OWNER: {
        const sessions =
          await this.sessionRepository.find(
            {
              select: {
                id: true,
              },

              where: {
                ownerTeamLeaderId:
                  scope
                    .ownerTeamLeaderId,
              },
            },
          );

        return sessions.map(
          sessionEntity =>
            sessionEntity.id,
        );
      }

      /*
       * Ownership AND explicit session IDs.
       *
       * NEVER use OR here.
       *
       * Required:
       *
       * ownerTeamLeaderId = :ownerTeamLeaderId
       *
       * AND
       *
       * id IN (:...sessionIds)
       */
      case SessionScopeType
        .OWNER_AND_IDS: {
        if (
          scope.sessionIds
            .length === 0
        ) {
          return [];
        }

        const rows =
          await this.sessionRepository
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
                  scope
                    .sessionIds,
              },
            )
            .getRawMany<{
              id: string;
            }>();

        return rows.map(
          row =>
            row.id,
        );
      }

      /*
       * Explicit no-access scope.
       */
      case SessionScopeType.NONE:
        return [];

      default: {
        const exhaustiveCheck:
          never =
          scope;

        return exhaustiveCheck;
      }
    }
  }

  /**
   * Intersect a caller-supplied optional sessionId with the
   * authenticated effective scope.
   *
   * Transport input may narrow authorization only.
   */
  private intersectRequestedSession(
    effectiveSessionIds:
      | string[]
      | undefined,
    requestedSessionId?:
      string,
  ): string[] | undefined {
    /*
     * No requested session:
     * preserve the complete effective scope.
     */
    if (
      !requestedSessionId
    ) {
      return effectiveSessionIds;
    }

    /*
     * Global principal narrowed to one requested Session.
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
     * Restricted principal:
     *
     * requested session survives only when already authorized.
     */
    return effectiveSessionIds.includes(
      requestedSessionId,
    )
      ? [
          requestedSessionId,
        ]
      : [];
  }

  async findOne(
    sessionId: string,
    id: string,
  ): Promise<Webhook> {
    /*
     * Scope by both webhook ID and Session ID.
     *
     * Wrong-session webhook IDs intentionally produce 404 so the
     * endpoint does not expose another tenant's webhook existence.
     */
    const webhook =
      await this.webhookRepository.findOne(
        {
          where: {
            id,
            sessionId,
          },
        },
      );

    if (!webhook) {
      throw new NotFoundException(
        `Webhook with id '${id}' not found`,
      );
    }

    return webhook;
  }

  async update(
    sessionId: string,
    id: string,
    dto: UpdateWebhookDto,
  ): Promise<Webhook> {
    const webhook =
      await this.findOne(
        sessionId,
        id,
      );

    if (
      dto.url !==
      undefined
    ) {
      await this.validateWebhookUrl(
        dto.url,
      );

      webhook.url =
        dto.url;
    }

    if (
      dto.events !==
      undefined
    ) {
      webhook.events =
        dto.events;
    }

    /*
     * Empty secret means no HMAC signing.
     */
    if (
      dto.secret !==
      undefined
    ) {
      webhook.secret =
        dto.secret ||
        null;
    }

    if (
      dto.headers !==
      undefined
    ) {
      webhook.headers =
        dto.headers;
    }

    if (
      dto.filters !==
      undefined
    ) {
      webhook.filters =
        dto.filters;
    }

    if (
      dto.active !==
      undefined
    ) {
      webhook.active =
        dto.active;
    }

    if (
      dto.retryCount !==
      undefined
    ) {
      webhook.retryCount =
        dto.retryCount;
    }

    return this.webhookRepository.save(
      webhook,
    );
  }

  async delete(
    sessionId: string,
    id: string,
  ): Promise<void> {
    const webhook =
      await this.findOne(
        sessionId,
        id,
      );

    await this.webhookRepository.remove(
      webhook,
    );
  }

  async test(
    sessionId: string,
    webhookId: string,
  ): Promise<{
    success: boolean;
    statusCode?: number;
    error?: string;
  }> {
    const webhook =
      await this.findOne(
        sessionId,
        webhookId,
      );

    const testPayload:
      WebhookPayload = {
        event:
          'test',

        timestamp:
          new Date()
            .toISOString(),

        sessionId,

        idempotencyKey:
          generateIdempotencyKey(
            'test',
            {
              webhookId:
                webhook.id,
            },
          ),

        deliveryId:
          generateDeliveryId(),

        data: {
          message:
            'This is a test webhook from OpenWA',

          webhookId:
            webhook.id,

          url:
            webhook.url,
        },
      };

    const body =
      JSON.stringify(
        testPayload,
      );

    const headers:
      Record<
        string,
        string
      > = {
        /*
         * Custom headers first so the system-controlled headers below
         * always win.
         */
        ...this.delivery
          .sanitizeCustomHeaders(
            webhook.headers,
          ),

        'Content-Type':
          'application/json',

        'User-Agent':
          'OpenWA-Webhook/1.0.0',

        'X-OpenWA-Event':
          'test',

        'X-OpenWA-Idempotency-Key':
          testPayload
            .idempotencyKey,

        'X-OpenWA-Delivery-Id':
          testPayload
            .deliveryId,

        'X-OpenWA-Retry-Count':
          '0',
      };

    if (
      webhook.secret
    ) {
      headers[
        'X-OpenWA-Signature'
      ] =
        this.delivery
          .generateSignature(
            body,
            webhook.secret,
          );
    }

    try {
      return await withSafeFetch(
        webhook.url,

        {
          method:
            'POST',

          headers,

          body,

          signal:
            AbortSignal.timeout(
              this.configService
                .get<number>(
                  'webhook.timeout',
                  10000,
                ),
            ),
        },

        response => ({
          success:
            response.ok,

          statusCode:
            response.status,
        }),

        {
          guard:
            isSsrfProtectionEnabled(),
        },
      );
    } catch (error) {
      return {
        success:
          false,

        error:
          redactSsrfError(
            error,
            this.logger,
            'webhook test',
          ),
      };
    }
  }

  /**
   * Stable delivery facade used by event producers.
   */
  async dispatch(
    sessionId:
      string,
    event:
      string,
    data:
      Record<
        string,
        unknown
      >,
  ): Promise<void> {
    await this.delivery.dispatch(
      sessionId,
      event,
      data,
    );
  }
}


