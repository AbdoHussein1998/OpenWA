import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';

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

  /**
   * Runtime configuration scope, not relational ownership.
   *
   * A concrete value may temporarily name a Session that is absent; ScopeBindingService deliberately
   * preserves that binding and warns because restoring/re-importing the same Session id makes the
   * configuration valid again. ScopeBindingService already treats NULL/empty and '*' as the wildcard
   * runtime branch; '*' remains the explicit sentinel accepted by existing provisioning/API callers.
   *
   * Therefore this column is indexed for lookup but intentionally has no sessions(id) foreign key.
   */
  @Column({ type: 'varchar', nullable: true })
  sessionScope!: string | null;

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
