/** Fail-closed metadata sanitizer. The same sanitized entry is routed to BOTH sinks. */
import type { ApplicationLogEntry } from './log-entry.interface';

const SECRET_KEY = /password|passwd|secret|token|api[-_]?key|authorization|credential|private[-_]?key|cookie|set[-_]?cookie|qr|pairing|auth[-_]?data|session[-_]?data|profile|proxy[-_]?url|body|payload|attachment|media|image|content|text|messagebody|headers|screenshot|raw/i;
const SAFE_ID_KEY = /^(sessionId|messageId|webhookId|requestId|correlationId|incidentId|connectionAttemptId|engineGenerationId|actorId|userId|jobId|attemptId|eventId|proxyId|batchId|tenantId|sessionName)$/;
const SAFE_TEXT_KEY = /^(action|operation|eventType|source|status|actorType|host|reason|reasonCode|observedReason|suspectedCause|confirmedCause|previousStatus|nextStatus|stage|engine|engineType|type|method|route|code|errorCode|category|state|result|phase)$/;
const SAFE_NUMBER_KEY = /^(attempt|retry|retryCount|count|statusCode|exitCode|elapsedMs|delayMs|duration|durationMs|bytes|size|limit|failureCount|generation|pending|completed|failed|remaining|total|port)$/;
// `context` contains the substring `text`, so SECRET_KEY would otherwise redact every Nest
// framework class context. Only expose tightly bounded class-style names, never arbitrary input.
const SAFE_LOGGER_CONTEXT = /^[A-Z][A-Za-z0-9_.-]{0,79}$/;
const MAX_TEXT = 1024;
const MAX_ID = 160;
const MAX_KEYS = 48;
const MAX_DEPTH = 6;

/** Sanitize strings BEFORE console output, including raw error messages and trace strings. */
export function sanitizeLogText(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : value instanceof Error ? value.message : String(value);
  } catch {
    return '[UNPRINTABLE]';
  }
  text = text
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, '[REDACTED_AUTH]')
    .replace(/(\b(?:api[_-]?key|authorization|password|token|secret|cookie|proxy_password|access_token|refresh_token)\b\s*[=:]\s*["']?)[^\s,'"}\]]+/gi, '$1[REDACTED]')
    .replace(/([a-z][a-z\d+.-]*:\/\/)([^/@\s]+@)/gi, '$1[REDACTED]@')
    .replace(/\b(?:[1234]@[A-Za-z0-9+/=_,-]{24,}|[A-Za-z0-9_-]{140,})\b/g, '[REDACTED_BLOB]')
    .replace(/\beyJ[A-Za-z\d_-]+\.eyJ[A-Za-z\d_-]+\.[A-Za-z\d_-]+\b/g, '[REDACTED_JWT]')
    .replace(/(\b(?:\?|&)(?:token|key|auth|password|secret|code)=)[^&#\s]+/gi, '$1[REDACTED]');
  // Short bounded strings also defend the archive against accidental large message/body dumps.
  return text.slice(0, MAX_TEXT);
}

export function sanitizeLogValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'boolean' || typeof value === 'number') return Number.isFinite(Number(value)) ? value : null;
  if (typeof value === 'string') return sanitizeLogText(value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return '[OMITTED]';
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (value instanceof Error) {
    const out = safeLogError(value);
    seen.delete(value);
    return out;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    seen.delete(value);
    return '[BINARY_OMITTED]';
  }
  if (Array.isArray(value)) {
    const out = value.slice(0, 24).map(item => sanitizeLogValue(item, depth + 1, seen));
    seen.delete(value);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
    if (depth === 0 && key === 'context' && typeof item === 'string' && SAFE_LOGGER_CONTEXT.test(item)) {
      out[key] = item;
    } else if (SECRET_KEY.test(key)) {
      out[key] = '[REDACTED]';
    } else if (typeof item === 'string' && !SAFE_ID_KEY.test(key) && !SAFE_TEXT_KEY.test(key)) {
      out[key] = '[TEXT_OMITTED]';
    } else if (typeof item === 'number' && !SAFE_NUMBER_KEY.test(key)) {
      out[key] = item;
    } else {
      out[key] = sanitizeLogValue(item, depth + 1, seen);
    }
  }
  seen.delete(value);
  return out;
}

export function safeLogError(error: unknown): NonNullable<ApplicationLogEntry['error']> {
  if (error instanceof Error) {
    const coded = error as Error & { code?: unknown };
    return {
      name: sanitizeLogText(error.name).slice(0, 80),
      ...(typeof coded.code === 'string' ? { code: sanitizeLogText(coded.code).slice(0, 80) } : {}),
      message: sanitizeLogText(error.message),
      ...(typeof error.stack === 'string' ? { stack: sanitizeLogText(error.stack) } : {}),
    };
  }
  return { name: 'NonErrorThrown', message: sanitizeLogText(error) };
}

/** Preserve only safe, meaningful structured data; block unknown string fields. */
export function sanitizeLogMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const cleaned = sanitizeLogValue(value);
  const out = cleaned && !Array.isArray(cleaned) && typeof cleaned === 'object'
    ? cleaned as Record<string, unknown> : {};
  // Error and trace fields carry controlled diagnostics rather than unknown free-form data.
  const source = value as Record<string, unknown>;
  if (source.error !== undefined) {
    const e = source.error;
    if (e instanceof Error) out.error = safeLogError(e);
    else if (e && typeof e === 'object') {
      const parts = e as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown };
      out.error = {
        name: sanitizeLogText(parts.name ?? 'Error'),
        ...(parts.code !== undefined ? { code: sanitizeLogText(parts.code) } : {}),
        ...(parts.message !== undefined ? { message: sanitizeLogText(parts.message) } : {}),
        ...(parts.stack !== undefined ? { stack: sanitizeLogText(parts.stack) } : {}),
      };
    } else out.error = safeLogError(e);
  }
  if (source.trace !== undefined) out.trace = sanitizeLogText(source.trace);
  return out;
}
