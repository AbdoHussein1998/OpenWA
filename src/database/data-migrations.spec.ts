import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverMigrationClasses, loadDataMigrations } from './data-migrations';

function writeMigration(directory: string, timestamp: string, name: string): void {
  const exportName = `${name}${timestamp}`;
  fs.writeFileSync(
    path.join(directory, `${timestamp}-${name}.js`),
    `class ${exportName} { up() {} down() {} }\nmodule.exports = { ${exportName} };\n`,
    'utf8',
  );
}

describe('data migration registration', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-migrations-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('registers actual constructors in timestamp order and ignores Jest tests and nested fixtures', () => {
    writeMigration(directory, '1781200000000', 'AddLidMappings');
    writeMigration(directory, '1770108659848', 'AddMessageStatus');
    fs.writeFileSync(path.join(directory, '1789564500000-CorrectOperationalForeignKeyLifecycles.spec.js'),
      'throw new Error("A test file was incorrectly loaded");\n');
    fs.mkdirSync(path.join(directory, '__tests__'));
    fs.writeFileSync(path.join(directory, '__tests__', '1786300000000-Something.js'),
      'throw new Error("Nested test was incorrectly loaded");\n');

    const migrations = discoverMigrationClasses(directory, '.js', ['AddMessageStatus1770108659848']);
    expect(migrations.map(migration => migration.name)).toEqual([
      'AddMessageStatus1770108659848',
      'AddLidMappings1781200000000',
    ]);
    expect(migrations.every(migration => typeof migration === 'function')).toBe(true);
    expect(new Set(migrations).size).toBe(migrations.length);
  });

  it('rejects an empty migration directory instead of silently initializing an empty schema', () => {
    expect(() => discoverMigrationClasses(directory, '.js')).toThrow(/No OpenWA migration/);
  });

  it('rejects a missing directory with a specific error', () => {
    expect(() => discoverMigrationClasses(path.join(directory, 'missing'), '.js')).toThrow(/directory does not exist/);
  });

  it('rejects a migration that does not export the timestamped class expected from its filename', () => {
    fs.writeFileSync(path.join(directory, '1770108659848-AddMessageStatus.js'),
      'module.exports = { OtherName: class OtherName { up() {} down() {} } };\n');
    expect(() => discoverMigrationClasses(directory, '.js')).toThrow(/must export exactly one class/);
  });

  it('rejects a migration without the required up/down methods', () => {
    fs.writeFileSync(path.join(directory, '1770108659848-AddMessageStatus.js'),
      'class AddMessageStatus1770108659848 { up() {} }\nmodule.exports = { AddMessageStatus1770108659848 };\n');
    expect(() => discoverMigrationClasses(directory, '.js')).toThrow(/must implement up\(\) and down\(\)/);
  });

  it('rejects two migrations with the same timestamp', () => {
    writeMigration(directory, '1770108659848', 'AddMessageStatus');
    writeMigration(directory, '1770108659848', 'OtherMigration');
    expect(() => discoverMigrationClasses(directory, '.js')).toThrow(/Duplicate OpenWA migration/);
  });

  it('rejects a missing required migration even when other migrations exist', () => {
    writeMigration(directory, '1770108659848', 'AddMessageStatus');
    expect(() => discoverMigrationClasses(directory, '.js', ['AddLidMappings1781200000000']))
      .toThrow(/Missing required OpenWA migration/);
  });

  it('loads the real data migration set and its required schema-creation migrations', () => {
    const migrations = loadDataMigrations();
    const names = migrations.map(migration => migration.name);
    expect(names).toEqual(expect.arrayContaining([
      'AddMessageStatus1770108659848',
      'AddLidMappings1781200000000',
      'AddWebhookDeliveryFailures1781700000000',
      'CreateStatusUpdates1784822470680',
      'AddWebhookOutboxEvents1786200000000',
    ]));
    expect(new Set(names).size).toBe(names.length);
    expect(names.every(name => /\d{13}$/.test(name))).toBe(true);
  });
});
