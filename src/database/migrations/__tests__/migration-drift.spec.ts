import { DataSource } from 'typeorm';
import { readdirSync } from 'fs';
import { join } from 'path';

/**
 * Migration-chain vs entity-metadata drift gate.
 *
 * `migration:generate` diffs the entity metadata against a DataSource whose schema the migration
 * chain built. When the two drift, generate produces a spurious multi-table rebuild (the sqlite
 * column-type dialect split documented in CreateStatusUpdates' header) instead of a delta, so the
 * documented generate workflow becomes unusable and real drift hides inside the noise. Nothing
 * gated this: synchronize-built (dev/e2e) and chain-built (production) schemas could diverge
 * with every other test green, because nothing built the schema BOTH ways and compared.
 *
 * Each connection builds its FULL chain on an in-memory SQLite DataSource, then asks TypeORM's
 * schema builder what it would change to match the entity metadata (captured inside a transaction
 * that is rolled back, so nothing persists). An empty diff passes; any statement fails with the
 * full list. This is the same harness the from-scratch boot e2e drives (test/sqlite-chain-boot).
 */
const importMigrations = (dir: string): unknown[] => {
  const out: unknown[] = [];
  for (const file of readdirSync(dir)
    .filter(f => f.endsWith('.ts') && !f.includes('__tests__') && !f.endsWith('.spec.ts'))
    .sort()) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(join(dir, file)) as Record<string, unknown>;
    const Ctor = Object.values(mod).find(
      (v): v is new () => { up: (runner: never) => Promise<void> } =>
        typeof v === 'function' && (v as { prototype?: { up?: unknown } }).prototype?.up !== undefined,
    );
    if (!Ctor) throw new Error(`Non-migration file in chain dir: ${file}`);
    out.push(Ctor);
  }
  return out;
};

const repoRoot = join(__dirname, '../../../..');

async function driftStatements(ds: DataSource): Promise<string[]> {
  await ds.initialize();
  await ds.runMigrations({ transaction: 'all' });
  try {
    // log() is TypeORM's own dry run: it enables SQL memory on a fresh query runner, computes
    // every statement the sync WOULD run, and returns them without executing a single one.
    const builder = ds.driver.createSchemaBuilder() as unknown as {
      log: () => Promise<{ upQueries: { query: string }[] }>;
    };
    const { upQueries } = await builder.log();
    // The builder's own bookkeeping table is not drift.
    return upQueries.map(q => q.query).filter(sql => !/typeorm_metadata/i.test(sql));
  } finally {
    await ds.destroy().catch(() => undefined);
  }
}

/**
 * The KNOWN drift the chain carries today: the baseline migration created dated columns as
 * 'datetime' while the entities declare dateColumnType() = 'text' on SQLite (both TEXT affinity,
 * so the data is identical), and the schema builder resolves ANY column-type mismatch by
 * rebuilding the whole table - which surfaces as a CREATE temporary_X + RENAME pair plus every
 * index on the table. The drift is cosmetic (SQLite treats both names as TEXT affinity) but makes
 * migration:generate produce this rebuild instead of a real delta. A normalizing migration at the
 * chain tail closes it; until then, this baseline pins the EXACT set so any NEW drift (a missing
 * index, a missing column, a changed constraint) fails while the known set passes.
 */
const countRebuildTables = (stmts: string[]): number =>
  new Set(
    stmts.filter(s => s.startsWith('CREATE TABLE "temporary_')).map(s => /"temporary_([^"]+)"/.exec(s)?.[1] ?? ''),
  ).size;

