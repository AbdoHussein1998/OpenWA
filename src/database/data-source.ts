import { DataSource, DataSourceOptions } from 'typeorm';
import * as path from 'path';
import { loadCliEnv } from './load-cli-env';
import { sqliteDataMainPathCollision } from '../config/env.validation';
import { loadDataEntities } from './data-entities';

// The standalone CLI must use the same env-file precedence as the running app.
loadCliEnv();

// The CLI does not initialize ConfigModule, so repeat the data/main SQLite path guard.
const sqlitePathCollision = sqliteDataMainPathCollision(process.env);
if (sqlitePathCollision) {
  throw new Error(sqlitePathCollision);
}

const dbType = process.env.DATABASE_TYPE || 'sqlite';
const sourceGlob = (...segments: string[]): string =>
  path.join(__dirname, ...segments).replace(/\\/g, '/');

// Register the very same data-owned entity classes as AppModule. This excludes
// the main-owned auth/audit/teamleader entities and is independent of Windows
// glob handling and the TypeORM version's entity file-discovery implementation.
const dataEntities = loadDataEntities();
const dataMigrations = [sourceGlob('migrations', '*{.ts,.js}')];

const sqliteDataSourceOptions: DataSourceOptions = {
  type: 'better-sqlite3',
  database: process.env.DATABASE_NAME || './data/openwa.sqlite',
  entities: dataEntities,
  migrations: dataMigrations,
  synchronize: false,
  logging: process.env.DATABASE_LOGGING === 'true',
};

// Only an OPTIONS object is additionally exported: the TypeORM CLI requires
// exactly one exported DataSource instance (the default export below).
export function buildPostgresDataSourceOptions(env: NodeJS.ProcessEnv = process.env): DataSourceOptions {
  const schema = env.POSTGRES_SCHEMA || 'public';
  const useCustomSearchPath = schema !== 'public';
  return {
    type: 'postgres',
    schema,
    host: env.DATABASE_HOST || 'localhost',
    port: parseInt(env.DATABASE_PORT || '5432', 10),
    username: env.DATABASE_USERNAME,
    password: env.DATABASE_PASSWORD,
    database: env.DATABASE_NAME || 'openwa',
    entities: dataEntities,
    migrations: dataMigrations,
    synchronize: false,
    logging: env.DATABASE_LOGGING === 'true',
    ssl:
      env.DATABASE_SSL === 'true'
        ? { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' }
        : false,
    extra: {
      max: parseInt(env.DATABASE_POOL_SIZE || '10', 10),
      // Do NOT set statement_timeout on the migration CLI: large migrations
      // must be able to run longer than the normal runtime statement timeout.
      idleTimeoutMillis: parseInt(env.DATABASE_IDLE_TIMEOUT_MS || '30000', 10),
      connectionTimeoutMillis: parseInt(env.DATABASE_CONNECTION_TIMEOUT_MS || '10000', 10),
      ...(useCustomSearchPath ? { options: `-c search_path=${schema},public` } : {}),
    },
  };
}

export const postgresDataSourceOptions: DataSourceOptions = buildPostgresDataSourceOptions();

// Exactly one DataSource instance; CLI migrations remain separate from
// the application's boot-time advisory-lock migration runner.
export default new DataSource(dbType === 'postgres' ? postgresDataSourceOptions : sqliteDataSourceOptions);
