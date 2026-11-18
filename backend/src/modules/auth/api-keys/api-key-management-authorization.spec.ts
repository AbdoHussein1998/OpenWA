import { ForbiddenException } from '@nestjs/common';
import { ApiKeyRole } from '../auth.levels.constants';
import type { ApiKey } from '../entities/api-key.entity';
import { assertApiKeyManager } from './api-key-management-authorization';

function actor(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'manager-id',
    role: ApiKeyRole.ADMIN,
    isActive: true,
    expiresAt: null,
    allowedSessions: null,
    ...overrides,
  } as ApiKey;
}

describe('application-level API-key management authorization', () => {
  it('fails closed on a missing principal (direct service calls)', () => {
    expect(() => assertApiKeyManager(undefined)).toThrow(ForbiddenException);
  });

  it.each([ApiKeyRole.VIEWER, ApiKeyRole.AGENT, ApiKeyRole.TEAM_LEADER])(
    'denies a caller without API_KEY_MANAGE (%s)', role => {
      expect(() => assertApiKeyManager(actor({ role }))).toThrow(ForbiddenException);
    },
  );

  it('denies even an ADMIN limited to explicit session IDs', () => {
    expect(() => assertApiKeyManager(actor({ allowedSessions: ['session-1'] })))
      .toThrow(ForbiddenException);
  });

  it('denies revoked and expired management credentials', () => {
    expect(() => assertApiKeyManager(actor({ isActive: false }))).toThrow(ForbiddenException);
    expect(() => assertApiKeyManager(actor({ expiresAt: new Date('2020-01-01') })))
      .toThrow(ForbiddenException);
  });

  it.each([ApiKeyRole.ADMIN, ApiKeyRole.OPERATOR])(
    'allows active unscoped management role %s', role => {
      expect(() => assertApiKeyManager(actor({ role }))).not.toThrow();
    },
  );
});
