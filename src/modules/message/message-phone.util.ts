import { parseWaId } from '../../engine/identity/wa-id';

/** E.164-sized phone digits accepted for persisted message endpoints (country code included). */
const PHONE_DIGITS = /^\d{6,15}$/;

/**
 * Return a phone number (digits only) when the supplied WhatsApp identity is known to represent a
 * phone-addressed individual. Privacy ids (`@lid` / `@hosted.lid`), groups, broadcasts,
 * newsletters, and arbitrary strings intentionally return undefined: their numeric-looking local
 * part is not a phone number and must never be persisted as one.
 *
 * The engine boundary normally emits neutral `<phone>@c.us` ids, but using the shared identity
 * parser here also accepts the raw `@s.whatsapp.net` and Meta-hosted `@hosted` phone dialects without
 * duplicating domain classification. A bare phone is accepted for Session.phone/getPhoneNumber().
 */
export function phoneFromWhatsAppIdentity(value: string | null | undefined): string | undefined {
  if (!value) return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const bare = trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
  if (PHONE_DIGITS.test(bare)) return bare;

  const parsed = parseWaId(trimmed);
  if (parsed.kind !== 'user') return undefined;

  return PHONE_DIGITS.test(parsed.userPart) ? parsed.userPart : undefined;
}
