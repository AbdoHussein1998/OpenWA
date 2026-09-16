import {
  MigrationInterface,
  QueryRunner,
  TableForeignKey,
} from 'typeorm';

interface SessionForeignKeySpec {
  tableName: string;
  sessionColumn: string;
  foreignKeyName: string;
}

interface PostgresForeignKeyRow {
  conname: string;
  referencedTable: string;
  referencedColumn: string;
  deleteAction: string;
}

interface SqliteTriggerRow {
  name: string;
  sql: string;
}

/**
 * Tightens referential integrity for Data-DB rows whose lifecycle is owned by a Session.
 *
 * PostgreSQL deliberately uses catalog/raw DDL rather than QueryRunner.getTable(). The existing
 * AddMessagesFts migration creates messages.body_ts as a generated column with raw SQL, so there is
 * no TypeORM `typeorm_metadata` row/table for that expression. PostgresQueryRunner.getTable()
 * attempts to read that internal table when it sees a generated column and therefore fails on a
 * healthy migration-managed database. Existing OpenWA PostgreSQL migrations already use
 * pg_constraint/information_schema for the same reason: raw migration SQL is the schema authority.
 *
 * SQLite still needs TypeORM's table-rebuild implementation because SQLite cannot ALTER TABLE ADD
 * CONSTRAINT. A table rebuild can change rowids and remove table triggers, so the migration captures
 * and restores triggers and rebuilds the external-content messages_fts index when `messages` is
 * rebuilt.
 *
 * Existing orphan rows are never deleted or rewritten. The migration fails with sample ids so an
 * operator can repair inconsistent data explicitly and retry.
 */
export class AddSessionOwnedForeignKeys1789545600000 implements MigrationInterface {
  name = 'AddSessionOwnedForeignKeys1789545600000';

  private static readonly SPECS: readonly SessionForeignKeySpec[] = [
    {
      tableName: 'messages',
      sessionColumn: 'sessionId',
      foreignKeyName: 'FK_messages_sessionId',
    },
    {
      tableName: 'message_batches',
      sessionColumn: 'session_id',
      foreignKeyName: 'FK_message_batches_session_id',
    },
    {
      tableName: 'status_updates',
      sessionColumn: 'sessionId',
      foreignKeyName: 'FK_status_updates_sessionId',
    },
  ];

  private quoteIdentifier(identifier: string): string {
    return `"${identifier.replaceAll('"', '""')}"`;
  }

  private isPostgres(queryRunner: QueryRunner): boolean {
    return queryRunner.dataSource.options.type === 'postgres';
  }

  private async assertRequiredTableExists(
    queryRunner: QueryRunner,
    tableName: string,
  ): Promise<void> {
    if (!(await queryRunner.hasTable(tableName))) {
      throw new Error(
        `Cannot add Session foreign keys because required table ${tableName} does not exist in the data database`,
      );
    }
  }

  private async assertNoOrphans(
    queryRunner: QueryRunner,
    spec: SessionForeignKeySpec,
  ): Promise<void> {
    const table = this.quoteIdentifier(spec.tableName);
    const column = this.quoteIdentifier(spec.sessionColumn);

    const orphanRows = (await queryRunner.query(
      `SELECT child."id" AS "id", child.${column} AS "sessionId" ` +
        `FROM ${table} child ` +
        `LEFT JOIN "sessions" parent ON parent."id" = child.${column} ` +
        `WHERE child.${column} IS NOT NULL AND parent."id" IS NULL ` +
        `LIMIT 10`,
    )) as Array<{
      id?: unknown;
      sessionId?: unknown;
    }>;

    if (orphanRows.length === 0) {
      return;
    }

    const samples = orphanRows
      .map(row => `${String(row.id ?? '?')} -> ${String(row.sessionId ?? '?')}`)
      .join(', ');

    throw new Error(
      `Cannot add ${spec.foreignKeyName}: ${spec.tableName}.${spec.sessionColumn} contains orphan Session references. ` +
        `Repair the data and rerun the migration. Sample rowId -> sessionId values: ${samples}`,
    );
  }

