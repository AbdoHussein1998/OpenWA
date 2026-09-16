import {
  MigrationInterface,
  QueryRunner,
  TableForeignKey,
} from 'typeorm';

interface ForeignKeySpec {
  tableName: string;
  columnNames: readonly string[];
  referencedTableName: string;
  referencedColumnNames: readonly string[];
  foreignKeyName: string;
  onDelete: 'CASCADE' | 'RESTRICT';
  /** Legacy/sentinel child values that are semantically NULL and are normalized before FK DDL. */
  normalizeToNullValues?: readonly string[];
}

interface PostgresForeignKeyRow {
  conname: string;
  referencedTable: string;
  childColumns: string[];
  referencedColumns: string[];
  deleteAction: string;
  updateAction: string;
}

interface SqliteTriggerRow {
  name: string;
  sql: string;
}

/**
 * Connects the remaining operational Data-DB tables into a real OLTP ownership graph.
 *
 * Final graph introduced by this migration:
 *
 * sessions
 *   ├─ webhooks
 *   │    ├─ webhook_outbox_events
 *   │    └─ webhook_delivery_failures
 *   └─ plugin_instances (nullable sessionScope; concrete scopes only, Session delete RESTRICT)
 *        ├─ conversation_mappings
 *        ├─ ingress_events
 *        └─ integration_delivery_failures
 *
 * conversation_mappings / ingress_events / integration_delivery_failures additionally reference
 * sessions directly because a global/unscoped PluginInstance may legitimately serve many Sessions.
 *
 * Operational children cascade with their owning Webhook / PluginInstance / Session. The one deliberate
 * exception is plugin_instances.sessionScope: deleting a Session is RESTRICTED while a concrete plugin
 * configuration still points at it. SET NULL would silently broaden/change that instance's persisted scope, while
 * CASCADE would bypass the runtime scope-teardown lifecycle. The operator must re-scope/delete it first.
 *
 * PostgreSQL uses pg_catalog directly and never QueryRunner.getTable(). This preserves compatibility
 * with OpenWA's hand-authored migration model and avoids the `typeorm_metadata` failure encountered on
 * databases containing the raw-SQL generated messages.body_ts column.
 *
 * SQLite uses TypeORM's table-rebuild FK support and preserves non-TypeORM triggers around rebuilds.
 * Existing orphan rows are never silently deleted; the migration aborts before any FK DDL and reports
 * sample offending row ids so the operator can repair data explicitly.
 */
