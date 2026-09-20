/** Shared credential storage for dashboard startup, HTTP, and WebSocket authentication. */
const API_KEY_STORAGE_KEY = 'openwa_api_key';

export function getStoredApiKey(): string | null {
  return sessionStorage.getItem(API_KEY_STORAGE_KEY) ?? localStorage.getItem(API_KEY_STORAGE_KEY);
}

export function saveApiKey(apiKey: string, rememberMe: boolean): void {
  if (rememberMe) {
    localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
    sessionStorage.removeItem(API_KEY_STORAGE_KEY);
  } else {
    sessionStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
    localStorage.removeItem(API_KEY_STORAGE_KEY);
  }
}

export function clearStoredApiKey(): void {
  sessionStorage.removeItem(API_KEY_STORAGE_KEY);
  localStorage.removeItem(API_KEY_STORAGE_KEY);
}
