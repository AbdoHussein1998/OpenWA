import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from './entities/audit-log.entity';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { AccessControlModule } from '../access-control/access-control.module';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog], 'main'), AccessControlModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
