import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ApiCapability } from '../auth/capabilities/api-capability';
import { ApiKey } from '../auth/entities/api-key.entity';
import { ApiKeyRole } from '../auth/auth.levels.constants';
import { SessionTenantAccessService } from './session-tenant-access.service';
import { AuthorizationService } from './authorization.service';

describe('AuthorizationService', () => {
  const key = (role: ApiKeyRole, allowedSessions: string[] | null = null) =>
    ({role, allowedSessions} as ApiKey);
  const tenant = {
    assertSessionAccess: jest.fn(),
    assertHistoricalSessionAccess: jest.fn(),
  };
  const service = new AuthorizationService(tenant as unknown as SessionTenantAccessService);

  beforeEach(() => jest.clearAllMocks());

  it('rejects insufficient capability before tenant lookup', async () => {
    await expect(service.assertAuthorized(key(ApiKeyRole.VIEWER), {
      requiredCapability: ApiCapability.PROXY_TEST, sessionId: 's1',
    })).rejects.toThrow(ForbiddenException);
    expect(tenant.assertSessionAccess).not.toHaveBeenCalled();
  });

  it('rejects a session-scoped admin from global infra operations', async () => {
    await expect(service.assertAuthorized(key(ApiKeyRole.ADMIN, ['s1']), {
      requiredCapability: ApiCapability.PROXY_TEST, requireUnscoped: true,
    })).rejects.toThrow('Session-scoped API keys are not permitted on this route');
  });

  it('authorizes the configured live session only via tenant service', async () => {
    await service.assertAuthorized(key(ApiKeyRole.AGENT), {
      requiredCapability: ApiCapability.SESSION_START, sessionId: 's1',
    });
    expect(tenant.assertSessionAccess).toHaveBeenCalledWith(expect.any(Object), 's1');
    expect(tenant.assertHistoricalSessionAccess).not.toHaveBeenCalled();
  });

  it('uses history/tombstone authorization only on explicit historical routes', async () => {
    await service.assertAuthorized(key(ApiKeyRole.VIEWER), {
      requiredCapability: ApiCapability.SESSION_READ,
      sessionId: 'deleted', historicalSessionRead: true,
    });
    expect(tenant.assertHistoricalSessionAccess).toHaveBeenCalledWith(expect.any(Object), 'deleted');
  });

  it('propagates tenant 404 without exposing existence', async () => {
    tenant.assertSessionAccess.mockRejectedValueOnce(new NotFoundException('Session not found'));
    await expect(service.assertAuthorized(key(ApiKeyRole.AGENT), {
      requiredCapability: ApiCapability.SESSION_START, sessionId: 'foreign',
    })).rejects.toThrow(NotFoundException);
  });
});
