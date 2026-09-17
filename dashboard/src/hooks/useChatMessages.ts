import { useCallback } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  mergeChatMessages,
  mapEngineHistoryMessage,
  mergeOrAppend,
  updateMessageById,
  removeMessageById,
  type ChatMessageView,
} from '../utils/chatMessages';
import { sessionApi } from '../services/api';

export const MESSAGE_QUERY_PREFIX = 'messages' as const;

export type MessagesQueryKey = readonly [typeof MESSAGE_QUERY_PREFIX, string, string];

export function messagesQueryKey(sessionId: string, chatId: string): MessagesQueryKey {
  return [MESSAGE_QUERY_PREFIX, sessionId, chatId] as const;
}

/**
 * Fetch messages for one (sessionId, chatId) and keep them cached (staleTime: Infinity). Realtime
 * updates normally flow through useChatMessagesActions; a confirmed WebSocket re-subscription can
 * invalidate a session's cached slices so events missed while the route was unmounted are recovered.
 * Engine history is fetched WITHOUT media to keep the cache small — a single 50 MiB message would otherwise sit in heap as base64 (held twice
 * as a `data:` URI). Recent media still renders from the DB copy (which wins in mergeChatMessages);
 * older history media shows the omitted placeholder. Live/DB payloads that do arrive are additionally
 * bounded per slice: mergeChatMessages/mergeOrAppend run the result through capMediaPayloads, which
 * strips the oldest base64 beyond MEDIA_PAYLOAD_CACHE_LIMIT so a long media-heavy session can't grow
 * the tab's heap without bound. Cache eviction happens 5 min after the chat stops being observed
 * (gcTime), so browsing several media-rich chats doesn't accumulate large slices.
 */
export function useChatMessages(sessionId: string, chatId: string | null): UseQueryResult<ChatMessageView[], Error> {
  return useQuery<ChatMessageView[], Error>({
    queryKey: messagesQueryKey(sessionId, chatId ?? ''),
    queryFn: async () => {
      const [dbRes, historyRes] = await Promise.allSettled([
        sessionApi.getChatMessages(sessionId, chatId!, 100),
        sessionApi.getChatHistory(sessionId, chatId!, 100, false),
      ]);
      if (dbRes.status === 'rejected' && historyRes.status === 'rejected') throw dbRes.reason;
      const dbMessages = dbRes.status === 'fulfilled' ? dbRes.value.messages : [];
      const history = historyRes.status === 'fulfilled' ? historyRes.value.map(mapEngineHistoryMessage) : [];
      return mergeChatMessages(dbMessages, history);
    },
    enabled: Boolean(sessionId && chatId),
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });
}

/**
 * Mutation helpers that write directly to the React Query cache. Use these
 * from the WebSocket subscriber, the optimistic-send flow, and ACK handlers
 * instead of calling setMessages locally.
 */
export function useChatMessagesActions() {
  const qc = useQueryClient();

  const appendMessage = useCallback(
    (sessionId: string, chatId: string, msg: ChatMessageView) => {
      // Only append to a slice that already exists (a chat that has been opened). Do NOT seed a slice
      // for a never-opened chat: with staleTime: Infinity that phantom slice would be "fresh", so
      // opening the chat would skip the full-history queryFn and show only this one message (truncated
      // history). Returning undefined from the updater is a no-op when there is no cached data.
      qc.setQueryData<ChatMessageView[]>(messagesQueryKey(sessionId, chatId), old =>
        old === undefined ? undefined : mergeOrAppend(old, msg),
      );
    },
    [qc],
  );

  const updateMessage = useCallback(
    (sessionId: string, chatId: string, id: string, patch: Partial<ChatMessageView>) => {
      qc.setQueryData<ChatMessageView[]>(messagesQueryKey(sessionId, chatId), (old = []) =>
        updateMessageById(old, id, patch),
      );
    },
    [qc],
  );

  const removeMessage = useCallback(
    (sessionId: string, chatId: string, id: string) => {
      qc.setQueryData<ChatMessageView[]>(messagesQueryKey(sessionId, chatId), (old = []) =>
        removeMessageById(old, id),
      );
    },
    [qc],
  );

  /**
   * A page-scoped WebSocket can miss events while its route is unmounted. Once the server confirms
   * that the current session subscription is active again, mark every cached chat slice for that
   * session stale. Active slices refetch immediately; inactive slices refetch when next observed.
   */
  const invalidateSessionMessages = useCallback(
    (sessionId: string): Promise<void> => {
      if (!sessionId) return Promise.resolve();
      return qc.invalidateQueries({ queryKey: [MESSAGE_QUERY_PREFIX, sessionId] });
    },
    [qc],
  );

  return {
    appendMessage,
    updateMessage,
    removeMessage,
    invalidateSessionMessages,
  };
}
