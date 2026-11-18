import { MigrationInterface, QueryRunner, TableForeignKey } from 'typeorm';

interface ForeignKeySpec {
  tableName: string;
  columnNames: readonly string[];
  referencedTableName: string;
  referencedColumnNames: readonly string[];
  foreignKeyName: string;
  onDelete: 'CASCADE' | 'RESTRICT';
  /** Values accepted by the current application but incompatible with the old FK restored by down(). */
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
 * Corrects the ownership assumptions introduced by ConnectOperationalDataGraph1789552800000.
 *
 * The backend already defines four different lifecycles and the relational model must preserve them:
 *
 *  - plugin_instances.sessionScope: configuration scope. A missing Session is tolerated and warned
 *    about by ScopeBindingService because restoring the same Session id can make the binding valid.
 *  - conversation_mappings.sessionId: repairable provenance. ConversationMappingService.rebindSession
 *    needs the row to survive a Session deletion/re-pair.
 *  - ingress_events: the persist-before-ack dedup oracle, retained independently for a bounded window.
 *  - integration_delivery_failures / webhook_delivery_failures: DLQ/history with their own retention.
 *
 * Those references must therefore NOT cascade or restrict parent deletion. The identifiers remain
 * indexed scalar provenance columns.
 *
 * Two ownership relationships intentionally remain untouched:
 *
 *  - conversation_mappings(pluginId, instanceId)
 *      -> plugin_instances(pluginId, instanceId) ON DELETE CASCADE
 *  - webhook_outbox_events(webhookId, sessionId)
 *      -> webhooks(id, sessionId) ON DELETE CASCADE
 *
 * The outbox relation remains because replay requires the live Webhook configuration. Terminal failure
 * history is stored separately and survives through webhook_delivery_failures.
 *
 * PostgreSQL schema inspection uses pg_catalog directly and never QueryRunner.getTable(), preserving
 * compatibility with the hand-authored messages.body_ts generated column (no typeorm_metadata table).
 * SQLite uses TypeORM's rebuild support and restores any non-TypeORM triggers if a rebuild drops them.
 */
export class CorrectOperationalForeignKeyLifecycles1789564500000 implements MigrationInterface {
  name = 'CorrectOperationalForeignKeyLifecycles1789564500000';

  /** Foreign keys removed by up() and restored by down(). */
  private static readonly LEGACY_FOREIGN_KEYS: readonly ForeignKeySpec[] = [
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
      tableName: 'webhook_delivery_failures',
      columnNames: ['webhookId', 'sessionId'],
      referencedTableName: 'webhooks',
      referencedColumnNames: ['id', 'sessionId'],
      foreignKeyName: 'FK_webhook_delivery_failures_webhook_session',
      onDelete: 'CASCADE',
    },
  ];

  private isPostgres(queryRunner: QueryRunner): boolean {
    return queryRunner.dataSource.options.type === 'postgres';
  }

  private quoteIdentifier(identifier: string): string {
    return `"${identifier.replaceAll('"', '""')}"`;
  }

