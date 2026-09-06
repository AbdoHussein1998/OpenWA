


import type { z } from 'zod';

import type { ApiKey } from '../../modules/auth/entities/api-key.entity';
import type { ApiKeyRole } from '../../modules/auth/entities/api-key.entity';
import type { ApiCapability } from '../../modules/auth/capabilities/api-capability';
import type { SessionScope } from '../../modules/access-control/session-scope';

/**
 * Context resolved by the invoker from authenticated server state.
 *
 * Tool input must never be trusted to provide tenant scope.
 */
export interface ToolInvocationContext {
  /**
   * Effective tenant scope for aggregate/global tools.
   *
   * Present only when `aggregateSessionScoped === true`.
   *
   * The handler/service must use this scope when querying across sessions.
   */
  sessionScope?: SessionScope;
}

/**
 * A single agent-invocable capability.
 *
 * Protocol-neutral: no MCP SDK types here.
 */
export interface ToolDescriptor<I = unknown> {
  /** Explicit, stable public name, e.g. 'MessageSendText'. */
  name: string;

  /** Agent-legible description: what it does, when to use it, preconditions. */
  description: string;

  /** Input contract: validates the call AND is advertised to the agent. */
  inputSchema: z.ZodType<I>;

  tier: 'read' | 'write';

  /** True for irreversible/dangerous ops (none are exposed in v1). */
  destructive?: boolean;

  /** Safe to repeat without additional effect. Defaults to (tier === 'read'). */
  idempotent?: boolean;

  /**
   * Phase J authorization.
   *
   * Capability required to invoke this tool.
   *
   * This is the preferred authorization mechanism because capabilities describe
   * WHAT an identity may do independently from WHERE it may do it.
   */
  requiredCapability?: ApiCapability;

  /**
   * Legacy migration fallback.
   *
   * @deprecated
   * Phase J tools should migrate to `requiredCapability`.
   *
   * The invoker uses this only when `requiredCapability` is absent.
   * Keeping it temporarily prevents the complete existing MCP tool registry
   * from breaking while individual tools are migrated.
   */
  requiredRole?: ApiKeyRole;

  /**
   * The tool operates on exactly one WhatsApp session.
   *
   * When true:
   *
   * - input MUST contain a non-empty string `sessionId`
   * - SessionTenantAccessService.assertSessionAccess(apiKey, sessionId)
   *   runs before the handler
   *
   * The handler must never implement TEAM_LEADER / AGENT / allowedSessions
   * authorization independently.
   */
  sessionScoped?: boolean;

  /**
   * The tool performs an aggregate/global operation across sessions.
   *
   * When true, the invoker resolves:
   *
   *   SessionTenantAccessService.getEffectiveSessionScope(apiKey)
   *
   * and supplies it to the handler through:
   *
   *   context.sessionScope
   *
   * The downstream service/query must intersect its results with that scope.
   *
   * A descriptor must NOT set both `sessionScoped` and
   * `aggregateSessionScoped`.
   */
  aggregateSessionScoped?: boolean;

  /** Result rendering hint for the MCP adapter. Default 'smart'. */
  resultDisposition?: 'json' | 'smart';

  /**
   * Calls the underlying service.
   *
   * Receives:
   *
   * 1. validated input
   * 2. authenticated API key
   * 3. server-resolved invocation context
   */
  handler: (
    input: I,
    apiKey: ApiKey,
    context: ToolInvocationContext,
  ) => Promise<unknown>;
}

/**
 * A descriptor with its input type erased, for storing tools of different
 * shapes in one list.
 *
 * The handler parameter is `never`, not `unknown`.
 *
 * Under `strictFunctionTypes` parameters are checked CONTRAVARIANTLY, so a
 * handler accepting a specific validated shape is assignable to one accepting
 * `never` but not one accepting `unknown`.
 *
 * The erasure remains sound because ToolInvoker parses the descriptor's own
 * `inputSchema` before invoking its handler.
 */
export type AnyToolDescriptor = Omit<
  ToolDescriptor,
  'inputSchema' | 'handler'
> & {
  inputSchema: z.ZodType;

  handler: (
    input: never,
    apiKey: ApiKey,
    context: ToolInvocationContext,
  ) => Promise<unknown>;
};

/**
 * Declare one tool, tying its handler to its own schema.
 *
 * Also fail fast on an invalid tenant-scope declaration. A tool must be either:
 *
 * - single-session scoped
 * - aggregate-session scoped
 * - not session scoped
 *
 * but never both single-session and aggregate.
 */
export function defineTool<I>(
  descriptor: ToolDescriptor<I>,
): AnyToolDescriptor {
  if (
    descriptor.sessionScoped &&
    descriptor.aggregateSessionScoped
  ) {
    throw new Error(
      `Tool '${descriptor.name}' cannot be both sessionScoped and aggregateSessionScoped`,
    );
  }

  return descriptor;
}


