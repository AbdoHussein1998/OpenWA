




import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

import { ZodError } from 'zod';

import type { AuthService } from '../../modules/auth/auth.service';
import type { SessionTenantAccessService } from '../../modules/access-control/session-tenant-access.service';
import type { SessionScope } from '../../modules/access-control/session-scope';

import type {
  AnyToolDescriptor,
  ToolInvocationContext,
} from './tool-descriptor';

/**
 * Run one tool call with REST-equivalent authorization guarantees.
 *
 * Phase J pipeline:
 *
 *   credential validation
 *          ↓
 *   capability check
 *          ↓
 *   tenant authorization
 *          ↓
 *   Zod validation
 *          ↓
 *   handler
 *
 * Important:
 *
 * AuthService answers:
 *
 *   "WHAT may this identity do?"
 *
 * SessionTenantAccessService answers:
 *
 *   "WHERE may this identity do it?"
 *
 * MCP must not duplicate TEAM_LEADER / AGENT / allowedSessions authorization
 * logic itself.
 *
 * `clientIp` remains undefined over MCP. A key carrying `allowedIps` therefore
 * fails closed inside validateApiKey.
 *
 * @param onAuthenticated
 * Optional callback invoked with apiKey.id immediately after credential
 * validation succeeds and before capability/tenant/input checks.
 *
 * Used by MCP rate limiting so authenticated identities are keyed by API-key ID
 * instead of allocating buckets from attacker-controlled raw credentials.
 *
 * @param onAuthFailure
 * Optional callback invoked when authentication or authorization fails.
 *
 * This includes:
 *
 * - invalid/missing/revoked/expired credential
 * - missing capability
 * - legacy role fallback failure
 * - tenant/session denial
 *
 * Input validation and handler failures are not auth failures.
 */
export async function invokeTool(
  tool: AnyToolDescriptor,
  rawInput: unknown,
  rawKey: string | undefined,
  authService: AuthService,
  sessionTenantAccessService: SessionTenantAccessService,
  onAuthenticated?: (apiKeyId: string) => void,
  onAuthFailure?: (error: unknown) => void,
): Promise<unknown> {
  /*
   * Descriptor configuration errors are application bugs, not caller auth
   * failures.
   */
  if (
    tool.sessionScoped &&
    tool.aggregateSessionScoped
  ) {
    throw new Error(
      `Tool '${tool.name}' cannot be both sessionScoped and aggregateSessionScoped`,
    );
  }

  let apiKey: Awaited<
    ReturnType<typeof authService.validateApiKey>
  >;

  let effectiveSessionScope: SessionScope | undefined;

  /*
   * AUTHORIZATION PHASE
   *
   * Mirrors the REST security architecture without assuming REST guards
   * execute for MCP.
   */
  try {
    if (!rawKey) {
      throw new UnauthorizedException(
        'Missing API key',
      );
    }

    /*
     * Phase J:
     *
     * Credential validation does NOT receive sessionId anymore.
     *
     * Credential/IP/expiry validation belongs to AuthService.
     * Tenant authorization belongs exclusively to
     * SessionTenantAccessService.
     */
    apiKey = await authService.validateApiKey(
      rawKey,
      undefined,
    );

    onAuthenticated?.(
      apiKey.id,
    );

    /*
     * Capability is authoritative for migrated Phase J tools.
     *
     * requiredRole remains only as a migration fallback so existing tools
     * continue compiling while their descriptors are converted.
     *
     * IMPORTANT:
     *
     * If requiredCapability exists, requiredRole is deliberately ignored.
     * Otherwise an AGENT possessing MESSAGE_SEND could still be rejected by
     * an old OPERATOR role requirement, defeating capability-based RBAC.
     */
    if (tool.requiredCapability) {
      if (
        !authService.hasCapability(
          apiKey,
          tool.requiredCapability,
        )
      ) {
        throw new ForbiddenException(
          'API key lacks the required capability',
        );
      }
    } else if (
      tool.requiredRole &&
      !authService.hasPermission(
        apiKey,
        tool.requiredRole,
      )
    ) {
      throw new ForbiddenException(
        'API key lacks the required role',
      );
    }

    /*
     * Single-session tenant authorization.
     *
     * Like REST route guards, we need sessionId before full DTO/Zod
     * validation so authorization happens before the tool handler.
     *
     * We only probe the value here. The complete object is still validated by
     * the tool's own Zod schema afterwards.
     */
    if (tool.sessionScoped) {
      const probe =
        (
          rawInput ?? {}
        ) as Record<string, unknown>;

      const rawSessionId =
        probe.sessionId;

      const sessionId =
        typeof rawSessionId === 'string' &&
        rawSessionId.trim().length > 0
          ? rawSessionId
          : undefined;

      /*
       * Fail closed.
       *
       * A session-scoped tool without sessionId cannot simply skip tenant
       * authorization.
       */
      if (!sessionId) {
        throw new BadRequestException(
          'sessionId is required for this tool',
        );
      }

      /*
       * Central tenant policy.
       *
       * Handles:
       *
       * ADMIN / legacy       -> allowedSessions semantics
       * TEAM_LEADER          -> ownership
       * AGENT                -> assigned session AND matching owner
       *
       * Foreign/nonexistent/unassigned access keeps the normal tenancy error
       * semantics from SessionTenantAccessService.
       */
      await sessionTenantAccessService
        .assertSessionAccess(
          apiKey,
          sessionId,
        );
    }

    /*
     * Aggregate/global MCP authorization.
     *
     * Do NOT pass apiKey.allowedSessions to aggregate handlers. That cannot
     * represent OWNER / OWNER_AND_IDS / NONE.
     *
     * Resolve the same effective SessionScope used by REST aggregate routes.
     */
    if (
      tool.aggregateSessionScoped
    ) {
      effectiveSessionScope =
        await sessionTenantAccessService
          .getEffectiveSessionScope(
            apiKey,
          );
    }
  } catch (error) {
    /*
     * The MCP adapter may use this hook for auth/security audit events.
     *
     * Phase K can distinguish ordinary credential/capability failures from
     * tenant-denial 404s and record TENANT_ACCESS_DENIED.
     */
    onAuthFailure?.(
      error,
    );

    throw error;
  }

  /*
   * VALIDATION PHASE
   *
   * Authorization has already completed. Zod now determines the complete
   * service input contract.
   */
  let input: unknown;

  try {
    input =
      tool.inputSchema.parse(
        rawInput,
      );
  } catch (error) {
    if (
      error instanceof ZodError
    ) {
      throw new BadRequestException(
        error.issues.map(
          issue =>
            `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        ),
      );
    }

    throw error;
  }

  /*
   * SERVER-RESOLVED CONTEXT
   *
   * Aggregate handlers receive effective SessionScope here. It never comes
   * from MCP client input.
   */
  const context: ToolInvocationContext = {
    sessionScope:
      effectiveSessionScope,
  };

  /*
   * The single cast required by AnyToolDescriptor's erased input type.
   *
   * `input` has just passed this exact descriptor's inputSchema, so it is the
   * type its handler declared.
   */
  return tool.handler(
    input as never,
    apiKey,
    context,
  );
}



