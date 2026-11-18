import { ConflictException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { Agent } from '../../teamleader/entities/agent.entity';
import { TeamLeader } from '../../teamleader/entities/team-leader.entity';
import { ApiKeyRole } from '../auth.levels.constants';
import { ApiKey } from '../entities/api-key.entity';
import { ApiKeyAdminSafetyService } from './api-key-admin-safety.service';

describe('SQLite database-side last-admin guard contract', () => {
  let dataSource: DataSource;
  let repository: Repository<ApiKey>;
  let safety: ApiKeyAdminSafetyService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3', database: ':memory:',
      entities: [ApiKey, Agent, TeamLeader], synchronize: true,
    });
    await dataSource.initialize();
    repository = dataSource.getRepository(ApiKey);
    safety = new ApiKeyAdminSafetyService(repository);
  });

  afterAll(async () => { if (dataSource?.isInitialized) await dataSource.destroy(); });
  beforeEach(async () => { await repository.clear(); });

  async function admin(suffix: string, extras: Partial<ApiKey> = {}): Promise<ApiKey> {
    return repository.save(repository.create({
      name: suffix,
      keyHash: suffix.padEnd(64, '0'),
      keyPrefix: suffix,
      role: ApiKeyRole.ADMIN,
      isActive: true,
      allowedSessions: null,
      ...extras,
    }));
  }

  it('rejects deleting the only usable unscoped admin', async () => {
    const last = await admin('only');
    await expect(safety.guardedDelete(last.id)).rejects.toThrow(ConflictException);
    expect(await repository.count()).toBe(1);
  });

  it('does not count scoped or expired admins as a usable replacement', async () => {
    const last = await admin('last');
    await admin('scoped', { allowedSessions: ['s1'] });
    await admin('expired', { expiresAt: new Date('2020-01-01T00:00:00Z') });
    await expect(safety.guardedUpdate(last.id, { isActive: false }))
      .rejects.toThrow(ConflictException);
    expect((await repository.findOneByOrFail({ id: last.id })).isActive).toBe(true);
  });

  it('permits one deletion when another usable admin remains', async () => {
    const first = await admin('first');
    const second = await admin('second');
    await safety.guardedDelete(first.id);
    expect(await repository.count()).toBe(1);
    await expect(safety.guardedDelete(second.id)).rejects.toThrow(ConflictException);
  });
});
