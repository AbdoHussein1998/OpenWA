import { generateApiKeySecret } from '../api-keys/api-key-secret-format';

/**
 * Resolves the API key to seed on first boot (when no keys exist yet).
 *
 * Precedence:
 *
 * 1. API_MASTER_KEY
 * 2. Explicit ALLOW_DEV_API_KEY=true
 * 3. Secure random generated key
 */
export function resolveSeedApiKey(): string {
  if (process.env.API_MASTER_KEY) {
    return process.env.API_MASTER_KEY;
  }

  if (process.env.ALLOW_DEV_API_KEY === 'true') {
    return 'dev-admin-key';
  }

  return generateApiKeySecret();
}

/**
 * The line printed for the API key in the startup banner.
 *
 * The complete plaintext API key is shown only when it has just been
 * created. On later boots only a short fingerprint is displayed.
 */
export function bannerKeyLine(
  displayKey: string,
  isNewKey: boolean,
): string {
  if (isNewKey) {
    return displayKey;
  }

  if (displayKey.startsWith('(')) {
    return displayKey;
  }

  return `${displayKey.slice(
    0,
    8,
  )}… (full key in data/.api-key or the dashboard)`;
}