  /**
   * Read PostgreSQL FK metadata directly from pg_catalog.
   *
   * Do not replace this with queryRunner.getTable(): messages.body_ts is a raw-SQL generated
   * column, and TypeORM's Postgres table loader queries `typeorm_metadata` when it encounters one.
   */
  private async postgresForeignKeysForColumn(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string,
  ): Promise<PostgresForeignKeyRow[]> {
    const rows = (await queryRunner.query(
      `SELECT ` +
        `c.conname AS "conname", ` +
        `ref.relname AS "referencedTable", ` +
        `ref_col.attname AS "referencedColumn", ` +
        `c.confdeltype AS "deleteAction" ` +
        `FROM pg_constraint c ` +
        `JOIN pg_class child ON child.oid = c.conrelid ` +
        `JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace ` +
        `JOIN pg_attribute child_col ` +
        `  ON child_col.attrelid = child.oid AND child_col.attnum = c.conkey[1] ` +
        `JOIN pg_class ref ON ref.oid = c.confrelid ` +
        `JOIN pg_namespace ref_ns ON ref_ns.oid = ref.relnamespace ` +
        `JOIN pg_attribute ref_col ` +
        `  ON ref_col.attrelid = ref.oid AND ref_col.attnum = c.confkey[1] ` +
        `WHERE c.contype = 'f' ` +
        `AND child_ns.nspname = current_schema() ` +
        `AND ref_ns.nspname = current_schema() ` +
        `AND child.relname = $1 ` +
        `AND child_col.attname = $2 ` +
        `AND array_length(c.conkey, 1) = 1 ` +
        `AND array_length(c.confkey, 1) = 1`,
      [tableName, columnName],
    )) as PostgresForeignKeyRow[] | undefined;

    return rows ?? [];
  }

  private async needsPostgresForeignKey(
    queryRunner: QueryRunner,
    spec: SessionForeignKeySpec,
  ): Promise<boolean> {
    const foreignKeys = await this.postgresForeignKeysForColumn(
      queryRunner,
      spec.tableName,
      spec.sessionColumn,
    );

    const equivalent = foreignKeys.find(
      foreignKey =>
        foreignKey.referencedTable === 'sessions' &&
        foreignKey.referencedColumn === 'id',
    );

    if (equivalent) {
      // PostgreSQL pg_constraint.confdeltype: c = CASCADE.
      if (equivalent.deleteAction !== 'c') {
        throw new Error(
          `${spec.tableName}.${spec.sessionColumn} already has a Session foreign key without ON DELETE CASCADE; ` +
            `review constraint ${equivalent.conname} before applying this migration`,
        );
      }

      return false;
    }

    if (foreignKeys.length > 0) {
      throw new Error(
        `${spec.tableName}.${spec.sessionColumn} already has a foreign key that does not reference sessions.id; ` +
          `review constraint(s) ${foreignKeys.map(foreignKey => foreignKey.conname).join(', ')} before applying this migration`,
      );
    }

    await this.assertNoOrphans(queryRunner, spec);
    return true;
  }

  private async needsSqliteForeignKey(
    queryRunner: QueryRunner,
    spec: SessionForeignKeySpec,
  ): Promise<boolean> {
    const table = await queryRunner.getTable(spec.tableName);

    if (!table) {
      throw new Error(
        `Cannot add ${spec.foreignKeyName}: required table ${spec.tableName} could not be loaded`,
      );
    }

    const foreignKeysForColumn = table.foreignKeys.filter(
      foreignKey =>
        foreignKey.columnNames.length === 1 &&
        foreignKey.columnNames[0] === spec.sessionColumn,
    );

    const equivalent = foreignKeysForColumn.find(
      foreignKey =>
        foreignKey.referencedTableName.split('.').at(-1) === 'sessions' &&
        foreignKey.referencedColumnNames.length === 1 &&
        foreignKey.referencedColumnNames[0] === 'id',
    );

    if (equivalent) {
      if (equivalent.onDelete?.toUpperCase() !== 'CASCADE') {
        throw new Error(
          `${spec.tableName}.${spec.sessionColumn} already has a Session foreign key without ON DELETE CASCADE; ` +
            `review constraint ${equivalent.name ?? '(unnamed)'} before applying this migration`,
        );
      }

      return false;
    }

    if (foreignKeysForColumn.length > 0) {
      throw new Error(
        `${spec.tableName}.${spec.sessionColumn} already has a foreign key that does not reference sessions.id; ` +
          'review that constraint before applying this migration',
      );
    }

    await this.assertNoOrphans(queryRunner, spec);
    return true;
  }

  private async needsForeignKey(
    queryRunner: QueryRunner,
    spec: SessionForeignKeySpec,
  ): Promise<boolean> {
    return this.isPostgres(queryRunner)
      ? this.needsPostgresForeignKey(queryRunner, spec)
      : this.needsSqliteForeignKey(queryRunner, spec);
  }

