


import {
  MigrationInterface,
  QueryRunner,
  TableColumn,
  TableIndex,
} from 'typeorm';

/**
 * Adds Team Leader tenant ownership metadata to WhatsApp sessions.
 *
 * This migration belongs to the `data` connection, which can be either:
 *
 * - better-sqlite3
 * - PostgreSQL
 *
 * New columns:
 *
 *   ownerTeamLeaderId
 *     Soft cross-database reference to TeamLeader.id.
 *     NULL means a legacy/non-Team-Leader-owned session.
 *
 *   targetPhone
 *     Optional display/intention metadata supplied during session creation.
 *     It is NEVER authorization state.
 *
 * No database foreign key is created for ownerTeamLeaderId because
 * TeamLeader lives in the separate `main` database.
 */
export class AddSessionTenantOwner1788686100000
  implements MigrationInterface
{
  name = 'AddSessionTenantOwner1788686100000';

  public async up(
    queryRunner: QueryRunner,
  ): Promise<void> {
    if (!(await queryRunner.hasTable('sessions'))) {
      throw new Error(
        'sessions table is missing; the data schema must exist before AddSessionTenantOwner runs',
      );
    }

    /*
     * Nullable columns preserve all legacy sessions:
     *
     *   ownerTeamLeaderId = NULL
     *   targetPhone       = NULL
     */

    if (
      !(await queryRunner.hasColumn(
        'sessions',
        'ownerTeamLeaderId',
      ))
    ) {
      await queryRunner.addColumn(
        'sessions',
        new TableColumn({
          name: 'ownerTeamLeaderId',
          type: 'varchar',
          length: '36',
          isNullable: true,
        }),
      );
    }

    if (
      !(await queryRunner.hasColumn(
        'sessions',
        'targetPhone',
      ))
    ) {
      await queryRunner.addColumn(
        'sessions',
        new TableColumn({
          name: 'targetPhone',
          type: 'varchar',
          length: '20',
          isNullable: true,
        }),
      );
    }

    await this.ensureOwnerIndex(
      queryRunner,
    );
  }

  public async down(
    queryRunner: QueryRunner,
  ): Promise<void> {
    if (!(await queryRunner.hasTable('sessions'))) {
      return;
    }

    await this.dropOwnerIndex(
      queryRunner,
    );

    if (
      await queryRunner.hasColumn(
        'sessions',
        'targetPhone',
      )
    ) {
      await queryRunner.dropColumn(
        'sessions',
        'targetPhone',
      );
    }

    if (
      await queryRunner.hasColumn(
        'sessions',
        'ownerTeamLeaderId',
      )
    ) {
      await queryRunner.dropColumn(
        'sessions',
        'ownerTeamLeaderId',
      );
    }
  }

  /**
   * Create the ownership lookup index using TypeORM's QueryRunner rather
   * than dialect-specific SQL so the same migration works on both
   * better-sqlite3 and PostgreSQL.
   */
  private async ensureOwnerIndex(
    queryRunner: QueryRunner,
  ): Promise<void> {
    const table = await queryRunner.getTable(
      'sessions',
    );

    if (!table) {
      throw new Error(
        'Cannot create session owner index: sessions table does not exist',
      );
    }

    const exists = table.indices.some(
      index =>
        index.columnNames.length === 1 &&
        index.columnNames[0] ===
          'ownerTeamLeaderId',
    );

    if (exists) {
      return;
    }

    await queryRunner.createIndex(
      'sessions',
      new TableIndex({
        columnNames: [
          'ownerTeamLeaderId',
        ],
      }),
    );
  }

  private async dropOwnerIndex(
    queryRunner: QueryRunner,
  ): Promise<void> {
    const table = await queryRunner.getTable(
      'sessions',
    );

    if (!table) {
      return;
    }

    const indexes = table.indices.filter(
      index =>
        index.columnNames.length === 1 &&
        index.columnNames[0] ===
          'ownerTeamLeaderId',
    );

    for (const index of indexes) {
      await queryRunner.dropIndex(
        'sessions',
        index,
      );
    }
  }
}



