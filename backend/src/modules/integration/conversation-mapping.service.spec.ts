import { DataSource } from 'typeorm';
import { ConversationMapping } from './entities/conversation-mapping.entity';
import { PluginInstance } from './entities/plugin-instance.entity';
import { ConversationMappingConflict, ConversationMappingService, MappingKey } from './conversation-mapping.service';
import { AddIntegrationFabric1781900000000 } from '../../database/migrations/1781900000000-AddIntegrationFabric';

describe('ConversationMappingService', () => {
  let ds: DataSource;
  let service: ConversationMappingService;

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      // PluginInstance is the only real relation target. Session is intentionally NOT registered:
      // sessionId is stale-repairable provenance rather than Session ownership.
      entities: [ConversationMapping, PluginInstance],
      migrations: [],
    });
    await ds.initialize();
    const runner = ds.createQueryRunner();
    await new AddIntegrationFabric1781900000000().up(runner);
    await runner.release();
    service = new ConversationMappingService(ds.getRepository(ConversationMapping));
  });

  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
  });

  const key: MappingKey = { sessionId: 'sess-1', chatId: 'chat-1', pluginId: 'chatwoot', instanceId: 'acct1' };

  it('upserts a mapping then get(forwardKey) returns it with a non-empty id', async () => {
    await service.upsert(key, 'conv-1');
    const found = await service.get(key);
    expect(found).not.toBeNull();
    expect(found?.id).toEqual(expect.any(String));
    expect(found?.id.length).toBeGreaterThan(0);
    expect(found?.providerConversationId).toBe('conv-1');
  });

  it('getByProvider reverse lookup returns the same row', async () => {
    await service.upsert(key, 'conv-1');
    const forward = await service.get(key);
    const reverse = await service.getByProvider(key.pluginId, key.instanceId, 'conv-1');
    expect(reverse).not.toBeNull();
    expect(reverse?.id).toBe(forward?.id);
  });

  it('upserting again on the same forward key updates providerConversationId instead of inserting a duplicate', async () => {
    await service.upsert(key, 'conv-1');
    const first = await service.get(key);
    await service.upsert(key, 'conv-2');
    const second = await service.get(key);
    expect(second?.id).toBe(first?.id);
    expect(second?.providerConversationId).toBe('conv-2');
    const stale = await service.getByProvider(key.pluginId, key.instanceId, 'conv-1');
    expect(stale).toBeNull();
  });

  it('rethrows ConversationMappingConflict when a providerConversationId is already bound to a different chat', async () => {
    await service.upsert(key, 'conv-1');
    await expect(
      service.upsert({ sessionId: 'sess-1', chatId: 'chat-2', pluginId: 'chatwoot', instanceId: 'acct1' }, 'conv-1'),
    ).rejects.toBeInstanceOf(ConversationMappingConflict);
  });

  it('converges (updates, does not throw) when the same forward key already exists', async () => {
    await service.upsert(key, 'conv-1');
    await expect(service.upsert(key, 'conv-9')).resolves.toBeUndefined();
    expect((await service.get(key))?.providerConversationId).toBe('conv-9');
  });

  it('findHandoverForChat returns any human/closed row for the chat, ignoring pluginId', async () => {
    await service.upsert({ sessionId: 'sess-1', chatId: 'chat-1', pluginId: 'faq-bot', instanceId: 'i1' }, 'convA');
    await service.upsert(
      { sessionId: 'sess-1', chatId: 'chat-1', pluginId: 'chatwoot-adapter', instanceId: 'i2' },
      'convB',
      { handoverState: 'human' },
    );
    expect(await service.findHandoverForChat('sess-1', 'chat-1')).toEqual({
      pluginId: 'chatwoot-adapter',
      handoverState: 'human',
    });
    expect(await service.findHandoverForChat('sess-1', 'other-chat')).toBeNull();
  });

  it('delete removes the row so a later reverse-key insert no longer conflicts', async () => {
    await service.upsert(key, 'conv-1');
    const row = await service.get(key);
    if (!row) throw new Error('expected a mapping row');
    await service.delete(row.id);
    expect(await service.get(key)).toBeNull();
    await expect(
      service.upsert({ sessionId: 'sess-2', chatId: 'chat-2', pluginId: 'chatwoot', instanceId: 'acct1' }, 'conv-1'),
    ).resolves.toBeUndefined();
  });

  it('rebindSession moves an existing row onto another Session even when the old Session no longer exists', async () => {
    await service.upsert(key, 'conv-1');
    const row = await service.get(key);
    if (!row) throw new Error('expected a mapping row');
    await service.rebindSession(row.id, 'sess-2');
    expect(await service.get(key)).toBeNull();
    const rebound = await service.getByProvider(key.pluginId, key.instanceId, 'conv-1');
    expect(rebound?.sessionId).toBe('sess-2');
    expect(
      await service.get({ sessionId: 'sess-2', chatId: 'chat-1', pluginId: 'chatwoot', instanceId: 'acct1' }),
    ).not.toBeNull();
  });

  it('rebindSession supersedes the old row when the destination session already owns the chat', async () => {
    await service.upsert(key, 'conv-1');
    await service.upsert(
      { sessionId: 'sess-2', chatId: 'chat-1', pluginId: 'chatwoot', instanceId: 'acct1' },
      'conv-2',
    );
    const stale = await service.get(key);
    if (!stale) throw new Error('expected a mapping row');
    await service.rebindSession(stale.id, 'sess-2');
    expect(await service.getByProvider('chatwoot', 'acct1', 'conv-1')).toBeNull();
    expect((await service.getByProvider('chatwoot', 'acct1', 'conv-2'))?.sessionId).toBe('sess-2');
  });
});
