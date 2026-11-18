import { BadRequestException, Controller, Get, NotFoundException, Param, Query, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Readable } from 'node:stream';
import { RequireRole, RequireUnscopedKey } from '../../../modules/auth/decorators/auth.decorators';
import { ApiKeyRole } from '../../../modules/auth/auth.levels.constants';
import { DailyLogArchiveService } from './daily-log-archive.service';

function validDay(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day + 'T00:00:00.000Z')))
    throw new BadRequestException('dateUtc must be a valid YYYY-MM-DD UTC date');
  return day;
}
function validLimit(raw?: string): number {
  if (!raw) return 200;
  if (!/^\d{1,4}$/.test(raw) || Number(raw) < 1 || Number(raw) > 1000)
    throw new BadRequestException('limit must be between 1 and 1000');
  return Number(raw);
}
function validIdentifier(raw?: string): string | undefined {
  if (raw === undefined) return undefined;
  if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(raw)) throw new BadRequestException('Invalid identifier filter');
  return raw;
}

@ApiTags('infrastructure-logs')
@RequireUnscopedKey()
@RequireRole(ApiKeyRole.ADMIN)
@Controller('infra/logs')
export class LogQueryController {
  constructor(private readonly logs: DailyLogArchiveService) {}

  @Get('status')
  @ApiOperation({ summary: 'Logging archive health, retention, backlog and latest archive status' })
  status() { return this.logs.status(); }

  @Get('today')
  @ApiOperation({ summary: 'Search sanitized current UTC-day disk logs without waiting for database upload' })
  today(@Query('limit') limit?: string, @Query('sessionId') sessionId?: string,
    @Query('incidentId') incidentId?: string) {
    return this.logs.currentDay(validLimit(limit), validIdentifier(sessionId), validIdentifier(incidentId));
  }

  @Get('archives')
  @ApiOperation({ summary: 'List completed database log archives (not audit logs)' })
  archives(@Query('dateUtc') date?: string) { return this.logs.listArchives(date ? validDay(date) : undefined); }

  @Get('history')
  @ApiOperation({ summary: 'Search past sanitized database log events by UTC date' })
  history(@Query('dateUtc') date?: string, @Query('limit') limit?: string,
    @Query('sessionId') sessionId?: string, @Query('incidentId') incidentId?: string) {
    if (!date) throw new BadRequestException('dateUtc is required');
    return this.logs.searchHistory(validDay(date), validLimit(limit), validIdentifier(sessionId), validIdentifier(incidentId));
  }

  @Get('archives/:archiveId/download')
  @ApiOperation({ summary: 'Stream a verified compressed NDJSON daily segment (admin-only)' })
  async download(@Param('archiveId') archiveId: string): Promise<StreamableFile> {
    if (!/^[a-fA-F0-9-]{36}$/.test(archiveId)) throw new BadRequestException('Invalid archive ID');
    const archive = await this.logs.getArchive(archiveId);
    if (!archive) throw new NotFoundException('Completed log archive not found');
    const stream = Readable.from(this.logs.compressedChunks(archive.id));
    return new StreamableFile(stream, {
      type: 'application/gzip',
      disposition: `attachment; filename="al-hakim-${archive.dateUtc}-${archive.id}.ndjson.gz"`,
    });
  }
}
