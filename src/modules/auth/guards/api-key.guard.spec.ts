


import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import {
  getRequestActor,
  runWithRequestId,
} from '../../../common/services/request-context';
import { SessionTenantAccessService } from '../../access-control/session-tenant-access.service';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/entities/audit-log.entity';
import { AuthService } from '../auth.service';
import { ApiCapability } from '../capabilities/api-capability';
import { REQUIRED_CAPABILITY_KEY } from '../decorators/capability.decorator';
import {
  PUBLIC_KEY,
  REQUIRED_ROLE_KEY,
  SESSION_SCOPED_KEY,
  UNSCOPED_KEY,
} from '../decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../entities/api-key.entity';
import { ApiKeyGuard } from './api-key.guard';

function createMockApiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'uuid-1',
    name: 'Test Key',
    keyHash: 'hash',
    keyPrefix: 'owa_k1_xxxx',
    role: ApiKeyRole.OPERATOR,
    teamLeaderId: null,
    teamLeader: null,
    agentId: null,
    agent: null,
    allowedIps: null,
    allowedSessions: null,
    isActive: true,
    expiresAt: null,
    lastUsedAt: null,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockContext(
  headers: Record<string, string> = {},
  params: Record<string, string> = {},
  socketIp = '127.0.0.1',
): ExecutionContext {
  const request = {
    headers,
    params,
    ip: socketIp,
    socket: { remoteAddress: socketIp },
    method: 'GET',
    path: '/test',
  };

  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  let authService: jest.Mocked<Partial<AuthService>>;
  let sessionTenantAccessService: jest.Mocked<Partial<SessionTenantAccessService>>;
  let reflector: jest.Mocked<Reflector>;
  let configService: jest.Mocked<Partial<ConfigService>>;
  let auditService: jest.Mocked<Partial<AuditService>>;
  let metadata: Map<string, unknown>;

  function buildGuard(trustedProxies: string[] = []): ApiKeyGuard {
    configService = {
      get: jest.fn().mockReturnValue(trustedProxies),
    };

    return new ApiKeyGuard(
      authService as AuthService,
      sessionTenantAccessService as SessionTenantAccessService,
      reflector,
      configService as ConfigService,
      auditService as AuditService,
    );
  }

  beforeEach(() => {
    metadata = new Map<string, unknown>();

    authService = {
      validateApiKey: jest.fn(),
      hasPermission: jest.fn().mockReturnValue(true),
      hasCapability: jest.fn().mockReturnValue(true),
    };

    sessionTenantAccessService = {
      assertSessionAccess: jest.fn().mockResolvedValue(undefined),
    };

    reflector = {
      getAllAndOverride: jest.fn((key: string) => metadata.get(key)),
    } as unknown as jest.Mocked<Reflector>;

    auditService = {
      logWarn: jest.fn().mockResolvedValue(null),
    };

    guard = buildGuard();
  });

  it('allows @Public() routes without API-key authentication', async () => {
    metadata.set(PUBLIC_KEY, true);

    const result = await guard.canActivate(createMockContext());

    expect(result).toBe(true);
    expect(authService.validateApiKey).not.toHaveBeenCalled();
    expect(sessionTenantAccessService.assertSessionAccess).not.toHaveBeenCalled();
  });

  it('rejects a request with no API key and records an authentication audit event', async () => {
    const context = createMockContext({}, {}, '203.0.113.9');

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    await new Promise(resolve => setImmediate(resolve));

    expect(auditService.logWarn).toHaveBeenCalledWith(
      AuditAction.API_KEY_AUTH_FAILED,
      expect.objectContaining({
        ipAddress: '203.0.113.9',
        errorMessage: 'API key is required',
      }),
    );
  });

  it('accepts X-API-Key and authenticates credential concerns only', async () => {
    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    const result = await guard.canActivate(
      createMockContext({ 'x-api-key': 'my-key' }),
    );

    expect(result).toBe(true);
    expect(authService.validateApiKey).toHaveBeenCalledWith('my-key', '127.0.0.1');
    expect(sessionTenantAccessService.assertSessionAccess).not.toHaveBeenCalled();
  });

  it('accepts Authorization: Bearer credentials', async () => {
    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    await expect(
      guard.canActivate(
        createMockContext({ authorization: 'Bearer my-bearer-key' }),
      ),
    ).resolves.toBe(true);

    expect(authService.validateApiKey).toHaveBeenCalledWith(
      'my-bearer-key',
      '127.0.0.1',
    );
  });

  it('propagates API-key validation failures and audits them', async () => {
    (authService.validateApiKey as jest.Mock).mockRejectedValue(
      new UnauthorizedException('Invalid API key'),
    );

    const context = createMockContext(
      { 'x-api-key': 'bad-key' },
      {},
      '203.0.113.9',
    );

    await expect(guard.canActivate(context)).rejects.toThrow('Invalid API key');
    await new Promise(resolve => setImmediate(resolve));

    expect(auditService.logWarn).toHaveBeenCalledWith(
      AuditAction.API_KEY_AUTH_FAILED,
      expect.objectContaining({
        ipAddress: '203.0.113.9',
        errorMessage: 'Invalid API key',
      }),
    );
  });

  it('does not write an auth-failure audit event after successful authorization', async () => {
    (authService.validateApiKey as jest.Mock).mockResolvedValue(createMockApiKey());

    await guard.canActivate(createMockContext({ 'x-api-key': 'good-key' }));
    await new Promise(resolve => setImmediate(resolve));

    expect(auditService.logWarn).not.toHaveBeenCalled();
  });

  it('rejects an authenticated key when legacy role permission is insufficient', async () => {
    metadata.set(REQUIRED_ROLE_KEY, ApiKeyRole.ADMIN);

    const apiKey = createMockApiKey({ role: ApiKeyRole.VIEWER });
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);
    (authService.hasPermission as jest.Mock).mockReturnValue(false);

    await expect(
      guard.canActivate(createMockContext({ 'x-api-key': 'viewer-key' })),
    ).rejects.toThrow(ForbiddenException);

    expect(authService.hasPermission).toHaveBeenCalledWith(apiKey, ApiKeyRole.ADMIN);
  });

  it('rejects an authenticated key when capability permission is insufficient', async () => {
    metadata.set(REQUIRED_CAPABILITY_KEY, ApiCapability.WEBHOOK_MANAGE);

    const apiKey = createMockApiKey({
      role: ApiKeyRole.TEAM_LEADER,
      teamLeaderId: 'tl-1',
    });
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);
    (authService.hasCapability as jest.Mock).mockReturnValue(false);

    await expect(
      guard.canActivate(createMockContext({ 'x-api-key': 'tl-key' })),
    ).rejects.toThrow(
      'Insufficient permissions. Required capability: webhook_manage',
    );

    expect(authService.hasCapability).toHaveBeenCalledWith(
      apiKey,
      ApiCapability.WEBHOOK_MANAGE,
    );
  });

  it('admits an authenticated key when its required capability is granted', async () => {
    metadata.set(REQUIRED_CAPABILITY_KEY, ApiCapability.SESSION_START);

    const apiKey = createMockApiKey({
      role: ApiKeyRole.AGENT,
      agentId: 'agent-1',
    });
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);
    (authService.hasCapability as jest.Mock).mockReturnValue(true);

    await expect(
      guard.canActivate(createMockContext({ 'x-api-key': 'agent-key' })),
    ).resolves.toBe(true);

    expect(authService.hasCapability).toHaveBeenCalledWith(
      apiKey,
      ApiCapability.SESSION_START,
    );
  });

  describe('post-authentication denial attribution', () => {
    const actorAfterDenial = async (
      apiKey: ApiKey,
      configure: () => void,
    ): Promise<ReturnType<typeof getRequestActor>> => {
      configure();
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

      let actor: ReturnType<typeof getRequestActor>;

      await runWithRequestId('req-1', async () => {
        await expect(
          guard.canActivate(
            createMockContext({ 'x-api-key': 'k' }, {}, '203.0.113.44'),
          ),
        ).rejects.toThrow(ForbiddenException);
        actor = getRequestActor();
      });

      return actor;
    };

    it('keeps the authenticated key stamped on a role denial', async () => {
      const apiKey = createMockApiKey({
        id: 'key-uuid-1',
        name: 'Reporting key',
        role: ApiKeyRole.VIEWER,
      });
      (authService.hasPermission as jest.Mock).mockReturnValue(false);

      const actor = await actorAfterDenial(apiKey, () => {
        metadata.set(REQUIRED_ROLE_KEY, ApiKeyRole.ADMIN);
      });

      expect(actor).toMatchObject({
        apiKeyId: 'key-uuid-1',
        apiKeyName: 'Reporting key',
        ipAddress: '203.0.113.44',
      });
    });

    it('keeps the authenticated key stamped on a capability denial', async () => {
      const apiKey = createMockApiKey({
        id: 'key-uuid-2',
        name: 'Team Leader',
        role: ApiKeyRole.TEAM_LEADER,
        teamLeaderId: 'tl-1',
      });
      (authService.hasCapability as jest.Mock).mockReturnValue(false);

      const actor = await actorAfterDenial(apiKey, () => {
        metadata.set(REQUIRED_CAPABILITY_KEY, ApiCapability.WEBHOOK_MANAGE);
      });

      expect(actor).toMatchObject({
        apiKeyId: 'key-uuid-2',
        apiKeyName: 'Team Leader',
        ipAddress: '203.0.113.44',
      });
    });

    it('does not invent an actor when authentication itself fails', async () => {
      (authService.validateApiKey as jest.Mock).mockRejectedValue(
        new UnauthorizedException('bad key'),
      );

      let actor: ReturnType<typeof getRequestActor>;

      await runWithRequestId('req-2', async () => {
        await expect(
          guard.canActivate(
            createMockContext({ 'x-api-key': 'nope' }, {}, '203.0.113.44'),
          ),
        ).rejects.toThrow(UnauthorizedException);
        actor = getRequestActor();
      });

      expect(actor?.apiKeyId).toBeUndefined();
      expect(actor?.apiKeyName).toBeUndefined();
      expect(actor?.ipAddress).toBe('203.0.113.44');
    });
  });

  it('rejects a session-scoped key on @RequireUnscopedKey routes', async () => {
    metadata.set(REQUIRED_ROLE_KEY, ApiKeyRole.ADMIN);
    metadata.set(UNSCOPED_KEY, true);

    const apiKey = createMockApiKey({
      role: ApiKeyRole.ADMIN,
      allowedSessions: ['sess-A'],
    });
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    await expect(
      guard.canActivate(createMockContext({ 'x-api-key': 'scoped-admin-key' })),
    ).rejects.toThrow(
      'Session-scoped API keys are not permitted on this route',
    );
  });

  it('admits an unrestricted key on @RequireUnscopedKey routes', async () => {
    metadata.set(REQUIRED_ROLE_KEY, ApiKeyRole.ADMIN);
    metadata.set(UNSCOPED_KEY, true);

    const apiKey = createMockApiKey({
      role: ApiKeyRole.ADMIN,
      allowedSessions: null,
    });
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    await expect(
      guard.canActivate(createMockContext({ 'x-api-key': 'admin-key' })),
    ).resolves.toBe(true);
  });

  it('allows a key carrying allowedSessions on routes without @RequireUnscopedKey', async () => {
    const apiKey = createMockApiKey({ allowedSessions: ['sess-A'] });
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    await expect(
      guard.canActivate(createMockContext({ 'x-api-key': 'scoped-key' })),
    ).resolves.toBe(true);
  });

  it('routes explicit :sessionId authorization through SessionTenantAccessService', async () => {
    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    await guard.canActivate(
      createMockContext(
        { 'x-api-key': 'key' },
        { sessionId: 'sess-123' },
      ),
    );

    expect(authService.validateApiKey).toHaveBeenCalledWith('key', '127.0.0.1');
    expect(sessionTenantAccessService.assertSessionAccess).toHaveBeenCalledWith(
      apiKey,
      'sess-123',
    );
  });

  it('returns tenant 404 semantics and audits a denied explicit session', async () => {
    const apiKey = createMockApiKey({
      role: ApiKeyRole.AGENT,
      agentId: 'agent-1',
    });
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);
    (sessionTenantAccessService.assertSessionAccess as jest.Mock).mockRejectedValue(
      new NotFoundException('Session not found'),
    );

    const context = createMockContext(
      { 'x-api-key': 'agent-key' },
      { sessionId: 'foreign-session' },
      '203.0.113.10',
    );

    await expect(guard.canActivate(context)).rejects.toThrow(NotFoundException);
    await new Promise(resolve => setImmediate(resolve));

    expect(auditService.logWarn).toHaveBeenCalledWith(
      AuditAction.TENANT_ACCESS_DENIED,
      expect.objectContaining({
        ipAddress: '203.0.113.10',
        statusCode: 404,
        errorMessage: 'Tenant session access denied',
        metadata: expect.objectContaining({
          surface: 'rest',
          attemptedSessionId: 'foreign-session',
          agentId: 'agent-1',
        }),
      }),
    );
  });

  it('does not treat a generic :id as a session without @SessionScoped()', async () => {
    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    await guard.canActivate(
      createMockContext(
        { 'x-api-key': 'key' },
        { id: 'plugin-x' },
      ),
    );

    expect(sessionTenantAccessService.assertSessionAccess).not.toHaveBeenCalled();
  });

  it('treats generic :id as the session id on @SessionScoped() routes', async () => {
    metadata.set(SESSION_SCOPED_KEY, true);

    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    await guard.canActivate(
      createMockContext(
        { 'x-api-key': 'key' },
        { id: 'sess-B' },
      ),
    );

    expect(sessionTenantAccessService.assertSessionAccess).toHaveBeenCalledWith(
      apiKey,
      'sess-B',
    );
  });

  it('ignores X-Forwarded-For by default to prevent IP spoofing', async () => {
    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    await guard.canActivate(
      createMockContext({
        'x-api-key': 'key',
        'x-forwarded-for': '203.0.113.50, 70.41.3.18',
      }),
    );

    expect(authService.validateApiKey).toHaveBeenCalledWith('key', '127.0.0.1');
  });

  it('uses the rightmost untrusted hop when the direct peer is trusted', async () => {
    guard = buildGuard(['10.0.0.0/8']);

    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    await guard.canActivate(
      createMockContext(
        {
          'x-api-key': 'key',
          'x-forwarded-for': '203.0.113.50, 10.0.0.5',
        },
        {},
        '10.0.0.1',
      ),
    );

    expect(authService.validateApiKey).toHaveBeenCalledWith('key', '203.0.113.50');
  });

  it('ignores X-Forwarded-For when the direct peer is not trusted', async () => {
    guard = buildGuard(['10.0.0.0/8']);

    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    await guard.canActivate(
      createMockContext(
        {
          'x-api-key': 'key',
          'x-forwarded-for': '10.0.0.5',
        },
        {},
        '203.0.113.99',
      ),
    );

    expect(authService.validateApiKey).toHaveBeenCalledWith('key', '203.0.113.99');
  });

  it('normalizes IPv4-mapped IPv6 proxy addresses', async () => {
    guard = buildGuard(['10.0.0.0/8']);

    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    await guard.canActivate(
      createMockContext(
        {
          'x-api-key': 'key',
          'x-forwarded-for': '203.0.113.50',
        },
        {},
        '::ffff:10.0.0.1',
      ),
    );

    expect(authService.validateApiKey).toHaveBeenCalledWith('key', '203.0.113.50');
  });
});


