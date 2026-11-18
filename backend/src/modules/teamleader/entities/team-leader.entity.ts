


import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Team Leader identity.
 *
 * This entity belongs to the `main` database because it represents
 * authentication/authorization identity rather than WhatsApp session data.
 *
 * Credentials are NOT stored here. API credentials are owned by the
 * api_keys table and linked through ApiKey.teamLeaderId.
 */
@Entity('team_leaders')
export class TeamLeader {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({
    type: 'varchar',
    length: 100,
  })
  name!: string;

  /**
   * Email is optional.
   *
   * Non-null values remain unique, while multiple Team Leaders may have
   * NULL email values.
   *
   * The database migration that accompanies this entity change must alter
   * the existing email column from NOT NULL to nullable without removing
   * the unique index.
   */
  @Index({ unique: true })
  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  email!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}


