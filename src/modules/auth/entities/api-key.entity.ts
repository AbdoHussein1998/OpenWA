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

  // 12 to fit the 12-char prefix that auth.service writes (was varchar(8); harmless on the
  // hardcoded-SQLite `main` connection, but kept consistent with the code).
  @Column({ type: 'varchar', length: 12 })
  keyPrefix!: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: ApiKeyRole.OPERATOR,
  })
  role!: ApiKeyRole;

  /**
   * Principal binding for TEAM_LEADER API keys.
   *
   * Must be non-null only when role === TEAM_LEADER.
   * The main-database migration adds the FK to team_leaders.id.
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
   * The main-database migration adds the FK to agents.id.
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
