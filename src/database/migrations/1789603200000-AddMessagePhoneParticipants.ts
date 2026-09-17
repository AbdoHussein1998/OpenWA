import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Persist resolved phone endpoints on message history without replacing the original WhatsApp ids.
 * Both columns are nullable because groups/channels have no single peer phone and an unresolved LID
 * is deliberately represented as unknown rather than as a fake phone number.
 *
 * PostgreSQL deliberately uses raw ALTER TABLE statements here instead of QueryRunner.addColumn /
 * dropColumn. TypeORM's PostgreSQL addColumn path introspects the full table and queries
 * `typeorm_metadata`; OpenWA databases created entirely by migrations do not necessarily have that
 * table, so a simple column addition could fail before executing the ALTER. The raw statements are
 * idempotent and match the hand-authored migration style used elsewhere in this project.
 */
export class AddMessagePhoneParticipants1789603200000 implements MigrationInterface {
  name = 'AddMessagePhoneParticipants1789603200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query(
        `ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "sentByPhone" varchar`,
      );
      await queryRunner.query(
        `ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "sentToPhone" varchar`,
      );
      return;
    }

    // SQLite path: keep TypeORM's table-rebuild-aware helpers. Guard every operation so the migration
    // remains safe on databases originally created with synchronize=true or partially adopted later.
    if (!(await queryRunner.hasTable('messages'))) return;

    if (!(await queryRunner.hasColumn('messages', 'sentByPhone'))) {
      await queryRunner.addColumn(
        'messages',
        new TableColumn({
          name: 'sentByPhone',
          type: 'varchar',
          isNullable: true,
        }),
      );
    }

    if (!(await queryRunner.hasColumn('messages', 'sentToPhone'))) {
      await queryRunner.addColumn(
        'messages',
        new TableColumn({
          name: 'sentToPhone',
          type: 'varchar',
          isNullable: true,
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query(
        `ALTER TABLE "messages" DROP COLUMN IF EXISTS "sentToPhone"`,
      );
      await queryRunner.query(
        `ALTER TABLE "messages" DROP COLUMN IF EXISTS "sentByPhone"`,
      );
      return;
    }

    if (!(await queryRunner.hasTable('messages'))) return;

    if (await queryRunner.hasColumn('messages', 'sentToPhone')) {
      await queryRunner.dropColumn('messages', 'sentToPhone');
    }
    if (await queryRunner.hasColumn('messages', 'sentByPhone')) {
      await queryRunner.dropColumn('messages', 'sentByPhone');
    }
  }
}
