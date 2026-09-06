
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

  @Index({ unique: true })
  @Column({
    type: 'varchar',
    length: 255,
  })
  email!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}


