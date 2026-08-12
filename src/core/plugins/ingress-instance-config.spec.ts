import { ConfigService } from '@nestjs/config';
import { HookManager } from '../hooks';
import { PluginSandboxBridge } from './plugin-sandbox-bridge';
import { PluginCapabilityContext } from './plugin-capability-context';
import { PluginHostServices } from './plugin-host-services';
import { PluginStorageService } from './plugin-storage.service';
import { PluginInstance as LoadedPlugin, PluginManifest, PluginStatus, PluginType } from './plugin.interfaces';
import { PluginWorkerHost } from './sandbox/plugin-worker-host';
import { PluginInstance as InstanceRow } from '../../modules/integration/entities/plugin-instance.entity';
import { IngressJobData } from '../../modules/queue/processors/ingress.processor';
import { createLogger } from '../../common/services/logger.service';

// Two enabled instances of ONE plugin may legitimately share a session scope. Provisioning projects
// each instance's config into a scope-keyed store, so the second write overwrites the first — which
// makes the scope an unusable key for resolving WHOSE credentials a delivery must run with. Dispatch
// is per-instance by definition and already holds the instance row, so these pin that the row, not
// the scope, decides the config a delivery is handled with.

const PLUGIN_ID = 'chat-adapter';
const SHARED_SCOPE = 'session-shared';

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: PLUGIN_ID,
    name: 'Chat Adapter',
    version: '1.0.0',
    type: PluginType.EXTENSION,
    main: 'index.js',
    ...overrides,
  };
}

