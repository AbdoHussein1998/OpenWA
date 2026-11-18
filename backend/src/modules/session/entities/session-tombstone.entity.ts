import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

import { DateTransformer } from '../../../common/transformers/date.transformer';
import { dateColumnType } from '../../../common/utils/column-types';

/**
 * Minimal durable identity for a physically deleted WhatsApp Session.
 *
 * Messages and message batches deliberately survive Session deletion. Their scalar session id remains
 * historical provenance, while this row preserves the tenant owner and display name required to
 * authorize and explain that history after the live runtime/configuration row is gone.
 *
 * There is intentionally NO foreign key back to sessions: the whole purpose of this table is to
 * outlive that row. A restored live Session with the same UUID is authoritative at read time; callers
 * must consult the tombstone only after confirming that no live Session exists.
 */
@Entity('session_tombstones')
@Index('IDX_session_tombstones_ownerTeamLeaderId', ['ownerTeamLeaderId'])
export class SessionTombstone {
  @PrimaryColumn({ type: 'varchar' })
  sessionId!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'varchar', nullable: true })
  ownerTeamLeaderId!: string | null;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  deletedAt!: Date;
}