  private async sqliteTriggersForTable(
    queryRunner: QueryRunner,
    tableName: string,
  ): Promise<SqliteTriggerRow[]> {
    const rows = (await queryRunner.query(
      `SELECT name, sql FROM sqlite_master ` +
        `WHERE type = 'trigger' AND tbl_name = ? AND sql IS NOT NULL`,
      [tableName],
    )) as Array<{
      name?: unknown;
      sql?: unknown;
    }>;

    return rows
      .filter(
        (row): row is { name: string; sql: string } =>
          typeof row.name === 'string' && typeof row.sql === 'string',
      )
      .map(row => ({
        name: row.name,
        sql: row.sql,
      }));
  }

  private async sqliteTriggerExists(
    queryRunner: QueryRunner,
    triggerName: string,
  ): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT 1 AS present FROM sqlite_master WHERE type = 'trigger' AND name = ? LIMIT 1`,
      [triggerName],
    )) as unknown[];

    return rows.length > 0;
  }

  private async sqliteTableExistsInCatalog(
    queryRunner: QueryRunner,
    tableName: string,
  ): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
      [tableName],
    )) as unknown[];

    return rows.length > 0;
  }

  /**
   * TypeORM rebuilds SQLite tables to add/drop FKs. Preserve non-TypeORM triggers around that
   * rebuild, and rebuild the FTS5 external-content index if the messages rowids changed.
   */
  private async withSqliteTableRebuildProtection(
    queryRunner: QueryRunner,
    tableName: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const triggers = await this.sqliteTriggersForTable(queryRunner, tableName);

    await operation();

    for (const trigger of triggers) {
      if (!(await this.sqliteTriggerExists(queryRunner, trigger.name))) {
        await queryRunner.query(trigger.sql);
      }
    }

    if (
      tableName === 'messages' &&
      (await this.sqliteTableExistsInCatalog(queryRunner, 'messages_fts'))
    ) {
      // External-content FTS5 rows key off messages.rowid. A table rebuild can assign new rowids,
      // so rebuild the index from the authoritative content table before accepting traffic.
      await queryRunner.query(
        `INSERT INTO "messages_fts"("messages_fts") VALUES ('rebuild')`,
      );
    }
  }

  private async createForeignKey(
    queryRunner: QueryRunner,
    spec: SessionForeignKeySpec,
  ): Promise<void> {
    if (this.isPostgres(queryRunner)) {
      await queryRunner.query(
        `ALTER TABLE ${this.quoteIdentifier(spec.tableName)} ` +
          `ADD CONSTRAINT ${this.quoteIdentifier(spec.foreignKeyName)} ` +
          `FOREIGN KEY (${this.quoteIdentifier(spec.sessionColumn)}) ` +
          `REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
      );
      return;
    }

    await this.withSqliteTableRebuildProtection(
      queryRunner,
      spec.tableName,
      () =>
        queryRunner.createForeignKey(
          spec.tableName,
          new TableForeignKey({
            name: spec.foreignKeyName,
            columnNames: [spec.sessionColumn],
            referencedTableName: 'sessions',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
            onUpdate: 'NO ACTION',
          }),
        ),
    );
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertRequiredTableExists(queryRunner, 'sessions');

    for (const spec of AddSessionOwnedForeignKeys1789545600000.SPECS) {
      await this.assertRequiredTableExists(queryRunner, spec.tableName);
    }

    // Preflight every relationship before changing schema. That way an orphan or incompatible
    // constraint in one table cannot leave only part of the intended FK set applied.
    const pending: SessionForeignKeySpec[] = [];

    for (const spec of AddSessionOwnedForeignKeys1789545600000.SPECS) {
      if (await this.needsForeignKey(queryRunner, spec)) {
        pending.push(spec);
      }
    }

    for (const spec of pending) {
      await this.createForeignKey(queryRunner, spec);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const spec of [...AddSessionOwnedForeignKeys1789545600000.SPECS].reverse()) {
      if (!(await queryRunner.hasTable(spec.tableName))) {
        continue;
      }

      if (this.isPostgres(queryRunner)) {
        // Drop only the canonical constraint created by this migration. If up() adopted an
        // equivalent pre-existing FK with another name, down() deliberately leaves it intact.
        await queryRunner.query(
          `ALTER TABLE ${this.quoteIdentifier(spec.tableName)} ` +
            `DROP CONSTRAINT IF EXISTS ${this.quoteIdentifier(spec.foreignKeyName)}`,
        );
        continue;
      }

      const table = await queryRunner.getTable(spec.tableName);
      const foreignKey = table?.foreignKeys.find(
        candidate => candidate.name === spec.foreignKeyName,
      );

      if (!foreignKey) {
        continue;
      }

      await this.withSqliteTableRebuildProtection(
        queryRunner,
        spec.tableName,
        () => queryRunner.dropForeignKey(spec.tableName, foreignKey),
      );
    }
  }
}
