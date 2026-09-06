


import {
  MigrationInterface,
  QueryRunner,
  TableColumn,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

/**
 * Adds Team Leader / Agent principals to the `main` database.
 *
 * Responsibilities:
 *
 * - create team_leaders;
 * - create agents;
 * - enforce Agent -> TeamLeader ownership with ON DELETE CASCADE;
 * - add teamLeaderId / agentId principal bindings to api_keys;
 * - add indexes;
 * - add real main-database foreign keys for API-key principal bindings.
 *
 * The `main` OpenWA connection is SQLite.
 *
 * This migration is deliberately idempotent at the schema-operation level
 * so it can also be adopted by installations whose main DB was previously
 * created through TypeORM synchronize.
 */
export class AddTeamLeaderAgentPrincipals1788686000000
  implements MigrationInterface
{
  name = 'AddTeamLeaderAgentPrincipals1788686000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /*
     * ------------------------------------------------------------------
     * Team Leaders
     * ------------------------------------------------------------------
     */

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "team_leaders" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"name" varchar(100) NOT NULL, ` +
        `"email" varchar(255) NOT NULL, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );

    await this.ensureSingleColumnIndex(
      queryRunner,
      'team_leaders',
      'email',
      true,
    );

    /*
     * ------------------------------------------------------------------
     * Agents
     * ------------------------------------------------------------------
     */

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "agents" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"name" varchar(100) NOT NULL, ` +
        `"email" varchar(255), ` +
        `"teamLeaderId" varchar(36) NOT NULL, ` +
        `"assignedSessionId" varchar(36), ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `FOREIGN KEY ("teamLeaderId") ` +
        `REFERENCES "team_leaders" ("id") ` +
        `ON DELETE CASCADE` +
        `)`,
    );

    await this.ensureSingleColumnIndex(
      queryRunner,
      'agents',
      'teamLeaderId',
    );

    await this.ensureSingleColumnIndex(
      queryRunner,
      'agents',
      'assignedSessionId',
    );

    /*
     * CREATE TABLE above handles the normal migration-created case.
     *
     * This additional check handles adoption of a table that may have
     * previously been created by synchronize or by an interrupted/manual
     * schema operation without the foreign key.
     */
    await this.ensureForeignKey(
      queryRunner,
      'agents',
      'teamLeaderId',
      'team_leaders',
      'id',
      'CASCADE',
    );

    /*
     * ------------------------------------------------------------------
     * API-key principal links
     * ------------------------------------------------------------------
     */

    if (!(await queryRunner.hasTable('api_keys'))) {
      throw new Error(
        'api_keys table is missing; run the main auth/audit baseline migration first',
      );
    }

    if (
      !(await queryRunner.hasColumn(
        'api_keys',
        'teamLeaderId',
      ))
    ) {
      await queryRunner.addColumn(
        'api_keys',
        new TableColumn({
          name: 'teamLeaderId',
          type: 'varchar',
          length: '36',
          isNullable: true,
        }),
      );
    }

    if (
      !(await queryRunner.hasColumn(
        'api_keys',
        'agentId',
      ))
    ) {
      await queryRunner.addColumn(
        'api_keys',
        new TableColumn({
          name: 'agentId',
          type: 'varchar',
          length: '36',
          isNullable: true,
        }),
      );
    }

    await this.ensureSingleColumnIndex(
      queryRunner,
      'api_keys',
      'teamLeaderId',
    );

    await this.ensureSingleColumnIndex(
      queryRunner,
      'api_keys',
      'agentId',
    );

    /*
     * Deleting a principal must never leave behind a usable management
     * credential with a stale authorization binding.
     *
     * Application services will still revoke/evict credentials before
     * principal deletion. CASCADE is the database integrity backstop.
     */
    await this.ensureForeignKey(
      queryRunner,
      'api_keys',
      'teamLeaderId',
      'team_leaders',
      'id',
      'CASCADE',
    );

    await this.ensureForeignKey(
      queryRunner,
      'api_keys',
      'agentId',
      'agents',
      'id',
      'CASCADE',
    );
  }

  public async down(
    queryRunner: QueryRunner,
  ): Promise<void> {
    /*
     * Remove API-key references first because they point at the principal
     * tables that will be removed afterwards.
     */

    if (await queryRunner.hasTable('api_keys')) {
      await this.dropForeignKeyForColumn(
        queryRunner,
        'api_keys',
        'agentId',
        'agents',
      );

      await this.dropForeignKeyForColumn(
        queryRunner,
        'api_keys',
        'teamLeaderId',
        'team_leaders',
      );

      await this.dropSingleColumnIndex(
        queryRunner,
        'api_keys',
        'agentId',
      );

      await this.dropSingleColumnIndex(
        queryRunner,
        'api_keys',
        'teamLeaderId',
      );

      if (
        await queryRunner.hasColumn(
          'api_keys',
          'agentId',
        )
      ) {
        await queryRunner.dropColumn(
          'api_keys',
          'agentId',
        );
      }

      if (
        await queryRunner.hasColumn(
          'api_keys',
          'teamLeaderId',
        )
      ) {
        await queryRunner.dropColumn(
          'api_keys',
          'teamLeaderId',
        );
      }
    }

    /*
     * Agents reference Team Leaders, so Agents must be removed first.
     */

    if (await queryRunner.hasTable('agents')) {
      await queryRunner.dropTable(
        'agents',
        true,
      );
    }

    if (await queryRunner.hasTable('team_leaders')) {
      await queryRunner.dropTable(
        'team_leaders',
        true,
      );
    }
  }

  /**
   * Ensure a single-column index exists.
   *
   * We detect by indexed columns rather than by index name so this works
   * both for migration-created databases and synchronize-created databases,
   * where TypeORM may have generated a different deterministic index name.
   */
  private async ensureSingleColumnIndex(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string,
    isUnique = false,
  ): Promise<void> {
    const table = await queryRunner.getTable(
      tableName,
    );

    if (!table) {
      throw new Error(
        `Cannot create index: table "${tableName}" does not exist`,
      );
    }

    const exists = table.indices.some(
      index =>
        index.columnNames.length === 1 &&
        index.columnNames[0] === columnName &&
        index.isUnique === isUnique,
    );

    if (exists) {
      return;
    }

    await queryRunner.createIndex(
      tableName,
      new TableIndex({
        columnNames: [columnName],
        isUnique,
      }),
    );
  }

  private async dropSingleColumnIndex(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string,
  ): Promise<void> {
    const table = await queryRunner.getTable(
      tableName,
    );

    if (!table) {
      return;
    }

    const indexes = table.indices.filter(
      index =>
        index.columnNames.length === 1 &&
        index.columnNames[0] === columnName,
    );

    for (const index of indexes) {
      await queryRunner.dropIndex(
        tableName,
        index,
      );
    }
  }

  /**
   * Ensure a foreign key exists based on the actual column/reference pair,
   * not its generated constraint name.
   */
  private async ensureForeignKey(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string,
    referencedTableName: string,
    referencedColumnName: string,
    onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION',
  ): Promise<void> {
    const table = await queryRunner.getTable(
      tableName,
    );

    if (!table) {
      throw new Error(
        `Cannot create foreign key: table "${tableName}" does not exist`,
      );
    }

    const exists = table.foreignKeys.some(
      foreignKey =>
        foreignKey.columnNames.length === 1 &&
        foreignKey.columnNames[0] === columnName &&
        foreignKey.referencedTableName === referencedTableName &&
        foreignKey.referencedColumnNames.length === 1 &&
        foreignKey.referencedColumnNames[0] ===
          referencedColumnName,
    );

    if (exists) {
      return;
    }

    await queryRunner.createForeignKey(
      tableName,
      new TableForeignKey({
        columnNames: [columnName],
        referencedTableName,
        referencedColumnNames: [
          referencedColumnName,
        ],
        onDelete,
      }),
    );
  }

  private async dropForeignKeyForColumn(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string,
    referencedTableName: string,
  ): Promise<void> {
    const table = await queryRunner.getTable(
      tableName,
    );

    if (!table) {
      return;
    }

    const foreignKey = table.foreignKeys.find(
      candidate =>
        candidate.columnNames.length === 1 &&
        candidate.columnNames[0] === columnName &&
        candidate.referencedTableName ===
          referencedTableName,
    );

    if (!foreignKey) {
      return;
    }

    await queryRunner.dropForeignKey(
      tableName,
      foreignKey,
    );
  }
}






