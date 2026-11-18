import { getMetadataArgsStorage } from 'typeorm';
import { ConversationMapping } from './conversation-mapping.entity';
import { IngressEvent } from './ingress-event.entity';
import { IntegrationDeliveryFailure } from './integration-delivery-failure.entity';
import { PluginInstance } from './plugin-instance.entity';
import { Webhook } from '../../webhook/entities/webhook.entity';
import { WebhookDeliveryFailure } from '../../webhook/entities/webhook-delivery-failure.entity';
import { WebhookOutboxEvent } from '../../webhook/entities/webhook-outbox-event.entity';
import { Session } from '../../session/entities/session.entity';

function relationTargets(target: Function): Function[] {
  return getMetadataArgsStorage()
    .relations.filter(relation => relation.target === target)
    .map(relation => (typeof relation.type === 'function' ? (relation.type as () => Function)() : relation.type as unknown as Function));
}

describe('operational OLTP relation metadata', () => {
  it('keeps only real ownership relations and leaves provenance/configuration identifiers scalar', () => {
    const storage = getMetadataArgsStorage();

    const mappingRelations = storage.relations.filter(relation => relation.target === ConversationMapping);
    expect(mappingRelations).toHaveLength(1);
    expect(relationTargets(ConversationMapping)).toEqual([PluginInstance]);
    expect(mappingRelations[0].relationType).toBe('many-to-one');
    expect(mappingRelations[0].options.onDelete).toBe('CASCADE');

    const mappingJoinColumns = storage.joinColumns.filter(column => column.target === ConversationMapping);
    expect(mappingJoinColumns.map(column => [column.name, column.referencedColumnName])).toEqual(
      expect.arrayContaining([
        ['pluginId', 'pluginId'],
        ['instanceId', 'instanceId'],
      ]),
    );

    expect(relationTargets(PluginInstance)).not.toContain(Session);
    expect(relationTargets(IngressEvent)).toEqual([]);
    expect(relationTargets(IntegrationDeliveryFailure)).toEqual([]);
    expect(relationTargets(WebhookDeliveryFailure)).toEqual([]);
  });

  it('keeps the Webhook-owned outbox composite relation and the Webhook-owned Session relation', () => {
    const storage = getMetadataArgsStorage();
    const outboxRelations = storage.relations.filter(relation => relation.target === WebhookOutboxEvent);
    expect(outboxRelations).toHaveLength(1);
    expect(relationTargets(WebhookOutboxEvent)).toEqual([Webhook]);
    expect(outboxRelations[0].options.onDelete).toBe('CASCADE');

    const outboxJoinColumns = storage.joinColumns.filter(column => column.target === WebhookOutboxEvent);
    expect(outboxJoinColumns.map(column => [column.name, column.referencedColumnName])).toEqual(
      expect.arrayContaining([
        ['webhookId', 'id'],
        ['sessionId', 'sessionId'],
      ]),
    );

    expect(relationTargets(Webhook)).toContain(Session);
  });
});
