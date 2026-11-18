import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Session } from '../session/entities/session.entity';
import { Agent } from '../teamleader/entities/agent.entity';
import { SessionTenantAccessService } from './session-tenant-access.service';
import { AuthorizationService } from './authorization.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Agent], 'main'),
    TypeOrmModule.forFeature([Session], 'data'),
  ],
  providers: [SessionTenantAccessService, AuthorizationService],
  exports: [SessionTenantAccessService, AuthorizationService],
})
export class AccessControlModule {}
