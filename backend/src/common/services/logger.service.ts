import { Injectable, LoggerService as NestLoggerService, Scope } from '@nestjs/common';
import { getRequestActor, getRequestId } from './request-context';
import { randomUUID } from 'node:crypto';
import { applicationLogWriter, emergencyLog } from './logging/log-writer';
import { AppLogLevel, ApplicationLogEntry, LogSource, isLevelEnabled } from './logging/log-entry.interface';
import { safeLogError, sanitizeLogMetadata, sanitizeLogText } from './logging/log-sanitizer';

export enum LogLevel {
  FATAL = 'fatal',
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
  VERBOSE = 'verbose',
  TRACE = 'trace',
}

export enum LogFormat {
  JSON = 'json',
  PRETTY = 'pretty',
}

export interface LogContext {
  sessionId?: string;
  messageId?: string;
  webhookId?: string;
  action?: string;
  duration?: number;
  [key: string]: unknown;
}

// ANSI color codes — mirrors the palette NestJS's built-in ConsoleLogger uses so our
// pretty output blends in with the framework's own `[Nest] … LOG [Context]` lines.
const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
} as const;

const LEVEL_COLOR: Record<LogLevel, string> = {
  [LogLevel.FATAL]: ANSI.red,
  [LogLevel.ERROR]: ANSI.red,
  [LogLevel.WARN]: ANSI.yellow,
  [LogLevel.INFO]: ANSI.green,
  [LogLevel.DEBUG]: ANSI.magenta,
  [LogLevel.VERBOSE]: ANSI.cyan,
  [LogLevel.TRACE]: ANSI.dim,
};

// NestJS prints `info` as `LOG`; match its labels so both log sources line up.
const LEVEL_LABEL: Record<LogLevel, string> = {
  [LogLevel.FATAL]: 'FATAL',
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.INFO]: 'LOG',
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.VERBOSE]: 'VERBOSE',
  [LogLevel.TRACE]: 'TRACE',
};

// Keys that are rendered in the line prefix rather than the trailing metadata.
const STRUCTURAL_KEYS = new Set(['timestamp', 'level', 'context', 'message', 'trace', 'error']);

@Injectable({ scope: Scope.TRANSIENT })
export class LoggerService implements NestLoggerService {
  private context: string = 'Application';
  private static logLevel: LogLevel = LogLevel.INFO;
  private static logFormat: LogFormat | null = null;

  static setLogLevel(level: LogLevel): void {
    LoggerService.logLevel = level;
  }

  static getLogLevel(): LogLevel { return LoggerService.logLevel; }

  // Explicitly pin the output format. When unset, the format is resolved from
  // LOG_FORMAT / TTY detection (see resolveFormat).
  static setLogFormat(format: LogFormat | null): void {
    LoggerService.logFormat = format;
  }

  setContext(context: string): void {
    this.context = context;
  }

  log(message: string, context?: string | LogContext): void {
    this.writeLog(LogLevel.INFO, message, context);
  }

  error(message: string, trace?: string, context?: string | LogContext): void {
    const ctx = typeof context === 'string' ? { context } : context;
    this.writeLog(LogLevel.ERROR, message, { ...ctx, trace });
  }

  warn(message: string, context?: string | LogContext): void {
    this.writeLog(LogLevel.WARN, message, context);
  }

  debug(message: string, context?: string | LogContext): void {
    this.writeLog(LogLevel.DEBUG, message, context);
  }

  verbose(message: string, context?: string | LogContext): void {
    this.writeLog(LogLevel.VERBOSE, message, context);
  }

  trace(message: string, context?: string | LogContext): void {
    this.writeLog(LogLevel.TRACE, message, context);
  }

  fatal(message: string, context?: string | LogContext): void {
    this.writeLog(LogLevel.FATAL, message, context);
  }

  /** Emit an explicit causality event; all field values pass through mandatory sanitization. */
  event(level: LogLevel, eventType: string, operation: string, message: string, details: LogContext = {}): void {
    this.writeLog(level, message, { ...details, eventType, operation });
  }

