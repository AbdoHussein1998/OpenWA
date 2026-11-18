import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

type SqliteArtifact = {
  type: 'index' | 'trigger';
  name: string;
  sql: string;
};

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function captureSqliteArtifacts(
  queryRunner: QueryRunner,
  table: string,
): Promise<SqliteArtifact[]> {
  const rows = (await queryRunner.query(
    `SELECT type, name, sql
       FROM sqlite_master
      WHERE tbl_name = ?
        AND type IN ('index', 'trigger')
        AND sql IS NOT NULL`,
    [table],
  )) as Array<{
    type: 'index' | 'trigger';
    name: string;
    sql: string | null;
  }>;

  return rows
    .filter((row): row is SqliteArtifact => typeof row.sql === 'string')
    .map(row => ({
      type: row.type,
      name: row.name,
      sql: row.sql,
    }));
}

async function restoreSqliteArtifacts(
  queryRunner: QueryRunner,
  artifacts: readonly SqliteArtifact[],
): Promise<void> {
  for (const artifact of artifacts) {
    const existing = (await queryRunner.query(
      `SELECT 1
         FROM sqlite_master
        WHERE type = ?
          AND name = ?
        LIMIT 1`,
      [artifact.type, artifact.name],
    )) as unknown[];

    if (existing.length === 0) {
      await queryRunner.query(artifact.sql);
    }
  }
}

async function dropSqliteSessionForeignKey(
  queryRunner: QueryRunner,
  tableName: string,
  columnName: string,
): Promise<void> {
  if (!(await queryRunner.hasTable(tableName))) return;

  const table = await queryRunner.getTable(tableName);
  if (!table) return;

  const foreignKeys = table.foreignKeys.filter(
    foreignKey =>
      foreignKey.referencedTableName === 'sessions' &&
      foreignKey.columnNames.length === 1 &&
      foreignKey.columnNames[0] === columnName,
  );

  if (foreignKeys.length === 0) return;

  const artifacts = await captureSqliteArtifacts(queryRunner, tableName);

  for (const foreignKey of foreignKeys) {
    await queryRunner.dropForeignKey(tableName, foreignKey);
  }

  await restoreSqliteArtifacts(queryRunner, artifacts);
}

async function sqliteHasSessionForeignKey(
  queryRunner: QueryRunner,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  if (!(await queryRunner.hasTable(tableName))) return false;
  const table = await queryRunner.getTable(tableName);
  return Boolean(
    table?.foreignKeys.some(
      foreignKey =>
        foreignKey.referencedTableName === 'sessions' &&
        foreignKey.columnNames.length === 1 &&
        foreignKey.columnNames[0] === columnName,
    ),
  );
}

async function createSqliteSessionForeignKey(
  queryRunner: QueryRunner,
  tableName: string,
  columnName: string,
  constraintName: string,
): Promise<void> {
  if (!(await queryRunner.hasTable(tableName))) return;
  if (await sqliteHasSessionForeignKey(queryRunner, tableName, columnName)) return;

  const artifacts = await captureSqliteArtifacts(queryRunner, tableName);

  await queryRunner.createForeignKey(
    tableName,
    new TableForeignKey({
      name: constraintName,
      columnNames: [columnName],
      referencedTableName: 'sessions',
      referencedColumnNames: ['id'],
      onDelete: 'CASCADE',
    }),
  );

  await restoreSqliteArtifacts(queryRunner, artifacts);
}

async function postgresSessionForeignKeys(
  queryRunner: QueryRunner,
  tableName: string,
  columnName: string,
): Promise<string[]> {
  const rows = (await queryRunner.query(
    `SELECT con.conname AS name
       FROM pg_constraint con
       JOIN pg_class child
         ON child.oid = con.conrelid
       JOIN pg_namespace child_ns
         ON child_ns.oid = child.relnamespace
       JOIN pg_class parent
         ON parent.oid = con.confrelid
       JOIN pg_namespace parent_ns
         ON parent_ns.oid = parent.relnamespace
       JOIN pg_attribute attr
         ON attr.attrelid = child.oid
        AND attr.attnum = ANY(con.conkey)
      WHERE con.contype = 'f'
        AND child_ns.nspname = current_schema()
        AND child.relname = $1
        AND parent_ns.nspname = child_ns.nspname
        AND parent.relname = 'sessions'
        AND attr.attname = $2`,
    [tableName, columnName],
  )) as Array<{ name: string }>;

  return rows.map(row => row.name);
}

async function dropPostgresSessionForeignKey(
  queryRunner: QueryRunner,
  tableName: string,
  columnName: string,
): Promise<void> {
  for (const constraintName of await postgresSessionForeignKeys(
    queryRunner,
    tableName,
    columnName,
  )) {
    await queryRunner.query(
      `ALTER TABLE ${quoteIdentifier(tableName)} DROP CONSTRAINT ${quoteIdentifier(constraintName)}`,
    );
  }
}

