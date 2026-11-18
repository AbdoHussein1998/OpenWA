import { Column, Entity, Index, PrimaryGeneratedColumn, PrimaryColumn } from 'typeorm';

/** Stored on the `main` connection, separate from the audit-history table and retention. */
@Entity('application_daily_logs')
@Index('UQ_application_log_segment', ['segmentKey'], { unique: true })
@Index('IDX_application_log_date', ['dateUtc'])
export class ApplicationDailyLog {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'varchar', length: 240 }) segmentKey!: string;
  @Column({ type: 'varchar', length: 10 }) dateUtc!: string;
  @Column({ type: 'varchar', length: 110 }) instanceId!: string;
  @Column({ type: 'varchar', length: 30 }) status!: string;
  @Column({ type: 'integer', default: 1 }) archiveVersion!: number;
  @Column({ type: 'integer', default: 0 }) entryCount!: number;
  @Column({ type: 'varchar', length: 64, nullable: true }) sha256!: string | null;
  @Column({ type: 'integer', default: 0 }) uncompressedBytes!: number;
  @Column({ type: 'integer', default: 0 }) compressedBytes!: number;
  @Column({ type: 'integer', default: 0 }) chunkCount!: number;
  @Column({ type: 'datetime', nullable: true }) firstEventAt!: Date | null;
  @Column({ type: 'datetime', nullable: true }) lastEventAt!: Date | null;
  @Column({ type: 'datetime', nullable: true }) completedAt!: Date | null;
  @Column({ type: 'varchar', length: 120, nullable: true }) leaseOwner!: string | null;
  @Column({ type: 'datetime', nullable: true }) leaseUntil!: Date | null;
  @Column({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' }) createdAt!: Date;
}

@Entity('application_daily_log_chunks')
@Index('IDX_application_chunk_archive', ['dailyLogId'])
export class ApplicationDailyLogChunk {
  @PrimaryColumn({ type: 'varchar', length: 36 }) dailyLogId!: string;
  @PrimaryColumn({ type: 'integer' }) chunkNo!: number;
  @Column({ type: 'blob' }) content!: Buffer;
  @Column({ type: 'integer' }) compressedBytes!: number;
  @Column({ type: 'varchar', length: 64 }) sha256!: string;
}
