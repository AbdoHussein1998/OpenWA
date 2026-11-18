import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProxyAwareThrottlerGuard } from '../../common/security/proxy-aware-throttler.guard';
import { AccessControlModule } from '../access-control/access-control.module';
import { ApiKey } from './entities/api-key.entity';
import { AuthController } from './auth.controller';
import { AuthValidateController } from './auth-validate.controller';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ApiKeyAuthenticator } from './authentication/api-key-authenticator.service';
import { ApiKeyManagementService } from './api-keys/api-key-management.service';
import { ApiKeyProvisioningService } from './api-keys/api-key-provisioning.service';
import { ApiKeyAdminSafetyService } from './api-keys/api-key-admin-safety.service';
import { ApiKeySocketEvictionService } from './api-keys/api-key-socket-eviction.service';
import { ACTIVE_CREDENTIAL_CONNECTION_EVICTOR } from './api-keys/active-credential-connection-evictor';
import { EventsGatewayConnectionEvictor } from './api-keys/adapters/events-gateway-connection-evictor';
import { ApiKeyBootstrapService } from './bootstrap/api-key-bootstrap.service';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import { PrincipalResolver } from './principals/principal-resolver.service';

/** Authentication and credential lifecycle; action/tenant decisions live in AccessControlModule. */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([ApiKey], 'main'),
    AccessControlModule,
  ],
  controllers: [AuthController, AuthValidateController],
  providers: [
    ApiKeyAuthenticator,
    ApiKeyManagementService,
    ApiKeyProvisioningService,
    ApiKeyAdminSafetyService,
    ApiKeySocketEvictionService,
    {
      provide: ACTIVE_CREDENTIAL_CONNECTION_EVICTOR,
      useClass: EventsGatewayConnectionEvictor,
    },
    ApiKeyBootstrapService,
    ApiKeyUsageTracker,
    PrincipalResolver,
    { provide: APP_GUARD, useClass: ProxyAwareThrottlerGuard },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
  ],
  // Export only services consumed by other modules, not internal safety/bootstrap components.
  exports: [
    ApiKeyAuthenticator,
    ApiKeyManagementService,
    ApiKeyProvisioningService,
    PrincipalResolver,
  ],
})
export class AuthModule {}