  /** For meaningful async business operations. Does not change the original result or throw behavior. */
  async withOperation<T>(operation: string, execute: () => Promise<T>, details: LogContext = {}): Promise<T> {
    const started = Date.now();
    this.event(LogLevel.DEBUG, 'operation.started', operation, 'Operation started', { ...details, status: 'started' });
    try {
      const result = await execute();
      this.event(LogLevel.DEBUG, 'operation.succeeded', operation, 'Operation succeeded',
        { ...details, status: 'succeeded', elapsedMs: Date.now() - started });
      return result;
    } catch (error) {
      this.event(LogLevel.ERROR, 'operation.failed', operation, 'Operation failed',
        { ...details, status: 'failed', elapsedMs: Date.now() - started, error: safeLogError(error) });
      throw error;
    }
  }

  private writeLog(level: LogLevel, message: string, context?: string | LogContext): void {
    // Sanitize once, BEFORE either transport. Never suppress archive entries because the
    // separate console threshold happens to be INFO.
    try {
      const data = typeof context === 'object' && context !== null ? sanitizeLogMetadata(context) : {};
      const name = typeof context === 'string' ? context : this.context;
      const actor = getRequestActor();
      const text = (field: string): string | undefined => typeof data[field] === 'string'
        ? String(data[field]).slice(0, 160) : undefined;
      const { eventId, timestamp, instanceId, bootId } = {
        eventId: randomUUID(), timestamp: new Date().toISOString(),
        instanceId: applicationLogWriter.instanceId, bootId: applicationLogWriter.bootId,
      };
      const source: LogSource = /controller|guard|interceptor/i.test(name) && getRequestId() ? 'http'
        : /webhook/i.test(name) ? 'webhook'
        : /browser|puppeteer|chromium/i.test(name) ? 'browser'
        : /engine|baileys|wwebjs|session/i.test(name) ? 'engine'
        : /automation/i.test(name) ? 'automation' : /mcp/i.test(name) ? 'mcp'
        : /infra|docker/i.test(name) ? 'infra' : 'application';
      const structured: ApplicationLogEntry = {
        eventId, timestamp, level: level as AppLogLevel,
        context: sanitizeLogText(name).slice(0, 120), message: sanitizeLogText(message), source,
        instanceId, bootId,
        ...(getRequestId() ? { requestId: getRequestId() } : {}),
        ...(actor?.apiKeyId ? { actorType: 'api_key' as const, actorId: actor.apiKeyId }
          : ['user', 'api_key', 'automation', 'system', 'remote', 'unknown'].includes(String(data.actorType))
            ? { actorType: data.actorType as ApplicationLogEntry['actorType'] }
            : {}),
        ...(text('operation') ? { operation: text('operation') } : {}),
        ...(text('eventType') ? { eventType: text('eventType') } : {}),
        ...(text('sessionId') ? { sessionId: text('sessionId') } : {}),
        ...(text('connectionAttemptId') ? { connectionAttemptId: text('connectionAttemptId') } : {}),
        ...(text('engineGenerationId') ? { engineGenerationId: text('engineGenerationId') } : {}),
        ...(text('incidentId') ? { incidentId: text('incidentId') } : {}),
        ...(text('correlationId') ? { correlationId: text('correlationId') } : {}),
        ...(text('reasonCode') ? { reasonCode: text('reasonCode') } : {}),
        ...(typeof data.elapsedMs === 'number' ? { elapsedMs: data.elapsedMs } : {}),
        ...(data.status === 'started' || data.status === 'succeeded' || data.status === 'failed' || data.status === 'skipped'
          ? { status: data.status } : {}),
        ...(data.error ? { error: data.error as ApplicationLogEntry['error'] } : {}),
        ...(data.trace ? { error: { name: 'Error', stack: sanitizeLogText(data.trace) } } : {}),
        metadata: Object.fromEntries(Object.entries(data).filter(([k]) =>
          !['trace', 'error', 'eventType', 'operation', 'sessionId', 'connectionAttemptId',
            'engineGenerationId', 'incidentId', 'correlationId', 'reasonCode', 'elapsedMs', 'status'].includes(k))),
      };
      // Legacy top-level context keys remain readable to existing log consumers. They
      // are sanitized FIRST and cannot overwrite canonical fields. New consumers should
      // use the normalized `metadata` object instead.
      const protectedFields = new Set(['timestamp', 'level', 'context', 'message', 'source',
        'eventId', 'instanceId', 'bootId', 'requestId', 'actorType', 'actorId', 'error']);
      const legacyFields = Object.fromEntries(Object.entries(data).filter(([key]) => !protectedFields.has(key)));
      const entry = { ...structured, ...legacyFields } as ApplicationLogEntry;
      applicationLogWriter.write(entry);
      if (!this.shouldLog(level)) return;
      const output = LoggerService.resolveFormat() === LogFormat.PRETTY
        ? this.formatPretty(level, entry as unknown as Record<string, unknown>)
        : JSON.stringify(entry);
      if (level === LogLevel.ERROR || level === LogLevel.FATAL) console.error(output);
      else if (level === LogLevel.WARN) console.warn(output);
      else console.log(output);
    } catch {
      // Never cause an application error while attempting to log an application error.
      emergencyLog('logger_normalize_failed');
    }
  }

