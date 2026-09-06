

import { Global, Module } from '@nestjs/common';

import { EventsGateway } from './events.gateway';

import { AuthModule } from '../auth/auth.module';
import { AccessControlModule } from '../access-control/access-control.module';

@Global()
@Module({
  imports: [
    AuthModule,

    /*
     * Phase I — WebSocket tenancy.
     *
     * EventsGateway uses SessionTenantAccessService for:
     *
     * - concrete session subscriptions:
     *     assertSessionAccess(apiKey, sessionId)
     *
     * - wildcard subscriptions:
     *     getEffectiveSessionScope(apiKey)
     *
     * This keeps WebSocket authorization aligned with REST tenancy
     * instead of implementing TEAM_LEADER / AGENT rules independently
     * inside the gateway.
     */
    AccessControlModule,
  ],

  providers: [
    EventsGateway,
  ],

  exports: [
    EventsGateway,
  ],
})
export class EventsModule {}

