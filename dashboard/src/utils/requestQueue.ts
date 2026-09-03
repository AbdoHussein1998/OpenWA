export interface RequestQueue {
  enqueue<T>(task: () => Promise<T> | T): Promise<T>;
  clear(reason?: unknown): void;
}

interface QueueItem<T> {
  task: () => Promise<T> | T;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

/**
 * FIFO async request queue.
 *
 * Guarantees:
 * - only one task is in flight at a time;
 * - task dispatches are separated by at least `gapMs`;
 * - synchronous throws are converted into promise rejections;
 * - `clear()` rejects work that has not started yet.
 */
export function createRequestQueue(gapMs: number): RequestQueue {
  if (!Number.isFinite(gapMs) || gapMs < 0) {
    throw new RangeError('gapMs must be a finite number >= 0');
  }

  const pending: QueueItem<unknown>[] = [];
  let running = false;
  let clearedError: unknown;

  const runNext = async (): Promise<void> => {
    if (running || pending.length === 0) {
      return;
    }

    running = true;

    const item = pending.shift()!;
    const startedAt = Date.now();

    try {
      const result = await item.task();
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    }

    const elapsed = Date.now() - startedAt;
    const remainingGap = Math.max(0, gapMs - elapsed);

    try {
      if (remainingGap > 0) {
        await new Promise<void>(resolve => setTimeout(resolve, remainingGap));
      }
    } finally {
      running = false;
      void runNext();
    }
  };

  return {
    enqueue<T>(task: () => Promise<T> | T): Promise<T> {
      if (clearedError !== undefined) {
        return Promise.reject(clearedError);
      }

      return new Promise<T>((resolve, reject) => {
        pending.push({
          task,
          resolve: resolve as (value: unknown) => void,
          reject,
        });

        void runNext();
      });
    },

    clear(reason = new Error('Request queue cleared')): void {
      clearedError = reason;

      while (pending.length > 0) {
        pending.shift()!.reject(reason);
      }

      // Allow the queue to accept new work after a clear once the caller
      // explicitly starts using it again. This also prevents a permanent
      // "cleared" state from surviving a session/page transition.
      clearedError = undefined;
    },
  };
}