function instanceRow(instanceId: string, config: Record<string, unknown> | null, scope: string | null): InstanceRow {
  return {
    id: `${PLUGIN_ID}:${instanceId}`,
    pluginId: PLUGIN_ID,
    instanceId,
    sessionScope: scope,
    secret: 'secret-' + instanceId,
    verifyToken: null,
    config,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function job(instanceId: string): IngressJobData {
  return {
    pluginId: PLUGIN_ID,
    instanceId,
    route: '/hook',
    deliveryId: 'delivery-' + instanceId,
    payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
  };
}

/** The one field of the worker payload these specs assert on. */
type WebhookCall = { config?: Record<string, unknown> };

/** Builds a bridge whose dispatch path is real; only the worker host and the instance store are fakes. */
function makeBridge(opts: {
  rows: InstanceRow[];
  baseConfig?: Record<string, unknown>;
  sessionConfig?: Record<string, Record<string, unknown>>;
  manifestOverrides?: Partial<PluginManifest>;
}): { bridge: PluginSandboxBridge; calls: WebhookCall[] } {
  const calls: WebhookCall[] = [];
  const dispatchWebhook = (payload: WebhookCall): Promise<{ ok: boolean; status: number }> => {
    calls.push(payload);
    return Promise.resolve({ ok: true, status: 200 });
  };
  const sandboxHosts = new Map<string, PluginWorkerHost>([
    [PLUGIN_ID, { dispatchWebhook } as unknown as PluginWorkerHost],
  ]);

  const plugins = new Map<string, LoadedPlugin>([
    [
      PLUGIN_ID,
      {
        manifest: manifest(opts.manifestOverrides),
        status: PluginStatus.ENABLED,
        config: opts.baseConfig ?? {},
        sessionConfig: opts.sessionConfig,
      } as unknown as LoadedPlugin,
    ],
  ]);

  const hostServices = {
    getPluginInstanceService: () => ({
      resolve: (pluginId: string, instanceId: string) =>
        Promise.resolve(opts.rows.find(r => r.pluginId === pluginId && r.instanceId === instanceId) ?? null),
    }),
  } as unknown as PluginHostServices;

  const bridge = new PluginSandboxBridge(
    createLogger('test'),
    new HookManager(),
    undefined as unknown as PluginCapabilityContext,
    hostServices,
    undefined as unknown as ConfigService,
    undefined as unknown as PluginStorageService,
    plugins,
    sandboxHosts,
    new Map(),
    '/plugins',
    (() => undefined) as never,
    () => '/plugins/index.js',
  );
  return { bridge, calls };
}

describe('ingress dispatch resolves config per INSTANCE, not per session scope', () => {
  it('hands each instance its own credentials when two instances share one session scope', async () => {
    const a = instanceRow('acct-a', { apiToken: 'token-A' }, SHARED_SCOPE);
    const b = instanceRow('acct-b', { apiToken: 'token-B' }, SHARED_SCOPE);
    // Provisioning wrote both to the same scope key; the second write won.
    const { bridge, calls } = makeBridge({
      rows: [a, b],
      sessionConfig: { [SHARED_SCOPE]: { apiToken: 'token-B' } },
    });

    await bridge.dispatchWebhookForInstance(job('acct-a'));

    expect(calls).toHaveLength(1);
    expect(calls[0].config).toEqual({ apiToken: 'token-A' });
  });

  it('hands the other instance ITS credentials from the same shared scope', async () => {
    const a = instanceRow('acct-a', { apiToken: 'token-A' }, SHARED_SCOPE);
    const b = instanceRow('acct-b', { apiToken: 'token-B' }, SHARED_SCOPE);
    const { bridge, calls } = makeBridge({
      rows: [a, b],
      sessionConfig: { [SHARED_SCOPE]: { apiToken: 'token-B' } },
    });

    await bridge.dispatchWebhookForInstance(job('acct-b'));

    expect(calls[0].config).toEqual({ apiToken: 'token-B' });
  });

  it('keeps plugin-level defaults underneath the instance override', async () => {
    const a = instanceRow('acct-a', { apiToken: 'token-A' }, SHARED_SCOPE);
    const { bridge, calls } = makeBridge({
      rows: [a],
      // Base carries schema-seeded defaults the instance row does not repeat.
      baseConfig: { apiToken: 'unset', endpoint: 'https://default.example', retries: 3 },
      sessionConfig: { [SHARED_SCOPE]: { apiToken: 'token-A' } },
    });

    await bridge.dispatchWebhookForInstance(job('acct-a'));

    expect(calls[0].config).toEqual({
      apiToken: 'token-A',
      endpoint: 'https://default.example',
      retries: 3,
    });
  });

  it('merges the instance config deeply, so a sparse override cannot drop a nested base key', async () => {
    const a = instanceRow('acct-a', { auth: { token: 'token-A' } }, SHARED_SCOPE);
    const { bridge, calls } = makeBridge({
      rows: [a],
      // `auth.region` exists only in the base; a shallow merge would delete it.
      baseConfig: { auth: { token: 'unset', region: 'eu-west-1' } },
    });

    await bridge.dispatchWebhookForInstance(job('acct-a'));

    expect(calls[0].config).toEqual({
      auth: { token: 'token-A', region: 'eu-west-1' },
    });
  });

  it('falls back to the base config when the instance row carries none', async () => {
    const a = instanceRow('acct-a', null, SHARED_SCOPE);
    const { bridge, calls } = makeBridge({
      rows: [a],
      baseConfig: { endpoint: 'https://default.example' },
    });

    await bridge.dispatchWebhookForInstance(job('acct-a'));

    expect(calls[0].config).toEqual({ endpoint: 'https://default.example' });
  });

  it('isolates instances of a plugin that is NOT session-scoped', async () => {
    // sessionScoped:false previously skipped the override entirely, so every instance of such a
    // plugin was dispatched with one shared config.
    const a = instanceRow('acct-a', { apiToken: 'token-A' }, null);
    const b = instanceRow('acct-b', { apiToken: 'token-B' }, null);
    const { bridge, calls } = makeBridge({
      rows: [a, b],
      baseConfig: { apiToken: 'token-B' },
      manifestOverrides: { sessionScoped: false },
    });

    await bridge.dispatchWebhookForInstance(job('acct-a'));

    expect(calls[0].config).toEqual({ apiToken: 'token-A' });
  });
});
