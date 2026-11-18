import { UnauthorizedException } from '@nestjs/common';
import { hashApiKey } from '../api-key-hash';
import { ApiKey } from '../entities/api-key.entity';
import { ApiKeyRole } from '../auth.levels.constants';
import { ApiKeyAuthenticator } from './api-key-authenticator.service';

describe('ApiKeyAuthenticator', () => {
  const repository = { findOne: jest.fn() };
  const tracker = { record: jest.fn() };
  const auth = new ApiKeyAuthenticator(repository as never, tracker as never);
  const rawKey = 'owa_k1_token';
  const key = (): ApiKey => ({
    id: 'k1', name: 'test', role: ApiKeyRole.VIEWER,
    keyHash: hashApiKey(rawKey, process.env.API_KEY_PEPPER),
    keyPrefix: 'owa_k1_token', isActive: true, expiresAt: null,
    allowedIps: null, allowedSessions: ['s1'],
  } as ApiKey);

  beforeEach(() => {
    jest.clearAllMocks();
    repository.findOne.mockResolvedValue(key());
  });

  it('validates only the credential, not session ownership', async () => {
    await expect(auth.validateApiKey(` ${rawKey} `, '127.0.0.1')).resolves.toMatchObject({ id: 'k1' });
    expect(tracker.record).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing or unknown key', async () => {
    await expect(auth.validateApiKey('  ')).rejects.toThrow(UnauthorizedException);
    repository.findOne.mockResolvedValueOnce(null);
    await expect(auth.validateApiKey('unknown')).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a revoked key', async () => {
    repository.findOne.mockResolvedValueOnce({ ...key(), isActive: false });
    await expect(auth.validateApiKey(rawKey)).rejects.toThrow('API key is revoked');
  });

  it('requires a client IP when the key has a whitelist', async () => {
    repository.findOne.mockResolvedValueOnce({ ...key(), allowedIps: ['10.0.0.0/8'] });
    await expect(auth.validateApiKey(rawKey)).rejects.toThrow('Client IP could not be determined');
  });
});
