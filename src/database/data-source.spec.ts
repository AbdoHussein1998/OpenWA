import { getMetadataArgsStorage, type EntityTarget } from 'typeorm';
import dataDataSource, { postgresDataSourceOptions, buildPostgresDataSourceOptions } from './data-source';
import { loadDataEntities } from './data-entities';

const entityNames = (entities: readonly EntityTarget<unknown>[]): string[] =>
  entities.map(entity => (entity as { name?: string }).name ?? '');

describe('data CLI DataSource', () => {
  it('registers the same entity constructors as the runtime loader', () => {
    const entities = dataDataSource.options.entities as EntityTarget<unknown>[];
    expect(entities).toEqual(loadDataEntities());
    expect(new Set(entities).size).toBe(entities.length);
  });

  it('registers session, webhook, status and LID entities by class identity', () => {
    const entities = dataDataSource.options.entities as EntityTarget<unknown>[];
    const names = entityNames(entities);
    expect(names).toEqual(expect.arrayContaining([
      'Session', 'WebhookDeliveryFailure', 'WebhookOutboxEvent', 'StatusUpdate', 'LidMapping',
    ]));
    const decorators = new Set(getMetadataArgsStorage().tables.map(table => table.target));
    for (const entity of entities) {
      expect(decorators.has(entity)).toBe(true);
    }
  });

  it('excludes entities belonging to the main connection', () => {
    const names = entityNames(dataDataSource.options.entities as EntityTarget<unknown>[]);
    for (const name of ['ApiKey', 'AuditLog', 'TeamLeader', 'Agent', 'AgentTemplateSendUsage']) {
      expect(names).not.toContain(name);
    }
  });

  it('refuses a DATA SQLite path that resolves to the MAIN SQLite file', () => {
    const prevType = process.env.DATABASE_TYPE;
    const prevMain = process.env.MAIN_DATABASE_NAME;
    const prevData = process.env.DATABASE_NAME;
    process.env.DATABASE_TYPE = 'sqlite';
    process.env.MAIN_DATABASE_NAME = '/tmp/cli-guard-main.sqlite';
    process.env.DATABASE_NAME = '/tmp/../tmp/cli-guard-main.sqlite';
    jest.resetModules();
    try {
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('./data-source');
      }).toThrow(/DATABASE_NAME/);
    } finally {
      if (prevType !== undefined) process.env.DATABASE_TYPE = prevType;
      else delete process.env.DATABASE_TYPE;
      if (prevMain !== undefined) process.env.MAIN_DATABASE_NAME = prevMain;
      else delete process.env.MAIN_DATABASE_NAME;
      if (prevData !== undefined) process.env.DATABASE_NAME = prevData;
      else delete process.env.DATABASE_NAME;
      jest.resetModules();
    }
  });
});

describe('Postgres migration connection pool timeouts', () => {
  const extra = postgresDataSourceOptions.extra as Record<string, number | undefined>;

  it('preserves idle and connection pool timeouts', () => {
    expect(extra.idleTimeoutMillis).toBe(30000);
    expect(extra.connectionTimeoutMillis).toBe(10000);
  });

  it('does not set a statement timeout on migration commands', () => {
    expect(extra.statement_timeout).toBeUndefined();
  });
});

describe('PostgreSQL schema selection (POSTGRES_SCHEMA)', () => {
  type PgOpts = { schema?: string; extra?: Record<string, unknown> };

  it('defaults to public without overriding the search path', () => {
    const options = buildPostgresDataSourceOptions({}) as PgOpts;
    expect(options.schema).toBe('public');
    expect(options.extra?.options).toBeUndefined();
  });

  it('uses the configured schema for TypeORM and raw migration SQL', () => {
    const options = buildPostgresDataSourceOptions({ POSTGRES_SCHEMA: 'openwa' }) as PgOpts;
    expect(options.schema).toBe('openwa');
    expect(options.extra?.options).toBe('-c search_path=openwa,public');
  });

  it('preserves pool timeouts without introducing statement_timeout', () => {
    const options = buildPostgresDataSourceOptions({ POSTGRES_SCHEMA: 'openwa' }) as PgOpts;
    expect(options.extra?.max).toBe(10);
    expect(options.extra?.idleTimeoutMillis).toBe(30000);
    expect(options.extra?.connectionTimeoutMillis).toBe(10000);
    expect(options.extra?.statement_timeout).toBeUndefined();
  });
});
