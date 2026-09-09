


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

import {
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import {
  useTranslation,
} from 'react-i18next';

import {
  AlertCircle,
  ArrowLeft,
  Loader2,
  MessageSquare,
  Play,
  RefreshCw,
  Skull,
  Smartphone,
  Square,
  Unlink,
  UserRound,
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
  queryKeys,
  useAgentMeQuery,
  useSessionsQuery,
} from '../hooks/queries';

import {
  useRole,
} from '../hooks/useRole';

import {
  useDocumentTitle,
} from '../hooks/useDocumentTitle';

import {
  type MessageMedia,
} from '../utils/chatMessages';

import {
  applyIncomingToChatList,
} from '../utils/chatList';

import {
  applyMessageEdit,
  findRevokedIndex,
  mergeDeliveryStatus,
  mergeReactionSnapshot,
  getMediaSrc,
  type ChatMessageView,
} from '../utils/chatMessages';

import {
  filterChats,
} from '../utils/chatFilters';

import {
  useWebSocket,
} from '../hooks/useWebSocket';

import {
  useChatMessages,
  useChatMessagesActions,
  messagesQueryKey,
} from '../hooks/useChatMessages';

import {
  useChatScrollPosition,
} from '../hooks/useChatScrollPosition';

import {
  useProfilePicture,
} from '../hooks/useProfilePicture';

import {
  useProfilePictures,
} from '../hooks/useProfilePictures';

import {
  useToast,
} from '../hooks/useToast';

import {
  useMarkChatRead,
} from '../hooks/useMarkChatRead';

import {
  canForceKillSession,
  canUnlinkSession,
  classifyUnlinkError,
  isSessionStarted,
} from '../utils/sessionActions';

import ChatSidebar from '../components/chats/ChatSidebar';

import ChatThread from '../components/chats/ChatThread';

import ChatComposer, {
  type StagedAttachment,
} from '../components/chats/ChatComposer';

import MediaLightbox, {
  type LightboxItem,
} from '../components/chats/MediaLightbox';

import KindIcon from '../components/chats/KindIcon';

import './Chats.css';
import './Agent.css';

/* ================================================================
   CONSTANTS
   ================================================================ */

const MESSAGE_QUERY_PREFIX =
  'messages';

const AGENT_WS_EVENTS = [
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

  metadata?:
    ChatMessageView['metadata'];

  kind?: ChatKind;

  contact?: {
    id?: string;
    name?: string;
    pushName?: string;
  };

  author?: string;
}

/* ================================================================
   HELPERS
   ================================================================ */

function normalizePhone(
  phone?: string | null,
): string {
  if (!phone) {
    return '';
  }

  return phone.replace(
    /\D/g,
    '',
  );
}

function toUnixTimestamp(
  timestamp?: number,
): number {
  if (
    typeof timestamp ===
      'number' &&
    Number.isFinite(
      timestamp,
    ) &&
    timestamp > 0
  ) {
    return timestamp;
  }

  return Math.floor(
    Date.now() /
      1000,
  );
}

function mapIncomingWebSocketMessage(
  message: IncomingWsMessage,
): ChatMessageView {
  const timestamp =
    toUnixTimestamp(
      message.timestamp,
    );

  return {
    id:
      message.id,
    waMessageId:
      message.id,
    chatId:
      message.chatId,

    chatName:
      message.contact?.pushName ??
      message.contact?.name,

    author:
      message.author,

    from:
      message.from,

    to:
      message.to,

    body:
      message.body,

    type:
      asMessageType(
        message.type,
      ),

    direction:
      message.fromMe
        ? 'outgoing'
        : 'incoming',

    status:
      'sent',

    timestamp,

    createdAt:
      new Date(
        timestamp *
          1000,
      ).toISOString(),

    metadata:
      message.metadata || {
        media:
          message.media,
        quotedMessage:
          message.quotedMessage,
        call:
          message.call,
      },

    kind:
      message.kind,
  };
}

function isOwnReactionSender(
  sender: string,
  sessionPhone: string,
): boolean {
  if (
    sender ===
    'me'
  ) {
    return true;
  }

  if (!sessionPhone) {
    return false;
  }

  return sender.includes(
    sessionPhone,
  );
}

function statusLabel(
  status: string,
): string {
  return status
    .replaceAll(
      '_',
      ' ',
    )
    .replace(
      /\b\w/g,
      value =>
        value.toUpperCase(),
    );
}

function templateQuotaLabel(
  limit: number | null,
): string {
  if (limit === null) {
    return 'Unlimited';
  }

  if (limit === 0) {
    return 'Disabled';
  }

  return `${limit} / 24h`;
}

type AgentSessionAction =
  | 'start'
  | 'stop'
  | 'logout'
  | 'force-kill';

/* ================================================================
   PAGE
   ================================================================ */

export function Agent() {
  const {
    t,
    i18n,
  } =
    useTranslation();

  useDocumentTitle(
    t(
      'agent.title',
      'Agent',
    ),
  );

  const toast =
    useToast();

  const queryClient =
    useQueryClient();

  const {
    canStartSessions,
    canShutdownSessions,
  } =
    useRole();

  /**
   * Authoritative Agent identity.
   *
   * The browser never submits an agentId. The backend resolves the
   * principal from the authenticated AGENT API key.
   */
  const agentQuery =
    useAgentMeQuery();

  /**
   * The backend scopes this list according to the authenticated Agent's
   * assignment. We only use the list to resolve the assignedSessionId
   * returned by /agent/me.
   */
  const sessionsQuery =
    useSessionsQuery();

  const agent =
    agentQuery.data;

  const sessions =
    sessionsQuery.data ??
    [];

  const assignedSessionId =
    agent?.assignedSessionId ??
    '';

  const assignedSession =
    useMemo(
      () =>
        assignedSessionId
          ? sessions.find(
              session =>
                session.id ===
                assignedSessionId,
            ) ??
            null
          : null,
      [
        assignedSessionId,
        sessions,
      ],
    );

  const selectedSessionId =
    assignedSession?.id ??
    '';

  const sessionReady =
    assignedSession?.status ===
    'ready';

  /* ================================================================
     STATE
     ================================================================ */

  const [
    chats,
    setChats,
  ] =
    useState<Chat[]>(
      [],
    );

  const [
    loadingChats,
    setLoadingChats,
  ] =
    useState(false);

  const [
    searchQuery,
    setSearchQuery,
  ] =
    useState('');

  const [
    activeChat,
    setActiveChat,
  ] =
    useState<Chat | null>(
      null,
    );

  const [
    messageInput,
    setMessageInput,
  ] =
    useState('');

  const [
    replyingTo,
    setReplyingTo,
  ] =
    useState<ChatMessageView | null>(
      null,
    );

  const [
    attachment,
    setAttachment,
  ] =
    useState<StagedAttachment | null>(
      null,
    );

  const [
    previewUrl,
    setPreviewUrl,
  ] =
    useState<string | null>(
      null,
    );

  const [
    lightboxIndex,
    setLightboxIndex,
  ] =
    useState<number | null>(
      null,
    );

  const [
    sessionAction,
    setSessionAction,
  ] =
    useState<AgentSessionAction | null>(
      null,
    );

  const activeChatId =
    activeChat?.id ??
    null;

  const {
    markChatRead,
  } =
    useMarkChatRead(
      selectedSessionId ||
        undefined,
      {
        errorTitle:
          t(
            'chats.errors.markRead',
          ),
      },
    );

  /* ================================================================
     REFS
     ================================================================ */

  const isMountedRef =
    useRef(true);

  const loadChatsVersionRef =
    useRef(0);

  const selectedSessionIdRef =
    useRef(
      selectedSessionId,
    );

  const chatsRef =
    useRef<Chat[]>(
      [],
    );

  const activeChatIdRef =
    useRef<string | null>(
      null,
    );

  const scrolledForChatIdRef =
    useRef<string | null>(
      null,
    );

  const wasConnectedRef =
    useRef<
      boolean | null
    >(
      null,
    );

  const failedActiveAvatarUrlRef =
    useRef<
      string | null
    >(
      null,
    );

  /* ================================================================
     STABLE STATE HELPERS
     ================================================================ */

  const setChatsWithRef =
    useCallback<
      Dispatch<
        SetStateAction<
          Chat[]
        >
      >
    >(
      value => {
        setChats(
          previous => {
            const next =
              typeof value ===
              'function'
                ? (
                    value as (
                      prev: Chat[],
                    ) => Chat[]
                  )(
                    previous,
                  )
                : value;

            chatsRef.current =
              next;

            return next;
          },
        );
      },
      [],
    );

  const commitChats =
    useCallback(
      (
        nextChats:
          Chat[],
      ) => {
        chatsRef.current =
          nextChats;

        setChats(
          nextChats,
        );
      },
      [],
    );

  const resetChatState =
    useCallback(() => {
      activeChatIdRef.current =
        null;

      scrolledForChatIdRef.current =
        null;

      setActiveChat(
        null,
      );

      setReplyingTo(
        null,
      );

      setAttachment(
        null,
      );

      setPreviewUrl(
        null,
      );

      setMessageInput(
        '',
      );

      setLightboxIndex(
        null,
      );

      setSearchQuery(
        '',
      );
    }, []);

  /* ================================================================
     LIFECYCLE
     ================================================================ */

  useEffect(() => {
    isMountedRef.current =
      true;

    return () => {
      isMountedRef.current =
        false;
    };
  }, []);

  useEffect(() => {
    selectedSessionIdRef.current =
      selectedSessionId;
  }, [
    selectedSessionId,
  ]);

  useEffect(() => {
    failedActiveAvatarUrlRef.current =
      null;
  }, [
    activeChatId,
  ]);

  /* ================================================================
     MESSAGE QUERY
     ================================================================ */

  const {
    data:
      messages = [],
    isLoading:
      loadingMessages,
    isError:
      messagesError,
  } =
    useChatMessages(
      selectedSessionId,
      activeChatId,
    );

  const {
    appendMessage,
    updateMessage,
  } =
    useChatMessagesActions();

  /* ================================================================
     PROFILE PICTURES
     ================================================================ */

  const chatIds =
    useMemo(
      () =>
        chats.map(
          chat =>
            chat.id,
        ),
      [
        chats,
      ],
    );

  const listPics =
    useProfilePictures(
      selectedSessionId ||
        undefined,
      chatIds,
    );

  const activePp =
    useProfilePicture(
      selectedSessionId ||
        undefined,
      activeChatId ??
        undefined,
    );

  /* ================================================================
     CHAT SCROLL
     ================================================================ */

  const {
    containerRef:
      messagesContainerRef,
    onMessageAppended,
    onMediaLoad,
  } =
    useChatScrollPosition(
      activeChatId,
      messages.length >
        0,
    );

  /* ================================================================
     LOAD CHATS
     ================================================================ */

  const loadChats =
    useCallback(
      async (
        sessionId:
          string,
      ) => {
        const requestId =
          ++loadChatsVersionRef.current;

        if (!sessionId) {
          commitChats(
            [],
          );
          return;
        }

        setLoadingChats(
          true,
        );

        try {
          const data =
            await sessionApi.getChats(
              sessionId,
            );

          if (
            !isMountedRef.current ||
            requestId !==
              loadChatsVersionRef.current ||
            selectedSessionIdRef.current !==
              sessionId
          ) {
            return;
          }

          const sorted = [
            ...data,
          ].sort(
            (
              a,
              b,
            ) =>
              (b.timestamp ||
                0) -
              (a.timestamp ||
                0),
          );

          commitChats(
            sorted,
          );
        } catch (
          error
        ) {
          if (
            !isMountedRef.current ||
            requestId !==
              loadChatsVersionRef.current
          ) {
            return;
          }

          commitChats(
            [],
          );

          toast.error(
            t(
              'chats.errors.loadChats',
            ),
            error instanceof
              Error
              ? error.message
              : undefined,
          );
        } finally {
          if (
            isMountedRef.current &&
            requestId ===
              loadChatsVersionRef.current
          ) {
            setLoadingChats(
              false,
            );
          }
        }
      },
      [
        commitChats,
        t,
        toast,
      ],
    );

  /**
   * Assignment/session changes come only from backend state.
   *
   * There is no phone lookup, session selector, localStorage phone, or
   * user-driven session discovery anymore.
   */
  useEffect(() => {
    resetChatState();
    commitChats(
      [],
    );

    if (
      selectedSessionId &&
      sessionReady
    ) {
      void loadChats(
        selectedSessionId,
      );
    }
  }, [
    commitChats,
    loadChats,
    resetChatState,
    selectedSessionId,
    sessionReady,
  ]);

  const refreshWorkspace =
    useCallback(
      async () => {
        const [
          agentResult,
          sessionsResult,
        ] =
          await Promise.all([
            agentQuery.refetch(),
            sessionsQuery.refetch(),
          ]);

        const refreshedAgent =
          agentResult.data;

        const refreshedSessionId =
          refreshedAgent?.assignedSessionId;

        const refreshedSession =
          refreshedSessionId
            ? sessionsResult.data?.find(
                session =>
                  session.id ===
                  refreshedSessionId,
              )
            : undefined;

        if (
          refreshedSession?.status ===
          'ready'
        ) {
          await loadChats(
            refreshedSession.id,
          );
        }
      },
      [
        agentQuery,
        loadChats,
        sessionsQuery,
      ],
    );

  const applyUpdatedSession =
    useCallback(
      (
        updated:
          Session,
      ) => {
        queryClient.setQueryData<
          Session[]
        >(
          queryKeys.sessions,
          previous =>
            previous
              ? previous.map(
                  session =>
                    session.id ===
                    updated.id
                      ? updated
                      : session,
                )
              : [
                  updated,
                ],
        );
      },
      [
        queryClient,
      ],
    );

  const runSessionAction =
    useCallback(
      async (
        action:
          AgentSessionAction,
      ) => {
        const session =
          assignedSession;

        if (
          !session ||
          sessionAction
        ) {
          return;
        }

        if (
          action ===
            'start' &&
          !canStartSessions
        ) {
          return;
        }

        if (
          action !==
            'start' &&
          !canShutdownSessions
        ) {
          return;
        }

        if (
          action ===
            'logout' &&
          typeof window !==
            'undefined' &&
          !window.confirm(
            t(
              'agent.logoutConfirm',
              'Unlink this WhatsApp session? A fresh QR scan or pairing code will be required before it can connect again.',
            ),
          )
        ) {
          return;
        }

        if (
          action ===
            'force-kill' &&
          typeof window !==
            'undefined' &&
          !window.confirm(
            t(
              'agent.forceKillConfirm',
              'Force-kill the assigned session engine? Use this only when the normal stop action cannot recover a stuck engine.',
            ),
          )
        ) {
          return;
        }

        setSessionAction(
          action,
        );

        try {
          const updated =
            action ===
            'start'
              ? await sessionApi.start(
                  session.id,
                )
              : action ===
                  'stop'
                ? await sessionApi.stop(
                    session.id,
                  )
                : action ===
                    'logout'
                  ? await sessionApi.logout(
                      session.id,
                    )
                  : await sessionApi.forceKill(
                      session.id,
                    );

          applyUpdatedSession(
            updated,
          );

          toast.success(
            action ===
              'start'
              ? t(
                  'agent.sessionStarted',
                  'Session start requested',
                )
              : action ===
                  'stop'
                ? t(
                    'agent.sessionStopped',
                    'Session stopped',
                  )
                : action ===
                    'logout'
                  ? t(
                      'agent.sessionUnlinked',
                      'Session unlinked',
                    )
                  : t(
                      'agent.sessionForceKilled',
                      'Session force-killed',
                    ),
          );
        } catch (
          error
        ) {
          if (
            action ===
              'logout' &&
            classifyUnlinkError(
              error,
            ) ===
              'incomplete'
          ) {
            await sessionsQuery.refetch();

            toast.warning(
              t(
                'agent.logoutIncompleteTitle',
                'Unlink did not complete',
              ),
              t(
                'agent.logoutIncompleteDescription',
                'The session was stopped locally, but unlinking remained incomplete. Start the session again and retry the unlink.',
              ),
            );

            return;
          }

          toast.error(
            t(
              'agent.sessionActionFailed',
              'Session action failed',
            ),
            error instanceof
              Error
              ? error.message
              : undefined,
          );
        } finally {
          setSessionAction(
            null,
          );
        }
      },
      [
        applyUpdatedSession,
        assignedSession,
        canShutdownSessions,
        canStartSessions,
        sessionAction,
        sessionsQuery,
        t,
        toast,
      ],
    );

  const assignedSessionStarted =
    assignedSession
      ? isSessionStarted(
          assignedSession,
        )
      : false;

  const canStartAssignedSession =
    Boolean(
      assignedSession &&
        canStartSessions &&
        !assignedSessionStarted,
    );

  const canStopAssignedSession =
    Boolean(
      assignedSession &&
        canShutdownSessions &&
        assignedSessionStarted,
    );

  const canUnlinkAssignedSession =
    Boolean(
      assignedSession &&
        canUnlinkSession(
          assignedSession,
          canShutdownSessions,
        ),
    );

  const canForceKillAssignedSession =
    Boolean(
      assignedSession &&
        canForceKillSession(
          assignedSession,
          canShutdownSessions,
        ),
    );

  /* ================================================================
     CHAT TIME FORMATTING
     ================================================================ */

  const timeFormatter =
    useMemo(
      () =>
        new Intl.DateTimeFormat(
          i18n.language,
          {
            hour:
              '2-digit',
            minute:
              '2-digit',
          },
        ),
      [
        i18n.language,
      ],
    );

  const dateFormatter =
    useMemo(
      () =>
        new Intl.DateTimeFormat(
          i18n.language,
          {
            month:
              'short',
            day:
              'numeric',
          },
        ),
      [
        i18n.language,
      ],
    );

  const formatChatTime =
    useCallback(
      (
        timestamp?:
          number,
      ) => {
        if (
          !timestamp ||
          !Number.isFinite(
            timestamp,
          )
        ) {
          return '';
        }

        const date =
          new Date(
            timestamp *
              1000,
          );

        if (
          Number.isNaN(
            date.getTime(),
          )
        ) {
          return '';
        }

        const today =
          new Date();

        if (
          date.toDateString() ===
          today.toDateString()
        ) {
          return timeFormatter.format(
            date,
          );
        }

        const yesterday =
          new Date(
            today,
          );

        yesterday.setDate(
          yesterday.getDate() -
            1,
        );

        if (
          date.toDateString() ===
          yesterday.toDateString()
        ) {
          return t(
            'chats.yesterday',
          );
        }

        return dateFormatter.format(
          date,
        );
      },
      [
        dateFormatter,
        t,
        timeFormatter,
      ],
    );

  /* ================================================================
     CHAT FILTER / SELECTION
     ================================================================ */

  const filteredChats =
    useMemo(
      () =>
        filterChats(
          chats,
          searchQuery,
        ),
      [
        chats,
        searchQuery,
      ],
    );

  const handleSelectChat =
    useCallback(
      (
        chat:
          Chat | null,
      ) => {
        activeChatIdRef.current =
          chat?.id ??
          null;

        scrolledForChatIdRef.current =
          null;

        setActiveChat(
          chat,
        );
      },
      [],
    );

  const handleBackToChats =
    useCallback(() => {
      activeChatIdRef.current =
        null;

      scrolledForChatIdRef.current =
        null;

      setActiveChat(
        null,
      );
    }, []);

  useEffect(() => {
    if (!activeChatId) {
      return;
    }

    markChatRead(
      activeChatId,
    );

    setChatsWithRef(
      previous =>
        previous.map(
          chat =>
            chat.id ===
            activeChatId
              ? {
                  ...chat,
                  unreadCount:
                    0,
                }
              : chat,
        ),
    );
  }, [
    activeChatId,
    markChatRead,
    setChatsWithRef,
  ]);

  /* ================================================================
     LIGHTBOX
     ================================================================ */

  const imageMedia =
    useMemo<
      LightboxItem[]
    >(() => {
      return messages.reduce<
        LightboxItem[]
      >(
        (
          accumulator,
          message,
        ) => {
          if (
            message.type !==
            'image'
          ) {
            return accumulator;
          }

          const mediaUrl =
            getMediaSrc(
              message.metadata?.media,
            );

          if (!mediaUrl) {
            return accumulator;
          }

          const fallbackTimestamp =
            message.createdAt
              ? Math.floor(
                  new Date(
                    message.createdAt,
                  ).getTime() /
                    1000,
                )
              : undefined;

          const resolvedTimestamp =
            typeof message.timestamp ===
              'number' &&
            Number.isFinite(
              message.timestamp,
            )
              ? message.timestamp
              : typeof fallbackTimestamp ===
                    'number' &&
                  Number.isFinite(
                    fallbackTimestamp,
                  )
                ? fallbackTimestamp
                : undefined;

          accumulator.push(
            {
              id:
                message.id,
              url:
                mediaUrl,
              alt:
                message.body ||
                message.metadata?.media?.filename ||
                '',
              senderName:
                undefined,
              timestamp:
                formatChatTime(
                  resolvedTimestamp,
                ),
            },
          );

          return accumulator;
        },
        [],
      );
    }, [
      formatChatTime,
      messages,
    ]);

  const handleOpenImage =
    useCallback(
      (
        messageId:
          string,
      ) => {
        const index =
          imageMedia.findIndex(
            item =>
              item.id ===
              messageId,
          );

        if (
          index >= 0
        ) {
          setLightboxIndex(
            index,
          );
        }
      },
      [
        imageMedia,
      ],
    );

  /* ================================================================
     MESSAGE CACHE HELPERS
     ================================================================ */

  const updateMessageCaches =
    useCallback(
      (
        sessionId:
          string,
        updater: (
          messages:
            ChatMessageView[],
        ) => ChatMessageView[],
      ) => {
        const caches =
          queryClient.getQueriesData<
            ChatMessageView[]
          >({
            queryKey: [
              MESSAGE_QUERY_PREFIX,
              sessionId,
            ],
          });

        for (
          const [
            key,
            list,
          ] of caches
        ) {
          if (!list) {
            continue;
          }

          const next =
            updater(
              list,
            );

          if (
            next !==
            list
          ) {
            queryClient.setQueryData(
              key,
              next,
            );
          }
        }
      },
      [
        queryClient,
      ],
    );

  /* ================================================================
     REACTION
     ================================================================ */

  const handleReactMessage =
    useCallback(
      async (
        message:
          ChatMessageView,
        emoji:
          string,
      ) => {
        if (
          !selectedSessionId ||
          !activeChat
        ) {
          return;
        }

        const messageId =
          message.waMessageId ||
          message.id;

        const currentReactions =
          message.metadata?.reactions ||
          {};

        const sessionPhone =
          normalizePhone(
            assignedSession?.phone,
          );

        let alreadyReacted =
          false;

        for (
          const [
            sender,
            reactionEmoji,
          ] of Object.entries(
            currentReactions,
          )
        ) {
          if (
            isOwnReactionSender(
              sender,
              sessionPhone,
            ) &&
            reactionEmoji ===
              emoji
          ) {
            alreadyReacted =
              true;
            break;
          }
        }

        const emojiToSend =
          alreadyReacted
            ? ''
            : emoji;

        const key =
          messagesQueryKey(
            selectedSessionId,
            activeChat.id,
          );

        const previous =
          queryClient.getQueryData<
            ChatMessageView[]
          >(
            key,
          );

        const applyOptimisticReaction =
          (
            list?:
              ChatMessageView[],
          ): ChatMessageView[] =>
            (
              list ||
              []
            ).map(
              current => {
                if (
                  current.id !==
                    message.id &&
                  current.waMessageId !==
                    message.waMessageId
                ) {
                  return current;
                }

                const metadata =
                  current.metadata ||
                  {};

                const reactions = {
                  ...(
                    metadata.reactions ||
                    {}
                  ),
                };

                if (
                  emojiToSend ===
                  ''
                ) {
                  delete reactions.me;
                } else {
                  reactions.me =
                    emojiToSend;
                }

                return {
                  ...current,
                  metadata: {
                    ...metadata,
                    reactions,
                  },
                };
              },
            );

        queryClient.setQueryData(
          key,
          applyOptimisticReaction(
            previous,
          ),
        );

        try {
          await messageApi.react(
            selectedSessionId,
            {
              chatId:
                activeChat.id,
              messageId,
              emoji:
                emojiToSend,
            },
          );
        } catch (
          error
        ) {
          queryClient.setQueryData(
            key,
            previous ??
              [],
          );

          toast.error(
            t(
              'chats.errors.react',
            ),
            error instanceof
              Error
              ? error.message
              : undefined,
          );
        }
      },
      [
        activeChat,
        assignedSession?.phone,
        queryClient,
        selectedSessionId,
        t,
        toast,
      ],
    );

  /* ================================================================
     DELETE MESSAGE
     ================================================================ */

  const handleDeleteMessage =
    useCallback(
      async (
        message:
          ChatMessageView,
      ) => {
        if (
          !selectedSessionId ||
          !activeChat
        ) {
          return;
        }

        if (
          typeof window ===
          'undefined'
        ) {
          return;
        }

        if (
          !window.confirm(
            t(
              'chats.deleteConfirm',
            ),
          )
        ) {
          return;
        }

        const messageId =
          message.waMessageId ||
          message.id;

        try {
          await messageApi.delete(
            selectedSessionId,
            {
              chatId:
                activeChat.id,
              messageId,
              forEveryone:
                true,
            },
          );

          updateMessage(
            selectedSessionId,
            activeChat.id,
            message.id,
            {
              body:
                '',
              type:
                'revoked',
            },
          );
        } catch (
          error
        ) {
          toast.error(
            t(
              'chats.errors.delete',
            ),
            error instanceof
              Error
              ? error.message
              : undefined,
          );
        }
      },
      [
        activeChat,
        selectedSessionId,
        t,
        toast,
        updateMessage,
      ],
    );

  /* ================================================================
     WEBSOCKET
     ================================================================ */

  const handleIncomingMessage =
    useCallback(
      (
        event: {
          sessionId:
            string;
          message:
            Record<
              string,
              unknown
            >;
        },
      ) => {
        if (
          event.sessionId !==
          selectedSessionIdRef.current
        ) {
          return;
        }

        const incoming =
          event.message as unknown as
            IncomingWsMessage;

        const mappedMessage =
          mapIncomingWebSocketMessage(
            incoming,
          );

        appendMessage(
          event.sessionId,
          incoming.chatId,
          mappedMessage,
        );

        const currentActiveChatId =
          activeChatIdRef.current;

        if (
          currentActiveChatId ===
          incoming.chatId
        ) {
          markChatRead(
            incoming.chatId,
          );

          if (
            !incoming.fromMe
          ) {
            onMessageAppended(
              'incoming',
            );
          }
        }

        const result =
          applyIncomingToChatList(
            chatsRef.current,
            incoming,
            {
              activeChatId:
                currentActiveChatId ??
                undefined,
              locationLabel:
                `📍 ${t(
                  'chats.media.location',
                  'Location',
                )}`,
            },
          );

        commitChats(
          result.chats,
        );

        if (
          result.needsSidebarRefetch
        ) {
          void loadChats(
            event.sessionId,
          );
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

  const handleIncomingMessageAck =
    useCallback(
      (
        event: {
          sessionId:
            string;
          messageId:
            string;
          status:
            ChatMessageView['status'];
        },
      ) => {
        if (
          event.sessionId !==
          selectedSessionIdRef.current
        ) {
          return;
        }

        updateMessageCaches(
          event.sessionId,
          list => {
            const index =
              list.findIndex(
                message =>
                  message.id ===
                    event.messageId ||
                  message.waMessageId ===
                    event.messageId,
              );

            if (
              index ===
              -1
            ) {
              return list;
            }

            const target =
              list[index];

            const nextStatus =
              mergeDeliveryStatus(
                target.status,
                event.status,
              ) ??
              target.status;

            if (
              nextStatus ===
              target.status
            ) {
              return list;
            }

            const next =
              list.slice();

            next[index] = {
              ...target,
              status:
                nextStatus,
            };

            return next;
          },
        );
      },
      [
        updateMessageCaches,
      ],
    );

  const handleIncomingMessageReaction =
    useCallback(
      (
        event: {
          sessionId:
            string;
          messageId:
            string;
          reactions?:
            Record<
              string,
              string
            >;
        },
      ) => {
        if (
          event.sessionId !==
          selectedSessionIdRef.current
        ) {
          return;
        }

        updateMessageCaches(
          event.sessionId,
          list => {
            const index =
              list.findIndex(
                message =>
                  message.id ===
                    event.messageId ||
                  message.waMessageId ===
                    event.messageId,
              );

            if (
              index ===
              -1
            ) {
              return list;
            }

            const target =
              list[index];

            const next =
              list.slice();

            next[index] = {
              ...target,
              metadata: {
                ...(
                  target.metadata ||
                  {}
                ),
                reactions:
                  mergeReactionSnapshot(
                    target.metadata?.reactions,
                    event.reactions,
                  ),
              },
            };

            return next;
          },
        );
      },
      [
        updateMessageCaches,
      ],
    );

  const handleIncomingMessageRevoked =
    useCallback(
      (
        event: {
          sessionId:
            string;
          id:
            string;
          revokedId?:
            string;
          type:
            string;
        },
      ) => {
        if (
          event.sessionId !==
          selectedSessionIdRef.current
        ) {
          return;
        }

        updateMessageCaches(
          event.sessionId,
          list => {
            const index =
              findRevokedIndex(
                list,
                event,
              );

            if (
              index ===
              -1
            ) {
              return list;
            }

            const target =
              list[index];

            const next =
              list.slice();

            next[index] = {
              ...target,
              body:
                '',
              type:
                asMessageType(
                  event.type,
                ),
            };

            return next;
          },
        );
      },
      [
        updateMessageCaches,
      ],
    );

  const handleIncomingMessageEdited =
    useCallback(
      (
        event: {
          sessionId:
            string;
          messageId:
            string;
          chatId:
            string;
          body:
            string;
        },
      ) => {
        if (
          event.sessionId !==
          selectedSessionIdRef.current
        ) {
          return;
        }

        const caches =
          queryClient.getQueriesData<
            ChatMessageView[]
          >({
            queryKey: [
              MESSAGE_QUERY_PREFIX,
              event.sessionId,
            ],
          });

        let editedLastMessage =
          false;

        let matchedCachedMessage =
          false;

        for (
          const [
            key,
            list,
          ] of caches
        ) {
          if (!list) {
            continue;
          }

          const next =
            applyMessageEdit(
              list,
              event,
            );

          if (
            next ===
            list
          ) {
            continue;
          }

          matchedCachedMessage =
            true;

          queryClient.setQueryData(
            key,
            next,
          );

          const cachedChatId =
            Array.isArray(
              key,
            ) &&
            typeof key[2] ===
              'string'
              ? key[2]
              : undefined;

          const editedIndex =
            list.findIndex(
              message =>
                message.id ===
                  event.messageId ||
                message.waMessageId ===
                  event.messageId,
            );

          if (
            cachedChatId ===
              event.chatId &&
            editedIndex ===
              list.length -
                1
          ) {
            editedLastMessage =
              true;
          }
        }

        if (
          editedLastMessage
        ) {
          setChatsWithRef(
            previous =>
              previous.map(
                chat =>
                  chat.id ===
                  event.chatId
                    ? {
                        ...chat,
                        lastMessage:
                          event.body,
                      }
                    : chat,
              ),
          );
        } else if (
          !matchedCachedMessage
        ) {
          void loadChats(
            selectedSessionIdRef.current,
          );
        }
      },
      [
        loadChats,
        queryClient,
        setChatsWithRef,
      ],
    );

  const wsEvents =
    useMemo(
      () => ({
        onMessage:
          handleIncomingMessage,
        onMessageAck:
          handleIncomingMessageAck,
        onMessageReaction:
          handleIncomingMessageReaction,
        onMessageRevoked:
          handleIncomingMessageRevoked,
        onMessageEdited:
          handleIncomingMessageEdited,
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
  } =
    useWebSocket(
      wsEvents,
    );

  useEffect(() => {
    if (
      !selectedSessionId ||
      !isConnected
    ) {
      return undefined;
    }

    subscribe(
      selectedSessionId,
      [
        ...AGENT_WS_EVENTS,
      ],
    );

    return () => {
      unsubscribe(
        selectedSessionId,
      );
    };
  }, [
    isConnected,
    selectedSessionId,
    subscribe,
    unsubscribe,
  ]);

  useEffect(() => {
    if (
      !selectedSessionId
    ) {
      wasConnectedRef.current =
        null;
      return;
    }

    if (
      wasConnectedRef.current ===
        false &&
      isConnected
    ) {
      void queryClient.invalidateQueries(
        {
          queryKey: [
            MESSAGE_QUERY_PREFIX,
            selectedSessionId,
          ],
        },
      );

      void loadChats(
        selectedSessionId,
      );
    }

    wasConnectedRef.current =
      isConnected;
  }, [
    isConnected,
    loadChats,
    queryClient,
    selectedSessionId,
  ]);

  /* ================================================================
     INITIAL SCROLL
     ================================================================ */

  useLayoutEffect(() => {
    if (
      !activeChatId
    ) {
      scrolledForChatIdRef.current =
        null;
      return;
    }

    if (
      loadingMessages ||
      messages.length ===
        0
    ) {
      return;
    }

    if (
      scrolledForChatIdRef.current ===
      activeChatId
    ) {
      return;
    }

    const container =
      messagesContainerRef.current;

    if (!container) {
      return;
    }

    scrolledForChatIdRef.current =
      activeChatId;

    container.scrollTo(
      {
        top:
          container.scrollHeight,
      },
    );
  }, [
    activeChatId,
    loadingMessages,
    messages.length,
    messagesContainerRef,
  ]);

  /* ================================================================
     LOCKED SIDEBAR TABS
     ================================================================ */

  const noop =
    useCallback(
      () => {},
      [],
    );

  const agentChannelsQuery =
    useQuery<
      Channel[],
      Error
    >({
      queryKey: [
        'agent-disabled-channels',
      ],
      queryFn:
        async () =>
          [],
      enabled:
        false,
      retry:
        false,
      staleTime:
        Infinity,
    });

  const chatsTab =
    useMemo(
      () => ({
        loading:
          loadingChats,
        chats:
          filteredChats,
        activeChatId:
          activeChatId ??
          undefined,
        pictures:
          listPics.data,
        onSelectChat:
          handleSelectChat,
      }),
      [
        activeChatId,
        filteredChats,
        handleSelectChat,
        listPics.data,
        loadingChats,
      ],
    );

  const channelsTab =
    useMemo(
      () => ({
        engineLoading:
          false,
        supported:
          false,
        query:
          agentChannelsQuery,
        channels:
          [] as Channel[],
        activeChannelId:
          undefined,
        onSelectChannel:
          noop,
      }),
      [
        agentChannelsQuery,
        noop,
      ],
    );

  const statusTab =
    useMemo(
      () => ({
        loading:
          false,
        error:
          false,
        groups:
          [],
        activeContactId:
          null,
        onSelectContact:
          noop,
      }),
      [
        noop,
      ],
    );

  /* ================================================================
     RENDER STATES
     ================================================================ */

  const loadingIdentity =
    agentQuery.isLoading ||
    sessionsQuery.isLoading;

  const refreshing =
    agentQuery.isFetching ||
    sessionsQuery.isFetching;

  if (
    loadingIdentity
  ) {
    return (
      <div className="agent-page">
        <div className="agent-state">
          <Loader2
            size={30}
            className="animate-spin"
          />

          <h2>
            {t(
              'agent.loadingTitle',
              'Loading Agent workspace',
            )}
          </h2>

          <p>
            {t(
              'agent.loadingDescription',
              'Resolving your identity and assigned WhatsApp session.',
            )}
          </p>
        </div>
      </div>
    );
  }

  if (
    agentQuery.isError
  ) {
    return (
      <div className="agent-page">
        <div className="agent-state agent-state--error">
          <AlertCircle
            size={38}
          />

          <h2>
            {t(
              'agent.identityErrorTitle',
              'Agent identity could not be loaded',
            )}
          </h2>

          <p>
            {agentQuery.error instanceof
            Error
              ? agentQuery.error.message
              : t(
                  'agent.identityErrorDescription',
                  'The authenticated Agent principal is unavailable.',
                )}
          </p>

          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              void refreshWorkspace()
            }
          >
            <RefreshCw
              size={17}
            />

            {t(
              'common.refresh',
              'Refresh',
            )}
          </button>
        </div>
      </div>
    );
  }

  if (
    agent &&
    !agent.assignedSessionId
  ) {
    return (
      <div className="agent-page">
        <header className="agent-header">
          <div>
            <h1>
              {t(
                'agent.title',
                'Agent',
              )}
            </h1>

            <p>
              {agent.name}
              {agent.email
                ? ` · ${agent.email}`
                : ''}
            </p>
          </div>

          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              void refreshWorkspace()
            }
            disabled={
              refreshing
            }
          >
            <RefreshCw
              size={17}
              className={
                refreshing
                  ? 'animate-spin'
                  : undefined
              }
            />

            {t(
              'common.refresh',
              'Refresh',
            )}
          </button>
        </header>

        <div className="agent-state">
          <UserRound
            size={44}
          />

          <h2>
            {t(
              'agent.unassignedTitle',
              'No session assigned',
            )}
          </h2>

          <p>
            {t(
              'agent.unassignedDescription',
              'Your Team Leader has not assigned a WhatsApp session to this Agent account. Contact your Team Leader.',
            )}
          </p>

          <span className="agent-status">
            {t(
              'agent.templateQuotaSummary',
              `Template quota: ${templateQuotaLabel(
                agent.templateSendLimit24h,
              )}`,
            )}
          </span>
        </div>
      </div>
    );
  }

  if (
    agent?.assignedSessionId &&
    !assignedSession
  ) {
    return (
      <div className="agent-page">
        <header className="agent-header">
          <div>
            <h1>
              {t(
                'agent.title',
                'Agent',
              )}
            </h1>

            <p>
              {agent.name}
            </p>
          </div>

          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              void refreshWorkspace()
            }
            disabled={
              refreshing
            }
          >
            <RefreshCw
              size={17}
              className={
                refreshing
                  ? 'animate-spin'
                  : undefined
              }
            />

            {t(
              'common.refresh',
              'Refresh',
            )}
          </button>
        </header>

        <div className="agent-state agent-state--error">
          <AlertCircle
            size={40}
          />

          <h2>
            {t(
              'agent.assignmentUnavailableTitle',
              'Assigned session unavailable',
            )}
          </h2>

          <p>
            {t(
              'agent.assignmentUnavailableDescription',
              'Your Agent account has an assignment, but that session is not present in the sessions authorized for this API key. Refresh the page or contact your Team Leader.',
            )}
          </p>

          <code>
            {
              agent.assignedSessionId
            }
          </code>
        </div>
      </div>
    );
  }

  if (
    !agent ||
    !assignedSession
  ) {
    return null;
  }

  return (
    <div className="agent-page chats-page">
      <header className="agent-header">
        <div>
          <h1>
            {t(
              'agent.title',
              'Agent',
            )}
          </h1>

          <p>
            {t(
              'agent.description',
              'Chat workspace for the WhatsApp session assigned by your Team Leader.',
            )}
          </p>
        </div>

        <div className="agent-session-actions">
          {canStartAssignedSession && (
            <button
              type="button"
              className="btn-primary"
              onClick={() =>
                void runSessionAction(
                  'start',
                )
              }
              disabled={
                Boolean(
                  sessionAction,
                )
              }
            >
              {sessionAction ===
              'start' ? (
                <Loader2
                  size={17}
                  className="animate-spin"
                />
              ) : (
                <Play
                  size={17}
                />
              )}

              {t(
                'sessions.actions.start',
                'Start',
              )}
            </button>
          )}

          {canStopAssignedSession && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                void runSessionAction(
                  'stop',
                )
              }
              disabled={
                Boolean(
                  sessionAction,
                )
              }
            >
              {sessionAction ===
              'stop' ? (
                <Loader2
                  size={17}
                  className="animate-spin"
                />
              ) : (
                <Square
                  size={17}
                />
              )}

              {t(
                'sessions.actions.stop',
                'Stop',
              )}
            </button>
          )}

          {canUnlinkAssignedSession && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                void runSessionAction(
                  'logout',
                )
              }
              disabled={
                Boolean(
                  sessionAction,
                )
              }
            >
              {sessionAction ===
              'logout' ? (
                <Loader2
                  size={17}
                  className="animate-spin"
                />
              ) : (
                <Unlink
                  size={17}
                />
              )}

              {t(
                'sessions.actions.unlink',
                'Unlink',
              )}
            </button>
          )}

          {canForceKillAssignedSession && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                void runSessionAction(
                  'force-kill',
                )
              }
              disabled={
                Boolean(
                  sessionAction,
                )
              }
            >
              {sessionAction ===
              'force-kill' ? (
                <Loader2
                  size={17}
                  className="animate-spin"
                />
              ) : (
                <Skull
                  size={17}
                />
              )}

              {t(
                'sessions.actions.killStuck',
                'Force kill',
              )}
            </button>
          )}

          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              void refreshWorkspace()
            }
            disabled={
              refreshing ||
              Boolean(
                sessionAction,
              )
            }
          >
            <RefreshCw
              size={17}
              className={
                refreshing
                  ? 'animate-spin'
                  : undefined
              }
            />

            {t(
              'common.refresh',
              'Refresh',
            )}
          </button>
        </div>
      </header>

      <section
        className="agent-identity-grid"
        aria-label={t(
          'agent.assignmentSummary',
          'Agent assignment summary',
        )}
      >
        <article className="agent-info-card">
          <span className="agent-info-label">
            {t(
              'agent.agentLabel',
              'Agent',
            )}
          </span>

          <strong>
            {
              agent.name
            }
          </strong>

          <span className="agent-info-secondary">
            {agent.email ??
              t(
                'agent.noEmail',
                'No email',
              )}
          </span>
        </article>

        <article className="agent-info-card">
          <span className="agent-info-label">
            {t(
              'agent.sessionLabel',
              'Session',
            )}
          </span>

          <strong>
            {
              assignedSession.name
            }
          </strong>

          <span
            className="agent-info-secondary agent-mono"
            title={
              assignedSession.id
            }
          >
            {
              assignedSession.id
            }
          </span>
        </article>

        <article className="agent-info-card">
          <span className="agent-info-label">
            {t(
              'agent.configuredPhone',
              'Configured phone',
            )}
          </span>

          <strong className="agent-mono">
            {assignedSession.targetPhone ??
              '—'}
          </strong>

          <span className="agent-info-secondary">
            {t(
              'agent.configuredPhoneHint',
              'Configured by Team Leader',
            )}
          </span>
        </article>

        <article className="agent-info-card">
          <span className="agent-info-label">
            {t(
              'agent.connectedPhone',
              'Connected phone',
            )}
          </span>

          <strong className="agent-mono">
            {assignedSession.phone ??
              '—'}
          </strong>

          <span
            className={`agent-status agent-status--${assignedSession.status}`}
          >
            {statusLabel(
              assignedSession.status,
            )}
          </span>
        </article>

        <article className="agent-info-card">
          <span className="agent-info-label">
            {t(
              'agent.templateQuota',
              'Template quota',
            )}
          </span>

          <strong>
            {templateQuotaLabel(
              agent.templateSendLimit24h,
            )}
          </strong>

          <span className="agent-info-secondary">
            {agent.templateSendLimit24h ===
            null
              ? t(
                  'agent.templateQuotaUnlimitedHint',
                  'No rolling 24-hour stored-template limit',
                )
              : agent.templateSendLimit24h ===
                  0
                ? t(
                    'agent.templateQuotaDisabledHint',
                    'Stored-template sending is disabled',
                  )
                : t(
                    'agent.templateQuotaLimitedHint',
                    'Rolling 24-hour stored-template limit',
                  )}
          </span>
        </article>
      </section>

      {!sessionReady ? (
        <div className="agent-state agent-state--compact">
          <Smartphone
            size={42}
          />

          <h2>
            {t(
              'agent.sessionNotReadyTitle',
              'Session is not ready',
            )}
          </h2>

          <p>
            {t(
              'agent.sessionNotReadyDescription',
              'The assigned WhatsApp session is currently unavailable for chat. You can start or stop the assigned engine when permitted; QR/pairing and session configuration remain Team Leader responsibilities.',
            )}
          </p>

          <span
            className={`agent-status agent-status--${assignedSession.status}`}
          >
            {statusLabel(
              assignedSession.status,
            )}
          </span>
        </div>
      ) : (
        <section className="agent-workspace">
          <div className="agent-chat-grid-item">
            {connectionFailed && (
              <div
                className="chats-reconnect-banner"
                role="alert"
              >
                <AlertCircle
                  size={16}
                />

                <span>
                  {t(
                    'common.disconnected',
                    'Disconnected',
                  )}
                </span>

                <button
                  type="button"
                  className="btn-secondary"
                  onClick={
                    reconnect
                  }
                >
                  {t(
                    'common.refresh',
                    'Refresh',
                  )}
                </button>
              </div>
            )}

            <div
              className={`chats-layout ${
                activeChat
                  ? 'has-active-chat'
                  : ''
              }`}
            >
              <ChatSidebar
                sessions={[
                  assignedSession,
                ]}
                selectedSessionId={
                  assignedSession.id
                }
                onSelectSession={
                  noop
                }
                lockedSession
                activeTab="chats"
                onSwitchTab={
                  noop
                }
                searchQuery={
                  searchQuery
                }
                onSearchQueryChange={
                  setSearchQuery
                }
                onComposeStatus={
                  noop
                }
                formatChatTime={
                  formatChatTime
                }
                chatsTab={
                  chatsTab
                }
                channelsTab={
                  channelsTab
                }
                statusTab={
                  statusTab
                }
              />

              <main className="chats-room">
                {activeChat ? (
                  <div className="room-container">
                    <header className="room-header">
                      <button
                        type="button"
                        className="room-back"
                        onClick={
                          handleBackToChats
                        }
                        aria-label={t(
                          'common.back',
                          'Back',
                        )}
                      >
                        <ArrowLeft
                          size={20}
                        />
                      </button>

                      <div className="room-avatar">
                        {activePp.data ? (
                          <img
                            src={
                              activePp.data
                            }
                            alt={
                              activeChat.name ||
                              ''
                            }
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
                          <KindIcon
                            kind={
                              activeChat.kind
                            }
                          />
                        )}
                      </div>

                      <div className="room-contact-info">
                        <h3>
                          {activeChat.name ||
                            activeChat.id.split(
                              '@',
                            )[0]}
                        </h3>

                        <span className="room-contact-phone">
                          {activeChat.isGroup
                            ? t(
                                'chats.groupSubtitle',
                                'Group',
                              )
                            : t(
                                'chats.privateContactSubtitle',
                                'Private contact',
                              )}
                        </span>

                        <span
                          className="room-contact-jid"
                          title={
                            activeChat.id
                          }
                        >
                          {
                            activeChat.id
                          }
                        </span>
                      </div>
                    </header>

                    <ChatThread
                      sessionId={
                        assignedSession.id
                      }
                      activeChat={
                        activeChat
                      }
                      messages={
                        messages
                      }
                      loadingMessages={
                        loadingMessages
                      }
                      messagesError={
                        messagesError
                      }
                      messagesContainerRef={
                        messagesContainerRef
                      }
                      onMediaLoad={
                        onMediaLoad
                      }
                      onOpenImage={
                        handleOpenImage
                      }
                      onReply={
                        setReplyingTo
                      }
                      onReact={
                        handleReactMessage
                      }
                      onDelete={
                        handleDeleteMessage
                      }
                    />

                    <ChatComposer
                      selectedSessionId={
                        assignedSession.id
                      }
                      activeChat={
                        activeChat
                      }
                      replyingTo={
                        replyingTo
                      }
                      setReplyingTo={
                        setReplyingTo
                      }
                      onMessageAppended={
                        onMessageAppended
                      }
                      setChats={
                        setChatsWithRef
                      }
                      messageInput={
                        messageInput
                      }
                      setMessageInput={
                        setMessageInput
                      }
                      attachment={
                        attachment
                      }
                      setAttachment={
                        setAttachment
                      }
                      previewUrl={
                        previewUrl
                      }
                      setPreviewUrl={
                        setPreviewUrl
                      }
                    />
                  </div>
                ) : (
                  <div className="chats-room-placeholder">
                    <MessageSquare
                      size={80}
                      className="placeholder-icon"
                    />

                    <h2>
                      {t(
                        'agent.selectChatTitle',
                        'Select a chat',
                      )}
                    </h2>

                    <p>
                      {t(
                        'agent.selectChatDescription',
                        'Choose a conversation from the list to start messaging.',
                      )}
                    </p>
                  </div>
                )}
              </main>
            </div>
          </div>
        </section>
      )}

      <MediaLightbox
        items={
          imageMedia
        }
        index={
          lightboxIndex
        }
        onClose={() =>
          setLightboxIndex(
            null,
          )
        }
        onNavigate={
          setLightboxIndex
        }
      />
    </div>
  );
}



