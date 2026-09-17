import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Persist resolved phone endpoints on message history without replacing the original WhatsApp ids.
 * Both columns are nullable because groups/channels have no single peer phone and an unresolved LID
 * is deliberately represented as unknown rather than as a fake phone number.
 */
export class AddMessagePhoneParticipants1789603200000 implements MigrationInterface {
  name = 'AddMessagePhoneParticipants1789603200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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
    if (!(await queryRunner.hasTable('messages'))) return;

    if (await queryRunner.hasColumn('messages', 'sentToPhone')) {
      await queryRunner.dropColumn('messages', 'sentToPhone');
    }
    if (await queryRunner.hasColumn('messages', 'sentByPhone')) {
      await queryRunner.dropColumn('messages', 'sentByPhone');
    }
  }
}
