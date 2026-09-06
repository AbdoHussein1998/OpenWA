


import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

import { AuthService } from '../auth.service';

import {
  ApiKeyRole,
} from '../entities/api-key.entity';

import {
  REQUIRED_ROLE_KEY,
  PUBLIC_KEY,
  SESSION_SCOPED_KEY,
  UNSCOPED_KEY,
} from '../decorators/auth.decorators';

import {
  resolveClientIp,
} from '../../../common/utils/ip';

import {
  setRequestActor,
} from '../../../common/services/request-context';

import {
  AuditService,
} from '../../audit/audit.service';

import {
  AuditAction,
} from '../../audit/entities/audit-log.entity';

import {
  ApiCapability,
} from '../capabilities/api-capability';

import {
  REQUIRED_CAPABILITY_KEY,
} from '../decorators/capability.decorator';

import {
  SessionTenantAccessService,
} from '../../access-control/session-tenant-access.service';


@Injectable()
export class ApiKeyGuard
  implements CanActivate
{
  constructor(
    private readonly authService:
      AuthService,

    private readonly sessionTenantAccessService:
      SessionTenantAccessService,

    private readonly reflector:
      Reflector,

    private readonly configService:
      ConfigService,

    private readonly auditService:
      AuditService,
  ) {}

  async canActivate(
    context:
      ExecutionContext,
  ): Promise<boolean> {
    /*
     * Public routes bypass API-key authentication entirely.
     */
    const isPublic =
      this.reflector
        .getAllAndOverride<boolean>(
          PUBLIC_KEY,
          [
            context.getHandler(),
            context.getClass(),
          ],
        );

    if (isPublic) {
      return true;
    }

    const request =
      context
        .switchToHttp()
        .getRequest<Request>();

    try {
      return await this.authorize(
        request,
        context,
      );
    } catch (err) {
      /*
       * Credential / capability authorization failures.
       *
       * Keep these separate from tenant access denials.
       *
       * 401:
       *   missing / invalid / revoked / expired credential
       *
       * 403:
       *   authenticated but insufficient role/capability
       *
       * Tenant 404s are audited closer to assertSessionAccess() below as
       * TENANT_ACCESS_DENIED.
       */
      if (
        err instanceof
          UnauthorizedException ||
        err instanceof
          ForbiddenException
      ) {
        const clientIp =
          this.getClientIp(
            request,
          );

        /*
         * Stamp at least the IP so a failed credential attempt remains
         * attributable even if no ApiKey identity could be resolved.
         *
         * setRequestActor() is a no-op outside request scope.
         */
        setRequestActor({
          ipAddress:
            clientIp,
        });

        /*
         * Best-effort only.
         *
         * Audit persistence must never alter the HTTP authorization result.
         */
        void this.auditService
          .logWarn(
            AuditAction
              .API_KEY_AUTH_FAILED,
            {
              ipAddress:
                clientIp,

              method:
                request.method,

              path:
                request.path,

              errorMessage:
                err.message,
            },
          );
      }

      throw err;
    }
  }

  private async authorize(
    request:
      Request,

    context:
      ExecutionContext,
  ): Promise<boolean> {
    const apiKeyHeader =
      this.extractApiKey(
        request,
      );

    if (!apiKeyHeader) {
      throw new UnauthorizedException(
        'API key is required',
      );
    }

    /*
     * Legacy role-based authorization.
     *
     * Kept for backward compatibility while migrated routes use
     * requiredCapability.
     */
    const requiredRole =
      this.reflector
        .getAllAndOverride<ApiKeyRole>(
          REQUIRED_ROLE_KEY,
          [
            context.getHandler(),
            context.getClass(),
          ],
        );

    /*
     * Fine-grained capability authorization.
     */
    const requiredCapability =
      this.reflector
        .getAllAndOverride<ApiCapability>(
          REQUIRED_CAPABILITY_KEY,
          [
            context.getHandler(),
            context.getClass(),
          ],
        );

    /*
     * Resolve the concrete route session id.
     *
     * :sessionId is always considered a session identifier.
     *
     * A generic :id parameter is considered a session identifier only when
     * the route/controller is explicitly decorated with @SessionScoped().
     */
    const sessionScoped =
      this.reflector
        .getAllAndOverride<boolean>(
          SESSION_SCOPED_KEY,
          [
            context.getHandler(),
            context.getClass(),
          ],
        );

    const sessionId =
      (
        request.params[
          'sessionId'
        ] ||
        (
          sessionScoped
            ? request.params[
                'id'
              ]
            : undefined
        )
      ) as
        | string
        | undefined;

    const clientIp =
      this.getClientIp(
        request,
      );

    /*
     * -----------------------------------------------------------------------
     * 1. CREDENTIAL AUTHENTICATION
     * -----------------------------------------------------------------------
     *
     * AuthService validates:
     *
     * - credential
     * - revoked state
     * - expiry
     * - allowed IPs
     *
     * It deliberately does NOT perform session authorization.
     *
     * Tenant authorization belongs exclusively to:
     *
     * SessionTenantAccessService.
     */
    const apiKey =
      await this.authService
        .validateApiKey(
          apiKeyHeader,
          clientIp,
        );

    /*
     * Stamp the authenticated actor before all subsequent authorization
     * checks.
     *
     * This means role/capability/tenant denials remain attributable to the
     * authenticated key in request-scoped audit context.
     */
    setRequestActor({
      apiKeyId:
        apiKey.id,

      apiKeyName:
        apiKey.name,

      ipAddress:
        clientIp,
    });

    /*
     * -----------------------------------------------------------------------
     * 2. LEGACY ROLE AUTHORIZATION
     * -----------------------------------------------------------------------
     */
    if (
      requiredRole &&
      !this.authService
        .hasPermission(
          apiKey,
          requiredRole,
        )
    ) {
      throw new ForbiddenException(
        `Insufficient permissions. Required: ${requiredRole}`,
      );
    }

    /*
     * -----------------------------------------------------------------------
     * 3. CAPABILITY AUTHORIZATION
     * -----------------------------------------------------------------------
     *
     * Capability answers:
     *
     *   WHAT may this identity do?
     */
    if (
      requiredCapability &&
      !this.authService
        .hasCapability(
          apiKey,
          requiredCapability,
        )
    ) {
      throw new ForbiddenException(
        `Insufficient permissions. Required capability: ${requiredCapability}`,
      );
    }

    /*
     * -----------------------------------------------------------------------
     * 4. UNSCOPED ADMINISTRATIVE ROUTE FENCE
     * -----------------------------------------------------------------------
     *
     * Routes explicitly requiring an unscoped key remain unavailable to
     * credentials carrying an allowedSessions ceiling.
     */
    const requireUnscoped =
      this.reflector
        .getAllAndOverride<boolean>(
          UNSCOPED_KEY,
          [
            context.getHandler(),
            context.getClass(),
          ],
        );

    if (
      requireUnscoped &&
      (
        apiKey.allowedSessions
          ?.length ??
        0
      ) > 0
    ) {
      throw new ForbiddenException(
        'Session-scoped API keys are not permitted on this route',
      );
    }

    /*
     * -----------------------------------------------------------------------
     * 5. TENANT / SESSION AUTHORIZATION
     * -----------------------------------------------------------------------
     *
     * SessionTenantAccessService answers:
     *
     *   WHERE may this identity act?
     *
     * It remains the single tenant policy used by REST, WebSocket and MCP.
     */
    if (sessionId) {
      try {
        await this
          .sessionTenantAccessService
          .assertSessionAccess(
            apiKey,
            sessionId,
          );
      } catch (err) {
        /*
         * Phase K — tenant-denial audit.
         *
         * SessionTenantAccessService intentionally uses 404 semantics for:
         *
         * - nonexistent session
         * - foreign Team Leader session
         * - Agent accessing an unassigned session
         * - Agent accessing another session
         * - Agent whose assignment/owner relationship is stale or invalid
         *
         * These cases are intentionally indistinguishable to the caller.
         */
        if (
          err instanceof
            NotFoundException
        ) {
          /*
           * Best-effort audit.
           *
           * Do NOT wait for the write and do NOT allow an audit failure to
           * change the authorization response.
           */
          void this.auditService
            .logWarn(
              AuditAction
                .TENANT_ACCESS_DENIED,
              {
                ipAddress:
                  clientIp,

                method:
                  request.method,

                path:
                  request.path,

                statusCode:
                  err.getStatus(),

                /*
                 * Keep tenant-sensitive information inside controlled audit
                 * metadata.
                 *
                 * attemptedSessionId is safe because it came from the caller.
                 *
                 * Never add:
                 *
                 * - foreign session name
                 * - foreign owner identity
                 * - another tenant's metadata
                 */
                metadata: {
                  surface:
                    'rest',

                  attemptedSessionId:
                    sessionId,

                  ...(
                    apiKey.teamLeaderId
                      ? {
                          teamLeaderId:
                            apiKey
                              .teamLeaderId,
                        }
                      : {}
                  ),

                  ...(
                    apiKey.agentId
                      ? {
                          agentId:
                            apiKey
                              .agentId,
                        }
                      : {}
                  ),
                },

                /*
                 * Keep this generic.
                 *
                 * The underlying NotFoundException may intentionally hide
                 * whether the session exists or belongs to another tenant.
                 */
                errorMessage:
                  'Tenant session access denied',
              },
            );
        }

        throw err;
      }
    }

    /*
     * -----------------------------------------------------------------------
     * 6. EXPOSE AUTHENTICATED CONTEXT
     * -----------------------------------------------------------------------
     *
     * Controllers/services receive only the already-authenticated identity.
     */
    (
      request as
        Request & {
          apiKey:
            typeof apiKey;
        }
    ).apiKey =
      apiKey;

    (
      request as
        Request & {
          clientIp?:
            string;
        }
    ).clientIp =
      clientIp;

    return true;
  }

  private extractApiKey(
    request:
      Request,
  ): string | undefined {
    /*
     * Support:
     *
     * X-API-Key: ...
     */
    const xApiKey =
      request.headers[
        'x-api-key'
      ] as
        | string
        | undefined;

    if (xApiKey) {
      return xApiKey;
    }

    /*
     * And:
     *
     * Authorization: Bearer ...
     */
    const authHeader =
      request.headers[
        'authorization'
      ];

    if (
      authHeader
        ?.startsWith(
          'Bearer ',
        )
    ) {
      return authHeader
        .substring(
          7,
        );
    }

    return undefined;
  }

  /**
   * Resolve the real client IP used for the API key's allowedIps whitelist.
   *
   * X-Forwarded-For is client-controllable, so it is only honored when the
   * request actually arrives from a configured trusted proxy
   * (TRUSTED_PROXIES).
   *
   * With no trusted proxies configured, X-Forwarded-For is ignored and the
   * direct socket address is used.
   */
  private getClientIp(
    request:
      Request,
  ): string {
    const trustedProxies =
      this.configService
        .get<string[]>(
          'security.trustedProxies',
        ) ??
      [];

    return resolveClientIp(
      request,
      trustedProxies,
    );
  }
}


