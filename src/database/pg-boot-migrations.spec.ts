import { DataSource, DataSourceOptions } from 'typeorm';
import {
  AdvisoryLockClient,
  BootDataSourceDeps,
  POSTGRES_BOOT_MIGRATION_LOCK_KEYS,
  createBootDataSource,
} from './pg-boot-migrations';

// Protocol wiring of the boot-migration advisory lock: the lock must be taken BEFORE runMigrations
// starts and dropped after it finishes (on success AND on migration failure), and the DataSource
// handed back to Nest must never carry migrationsRun (it would re-run the chain unsynchronized).
// The pg client and the DataSource constructor are injected as fakes; the PG-gated companion spec
// (pg-boot-migrations.pg.spec.ts) proves the same protocol against a real Postgres.

const PG_OPTIONS: DataSourceOptions = {
  type: 'postgres',
  host: 'db',
  port: 5432,
  username: 'openwa',
  password: 'secret',
  database: 'openwa',
  // The app config still carries this; the factory takes over execution and must neutralize it.
  migrationsRun: true,
  migrationsTransactionMode: 'all',
  extra: { statement_timeout: 30000, connectionTimeoutMillis: 10000 },
};

describe('createBootDataSource (postgres boot migrations)', () => {
  // Fakes keep their inferred jest.Mock types (casts live only at the injection boundary) and
  // record every step in `calls`, so ordering is asserted on one linear trace.
  function makeFakes(runMigrations: () => Promise<unknown> = jest.fn()) {
    const calls: string[] = [];
    const dataSource = {
      initialize: jest.fn(() => {
        calls.push('initialize');
        return Promise.resolve();
      }),
      runMigrations: jest.fn(() => {
        calls.push('runMigrations');
        return runMigrations();
      }),
      destroy: jest.fn(() => {
        calls.push('destroy');
        return Promise.resolve();
      }),
    };
    const lockClient: AdvisoryLockClient = {
      connect: jest.fn(() => {
        calls.push('connect');
        return Promise.resolve();
      }),
      query: jest.fn((text: string) => {
        calls.push(text);
        return Promise.resolve();
      }),
      end: jest.fn(() => {
        calls.push('end');
        return Promise.resolve();
      }),
    };
    const deps: BootDataSourceDeps = {
      createDataSource: jest.fn(() => dataSource as unknown as DataSource),
      createLockClient: jest.fn(() => lockClient),
    };
    return { calls, dataSource, lockClient, deps };
  }

  it('initializes, then migrates strictly between advisory lock acquire and release', async () => {
    const { calls, dataSource, lockClient, deps } = makeFakes();

    const returned = await createBootDataSource(PG_OPTIONS, deps);

    expect(returned).toBe(dataSource);
    expect(calls).toEqual([
      'initialize',
      'connect',
      'SELECT pg_advisory_lock($1, $2)',
      'runMigrations',
      'SELECT pg_advisory_unlock($1, $2)',
      'end',
    ]);
    // Same key for acquire and release, in the (key1, key2) form.
    expect(lockClient.query).toHaveBeenNthCalledWith(1, 'SELECT pg_advisory_lock($1, $2)', [
      ...POSTGRES_BOOT_MIGRATION_LOCK_KEYS,
    ]);
    expect(lockClient.query).toHaveBeenNthCalledWith(2, 'SELECT pg_advisory_unlock($1, $2)', [
      ...POSTGRES_BOOT_MIGRATION_LOCK_KEYS,
    ]);
    // Migration execution preserves the built-in migrationsRun transaction mode, and the boot
    // error path (destroy) never fires on success.
    expect(dataSource.runMigrations).toHaveBeenCalledWith({ transaction: 'all' });
    expect(dataSource.destroy).not.toHaveBeenCalled();
  });

  it('constructs the DataSource with migrationsRun disabled and never mutates the config', async () => {
    const { deps } = makeFakes();

    await createBootDataSource(PG_OPTIONS, deps);

    expect(deps.createDataSource).toHaveBeenCalledWith({ ...PG_OPTIONS, migrationsRun: false });
    // The resolved config object itself is untouched — the flag stays as the built-in fallback.
    expect(PG_OPTIONS.migrationsRun).toBe(true);
  });

  it('builds the lock client without a statement timeout (pg_advisory_lock must survive the wait)', async () => {
    const { deps } = makeFakes();

    await createBootDataSource(PG_OPTIONS, deps);

    // statement_timeout applies to any command — including the lock wait — and a config value of 0
    // is dropped by pg as falsy, so the only correct disable is the startup `options` string.
    expect(deps.createLockClient).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'db',
        port: 5432,
        user: 'openwa',
        password: 'secret',
        database: 'openwa',
        connectionTimeoutMillis: 10000,
        options: '-c statement_timeout=0',
      }),
    );
  });

  it('releases the lock and surfaces the error when a migration fails', async () => {
    const failure = new Error('duplicate table: messages');
    const { calls, lockClient, deps } = makeFakes(jest.fn(() => Promise.reject(failure)));

    await expect(createBootDataSource(PG_OPTIONS, deps)).rejects.toBe(failure);

    // Failure semantics: the lock still gets released, the client returned, and the DataSource is
    // torn down exactly like DataSource.initialize()'s own migrate-step error path — a retrying
    // boot must not stack initialized pools of failed attempts.
    expect(calls).toEqual([
      'initialize',
      'connect',
      'SELECT pg_advisory_lock($1, $2)',
      'runMigrations',
      'SELECT pg_advisory_unlock($1, $2)',
      'end',
      'destroy',
    ]);
    expect(lockClient.end).toHaveBeenCalledTimes(1);
  });

  it('tears the DataSource down when the lock client cannot connect', async () => {
    const { dataSource, lockClient, deps } = makeFakes();
    (lockClient.connect as jest.Mock).mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(createBootDataSource(PG_OPTIONS, deps)).rejects.toThrow('ECONNREFUSED');

    expect(lockClient.query).not.toHaveBeenCalled();
    expect(lockClient.end).toHaveBeenCalledTimes(1);
    expect(dataSource.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps the default @nestjs/typeorm path for non-postgres options (no lock, no initialize)', async () => {
    const sqliteOptions: DataSourceOptions = { type: 'better-sqlite3', database: './data/openwa.sqlite' };
    const dataSource = {
      initialize: jest.fn(() => Promise.resolve()),
      runMigrations: jest.fn(() => Promise.resolve()),
      destroy: jest.fn(() => Promise.resolve()),
    };
    const deps: BootDataSourceDeps = {
      createDataSource: jest.fn(() => dataSource as unknown as DataSource),
      createLockClient: jest.fn(),
    };

    const returned = await createBootDataSource(sqliteOptions, deps);

    // Untouched options, uninitialized DataSource (the wrapper's initialize keeps running the
    // connection's own migrationsRun), and no advisory-lock client is ever built.
    expect(returned).toBe(dataSource);
    expect(deps.createDataSource).toHaveBeenCalledWith(sqliteOptions);
    expect(deps.createLockClient).not.toHaveBeenCalled();
    expect(dataSource.initialize).not.toHaveBeenCalled();
  });
});
