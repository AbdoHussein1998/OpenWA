import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Optional per-session caller key for outbound sends. UNIQUE over (sessionId, idempotencyKey)
 * protects concurrent requests on different backend workers sharing the same data database.
 * NULL permits arbitrary legacy and phone-originated messages. No credentials are stored here.
 * Run BEFORE starting a backend that writes idempotencyKey.
 */
export class AddMessageSendIdempotency1789610400000 implements MigrationInterface {
  name = 'AddMessageSendIdempotency1789610400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type === 'postgres') {
      await queryRunner.query('ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "idempotencyKey" varchar(128)');
      await queryRunner.query('ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "sendRequestHash" varchar(64)');
      await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "UQ_messages_sessionId_idempotencyKey" ON "messages" ("sessionId", "idempotencyKey")');
      return;
    }
    if (!(await queryRunner.hasTable('messages'))) return;
    if (!(await queryRunner.hasColumn('messages', 'idempotencyKey'))) {
      await queryRunner.addColumn('messages', new TableColumn({
        name: 'idempotencyKey', type: 'varchar', length: '128', isNullable: true,
      }));
    }
    if (!(await queryRunner.hasColumn('messages', 'sendRequestHash'))) {
      await queryRunner.addColumn('messages', new TableColumn({
        name: 'sendRequestHash', type: 'varchar', length: '64', isNullable: true,
      }));
    }
    const table = await queryRunner.getTable('messages');
    if (!table?.indices.some(index => index.name === 'UQ_messages_sessionId_idempotencyKey')) {
      await queryRunner.createIndex('messages', new TableIndex({
        name: 'UQ_messages_sessionId_idempotencyKey',
        columnNames: ['sessionId', 'idempotencyKey'],
        isUnique: true,
      }));
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type === 'postgres') {
      await queryRunner.query('DROP INDEX IF EXISTS "UQ_messages_sessionId_idempotencyKey"');
      await queryRunner.query('ALTER TABLE "messages" DROP COLUMN IF EXISTS "sendRequestHash"');
      await queryRunner.query('ALTER TABLE "messages" DROP COLUMN IF EXISTS "idempotencyKey"');
      return;
    }
    if (!(await queryRunner.hasTable('messages'))) return;
    const table = await queryRunner.getTable('messages');
    if (table?.indices.some(index => index.name === 'UQ_messages_sessionId_idempotencyKey')) {
      await queryRunner.dropIndex('messages', 'UQ_messages_sessionId_idempotencyKey');
    }
    if (await queryRunner.hasColumn('messages', 'sendRequestHash')) {
      await queryRunner.dropColumn('messages', 'sendRequestHash');
    }
    if (await queryRunner.hasColumn('messages', 'idempotencyKey')) {
      await queryRunner.dropColumn('messages', 'idempotencyKey');
    }
  }
}
