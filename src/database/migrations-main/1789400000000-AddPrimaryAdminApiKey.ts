import {
  MigrationInterface,
  QueryRunner,
  TableColumn,
} from 'typeorm';

/**
 * Persist the identity of the installation's primary administrative API key.
 *
 * The main database is SQLite. AuthService backfills exactly one row at
 * startup after this column exists; the migration deliberately does not try to
 * infer identity from a mutable key name.
 */
export class AddPrimaryAdminApiKey1789400000000
  implements MigrationInterface
{
  name = 'AddPrimaryAdminApiKey1789400000000';

  public async up(
    queryRunner: QueryRunner,
  ): Promise<void> {
    if (
      !(await queryRunner.hasTable('api_keys')) ||
      (await queryRunner.hasColumn(
        'api_keys',
        'isPrimaryAdminKey',
      ))
    ) {
      return;
    }

    await queryRunner.addColumn(
      'api_keys',
      new TableColumn({
        name: 'isPrimaryAdminKey',
        type: 'boolean',
        isNullable: false,
        default: false,
      }),
    );

    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_api_keys_isPrimaryAdminKey" ' +
        'ON "api_keys" ("isPrimaryAdminKey")',
    );
  }

  public async down(
    queryRunner: QueryRunner,
  ): Promise<void> {
    if (
      !(await queryRunner.hasTable('api_keys')) ||
      !(await queryRunner.hasColumn(
        'api_keys',
        'isPrimaryAdminKey',
      ))
    ) {
      return;
    }

    await queryRunner.query(
      'DROP INDEX IF EXISTS "IDX_api_keys_isPrimaryAdminKey"',
    );

    await queryRunner.dropColumn(
      'api_keys',
      'isPrimaryAdminKey',
    );
  }
}
