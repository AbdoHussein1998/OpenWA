
// src/engine/engine.factory.ts

import * as fs from 'fs';
import * as path from 'path';
import {
  Injectable,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { IWhatsAppEngine } from './interfaces/whatsapp-engine.interface';
import { WhatsAppWebJsAdapter } from './adapters/whatsapp-web-js.adapter';
import { BrowserManager } from './browser/browser.manager';
import { BrowserProfileManager } from './browser/browser-profile.manager';
import { resolveBrowserSettings } from './browser/browser-config';

import {
  PluginLoaderService,
  PluginType,
  IEnginePlugin,
  PluginManifest,
} from '../core/plugins';

import { WhatsAppWebJsPlugin } from './builtin/whatsapp-web-js';
import { BaileysPlugin } from './builtin/baileys';

import { createLogger } from '../common/services/logger.service';

import { BaileysMessageStoreService } from './adapters/baileys-message-store.service';
import { LidMappingStoreService } from './identity/lid-mapping-store.service';

import { isSafeSessionName } from '../common/utils/path-safety';
import { ensurePrivateDir } from '../common/utils/private-dir.util';

export interface EngineCreateOptions {
  /**
   * Session NAME — the on-disk auth-directory key.
   */
  sessionId: string;

  /**
   * Session UUID — the DB-row key for FK-bound stores.
   */
  dbSessionId: string;

  proxyUrl?: string;

  proxyType?:
    | 'http'
    | 'https'
    | 'socks4'
    | 'socks5';
}

@Injectable()
export class EngineFactory
  implements OnModuleInit
{
  private readonly logger =
    createLogger(
      'EngineFactory',
    );

  private readonly engineType:
    string;

  constructor(
    private readonly configService:
      ConfigService,

    private readonly pluginLoader:
      PluginLoaderService,

    private readonly baileysMessageStore:
      BaileysMessageStoreService,

    private readonly lidMappingStore:
      LidMappingStoreService,

    private readonly browserManager: BrowserManager = new BrowserManager(),
  ) {
    this.engineType =
      this.configService
        .get<string>(
          'engine.type',
        ) ??
      'whatsapp-web.js';
  }

  async onModuleInit():
    Promise<void> {
    await this
      .registerBuiltInEngines();
  }

  private async registerBuiltInEngines():
    Promise<void> {
    const engineConfig =
      this.configService
        .get<
          Record<
            string,
            unknown
          >
        >(
          'engine',
        ) ??
      {};

    const wwjsManifest:
      PluginManifest = {
        id:
          'whatsapp-web.js',

        name:
          'WhatsApp Web.js Engine',

        version:
          '1.0.0',

        type:
          PluginType.ENGINE,

        description:
          'Official WhatsApp-web.js engine adapter',

        main:
          'index.ts',

        provides: [
          'whatsapp-engine',
        ],
      };

    const wwjsPlugin =
      new WhatsAppWebJsPlugin(
        engineConfig,
        this.lidMappingStore,
        this.browserManager,
      );

    this.pluginLoader
      .registerBuiltInPlugin(
        wwjsManifest,
        wwjsPlugin,
        engineConfig,
      );

    const baileysManifest:
      PluginManifest = {
        id:
          'baileys',

        name:
          'Baileys Engine',

        version:
          '1.0.0',

        type:
          PluginType.ENGINE,

        description:
          'Baileys (WebSocket, no-browser) engine adapter',

        main:
          'index.ts',

        provides: [
          'whatsapp-engine',
        ],
      };

    this.pluginLoader
      .registerBuiltInPlugin(
        baileysManifest,

        new BaileysPlugin(
          this.baileysMessageStore,
          engineConfig,
          this.lidMappingStore,
        ),

        engineConfig,
      );

    try {
      await this.pluginLoader
        .enablePlugin(
          this.engineType,
        );

      this.logger.log(
        `Engine plugin enabled: ${this.engineType}`,
        {
          action:
            'engine_enabled',

          engineType:
            this.engineType,
        },
      );
    } catch (error) {
      this.logger.error(
        `Failed to enable engine plugin: ${this.engineType}`,

        error instanceof
          Error
          ? error.message
          : String(
              error,
            ),

        {
          action:
            'engine_enable_failed',
        },
      );
    }
  }

  create(
    options:
      EngineCreateOptions,
  ):
    IWhatsAppEngine {
    if (
      !isSafeSessionName(
        options.sessionId,
      )
    ) {
      throw new Error(
        `Refusing to create an engine for an unsafe session name: ${JSON.stringify(
          options.sessionId,
        )}`,
      );
    }

    /*
     * Ensure both engine credential directory shapes exist with
     * private permissions.
     */
    ensurePrivateDir(
      this.wwjsAuthDir(
        options.sessionId,
      ),
    );

    ensurePrivateDir(
      this.baileysAuthDir(
        options.sessionId,
      ),
    );

    const enginePlugin =
      this.pluginLoader
        .getPlugin(
          this.engineType,
        );

    if (
      enginePlugin
        ?.instance &&
      this.isEnginePlugin(
        enginePlugin.instance,
      )
    ) {
      return enginePlugin
        .instance
        .createEngine({
          sessionId:
            options.sessionId,

          dbSessionId:
            options.dbSessionId,

          proxyUrl:
            options.proxyUrl,

          proxyType:
            options.proxyType,
        }) as IWhatsAppEngine;
    }

    this.logger.warn(
      `Engine plugin ${this.engineType} not available, using fallback`,
      {
        action:
          'engine_fallback',
      },
    );

    return this
      .createFallbackEngine(
        options,
      );
  }

  /**
   * Remove all persistent credential/store directories belonging to a session.
   *
   * Both engine shapes are removed because ENGINE_TYPE may change between
   * deployments, and a previously used engine may still have credentials on disk.
   */
  async purgeSessionData(
    sessionName: string,
  ):
    Promise<void> {
    if (
      !isSafeSessionName(
        sessionName,
      )
    ) {
      this.logger.warn(
        'Refusing to purge session data for an unsafe session name',
        {
          action:
            'engine_purge_unsafe',

          sessionName:
            JSON.stringify(
              sessionName,
            ),
        },
      );

      throw new Error('Refusing to purge session data with unsafe session name');
    }

    // A built-in plugin can hold an effective persisted override (context.config)
    // different from ConfigService. Use the plugin's actual profile root to
    // prevent deleting credentials from a different on-disk location.
    const wwjsPlugin = this.pluginLoader.getPlugin('whatsapp-web.js')?.instance;
    const browserProfileBasePath = wwjsPlugin instanceof WhatsAppWebJsPlugin
      ? wwjsPlugin.getEffectiveProfileBasePath()
      : (this.configService.get<string>('engine.browser.profileBasePath') ??
         this.configService.get<string>('engine.brave.profileBasePath') ??
         '/data/brave-profiles');
    const profileManager = new BrowserProfileManager(browserProfileBasePath);

    // Credential deletion cannot race a peer's live browser or a crashed owner whose state
    // has not been verified. Check BEFORE deleting any engine directory, not after a partial purge.
    await profileManager.assertProfileUnlocked(sessionName);
    // An unmarked or externally launched browser may use the same profile even
    // without our filesystem lease. Refuse ALL credential deletion unless the
    // OS process scan can verify that no browser still uses this profile.
    // SessionLifecycleFences separately prevents same-process start/delete races.
    await profileManager.assertNoConflictingBrowserProcesses(sessionName, this.logger);
    // Recheck after the (potentially slow) OS scan: a competing owner may have
    // acquired a lease in the meantime. A distributed, atomic purge barrier is
    // still a separate hardening concern for the final acceptance phase.
    await profileManager.assertProfileUnlocked(sessionName);

    const dirs:
      Array<{
        engine: string;
        dir: string;
      }> = [
        {
          engine:
            'whatsapp-web.js',

          dir:
            this.wwjsAuthDir(
              sessionName,
            ),
        },

        {
          engine:
            'baileys',

          dir:
            this.baileysAuthDir(
              sessionName,
            ),
        },

        {
          engine:
            'browser',

          dir:
            profileManager.getProfilePath(
              sessionName,
            ),
        },
      ];

    const failures: string[] = [];
    for (
      const {
        engine,
        dir,
      }
      of dirs
    ) {
      try {
        await fs.promises
          .rm(
            dir,
            {
              recursive:
                true,

              force:
                true,
            },
          );

        // fs.rm(force) can return successfully for an absent directory, which is fine; it must
        // NEVER return success while any credential-bearing directory remains on disk.
        try {
          await fs.promises.lstat(dir);
          throw new Error('Credential directory still exists after purge');
        } catch (checkError) {
          if ((checkError as NodeJS.ErrnoException).code !== 'ENOENT') throw checkError;
        }
        this.logger.log(
          'Purged session auth directory',
          {
            action:
              'engine_purge',

            engine,

            sessionName,

            dir,
          },
        );
      } catch (error) {
        failures.push(`${engine}: ${error instanceof Error ? error.message : String(error)}`);
        this.logger.warn(
          'Failed to purge session auth directory',
          {
            action:
              'engine_purge_failed',

            engine,

            sessionName,

            dir,

            error:
              error instanceof
                Error
                ? error.message
                : String(
                    error,
                  ),
          },
        );
      }
    }
    if (failures.length > 0) {
      // Do not release a database name while its old WhatsApp linked-device identity survives.
      throw new Error(`Credential purge incomplete: ${failures.join('; ')}`);
    }
  }

  /**
   * whatsapp-web.js auth directory.
   */
  private wwjsAuthDir(
    sessionName: string,
  ):
    string {
    const sessionDataPath =
      this.configService
        .get<string>(
          'engine.sessionDataPath',
        ) ??
      './data/sessions';

    return path.join(
      path.resolve(
        sessionDataPath,
      ),
      `session-${sessionName}`,
    );
  }

  /**
   * Baileys auth directory.
   */
  private baileysAuthDir(
    sessionName: string,
  ):
    string {
    const authDir =
      this.configService
        .get<string>(
          'engine.baileys.authDir',
        ) ??
      './data/baileys';

    return path.join(
      authDir,
      sessionName,
    );
  }

  private isEnginePlugin(
    instance:
      unknown,
  ):
    instance is
      IEnginePlugin {
    return (
      typeof instance ===
        'object' &&
      instance !==
        null &&
      'type' in
        instance &&
      instance.type ===
        PluginType.ENGINE &&
      'createEngine' in
        instance &&
      typeof (
        instance as {
          createEngine:
            unknown;
        }
      ).createEngine ===
        'function'
    );
  }

  private createFallbackEngine(
    options:
      EngineCreateOptions,
  ):
    IWhatsAppEngine {
    if (
      this.engineType !==
      'whatsapp-web.js'
    ) {
      throw new Error(
        `Engine '${this.engineType}' is unavailable and has no direct fallback; cannot start the session.`,
      );
    }

    // Resolve the browser from the same configuration contract as the plugin.
    // Keep legacy Brave/Puppeteer setting precedence and the existing profile root.
    const browserSettings = resolveBrowserSettings({
      browser: {
        type: this.configService.get<unknown>('engine.browser.type'),
        executablePath: this.configService.get<string>('engine.browser.executablePath'),
        profileBasePath: this.configService.get<string>('engine.browser.profileBasePath'),
      },
      brave: {
        executablePath: this.configService.get<string>('engine.brave.executablePath'),
        profileBasePath: this.configService.get<string>('engine.brave.profileBasePath'),
      },
      puppeteer: {
        executablePath: this.configService.get<string>('engine.puppeteer.executablePath'),
      },
    }, { profileBasePath: '/data/brave-profiles', executablePath: '/usr/bin/brave' });
    const browserDriver = this.browserManager.getBrowser(browserSettings.type);
    const browserProfileManager = new BrowserProfileManager(
      browserSettings.profileBasePath, [browserDriver],
    );

    return new WhatsAppWebJsAdapter({
      sessionId:
        options.sessionId,

      sessionDataPath:
        this.configService
          .get<string>(
            'engine.sessionDataPath',
          ) ??
        './data/sessions',

      puppeteer: {
        headless:
          this.configService
            .get<boolean>(
              'engine.puppeteer.headless',
            ) ??
          true,

        args:
          this.configService
            .get<string[]>(
              'engine.puppeteer.args',
            ) ??
          [
            '--no-sandbox',
            '--disable-setuid-sandbox',
          ],

        executablePath:
          this.configService
            .get<string>(
              'engine.puppeteer.executablePath',
            ),

        protocolTimeoutMs:
          this.configService
            .get<number>(
              'engine.puppeteer.protocolTimeoutMs',
            ),
      },

      browser: browserSettings,
      browserDriver,
      browserProfileManager,
      // Deprecated alias retained for direct adapter compatibility; Phase 6 uses the neutral manager.
      braveProfileManager: browserProfileManager,
      brave: browserSettings.type === 'brave' ? {
        executablePath: browserSettings.executablePath,
        profileBasePath: browserSettings.profileBasePath,
      } : undefined,

      proxy:
        options.proxyUrl
          ? {
              url:
                options.proxyUrl,

              type:
                options.proxyType ??
                'http',
            }
          : undefined,

      lidMappingStore:
        this.lidMappingStore,
    });
  }

  // ============================================================================
  // Query Methods for API/Dashboard
  // ============================================================================

  getAvailableEngines():
    Array<{
      id: string;
      name: string;
      enabled: boolean;
      features: string[];

      library?: {
        name: string;
        version: string;
      };
    }> {
    const enginePlugins =
      this.pluginLoader
        .getPluginsByType(
          PluginType.ENGINE,
        );

    return enginePlugins
      .map(
        plugin => {
          const inst =
            plugin.instance;

          const features =
            inst &&
            this.isEnginePlugin(
              inst,
            )
              ? inst
                  .getFeatures()
              : [];

          const library =
            inst &&
            this.isEnginePlugin(
              inst,
            )
              ? inst
                  .getEngineLibrary?.()
              : undefined;

          return {
            id:
              plugin.manifest.id,

            name:
              plugin.manifest.name,

            enabled:
              this.pluginLoader
                .isPluginEnabled(
                  plugin.manifest.id,
                ),

            features,

            library,
          };
        },
      );
  }

  getCurrentEngine():
    string {
    return this.engineType;
  }
}
