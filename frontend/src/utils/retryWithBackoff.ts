export interface RetryWithBackoffOptions {
  /**
   * Maximum number of attempts, including the initial attempt.
   * Example: maxAttempts=3 => initial attempt + 2 retries.
   */
  maxAttempts: number;
  baseMs: number;

  /**
   * Return true only for errors that are safe to retry.
   */
  isRetryable: (error: unknown) => boolean;

  /**
   * Optional upper bound for exponential backoff.
   */
  maxDelayMs?: number;

  /**
   * Jitter fraction applied to the backoff delay.
   * 0.25 means the actual delay is between 75% and 125% of the
   * calculated exponential delay.
   */
  jitterRatio?: number;
}

const DEFAULT_JITTER_RATIO = 0.25;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: {
      status?: unknown;
    };
    responseBody?: {
      status?: unknown;
    };
  };

  const values = [
    candidate.status,
    candidate.statusCode,
    candidate.response?.status,
    candidate.responseBody?.status,
  ];

  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && /^\d{3}$/.test(value)) {
      return Number(value);
    }
  }

  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      message?: unknown;
      error?: unknown;
    };

    if (typeof candidate.message === 'string') {
      return candidate.message;
    }

    if (typeof candidate.error === 'string') {
      return candidate.error;
    }

    try {
      return JSON.stringify(error);
    } catch {
      return '';
    }
  }

  return typeof error === 'string' ? error : '';
}

/**
 * Detect NestJS ThrottlerException / HTTP 429-shaped errors.
 *
 * This intentionally handles several common rejection shapes because
 * frontend API clients do not always preserve the same error structure.
 */
export function isThrottlerError(error: unknown): boolean {
  const status = getHttpStatus(error);

  if (status === 429) {
    return true;
  }

  const message = getErrorMessage(error).toLowerCase();

  return (
    message.includes('throttlerexception') ||
    message.includes('too many requests') ||
    message.includes('rate limit')
  );
}

/**
 * Retry an async operation with exponential backoff and jitter.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T> | T,
  options: RetryWithBackoffOptions,
): Promise<T> {
  const {
    baseMs,
    maxAttempts,
    isRetryable,
    maxDelayMs = 30_000,
    jitterRatio = DEFAULT_JITTER_RATIO,
  } = options;

  if (!Number.isFinite(baseMs) || baseMs < 0) {
    throw new RangeError('baseMs must be a finite number >= 0');
  }

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('maxAttempts must be an integer >= 1');
  }

  if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
    throw new RangeError('maxDelayMs must be a finite number >= 0');
  }

  if (!Number.isFinite(jitterRatio) || jitterRatio < 0) {
    throw new RangeError('jitterRatio must be a finite number >= 0');
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const hasAttemptsLeft = attempt < maxAttempts;
      if (!hasAttemptsLeft || !isRetryable(error)) {
        throw error;
      }

      const exponentialDelay = Math.min(
        maxDelayMs,
        baseMs * 2 ** (attempt - 1),
      );

      const jitter = exponentialDelay * jitterRatio;
      const delay =
        exponentialDelay === 0
          ? 0
          : Math.max(
              0,
              exponentialDelay - jitter + Math.random() * jitter * 2,
            );

      await sleep(delay);
    }
  }

  // Defensive fallback; the loop always either returns or throws.
  throw lastError;
}
