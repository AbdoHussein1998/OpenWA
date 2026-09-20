import * as fs from 'fs';
import * as path from 'path';
import { getMetadataArgsStorage } from 'typeorm';

/**
 * The DATA connection owns only entities under these directories. Keep this list
 * in sync with the project modules; do not scan all of src/ (main is a separate DB).
 *
 * Loading the actual exported classes instead of passing path globs to TypeORM
 * keeps the DataSource's entity targets identical to the classes imported by
 * @InjectRepository() / TypeOrmModule.forFeature(), on Windows and on Linux.
 * This loader is shared by the NestJS runtime and the standalone migration CLI.
 */
const DATA_ENTITY_DIRECTORIES = [
  'modules/session',
  'modules/webhook',
  'modules/message',
  'modules/template',
  'engine',
  'modules/integration',
  'modules/status-store',
  'modules/automation',
] as const;

// These targets have already been observed in the failing application logs.
// Fail at database setup if any of them is not registered, rather than allowing
// individual cleanup jobs to fail later with EntityMetadataNotFoundError.
const REQUIRED_ENTITY_NAMES = [
  'Session',
  'WebhookDeliveryFailure',
  'WebhookOutboxEvent',
  'StatusUpdate',
  'LidMapping',
] as const;

function collectEntityFiles(directory: string, extension: string, files: string[]): void {
  if (!fs.existsSync(directory)) {
    throw new Error(`OpenWA data entity directory does not exist: ${directory}`);
  }

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectEntityFiles(fullPath, extension, files);
    } else if (entry.isFile() && entry.name.endsWith(`.entity${extension}`)) {
      files.push(fullPath);
    }
  }
}

export function loadDataEntities(): Function[] {
  // ts-node / the dev CLI load .ts; compiled NestJS / the production CLI load .js.
  // Never load BOTH variants: that could register different constructors for the
  // same entity when a development checkout also contains compiled files.
  const extension = path.extname(__filename) === '.ts' ? '.ts' : '.js';
  const srcOrDistRoot = path.resolve(__dirname, '..');
  const files: string[] = [];

  for (const directory of DATA_ENTITY_DIRECTORIES) {
    collectEntityFiles(path.join(srcOrDistRoot, directory), extension, files);
  }
  files.sort();

  if (files.length === 0) {
    throw new Error(`No OpenWA data entity files found under ${srcOrDistRoot} (${extension}).`);
  }

  // Require every module first, so that its @Entity decorator has had a chance
  // to register its class with TypeORM's decorator metadata storage.
  const exportsByFile = files.map(file => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(file) as Record<string, unknown>;
  });
  const decoratedTargets = new Set<unknown>(
    getMetadataArgsStorage().tables.map(table => table.target),
  );

  const entities: Function[] = [];
  const seen = new Set<unknown>();
  for (const moduleExports of exportsByFile) {
    for (const candidate of Object.values(moduleExports)) {
      if (typeof candidate === 'function' && decoratedTargets.has(candidate) && !seen.has(candidate)) {
        seen.add(candidate);
        entities.push(candidate);
      }
    }
  }

  const registeredNames = new Set(
    entities.map(entity => entity.name),
  );
  const missing = REQUIRED_ENTITY_NAMES.filter(name => !registeredNames.has(name));
  if (missing.length > 0) {
    throw new Error(
      `OpenWA data connection is missing entity classes: ${missing.join(', ')}. ` +
      `Searched ${files.length} .entity${extension} files under ${srcOrDistRoot}. ` +
      'Check entity filenames/exports, compilation output and the data-owned directories.',
    );
  }

  return entities;
}
