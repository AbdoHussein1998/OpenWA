/**
 * Fine-grained authorization capabilities.
 *
 * Capabilities describe WHAT an authenticated principal may do. They
 * intentionally do not describe WHICH sessions/resources the principal may
 * access. Resource/tenant authorization is handled separately by
 * SessionTenantAccessService.
 */
export enum ApiCapability {
  // Session access and lifecycle
  SESSION_READ = 'session_read',
  SESSION_CREATE = 'session_create',
  SESSION_MANAGE = 'session_manage',
  SESSION_CONFIGURE = 'session_configure',
  SESSION_START = 'session_start',
  SESSION_SHUTDOWN = 'session_shutdown',

  // Chat access
  CHAT_READ = 'chat_read',
  CHAT_OPERATE = 'chat_operate',

  // Message access
  MESSAGE_SEND = 'message_send',
  MESSAGE_OPERATE = 'message_operate',
  MESSAGE_BULK = 'message_bulk',

  // Session-scoped management features
  WEBHOOK_MANAGE = 'webhook_manage',
  TEMPLATE_READ = 'template_read',
  TEMPLATE_MANAGE = 'template_manage',
  SEARCH_MESSAGES = 'search_messages',

  /**
   * Team Leader self-service management.
   *
   * TEAM_LEADER credentials intentionally retain this capability for their
   * own /team-leader/* surface. Do not use it to protect global Admin/Operator
   * principal-management routes.
   */
  TEAM_MANAGE = 'team_manage',

  /**
   * Global read-only access to Team Leader / Agent principal inventories.
   *
   * ADMIN, OPERATOR, and VIEWER receive this capability. It must be used only
   * for non-mutating global principal endpoints.
   */
  PRINCIPAL_READ = 'principal_read',

  /**
   * Global Team Leader / Agent principal administration.
   *
   * ADMIN and OPERATOR receive this capability. VIEWER and TEAM_LEADER do not.
   */
  PRINCIPAL_MANAGE = 'principal_manage',

  // Administrative capabilities
  API_KEY_MANAGE = 'api_key_manage',
  AUDIT_READ = 'audit_read',
  STATS_READ = 'stats_read',
  INFRA_MANAGE = 'infra_manage',
  PLUGIN_MANAGE = 'plugin_manage',
}
