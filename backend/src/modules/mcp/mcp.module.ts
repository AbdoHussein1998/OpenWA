
import {
  type DynamicModule,
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';

import { HttpAdapterHost } from '@nestjs/core';

import { ToolRegistryService } from '../../core/agent-tools/tool-registry.service';

import { AuthModule } from '../auth/auth.module';
import { ApiKeyAuthenticator } from '../auth/authentication/api-key-authenticator.service';
import { AuthorizationService } from '../access-control/authorization.service';

import { AuditService } from '../audit/audit.service';

import { AccessControlModule } from '../access-control/access-control.module';

import { SessionTenantAccessService } from '../access-control/session-tenant-access.service';

import {
  KeyRateLimiter,
  readRateLimitConfig,
  readIpRateLimitConfig,
} from './mcp-rate-limit';

import { mountMcpServer } from './mcp.server';

export interface McpModuleOptions {
  basePath?: string;

  serverInfo?: {
    name: string;
    version: string;
  };
}

// Module-level options store: set by forRoot(), read by configure().
//
// Safe because configure() runs after DI resolution
// (i.e. after forRoot() has been called).
let _moduleOptions: McpModuleOptions = {};

@Module({
  /*
   * Phase J — MCP authorization.
   *
   * MCP does not pass through REST guards, so its tool invocation surface
   * needs direct access to SessionTenantAccessService.
   *
   * This keeps the authorization architecture consistent:
   *
   *   ApiKeyAuthenticator
   *     -> credential validation
   *
   *   AuthorizationService
   *     -> capability/legacy-role authorization
   *
   *   SessionTenantAccessService
   *     -> tenant/session authorization
   */
  imports: [
    AuthModule,
    AccessControlModule,
  ],
})
export class McpModule implements NestModule {
  constructor(
    private readonly registry: ToolRegistryService,

    private readonly authenticator: ApiKeyAuthenticator,

    private readonly authorizationService: AuthorizationService,

    private readonly sessionTenantAccessService: SessionTenantAccessService,

    private readonly httpAdapterHost: HttpAdapterHost,

    /*
     * AuditModule is @Global(), so AuditService is injectable here
     * without an explicit import.
     */
    private readonly auditService: AuditService,
  ) {}

  static forRoot(
    options: McpModuleOptions = {},
  ): DynamicModule {
    _moduleOptions = options;

    return {
      module: McpModule,

      global: false,

      providers: [],

      exports: [],
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  configure(
    _consumer: MiddlewareConsumer,
  ): void {
    const httpAdapter =
      this.httpAdapterHost.httpAdapter;

    if (!httpAdapter) {
      throw new Error(
        'McpModule: HttpAdapterHost.httpAdapter is not available.',
      );
    }

    const {
      basePath,
      serverInfo,
    } = _moduleOptions;

    /*
     * Authenticated per-key rate limiter.
     *
     * invokeTool() calls this only after validateApiKey succeeds, so
     * anonymous callers cannot allocate arbitrary key buckets.
     */
    const {
      max,
      windowMs,
    } = readRateLimitConfig();

    const rateLimiter =
      new KeyRateLimiter(
        max,
        windowMs,
      );

    /*
     * Pre-auth IP limiter.
     *
     * MCP is mounted directly on the HTTP adapter rather than passing
     * through Nest guards, so invalid/missing credentials must be throttled
     * before they can repeatedly cause authentication DB lookups.
     */
    const ipCfg =
      readIpRateLimitConfig();

    const ipRateLimiter =
      new KeyRateLimiter(
        ipCfg.max,
        ipCfg.windowMs,
      );

    /*
     * Phase J:
     *
     * SessionTenantAccessService is passed explicitly into the MCP server
     * and eventually into invokeTool().
     *
     * Do not rely on REST ApiKeyGuard / @SessionScoped() here.
     */
    mountMcpServer(
      httpAdapter,
      this.registry,
      this.authenticator,
      this.authorizationService,
      this.sessionTenantAccessService,
      rateLimiter,
      ipRateLimiter,
      {
        basePath,
        serverInfo,
      },
      this.auditService,
    );
  }
}



