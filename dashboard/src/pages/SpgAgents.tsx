import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import {
  AlertCircle,
  ArrowLeft,
  Loader2,
  MessageSquare,
  X,
} from 'lucide-react';

import {
  asMessageType,
  messageApi,
  sessionApi,
  type Channel,
  type Chat,
  type ChatKind,
  type Session,
} from '../services/api';

import {
  type MessageMedia,
 } from '../utils/chatMessages';

import { applyIncomingToChatList } from '../utils/chatList';

import {
  applyMessageEdit,
  findRevokedIndex,
  mergeDeliveryStatus,
  mergeReactionSnapshot,
  getMediaSrc,
  type ChatMessageView,
} from '../utils/chatMessages';

import { filterChats } from '../utils/chatFilters';

import { useWebSocket } from '../hooks/useWebSocket';

import {
  useChatMessages,
  useChatMessagesActions,
  messagesQueryKey,
} from '../hooks/useChatMessages';

import { useChatScrollPosition } from '../hooks/useChatScrollPosition';
import { useProfilePicture } from '../hooks/useProfilePicture';
import { useProfilePictures } from '../hooks/useProfilePictures';
import { useToast } from '../hooks/useToast';
import { useRole } from '../hooks/useRole';

import { PhoneSearch } from '../components/PhoneSearch';
import { SessionCard } from '../components/SessionCard';

import ChatSidebar from '../components/chats/ChatSidebar';
import ChatThread from '../components/chats/ChatThread';
import ChatComposer, {
  type StagedAttachment,
} from '../components/chats/ChatComposer';

import MediaLightbox, {
  type LightboxItem,
} from '../components/chats/MediaLightbox';

import KindIcon from '../components/chats/KindIcon';

import './Chats.css';      // <-- ADD: reuse the main chat UI styles
import './SpgAgents.css';
import './SpgAgents.css';

/* ================================================================
   CONSTANTS
   ================================================================ */

const SPG_PHONE_STORAGE_KEY = 'spgAgents.phoneNumber';

const MESSAGE_QUERY_PREFIX = 'messages';

const SPG_WS_EVENTS = [
  'message.received',
  'message.sent',
  'message.ack',
  'message.reaction',
  'message.revoked',
  'message.edited',
] as const;

/* ================================================================
   TYPES
   ================================================================ */

interface IncomingWsMessage {
  id: string;
  chatId: string;
  from: string;
  to: string;
  body: string;
  type: string;
  timestamp?: number;
  fromMe?: boolean;

  media?: MessageMedia;

  quotedMessage?: {
    id: string;
    body: string;
  };

  call?: {
    video: boolean;
    missed: boolean;
  };

  metadata?: ChatMessageView['metadata'];

  kind?: ChatKind;

  contact?: {
    id?: string;
    name?: string;
    pushName?: string;
  };

  author?: string;
}

/* ================================================================
   STORAGE HELPERS
   ================================================================ */

