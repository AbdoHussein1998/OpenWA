

import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum AuditAction {
  // ---------------------------------------------------------------------------
  // API Key events
  // ---------------------------------------------------------------------------

  API_KEY_CREATED = 'api_key_created',

  API_KEY_UPDATED = 'api_key_updated',

  API_KEY_USED = 'api_key_used',

  API_KEY_REVOKED = 'api_key_revoked',

  API_KEY_DELETED = 'api_key_deleted',

  API_KEY_AUTH_FAILED = 'api_key_auth_failed',

  // ---------------------------------------------------------------------------
  // Authorization / tenancy events
  // ---------------------------------------------------------------------------

  /**
   * An authenticated principal attempted to access a session outside its
   * effective tenant scope.
   *
   * Used across:
   *
   * - REST
   * - WebSocket
   * - MCP
   *
   * Relevant metadata may include:
   *
   * {
   *   surface: 'rest' | 'websocket' | 'mcp',
   *   attemptedSessionId: string,
   *   teamLeaderId?: string,
   *   agentId?: string,
   * }
   *
   * Do not include foreign session names or other tenant-sensitive data.
   */
  TENANT_ACCESS_DENIED = 'tenant_access_denied',

  // ---------------------------------------------------------------------------
  // Rate-limit enforcement
  // ---------------------------------------------------------------------------

  /**
   * Sampled: at most one row per subject+kind per minute — see
   * EventsGateway — so enforcing a limit never becomes an audit-write flood
   * of its own.
   */
  RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded',

  // ---------------------------------------------------------------------------
  // Queue dashboard (Bull Board) events
  // ---------------------------------------------------------------------------

  QUEUE_BOARD_MUTATED = 'queue_board_mutated',

  // ---------------------------------------------------------------------------
  // Team Leader / Agent management events
  // ---------------------------------------------------------------------------

  /**
   * Team Leader identity and its management credential were created.
   *
   * Recommended metadata:
   *
   * {
   *   teamLeaderId: string
   * }
   */
  TEAM_LEADER_CREATED = 'team_leader_created',

  /**
   * Team Leader identity was deleted.
   *
   * Recommended metadata:
   *
   * {
   *   teamLeaderId: string
   * }
   */
  TEAM_LEADER_DELETED = 'team_leader_deleted',

  /**
   * Agent identity and its management credential were created.
   *
   * Recommended metadata:
   *
   * {
   *   agentId: string,
   *   teamLeaderId: string
   * }
   */
  AGENT_CREATED = 'agent_created',

  /**
   * Agent identity was deleted.
   *
   * Recommended metadata:
   *
   * {
   *   agentId: string,
   *   teamLeaderId: string
   * }
   */
  AGENT_DELETED = 'agent_deleted',

  /**
   * An unassigned Agent was assigned a session.
   *
   * Recommended metadata:
   *
   * {
   *   agentId: string,
   *   teamLeaderId: string,
   *   newSessionId: string
   * }
   */
  AGENT_SESSION_ASSIGNED = 'agent_session_assigned',

  /**
   * An Agent's current session assignment was removed.
   *
   * Recommended metadata:
   *
   * {
   *   agentId: string,
   *   teamLeaderId: string,
   *   previousSessionId: string
   * }
   */
  AGENT_SESSION_UNASSIGNED = 'agent_session_unassigned',

  /**
   * An Agent was moved directly from one session to another.
   *
   * Recommended metadata:
   *
   * {
   *   agentId: string,
   *   teamLeaderId: string,
   *   previousSessionId: string,
   *   newSessionId: string
   * }
   */
  AGENT_SESSION_REASSIGNED = 'agent_session_reassigned',

  // ---------------------------------------------------------------------------
  // Session events
  // ---------------------------------------------------------------------------

  SESSION_CREATED = 'session_created',

  SESSION_STARTED = 'session_started',

  SESSION_STOPPED = 'session_stopped',

  SESSION_FORCE_KILLED = 'session_force_killed',

  SESSION_LOGGED_OUT = 'session_logged_out',

  SESSION_DELETED = 'session_deleted',

  SESSION_CONFIG_UPDATED = 'session_config_updated',

  SESSION_QR_GENERATED = 'session_qr_generated',

  SESSION_CONNECTED = 'session_connected',

  SESSION_DISCONNECTED = 'session_disconnected',

  /**
   * WhatsApp's own judgement of the account, not our connection to it.
   *
   * Unlike SESSION_CONNECTED / SESSION_DISCONNECTED, these ARE audited:
   * they are rare, they are not reconnect noise, and the in-memory store
   * that serves them to the API does not survive a restart. The audit log is
   * therefore the durable record of when an account was restricted and for
   * how long.
   */
  SESSION_RESTRICTED = 'session_restricted',

  SESSION_RESTRICTION_LIFTED = 'session_restriction_lifted',

  // ---------------------------------------------------------------------------
  // Message events
  // ---------------------------------------------------------------------------

  MESSAGE_SENT = 'message_sent',

  MESSAGE_FAILED = 'message_failed',

  /**
   * Send-pacing enforcement.
   *
   * SEND_PACING_BLOCKED is sampled per session — at most one row per session
   * per minute, carrying the suppressed count — following the
   * RATE_LIMIT_EXCEEDED precedent.
   *
   * A breaker trip is rare and alert-worthy, so it is never sampled.
   */
  SEND_PACING_BLOCKED = 'send_pacing_blocked',

  SEND_BREAKER_TRIPPED = 'send_breaker_tripped',

  // ---------------------------------------------------------------------------
  // Webhook events
  // ---------------------------------------------------------------------------

  WEBHOOK_CREATED = 'webhook_created',

  WEBHOOK_DELETED = 'webhook_deleted',

  WEBHOOK_TRIGGERED = 'webhook_triggered',

  WEBHOOK_FAILED = 'webhook_failed',

  // ---------------------------------------------------------------------------
  // Integration plugin-instance events
  // ---------------------------------------------------------------------------

  INTEGRATION_INSTANCE_CREATED = 'integration_instance_created',

  INTEGRATION_INSTANCE_UPDATED = 'integration_instance_updated',

  INTEGRATION_INSTANCE_SECRET_REGENERATED =
    'integration_instance_secret_regenerated',

  INTEGRATION_INSTANCE_DELETED = 'integration_instance_deleted',

  INTEGRATION_INSTANCE_REDRIVEN = 'integration_instance_redriven',

  // ---------------------------------------------------------------------------
  // Infrastructure events
  // ---------------------------------------------------------------------------

  /**
   * ADMIN-only operations on the infra module:
   *
   * - credential-bearing config mutation
   * - server restart / Docker orchestration
   * - full DB export/import
   * - storage export/import
   */
  INFRA_CONFIG_SAVED = 'infra_config_saved',

  INFRA_RESTART_REQUESTED = 'infra_restart_requested',

  INFRA_DATA_EXPORTED = 'infra_data_exported',

  INFRA_DATA_IMPORTED = 'infra_data_imported',

  INFRA_STORAGE_EXPORTED = 'infra_storage_exported',

  INFRA_STORAGE_IMPORTED = 'infra_storage_imported',
}

