import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';
import { Session } from '../../session/entities/session.entity';
import { PluginInstance } from './plugin-instance.entity';
// DLQ-of-record for both inbound (ingress) and outbound (provider egress) delivery failures.
// A failure is operationally owned by its PluginInstance; when sessionId is concrete it also points
// to a live Session. Both references are enforced so redrive state cannot become orphaned.
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

  @ManyToOne(() => PluginInstance, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'pluginId', referencedColumnName: 'pluginId' },
    { name: 'instanceId', referencedColumnName: 'instanceId' },
  ])
  pluginInstance?: PluginInstance;

  @Column({ type: 'varchar', nullable: true })
  sessionId!: string | null;

  @ManyToOne(() => Session, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session?: Session | null;

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
