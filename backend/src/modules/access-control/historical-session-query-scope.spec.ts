import type { ApiKey } from '../auth/entities/api-key.entity';
import { ApiKeyRole } from '../auth/auth.levels.constants';
import { SessionTenantAccessService } from './session-tenant-access.service';
import { SessionScopes } from './session-scope';

function leader(): ApiKey {
  return {
    role: ApiKeyRole.TEAM_LEADER,
    teamLeaderId: 'leader-a',
    allowedSessions: null,
  } as ApiKey;
}

describe('historical session query scope materialization', () => {
  it('adds deleted owned sessions but excludes tombstones for any restored live ID', async () => {
    const sessionRepo = {
      find: jest.fn()
        .mockResolvedValueOnce([{ id: 'owned-live' }])
        .mockResolvedValueOnce([{ id: 'restored-to-other-leader' }]),
    };
    const getRawMany = jest.fn().mockResolvedValue([
      { sessionId: 'deleted-owned' },
      { sessionId: 'restored-to-other-leader' },
    ]);
    const ds = {
      createQueryBuilder: jest.fn(() => ({
        select() { return this; },
        from() { return this; },
        where() { return this; },
        getRawMany,
      })),
    };
    const access = new SessionTenantAccessService({} as never, sessionRepo as never, ds as never);
    expect(await access.getHistoricalSessionQueryScope(leader()))
      .toEqual(SessionScopes.ids(['owned-live', 'deleted-owned']));
  });

  it('enforces both tenant ownership and explicit allowlist for historical reads', async () => {
    const sessionRepo = {
      findOne: jest.fn(({ where }: { where: { id: string } }) => {
        if (where.id === 'owned') return Promise.resolve({ id: 'owned', ownerTeamLeaderId: 'leader-a' });
        if (where.id === 'foreign-live') return Promise.resolve({ id: 'foreign-live', ownerTeamLeaderId: 'leader-b' });
        return Promise.resolve(null);
      }),
    };
    const ds = {
      createQueryBuilder: jest.fn(() => ({
        select() { return this; },
        from() { return this; },
        where() { return this; },
        getRawOne: jest.fn().mockResolvedValue({ ownerTeamLeaderId: 'leader-a' }),
      })),
    };
    const access = new SessionTenantAccessService({} as never, sessionRepo as never, ds as never);
    const scoped = { ...leader(), allowedSessions: ['owned', 'foreign-live', 'deleted-owned'] } as ApiKey;
    expect(await access.getHistoricalSessionQueryScope(scoped))
      .toEqual(SessionScopes.ids(['owned', 'deleted-owned']));
  });
});