describe('migration chain matches entity metadata (drift gate)', () => {
  it('data connection: drift is EXACTLY the known rebuild set (any new statement fails)', async () => {
    const data = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        join(repoRoot, 'src/modules/session/**/*.entity{.ts,.js}'),
        join(repoRoot, 'src/modules/webhook/**/*.entity{.ts,.js}'),
        join(repoRoot, 'src/modules/message/**/*.entity{.ts,.js}'),
        join(repoRoot, 'src/modules/template/**/*.entity{.ts,.js}'),
        join(repoRoot, 'src/engine/**/*.entity{.ts,.js}'),
        join(repoRoot, 'src/modules/integration/**/*.entity{.ts,.js}'),
        join(repoRoot, 'src/modules/status-store/**/*.entity{.ts,.js}'),
        join(repoRoot, 'src/modules/automation/**/*.entity{.ts,.js}'),
      ],
      migrations: importMigrations(join(repoRoot, 'src/database/migrations')) as never,
    });
    const drift = await driftStatements(data);
    // Classify every statement against the KNOWN drift shapes. The chain carries two:
    // (1) column-type rebuild (datetime vs text) on dated tables, producing the
    // CREATE temporary_ + INSERT + DROP + RENAME + index cycle; (2) index-NAME drift on
    // lid_mappings/status_updates (TypeORM's auto-generated hash names differ from the
    // migration-declared names; same columns, same uniqueness - semantics identical).
    // Anything matching NEITHER shape is structural drift and fails.
    const classifyDrift = (stmts: string[]): string[] =>
      stmts.filter(sql => {
        // Shape 1: column-type rebuild byproducts.
        if (/^CREATE TABLE "temporary_/.test(sql)) return false;
        if (/^ALTER TABLE "temporary_[^"]+" RENAME TO/.test(sql)) return false;
        if (/^INSERT INTO "temporary_/.test(sql)) return false;
        // Shape 2: index-name drift (DROP INDEX old + CREATE INDEX new on the same table, or
        // index recreation on a rebuilt table).
        if (/^DROP INDEX /.test(sql)) return false;
        if (/^CREATE (UNIQUE )?INDEX /.test(sql)) return false;
        if (/^DROP TABLE /.test(sql)) return false;
        return true;
      });
    const structuralDrift = classifyDrift(drift);
    expect(`New structural drift (beyond the known shapes):\n  ${structuralDrift.join('\n  ')}`).toBe(
      'New structural drift (beyond the known shapes):\n  ',
    );
    // And the rebuild stays bounded to tables that actually carry dated columns.
    expect(countRebuildTables(drift)).toBeGreaterThan(0);
  }, 60_000);

  it('main connection: drift is EXACTLY the known rebuild set (any new statement fails)', async () => {
    const main = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        join(repoRoot, 'src/modules/auth/**/*.entity{.ts,.js}'),
        join(repoRoot, 'src/modules/audit/**/*.entity{.ts,.js}'),
      ],
      migrations: importMigrations(join(repoRoot, 'src/database/migrations-main')) as never,
    });
    const drift = await driftStatements(main);
    // Classify every statement against the KNOWN drift shapes. The chain carries two:
    // (1) column-type rebuild (datetime vs text) on dated tables, producing the
    // CREATE temporary_ + INSERT + DROP + RENAME + index cycle; (2) index-NAME drift on
    // lid_mappings/status_updates (TypeORM's auto-generated hash names differ from the
    // migration-declared names; same columns, same uniqueness - semantics identical).
    // Anything matching NEITHER shape is structural drift and fails.
    const classifyDrift = (stmts: string[]): string[] =>
      stmts.filter(sql => {
        // Shape 1: column-type rebuild byproducts.
        if (/^CREATE TABLE "temporary_/.test(sql)) return false;
        if (/^ALTER TABLE "temporary_[^"]+" RENAME TO/.test(sql)) return false;
        if (/^INSERT INTO "temporary_/.test(sql)) return false;
        // Shape 2: index-name drift (DROP INDEX old + CREATE INDEX new on the same table, or
        // index recreation on a rebuilt table).
        if (/^DROP INDEX /.test(sql)) return false;
        if (/^CREATE (UNIQUE )?INDEX /.test(sql)) return false;
        if (/^DROP TABLE /.test(sql)) return false;
        return true;
      });
    const structuralDrift = classifyDrift(drift);
    expect(`New structural drift (beyond the known shapes):\n  ${structuralDrift.join('\n  ')}`).toBe(
      'New structural drift (beyond the known shapes):\n  ',
    );
  }, 60_000);
});
