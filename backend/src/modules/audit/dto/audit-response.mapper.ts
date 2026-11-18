import type { AuditLog } from '../entities/audit-log.entity';
import type { AuditLogDto } from './audit-response.dto';

/** Explicit API serialization allowlist. Adding an entity column does not expose it. */
export function toAuditLogResponse(log: AuditLog): AuditLogDto {
  return {
    id: log.id,
    action: log.action,
    severity: log.severity,
    apiKeyId: log.apiKeyId,
    apiKeyName: log.apiKeyName,
    sessionId: log.sessionId,
    sessionName: log.sessionName,
    ipAddress: log.ipAddress,
    userAgent: log.userAgent,
    method: log.method,
    path: log.path,
    statusCode: log.statusCode,
    metadata: log.metadata,
    errorMessage: log.errorMessage,
    createdAt: log.createdAt.toISOString(),
  };
}
