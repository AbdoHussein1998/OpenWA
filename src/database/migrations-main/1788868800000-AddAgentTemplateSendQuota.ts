



import {
  MigrationInterface,
  QueryRunner,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

const USAGE_TABLE = 'agent_template_send_usage';

const CONSUMED_INDEX =
  'IDX_agent_template_send_usage_agent_status_consumed_at';

const RESERVATION_INDEX =
  'IDX_agent_template_send_usage_agent_status_reservation_expires_at';

/**
 * Adds the rolling 24-hour stored-template send quota schema for Agents.
 *
 * Main-database responsibilities:
 *
 * - add Agent.templateSendLimit24h;
 * - create agent_template_send_usage;
 * - enforce usage -> Agent ownership with ON DELETE CASCADE;
 * - add the two indexes used by quota reservation/cleanup queries.
 *
 * Important database boundary:
 *
 * Agent and AgentTemplateSendUsage both live in the `main` SQLite database,
 * so agentId is a real foreign key.
 *
 * Session lives in the separate `data` database, so sessionId is intentionally
 * stored as a plain varchar and MUST NOT have a database foreign key here.
 *
 * Backward compatibility:
 *
 * Existing Agents receive templateSendLimit24h = NULL, meaning unlimited.
 * New Agent creation is responsible for validating/persisting null, 0, or a
 * non-negative integer according to the API contract.
 *
 * The migration is idempotent at the schema-operation level so installations
 * previously created with TypeORM synchronize can adopt it safely.
 */
export class AddAgentTemplateSendQuota1788868800000
  implements MigrationInterface
{
  name = 'AddAgentTemplateSendQuota1788868800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('agents'))) {
      throw new Error(
        'agents table is missing; run AddTeamLeaderAgentPrincipals1788686000000 first',
      );
    }

    /*
     * ------------------------------------------------------------------
     * Agent quota configuration
     * ------------------------------------------------------------------
     *
     * NULL = unlimited / legacy behavior
     * 0    = stored-template sending disabled
     * N    = max stored-template sends in the rolling previous 24 hours
     */
    if (
      !(await queryRunner.hasColumn(
        'agents',
        'templateSendLimit24h',
      ))
    ) {
      // A nullable column requires no backfill and preserves all existing Agents
      // as unlimited immediately after migration.
      await queryRunner.query(
        `ALTER TABLE "agents" ` +
          `ADD COLUMN "templateSendLimit24h" integer`,
      );
    }

    await this.assertNullableQuotaColumn(queryRunner);

    /*
     * ------------------------------------------------------------------
     * Agent stored-template send usage / reservations
     * ------------------------------------------------------------------
     *
     * A row can represent either:
     *
     *   reserved  -> a quota slot temporarily reserved before the send
     *   consumed  -> a successfully consumed quota slot
     *
     * reservationExpiresAt lets the quota service reclaim abandoned/stale
     * reservations. consumedAt is the timestamp used by the rolling-24h count.
     */
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "${USAGE_TABLE}" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"agentId" varchar(36) NOT NULL, ` +
        `"sessionId" varchar(36) NOT NULL, ` +
        `"status" varchar(16) NOT NULL DEFAULT ('reserved'), ` +
        `"reservationExpiresAt" datetime, ` +
        `"consumedAt" datetime, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `FOREIGN KEY ("agentId") ` +
        `REFERENCES "agents" ("id") ` +
        `ON DELETE CASCADE` +
        `)`,
    );

    await this.assertUsageTableShape(queryRunner);

    /*
     * CREATE TABLE above includes the FK for a fresh migration-created DB.
     * This extra check also supports adoption of a synchronize-created table
     * where the table exists but the FK was not materialized as expected.
     */
    await this.ensureAgentForeignKey(queryRunner);

    /*
     * Query pattern #1:
     *   count/find consumed rows for one Agent inside the rolling window.
     *
     * Query pattern #2:
     *   count/find active reservations and clean expired reservations.
     */
    await this.ensureIndex(
      queryRunner,
      CONSUMED_INDEX,
      ['agentId', 'status', 'consumedAt'],
    );

    await this.ensureIndex(
      queryRunner,
      RESERVATION_INDEX,
      [
        'agentId',
        'status',
        'reservationExpiresAt',
      ],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /*
     * Usage rows reference Agents, so remove the child table before changing
     * the parent table.
     */
    if (await queryRunner.hasTable(USAGE_TABLE)) {
      await queryRunner.dropTable(
        USAGE_TABLE,
        true,
      );
    }

    if (
      (await queryRunner.hasTable('agents')) &&
      (await queryRunner.hasColumn(
        'agents',
        'templateSendLimit24h',
      ))
    ) {
      // Use QueryRunner rather than raw DROP COLUMN so TypeORM can perform the
      // SQLite table-rebuild fallback on SQLite versions/drivers that need it.
      await queryRunner.dropColumn(
        'agents',
        'templateSendLimit24h',
      );
    }
  }

  /**
   * If the quota column already exists because synchronize created it before
   * this migration was adopted, verify the compatibility property that matters
   * for legacy rows: it must remain nullable.
   */
  private async assertNullableQuotaColumn(
    queryRunner: QueryRunner,
  ): Promise<void> {
    const table = await queryRunner.getTable('agents');

    if (!table) {
      throw new Error(
        'Cannot validate Agent quota column: agents table does not exist',
      );
    }

    const column = table.columns.find(
      candidate =>
        candidate.name ===
        'templateSendLimit24h',
    );

    if (!column) {
      throw new Error(
        'Failed to create agents.templateSendLimit24h',
      );
    }

    if (!column.isNullable) {
      throw new Error(
        'agents.templateSendLimit24h must be nullable so existing Agents remain unlimited',
      );
    }
  }

  /**
   * CREATE TABLE IF NOT EXISTS is safe for normal reruns, but it would also
   * silently accept a partially-created/manual table. Fail fast instead of
   * letting quota code run against an incompatible schema.
   */
  private async assertUsageTableShape(
    queryRunner: QueryRunner,
  ): Promise<void> {
    const table = await queryRunner.getTable(
      USAGE_TABLE,
    );

    if (!table) {
      throw new Error(
        `Failed to create ${USAGE_TABLE}`,
      );
    }

    const expectedColumns: ReadonlyArray<{
      name: string;
      nullable: boolean;
    }> = [
      { name: 'id', nullable: false },
      { name: 'agentId', nullable: false },
      { name: 'sessionId', nullable: false },
      { name: 'status', nullable: false },
      {
        name: 'reservationExpiresAt',
        nullable: true,
      },
      { name: 'consumedAt', nullable: true },
      { name: 'createdAt', nullable: false },
    ];

    for (const expected of expectedColumns) {
      const column = table.columns.find(
        candidate =>
          candidate.name === expected.name,
      );

      if (!column) {
        throw new Error(
          `${USAGE_TABLE}.${expected.name} is missing`,
        );
      }

      if (column.isNullable !== expected.nullable) {
        throw new Error(
          `${USAGE_TABLE}.${expected.name} has incompatible nullability`,
        );
      }
    }

    const idColumn = table.columns.find(
      column => column.name === 'id',
    );

    if (!idColumn?.isPrimary) {
      throw new Error(
        `${USAGE_TABLE}.id must be the primary key`,
      );
    }

    const sessionForeignKey = table.foreignKeys.find(
      foreignKey =>
        foreignKey.columnNames.includes('sessionId'),
    );

    if (sessionForeignKey) {
      throw new Error(
        `${USAGE_TABLE}.sessionId must not have a foreign key because Session lives in the separate data database`,
      );
    }
  }

  /**
   * Ensure the usage table has the real main-database Agent foreign key.
   * Detection is based on the column/reference pair rather than generated
   * constraint names, matching the existing principal migration strategy.
   */
  private async ensureAgentForeignKey(
    queryRunner: QueryRunner,
  ): Promise<void> {
    const table = await queryRunner.getTable(
      USAGE_TABLE,
    );

    if (!table) {
      throw new Error(
        `Cannot create foreign key: ${USAGE_TABLE} does not exist`,
      );
    }

    const existing = table.foreignKeys.find(
      foreignKey =>
        foreignKey.columnNames.length === 1 &&
        foreignKey.columnNames[0] === 'agentId' &&
        foreignKey.referencedTableName === 'agents' &&
        foreignKey.referencedColumnNames.length === 1 &&
        foreignKey.referencedColumnNames[0] === 'id',
    );

    if (existing?.onDelete?.toUpperCase() === 'CASCADE') {
      return;
    }

    if (existing) {
      await queryRunner.dropForeignKey(
        USAGE_TABLE,
        existing,
      );
    }

    await queryRunner.createForeignKey(
      USAGE_TABLE,
      new TableForeignKey({
        columnNames: ['agentId'],
        referencedTableName: 'agents',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      }),
    );
  }

  /**
   * Ensure an index exists by indexed columns rather than only by name.
   * This avoids duplicate indexes when adopting a DB previously created by
   * TypeORM synchronize, which may have generated a different index name.
   */
  private async ensureIndex(
    queryRunner: QueryRunner,
    indexName: string,
    columnNames: string[],
  ): Promise<void> {
    const table = await queryRunner.getTable(
      USAGE_TABLE,
    );

    if (!table) {
      throw new Error(
        `Cannot create index: ${USAGE_TABLE} does not exist`,
      );
    }

    const sameColumns = table.indices.find(
      index =>
        !index.isUnique &&
        index.columnNames.length ===
          columnNames.length &&
        index.columnNames.every(
          (columnName, position) =>
            columnName === columnNames[position],
        ),
    );

    if (sameColumns) {
      return;
    }

    const sameName = table.indices.find(
      index => index.name === indexName,
    );

    if (sameName) {
      await queryRunner.dropIndex(
        USAGE_TABLE,
        sameName,
      );
    }

    await queryRunner.createIndex(
      USAGE_TABLE,
      new TableIndex({
        name: indexName,
        columnNames,
      }),
    );
  }
}