  // Render a single entry as a human-readable line in the same shape NestJS's ConsoleLogger uses
  // (so it lines up with the framework's own output), but tagged honestly as [al-hakim]:
  //   [al-hakim] 1896  - 25/06/2026, 4:59:22 PM     LOG [ApiKeyAuthenticator] API Docs: … sessionId=abc
  private formatPretty(level: LogLevel, entry: Record<string, unknown>): string {
    const useColor = LoggerService.colorEnabled();
    const paint = (code: string, text: string): string => (useColor ? `${code}${text}${ANSI.reset}` : text);

    const levelColor = LEVEL_COLOR[level];
    const label = LEVEL_LABEL[level].padStart(7);
    const timestamp = new Date(String(entry.timestamp)).toLocaleString();
    const contextName = String(entry.context);
    const message = String(entry.message);

    // Trailing structured metadata (sessionId, action, duration, …) shown dimmed as key=value pairs.
    const formatValue = (value: unknown): string => (typeof value === 'string' ? value : (JSON.stringify(value) ?? ''));
    const meta = Object.entries(entry)
      .filter(([key, value]) => !STRUCTURAL_KEYS.has(key) && value !== undefined)
      .map(([key, value]) => `${key}=${formatValue(value)}`)
      .join(' ');

    let line =
      `${paint(levelColor, `[al-hakim] ${process.pid}  -`)} ${timestamp} ` +
      `${paint(levelColor, label)} ${paint(ANSI.yellow, `[${contextName}]`)} ${paint(levelColor, message)}`;

    if (meta) {
      line += ` ${paint(ANSI.dim, meta)}`;
    }

    const error = entry.error as { stack?: string } | undefined;
    if (error?.stack) line += `\n${paint(levelColor, error.stack)}`;

    return line;
  }

  private static resolveFormat(): LogFormat {
    if (LoggerService.logFormat) return LoggerService.logFormat;

    const explicit = process.env.LOG_FORMAT?.trim().toLowerCase();
    if (explicit === LogFormat.JSON || explicit === LogFormat.PRETTY) {
      return explicit;
    }

    // No explicit choice: structured JSON in production (containers, log aggregators),
    // human-readable pretty everywhere else. This mirrors NestJS's own logger, which
    // always prints its text format — and unlike a TTY check it stays correct when
    // stdout is piped through a dev runner (e.g. `concurrently` in `npm run dev`).
    return process.env.NODE_ENV === 'production' ? LogFormat.JSON : LogFormat.PRETTY;
  }

  private static colorEnabled(): boolean {
    // Honor the de-facto NO_COLOR / FORCE_COLOR conventions; otherwise colorize only a real TTY.
    if (process.env.NO_COLOR) return false;
    if (process.env.FORCE_COLOR) return true;
    return Boolean(process.stdout.isTTY);
  }

  private shouldLog(level: LogLevel): boolean {
    return isLevelEnabled(level as AppLogLevel, LoggerService.logLevel as AppLogLevel);
  }
}

// Create a factory for easy instantiation
export function createLogger(context: string): LoggerService {
  const logger = new LoggerService();
  logger.setContext(context);
  return logger;
}
