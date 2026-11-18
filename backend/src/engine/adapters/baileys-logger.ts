import { BaileysLogger } from '../types/baileys.types';
import { createLogger, LogLevel } from '../../common/services/logger.service';

/** Library internals are silent until explicitly enabled; never emit raw WhatsApp frames. */
export function createSilentLogger(): BaileysLogger {
  const noop = (): void => {};
  const logger: BaileysLogger = {
    level: 'silent', child: () => logger, trace: noop, debug: noop, info: noop, warn: noop, error: noop,
  };
  return logger;
}

const BAILEYS_LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'];
const TO_APP_LEVEL: Record<string, LogLevel> = {
  trace: LogLevel.TRACE, debug: LogLevel.DEBUG, info: LogLevel.INFO,
  warn: LogLevel.WARN, error: LogLevel.ERROR,
};

/**
 * Opt-in Baileys native diagnostics, sanitized and routed through the application logger.
 * In particular, Baileys TRACE may contain decoded WhatsApp wire frames, message bodies,
 * credentials and Signal keys: intentionally discard *all* raw objects and raw msg strings.
 * Capture only event occurrence, level and a safe classified reason. This trades raw native
 * content for production-safe forensics. Engine connection.update emits structured status codes.
 */
export function createBaileysLogger(): BaileysLogger {
  const configured = (process.env.BAILEYS_LOG_LEVEL ?? 'silent').toLowerCase();
  if (!BAILEYS_LOG_LEVELS.includes(configured)) return createSilentLogger();
  const threshold = BAILEYS_LOG_LEVELS.indexOf(configured);
  const application = createLogger('BaileysWire');
  const write = (level: string) => (obj: unknown, message?: string): void => {
    if (BAILEYS_LOG_LEVELS.indexOf(level) < threshold) return;
    // Classification operates on a bounded string but NEVER serializes the input into log sinks.
    const hint = typeof message === 'string' ? message.slice(0, 180)
      : typeof obj === 'string' ? obj.slice(0, 180) : '';
    const category = /timed? ?out/i.test(hint) ? 'TIMEOUT'
      : /decrypt|mac|cipher/i.test(hint) ? 'CRYPTO_DIAGNOSTIC'
      : /connect|socket|network/i.test(hint) ? 'TRANSPORT_DIAGNOSTIC'
      : /sync|history/i.test(hint) ? 'SYNC_DIAGNOSTIC'
      : 'NATIVE_DIAGNOSTIC';
    application.event(TO_APP_LEVEL[level], 'engine.baileys.native_diagnostic', 'nativeLog',
      'Baileys library diagnostic emitted', { reasonCode: category, action: `native_${level}` });
  };
  const logger: BaileysLogger = {
    level: configured, child: () => logger,
    trace: write('trace'), debug: write('debug'), info: write('info'),
    warn: write('warn'), error: write('error'),
  };
  return logger;
}
