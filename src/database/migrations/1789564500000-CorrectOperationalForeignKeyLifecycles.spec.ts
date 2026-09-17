import { QueryRunner, TableForeignKey } from 'typeorm';
import { CorrectOperationalForeignKeyLifecycles1789564500000 } from './1789564500000-CorrectOperationalForeignKeyLifecycles';

interface FakePgFk {
  conname: string;
  referencedTable: string;
  childColumns: string[];
  referencedColumns: string[];
  deleteAction: string;
  updateAction: string;
}

const legacyFksByTable: Record<string, FakePgFk[]> = {
  plugin_instances: [
    {
      conname: 'FK_plugin_instances_sessionScope',
      referencedTable: 'sessions',
      childColumns: ['sessionScope'],
      referencedColumns: ['id'],
      deleteAction: 'r',
      updateAction: 'a',
    },
  ],
  conversation_mappings: [
    {
      conname: 'FK_conversation_mappings_sessionId',
      referencedTable: 'sessions',
      childColumns: ['sessionId'],
      referencedColumns: ['id'],
      deleteAction: 'c',
      updateAction: 'a',
    },
    // This ownership FK must survive the corrective migration.
    {
      conname: 'FK_conversation_mappings_plugin_instance',
      referencedTable: 'plugin_instances',
      childColumns: ['pluginId', 'instanceId'],
      referencedColumns: ['pluginId', 'instanceId'],
      deleteAction: 'c',
      updateAction: 'a',
    },
  ],
  ingress_events: [
    {
      conname: 'FK_ingress_events_sessionId',
      referencedTable: 'sessions',
      childColumns: ['sessionId'],
      referencedColumns: ['id'],
      deleteAction: 'c',
      updateAction: 'a',
    },
    {
      conname: 'FK_ingress_events_plugin_instance',
      referencedTable: 'plugin_instances',
      childColumns: ['pluginId', 'instanceId'],
      referencedColumns: ['pluginId', 'instanceId'],
      deleteAction: 'c',
      updateAction: 'a',
    },
  ],
  integration_delivery_failures: [
    {
      conname: 'FK_integration_delivery_failures_sessionId',
      referencedTable: 'sessions',
      childColumns: ['sessionId'],
      referencedColumns: ['id'],
      deleteAction: 'c',
      updateAction: 'a',
    },
    {
      conname: 'FK_integration_delivery_failures_plugin_instance',
      referencedTable: 'plugin_instances',
      childColumns: ['pluginId', 'instanceId'],
      referencedColumns: ['pluginId', 'instanceId'],
      deleteAction: 'c',
      updateAction: 'a',
    },
  ],
  webhook_delivery_failures: [
    {
      conname: 'FK_webhook_delivery_failures_webhook_session',
      referencedTable: 'webhooks',
      childColumns: ['webhookId', 'sessionId'],
      referencedColumns: ['id', 'sessionId'],
      deleteAction: 'c',
      updateAction: 'a',
    },
  ],
  webhook_outbox_events: [
    // Not inspected by the corrective migration, but listed here as an explicit regression guard.
    {
      conname: 'FK_webhook_outbox_events_webhook_session',
      referencedTable: 'webhooks',
      childColumns: ['webhookId', 'sessionId'],
      referencedColumns: ['id', 'sessionId'],
      deleteAction: 'c',
      updateAction: 'a',
    },
  ],
};

function postgresRunner(initial: Record<string, FakePgFk[]> = legacyFksByTable) {
  const state = Object.fromEntries(Object.entries(initial).map(([table, fks]) => [table, fks.map(fk => ({ ...fk }))]));
  const statements: string[] = [];
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    statements.push(sql);
    if (sql.includes('FROM pg_constraint')) {
      const table = String(params?.[0] ?? '');
      return state[table] ?? [];
    }
    if (sql.startsWith('ALTER TABLE') && sql.includes('DROP CONSTRAINT')) {
      const match = sql.match(/^ALTER TABLE "([^"]+)" DROP CONSTRAINT IF EXISTS "([^"]+)"/);
      if (match) state[match[1]] = (state[match[1]] ?? []).filter(fk => fk.conname !== match[2]);
      return [];
    }
    if (sql.startsWith('ALTER TABLE') && sql.includes('ADD CONSTRAINT')) return [];
    if (sql.startsWith('SELECT child.')) return [];
    return [];
  });
  const runner = {
    dataSource: { options: { type: 'postgres' } },
    hasTable: jest.fn().mockResolvedValue(true),
    query,
    getTable: jest.fn(() => {
      throw new Error('PostgreSQL migration must never call getTable()');
    }),
  } as unknown as QueryRunner;
  return { runner, state, statements, query };
}

