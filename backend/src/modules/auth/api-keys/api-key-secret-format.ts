import { randomBytes } from 'crypto';

/** New secrets use a versioned format. Previously issued secrets remain valid. */
export const API_KEY_SECRET_PREFIX = 'owa_k1_';

export function generateApiKeySecret(): string {
  return `${API_KEY_SECRET_PREFIX}${randomBytes(32).toString('hex')}`;
}
