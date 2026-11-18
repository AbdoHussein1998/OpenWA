import { createRequire } from 'node:module';

/** A minimal, dependency-free contract for checking a native SQLite driver at startup. */
export interface SqliteNativeConnection {
  prepare(sql: string): { get(): unknown };
  close(): void;
}

export type SqliteNativeConstructor = new (filename: string) => SqliteNativeConnection;

function loadInstalledSqliteDriver(): SqliteNativeConstructor {
  // Do not import the package at module-evaluation time: its native binding is loaded by the
  // constructor, and we want a clear startup diagnostic rather than TypeORM's ten DB retries.
  return createRequire(__filename)('better-sqlite3') as SqliteNativeConstructor;
}

/**
 * Fail before Nest constructs either TypeORM connection if better-sqlite3 is missing/broken.
 * Main auth/audit DB ALWAYS uses SQLite, even when DATABASE_TYPE=postgres for the data DB.
 *
 * The optional loader makes failure paths testable without a compiled native module.
 */
export function assertSqliteNativeDriverAvailable(
  loadDriver: () => SqliteNativeConstructor = loadInstalledSqliteDriver,
): void {
  let db: SqliteNativeConnection | undefined;
  try {
    const SqliteDriver = loadDriver();
    db = new SqliteDriver(':memory:');
    const result = db.prepare('SELECT 1 AS healthy').get();
    if (!result || typeof result !== 'object' || (result as { healthy?: unknown }).healthy !== 1) {
      throw new Error('SQLite native driver failed its in-memory SQL check');
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : String(error);
    throw new Error(
      '[SQLITE_NATIVE_DRIVER_UNAVAILABLE] OpenWA cannot load its required better-sqlite3 binding. ' +
        `Node=${process.version}, platform=${process.platform}, arch=${process.arch}. ` +
        'The main auth/audit database always requires SQLite. ' +
        'Use the repository Node 22 release (>=22.22.3), enable npm lifecycle scripts, ' +
        'then run from the project root: ' +
        'npm --prefix backend rebuild better-sqlite3 --foreground-scripts --ignore-scripts=false ' +
        'and npm --prefix backend run deps:check. ' +
        `Original failure: ${reason}`,
      { cause: error },
    );
  } finally {
    // Do not mask the original native-load/SQL error with a secondary close failure.
    try {
      db?.close();
    } catch {
      /* in-memory test connection; application never starts with this handle */
    }
  }
}
