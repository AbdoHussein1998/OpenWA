import { ApiCapability } from '../../auth/capabilities/api-capability';
import { ApiKey } from '../../auth/entities/api-key.entity';
import { ApiKeyRole } from '../../auth/auth.levels.constants';
import { RoleCapabilityPolicy } from './role-capability.policy';

describe('RoleCapabilityPolicy', () => {
  const key = (role: ApiKeyRole) => ({role} as ApiKey);

  it.each(Object.values(ApiKeyRole))('%s preserves explicit legacy role decision', role => {
    expect(RoleCapabilityPolicy.hasPermission(key(role), role)).toBe(
      role !== ApiKeyRole.AGENT && role !== ApiKeyRole.TEAM_LEADER,
    );
  });

  it.each([
    ApiCapability.PROXY_READ,
    ApiCapability.PROXY_CREATE,
    ApiCapability.PROXY_UPDATE,
    ApiCapability.PROXY_TEST,
    ApiCapability.PROXY_DELETE,
  ])('restricts %s to ADMIN', capability => {
    for (const role of Object.values(ApiKeyRole)) {
      expect(RoleCapabilityPolicy.hasCapability(key(role), capability)).toBe(role === ApiKeyRole.ADMIN);
    }
  });

  it('denies unknown persisted roles and unknown capabilities', () => {
    expect(RoleCapabilityPolicy.hasPermission(key('unknown' as ApiKeyRole), ApiKeyRole.VIEWER)).toBe(false);
    expect(RoleCapabilityPolicy.hasCapability(key(ApiKeyRole.ADMIN), 'unknown' as ApiCapability)).toBe(false);
  });
});
