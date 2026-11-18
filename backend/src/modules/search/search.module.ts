import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchProviderRegistry } from './search-provider.registry';
import { BuiltInFtsProvider } from './providers/builtin-fts.provider';

import { PLUGIN_SEARCH_REGISTRY_PORT } from '../../core/plugins/plugin-host-ports';

import { AccessControlModule } from '../access-control/access-control.module';

/**
 * Wires the global search feature:
 *
 * - SearchController
 * - SearchService
 * - SearchProviderRegistry
 * - BuiltInFtsProvider
 *
 * SEARCH_PROVIDER=none keeps the route mounted but registers no provider,
 * causing SearchService.search() to return the existing 501 behavior.
 *
 * SEARCH_ENABLED=false is handled by AppModule and omits this module
 * entirely, leaving /search unavailable.
 *
 * Phase H:
 * AccessControlModule is imported so SearchController can obtain
 * SessionTenantAccessService and calculate the authenticated caller's
 * effective SessionScope before executing an aggregate/global search.
 */
export function bootstrapSearchProviders(
  registry: SearchProviderRegistry,
  builtin: BuiltInFtsProvider,
  cfg: ConfigService,
): SearchProviderRegistry {
  const provider = cfg.get<string>('search.provider', 'auto');

  /*
   * `none` keeps the route mounted but registers no provider.
   *
   * registry.active() remains null and SearchService.search()
   * preserves the existing 501 behavior.
   */
  if (provider === 'none') {
    return registry;
  }

  registry.register(builtin);

  /*
   * register() auto-promotes the first provider.
   *
   * Explicitly selecting builtin-fts remains useful when the configured
   * provider requests it directly.
   */
  if (provider === 'builtin-fts') {
    registry.setActive('builtin-fts');
  }

  return registry;
}

@Module({
  imports: [
    ConfigModule,

    /*
     * Phase H tenant authorization.
     *
     * Provides SessionTenantAccessService to SearchController.
     */
    AccessControlModule,
  ],

  controllers: [SearchController],

  providers: [
    SearchProviderRegistry,
    SearchService,
    BuiltInFtsProvider,

    {
      provide: 'SEARCH_BOOTSTRAP',
      inject: [
        SearchProviderRegistry,
        BuiltInFtsProvider,
        ConfigService,
      ],
      useFactory: bootstrapSearchProviders,
    },

    /*
     * Bind the core-owned plugin search capability port to this
     * module's registry.
     *
     * useExisting is intentional so Nest does not construct or dispatch
     * lifecycle hooks against another SearchProviderRegistry instance.
     */
    {
      provide: PLUGIN_SEARCH_REGISTRY_PORT,
      useExisting: SearchProviderRegistry,
    },
  ],
})
export class SearchModule {}