async function createPostgresSessionForeignKey(
  queryRunner: QueryRunner,
  tableName: string,
  columnName: string,
  constraintName: string,
): Promise<void> {
  if (!(await queryRunner.hasTable(tableName))) return;
  if ((await postgresSessionForeignKeys(queryRunner, tableName, columnName)).length > 0) return;

  await queryRunner.query(
    `ALTER TABLE ${quoteIdentifier(tableName)} ` +
      `ADD CONSTRAINT ${quoteIdentifier(constraintName)} ` +
      `FOREIGN KEY (${quoteIdentifier(columnName)}) ` +
      `REFERENCES "sessions"("id") ON DELETE CASCADE`,
  );
}

async function assertNoHistoricalOrphans(
  queryRunner: QueryRunner,
  tableName: string,
  columnName: string,
): Promise<void> {
  if (!(await queryRunner.hasTable(tableName))) return;

  const rows = (await queryRunner.query(
    `SELECT child.${quoteIdentifier(columnName)} AS "sessionId"
       FROM ${quoteIdentifier(tableName)} child
       LEFT JOIN "sessions" parent
         ON parent."id" = child.${quoteIdentifier(columnName)}
      WHERE parent."id" IS NULL
      LIMIT 1`,
  )) as Array<{ sessionId: string }>;

  if (rows.length > 0) {
    throw new Error(
      `Cannot restore ${tableName}.${columnName} -> sessions.id: preserved historical rows now ` +
        `reference deleted Session ${JSON.stringify(rows[0].sessionId)}. Restore the Session rows first ` +
        `or keep this migration applied; rollback will not delete history to satisfy the old FK.`,
    );
  }
}

export class PreserveMessageAndBatchHistory1789568100000 implements MigrationInterface {
  name = 'PreserveMessageAndBatchHistory1789568100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('session_tombstones'))) {
      await queryRunner.createTable(
        new Table({
          name: 'session_tombstones',
          columns: [
            {
              name: 'sessionId',
              type: 'varchar',
              isPrimary: true,
              isNullable: false,
            },
            {
              name: 'name',
              type: 'varchar',
              length: '100',
              isNullable: false,
            },
            {
              name: 'ownerTeamLeaderId',
              type: 'varchar',
              isNullable: true,
            },
            {
              name: 'deletedAt',
              type: 'text',
              isNullable: false,
            },
          ],
        }),
        true,
      );
    }

    if (await queryRunner.hasTable('session_tombstones')) {
      const table = await queryRunner.getTable('session_tombstones');
      const hasOwnerIndex = table?.indices.some(
        index =>
          index.columnNames.length === 1 &&
          index.columnNames[0] === 'ownerTeamLeaderId',
      );

      if (!hasOwnerIndex) {
        await queryRunner.createIndex(
          'session_tombstones',
          new TableIndex({
            name: 'IDX_session_tombstones_ownerTeamLeaderId',
            columnNames: ['ownerTeamLeaderId'],
          }),
        );
      }
    }

    const isPostgres = queryRunner.connection.options.type === 'postgres';

    if (isPostgres) {
      /*
       * Do not use QueryRunner.getTable() for messages on PostgreSQL: the migration-managed generated
       * body_ts column is not guaranteed to have a typeorm_metadata row. pg_catalog is authoritative.
       */
      await dropPostgresSessionForeignKey(queryRunner, 'messages', 'sessionId');
      await dropPostgresSessionForeignKey(queryRunner, 'message_batches', 'session_id');
      return;
    }

    await dropSqliteSessionForeignKey(queryRunner, 'messages', 'sessionId');
    await dropSqliteSessionForeignKey(queryRunner, 'message_batches', 'session_id');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /*
     * Once a Session has been deleted, preserved messages/batches are intentionally orphaned from the
     * live sessions table. Recreating the old FKs would therefore be destructive or invalid. Refuse
     * rollback before DDL rather than deleting historical rows merely to make the schema fit.
     */
    await assertNoHistoricalOrphans(queryRunner, 'messages', 'sessionId');
    await assertNoHistoricalOrphans(queryRunner, 'message_batches', 'session_id');

    const isPostgres = queryRunner.connection.options.type === 'postgres';

    if (isPostgres) {
      await createPostgresSessionForeignKey(
        queryRunner,
        'messages',
        'sessionId',
        'FK_messages_sessionId',
      );
      await createPostgresSessionForeignKey(
        queryRunner,
        'message_batches',
        'session_id',
        'FK_message_batches_session_id',
      );
    } else {
      await createSqliteSessionForeignKey(
        queryRunner,
        'messages',
        'sessionId',
        'FK_messages_sessionId',
      );
      await createSqliteSessionForeignKey(
        queryRunner,
        'message_batches',
        'session_id',
        'FK_message_batches_session_id',
      );
    }

    if (await queryRunner.hasTable('session_tombstones')) {
      await queryRunner.dropTable('session_tombstones', true);
    }
  }
}
