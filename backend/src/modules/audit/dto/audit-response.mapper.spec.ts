import type { AuditLog } from '../entities/audit-log.entity';
import { AuditAction, AuditSeverity } from '../entities/audit-log.entity';
import { toAuditLogResponse } from './audit-response.mapper';

it('explicitly serializes only public audit fields, never unknown entity properties', () => {
  const entity = {
    id: 'a1',
    action: AuditAction.API_KEY_UPDATED,
    severity: AuditSeverity.INFO,
    apiKeyId: 'k1',
    apiKeyName: 'admin',
    sessionId: null,
    sessionName: null,
    ipAddress: '127.0.0.1',
    userAgent: null,
    method: 'PUT',
    path: '/auth/api-keys/k1',
    statusCode: 200,
    metadata: { action: 'reissue' },
    errorMessage: null,
    createdAt: new Date('2026-01-01T12:00:00.000Z'),
    futureSensitiveColumn: 'must-not-leak',
  } as unknown as AuditLog;

  const response = toAuditLogResponse(entity);
  expect(response).not.toHaveProperty('futureSensitiveColumn');
  expect(response.createdAt).toBe('2026-01-01T12:00:00.000Z');
  expect(response.metadata).toEqual({ action: 'reissue' });
});
