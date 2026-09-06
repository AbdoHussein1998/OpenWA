import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { AuthService } from '../auth.service';
import { ApiKeyRole } from '../entities/api-key.entity';
import { REQUIRED_ROLE_KEY, PUBLIC_KEY, SESSION_SCOPED_KEY, UNSCOPED_KEY } from '../decorators/auth.decorators';
import { resolveClientIp } from '../../../common/utils/ip';
import { setRequestActor } from '../../../common/services/request-context';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/entities/audit-log.entity';
import { ApiCapability } from '../capabilities/api-capability';
import { REQUIRED_CAPABILITY_KEY } from '../decorators/capability.decorator';
import { SessionTenantAccessService } from '../../access-control/session-tenant-access.service';


@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
  private readonly authService: AuthService,
  private readonly sessionTenantAccessService: SessionTenantAccessService,
  private readonly reflector: Reflector,
  private readonly configService: ConfigService,
  private readonly auditService: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [context.getHandler(), context.getClass()]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    try {
      return await this.authorize(request, context);
    } catch (err) {
      // Record rejected/denied authentication attempts so the audit log has a forensic trail for
      // credential probing. Fire-and-forget: audit logging is best-effort and must never turn a
      // 401/403 into a failure of the guard itself.
      if (err instanceof UnauthorizedException || err instanceof ForbiddenException) {
        // Stamp at least the IP so the failed-auth audit row below is attributable even though the
        // key was never resolved. setRequestActor is a no-op outside a request scope.
        setRequestActor({ ipAddress: this.getClientIp(request) });
        void this.auditService.logWarn(AuditAction.API_KEY_AUTH_FAILED, {
          ipAddress: this.getClientIp(request),
          method: request.method,
          path: request.path,
          errorMessage: err.message,
        });
      }
      throw err;
    }
  }

  private async authorize(
    request: Request,
    context: ExecutionContext,
  ): Promise<boolean> {
    const apiKeyHeader = this.extractApiKey(request);

    if (!apiKeyHeader) {
      throw new UnauthorizedException(
        'API key is required',
      );
    }

    const requiredRole =
      this.reflector.getAllAndOverride<ApiKeyRole>(
        REQUIRED_ROLE_KEY,
        [
          context.getHandler(),
          context.getClass(),
        ],
      );

    const requiredCapability =
      this.reflector.getAllAndOverride<ApiCapability>(
        REQUIRED_CAPABILITY_KEY,
        [
          context.getHandler(),
          context.getClass(),
        ],
      );

    /*
    * Resolve the route session id.
    *
    * :sessionId is always a session identifier.
    *
    * A bare :id is treated as a session identifier only when the
    * controller/route is explicitly marked @SessionScoped().
    */
    const sessionScoped =
      this.reflector.getAllAndOverride<boolean>(
        SESSION_SCOPED_KEY,
        [
          context.getHandler(),
          context.getClass(),
        ],
      );

    const sessionId = (
      request.params['sessionId'] ||
      (
        sessionScoped
          ? request.params['id']
          : undefined
      )
    ) as string | undefined;

    const clientIp =
      this.getClientIp(request);

    /*
    * Credential validation only.
    *
    * Session authorization is deliberately NOT performed inside
    * validateApiKey(). SessionTenantAccessService is the authority
    * for session scope.
    */
    const apiKey =
      await this.authService.validateApiKey(
        apiKeyHeader,
        clientIp,
      );

    /*
    * Stamp the authenticated actor before authorization checks so
    * rejected requests remain attributable in audit logging.
    */
    setRequestActor({
      apiKeyId: apiKey.id,
      apiKeyName: apiKey.name,
      ipAddress: clientIp,
    });

    /*
    * Legacy @RequireRole compatibility.
    */
    if (
      requiredRole &&
      !this.authService.hasPermission(
        apiKey,
        requiredRole,
      )
    ) {
      throw new ForbiddenException(
        `Insufficient permissions. Required: ${requiredRole}`,
      );
    }

    /*
    * Fine-grained capability authorization.
    */
    if (
      requiredCapability &&
      !this.authService.hasCapability(
        apiKey,
        requiredCapability,
      )
    ) {
      throw new ForbiddenException(
        `Insufficient permissions. Required capability: ${requiredCapability}`,
      );
    }

    /*
    * Administrative routes that explicitly require an unscoped key
    * remain unavailable to keys carrying an allowedSessions ceiling.
    */
    const requireUnscoped =
      this.reflector.getAllAndOverride<boolean>(
        UNSCOPED_KEY,
        [
          context.getHandler(),
          context.getClass(),
        ],
      );

    if (
      requireUnscoped &&
      (apiKey.allowedSessions?.length ?? 0) > 0
    ) {
      throw new ForbiddenException(
        'Session-scoped API keys are not permitted on this route',
      );
    }

    /*
    * Central tenant/session authorization.
    *
    * This is the only REST location that decides whether the
    * authenticated principal may access a concrete session.
    */
    if (sessionId) {
      await this.sessionTenantAccessService.assertSessionAccess(
        apiKey,
        sessionId,
      );
    }

    /*
    * Expose authenticated context to downstream controllers.
    */
    (
      request as Request & {
        apiKey: typeof apiKey;
      }
    ).apiKey = apiKey;

    (
      request as Request & {
        clientIp?: string;
      }
    ).clientIp = clientIp;

    return true;
  }

  private extractApiKey(request: Request): string | undefined {
    // Support both X-API-Key header and Authorization Bearer
    const xApiKey = request.headers['x-api-key'] as string;
    if (xApiKey) return xApiKey;

    const authHeader = request.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    return undefined;
  }

  /**
   * Resolve the real client IP used for the API key's allowedIps whitelist.
   *
   * X-Forwarded-For is client-controllable, so it is only honored when the
   * request actually arrives from a configured trusted proxy (TRUSTED_PROXIES).
   * With no trusted proxies configured, the header is ignored entirely and the
   * direct socket address is used — preventing IP-whitelist spoofing.
   */
  private getClientIp(request: Request): string {
    const trustedProxies = this.configService.get<string[]>('security.trustedProxies') ?? [];
    return resolveClientIp(request, trustedProxies);
  }
}
