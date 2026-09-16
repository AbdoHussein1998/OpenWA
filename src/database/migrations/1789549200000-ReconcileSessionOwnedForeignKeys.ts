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
  childColumnCount: number;
  referencedColumnCount: number;
  deleteAction: string;
  updateAction: string;
}

interface SqliteTriggerRow {
  name: string;
  sql: string;
}

/**
 * Reconciles the complete set of Data-DB tables whose lifecycle is owned by a Session.
 *
 * Ownership rule:
 *
 *   sessions.id
 *      ├─ webhooks.sessionId
 *      ├─ messages.sessionId
 *      ├─ message_batches.session_id
 *      ├─ templates.sessionId
 *      ├─ baileys_stored_messages.sessionId
 *      ├─ status_updates.sessionId
 *      └─ automation_rules.sessionId
 *
 * Every relationship above is non-null and ON DELETE CASCADE. The migration adopts an existing
 * equivalent FK regardless of its generated/name-mangled constraint name and only creates a missing
 * relationship. This makes it safe on databases created by older migrations or synchronize=true.
 *
 * IMPORTANT: several other Data-DB columns happen to contain a Session id but are intentionally NOT
 * ownership foreign keys and MUST NOT be added here:
 *
 * - conversation_mappings.sessionId: stale mappings deliberately survive a deleted/re-paired Session
 *   and can be rebound by ConversationMappingService.
 * - webhook_delivery_failures.sessionId: append-only operational/audit history survives Session
 *   deletion until its retention policy prunes it.
 * - integration_delivery_failures.sessionId: DLQ provenance survives the Session it references.
 * - webhook_outbox_events.sessionId: pending durable deliveries must not disappear merely because a
 *   Session/Webhook is deleted; settled rows are pruned by the outbox retention policy.
 * - ingress_events.sessionId: dedup/replay history is retained independently for its bounded window.
 * - lid_mappings.sessionId: provenance only; the global LID mapping intentionally outlives a Session.
 * - plugin_instances.sessionScope: a scope value, not ownership (it can also be null / wildcard).
 *
 * PostgreSQL deliberately avoids QueryRunner.getTable(). `messages.body_ts` is a raw-SQL generated
 * column, and TypeORM's PostgreSQL table introspection attempts to read `typeorm_metadata` for such a
 * column. Migration-managed OpenWA databases legitimately may not have that internal table. Direct
 * pg_catalog inspection keeps this migration compatible with the project's hand-authored schema.
 *
 * SQLite cannot ALTER TABLE ADD CONSTRAINT, so TypeORM rebuilds the table. The helper below preserves
 * table triggers and rebuilds the external-content messages_fts index after a messages rebuild.
 *
 * Existing orphan rows are never silently deleted or rewritten. The migration fails before DDL with
 * sample row ids so the operator can repair inconsistent data explicitly and rerun migrations.
 */
