import { createHash } from 'crypto';
import { BadRequestException } from '@nestjs/common';

// Restricted alphabet avoids whitespace/Unicode normalization ambiguities across REST and
// agent-tool clients. This is an opt-in contract: missing keys preserve historical behavior.
export const SEND_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** Order-independent, JSON-compatible canonicalization; does not persist raw request content. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([name, item]) => [name, canonical(item)]),
    );
  }
  return value;
}

/** Fingerprint the *effective* post-plugin send input (including media and destination). */
export function sendIdempotencyFields<T extends object>(
  action: string,
  input: T,
): { idempotencyKey?: string; sendRequestHash?: string } {
  const { idempotencyKey, ...payload } = input as T & { idempotencyKey?: unknown };
  if (idempotencyKey === undefined) return {};
  if (typeof idempotencyKey !== 'string' || !SEND_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new BadRequestException('idempotencyKey must be 8–128 characters: letters, digits, period, colon, dash or underscore');
  }
  const sendRequestHash = createHash('sha256')
    .update(JSON.stringify(canonical({ action, payload })))
    .digest('hex');
  return { idempotencyKey, sendRequestHash };
}