function readStoredSpgPhone(): string {
  try {
    if (typeof window === 'undefined') {
      return '';
    }

    return window.localStorage.getItem(SPG_PHONE_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function persistSpgPhone(phone: string): void {
  try {
    if (typeof window === 'undefined') {
      return;
    }

    if (phone) {
      window.localStorage.setItem(SPG_PHONE_STORAGE_KEY, phone);
    } else {
      window.localStorage.removeItem(SPG_PHONE_STORAGE_KEY);
    }
  } catch {
    /*
     * Storage failures must never break the SPG page.
     */
  }
}

/* ================================================================
   PHONE HELPERS
   ================================================================ */

function normalizePhone(phone?: string | null): string {
  if (!phone) {
    return '';
  }

  return phone.replace(/\D/g, '');
}

function phoneMatches(
  sessionPhone: string | null | undefined,
  requestedPhone: string,
): boolean {
  const sessionDigits = normalizePhone(sessionPhone);
  const requestedDigits = normalizePhone(requestedPhone);

  if (!sessionDigits || !requestedDigits) {
    return false;
  }

  return sessionDigits === requestedDigits;
}

/* ================================================================
   TIME / MESSAGE HELPERS
   ================================================================ */

function toUnixTimestamp(timestamp?: number): number {
  if (
    typeof timestamp === 'number' &&
    Number.isFinite(timestamp) &&
    timestamp > 0
  ) {
    return timestamp;
  }

  return Math.floor(Date.now() / 1000);
}

function mapIncomingWebSocketMessage(
  message: IncomingWsMessage,
): ChatMessageView {
  const timestamp = toUnixTimestamp(message.timestamp);

  return {
    id: message.id,
    waMessageId: message.id,
    chatId: message.chatId,

    chatName: message.contact?.pushName ?? message.contact?.name,
    author: message.author,
    from: message.from,
    to: message.to,
    body: message.body,

    type: asMessageType(message.type),
    direction: message.fromMe ? 'outgoing' : 'incoming',
    status: 'sent',

    timestamp,
    createdAt: new Date(timestamp * 1000).toISOString(),

    metadata:
      message.metadata || {
        media: message.media,
        quotedMessage: message.quotedMessage,
        call: message.call,
      },

    kind: message.kind,
  };
}

function isOwnReactionSender(
  sender: string,
  sessionPhone: string,
): boolean {
  if (sender === 'me') {
    return true;
  }

  if (!sessionPhone) {
    return false;
  }

  return sender.includes(sessionPhone);
}

/* ================================================================
   PAGE
   ================================================================ */

export function SpgAgents() {
  const { t, i18n } = useTranslation();

  const toast = useToast();
  const queryClient = useQueryClient();

  const { canWrite } = useRole();

  /* ================================================================
     STATE
     ================================================================ */

  const [searchedPhone, setSearchedPhone] = useState<string>(
    readStoredSpgPhone,
  );

  const [selectedSession, setSelectedSession] = useState<Session | null>(
    null,
  );

  const [searchingSession, setSearchingSession] = useState(false);

  const [sessionSearchError, setSessionSearchError] = useState<string | null>(
    null,
  );

  const [chats, setChats] = useState<Chat[]>([]);

  const [loadingChats, setLoadingChats] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');

  const [activeChat, setActiveChat] = useState<Chat | null>(null);

  const [messageInput, setMessageInput] = useState('');

  const [replyingTo, setReplyingTo] = useState<ChatMessageView | null>(null);

  const [attachment, setAttachment] = useState<StagedAttachment | null>(null);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  /* ================================================================
     DERIVED STATE
     ================================================================ */

  const selectedSessionId = selectedSession?.id ?? '';
  const activeChatId = activeChat?.id ?? null;

  /* ================================================================
     REFS
     ================================================================ */

  const isMountedRef = useRef(true);
  const restoredPhoneRef = useRef(false);

  const searchVersionRef = useRef(0);
  const loadChatsVersionRef = useRef(0);

  const selectedSessionIdRef = useRef(selectedSessionId);

  const chatsRef = useRef<Chat[]>([]);
  const activeChatIdRef = useRef<string | null>(null);
  const scrolledForChatIdRef = useRef<string | null>(null);

  const wasConnectedRef = useRef<boolean | null>(null);

  const failedActiveAvatarUrlRef = useRef<string | null>(null);

  /* ================================================================
     STABLE STATE HELPERS
     ================================================================ */

  const selectSession = useCallback((session: Session | null) => {
    selectedSessionIdRef.current = session?.id ?? '';
    setSelectedSession(session);
  }, []);

  const setChatsWithRef = useCallback<Dispatch<SetStateAction<Chat[]>>>(
    value => {
      setChats(previous => {
        const next =
          typeof value === 'function'
            ? (value as (prev: Chat[]) => Chat[])(previous)
            : value;

        chatsRef.current = next;

        return next;
      });
    },
    [],
  );

  const commitChats = useCallback((nextChats: Chat[]) => {
    chatsRef.current = nextChats;
    setChats(nextChats);
  }, []);

  const resetChatState = useCallback(() => {
    activeChatIdRef.current = null;
    scrolledForChatIdRef.current = null;

    setActiveChat(null);
    setReplyingTo(null);
    setAttachment(null);
    setPreviewUrl(null);
    setMessageInput('');
    setLightboxIndex(null);
    setSearchQuery('');
  }, []);

  /* ================================================================
     LIFECYCLE / STORAGE EFFECTS
     ================================================================ */

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    persistSpgPhone(searchedPhone);
  }, [searchedPhone]);

  useEffect(() => {
    failedActiveAvatarUrlRef.current = null;
  }, [activeChatId]);

  /* ================================================================
     MESSAGE QUERY
     ================================================================ */

  const {
    data: messages = [],
    isLoading: loadingMessages,
    isError: messagesError,
  } = useChatMessages(selectedSessionId, activeChatId);

  const { appendMessage, updateMessage } = useChatMessagesActions();

  /* ================================================================
     PROFILE PICTURES
     ================================================================ */

  const chatIds = useMemo(() => chats.map(chat => chat.id), [chats]);

  const listPics = useProfilePictures(
    selectedSessionId || undefined,
    chatIds,
  );

  const activePp = useProfilePicture(
    selectedSessionId || undefined,
    activeChatId ?? undefined,
  );

  /* ================================================================
     CHAT SCROLL
     ================================================================ */

  const {
    containerRef: messagesContainerRef,
    onMessageAppended,
    onMediaLoad,
  } = useChatScrollPosition(activeChatId, messages.length > 0);

  /* ================================================================
     LOAD CHATS
     ================================================================ */

  const loadChats = useCallback(
    async (sessionId: string) => {
      const requestId = ++loadChatsVersionRef.current;

      if (!sessionId) {
        commitChats([]);
        return;
      }

      setLoadingChats(true);

      try {
        const data = await sessionApi.getChats(sessionId);

        if (!isMountedRef.current || requestId !== loadChatsVersionRef.current) {
          return;
        }

        const sorted = [...data].sort(
          (a, b) => (b.timestamp || 0) - (a.timestamp || 0),
        );

        commitChats(sorted);
      } catch (err) {
        if (!isMountedRef.current || requestId !== loadChatsVersionRef.current) {
          return;
        }

        commitChats([]);

        toast.error(
          t('chats.errors.loadChats'),
          err instanceof Error ? err.message : undefined,
        );
      } finally {
        if (isMountedRef.current && requestId === loadChatsVersionRef.current) {
          setLoadingChats(false);
        }
      }
    },
    [commitChats, t, toast],
  );

  /* ================================================================
     SEARCH SESSION BY PHONE
     ================================================================ */

  const searchSession = useCallback(
    async (phone: string) => {
      const trimmedPhone = phone.trim();
      const version = ++searchVersionRef.current;

      setSearchingSession(true);
      setSessionSearchError(null);

      /*
       * Persist the searched phone immediately.
       *
       * Even if the search fails, the number remains in the field
       * after reopening the page.
       */
      setSearchedPhone(trimmedPhone);

      /*
       * A new search always starts a clean SPG workspace.
       */
      selectSession(null);
      commitChats([]);
      resetChatState();

      try {
        const sessions = await sessionApi.list();

        if (!isMountedRef.current || version !== searchVersionRef.current) {
          return;
        }

        const matchingSession =
          sessions.find(session =>
            phoneMatches(session.phone, trimmedPhone),
          ) ?? null;

        if (!matchingSession) {
          setSessionSearchError(
            t(
              'spgAgents.sessionNotFound',
              'No WhatsApp session was found for this phone number.',
            ),
          );

          return;
        }

        /*
         * Lock SPG to this exact session.
         */
        selectSession(matchingSession);

        await loadChats(matchingSession.id);
      } catch (err) {
        if (!isMountedRef.current || version !== searchVersionRef.current) {
          return;
        }

        const message =
          err instanceof Error
            ? err.message
            : t(
                'spgAgents.searchError',
                'Failed to search for the session.',
              );

        setSessionSearchError(message);

        toast.error(
          t('spgAgents.searchErrorTitle', 'Session Search Failed'),
          message,
        );
      } finally {
        if (isMountedRef.current && version === searchVersionRef.current) {
          setSearchingSession(false);
        }
      }
    },
    [commitChats, loadChats, resetChatState, selectSession, t, toast],
  );

  /* ================================================================
     RESTORE LAST SEARCHED PHONE
     ================================================================ */

  useEffect(() => {
    if (restoredPhoneRef.current) {
      return;
    }

    restoredPhoneRef.current = true;

    if (!searchedPhone) {
      return;
    }

    void searchSession(searchedPhone);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ================================================================
     CLEAR SESSION — GUI ONLY
     ================================================================ */

  const handleClearSession = useCallback(() => {
    const sessionIdToClear = selectedSessionIdRef.current;

    /*
     * IMPORTANT:
     *
     * This does NOT stop/logout/delete the real OpenWA session.
     * It only clears the loaded SPG workspace.
     */
    selectSession(null);
    commitChats([]);
    resetChatState();

    setSessionSearchError(null);
    setSearchedPhone('');

    if (sessionIdToClear) {
      queryClient.removeQueries({
        queryKey: [MESSAGE_QUERY_PREFIX, sessionIdToClear],
      });
    }
  }, [commitChats, queryClient, resetChatState, selectSession]);

  /* ================================================================
     REFRESH SESSION
     ================================================================ */

  const handleRefreshSession = useCallback(async () => {
    const sessionId = selectedSessionIdRef.current;

    if (!sessionId) {
      return;
    }

    try {
      const sessions = await sessionApi.list();

      if (!isMountedRef.current || selectedSessionIdRef.current !== sessionId) {
        return;
      }

      const fresh =
        sessions.find(session => session.id === sessionId) ?? null;

      if (!fresh) {
        selectSession(null);
        commitChats([]);
        resetChatState();

        return;
      }

      selectSession(fresh);

      if (fresh.status === 'ready') {
        await loadChats(fresh.id);
      } else {
        commitChats([]);
        resetChatState();
      }
    } catch (err) {
      toast.error(
        t('spgAgents.sessionRefreshError', 'Failed to refresh session.'),
        err instanceof Error ? err.message : undefined,
      );
    }
  }, [commitChats, loadChats, resetChatState, selectSession, t, toast]);

  /* ================================================================
     SESSION CARD ACTIONS
     ================================================================ */

  const handleViewSession = useCallback(
    (session: Session) => {
      selectSession(session);

      if (session.status === 'ready') {
        void loadChats(session.id);
      }
    },
    [loadChats, selectSession],
  );

  const handleStartSession = useCallback(
    async (session: Session) => {
      const sessionId = session.id;

      try {
        const updated = await sessionApi.start(sessionId);

        if (!isMountedRef.current || selectedSessionIdRef.current !== sessionId) {
          return;
        }

        selectSession(updated);

        const sessions = await sessionApi.list();

        if (!isMountedRef.current || selectedSessionIdRef.current !== sessionId) {
          return;
        }

        const fresh =
          sessions.find(current => current.id === sessionId) ?? updated;

        selectSession(fresh);

        if (fresh.status === 'ready') {
          await loadChats(fresh.id);
        } else {
          commitChats([]);
          resetChatState();
        }
      } catch (err) {
        toast.error(
          t('spgAgents.startSessionError', 'Failed to start session.'),
          err instanceof Error ? err.message : undefined,
        );

        await handleRefreshSession();
      }
    },
    [
      commitChats,
      handleRefreshSession,
      loadChats,
      resetChatState,
      selectSession,
      t,
      toast,
    ],
  );

  const handleStopSession = useCallback(
    async (session: Session) => {
      const sessionId = session.id;

      try {
        const updated = await sessionApi.stop(sessionId);

        if (!isMountedRef.current || selectedSessionIdRef.current !== sessionId) {
          return;
        }

        selectSession(updated);
        commitChats([]);
        resetChatState();
      } catch (err) {
        toast.error(
          t('spgAgents.stopSessionError', 'Failed to stop session.'),
          err instanceof Error ? err.message : undefined,
        );

        await handleRefreshSession();
      }
    },
    [
      commitChats,
      handleRefreshSession,
      resetChatState,
      selectSession,
      t,
      toast,
    ],
  );

  const handleUnlinkSession = useCallback(
    async (session: Session) => {
      const sessionId = session.id;

      try {
        const updated = await sessionApi.logout(sessionId);

        if (!isMountedRef.current || selectedSessionIdRef.current !== sessionId) {
          return;
        }

        selectSession(updated);
        commitChats([]);
        resetChatState();
      } catch (err) {
        toast.error(
          t('spgAgents.logoutSessionError', 'Failed to logout session.'),
          err instanceof Error ? err.message : undefined,
        );

        await handleRefreshSession();
      }
    },
    [
      commitChats,
      handleRefreshSession,
      resetChatState,
      selectSession,
      t,
      toast,
    ],
  );

  const handleDeleteSession = useCallback(
    async (session: Session) => {
      try {
        await sessionApi.delete(session.id);

        if (!isMountedRef.current) {
          return;
        }

        if (selectedSessionIdRef.current === session.id) {
          handleClearSession();
        }

        toast.success(t('spgAgents.deleteSuccess', 'Session deleted.'));
      } catch (err) {
        toast.error(
          t('spgAgents.deleteError', 'Failed to delete session.'),
          err instanceof Error ? err.message : undefined,
        );
      }
    },
    [handleClearSession, t, toast],
  );

  const handleForceKillSession = useCallback(
    async (session: Session) => {
      const sessionId = session.id;

      try {
        const updated = await sessionApi.forceKill(sessionId);

        if (!isMountedRef.current || selectedSessionIdRef.current !== sessionId) {
          return;
        }

        selectSession(updated);
        commitChats([]);
        resetChatState();

        toast.success(t('spgAgents.forceKillSuccess', 'Session stopped.'));
      } catch (err) {
        toast.error(
          t('spgAgents.forceKillError', 'Failed to stop the session.'),
          err instanceof Error ? err.message : undefined,
        );

        await handleRefreshSession();
      }
    },
    [
      commitChats,
      handleRefreshSession,
      resetChatState,
      selectSession,
      t,
      toast,
    ],
  );

  const handleShowQR = useCallback(
    async (_session: Session) => {
      await handleRefreshSession();
    },
    [handleRefreshSession],
  );

  /* ================================================================
     CHAT TIME FORMATTING
     ================================================================ */

  const timeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        hour: '2-digit',
        minute: '2-digit',
      }),
    [i18n.language],
  );

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        month: 'short',
        day: 'numeric',
      }),
    [i18n.language],
  );

  const formatChatTime = useCallback(
    (timestamp?: number) => {
      if (!timestamp || !Number.isFinite(timestamp)) {
        return '';
      }

      const date = new Date(timestamp * 1000);

      if (Number.isNaN(date.getTime())) {
        return '';
      }

      const today = new Date();

      if (date.toDateString() === today.toDateString()) {
        return timeFormatter.format(date);
      }

      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      if (date.toDateString() === yesterday.toDateString()) {
        return t('chats.yesterday');
      }

      return dateFormatter.format(date);
    },
    [dateFormatter, t, timeFormatter],
  );

  /* ================================================================
     CHAT FILTER
     ================================================================ */

  const filteredChats = useMemo(
    () => filterChats(chats, searchQuery),
    [chats, searchQuery],
  );

  /* ================================================================
     CHAT SELECTION
     ================================================================ */

  const handleSelectChat = useCallback((chat: Chat | null) => {
    activeChatIdRef.current = chat?.id ?? null;
    scrolledForChatIdRef.current = null;

    setActiveChat(chat);
  }, []);

  const handleBackToChats = useCallback(() => {
    activeChatIdRef.current = null;
    scrolledForChatIdRef.current = null;

    setActiveChat(null);
  }, []);

  /* ================================================================
     MARK CHAT READ
     ================================================================ */

  const markChatRead = useCallback(
    (chatId: string) => {
      const sessionId = selectedSessionIdRef.current;

      if (!sessionId) {
        return;
      }

      void sessionApi.markChatRead(sessionId, chatId).catch(err => {
        toast.warning(
          t('chats.errors.markRead'),
          err instanceof Error ? err.message : undefined,
        );
      });
    },
    [t, toast],
  );

  useEffect(() => {
    if (!activeChatId) {
      return;
    }

    markChatRead(activeChatId);

    setChatsWithRef(previous =>
      previous.map(chat =>
        chat.id === activeChatId
          ? {
              ...chat,
              unreadCount: 0,
            }
          : chat,
      ),
    );
  }, [activeChatId, markChatRead, setChatsWithRef]);

  /* ================================================================
     LIGHTBOX ITEMS
     ================================================================ */

  const imageMedia = useMemo<LightboxItem[]>(() => {
    return messages.reduce<LightboxItem[]>((acc, message) => {
      if (message.type !== 'image') {
        return acc;
      }

      const mediaUrl = getMediaSrc(message.metadata?.media);

      if (!mediaUrl) {
        return acc;
      }

      const fallbackTimestamp = message.createdAt
        ? Math.floor(new Date(message.createdAt).getTime() / 1000)
        : undefined;

      const resolvedTimestamp =
        typeof message.timestamp === 'number' &&
        Number.isFinite(message.timestamp)
          ? message.timestamp
          : typeof fallbackTimestamp === 'number' &&
              Number.isFinite(fallbackTimestamp)
            ? fallbackTimestamp
            : undefined;

      acc.push({
        id: message.id,
        url: mediaUrl,
        alt:
          message.body ||
          message.metadata?.media?.filename ||
          '',
        senderName: undefined,
        timestamp: formatChatTime(resolvedTimestamp),
      });

      return acc;
    }, []);
  }, [formatChatTime, messages]);

  const handleOpenImage = useCallback(
    (messageId: string) => {
      const index = imageMedia.findIndex(item => item.id === messageId);

      if (index >= 0) {
        setLightboxIndex(index);
      }
    },
    [imageMedia],
  );

  /* ================================================================
     MESSAGE CACHE HELPERS
     ================================================================ */

  const updateMessageCaches = useCallback(
    (
      sessionId: string,
      updater: (messages: ChatMessageView[]) => ChatMessageView[],
    ) => {
      const caches = queryClient.getQueriesData<ChatMessageView[]>({
        queryKey: [MESSAGE_QUERY_PREFIX, sessionId],
      });

      for (const [key, list] of caches) {
        if (!list) {
          continue;
        }

        const next = updater(list);

        if (next !== list) {
          queryClient.setQueryData(key, next);
        }
      }
    },
    [queryClient],
  );

  /* ================================================================
     REACTION
     ================================================================ */

  const handleReactMessage = useCallback(
    async (msg: ChatMessageView, emoji: string) => {
      if (!selectedSessionId || !activeChat) {
        return;
      }

      const messageId = msg.waMessageId || msg.id;

      const currentReactions = msg.metadata?.reactions || {};
      const sessionPhone = normalizePhone(selectedSession?.phone);

      let alreadyReacted = false;

      for (const [sender, reactionEmoji] of Object.entries(currentReactions)) {
        if (
          isOwnReactionSender(sender, sessionPhone) &&
          reactionEmoji === emoji
        ) {
          alreadyReacted = true;
          break;
        }
      }

      const emojiToSend = alreadyReacted ? '' : emoji;

      const key = messagesQueryKey(selectedSessionId, activeChat.id);
      const previous = queryClient.getQueryData<ChatMessageView[]>(key);

      const applyOptimisticReaction = (
        list?: ChatMessageView[],
      ): ChatMessageView[] =>
        (list || []).map(message => {
          if (message.id !== msg.id && message.waMessageId !== msg.waMessageId) {
            return message;
          }

          const metadata = message.metadata || {};
          const reactions = {
            ...(metadata.reactions || {}),
          };

          if (emojiToSend === '') {
            delete reactions.me;
          } else {
            reactions.me = emojiToSend;
          }

          return {
            ...message,
            metadata: {
              ...metadata,
              reactions,
            },
          };
        });

      queryClient.setQueryData(key, applyOptimisticReaction(previous));

      try {
        await messageApi.react(selectedSessionId, {
          chatId: activeChat.id,
          messageId,
          emoji: emojiToSend,
        });
      } catch (err) {
        queryClient.setQueryData(key, previous ?? []);

        toast.error(
          t('chats.errors.react'),
          err instanceof Error ? err.message : undefined,
        );
      }
    },
    [
      activeChat,
      queryClient,
      selectedSession?.phone,
      selectedSessionId,
      t,
      toast,
    ],
  );

  /* ================================================================
     DELETE MESSAGE
     ================================================================ */

  const handleDeleteMessage = useCallback(
    async (msg: ChatMessageView) => {
      if (!selectedSessionId || !activeChat) {
        return;
      }

      if (typeof window === 'undefined') {
        return;
      }

      if (!window.confirm(t('chats.deleteConfirm'))) {
        return;
      }

      const messageId = msg.waMessageId || msg.id;

      try {
        await messageApi.delete(selectedSessionId, {
          chatId: activeChat.id,
          messageId,
          forEveryone: true,
        });

        updateMessage(selectedSessionId, activeChat.id, msg.id, {
          body: '',
          type: 'revoked',
        });
      } catch (err) {
        toast.error(
          t('chats.errors.delete'),
          err instanceof Error ? err.message : undefined,
        );
      }
    },
    [activeChat, selectedSessionId, t, toast, updateMessage],
  );

  /* ================================================================
     WEBSOCKET — INCOMING MESSAGE
     ================================================================ */

  const handleIncomingMessage = useCallback(
    (event: {
      sessionId: string;
      message: Record<string, unknown>;
    }) => {
      /*
       * Critical isolation guard:
       * events belonging to another session are ignored.
       */
      if (event.sessionId !== selectedSessionIdRef.current) {
        return;
      }

      const incoming = event.message as unknown as IncomingWsMessage;

      const mappedMessage = mapIncomingWebSocketMessage(incoming);

      appendMessage(event.sessionId, incoming.chatId, mappedMessage);

      const currentActiveChatId = activeChatIdRef.current;

      if (currentActiveChatId === incoming.chatId) {
        markChatRead(incoming.chatId);

        if (!incoming.fromMe) {
          onMessageAppended('incoming');
        }
      }

      const result = applyIncomingToChatList(
        chatsRef.current,
        incoming,
        {
          activeChatId: currentActiveChatId ?? undefined,
          locationLabel: `📍 ${t('chats.media.location', 'Location')}`,
        },
      );

      commitChats(result.chats);

      if (result.needsSidebarRefetch) {
        void loadChats(event.sessionId);
      }
    },
    [
      appendMessage,
      commitChats,
      loadChats,
      markChatRead,
      onMessageAppended,
      t,
    ],
  );

  /* ================================================================
     WEBSOCKET — MESSAGE ACK
     ================================================================ */

  const handleIncomingMessageAck = useCallback(
    (event: {
      sessionId: string;
      messageId: string;
      status: ChatMessageView['status'];
    }) => {
      if (event.sessionId !== selectedSessionIdRef.current) {
        return;
      }

      updateMessageCaches(event.sessionId, list => {
        const index = list.findIndex(
          message =>
            message.id === event.messageId ||
            message.waMessageId === event.messageId,
        );

        if (index === -1) {
          return list;
        }

        const target = list[index];

        const nextStatus =
          mergeDeliveryStatus(target.status, event.status) ?? target.status;

        if (nextStatus === target.status) {
          return list;
        }

        const next = list.slice();

        next[index] = {
          ...target,
          status: nextStatus,
        };

        return next;
      });
    },
    [updateMessageCaches],
  );

  /* ================================================================
     WEBSOCKET — MESSAGE REACTION
     ================================================================ */

  const handleIncomingMessageReaction = useCallback(
    (event: {
      sessionId: string;
      messageId: string;
      reactions?: Record<string, string>;
    }) => {
      if (event.sessionId !== selectedSessionIdRef.current) {
        return;
      }

      updateMessageCaches(event.sessionId, list => {
        const index = list.findIndex(
          message =>
            message.id === event.messageId ||
            message.waMessageId === event.messageId,
        );

        if (index === -1) {
          return list;
        }

        const target = list[index];

        const next = list.slice();

        next[index] = {
          ...target,
          metadata: {
            ...(target.metadata || {}),
            reactions: mergeReactionSnapshot(
              target.metadata?.reactions,
              event.reactions,
            ),
          },
        };

        return next;
      });
    },
    [updateMessageCaches],
  );

  /* ================================================================
     WEBSOCKET — MESSAGE REVOKED
     ================================================================ */

  const handleIncomingMessageRevoked = useCallback(
    (event: {
      sessionId: string;
      id: string;
      revokedId?: string;
      type: string;
    }) => {
      if (event.sessionId !== selectedSessionIdRef.current) {
        return;
      }

      updateMessageCaches(event.sessionId, list => {
        const index = findRevokedIndex(list, event);

        if (index === -1) {
          return list;
        }

        const target = list[index];

        const next = list.slice();

        next[index] = {
          ...target,
          body: '',
          type: asMessageType(event.type),
        };

        return next;
      });
    },
    [updateMessageCaches],
  );

  /* ================================================================
     WEBSOCKET — MESSAGE EDITED
     ================================================================ */

  const handleIncomingMessageEdited = useCallback(
    (event: {
      sessionId: string;
      messageId: string;
      chatId: string;
      body: string;
    }) => {
      if (event.sessionId !== selectedSessionIdRef.current) {
        return;
      }

      const caches = queryClient.getQueriesData<ChatMessageView[]>({
        queryKey: [MESSAGE_QUERY_PREFIX, event.sessionId],
      });

      let editedLastMessage = false;
      let matchedCachedMessage = false;

      for (const [key, list] of caches) {
        if (!list) {
          continue;
        }

        const next = applyMessageEdit(list, event);

        if (next === list) {
          continue;
        }

        matchedCachedMessage = true;

        queryClient.setQueryData(key, next);

        const cachedChatId =
          Array.isArray(key) && typeof key[2] === 'string'
            ? key[2]
            : undefined;

        const editedIndex = list.findIndex(
          message =>
            message.id === event.messageId ||
            message.waMessageId === event.messageId,
        );

        if (cachedChatId === event.chatId && editedIndex === list.length - 1) {
          editedLastMessage = true;
        }
      }

      if (editedLastMessage) {
        setChatsWithRef(previous =>
          previous.map(chat =>
            chat.id === event.chatId
              ? {
                  ...chat,
                  lastMessage: event.body,
                }
              : chat,
          ),
        );
      } else if (!matchedCachedMessage) {
        void loadChats(selectedSessionIdRef.current);
      }
    },
    [loadChats, queryClient, setChatsWithRef],
  );

  /* ================================================================
     WEBSOCKET HOOK
     ================================================================ */

  const wsEvents = useMemo(
    () => ({
      onMessage: handleIncomingMessage,
      onMessageAck: handleIncomingMessageAck,
      onMessageReaction: handleIncomingMessageReaction,
      onMessageRevoked: handleIncomingMessageRevoked,
      onMessageEdited: handleIncomingMessageEdited,
    }),
    [
      handleIncomingMessage,
      handleIncomingMessageAck,
      handleIncomingMessageEdited,
      handleIncomingMessageReaction,
      handleIncomingMessageRevoked,
    ],
  );

  const {
    isConnected,
    connectionFailed,
    reconnect,
    subscribe,
    unsubscribe,
  } = useWebSocket(wsEvents);

  /* ================================================================
     SUBSCRIBE ONLY TO THE LOCKED SESSION
     ================================================================ */

  useEffect(() => {
    if (!selectedSessionId || !isConnected) {
      return undefined;
    }

    subscribe(selectedSessionId, [...SPG_WS_EVENTS]);

    return () => {
      unsubscribe(selectedSessionId);
    };
  }, [isConnected, selectedSessionId, subscribe, unsubscribe]);

  /* ================================================================
     RESYNC AFTER RECONNECT
     ================================================================ */

  useEffect(() => {
    if (!selectedSessionId) {
      wasConnectedRef.current = null;
      return;
    }

    if (wasConnectedRef.current === false && isConnected) {
      void queryClient.invalidateQueries({
        queryKey: [MESSAGE_QUERY_PREFIX, selectedSessionId],
      });

      void loadChats(selectedSessionId);
    }

    wasConnectedRef.current = isConnected;
  }, [isConnected, loadChats, queryClient, selectedSessionId]);

  /* ================================================================
     RESET CHAT STATE WHEN SESSION CHANGES
     ================================================================ */

  useEffect(() => {
    resetChatState();
  }, [resetChatState, selectedSessionId]);

  /* ================================================================
     INITIAL SCROLL TO BOTTOM WHEN OPENING A CHAT
     ================================================================ */

  useLayoutEffect(() => {
    if (!activeChatId) {
      scrolledForChatIdRef.current = null;
      return;
    }

    if (loadingMessages || messages.length === 0) {
      return;
    }

    if (scrolledForChatIdRef.current === activeChatId) {
      return;
    }

    const container = messagesContainerRef.current;

    if (!container) {
      return;
    }

    scrolledForChatIdRef.current = activeChatId;

    container.scrollTo({
      top: container.scrollHeight,
    });
  }, [activeChatId, loadingMessages, messages.length, messagesContainerRef]);

  /* ================================================================
     SESSION READINESS
     ================================================================ */

  const sessionReady = selectedSession?.status === 'ready';

  /* ================================================================
     NO-OP HANDLERS FOR LOCKED UI AREAS
     ================================================================ */

  const noop = useCallback(() => {}, []);

  /* ================================================================
     DISABLED CHANNEL QUERY
     ================================================================ */

  const spgChannelsQuery = useQuery<Channel[], Error>({
    queryKey: ['spg-disabled-channels'],
    queryFn: async () => [],
    enabled: false,
    retry: false,
    staleTime: Infinity,
  });

  /* ================================================================
     SIDEBAR TAB PROPS
     ================================================================ */

  const chatsTab = useMemo(
    () => ({
      loading: loadingChats,
      chats: filteredChats,
      activeChatId: activeChatId ?? undefined,
      pictures: listPics.data,
      onSelectChat: handleSelectChat,
    }),
    [
      activeChatId,
      filteredChats,
      handleSelectChat,
      listPics.data,
      loadingChats,
    ],
  );

  const channelsTab = useMemo(
    () => ({
      engineLoading: false,
      supported: false,
      query: spgChannelsQuery,
      channels: [] as Channel[],
      activeChannelId: undefined,
      onSelectChannel: noop,
    }),
    [noop, spgChannelsQuery],
  );

  const statusTab = useMemo(
    () => ({
      loading: false,
      error: false,
      groups: [],
      activeContactId: null,
      onSelectContact: noop,
    }),
    [noop],
  );

  /* ================================================================
     RENDER
     ================================================================ */

  return (
    <div className="spg-agents-page chats-page">
      {/* ==========================================================
          HEADER
         ========================================================== */}

      <header className="spg-agents-header">
        <div>
          <h1>{t('spgAgents.title', 'SPG Agents')}</h1>

          <p>
            {t(
              'spgAgents.description',
              'Search for an agent by WhatsApp phone number.',
            )}
          </p>
        </div>
      </header>

      {/* ==========================================================
          PHONE SEARCH
         ========================================================== */}

      <section
        className="spg-search-section"
        aria-busy={searchingSession}
      >
        <PhoneSearch
          key={searchedPhone || 'spg-empty-phone'}
          onSearch={searchSession}
          initialValue={searchedPhone}
          disabled={searchingSession}
        />

        {sessionSearchError && (
          <div className="spg-search-error" role="alert">
            <AlertCircle size={18} />
            <span>{sessionSearchError}</span>
          </div>
        )}
      </section>

      {/* ==========================================================
          SEARCHING
         ========================================================== */}

      {searchingSession && (
        <div
          className="spg-loading-state"
          role="status"
          aria-live="polite"
        >
          <Loader2 size={28} className="animate-spin" />

          <span>
            {t('spgAgents.searching', 'Searching for session...')}
          </span>
        </div>
      )}

      {/* ==========================================================
          SESSION + CHAT WORKSPACE
        ========================================================== */}

      {selectedSession && !searchingSession && (
        <section className="spg-workspace">
          {/* CHAT BOX */}
          {sessionReady && (
            <div className="spg-chat-grid-item">
              {connectionFailed && (
                <div className="chats-reconnect-banner" role="alert">
                  <AlertCircle size={16} />
                  <span>{t('common.disconnected', 'Disconnected')}</span>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={reconnect}
                  >
                    {t('common.refresh', 'Refresh')}
                  </button>
                </div>
              )}

              <div
                className={`chats-layout ${
                  activeChat ? 'has-active-chat' : ''
                }`}
              >
                <ChatSidebar
                  sessions={[selectedSession]}
                  selectedSessionId={selectedSession.id}
                  onSelectSession={noop}
                  lockedSession
                  activeTab="chats"
                  onSwitchTab={noop}
                  searchQuery={searchQuery}
                  onSearchQueryChange={setSearchQuery}
                  onComposeStatus={noop}
                  formatChatTime={formatChatTime}
                  chatsTab={chatsTab}
                  channelsTab={channelsTab}
                  statusTab={statusTab}
                />

                <main className="chats-room">
                  {activeChat ? (
                    <div className="room-container">
                      {/* ===============================
                          ROOM HEADER
                         =============================== */}
                      <header className="room-header">
                        <button
                          type="button"
                          className="room-back"
                          onClick={handleBackToChats}
                          aria-label={t('common.back', 'Back')}
                        >
                          <ArrowLeft size={20} />
                        </button>

                        <div className="room-avatar">
                          {activePp.data ? (
                            <img
                              src={activePp.data}
                              alt={activeChat.name || ''}
                              onError={() => {
                                if (
                                  activePp.data &&
                                  failedActiveAvatarUrlRef.current !==
                                    activePp.data
                                ) {
                                  failedActiveAvatarUrlRef.current =
                                    activePp.data;
                                  void activePp.refetch();
                                }
                              }}
                            />
                          ) : (
                            <KindIcon kind={activeChat.kind} />
                          )}
                        </div>

                        <div className="room-contact-info">
                          <h3>
                            {activeChat.name || activeChat.id.split('@')[0]}
                          </h3>

                          <span className="room-contact-phone">
                            {activeChat.isGroup
                              ? t('chats.groupSubtitle', 'Group')
                              : t(
                                  'chats.privateContactSubtitle',
                                  'Private contact',
                                )}
                          </span>

                          <span
                            className="room-contact-jid"
                            title={activeChat.id}
                          >
                            {activeChat.id}
                          </span>
                        </div>
                      </header>

                      {/* ===============================
                          MESSAGE THREAD
                         =============================== */}
                      <ChatThread
                        sessionId={selectedSession.id}
                        activeChat={activeChat}
                        messages={messages}
                        loadingMessages={loadingMessages}
                        messagesError={messagesError}
                        messagesContainerRef={messagesContainerRef}
                        onMediaLoad={onMediaLoad}
                        onOpenImage={handleOpenImage}
                        onReply={setReplyingTo}
                        onReact={handleReactMessage}
                        onDelete={handleDeleteMessage}
                      />

                      {/* ===============================
                          COMPOSER
                         =============================== */}
                      <ChatComposer
                        selectedSessionId={selectedSession.id}
                        activeChat={activeChat}
                        replyingTo={replyingTo}
                        setReplyingTo={setReplyingTo}
                        onMessageAppended={onMessageAppended}
                        setChats={setChatsWithRef}
                        messageInput={messageInput}
                        setMessageInput={setMessageInput}
                        attachment={attachment}
                        setAttachment={setAttachment}
                        previewUrl={previewUrl}
                        setPreviewUrl={setPreviewUrl}
                      />
                    </div>
                  ) : (
                    <div className="chats-room-placeholder">
                      <MessageSquare size={80} className="placeholder-icon" />
                      <h2>{t('spgAgents.selectChatTitle', 'Select a chat')}</h2>
                      <p>
                        {t(
                          'spgAgents.selectChatDescription',
                          'Choose a conversation from the list to start messaging.',
                        )}
                      </p>
                    </div>
                  )}
                </main>
              </div>
            </div>
          )}

          {/* SESSION CARD UNDER CHAT */}
          <div className="spg-session-grid-item">
            <div className="spg-session-toolbar">
              <div className="spg-session-toolbar-info">
                <span className="spg-session-toolbar-label">
                  {t('spgAgents.loadedSession', 'Loaded Session')}
                </span>

                <span className="spg-session-toolbar-phone">
                  {selectedSession.phone || searchedPhone}
                </span>

                <button
                  type="button"
                  className="spg-remove-session-btn"
                  onClick={handleClearSession}
                  disabled={searchingSession}
                  aria-label={t('spgAgents.removeSession', 'Remove')}
                  title={t('spgAgents.removeSession', 'Remove')}
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            <SessionCard
              session={selectedSession}
              canWrite={canWrite}
              onView={handleViewSession}
              onStart={session => void handleStartSession(session)}
              onStop={session => void handleStopSession(session)}
              onUnlink={session => void handleUnlinkSession(session)}
              onDelete={session => void handleDeleteSession(session)}
              onForceKill={session => void handleForceKillSession(session)}
              onShowQR={session => void handleShowQR(session)}
            />
          </div>
        </section>
      )}

      {/* ==========================================================
          NO SESSION RESULT
         ========================================================== */}

      {!selectedSession &&
        !searchingSession &&
        searchedPhone &&
        sessionSearchError && (
          <div className="spg-empty-state">
            <AlertCircle size={40} />
            <h2>{t('spgAgents.noSession', 'No session found')}</h2>
            <p>{sessionSearchError}</p>
          </div>
        )}

      {/* ==========================================================
          MEDIA LIGHTBOX
         ========================================================== */}

      <MediaLightbox
        items={imageMedia}
        index={lightboxIndex}
        onClose={() => setLightboxIndex(null)}
        onNavigate={setLightboxIndex}
      />
    </div>
  );
}