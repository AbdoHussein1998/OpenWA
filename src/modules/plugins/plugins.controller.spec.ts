



import { Reflector } from '@nestjs/core';

import {
  ApiCapability,
} from '../auth/capabilities/api-capability';
import {
  REQUIRED_CAPABILITY_KEY,
} from '../auth/decorators/capability.decorator';
import {
  UNSCOPED_KEY,
} from '../auth/decorators/auth.decorators';

import {
  PluginsController,
} from './plugins.controller';

describe('PluginsController authorization', () => {
  const reflector = new Reflector();

  const globallyUnscopedHandlers = [
    'findAll',
    'install',
    'installFromUrl',
    'catalog',
    'findOne',
    'enable',
    'disable',
    'updateConfig',
    'getConfigUi',
    'updateSessions',
    'update',
    'uninstall',
    'healthCheck',
  ] as const;

  it('requires PLUGIN_MANAGE at the controller level', () => {
    expect(
      reflector.get<ApiCapability | undefined>(
        REQUIRED_CAPABILITY_KEY,
        PluginsController,
      ),
    ).toBe(ApiCapability.PLUGIN_MANAGE);
  });

  it.each(globallyUnscopedHandlers)(
    '%s requires an unrestricted API key',
    method => {
      // Metadata-only lookup; the handler is not detached and invoked.
      const handler = PluginsController.prototype[method];

      expect(
        reflector.get<boolean | undefined>(
          UNSCOPED_KEY,
          handler,
        ),
      ).toBe(true);
    },
  );

  it('allows updateSessionConfig to rely on its :sessionId tenant fence instead of requiring an unrestricted key', () => {
    const handler =
      PluginsController.prototype.updateSessionConfig;

    expect(
      reflector.get<boolean | undefined>(
        UNSCOPED_KEY,
        handler,
      ),
    ).toBeUndefined();
  });
});



