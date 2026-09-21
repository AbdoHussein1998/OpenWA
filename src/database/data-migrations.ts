import * as fs from 'fs';
import * as path from 'path';

/**
 * Migrations must be loaded as actual constructors. On some Windows paths,
 * TypeORM's internal glob loader finds zero classes even when files exist.
 *
 * Match only direct-child migration implementation files, never *.spec.ts,
 * source maps, test fixtures, or migrations-main (which belongs to MAIN).
 */
const MIGRATION_FILE = /^(\d{13})-([A-Za-z][A-Za-z0-9]*)\.(ts|js)$/;

// These migrations establish the tables involved in the reported startup errors.
// Fail at configuration time if a checkout or production build omits one of them.
const REQUIRED_DATA_MIGRATIONS = [
  'AddMessageStatus1770108659848',
  'AddLidMappings1781200000000',
  'AddWebhookDeliveryFailures1781700000000',
  'CreateStatusUpdates1784822470680',
  'AddWebhookOutboxEvents1786200000000',
] as const;

/**
 * Load migration classes from a single directory without relying on TypeORM's
 * platform-sensitive glob discovery. Exposed for isolated fixture-based tests.
 *
 * The caller chooses the extension so a compiled runtime never imports its
 * neighbouring TypeScript sources, or the inverse. Each matching file must
 * export exactly the timestamped class named by the file and implementing
 * the migration's up()/down() instance methods.
 */
export function discoverMigrationClasses(
  directory: string,
  extension: '.ts' | '.js',
  requiredNames: readonly string[] = [],
): Function[] {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`OpenWA migration directory does not exist: ${directory}`);
  }

  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && MIGRATION_FILE.test(entry.name) && entry.name.endsWith(extension))
    .map(entry => entry.name)
    .sort();

  if (files.length === 0) {
    throw new Error(`No OpenWA migration implementation files found in ${directory} (${extension}).`);
  }

  const migrations: Function[] = [];
  const seenNames = new Set<string>();
  const seenTimestamps = new Set<string>();

  for (const filename of files) {
    const match = MIGRATION_FILE.exec(filename);
    if (!match) {
      // Unreachable because of the filtered file list; retained for type safety.
      throw new Error(`Invalid OpenWA migration filename: ${filename}`);
    }

    const [, timestamp, shortName] = match;
    const expectedName = `${shortName}${timestamp}`;
    const filePath = path.join(directory, filename);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const exportsObject: unknown = require(filePath);
    const exportsList: unknown[] = typeof exportsObject === 'function'
      ? [exportsObject]
      : exportsObject !== null && typeof exportsObject === 'object'
        ? Object.values(exportsObject)
        : [];

    const matches = [...new Set(exportsList)].filter(
      (candidate): candidate is Function =>
        typeof candidate === 'function' && candidate.name === expectedName,
    );

    if (matches.length !== 1) {
      throw new Error(
        `OpenWA migration ${filePath} must export exactly one class named ${expectedName}; found ${matches.length}.`,
      );
    }

    const migration = matches[0];
    const prototype = migration.prototype as { up?: unknown; down?: unknown } | undefined;
    if (!prototype || typeof prototype.up !== 'function' || typeof prototype.down !== 'function') {
      throw new Error(`OpenWA migration ${expectedName} must implement up() and down().`);
    }

    if (seenNames.has(expectedName) || seenTimestamps.has(timestamp)) {
      throw new Error(`Duplicate OpenWA migration name or timestamp in ${directory}: ${expectedName}`);
    }
    seenNames.add(expectedName);
    seenTimestamps.add(timestamp);
    migrations.push(migration);
  }

  const missing = requiredNames.filter(name => !seenNames.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Missing required OpenWA migration classes in ${directory}: ${missing.join(', ')}. ` +
      'Check the source checkout or compiled production image.',
    );
  }

  return migrations;
}

/**
 * The NestJS runtime and the standalone TypeORM CLI call this same loader.
 * In ts-node / ts-jest the source module filename is .ts; in the compiled
 * NestJS image it is .js. Keep the source/compiled variants separate.
 */
export function loadDataMigrations(): Function[] {
  const extension: '.ts' | '.js' = path.extname(__filename) === '.ts' ? '.ts' : '.js';
  return discoverMigrationClasses(
    path.resolve(__dirname, 'migrations'),
    extension,
    REQUIRED_DATA_MIGRATIONS,
  );
}
