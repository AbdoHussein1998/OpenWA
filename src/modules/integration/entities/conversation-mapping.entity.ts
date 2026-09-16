import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';
import { Session } from '../../session/entities/session.entity';
import { PluginInstance } from './plugin-instance.entity';

export type HandoverState = 'bot' | 'human' | 'closed';
// Maps a WA chat to a provider conversation, both directions. This is active OLTP state: a mapping
// is valid only while both its Session and PluginInstance exist, so both parent references are real FKs.
@Entity('conversation_mappings')
@Index('UQ_conversation_mappings_forward', ['sessionId', 'chatId', 'pluginId', 'instanceId'], { unique: true })
@Index('UQ_conversation_mappings_reverse', ['pluginId', 'instanceId', 'providerConversationId'], { unique: true })
export class ConversationMapping {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
  @Column({ type: 'varchar' })
  sessionId!: string;

  @ManyToOne(() => Session, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId' })
  session?: Session;

  @Column()
  chatId!: string;

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

  @Column()
  providerConversationId!: string;

  @Column({ default: 'bot' })
  handoverState!: HandoverState;

  @Column({ type: jsonColumnType(), nullable: true })
  metadata!: Record<string, unknown> | null;

  @UpdateDateColumn()
  updatedAt!: Date;
}
