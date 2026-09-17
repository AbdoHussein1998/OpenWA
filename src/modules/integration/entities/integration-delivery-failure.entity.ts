import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';

// DLQ-of-record for both inbound (ingress) and outbound (provider egress) delivery failures.
// Generalizes webhook_delivery_failures. pluginId/instanceId/sessionId are durable provenance, not
// ownership FKs: deleting current configuration must not erase the payload/error record before its
// independent retention/redrive lifecycle has completed.
@Entity('integration_delivery_failures')
@Index('IDX_integration_delivery_failures_instance', ['pluginId', 'instanceId'])
@Index('IDX_integration_delivery_failures_sessionId', ['sessionId'])
export class IntegrationDeliveryFailure {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  direction!: 'inbound' | 'outbound';

  @Column({ type: 'varchar' })
  pluginId!: string;

  @Column({ type: 'varchar' })
  instanceId!: string;

  @Column({ type: 'varchar', nullable: true })
  sessionId!: string | null;

  @Column({ type: 'varchar', nullable: true })
  deliveryId!: string | null;

  @Column({ type: 'int' })
  attempts!: number;

  @Column({ type: 'text' })
  lastError!: string;

  @Column({ type: jsonColumnType(), nullable: true })
  payload!: Record<string, unknown> | null;

  @Column({ default: false })
  redriven!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
