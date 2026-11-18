import { BadRequestException } from '@nestjs/common';
import { ApiKeyRoleRules } from './api-key-role-rules';
import { ApiKeyRole } from '../auth.levels.constants';

describe('ApiKeyRoleRules', () => {
  it.each([ApiKeyRole.ADMIN, ApiKeyRole.OPERATOR, ApiKeyRole.VIEWER])(
    'allows generic creation of %s keys', role => {
      expect(() => ApiKeyRoleRules.assertGenericApiKeyRole(role)).not.toThrow();
    },
  );

  it.each([ApiKeyRole.AGENT, ApiKeyRole.TEAM_LEADER])(
    'rejects generic creation of %s keys', role => {
      expect(() => ApiKeyRoleRules.assertGenericApiKeyRole(role)).toThrow(BadRequestException);
    },
  );

  it('fails closed for unsupported role values', () => {
    expect(() => ApiKeyRoleRules.assertGenericApiKeyRole('SUPERADMIN' as ApiKeyRole)).toThrow(
      'Unsupported API key role',
    );
    expect(() => ApiKeyRoleRules.assertManagementPrincipalBinding({
      role: 'SUPERADMIN' as ApiKeyRole,
      agentId: 'agent-1',
    })).toThrow(BadRequestException);
  });

  it('requires exact principal bindings for Team Leaders', () => {
    expect(() => ApiKeyRoleRules.assertManagementPrincipalBinding({
      role: ApiKeyRole.TEAM_LEADER, teamLeaderId: 'leader-1', agentId: null,
    })).not.toThrow();
    expect(() => ApiKeyRoleRules.assertManagementPrincipalBinding({
      role: ApiKeyRole.TEAM_LEADER, teamLeaderId: 'leader-1', agentId: 'agent-1',
    })).toThrow(BadRequestException);
  });

  it('requires exact principal bindings for Agents', () => {
    expect(() => ApiKeyRoleRules.assertManagementPrincipalBinding({
      role: ApiKeyRole.AGENT, agentId: 'agent-1', teamLeaderId: null,
    })).not.toThrow();
    expect(() => ApiKeyRoleRules.assertManagementPrincipalBinding({
      role: ApiKeyRole.AGENT, teamLeaderId: 'leader-1', agentId: 'agent-1',
    })).toThrow(BadRequestException);
  });
});
