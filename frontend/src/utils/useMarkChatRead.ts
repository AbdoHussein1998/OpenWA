import { useCallback, useEffect, useMemo, useRef } from 'react';
import { sessionApi } from '../services/api';
import { useToast } from '../hooks/useToast';
import { createRequestQueue } from '../utils/requestQueue';
import { createTrailingCoalescer } from '../utils/trailingCoalescer';
import {
  isThrottlerError,
  retryWithBackoff,
} from '../utils/retryWithBackoff';

/**
 * Existing behavior: collapse repeated read notifications for the same chat.
 */
export const MARK_READ_DEBOUNCE_MS = 750;

/**
 * Global behavior: never dispatch mark-read requests concurrently, and leave
 * a small gap between requests across ALL chats/pages using this module.
 */
export const MARK_READ_QUEUE_GAP_MS = 250;

/**
 * Retry only rate-limit/throttling failures.
 */
export const MARK_READ_RETRY_BASE_MS = 1000;
export const MARK_READ_RETRY_MAX_ATTEMPTS = 3;

/**
 * Prevent a 429 burst from becoming a toast burst.
 */
export const MARK_READ_TOAST_COOLDOWN_MS = 5000;

/**
 * One queue for the whole dashboard bundle.
 *
 * This is deliberately module-scoped. If Chats.tsx and SpgAgents.tsx both
 * mount/use this hook, their markChatRead calls share the same limiter.
 */
const markChatReadQueue = createRequestQueue(MARK_READ_QUEUE_GAP_MS);

let lastMarkReadToastAt = 0;

/**
 * Show at most one mark-read warning during the cooldown window.
 *
 * We intentionally do not put this in React state. A burst of failed network
 * calls should not trigger a React render for every failure.
 */
function showRateLimitedMarkReadToast(
  showWarningToast: (title: string, message?: string) => void,
  title: string,
  error: unknown,
): void {
  const now = Date.now();

  if (now - lastMarkReadToastAt < MARK_READ_TOAST_COOLDOWN_MS) {
    return;
  }

  lastMarkReadToastAt = now;

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : undefined;

  showWarningToast(title, message);
}

export interface UseMarkChatReadOptions {
  /**
   * Translated title used for the single warning toast.
   *
   * Example:
   *   t('chats.errors.markRead')
   */
  errorTitle: string;
}

export interface UseMarkChatReadResult {
  markChatRead: (chatId: string) => void;
}

/**
 * Centralized mark-chat-read orchestration:
 *
 *   per-chat trailing coalescer
 *              ↓
 *       global FIFO queue
 *              ↓
 *      retry throttled calls
 *              ↓
 *      sessionApi.markChatRead()
 *              ↓
 *       rate-limited toast
 *
 * The hook owns only the per-instance coalescer. The queue and toast
 * cooldown are shared globally by all hook instances.
 */
export function useMarkChatRead(
  sessionId: string | undefined,
  { errorTitle }: UseMarkChatReadOptions,
): UseMarkChatReadResult {
  const { warning: showWarningToast } = useToast();

  /**
   * Refs keep the coalescer callback stable while still using the latest
   * toast function/title.
   */
  const showWarningToastRef = useRef(showWarningToast);
  const errorTitleRef = useRef(errorTitle);

  useEffect(() => {
    showWarningToastRef.current = showWarningToast;
  }, [showWarningToast]);

  useEffect(() => {
    errorTitleRef.current = errorTitle;
  }, [errorTitle]);

  const markReadCoalescer = useMemo(() => {
    if (!sessionId) {
      return null;
    }

    const currentSessionId = sessionId;

    return createTrailingCoalescer<string>(
      chatId => {
        void markChatReadQueue
          .enqueue(() =>
            retryWithBackoff(
              () => sessionApi.markChatRead(currentSessionId, chatId),
              {
                baseMs: MARK_READ_RETRY_BASE_MS,
                maxAttempts: MARK_READ_RETRY_MAX_ATTEMPTS,
                isRetryable: isThrottlerError,
              },
            ),
          )
          .catch(error => {
            showRateLimitedMarkReadToast(
              showWarningToastRef.current,
              errorTitleRef.current,
              error,
            );
          });
      },
      MARK_READ_DEBOUNCE_MS,
    );
  }, [sessionId]);

  /**
   * Calling markChatRead only schedules/coalesces the operation. No network
   * request happens directly from the caller.
   */
  const markChatRead = useCallback(
    (chatId: string) => {
      if (!chatId || !markReadCoalescer) {
        return;
      }

      markReadCoalescer.call(chatId);
    },
    [markReadCoalescer],
  );

  /**
   * Important: flush the pending trailing request for THIS session when its
   * coalescer is replaced/unmounted. The callback captured the old sessionId,
   * so the flushed request still belongs to the session being left.
   *
   * We do NOT clear the global queue here because another page may be using it.
   */
  useEffect(() => {
    return () => {
      markReadCoalescer?.flush();
    };
  }, [markReadCoalescer]);

  return {
    markChatRead,
  };
}






