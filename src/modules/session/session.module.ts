import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccessControlModule } from '../access-control/access-control.module';

import { Session } from './entities/session.entity';
import { Message } from '../message/entities/message.entity';

import { SessionService } from './session.service';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { SessionLidResolver } from './session-lid-resolver.service';
import { SessionLivenessWatchdog } from './session-liveness-watchdog.service';
import { SessionOwnershipService } from './session-ownership.service';
import { SessionProxyInterceptor } from './session-proxy.interceptor';
import { MessageProjector } from './message-projector.service';
import { SessionErrorStore } from './session-error-store.service';
import { SessionRestrictionStore } from './session-restriction-store.service';
import { PresenceStore } from './presence-store.service';

import { SessionController } from './session.controller';

import { WebhookModule } from '../webhook/webhook.module';
import { StatusStoreModule } from '../status-store/status-store.module';
import { ChatMediaModule } from '../chat-media/chat-media.module';
import { AutomationModule } from '../automation/automation.module';

import {
  PLUGIN_SESSION_PORT,
} from '../../core/plugins/plugin-host-ports';

@Module({
  /*
   * WebhookModule / StatusStoreModule / ChatMediaModule /
   * AutomationModule do not import SessionModule back, so the
   * dependency remains one-directional.
   */
  imports: [
    TypeOrmModule.forFeature(
      [
        Session,
        Message,
      ],
      'data',
    ),

    /*
     * SessionController needs SessionTenantAccessService for
     * aggregate routes such as GET /sessions and stats/overview.
     */
    AccessControlModule,

    WebhookModule,
    StatusStoreModule,
    ChatMediaModule,
    AutomationModule,
  ],

  controllers: [
    SessionController,
  ],

  providers: [
    /*
     * Global on purpose: any controller may carry a session
     * dimension. Inert unless NODE_URL is configured.
     */
    {
      provide: APP_INTERCEPTOR,
      useClass: SessionProxyInterceptor,
    },

    SessionService,
    SessionEngineLifecycle,
    SessionErrorStore,
    SessionRestrictionStore,
    PresenceStore,
    SessionLidResolver,
    SessionLivenessWatchdog,
    SessionOwnershipService,
    MessageProjector,

    /*
     * Alias the core plugin port to the existing SessionService
     * instance so lifecycle hooks still execute only once.
     */
    {
      provide: PLUGIN_SESSION_PORT,
      useExisting: SessionService,
    },
  ],

  exports: [
    SessionService,
    MessageProjector,
    SessionOwnershipService,
  ],
})
export class SessionModule {}


