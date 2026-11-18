import { generateApiKeySecret } from './api-key-secret-format';
import { hashApiKey } from '../api-key-hash';

/** Only this module creates or hashes new API-key secrets. */
export function hashCredential(rawKey: string): string {
  return hashApiKey(rawKey, process.env.API_KEY_PEPPER);
}

export function createCredentialMaterial(rawKey = generateApiKeySecret()) {
  return { rawKey, keyHash: hashCredential(rawKey), keyPrefix: rawKey.substring(0, 12) };
}