  private normalizedPairs(childColumns: readonly string[], referencedColumns: readonly string[]): string[] {
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

  private postgresDeleteAction(onDelete: ForeignKeySpec['onDelete']): string {
    return onDelete === 'CASCADE' ? 'c' : 'r';
  }

  private async assertRequiredTablesExist(queryRunner: QueryRunner): Promise<void> {
    const tables = new Set<string>();
    for (const spec of CorrectOperationalForeignKeyLifecycles1789564500000.LEGACY_FOREIGN_KEYS) {
      tables.add(spec.tableName);
      tables.add(spec.referencedTableName);
    }
    for (const tableName of tables) {
      if (!(await queryRunner.hasTable(tableName))) {
        throw new Error(
          `Cannot correct operational FK lifecycles because required table ${tableName} does not exist in the data database`,
        );
      }
    }
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

  private matchesSpec(
    foreignKey: Pick<PostgresForeignKeyRow, 'referencedTable' | 'childColumns' | 'referencedColumns'>,
    spec: ForeignKeySpec,
  ): boolean {
    return (
      foreignKey.referencedTable === spec.referencedTableName &&
      this.samePairs(
        foreignKey.childColumns,
        foreignKey.referencedColumns,
        spec.columnNames,
        spec.referencedColumnNames,
      )
    );
  }

  private async sqliteTriggersForTable(queryRunner: QueryRunner, tableName: string): Promise<SqliteTriggerRow[]> {
    const rows = (await queryRunner.query(
      `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND sql IS NOT NULL`,
      [tableName],
    )) as Array<{ name?: unknown; sql?: unknown }>;
    return rows
      .filter(
        (row): row is { name: string; sql: string } => typeof row.name === 'string' && typeof row.sql === 'string',
      )
      .map(row => ({ name: row.name, sql: row.sql }));
  }

  private async sqliteTriggerExists(queryRunner: QueryRunner, triggerName: string): Promise<boolean> {
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

  private async dropForeignKey(queryRunner: QueryRunner, spec: ForeignKeySpec): Promise<void> {
    if (this.isPostgres(queryRunner)) {
      const matches = (await this.postgresForeignKeysForTable(queryRunner, spec.tableName)).filter(fk =>
        this.matchesSpec(fk, spec),
      );
      for (const foreignKey of matches) {
        await queryRunner.query(
          `ALTER TABLE ${this.quoteIdentifier(spec.tableName)} ` +
            `DROP CONSTRAINT IF EXISTS ${this.quoteIdentifier(foreignKey.conname)}`,
        );
      }
      return;
    }

    const table = await queryRunner.getTable(spec.tableName);
    if (!table) throw new Error(`Cannot load required table ${spec.tableName}`);
    const matches = table.foreignKeys.filter(
      foreignKey =>
        foreignKey.referencedTableName.split('.').at(-1) === spec.referencedTableName &&
        this.samePairs(
          foreignKey.columnNames,
          foreignKey.referencedColumnNames,
          spec.columnNames,
          spec.referencedColumnNames,
        ),
    );
    for (const foreignKey of matches) {
      await this.withSqliteRebuildProtection(queryRunner, spec.tableName, () =>
        queryRunner.dropForeignKey(spec.tableName, foreignKey),
      );
    }
  }

  private activeReferenceCondition(spec: ForeignKeySpec): string {
    const conditions = spec.columnNames.map(columnName => `child.${this.quoteIdentifier(columnName)} IS NOT NULL`);
    if (spec.normalizeToNullValues?.length) {
      if (spec.columnNames.length !== 1) {
        throw new Error(`${spec.foreignKeyName}: normalizeToNullValues is supported only for single-column FKs`);
      }
      const column = this.quoteIdentifier(spec.columnNames[0]);
      const values = spec.normalizeToNullValues.map(value => `'${value.replaceAll("'", "''")}'`).join(', ');
      conditions.push(`child.${column} NOT IN (${values})`);
    }
    return conditions.join(' AND ');
  }

  private joinCondition(spec: ForeignKeySpec): string {
    return spec.columnNames
      .map(
        (columnName, index) =>
          `child.${this.quoteIdentifier(columnName)} = parent.${this.quoteIdentifier(spec.referencedColumnNames[index])}`,
      )
      .join(' AND ');
  }

  private async assertNoOrphans(queryRunner: QueryRunner, spec: ForeignKeySpec): Promise<void> {
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

    if (rows.length === 0) return;
    const samples = rows
      .map(row => {
        const key = spec.columnNames.map((_, index) => String(row[`child_${index}`] ?? '?')).join(' / ');
        return `${String(row.id ?? '?')} -> ${key}`;
      })
      .join(', ');
    throw new Error(
      `Cannot restore ${spec.foreignKeyName}: ${spec.tableName} contains references that no longer resolve to ` +
        `${spec.referencedTableName}. Repair the data before reverting this migration. ` +
        `Sample rowId -> key values: ${samples}`,
    );
  }

  private async normalizeNullEquivalentValues(queryRunner: QueryRunner, spec: ForeignKeySpec): Promise<void> {
    if (!spec.normalizeToNullValues?.length) return;
    if (spec.columnNames.length !== 1) {
      throw new Error(`${spec.foreignKeyName}: normalizeToNullValues is supported only for single-column FKs`);
    }
    const table = this.quoteIdentifier(spec.tableName);
    const column = this.quoteIdentifier(spec.columnNames[0]);
    const values = spec.normalizeToNullValues.map(value => `'${value.replaceAll("'", "''")}'`).join(', ');
    await queryRunner.query(`UPDATE ${table} SET ${column} = NULL WHERE ${column} IN (${values})`);
  }

  private async foreignKeyExists(queryRunner: QueryRunner, spec: ForeignKeySpec): Promise<boolean> {
    if (this.isPostgres(queryRunner)) {
      const foreignKeys = await this.postgresForeignKeysForTable(queryRunner, spec.tableName);
      const overlapping = foreignKeys.filter(fk => this.overlapsColumns(fk.childColumns, spec.columnNames));
      const exact = overlapping.filter(fk => this.matchesSpec(fk, spec));
      const incompatible = overlapping.filter(fk => !exact.includes(fk));
      if (incompatible.length > 0) {
        throw new Error(
          `${spec.tableName}.${spec.columnNames.join(',')} already has incompatible foreign-key constraint(s): ` +
            `${incompatible.map(fk => fk.conname).join(', ')}`,
        );
      }
      if (exact.length === 0) return false;
      const expectedDelete = this.postgresDeleteAction(spec.onDelete);
      const invalidAction = exact.find(fk => fk.deleteAction !== expectedDelete || fk.updateAction !== 'a');
      if (invalidAction) {
        throw new Error(
          `${invalidAction.conname} does not match ON DELETE ${spec.onDelete} / ON UPDATE NO ACTION required by rollback`,
        );
      }
      return true;
    }

    const table = await queryRunner.getTable(spec.tableName);
    if (!table) throw new Error(`Cannot load required table ${spec.tableName}`);
    const overlapping = table.foreignKeys.filter(fk => this.overlapsColumns(fk.columnNames, spec.columnNames));
    const exact = overlapping.filter(
      fk =>
        fk.referencedTableName.split('.').at(-1) === spec.referencedTableName &&
        this.samePairs(fk.columnNames, fk.referencedColumnNames, spec.columnNames, spec.referencedColumnNames),
    );
    const incompatible = overlapping.filter(fk => !exact.includes(fk));
    if (incompatible.length > 0) {
      throw new Error(`${spec.tableName}.${spec.columnNames.join(',')} already has an incompatible foreign-key constraint`);
    }
    if (exact.length === 0) return false;
    const invalidAction = exact.find(
      fk =>
        fk.onDelete?.toUpperCase() !== spec.onDelete ||
        (fk.onUpdate?.toUpperCase() ?? 'NO ACTION') !== 'NO ACTION',
    );
    if (invalidAction) {
      throw new Error(
        `${invalidAction.name ?? 'existing FK'} does not match ON DELETE ${spec.onDelete} / ON UPDATE NO ACTION required by rollback`,
      );
    }
    return true;
  }

  private async createForeignKey(queryRunner: QueryRunner, spec: ForeignKeySpec): Promise<void> {
    if (this.isPostgres(queryRunner)) {
      const childColumns = spec.columnNames.map(column => this.quoteIdentifier(column)).join(', ');
      const referencedColumns = spec.referencedColumnNames.map(column => this.quoteIdentifier(column)).join(', ');
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

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertRequiredTablesExist(queryRunner);
    for (const spec of CorrectOperationalForeignKeyLifecycles1789564500000.LEGACY_FOREIGN_KEYS) {
      await this.dropForeignKey(queryRunner, spec);
    }
    // Deliberately retain the supporting indexes created by ConnectOperationalDataGraph. They remain
    // useful for provenance lookups and UQ_webhooks_id_sessionId is required by the retained outbox FK.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.assertRequiredTablesExist(queryRunner);

    // Preflight every relationship before mutating schema, so rollback never leaves a half-restored graph.
    const missing: ForeignKeySpec[] = [];
    for (const spec of CorrectOperationalForeignKeyLifecycles1789564500000.LEGACY_FOREIGN_KEYS) {
      if (await this.foreignKeyExists(queryRunner, spec)) continue;
      await this.assertNoOrphans(queryRunner, spec);
      missing.push(spec);
    }

    // The old schema cannot represent the explicit '*' wildcard. Match the legacy migration's behavior
    // only when rolling back to that schema; the forward/current model preserves '*'.
    for (const spec of missing) {
      await this.normalizeNullEquivalentValues(queryRunner, spec);
    }

    // Required by the legacy composite webhook_delivery_failures -> webhooks relationship.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_webhooks_id_sessionId" ON "webhooks" ("id", "sessionId")`,
    );

    for (const spec of missing) {
      await this.createForeignKey(queryRunner, spec);
    }
  }
}
