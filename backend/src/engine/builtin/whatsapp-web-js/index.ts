/**
 * WhatsApp-web.js Engine Plugin
 * Built-in engine plugin that wraps the whatsapp-web.js library
 */

import { PluginContext, PluginType, IEnginePlugin } from '../../../core/plugins';
import { IWhatsAppEngine } from '../../interfaces/whatsapp-engine.interface';
import { WhatsAppWebJsAdapter } from '../../adapters/whatsapp-web-js.adapter';
import { LidMappingStore } from '../../identity/lid-mapping-store.service';
import { BrowserProfileManager } from '../../browser/browser-profile.manager';
import { BrowserManager } from '../../browser/browser.manager';
import { resolveBrowserSettings } from '../../browser/browser-config';
import { inspectWwebjsRuntime } from '../../adapters/wwebjs-runtime-compat';

export class WhatsAppWebJsPlugin implements IEnginePlugin {
  type = PluginType.ENGINE as const;
  private context?: PluginContext;

  // The engine config blob is also supplied at construction so createEngine has operator
  // config even if enablePlugin fails before onLoad runs (which would leave this.context unset).
  // The healthy path still prefers context.config (it carries any persisted-override merge).
  constructor(
    private readonly registeredConfig?: Record<string, unknown>,
    // Shared lid<->phone table, threaded to the adapter so it can persist learned phone->lid pairs
    // (mirrors how BaileysPlugin receives it; #583 R3).
    private readonly lidMappingStore?: LidMappingStore,
    private readonly browserManager: BrowserManager = new BrowserManager(),
  ) {}

  onLoad(context: PluginContext): Promise<void> {
    this.context = context;
    context.logger.log('WhatsApp-web.js engine plugin loaded');
    return Promise.resolve();
  }

  onEnable(context: PluginContext): Promise<void> {
    context.logger.log('WhatsApp-web.js engine plugin enabled');
    return Promise.resolve();
  }

  onDisable(context: PluginContext): Promise<void> {
    context.logger.log('WhatsApp-web.js engine plugin disabled');
    return Promise.resolve();
  }

  createEngine(config: Record<string, unknown>): IWhatsAppEngine {
    const sessionId = config.sessionId as string;
    const proxyUrl = config.proxyUrl as string | undefined;
    const proxyType =
      config.proxyType as 'http' | 'https' | 'socks4' | 'socks5' | undefined;

    // Browser config is this engine's OWN namespace, read from the opaque per-engine blob
    // supplied through context.config / registeredConfig.
    const engineConfig = (this.context?.config ?? this.registeredConfig ?? {}) as {
      sessionDataPath?: string;

      puppeteer?: {
        headless?: boolean;
        args?: string[];
        executablePath?: string;
        protocolTimeoutMs?: number;
      };

      brave?: {
        executablePath?: string;
        profileBasePath?: string;
      };
      browser?: {
        type?: unknown;
        executablePath?: string;
        profileBasePath?: string;
      };
    };

    const puppeteer = engineConfig.puppeteer ?? {};

    const sessionDataPath =
      engineConfig.sessionDataPath ?? './data/sessions';

    const headless =
      puppeteer.headless ?? true;

    const puppeteerArgs =
      puppeteer.args ?? ['--no-sandbox', '--disable-setuid-sandbox'];

    const executablePath =
      puppeteer.executablePath;

    const protocolTimeoutMs =
      puppeteer.protocolTimeoutMs;

    // The effective plugin config (context.config when present) is authoritative.
    // It must use exactly the same resolver as the direct fallback.
    const browserSettings = resolveBrowserSettings(engineConfig, {
      profileBasePath: '/data/brave-profiles',
      executablePath: '/usr/bin/brave',
    });
    const browserDriver = this.browserManager.getBrowser(browserSettings.type);
    const browserProfileManager = new BrowserProfileManager(
      browserSettings.profileBasePath, [browserDriver],
    );

    return new WhatsAppWebJsAdapter({
      sessionId,
      sessionDataPath,

      puppeteer: {
        headless,
        args: puppeteerArgs,
        executablePath,
        protocolTimeoutMs,
      },

      browser: browserSettings,
      browserDriver,
      browserProfileManager,

      // Legacy alias is retained for WwebjsStuckAuth (migrated in Phase 6).
      braveProfileManager: browserProfileManager,
      brave: browserSettings.type === 'brave' ? {
        executablePath: browserSettings.executablePath,
        profileBasePath: browserSettings.profileBasePath,
      } : undefined,

      proxy: proxyUrl
        ? {
            url: proxyUrl,
            type: proxyType ?? 'http',
          }
        : undefined,

      lidMappingStore: this.lidMappingStore,
    });
  }

  /**
   * Profile deletion must resolve the same effective root as createEngine().
   * In particular, context.config can include a persisted override that is
   * not visible through EngineFactory's base ConfigService snapshot.
   */
  getEffectiveProfileBasePath(): string {
    const engineConfig = (this.context?.config ?? this.registeredConfig ?? {}) as {
      browser?: { type?: unknown; executablePath?: string; profileBasePath?: string };
      brave?: { executablePath?: string; profileBasePath?: string };
      puppeteer?: { executablePath?: string };
    };
    return resolveBrowserSettings(engineConfig, {
      profileBasePath: '/data/brave-profiles',
      executablePath: '/usr/bin/brave',
    }).profileBasePath;
  }

  getFeatures(): string[] {
    return [
      'text-messages',
      'media-messages',
      'location-messages',
      'contact-messages',
      'group-management',
      'message-reactions',
      'message-replies',
      'message-forwarding',
      'message-deletion',
      'read-receipts',
      'typing-indicator',
      'labels',
      'channels',
      'status-updates',
      // No 'catalog': whatsapp-web.js has no catalog/product API, so the adapter 501s those methods —
      // advertising the feature here would promise clients a capability the engine cannot deliver.
    ];
  }

  getEngineLibrary(): { name: string; version: string } {
    // The actual whatsapp-web.js library version (e.g. 1.34.7), surfaced so operators can see which
    // engine version is really running — distinct from this adapter plugin's manifest version (1.0.0).
    let version = 'unknown';

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      version = (require('whatsapp-web.js/package.json') as { version: string }).version;
    } catch {
      // Keep 'unknown' if the package metadata can't be resolved at runtime.
    }

    return {
      name: 'whatsapp-web.js',
      version,
    };
  }

  healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    const runtime = inspectWwebjsRuntime();
    // Plugin compatibility is NOT proof of browser launch, linked-device login, or event delivery.
    // Only fail for a confirmed incompatible installed source, never missing/bundled metadata.
    const healthy = runtime.attachEventListenersMethod !== 'missing' &&
      runtime.messageIdNormalization !== 'missing';
    return Promise.resolve({
      healthy,
      message: healthy
        ? `whatsapp-web.js ${runtime.version}: plugin source appears compatible ` +
            `(bridge method: ${runtime.attachEventListenersMethod}, message IDs: ${runtime.messageIdNormalization}). ` +
            'Live session/browser/bridge health is verified separately.'
        : `whatsapp-web.js ${runtime.version}: installed source is missing a required method or ID normalization; ` +
            'check 1.34.8 install and postinstall patches.',
    });
  }
}

export default WhatsAppWebJsPlugin;


