
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
import { BraveProfileManager } from './brave/brave-profile.manager';

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

      return;
    }

    const braveProfileBasePath =
      this.configService
        .get<string>(
          'engine.brave.profileBasePath',
        ) ??
      '/data/brave-profiles';

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
            'brave',

          dir:
            new BraveProfileManager(
              braveProfileBasePath,
            ).getProfilePath(
              sessionName,
            ),
        },
      ];

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

      brave: {
        executablePath:
          this.configService
            .get<string>(
              'engine.brave.executablePath',
            ) ??
          this.configService
            .get<string>(
              'engine.puppeteer.executablePath',
            ) ??
          '/usr/bin/brave',

        profileBasePath:
          this.configService
            .get<string>(
              'engine.brave.profileBasePath',
            ) ??
          '/data/brave-profiles',
      },

      braveProfileManager:
        new BraveProfileManager(
          this.configService
            .get<string>(
              'engine.brave.profileBasePath',
            ) ??
            '/data/brave-profiles',
        ),

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
