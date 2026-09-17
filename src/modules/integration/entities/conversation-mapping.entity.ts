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
import { PluginInstance } from './plugin-instance.entity';

export type HandoverState = 'bot' | 'human' | 'closed';

// Maps a WA chat to a provider conversation, both directions.
//
// sessionId is repairable provenance, not Session ownership: a mapping may outlive a Session and
// ConversationMappingService.rebindSession() deliberately moves the stale row when that Session is
// recreated/re-paired under another id. Enforcing sessions(id) here would delete the row that the
// recovery path needs.
//
// pluginId + instanceId, however, identify the configured integration instance that owns this active
// mapping. Retiring that exact PluginInstance retires its mappings as well.
@Entity('conversation_mappings')
@Index('UQ_conversation_mappings_forward', ['sessionId', 'chatId', 'pluginId', 'instanceId'], { unique: true })
@Index('UQ_conversation_mappings_reverse', ['pluginId', 'instanceId', 'providerConversationId'], { unique: true })
export class ConversationMapping {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  sessionId!: string;

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
