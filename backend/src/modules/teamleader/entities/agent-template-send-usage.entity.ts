


import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Agent } from './agent.entity';

/**
 * Lifecycle state for one template-send quota reservation.
 *
 * RESERVED counts against the quota immediately so concurrent requests
 * cannot all observe the same remaining slot.
 *
 * CONSUMED means the stored-template send completed successfully.
 */
export enum AgentTemplateSendUsageStatus {
  RESERVED = 'reserved',
  CONSUMED = 'consumed',
}

/**
 * One rolling-24h quota record for an Agent stored-template send.
 *
 * This entity belongs to the `main` database because Agent principals and
 * their quota configuration also live there.
 *
 * Session is intentionally represented by sessionId only. Session lives in
 * the separate `data` database, so there must not be a TypeORM relation/FK
 * from this entity to Session.
 */
@Index(
  'IDX_agent_template_send_usage_agent_status_consumed_at',
  ['agentId', 'status', 'consumedAt'],
)
@Index(
  'IDX_agent_template_send_usage_agent_status_reservation_expires_at',
  ['agentId', 'status', 'reservationExpiresAt'],
)
@Entity('agent_template_send_usage')
export class AgentTemplateSendUsage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Agent whose quota this record consumes.
   */
  @Column({
    type: 'varchar',
    length: 36,
  })
  agentId!: string;

  @ManyToOne(
    () => Agent,
    {
      nullable: false,
      onDelete: 'CASCADE',
    },
  )
  @JoinColumn({
    name: 'agentId',
  })
  agent!: Agent;

  /**
   * Session targeted by the stored-template send.
   *
   * This is informational/audit context only; authorization remains the
   * responsibility of SessionTenantAccessService before the controller runs.
   */
  @Column({
    type: 'varchar',
    length: 36,
  })
  sessionId!: string;

  @Column({
    type: 'varchar',
    length: 16,
    default: AgentTemplateSendUsageStatus.RESERVED,
  })
  status!: AgentTemplateSendUsageStatus;

  /**
   * Safety lease for an in-flight reservation.
   *
   * A process crash between reservation and send completion must not block an
   * Agent's quota for the entire 24-hour window. The quota service removes
   * expired RESERVED rows before making a new reservation.
   *
   * CONSUMED rows set this field back to null.
   */
  @Column({
    type: 'datetime',
    nullable: true,
  })
  reservationExpiresAt!: Date | null;

  /**
   * Set when the stored-template send succeeds.
   *
   * CONSUMED rows use consumedAt as the exact rolling-24h window anchor.
   * RESERVED rows count immediately only while their reservation lease is live.
   */
  @Column({
    type: 'datetime',
    nullable: true,
  })
  consumedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}





