

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { TeamLeader } from './team-leader.entity';

/**
 * Agent identity.
 *
 * Agents belong to exactly one Team Leader and may have zero or one
 * assigned WhatsApp session.
 *
 * This entity belongs to the `main` database.
 */
@Entity('agents')
export class Agent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({
    type: 'varchar',
    length: 100,
  })
  name!: string;

  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  email!: string | null;

  /**
   * Owning Team Leader.
   *
   * This is a real foreign key because both Agent and TeamLeader live
   * in the same `main` database.
   */
  @Index()
  @Column({
    type: 'varchar',
    length: 36,
  })
  teamLeaderId!: string;

  @ManyToOne(
    () => TeamLeader,
    {
      nullable: false,
      onDelete: 'CASCADE',
    },
  )
  @JoinColumn({
    name: 'teamLeaderId',
  })
  teamLeader!: TeamLeader;

  /**
   * The Agent's currently assigned WhatsApp session.
   *
   * This cannot be a TypeORM/database relation because Session lives
   * in the separate `data` database.
   *
   * Authorization must always verify BOTH:
   *
   *   assignedSessionId === requested session ID
   *
   * and:
   *
   *   session.ownerTeamLeaderId === teamLeaderId
   */
  @Index()
  @Column({
    type: 'varchar',
    length: 36,
    nullable: true,
  })
  assignedSessionId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}


