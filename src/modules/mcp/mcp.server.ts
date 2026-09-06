


import {
  ForbiddenException,
  HttpException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';

import type { HttpAdapterHost } from '@nestjs/core';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';

import type {
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';

import express, {
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { invokeTool } from '../../core/agent-tools/tool-invoker';

import type { ToolRegistryService } from '../../core/agent-tools/tool-registry.service';

import type { AuthService } from '../auth/auth.service';

import type { SessionTenantAccessService } from '../access-control/session-tenant-access.service';

import type { AuditService } from '../audit/audit.service';

import { AuditAction } from '../audit/entities/audit-log.entity';

import {
  handleToolError,
  jsonToolResult,
  smartToolResult,
} from './tool-result';

import type { KeyRateLimiter } from './mcp-rate-limit';

import { resolveClientIp } from '../../common/utils/ip';

import { resolveBodyLimit } from '../../config/bootstrap-security';

const logger = new Logger('McpServer');

type HttpAdapter =
  NonNullable<HttpAdapterHost['httpAdapter']>;

type ToolExtra =
  RequestHandlerExtra<
    ServerRequest,
    ServerNotification
  >;

/**
 * Request-scoped context forwarded to the audit trail on an MCP auth
 * failure (mirrors the REST guard).
 */
export interface McpRequestContext {
  ipAddress?: string;
  method?: string;
  path?: string;
}

/**
 * Extract the raw API key from MCP request headers.
 *
 * Accepts:
 *
 * - X-Api-Key
 * - Authorization: Bearer ...
 */
function extractApiKey(
  extra: ToolExtra,
): string | undefined {
  const headers =
    extra.requestInfo?.headers ?? {};

  const xApiKey =
    headers['x-api-key'];

  if (xApiKey) {
    return Array.isArray(xApiKey)
      ? xApiKey[0]
      : xApiKey;
  }

  const auth =
    headers['authorization'];

  const authStr =
    Array.isArray(auth)
      ? auth[0]
      : auth;

  if (
    authStr
      ?.toLowerCase()
      .startsWith('bearer ')
  ) {
    return authStr
      .slice(7)
      .trim();
  }

  return undefined;
}

/**
 * Mirror the REST ApiKeyGuard's auth-failure audit trail for MCP.
 *
 * The MCP mount is raw Express and therefore sits outside the Nest guard
 * pipeline. Without this hook, credential probing against /mcp would leave
 * no equivalent forensic record.
 *
 * Existing behavior is intentionally preserved here:
 *
 * - 401 -> API_KEY_AUTH_FAILED
 * - 403 -> API_KEY_AUTH_FAILED
 * - other errors are not recorded by this hook
 *
 * Phase K may extend tenant-denial auditing separately.
 */
export function auditMcpAuthFailure(
  auditService:
    Pick<AuditService, 'logWarn'> |
    undefined,
  error: unknown,
  reqContext: McpRequestContext,
): void {
  if (!auditService) {
    return;
  }

  if (
    error instanceof UnauthorizedException ||
    error instanceof ForbiddenException
  ) {
    void auditService.logWarn(
      AuditAction.API_KEY_AUTH_FAILED,
      {
        ipAddress:
          reqContext.ipAddress,

        method:
          reqContext.method,

        path:
          reqContext.path,

        errorMessage:
          error instanceof Error
            ? error.message
            : String(error),
      },
    );
  }
}

/**
 * Read TRUSTED_PROXIES once as a list.
 *
 * Shared by the pre-auth throttle and audit IP resolver.
 */
function readTrustedProxies(): string[] {
  return (
    process.env.TRUSTED_PROXIES ??
    ''
  )
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

/**
 * Resolve trusted-proxy-aware client IP plus HTTP method/path for audit.
 */
function resolveReqContext(
  req: Request,
): McpRequestContext {
  return {
    ipAddress:
      resolveClientIp(
        req,
        readTrustedProxies(),
      ),

    method:
      req.method,

    path:
      req.path,
  };
}

/**
 * Build one MCP server and register the available tools.
 *
 * Phase J authorization dependencies:
 *
 *   AuthService
 *       -> credential / capability authorization
 *
 *   SessionTenantAccessService
 *       -> session tenancy / aggregate SessionScope
 *
 * MCP must not rely on REST guards because this surface is mounted directly
 * on the HTTP adapter.
 */
function buildServer(
  registry: ToolRegistryService,
  authService: AuthService,
  sessionTenantAccessService: SessionTenantAccessService,
  rateLimiter: KeyRateLimiter,
  readOnly: boolean,
  serverInfo: {
    name: string;
    version: string;
  },
  auditService:
    AuditService |
    undefined,
  reqContext: McpRequestContext,
): McpServer {
  const server =
    new McpServer(
      {
        name:
          serverInfo.name,

        version:
          serverInfo.version,
      },
      {
        capabilities: {
          tools: {},
          logging: {},
        },
      },
    );

  const tools =
    registry.list({
      readOnly,
    });

  for (
    const tool of tools
  ) {
    server.registerTool(
      tool.name,
      {
        description:
          tool.description,

        /*
         * The SDK's InputArgs is inferred from this property.
         *
         * Widening it to the complete ZodRawShapeCompat | AnySchema
         * constraint would collapse the callback type inferred by the SDK.
         *
         * tool.inputSchema is already the descriptor's authoritative schema.
         */
        inputSchema:
          tool.inputSchema as AnySchema,

        annotations: {
          readOnlyHint:
            tool.tier === 'read',

          destructiveHint:
            tool.destructive ??
            false,

          idempotentHint:
            tool.idempotent ??
            tool.tier === 'read',
        },
      },

      async (
        input:
          Record<string, unknown>,
        extra:
          ToolExtra,
      ) => {
        const rawKey =
          extractApiKey(
            extra,
          );

        try {
          /*
           * Phase J pipeline:
           *
           * validateApiKey
           *      ↓
           * capability / legacy-role authorization
           *      ↓
           * SessionTenantAccessService
           *      ↓
           * Zod validation
           *      ↓
           * tool handler
           */
          const result =
            await invokeTool(
              tool,
              input,
              rawKey,
              authService,

              /*
               * Phase J:
               *
               * Single-session tools call assertSessionAccess().
               *
               * Aggregate-session tools call
               * getEffectiveSessionScope().
               */
              sessionTenantAccessService,

              /*
               * Per-key rate limiting.
               *
               * invokeTool calls this immediately after successful
               * credential validation, preserving the existing behavior
               * where anonymous raw credentials cannot allocate arbitrary
               * authenticated rate-limit buckets.
               */
              id =>
                rateLimiter.check(
                  id,
                ),

              /*
               * Existing MCP auth audit hook.
               *
               * Fires inside invokeTool's authorization phase, before input
               * validation or the tool handler.
               *
               * Consequently a handler-thrown 403 is still not mislabeled
               * as an authentication failure.
               */
              error =>
                auditMcpAuthFailure(
                  auditService,
                  error,
                  reqContext,
                ),
            );

          return (
            tool.resultDisposition ===
            'json'
          )
            ? jsonToolResult(
                result as object,
              )
            : smartToolResult(
                result as object,
              );
        } catch (error) {
          /*
           * Preserve existing MCP error translation.
           */
          return handleToolError(
            error,
          );
        }
      },
    );
  }

  logger.log(
    `MCP server built with ${tools.length} tools (readOnly=${readOnly})`,
  );

  return server;
}

export interface MountMcpServerOptions {
  basePath?: string;

  serverInfo?: {
    name: string;
    version: string;
  };

  readOnly?: boolean;
}

/**
 * Mount the MCP Streamable-HTTP transport on the existing Nest/Express
 * adapter at POST {basePath} (default /mcp).
 *
 * Tool handlers are built once per MCP request around the same application
 * services:
 *
 * - ToolRegistryService
 * - AuthService
 * - SessionTenantAccessService
 * - KeyRateLimiter
 *
 * Per request:
 *
 *   fresh McpServer
 *      ↓
 *   StreamableHTTPServerTransport
 *      ↓
 *   handle request
 *      ↓
 *   tear down
 *
 * Stateless:
 *
 *   sessionIdGenerator: undefined
 *
 * There is therefore no MCP transport-session map and no GET/DELETE
 * reconnect surface.
 */
export function mountMcpServer(
  httpAdapter: HttpAdapter,
  registry: ToolRegistryService,
  authService: AuthService,

  /*
   * Phase J tenancy dependency.
   *
   * Passed by McpModule from AccessControlModule.
   */
  sessionTenantAccessService: SessionTenantAccessService,

  rateLimiter: KeyRateLimiter,
  ipRateLimiter: KeyRateLimiter,
  options:
    MountMcpServerOptions = {},
  auditService?: AuditService,
): void {
  const basePath =
    (
      options.basePath ??
      '/mcp'
    )
      .replace(
        /\/$/,
        '',
      ) ||
    '/mcp';

  const serverInfo =
    options.serverInfo ?? {
      name: 'openwa',
      version: '0.0.0',
    };

  const readOnly =
    resolveMcpReadOnly(
      options.readOnly,
    );

  /*
   * Eagerly compute the tool list at mount time to validate that the
   * registry is populated and emit the mount log once.
   *
   * A new McpServer is still created for each request to avoid the SDK's
   * single-transport-at-a-time constraint.
   */
  const tools =
    registry.list({
      readOnly,
    });

  logger.log(
    `MCP server mounted at POST ${basePath} (${tools.length} tools)`,
  );

  const handler:
    RequestHandler =
    async (
      req:
        Request,
      res:
        Response,
    ) => {
      const server =
        buildServer(
          registry,
          authService,

          /*
           * Phase J:
           * propagate centralized tenant policy into invokeTool().
           */
          sessionTenantAccessService,

          rateLimiter,
          readOnly,
          serverInfo,
          auditService,
          resolveReqContext(
            req,
          ),
        );

      const transport =
        new StreamableHTTPServerTransport(
          {
            sessionIdGenerator:
              undefined,
          },
        );

      try {
        res.on(
          'close',
          () => {
            void transport.close();
            void server.close();
          },
        );

        await server.connect(
          transport,
        );

        await transport.handleRequest(
          req,
          res,
          req.body,
        );
      } catch (error) {
        logger.error(
          'Error handling MCP request',

          error instanceof Error
            ? error.stack
            : String(error),
        );

        if (
          !res.headersSent
        ) {
          res
            .status(500)
            .json({
              jsonrpc:
                '2.0',

              error: {
                code:
                  -32603,

                message:
                  'Internal server error',
              },

              id:
                null,
            });
        }
      }
    };

  const adapter =
    httpAdapter as unknown as {
      post: (
        path: string,
        ...handlers: RequestHandler[]
      ) => unknown;
    };

  /*
   * The route throttle gates:
   *
   * - authentication DB lookup
   * - per-request MCP server construction
   * - transport construction
   *
   * The global Nest throttler does not cover this raw adapter mount.
   *
   * The process-wide capped body parser in main.ts normally executes first.
   * This route-level parser remains a defensive fallback.
   */
  const bodyLimit =
    resolveBodyLimit(
      process.env.BODY_SIZE_LIMIT,
    );

  adapter.post(
    basePath,

    createIpThrottle(
      ipRateLimiter,
    ),

    express.json({
      limit:
        bodyLimit,

      inflate:
        false,
    }),

    handler,
  );
}

/**
 * Pre-auth, per-IP throttle for the raw Express /mcp mount.
 *
 * This MUST execute before API-key validation because otherwise missing,
 * invalid, or revoked credentials can cause unbounded authentication DB
 * lookups.
 *
 * Errors are written directly as JSON-RPC responses because this route does
 * not pass through Nest's exception pipeline.
 */
export function createIpThrottle(
  ipRateLimiter:
    KeyRateLimiter,
): RequestHandler {
  return (
    req,
    res,
    next,
  ) => {
    const ip =
      resolveClientIp(
        req,
        readTrustedProxies(),
      );

    try {
      ipRateLimiter.check(
        ip,
      );

      next();
    } catch (error) {
      const status =
        error instanceof HttpException
          ? error.getStatus()
          : 429;

      res
        .status(status)
        .json({
          jsonrpc:
            '2.0',

          error: {
            code:
              -32000,

            message:
              error instanceof Error
                ? error.message
                : 'MCP rate limit exceeded',
          },

          id:
            null,
        });
    }
  };
}

/**
 * Resolve MCP read-only mode with a secure default.
 *
 * MCP is read-only unless the operator explicitly sets:
 *
 *   MCP_READONLY=false
 *
 * Explicit programmatic/test configuration still takes precedence.
 */
export function resolveMcpReadOnly(
  optionsReadOnly?: boolean,
): boolean {
  return (
    optionsReadOnly ??
    process.env.MCP_READONLY !==
      'false'
  );
}