export class ReconcileSessionOwnedForeignKeys1789549200000
  implements MigrationInterface
{
  name = 'ReconcileSessionOwnedForeignKeys1789549200000';

  private static readonly SPECS: readonly SessionForeignKeySpec[] = [
    {
      tableName: 'webhooks',
      sessionColumn: 'sessionId',
      foreignKeyName: 'FK_webhooks_sessionId',
    },
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
      tableName: 'templates',
      sessionColumn: 'sessionId',
      foreignKeyName: 'FK_templates_sessionId',
    },
    {
      tableName: 'baileys_stored_messages',
      sessionColumn: 'sessionId',
      foreignKeyName: 'FK_baileys_stored_messages_sessionId',
    },
    {
      tableName: 'status_updates',
      sessionColumn: 'sessionId',
      foreignKeyName: 'FK_status_updates_sessionId',
    },
    {
      tableName: 'automation_rules',
      sessionColumn: 'sessionId',
      foreignKeyName: 'FK_automation_rules_sessionId',
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
        `Cannot reconcile Session foreign keys because required table ${tableName} does not exist in the data database`,
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
   * Do not replace this with queryRunner.getTable(): messages.body_ts is a raw-SQL generated column,
   * and TypeORM's PostgreSQL table loader queries `typeorm_metadata` when it encounters one.
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
        `cardinality(c.conkey)::int AS "childColumnCount", ` +
        `cardinality(c.confkey)::int AS "referencedColumnCount", ` +
        `c.confdeltype AS "deleteAction", ` +
        `c.confupdtype AS "updateAction" ` +
        `FROM pg_constraint c ` +
        `JOIN pg_class child ON child.oid = c.conrelid ` +
        `JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace ` +
        `JOIN pg_attribute child_col ` +
        `  ON child_col.attrelid = child.oid AND child_col.attnum = ANY(c.conkey) ` +
        `JOIN pg_class ref ON ref.oid = c.confrelid ` +
        `JOIN pg_namespace ref_ns ON ref_ns.oid = ref.relnamespace ` +
        `JOIN pg_attribute ref_col ` +
        `  ON ref_col.attrelid = ref.oid AND ref_col.attnum = c.confkey[1] ` +
        `WHERE c.contype = 'f' ` +
        `AND child_ns.nspname = current_schema() ` +
        `AND ref_ns.nspname = current_schema() ` +
        `AND child.relname = $1 ` +
        `AND child_col.attname = $2`,
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

    const incompatible = foreignKeys.filter(
      foreignKey =>
        foreignKey.childColumnCount !== 1 ||
        foreignKey.referencedColumnCount !== 1 ||
        foreignKey.referencedTable !== 'sessions' ||
        foreignKey.referencedColumn !== 'id' ||
        foreignKey.deleteAction !== 'c' ||
        foreignKey.updateAction !== 'a',
    );

    if (incompatible.length > 0) {
      throw new Error(
        `${spec.tableName}.${spec.sessionColumn} already has incompatible foreign-key constraint(s): ` +
          `${incompatible.map(foreignKey => foreignKey.conname).join(', ')}. ` +
          'Expected a single-column reference to sessions.id with ON DELETE CASCADE and ON UPDATE NO ACTION.',
      );
    }

    if (foreignKeys.length > 0) {
      return false;
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

    const incompatible = foreignKeysForColumn.filter(
      foreignKey =>
        foreignKey.referencedTableName.split('.').at(-1) !== 'sessions' ||
        foreignKey.referencedColumnNames.length !== 1 ||
        foreignKey.referencedColumnNames[0] !== 'id' ||
        foreignKey.onDelete?.toUpperCase() !== 'CASCADE' ||
        (foreignKey.onUpdate?.toUpperCase() ?? 'NO ACTION') !== 'NO ACTION',
    );

    if (incompatible.length > 0) {
      throw new Error(
        `${spec.tableName}.${spec.sessionColumn} already has an incompatible foreign-key constraint. ` +
          'Expected a single-column reference to sessions.id with ON DELETE CASCADE and ON UPDATE NO ACTION.',
      );
    }

    if (foreignKeysForColumn.length > 0) {
      return false;
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

    for (const spec of ReconcileSessionOwnedForeignKeys1789549200000.SPECS) {
      await this.assertRequiredTableExists(queryRunner, spec.tableName);
    }

    // Preflight EVERY ownership relationship before changing schema. An orphan or incompatible FK
    // therefore cannot leave only part of the intended ownership graph applied.
    const pending: SessionForeignKeySpec[] = [];

    for (const spec of ReconcileSessionOwnedForeignKeys1789549200000.SPECS) {
      if (await this.needsForeignKey(queryRunner, spec)) {
        pending.push(spec);
      }
    }

    for (const spec of pending) {
      await this.createForeignKey(queryRunner, spec);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const spec of [
      ...ReconcileSessionOwnedForeignKeys1789549200000.SPECS,
    ].reverse()) {
      if (!(await queryRunner.hasTable(spec.tableName))) {
        continue;
      }

      if (this.isPostgres(queryRunner)) {
        // Drop only the canonical constraint created by THIS migration. If up() merely adopted an
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
