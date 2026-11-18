import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Main DB is SQLite; this migration is used when MAIN_DATABASE_SYNCHRONIZE=false. */
export class AddApplicationDailyLogs1794873600000 implements MigrationInterface {
  name = 'AddApplicationDailyLogs1794873600000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS "application_daily_logs" (
      "id" varchar(36) PRIMARY KEY NOT NULL, "segmentKey" varchar(240) NOT NULL UNIQUE,
      "dateUtc" varchar(10) NOT NULL, "instanceId" varchar(110) NOT NULL,
      "status" varchar(30) NOT NULL, "archiveVersion" integer NOT NULL DEFAULT 1,
      "entryCount" integer NOT NULL DEFAULT 0, "sha256" varchar(64),
      "uncompressedBytes" integer NOT NULL DEFAULT 0, "compressedBytes" integer NOT NULL DEFAULT 0,
      "chunkCount" integer NOT NULL DEFAULT 0, "firstEventAt" datetime, "lastEventAt" datetime,
      "completedAt" datetime, "leaseOwner" varchar(120), "leaseUntil" datetime,
      "createdAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_application_log_date" ON "application_daily_logs"("dateUtc")`);
    await q.query(`CREATE TABLE IF NOT EXISTS "application_daily_log_chunks" (
      "dailyLogId" varchar(36) NOT NULL, "chunkNo" integer NOT NULL,
      "content" blob NOT NULL, "compressedBytes" integer NOT NULL, "sha256" varchar(64) NOT NULL,
      PRIMARY KEY ("dailyLogId", "chunkNo"))`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_application_chunk_archive" ON "application_daily_log_chunks"("dailyLogId")`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "application_daily_log_chunks"`);
    await q.query(`DROP TABLE IF EXISTS "application_daily_logs"`);
  }
}
