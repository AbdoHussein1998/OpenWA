import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { bigintToNumberTransformer } from '../../message/entities/message.entity';
import { Session } from '../../session/entities/session.entity';

@Entity('status_updates')
@Index(['sessionId', 'contactJid'])
@Index(['sessionId', 'waStatusId'], { unique: true })
export class StatusUpdate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // varchar matches sessions.id in the data database on both supported dialects.
  @Column({ type: 'varchar' })
  sessionId!: string;

  /** Status/Story rows are Session-owned TTL data and cascade with the Session. */
  @ManyToOne(() => Session, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'sessionId' })
  session!: Session;

  /** Neutral @c.us / @lid JID of the contact who posted. */
  @Column()
  contactJid!: string;

  @Column({ nullable: true })
  contactName?: string;

  @Column({ nullable: true })
  contactPushName?: string;

  /** Engine status id, e.g. false_status@broadcast_<hash>. */
  @Column()
  waStatusId!: string;

  @Column()
  type!: 'text' | 'image' | 'video' | 'voice';

  @Column({ type: 'text', nullable: true })
  caption?: string;

  /** Relative path under the media store; null for text or omitted media. */
  @Column({ nullable: true })
  mediaPath?: string;

  @Column({ nullable: true })
  mediaMimetype?: string;

  @Column({ default: false })
  mediaOmitted!: boolean;

  /** 'over_cap' | 'engine_omitted' | 'write_failed' — null when media is present or type is text. */
  @Column({ nullable: true })
  omitReason?: string;

  @Column({ nullable: true })
  backgroundColor?: string;

  @Column({ type: 'int', nullable: true })
  font?: number;

  @Column({ type: 'bigint', transformer: bigintToNumberTransformer })
  postedAt!: number; // epoch ms

  @Column({ type: 'bigint', transformer: bigintToNumberTransformer })
  @Index()
  expiresAt!: number; // epoch ms
}
