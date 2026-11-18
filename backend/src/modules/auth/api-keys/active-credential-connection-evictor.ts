/**
 * Port owned by authentication. Concrete socket adapters implement it without
 * exposing gateway types to credential lifecycle orchestrators.
 */
export type CredentialEvictionReason =
  | 'revoked'
  | 'deleted'
  | 'authorization_changed';

export interface ActiveCredentialConnectionEvictor {
  evictApiKey(keyId: string, reason: CredentialEvictionReason): void;
}

/** Explicit Nest DI contract; future event-driven adapters can replace it. */
export const ACTIVE_CREDENTIAL_CONNECTION_EVICTOR = Symbol(
  'ACTIVE_CREDENTIAL_CONNECTION_EVICTOR',
);
