import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';
import { Session } from '../../session/entities/session.entity';
// One configured instance of an adapter plugin (e.g. one Chatwoot account). instanceId is namespaced
// under pluginId; NOT a separate worker. Secret is host-minted and masked-on-read.
@Entity('plugin_instances')
@Index('UQ_plugin_instances_plugin_instance', ['pluginId', 'instanceId'], { unique: true })
@Index('IDX_plugin_instances_sessionScope', ['sessionScope'])
export class PluginInstance {
  @PrimaryColumn()
  id!: string; // `${pluginId}:${instanceId}`

  @Column()
  pluginId!: string;

  @Column()
  instanceId!: string;

  @Column({ type: 'varchar', nullable: true })
  sessionScope!: string | null; // resolved session id this instance acts on; null = inherit manifest.sessions

  /**
   * A concrete scope is a real Session relation. Deleting that Session is RESTRICTED while the
   * instance still points at it: SET NULL would silently broaden/change the persisted scope and CASCADE
   * would bypass ScopeBindingService's runtime teardown. Re-scope/delete the instance explicitly.
   * Legacy '*' wildcard writes are normalized to NULL by PluginInstanceService and the migration.
   */
  @ManyToOne(() => Session, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sessionScope' })
  session?: Session | null;

  @Column()
  secret!: string; // host-minted ingress HMAC secret; stored plaintext, masked to '***' on API reads
  // (via PluginInstanceService.maskedView + the provisioning controller's reveal flag), exposed
  // in full only on mint and regenerate-secret. Note: instance `config` is NOT secret-redacted.
  @Column({ type: 'varchar', nullable: true })
  verifyToken!: string | null; // optional provider challenge token

  @Column({ type: jsonColumnType(), nullable: true })
  config!: Record<string, unknown> | null;

  @Column({ default: true })
  enabled!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
