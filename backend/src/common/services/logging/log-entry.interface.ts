/** Canonical, security-filtered logging event shared by both transports. */
export type AppLogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'verbose' | 'trace';
export type LogSource = 'http' | 'websocket' | 'engine' | 'browser' | 'automation' |
  'mcp' | 'webhook' | 'job' | 'infra' | 'framework' | 'application';
export type LogActorType = 'user' | 'api_key' | 'automation' | 'system' | 'remote' | 'unknown';

export interface ApplicationLogEntry {
  eventId: string;
  timestamp: string;
  level: AppLogLevel;
  context: string;
  operation?: string;
  eventType?: string;
  message: string;
  source: LogSource;
  requestId?: string;
  correlationId?: string;
  incidentId?: string;
  sessionId?: string;
  connectionAttemptId?: string;
  engineGenerationId?: string;
  instanceId: string;
  bootId: string;
  elapsedMs?: number;
  status?: 'started' | 'succeeded' | 'failed' | 'skipped';
  reasonCode?: string;
  actorType?: LogActorType;
  actorId?: string;
  error?: { name: string; code?: string; message?: string; stack?: string };
  metadata?: Record<string, unknown>;
}

export const LOG_LEVEL_ORDER: AppLogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'verbose', 'trace'];

export function isLevelEnabled(level: AppLogLevel, threshold: AppLogLevel): boolean {
  return LOG_LEVEL_ORDER.indexOf(level) <= LOG_LEVEL_ORDER.indexOf(threshold);
}
