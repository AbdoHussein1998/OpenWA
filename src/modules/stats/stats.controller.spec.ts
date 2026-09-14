


import { Reflector } from '@nestjs/core';

import {
  ApiCapability,
} from '../auth/capabilities/api-capability';
import {
  REQUIRED_CAPABILITY_KEY,
} from '../auth/decorators/capability.decorator';
import {
  SESSION_SCOPED_KEY,
  UNSCOPED_KEY,
} from '../auth/decorators/auth.decorators';

import {
  StatsController,
} from './stats.controller';

describe('StatsController access control', () => {
  const reflector = new Reflector();

  const globalStatsHandlers = [
    'getOverview',
    'getMessageStats',
  ] as const;

  it('marks the controller as Session-scoped for :sessionId routes', () => {
    expect(
      reflector.get<boolean | undefined>(
        SESSION_SCOPED_KEY,
        StatsController,
      ),
    ).toBe(true);
  });

  it.each(globalStatsHandlers)(
    'global stats route %s requires STATS_READ',
    method => {
      const handler = StatsController.prototype[method];

      expect(
        reflector.get<ApiCapability | undefined>(
          REQUIRED_CAPABILITY_KEY,
          handler,
        ),
      ).toBe(ApiCapability.STATS_READ);
    },
  );

  it.each(globalStatsHandlers)(
    'global stats route %s requires an unrestricted API key',
    method => {
      const handler = StatsController.prototype[method];

      expect(
        reflector.get<boolean | undefined>(
          UNSCOPED_KEY,
          handler,
        ),
      ).toBe(true);
    },
  );

  it('per-session stats requires SESSION_READ', () => {
    const handler =
      StatsController.prototype.getSessionStats;

    expect(
      reflector.get<ApiCapability | undefined>(
        REQUIRED_CAPABILITY_KEY,
        handler,
      ),
    ).toBe(ApiCapability.SESSION_READ);
  });

  it('per-session stats does not require an unrestricted key because :sessionId is tenant-scoped', () => {
    const handler =
      StatsController.prototype.getSessionStats;

    expect(
      reflector.get<boolean | undefined>(
        UNSCOPED_KEY,
        handler,
      ),
    ).toBeUndefined();
  });
});