export enum AuditSeverity {
  INFO = 'info',

  WARN = 'warn',

  ERROR = 'error',
}

@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({
    type: 'varchar',
    length: 50,
  })
  action!: AuditAction;

  @Column({
    type: 'varchar',
    length: 10,
    default: AuditSeverity.INFO,
  })
  severity!: AuditSeverity;

  @Index()
  @Column({
    type: 'varchar',
    length: 36,
    nullable: true,
  })
  apiKeyId!: string | null;

  @Column({
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  apiKeyName!: string | null;

  @Index()
  @Column({
    type: 'varchar',
    length: 36,
    nullable: true,
  })
  sessionId!: string | null;

  @Column({
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  sessionName!: string | null;

  @Column({
    type: 'varchar',
    length: 45,
    nullable: true,
  })
  ipAddress!: string | null;

  @Column({
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  userAgent!: string | null;

  @Column({
    type: 'varchar',
    length: 10,
    nullable: true,
  })
  method!: string | null;

  @Column({
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  path!: string | null;

  @Column({
    type: 'int',
    nullable: true,
  })
  statusCode!: number | null;

  /**
   * The "main" database connection is always SQLite (boot config), so
   * simple-json is used regardless of the user's data DB choice.
   *
   * Phase K tenant/management context is intentionally stored here rather
   * than adding nullable columns for every identity-specific audit field.
   *
   * Examples:
   *
   * {
   *   surface: 'rest',
   *   attemptedSessionId: '...',
   *   teamLeaderId: '...',
   *   agentId: '...'
   * }
   *
   * or:
   *
   * {
   *   agentId: '...',
   *   teamLeaderId: '...',
   *   previousSessionId: '...',
   *   newSessionId: '...'
   * }
   */
  @Column({
    type: 'simple-json',
    nullable: true,
  })
  metadata!: Record<string, unknown> | null;

  @Column({
    type: 'text',
    nullable: true,
  })
  errorMessage!: string | null;

  @Index()
  @CreateDateColumn()
  createdAt!: Date;
}