describe('CorrectOperationalForeignKeyLifecycles1789564500000', () => {
  it('PostgreSQL up drops only the seven provenance/history FKs and leaves ownership FKs alone', async () => {
    const { runner, state, statements } = postgresRunner();
    await new CorrectOperationalForeignKeyLifecycles1789564500000().up(runner);

    const drops = statements.filter(sql => sql.includes('DROP CONSTRAINT'));
    expect(drops).toHaveLength(7);
    expect(drops.join('\n')).toContain('FK_plugin_instances_sessionScope');
    expect(drops.join('\n')).toContain('FK_conversation_mappings_sessionId');
    expect(drops.join('\n')).toContain('FK_ingress_events_sessionId');
    expect(drops.join('\n')).toContain('FK_ingress_events_plugin_instance');
    expect(drops.join('\n')).toContain('FK_integration_delivery_failures_sessionId');
    expect(drops.join('\n')).toContain('FK_integration_delivery_failures_plugin_instance');
    expect(drops.join('\n')).toContain('FK_webhook_delivery_failures_webhook_session');
    expect(drops.join('\n')).not.toContain('FK_conversation_mappings_plugin_instance');
    expect(drops.join('\n')).not.toContain('FK_webhook_outbox_events_webhook_session');

    expect(state.conversation_mappings.map(fk => fk.conname)).toContain('FK_conversation_mappings_plugin_instance');
    expect(state.webhook_outbox_events.map(fk => fk.conname)).toContain('FK_webhook_outbox_events_webhook_session');
  });

  it('PostgreSQL up is idempotent and never uses TypeORM table introspection', async () => {
    const { runner, statements } = postgresRunner({});
    await expect(new CorrectOperationalForeignKeyLifecycles1789564500000().up(runner)).resolves.toBeUndefined();
    expect(statements.some(sql => sql.includes('DROP CONSTRAINT'))).toBe(false);
  });

  it('PostgreSQL down restores the seven legacy constraints only after orphan preflight', async () => {
    const { runner, statements } = postgresRunner({});
    await new CorrectOperationalForeignKeyLifecycles1789564500000().down(runner);

    const adds = statements.filter(sql => sql.includes('ADD CONSTRAINT'));
    expect(adds).toHaveLength(7);
    expect(adds.join('\n')).toContain('FK_plugin_instances_sessionScope');
    expect(adds.join('\n')).toContain('ON DELETE RESTRICT ON UPDATE NO ACTION');
    expect(adds.join('\n')).toContain('FK_webhook_delivery_failures_webhook_session');
    expect(statements.some(sql => sql.includes('UPDATE "plugin_instances" SET "sessionScope" = NULL'))).toBe(true);
    expect(statements.some(sql => sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS "UQ_webhooks_id_sessionId"'))).toBe(true);
  });

  it('PostgreSQL down fails before ADD CONSTRAINT when provenance rows no longer resolve', async () => {
    const { runner, query, statements } = postgresRunner({});
    (query as jest.Mock).mockImplementation(async (sql: string, params?: unknown[]) => {
      statements.push(sql);
      if (sql.includes('FROM pg_constraint')) return [];
      if (sql.includes('FROM "conversation_mappings" child')) {
        return [{ id: 'map-1', child_0: 'deleted-session' }];
      }
      if (sql.startsWith('SELECT child.')) return [];
      return [];
    });

    await expect(new CorrectOperationalForeignKeyLifecycles1789564500000().down(runner)).rejects.toThrow(
      /conversation_mappings contains references that no longer resolve/,
    );
    expect(statements.some(sql => sql.includes('ADD CONSTRAINT'))).toBe(false);
  });

  it('SQLite up removes matching legacy relations semantically rather than by generated name', async () => {
    const tables: Record<string, { foreignKeys: TableForeignKey[] }> = {
      plugin_instances: {
        foreignKeys: [
          new TableForeignKey({
            name: 'generated_scope_fk',
            columnNames: ['sessionScope'],
            referencedTableName: 'sessions',
            referencedColumnNames: ['id'],
            onDelete: 'RESTRICT',
          }),
        ],
      },
      conversation_mappings: {
        foreignKeys: [
          new TableForeignKey({
            name: 'generated_session_fk',
            columnNames: ['sessionId'],
            referencedTableName: 'sessions',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          }),
          new TableForeignKey({
            name: 'keep_plugin_owner',
            columnNames: ['pluginId', 'instanceId'],
            referencedTableName: 'plugin_instances',
            referencedColumnNames: ['pluginId', 'instanceId'],
            onDelete: 'CASCADE',
          }),
        ],
      },
      ingress_events: {
        foreignKeys: [
          new TableForeignKey({
            columnNames: ['sessionId'],
            referencedTableName: 'sessions',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          }),
          new TableForeignKey({
            columnNames: ['pluginId', 'instanceId'],
            referencedTableName: 'plugin_instances',
            referencedColumnNames: ['pluginId', 'instanceId'],
            onDelete: 'CASCADE',
          }),
        ],
      },
      integration_delivery_failures: {
        foreignKeys: [
          new TableForeignKey({
            columnNames: ['sessionId'],
            referencedTableName: 'sessions',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          }),
          new TableForeignKey({
            columnNames: ['pluginId', 'instanceId'],
            referencedTableName: 'plugin_instances',
            referencedColumnNames: ['pluginId', 'instanceId'],
            onDelete: 'CASCADE',
          }),
        ],
      },
      webhook_delivery_failures: {
        foreignKeys: [
          new TableForeignKey({
            columnNames: ['webhookId', 'sessionId'],
            referencedTableName: 'webhooks',
            referencedColumnNames: ['id', 'sessionId'],
            onDelete: 'CASCADE',
          }),
        ],
      },
    };
    const dropped: string[] = [];
    const runner = {
      dataSource: { options: { type: 'better-sqlite3' } },
      hasTable: jest.fn().mockResolvedValue(true),
      getTable: jest.fn(async (table: string) => tables[table]),
      query: jest.fn(async (sql: string) => {
        if (sql.includes('sqlite_master')) return [];
        return [];
      }),
      dropForeignKey: jest.fn(async (table: string, fk: TableForeignKey) => {
        dropped.push(`${table}:${fk.name ?? fk.columnNames.join('+')}`);
        tables[table].foreignKeys = tables[table].foreignKeys.filter(candidate => candidate !== fk);
      }),
    } as unknown as QueryRunner;

    await new CorrectOperationalForeignKeyLifecycles1789564500000().up(runner);
    expect(dropped).toHaveLength(7);
    expect(tables.conversation_mappings.foreignKeys.map(fk => fk.name)).toEqual(['keep_plugin_owner']);
  });
});
