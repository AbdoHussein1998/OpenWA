import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  JoinColumn,
  ManyToOne,
} from 'typeorm';

import { Agent } from '../../teamleader/entities/agent.entity';
import { TeamLeader } from '../../teamleader/entities/team-leader.entity';

export enum ApiKeyRole {
  ADMIN = 'admin',
  OPERATOR = 'operator',
  VIEWER = 'viewer',
  TEAM_LEADER = 'team_leader',
  AGENT = 'agent',
}

@Entity('api_keys')
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  keyHash!: string;

  // 12 to fit the 12-char prefix that auth.service writes.
  @Column({ type: 'varchar', length: 12 })
  keyPrefix!: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: ApiKeyRole.OPERATOR,
  })
  role!: ApiKeyRole;

  /**
   * Durable identity of the installation's primary/bootstrap administrative
   * credential.
   *
   * This flag is intentionally independent from name and current role so an
   * Operator cannot bypass primary-key deletion protection by renaming or
   * demoting the credential first. AuthService guarantees that, while at least
   * one ADMIN key exists, one row is selected as the primary administrative
   * anchor.
   */
  @Index('IDX_api_keys_isPrimaryAdminKey')
  @Column({ type: 'boolean', default: false })
  isPrimaryAdminKey!: boolean;

  /**
   * Principal binding for TEAM_LEADER API keys.
   *
   * Must be non-null only when role === TEAM_LEADER.
   */
  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true })
  teamLeaderId!: string | null;

  @ManyToOne(
    () => TeamLeader,
    {
      nullable: true,
      onDelete: 'CASCADE',
    },
  )
  @JoinColumn({
    name: 'teamLeaderId',
  })
  teamLeader!: TeamLeader | null;

  /**
   * Principal binding for AGENT API keys.
   *
   * Must be non-null only when role === AGENT.
   */
  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true })
  agentId!: string | null;

  @ManyToOne(
    () => Agent,
    {
      nullable: true,
      onDelete: 'CASCADE',
    },
  )
  @JoinColumn({
    name: 'agentId',
  })
  agent!: Agent | null;

  @Column({ type: 'simple-array', nullable: true })
  allowedIps!: string[] | null;

  @Column({ type: 'simple-array', nullable: true })
  allowedSessions!: string[] | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'datetime', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'datetime', nullable: true })
  lastUsedAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  usageCount!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
