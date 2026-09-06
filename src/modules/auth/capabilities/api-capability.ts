/**
 * Fine-grained authorization capabilities.
 *
 * Capabilities describe WHAT an authenticated principal may do.
 * They intentionally do not describe WHICH sessions/resources the
 * principal may access.
 *
 * Resource/tenant authorization is handled separately by
 * SessionTenantAccessService.
 */
export enum ApiCapability {
  // Session access
  SESSION_READ = 'session_read',
  SESSION_CREATE = 'session_create',
  SESSION_MANAGE = 'session_manage',
  SESSION_CONFIGURE = 'session_configure',

  // Chat access
  CHAT_READ = 'chat_read',
  CHAT_OPERATE = 'chat_operate',

  // Message access
  MESSAGE_SEND = 'message_send',
  MESSAGE_OPERATE = 'message_operate',
  MESSAGE_BULK = 'message_bulk',

  // Session-scoped management features
  WEBHOOK_MANAGE = 'webhook_manage',
  TEMPLATE_MANAGE = 'template_manage',
  SEARCH_MESSAGES = 'search_messages',

  // Team Leader / Agent administration
  TEAM_MANAGE = 'team_manage',

  // Administrative capabilities
  API_KEY_MANAGE = 'api_key_manage',
  AUDIT_READ = 'audit_read',
  INFRA_MANAGE = 'infra_manage',
  PLUGIN_MANAGE = 'plugin_manage',
}