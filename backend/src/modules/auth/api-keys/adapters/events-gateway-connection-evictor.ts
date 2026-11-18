import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventsGateway } from '../../../events/events.gateway';
import {
  type ActiveCredentialConnectionEvictor,
  type CredentialEvictionReason,
} from '../active-credential-connection-evictor';

/**
 * Compatibility adapter: the existing gateway/module cycle requires lazy
 * resolution. Only this infrastructure adapter knows about EventsGateway.
 * Replace this provider when EventsModule can register a direct port.
 */
@Injectable()
export class EventsGatewayConnectionEvictor
  implements ActiveCredentialConnectionEvictor {
  constructor(private readonly moduleRef: ModuleRef) {}

  evictApiKey(keyId: string, reason: CredentialEvictionReason): void {
    const gateway = this.moduleRef.get(EventsGateway, { strict: false });
    if (!gateway) {
      throw new Error('EventsGateway is not registered; active API-key sockets were not evicted');
    }
    gateway.evictApiKey(keyId, reason);
  }
}
