



import {
  MigrationInterface,
  QueryRunner,
  TableColumn,
} from 'typeorm';

/**
 * Makes TeamLeader.email optional at the database level.
 *
 * The existing unique index is preserved. With SQLite's normal UNIQUE
 * semantics, multiple NULL values are allowed while non-null email values
 * remain unique.
 */
export class MakeTeamLeaderEmailNullable1789296480000
  implements MigrationInterface
{
  name = 'MakeTeamLeaderEmailNullable1789296480000';

  public async up(
    queryRunner: QueryRunner,
  ): Promise<void> {
    const table =
      await queryRunner.getTable(
        'team_leaders',
      );

    if (!table) {
      throw new Error(
        'Cannot make Team Leader email nullable: team_leaders table does not exist',
      );
    }

    const emailColumn =
      table.findColumnByName(
        'email',
      );

    if (!emailColumn) {
      throw new Error(
        'Cannot make Team Leader email nullable: team_leaders.email column does not exist',
      );
    }

    if (emailColumn.isNullable) {
      return;
    }

    await queryRunner.changeColumn(
      table,
      emailColumn,
      new TableColumn({
        name: emailColumn.name,
        type: emailColumn.type,
        length: emailColumn.length,
        isNullable: true,
        isUnique: emailColumn.isUnique,
        default: emailColumn.default,
        comment: emailColumn.comment,
        charset: emailColumn.charset,
        collation: emailColumn.collation,
      }),
    );
  }

  public async down(
    queryRunner: QueryRunner,
  ): Promise<void> {
    const table =
      await queryRunner.getTable(
        'team_leaders',
      );

    if (!table) {
      throw new Error(
        'Cannot restore Team Leader email constraint: team_leaders table does not exist',
      );
    }

    const emailColumn =
      table.findColumnByName(
        'email',
      );

    if (!emailColumn) {
      throw new Error(
        'Cannot restore Team Leader email constraint: team_leaders.email column does not exist',
      );
    }

    if (!emailColumn.isNullable) {
      return;
    }

    await queryRunner.changeColumn(
      table,
      emailColumn,
      new TableColumn({
        name: emailColumn.name,
        type: emailColumn.type,
        length: emailColumn.length,
        isNullable: false,
        isUnique: emailColumn.isUnique,
        default: emailColumn.default,
        comment: emailColumn.comment,
        charset: emailColumn.charset,
        collation: emailColumn.collation,
      }),
    );
  }
}


