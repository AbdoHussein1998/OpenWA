import { Client, ClientConfig } from 'pg';
import { DataSource, DataSourceOptions } from 'typeorm';

// Replicas serialize boot migrations using a session-scoped two-int4 advisory
// lock. These keys are exactly representable in JavaScript and must remain
// stable across app versions and replicas.
export const POSTGRES_BOOT_MIGRATION_LOCK_KEYS: readonly [number, number] = [0x4f5741, 0x626f6f74];

export interface AdvisoryLockClient {
  connect: () => Promise<unknown>;
  query: (text: string, values?: unknown[]) => Promise<unknown>;
  end: () => Promise<unknown>;
}

export interface BootDataSourceDeps {
  createDataSource?: (options: DataSourceOptions) => DataSource;
  createLockClient?: (config: ClientConfig) => AdvisoryLockClient;
}

type PostgresOptions = Extract<DataSourceOptions, { type: 'postgres' }>;

/**
 * Called by TypeOrmModule's dataSourceFactory for the DATA connection only.
 * SQLite keeps Nest's default construction/initialization/migration path.
 * PostgreSQL runs migrations while holding a cross-replica advisory lock.
 */
export async function createBootDataSource(
  options: DataSourceOptions | undefined,
  deps: BootDataSourceDeps = {},
): Promise<DataSource> {
  const createDataSource = deps.createDataSource ?? (opts => new DataSource(opts));
  const createLockClient = deps.createLockClient ?? (config => new Client(config));

  if (options?.type !== 'postgres') {
    // The app supplies an options object; the optional signature comes from
    // @nestjs/typeorm's dataSourceFactory contract.
    return createDataSource(options as DataSourceOptions);
  }

  // Preserve *all* entities, migration paths, schema, and driver settings.
  // Disable the built-in migration runner only on PostgreSQL: migration execution
  // below is serialized across replicas while the lock is held.
  const dataSource = createDataSource({ ...options, migrationsRun: false });
  try {
    await dataSource.initialize();
    const lockClient = createLockClient(lockClientConfig(options));
    try {
      await lockClient.connect();
      await lockClient.query('SELECT pg_advisory_lock($1, $2)', [...POSTGRES_BOOT_MIGRATION_LOCK_KEYS]);
      try {
        await dataSource.runMigrations({ transaction: options.migrationsTransactionMode });
      } finally {
        // Closing the session also releases its lock if explicit unlock fails.
        await lockClient
          .query('SELECT pg_advisory_unlock($1, $2)', [...POSTGRES_BOOT_MIGRATION_LOCK_KEYS])
          .catch(() => undefined);
      }
    } finally {
      await lockClient.end().catch(() => undefined);
    }
  } catch (error) {
    // Do not leave an initialized pool behind if a boot migration fails.
    await dataSource.destroy().catch(() => undefined);
    throw error;
  }
  return dataSource;
}

function lockClientConfig(options: PostgresOptions): ClientConfig {
  const extra = (options.extra ?? {}) as { connectionTimeoutMillis?: number };
  return {
    host: options.host,
    port: options.port,
    user: options.username,
    password: options.password,
    database: options.database,
    ssl: options.ssl as ClientConfig['ssl'],
    connectionTimeoutMillis: extra.connectionTimeoutMillis ?? 10000,
    // Waiting for another replica's migration lock must not be cut short by
    // the server-side statement_timeout configured for normal API queries.
    options: '-c statement_timeout=0',
  };
}
