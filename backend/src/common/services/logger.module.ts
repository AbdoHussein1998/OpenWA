import { Global, Module } from '@nestjs/common';
import { LoggerService } from './logger.service';
import { ShutdownService } from './shutdown.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApplicationDailyLog, ApplicationDailyLogChunk } from './logging/application-daily-log.entity';
import { DailyLogArchiveService } from './logging/daily-log-archive.service';
import { LogQueryController } from './logging/log-query.controller';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ApplicationDailyLog, ApplicationDailyLogChunk], 'main')],
  controllers: [LogQueryController],
  providers: [LoggerService, ShutdownService, DailyLogArchiveService],
  exports: [LoggerService, ShutdownService, DailyLogArchiveService],
})
export class LoggerModule {}