export class ConnectOperationalDataGraph1789552800000
  implements MigrationInterface
{
  name = 'ConnectOperationalDataGraph1789552800000';

  private static readonly FOREIGN_KEYS: readonly ForeignKeySpec[] = [
    {
      tableName: 'plugin_instances',
      columnNames: ['sessionScope'],
      referencedTableName: 'sessions',
      referencedColumnNames: ['id'],
      foreignKeyName: 'FK_plugin_instances_sessionScope',
      onDelete: 'RESTRICT',
      normalizeToNullValues: ['*'],
    },
    {
      tableName: 'conversation_mappings',
      columnNames: ['sessionId'],
      referencedTableName: 'sessions',
      referencedColumnNames: ['id'],
      foreignKeyName: 'FK_conversation_mappings_sessionId',
      onDelete: 'CASCADE',
    },
    {
      tableName: 'conversation_mappings',
      columnNames: ['pluginId', 'instanceId'],
      referencedTableName: 'plugin_instances',
      referencedColumnNames: ['pluginId', 'instanceId'],
      foreignKeyName: 'FK_conversation_mappings_plugin_instance',
      onDelete: 'CASCADE',
    },
    {
      tableName: 'ingress_events',
      columnNames: ['sessionId'],
      referencedTableName: 'sessions',
      referencedColumnNames: ['id'],
      foreignKeyName: 'FK_ingress_events_sessionId',
      onDelete: 'CASCADE',
    },
    {
      tableName: 'ingress_events',
      columnNames: ['pluginId', 'instanceId'],
      referencedTableName: 'plugin_instances',
      referencedColumnNames: ['pluginId', 'instanceId'],
      foreignKeyName: 'FK_ingress_events_plugin_instance',
      onDelete: 'CASCADE',
    },
    {
      tableName: 'integration_delivery_failures',
      columnNames: ['sessionId'],
      referencedTableName: 'sessions',
      referencedColumnNames: ['id'],
      foreignKeyName: 'FK_integration_delivery_failures_sessionId',
      onDelete: 'CASCADE',
    },
    {
      tableName: 'integration_delivery_failures',
      columnNames: ['pluginId', 'instanceId'],
      referencedTableName: 'plugin_instances',
      referencedColumnNames: ['pluginId', 'instanceId'],
      foreignKeyName: 'FK_integration_delivery_failures_plugin_instance',
      onDelete: 'CASCADE',
    },
    {
      tableName: 'webhook_outbox_events',
      columnNames: ['webhookId', 'sessionId'],
      referencedTableName: 'webhooks',
      referencedColumnNames: ['id', 'sessionId'],
      foreignKeyName: 'FK_webhook_outbox_events_webhook_session',
      onDelete: 'CASCADE',
    },
    {
      tableName: 'webhook_delivery_failures',
      columnNames: ['webhookId', 'sessionId'],
      referencedTableName: 'webhooks',
      referencedColumnNames: ['id', 'sessionId'],
      foreignKeyName: 'FK_webhook_delivery_failures_webhook_session',
      onDelete: 'CASCADE',
    },
  ];

  private quoteIdentifier(identifier: string): string {
    return `"${identifier.replaceAll('"', '""')}"`;
  }

  private isPostgres(queryRunner: QueryRunner): boolean {
    return queryRunner.dataSource.options.type === 'postgres';
  }

  private async assertRequiredTablesExist(queryRunner: QueryRunner): Promise<void> {
    const tables = new Set<string>([
      'sessions',
      'webhooks',
      'plugin_instances',
      ...ConnectOperationalDataGraph1789552800000.FOREIGN_KEYS.map(spec => spec.tableName),
    ]);

    for (const tableName of tables) {
      if (!(await queryRunner.hasTable(tableName))) {
        throw new Error(
          `Cannot connect OLTP data graph because required table ${tableName} does not exist in the data database`,
        );
      }
    }
  }

  private joinCondition(spec: ForeignKeySpec): string {
    return spec.columnNames
      .map(
        (columnName, index) =>
          `child.${this.quoteIdentifier(columnName)} = parent.${this.quoteIdentifier(spec.referencedColumnNames[index])}`,
      )
      .join(' AND ');
  }

  private activeReferenceCondition(spec: ForeignKeySpec): string {
    const conditions = spec.columnNames.map(
      columnName => `child.${this.quoteIdentifier(columnName)} IS NOT NULL`,
    );

    if (spec.normalizeToNullValues?.length) {
      if (spec.columnNames.length !== 1) {
        throw new Error(`${spec.foreignKeyName}: normalizeToNullValues is supported only for single-column FKs`);
      }

      const column = this.quoteIdentifier(spec.columnNames[0]);
      const values = spec.normalizeToNullValues
        .map(value => `'${value.replaceAll("'", "''")}'`)
        .join(', ');
      conditions.push(`child.${column} NOT IN (${values})`);
    }

    return conditions.join(' AND ');
  }

  private async normalizeNullEquivalentValues(
    queryRunner: QueryRunner,
    spec: ForeignKeySpec,
  ): Promise<void> {
    if (!spec.normalizeToNullValues?.length) {
      return;
    }

    if (spec.columnNames.length !== 1) {
      throw new Error(`${spec.foreignKeyName}: normalizeToNullValues is supported only for single-column FKs`);
    }

    const table = this.quoteIdentifier(spec.tableName);
    const column = this.quoteIdentifier(spec.columnNames[0]);
    const values = spec.normalizeToNullValues
      .map(value => `'${value.replaceAll("'", "''")}'`)
      .join(', ');

    await queryRunner.query(
      `UPDATE ${table} SET ${column} = NULL WHERE ${column} IN (${values})`,
    );
  }

  private async assertNoOrphans(
    queryRunner: QueryRunner,
    spec: ForeignKeySpec,
  ): Promise<void> {
    const childTable = this.quoteIdentifier(spec.tableName);
    const parentTable = this.quoteIdentifier(spec.referencedTableName);
    const firstParentColumn = this.quoteIdentifier(spec.referencedColumnNames[0]);

    const selectedChildColumns = spec.columnNames
      .map(
        (columnName, index) =>
          `child.${this.quoteIdentifier(columnName)} AS ${this.quoteIdentifier(`child_${index}`)}`,
      )
      .join(', ');

    const rows = (await queryRunner.query(
      `SELECT child."id" AS "id", ${selectedChildColumns} ` +
        `FROM ${childTable} child ` +
        `LEFT JOIN ${parentTable} parent ON ${this.joinCondition(spec)} ` +
        `WHERE ${this.activeReferenceCondition(spec)} ` +
        `AND parent.${firstParentColumn} IS NULL ` +
        `LIMIT 10`,
    )) as Array<Record<string, unknown>>;

    if (rows.length === 0) {
      return;
    }

    const samples = rows
      .map(row => {
        const key = spec.columnNames
          .map((_, index) => String(row[`child_${index}`] ?? '?'))
          .join(' / ');
        return `${String(row.id ?? '?')} -> ${key}`;
      })
      .join(', ');

    throw new Error(
      `Cannot add ${spec.foreignKeyName}: ${spec.tableName} contains orphan references to ` +
        `${spec.referencedTableName}. Repair the data and rerun the migration. ` +
        `Sample rowId -> key values: ${samples}`,
    );
  }

  private normalizedPairs(
    childColumns: readonly string[],
    referencedColumns: readonly string[],
  ): string[] {
    return childColumns
      .map((childColumn, index) => `${childColumn}\u0000${referencedColumns[index]}`)
      .sort();
  }

  private samePairs(
    leftChild: readonly string[],
    leftReferenced: readonly string[],
    rightChild: readonly string[],
    rightReferenced: readonly string[],
  ): boolean {
    if (
      leftChild.length !== leftReferenced.length ||
      rightChild.length !== rightReferenced.length ||
      leftChild.length !== rightChild.length
    ) {
      return false;
    }

    const left = this.normalizedPairs(leftChild, leftReferenced);
    const right = this.normalizedPairs(rightChild, rightReferenced);
    return left.every((value, index) => value === right[index]);
  }

  private overlapsColumns(candidate: readonly string[], expected: readonly string[]): boolean {
    return candidate.some(column => expected.includes(column));
  }

  private async postgresForeignKeysForTable(
    queryRunner: QueryRunner,
    tableName: string,
  ): Promise<PostgresForeignKeyRow[]> {
    const rows = (await queryRunner.query(
      `SELECT ` +
        `c.conname AS "conname", ` +
        `ref.relname AS "referencedTable", ` +
        `array_agg(child_col.attname ORDER BY key_cols.ordinality) AS "childColumns", ` +
        `array_agg(ref_col.attname ORDER BY key_cols.ordinality) AS "referencedColumns", ` +
        `c.confdeltype AS "deleteAction", ` +
        `c.confupdtype AS "updateAction" ` +
        `FROM pg_constraint c ` +
        `JOIN pg_class child ON child.oid = c.conrelid ` +
        `JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace ` +
        `JOIN pg_class ref ON ref.oid = c.confrelid ` +
        `JOIN pg_namespace ref_ns ON ref_ns.oid = ref.relnamespace ` +
        `JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS key_cols(attnum, ordinality) ON true ` +
        `JOIN pg_attribute child_col ` +
        `  ON child_col.attrelid = child.oid AND child_col.attnum = key_cols.attnum ` +
        `JOIN pg_attribute ref_col ` +
        `  ON ref_col.attrelid = ref.oid AND ref_col.attnum = c.confkey[key_cols.ordinality::int] ` +
        `WHERE c.contype = 'f' ` +
        `AND child_ns.nspname = current_schema() ` +
        `AND ref_ns.nspname = current_schema() ` +
        `AND child.relname = $1 ` +
        `GROUP BY c.oid, c.conname, ref.relname, c.confdeltype, c.confupdtype`,
      [tableName],
    )) as PostgresForeignKeyRow[] | undefined;

    return rows ?? [];
  }

  private postgresDeleteAction(onDelete: ForeignKeySpec['onDelete']): string {
    return onDelete === 'CASCADE' ? 'c' : 'r';
  }

  private async needsPostgresForeignKey(
    queryRunner: QueryRunner,
    spec: ForeignKeySpec,
  ): Promise<boolean> {
    const foreignKeys = await this.postgresForeignKeysForTable(queryRunner, spec.tableName);
    const overlapping = foreignKeys.filter(foreignKey =>
      this.overlapsColumns(foreignKey.childColumns, spec.columnNames),
    );

    const equivalent = overlapping.filter(
      foreignKey =>
        foreignKey.referencedTable === spec.referencedTableName &&
        this.samePairs(
          foreignKey.childColumns,
          foreignKey.referencedColumns,
          spec.columnNames,
          spec.referencedColumnNames,
        ) &&
        foreignKey.deleteAction === this.postgresDeleteAction(spec.onDelete) &&
        foreignKey.updateAction === 'a',
    );

    const incompatible = overlapping.filter(foreignKey => !equivalent.includes(foreignKey));

    if (incompatible.length > 0) {
      throw new Error(
        `${spec.tableName}.${spec.columnNames.join(',')} already has incompatible foreign-key constraint(s): ` +
          `${incompatible.map(foreignKey => foreignKey.conname).join(', ')}. ` +
          `Expected ${spec.referencedTableName}(${spec.referencedColumnNames.join(',')}) ` +
          `with ON DELETE ${spec.onDelete} and ON UPDATE NO ACTION.`,
      );
    }

    if (equivalent.length > 0) {
      return false;
    }

    await this.assertNoOrphans(queryRunner, spec);
    return true;
  }

  private async needsSqliteForeignKey(
    queryRunner: QueryRunner,
    spec: ForeignKeySpec,
  ): Promise<boolean> {
    const table = await queryRunner.getTable(spec.tableName);

    if (!table) {
      throw new Error(`Cannot load required table ${spec.tableName}`);
    }

    const overlapping = table.foreignKeys.filter(foreignKey =>
      this.overlapsColumns(foreignKey.columnNames, spec.columnNames),
    );

    const equivalent = overlapping.filter(
      foreignKey =>
        foreignKey.referencedTableName.split('.').at(-1) === spec.referencedTableName &&
        this.samePairs(
          foreignKey.columnNames,
          foreignKey.referencedColumnNames,
          spec.columnNames,
          spec.referencedColumnNames,
        ) &&
        foreignKey.onDelete?.toUpperCase() === spec.onDelete &&
        (foreignKey.onUpdate?.toUpperCase() ?? 'NO ACTION') === 'NO ACTION',
    );

    const incompatible = overlapping.filter(foreignKey => !equivalent.includes(foreignKey));

    if (incompatible.length > 0) {
      throw new Error(
        `${spec.tableName}.${spec.columnNames.join(',')} already has an incompatible foreign-key constraint. ` +
          `Expected ${spec.referencedTableName}(${spec.referencedColumnNames.join(',')}) ` +
          `with ON DELETE ${spec.onDelete} and ON UPDATE NO ACTION.`,
      );
    }

    if (equivalent.length > 0) {
      return false;
    }

    await this.assertNoOrphans(queryRunner, spec);
    return true;
  }

  private async needsForeignKey(
    queryRunner: QueryRunner,
    spec: ForeignKeySpec,
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
    )) as Array<{ name?: unknown; sql?: unknown }>;

    return rows
      .filter(
        (row): row is { name: string; sql: string } =>
          typeof row.name === 'string' && typeof row.sql === 'string',
      )
      .map(row => ({ name: row.name, sql: row.sql }));
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

  private async withSqliteRebuildProtection(
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
  }

  private async createForeignKey(
    queryRunner: QueryRunner,
    spec: ForeignKeySpec,
  ): Promise<void> {
    if (this.isPostgres(queryRunner)) {
      const childColumns = spec.columnNames.map(column => this.quoteIdentifier(column)).join(', ');
      const referencedColumns = spec.referencedColumnNames
        .map(column => this.quoteIdentifier(column))
        .join(', ');

      await queryRunner.query(
        `ALTER TABLE ${this.quoteIdentifier(spec.tableName)} ` +
          `ADD CONSTRAINT ${this.quoteIdentifier(spec.foreignKeyName)} ` +
          `FOREIGN KEY (${childColumns}) ` +
          `REFERENCES ${this.quoteIdentifier(spec.referencedTableName)} (${referencedColumns}) ` +
          `ON DELETE ${spec.onDelete} ON UPDATE NO ACTION`,
      );
      return;
    }

    await this.withSqliteRebuildProtection(queryRunner, spec.tableName, () =>
      queryRunner.createForeignKey(
        spec.tableName,
        new TableForeignKey({
          name: spec.foreignKeyName,
          columnNames: [...spec.columnNames],
          referencedTableName: spec.referencedTableName,
          referencedColumnNames: [...spec.referencedColumnNames],
          onDelete: spec.onDelete,
          onUpdate: 'NO ACTION',
        }),
      ),
    );
  }

  private async createSupportingIndexes(queryRunner: QueryRunner): Promise<void> {
    // Required parent candidate key for the composite Webhook-child foreign keys. `id` alone is
    // already unique, so this operation is lossless and cannot surface duplicate rows.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_webhooks_id_sessionId" ` +
        `ON "webhooks" ("id", "sessionId")`,
    );

    // Child-side indexes keep parent deletes and Session-scoped operational queries from scanning
    // append-heavy integration tables. Existing composite indexes already cover pluginId+instanceId
    // and the Webhook children, so only the missing Session-scope indexes are added here.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_plugin_instances_sessionScope" ` +
        `ON "plugin_instances" ("sessionScope")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ingress_events_sessionId" ` +
        `ON "ingress_events" ("sessionId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_integration_delivery_failures_sessionId" ` +
        `ON "integration_delivery_failures" ("sessionId")`,
    );
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertRequiredTablesExist(queryRunner);

    // Preflight every FK before changing schema. A single orphan/incompatible constraint therefore
    // cannot leave a half-connected graph behind.
    const pending: ForeignKeySpec[] = [];

    for (const spec of ConnectOperationalDataGraph1789552800000.FOREIGN_KEYS) {
      if (await this.needsForeignKey(queryRunner, spec)) {
        pending.push(spec);
      }
    }

    // Canonicalize legacy sentinels only after every FK has passed orphan/conflict preflight.
    // `plugin_instances.sessionScope='*'` has always meant the same thing as NULL (all sessions), but
    // a real FK cannot point at that sentinel. Future writes are normalized in PluginInstanceService.
    for (const spec of ConnectOperationalDataGraph1789552800000.FOREIGN_KEYS) {
      await this.normalizeNullEquivalentValues(queryRunner, spec);
    }

    await this.createSupportingIndexes(queryRunner);

    for (const spec of pending) {
      await this.createForeignKey(queryRunner, spec);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const spec of [...ConnectOperationalDataGraph1789552800000.FOREIGN_KEYS].reverse()) {
      if (!(await queryRunner.hasTable(spec.tableName))) {
        continue;
      }

      if (this.isPostgres(queryRunner)) {
        // Drop only the canonical FK created by this migration. If up() adopted an equivalent
        // pre-existing relation under another name, down() deliberately leaves it intact.
        await queryRunner.query(
          `ALTER TABLE ${this.quoteIdentifier(spec.tableName)} ` +
            `DROP CONSTRAINT IF EXISTS ${this.quoteIdentifier(spec.foreignKeyName)}`,
        );
        continue;
      }

      const table = await queryRunner.getTable(spec.tableName);
      const foreignKey = table?.foreignKeys.find(candidate => candidate.name === spec.foreignKeyName);

      if (!foreignKey) {
        continue;
      }

      await this.withSqliteRebuildProtection(queryRunner, spec.tableName, () =>
        queryRunner.dropForeignKey(spec.tableName, foreignKey),
      );
    }

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_integration_delivery_failures_sessionId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ingress_events_sessionId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_plugin_instances_sessionScope"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_webhooks_id_sessionId"`);
  }
}
