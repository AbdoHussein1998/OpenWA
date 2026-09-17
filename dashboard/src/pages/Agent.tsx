





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
  useNavigate,
} from 'react-router-dom';

import {
  useTranslation,
} from 'react-i18next';

import {
  AlertCircle,
  ArrowLeft,
  ClipboardList,
  Loader2,
  MessageSquare,
  Play,
  QrCode,
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
  type ApiRequestError,
  type Channel,
  type Chat,
  type ChatKind,
  type Session,
} from '../services/api';

import {
  useAgentMeQuery,
  useSessionsQuery,
} from '../hooks/queries';

import {
  useRole,
} from '../hooks/useRole';

import {
  useSessionPairing,
} from '../hooks/useSessionPairing';

import {
  canForceKillSession,
  canUnlinkSession,
  classifyUnlinkError,
  isSessionStarted,
} from '../utils/sessionActions';

import {
  isValidPairingPhone,
} from '../utils/sessionForm';

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
  type SubscribedEvent,
} from '../hooks/useWebSocket';

import {
  MESSAGE_QUERY_PREFIX,
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
  Modal,
} from '../components/Modal';

import ChatSidebar from '../components/chats/ChatSidebar';

import ChatThread from '../components/chats/ChatThread';

import ChatComposer, {
  type StagedAttachment,
} from '../components/chats/ChatComposer';

import MediaLightbox, {
  type LightboxItem,
} from '../components/chats/MediaLightbox';

import {
  CountryPhoneInput,
} from '../components/CountryPhoneInput';

import KindIcon from '../components/chats/KindIcon';

import './Chats.css';
import './Agent.css';
import './AgentQrModal.css';

/* ================================================================
   CONSTANTS
   ================================================================ */

const AGENT_WS_EVENTS = [
  'session.status',
  'session.qr',
  'session.restriction',
  'message.received',
  'message.sent',
  'message.ack',
  'message.reaction',
  'message.revoked',
  'message.edited',
] as const;

/**
 * Controlled retry cadence for the short period where the Session remains
 * logically READY while whatsapp-web.js rebuilds window.WWebJS after a page
 * navigation. Total wait is 64 seconds, matching the backend's ~60 second
 * navigation reinjection grace without ever approaching the API throttle.
 */
const CHAT_REINJECT_RETRY_DELAYS_MS = [
  2_000,
  4_000,
  8_000,
  10_000,
  10_000,
  10_000,
  10_000,
  10_000,
] as const;

function isEngineReinjectingError(
  error: unknown,
): error is ApiRequestError {
  if (!(error instanceof Error)) {
    return false;
  }

  const candidate =
    error as ApiRequestError;

  return (
    candidate.status === 409 &&
    (
      candidate.code ===
        'ENGINE_REINJECTING' ||
      /re-?injecting/i.test(
        candidate.message,
      )
    )
  );
}

function waitForRetry(
  delayMs: number,
): Promise<void> {
  return new Promise(resolve => {
    setTimeout(
      resolve,
      delayMs,
    );
  });
}

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

  // `ToastProvider` includes the live toast list in its context value, so the
  // context object itself changes whenever a toast is added/removed. Keep the
  // stable callback functions separately for loadChats; depending on the whole
  // object creates a toast -> render -> loadChats identity -> effect loop.
  const showLoadChatsError =
    toast.error;
  const showLoadChatsWarning =
    toast.warning;

  const queryClient =
    useQueryClient();

  const navigate =
    useNavigate();

  const {
    canReadTemplates,
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
    useState<
      | 'start'
      | 'stop'
      | 'unlink'
      | 'kill'
      | null
    >(
      null,
    );

  /**
   * QR display is intentionally user-controlled.
   *
   * Receiving/generating a QR only makes the "Show QR Code" action
   * available. The image itself is rendered in a modal only after the Agent
   * explicitly clicks that action, so short-lived Session status transitions
   * cannot make the QR flash on screen and disappear before it can be scanned.
   */
  const [
    qrDisplayOpen,
    setQrDisplayOpen,
  ] =
    useState(false);

  /**
   * Stable copy of the latest generated QR for the currently assigned Session.
   *
   * `useSessionPairing().qrData` is transport/polling state and may be cleared
   * during short status transitions. UI availability must not depend on that
   * transient value, otherwise the Show QR button can flash and disappear.
   * This value is cleared only when the assignment changes, the Session becomes
   * ready, or the Agent explicitly stops/unlinks/kills the Session.
   */
  const [
    latchedQrData,
    setLatchedQrData,
  ] = useState<{
    sessionId: string;
    qrCode: string;
  } | null>(null);

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

  // Deduplicate sidebar reloads from effects/WebSocket recovery while one
  // request/retry sequence for the same Session is already active.
  const loadChatsInFlightSessionRef =
    useRef<string | null>(
      null,
    );

  const selectedSessionIdRef =
    useRef(
      selectedSessionId,
    );

  const sessionsRef =
    useRef<Session[]>(
      sessions,
    );

  const qrPrefetchKeyRef =
    useRef<string | null>(
      null,
    );

  const qrReadyNotifiedSessionRef =
    useRef<string | null>(
      null,
    );

  const previousAssignedSessionIdRef =
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

  const failedActiveAvatarUrlRef =
    useRef<
      string | null
    >(
      null,
    );

  const refetchSessions =
    sessionsQuery.refetch;

  const reloadSessions =
    useCallback(
      async (): Promise<Session[]> => {
        const result =
          await refetchSessions();

        return (
          result.data ??
          []
        );
      },
      [
        refetchSessions,
      ],
    );

  const {
    qrData,
    pairingMode,
    phoneNumber,
    pairingCode,
    requestingPairing,
    pairingError,
    setPhoneNumber,
    selectPairingTab,
    handleChangeNumber,
    handleGeneratePairingCode,
    handleShowQR,
    handleCloseQRModal,
    applyQrPush,
    dismissQrForSession,
  } =
    useSessionPairing({
      sessions,
      sessionsRef,
      reloadSessions,
    });

  const handleShowQRRef =
    useRef(
      handleShowQR,
    );

  useEffect(() => {
    handleShowQRRef.current =
      handleShowQR;
  }, [
    handleShowQR,
  ]);

  /**
   * Capture QR values obtained through the REST/polling path. Once captured,
   * the UI no longer depends on the hook continuing to expose `qrData`.
   */
  useEffect(() => {
    if (
      !assignedSession ||
      !qrData?.qrCode ||
      qrData.sessionId !==
        assignedSession.id
    ) {
      return;
    }

    setLatchedQrData({
      sessionId:
        qrData.sessionId,
      qrCode:
        qrData.qrCode,
    });
  }, [
    assignedSession,
    qrData,
  ]);

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
    sessionsRef.current =
      sessions;
  }, [
    sessions,
  ]);

  /**
   * A Team Leader may reassign this Agent while the page is open.
   * Tear down pairing state from the previous assignment immediately so
   * the Agent never keeps polling or displaying a QR for a session that
   * is no longer assigned.
   */
  useEffect(() => {
    if (
      previousAssignedSessionIdRef.current !==
      selectedSessionId
    ) {
      setQrDisplayOpen(
        false,
      );

      setLatchedQrData(
        null,
      );

      handleCloseQRModal();

      qrPrefetchKeyRef.current =
        null;

      qrReadyNotifiedSessionRef.current =
        null;

      previousAssignedSessionIdRef.current =
        selectedSessionId;
    }
  }, [
    handleCloseQRModal,
    selectedSessionId,
  ]);

  /**
   * Prime the QR data in the background, but never display it automatically.
   *
   * `useSessionPairing` owns fetching/refreshing the latest QR. This page only
   * exposes the QR after the Agent explicitly presses "Show QR Code".
   *
   * Importantly, we do not dismiss cached QR data merely because the Session
   * briefly leaves `qr_ready`. WhatsApp engines can move through transient
   * states very quickly; tying visibility to those states caused the QR to
   * flash and disappear before the Agent could scan it.
   */
  useEffect(() => {
    if (
      !assignedSession
    ) {
      qrPrefetchKeyRef.current =
        null;
      return;
    }

    const shouldPrefetchQr =
      assignedSession.status ===
        'initializing' ||
      assignedSession.status ===
        'qr_ready';

    if (
      !shouldPrefetchQr
    ) {
      qrPrefetchKeyRef.current =
        null;
      return;
    }

    const key =
      `${assignedSession.id}:${assignedSession.status}`;

    if (
      qrPrefetchKeyRef.current ===
      key
    ) {
      return;
    }

    qrPrefetchKeyRef.current =
      key;

    void handleShowQRRef.current(
      assignedSession.id,
    );
  }, [
    assignedSession,
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
    invalidateSessionMessages,
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
        if (!sessionId) {
          commitChats(
            [],
          );
          return;
        }

        if (
          loadChatsInFlightSessionRef.current ===
          sessionId
        ) {
          return;
        }

        loadChatsInFlightSessionRef.current =
          sessionId;

        const requestId =
          ++loadChatsVersionRef.current;

        setLoadingChats(
          true,
        );

        try {
          for (
            let attempt = 0;
            ;
            attempt += 1
          ) {
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
              return;
            } catch (
              error
            ) {
              if (
                !isMountedRef.current ||
                requestId !==
                  loadChatsVersionRef.current ||
                selectedSessionIdRef.current !==
                  sessionId
              ) {
                return;
              }

              if (
                isEngineReinjectingError(
                  error,
                )
              ) {
                const delayMs =
                  CHAT_REINJECT_RETRY_DELAYS_MS[
                    attempt
                  ];

                if (
                  delayMs ===
                  undefined
                ) {
                  showLoadChatsWarning(
                    t(
                      'agent.chatsReinjectingTitle',
                      'WhatsApp is still reconnecting',
                    ),
                    t(
                      'agent.chatsReinjectingDescription',
                      'The WhatsApp Web page is still rebuilding its connection. Existing chats were kept. Refresh again shortly if they do not update automatically.',
                    ),
                  );
                  return;
                }

                // This is an expected recovery window, not a chat-list failure:
                // keep the last good chats, do not create an error toast, and
                // retry slowly enough to stay far below the global throttle.
                await waitForRetry(
                  delayMs,
                );
                continue;
              }

              commitChats(
                [],
              );

              showLoadChatsError(
                t(
                  'chats.errors.loadChats',
                ),
                error instanceof
                  Error
                  ? error.message
                  : undefined,
              );
              return;
            }
          }
        } finally {
          if (
            loadChatsInFlightSessionRef.current ===
            sessionId
          ) {
            loadChatsInFlightSessionRef.current =
              null;
          }

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
        showLoadChatsError,
        showLoadChatsWarning,
        t,
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

  /* ================================================================
     ASSIGNED SESSION MANAGEMENT
     ================================================================ */

  const handleStartAssignedSession =
    useCallback(
      async () => {
        if (
          !assignedSession ||
          !canStartSessions
        ) {
          return;
        }

        if (
          isSessionStarted(
            assignedSession,
          )
        ) {
          if (
            assignedSession.status ===
              'initializing' ||
            assignedSession.status ===
              'qr_ready' ||
            assignedSession.status ===
              'authenticating'
          ) {
            void handleShowQRRef.current(
              assignedSession.id,
            );
          }

          return;
        }

        setSessionAction(
          'start',
        );

        try {
          await sessionApi.start(
            assignedSession.id,
          );

          const refreshed =
            await reloadSessions();

          const current =
            refreshed.find(
              session =>
                session.id ===
                assignedSession.id,
            );

          if (
            current &&
            current.status !==
              'ready'
          ) {
            void handleShowQRRef.current(
              current.id,
            );
          }
        } catch (
          error
        ) {
          toast.error(
            t(
              'agent.sessionStartFailed',
              'Failed to start session',
            ),
            error instanceof
              Error
              ? error.message
              : undefined,
          );

          await reloadSessions();
        } finally {
          setSessionAction(
            null,
          );
        }
      },
      [
        assignedSession,
        canStartSessions,
        reloadSessions,
        t,
        toast,
      ],
    );

  const handleStopAssignedSession =
    useCallback(
      async () => {
        if (
          !assignedSession ||
          !canShutdownSessions
        ) {
          return;
        }

        setSessionAction(
          'stop',
        );

        try {
          await sessionApi.stop(
            assignedSession.id,
          );

          setQrDisplayOpen(
            false,
          );
          setLatchedQrData(
            null,
          );

          dismissQrForSession(
            assignedSession.id,
          );

          await reloadSessions();

          toast.success(
            t(
              'agent.sessionStopped',
              'Session stopped',
            ),
          );
        } catch (
          error
        ) {
          toast.error(
            t(
              'agent.sessionStopFailed',
              'Failed to stop session',
            ),
            error instanceof
              Error
              ? error.message
              : undefined,
          );

          await reloadSessions();
        } finally {
          setSessionAction(
            null,
          );
        }
      },
      [
        assignedSession,
        canShutdownSessions,
        dismissQrForSession,
        reloadSessions,
        t,
        toast,
      ],
    );

  const handleUnlinkAssignedSession =
    useCallback(
      async () => {
        if (
          !assignedSession ||
          !canShutdownSessions ||
          !canUnlinkSession(
            assignedSession,
            canShutdownSessions,
          )
        ) {
          return;
        }

        if (
          typeof window !==
            'undefined' &&
          !window.confirm(
            t(
              'agent.unlinkConfirm',
              'Unlink WhatsApp from your assigned session? You will need to pair the session again before using WhatsApp.',
            ),
          )
        ) {
          return;
        }

        setSessionAction(
          'unlink',
        );

        try {
          await sessionApi.logout(
            assignedSession.id,
          );

          setQrDisplayOpen(
            false,
          );
          setLatchedQrData(
            null,
          );

          dismissQrForSession(
            assignedSession.id,
          );

          await reloadSessions();

          toast.success(
            t(
              'sessions.unlink.successTitle',
              'Session unlinked',
            ),
            t(
              'sessions.unlink.success',
              'WhatsApp was unlinked from the session.',
            ),
          );
        } catch (
          error
        ) {
          await reloadSessions();

          if (
            classifyUnlinkError(
              error,
            ) ===
            'incomplete'
          ) {
            toast.warning(
              t(
                'sessions.unlink.incompleteTitle',
                'Unlink incomplete',
              ),
              error instanceof
                Error
                ? error.message
                : t(
                    'sessions.unlink.incomplete',
                    'The local session stopped, but WhatsApp unlinking did not complete.',
                  ),
            );
          } else {
            toast.error(
              t(
                'sessions.unlink.failedTitle',
                'Failed to unlink session',
              ),
              error instanceof
                Error
                ? error.message
                : undefined,
            );
          }
        } finally {
          setSessionAction(
            null,
          );
        }
      },
      [
        assignedSession,
        canShutdownSessions,
        dismissQrForSession,
        reloadSessions,
        t,
        toast,
      ],
    );

  const handleKillAssignedSession =
    useCallback(
      async () => {
        if (
          !assignedSession ||
          !canShutdownSessions ||
          !canForceKillSession(
            assignedSession,
            canShutdownSessions,
          )
        ) {
          return;
        }

        if (
          typeof window !==
            'undefined' &&
          !window.confirm(
            t(
              'agent.forceKillConfirm',
              'Force-kill the engine for your assigned session? Use this only when the session is stuck.',
            ),
          )
        ) {
          return;
        }

        setSessionAction(
          'kill',
        );

        try {
          await sessionApi.forceKill(
            assignedSession.id,
          );

          setQrDisplayOpen(
            false,
          );
          setLatchedQrData(
            null,
          );

          dismissQrForSession(
            assignedSession.id,
          );

          await reloadSessions();

          toast.success(
            t(
              'sessions.forceKill.successTitle',
              'Session engine stopped',
            ),
            t(
              'sessions.forceKill.success',
              'The stuck session engine was force-killed.',
            ),
          );
        } catch (
          error
        ) {
          toast.error(
            t(
              'sessions.forceKill.failedTitle',
              'Failed to force-kill session',
            ),
            error instanceof
              Error
              ? error.message
              : undefined,
          );

          await reloadSessions();
        } finally {
          setSessionAction(
            null,
          );
        }
      },
      [
        assignedSession,
        canShutdownSessions,
        dismissQrForSession,
        reloadSessions,
        t,
        toast,
      ],
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

  const handleIncomingSessionStatus =
    useCallback(
      (
        event: {
          sessionId:
            string;
          status:
            string;
        },
      ) => {
        if (
          event.sessionId !==
          selectedSessionIdRef.current
        ) {
          return;
        }

        /**
         * Do not clear QR state on transient engine statuses.
         *
         * A generated QR must remain available until the Agent closes the
         * popup or authentication actually completes. Explicit stop/unlink/
         * force-kill handlers already clear pairing state themselves.
         */
        if (
          event.status ===
          'ready'
        ) {
          setQrDisplayOpen(
            false,
          );
          setLatchedQrData(
            null,
          );

          dismissQrForSession(
            event.sessionId,
          );

          qrPrefetchKeyRef.current =
            null;

          qrReadyNotifiedSessionRef.current =
            null;
        }

        void reloadSessions();
      },
      [
        dismissQrForSession,
        reloadSessions,
      ],
    );

  const handleIncomingQRCode =
    useCallback(
      (
        event: {
          sessionId:
            string;
          qrCode:
            string;
        },
      ) => {
        if (
          event.sessionId !==
          selectedSessionIdRef.current
        ) {
          return;
        }

        setLatchedQrData({
          sessionId:
            event.sessionId,
          qrCode:
            event.qrCode,
        });

        applyQrPush(
          event,
        );
      },
      [
        applyQrPush,
      ],
    );

  const handleIncomingSessionRestriction =
    useCallback(
      (
        event: {
          sessionId:
            string;
        },
      ) => {
        if (
          event.sessionId !==
          selectedSessionIdRef.current
        ) {
          return;
        }

        void reloadSessions();
      },
      [
        reloadSessions,
      ],
    );

  // This route owns its WebSocket. A message can therefore be persisted while Agent is on another
  // page, leaving an Infinity-stale React Query slice behind. The subscription acknowledgement is
  // the reliable recovery boundary: everything before it is reconciled from REST/history, while
  // everything after it arrives through the active realtime subscription.
  const handleSubscriptionConfirmed =
    useCallback(
      (
        event:
          SubscribedEvent,
      ) => {
        if (
          event.sessionId !==
          selectedSessionIdRef.current
        ) {
          return;
        }

        void invalidateSessionMessages(
          event.sessionId,
        );

        if (sessionReady) {
          void loadChats(
            event.sessionId,
          );
        }
      },
      [
        invalidateSessionMessages,
        loadChats,
        sessionReady,
      ],
    );

  const wsEvents =
    useMemo(
      () => ({
        onSessionStatus:
          handleIncomingSessionStatus,
        onQRCode:
          handleIncomingQRCode,
        onSessionRestriction:
          handleIncomingSessionRestriction,
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
        onSubscribed:
          handleSubscriptionConfirmed,
      }),
      [
        handleIncomingMessage,
        handleIncomingMessageAck,
        handleIncomingMessageEdited,
        handleIncomingMessageReaction,
        handleIncomingMessageRevoked,
        handleIncomingQRCode,
        handleIncomingSessionRestriction,
        handleIncomingSessionStatus,
        handleSubscriptionConfirmed,
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

  const assignedSessionStarted =
    assignedSession
      ? isSessionStarted(
          assignedSession,
        )
      : false;

  const assignedQrData =
    assignedSession &&
    latchedQrData?.sessionId ===
      assignedSession.id
      ? latchedQrData
      : assignedSession &&
          qrData?.sessionId ===
            assignedSession.id
        ? qrData
        : null;

  /**
   * Surface QR readiness as a notification instead of auto-opening the image.
   * This also covers QR values obtained by the REST prefetch path, not only
   * WebSocket `session.qr` pushes.
   */
  useEffect(() => {
    if (
      !assignedSession ||
      !assignedQrData?.qrCode ||
      qrReadyNotifiedSessionRef.current ===
        assignedSession.id
    ) {
      return;
    }

    qrReadyNotifiedSessionRef.current =
      assignedSession.id;

    toast.info(
      t(
        'agent.qrReadyTitle',
        'QR code ready',
      ),
      t(
        'agent.qrReadyDescription',
        'Use the green "Show QR Code" button beside the Session controls to open it.',
      ),
    );
  }, [
    assignedQrData?.qrCode,
    assignedSession,
    t,
    toast,
  ]);

  const qrCodeReady =
    Boolean(
      assignedQrData?.qrCode,
    );

  const showPairingPanel =
    Boolean(
      assignedSession &&
        (
          assignedSession.status ===
            'initializing' ||
          assignedSession.status ===
            'qr_ready' ||
          assignedSession.status ===
            'authenticating' ||
          assignedQrData
        ),
    );

  const sessionActionPending =
    sessionAction !==
    null;

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
        </div>
      </header>

      <section
        className="agent-session-management-card"
        aria-label={t(
          'agent.sessionManagement',
          'Assigned session management',
        )}
      >
        <div className="agent-session-management-header">
          <div>
            <div className="agent-session-management-title">
              <Smartphone
                size={20}
              />

              <div>
                <h2>
                  {t(
                    'agent.sessionManagement',
                    'Assigned session management',
                  )}
                </h2>

                <p>
                  {t(
                    'agent.sessionManagementDescription',
                    'Operate only the WhatsApp session assigned to this Agent.',
                  )}
                </p>
              </div>
            </div>
          </div>

          <span
            className={`agent-status agent-status--${assignedSession.status}`}
          >
            {statusLabel(
              assignedSession.status,
            )}
          </span>
        </div>

        <div className="agent-session-management-body">
          <div className="agent-session-management-summary">
            <div>
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
            </div>

            <div>
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
            </div>

            <div>
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
            </div>
          </div>

          {assignedSession.lastError && (
            <div
              className="agent-session-warning"
              role="status"
            >
              <AlertCircle
                size={16}
              />

              <span>
                {
                  assignedSession.lastError
                }
              </span>
            </div>
          )}

          <div className="agent-session-control-row">
            {assignedSessionStarted ? (
              canShutdownSessions && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() =>
                    void handleStopAssignedSession()
                  }
                  disabled={
                    sessionActionPending
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
              )
            ) : (
              canStartSessions && (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() =>
                    void handleStartAssignedSession()
                  }
                  disabled={
                    sessionActionPending
                  }
                >
                  {sessionAction ===
                  'start' ? (
                    <Loader2
                      size={17}
                      className="animate-spin"
                    />
                  ) : assignedSession.status ===
                      'created' ||
                    assignedSession.status ===
                      'disconnected' ? (
                    <Play
                      size={17}
                    />
                  ) : (
                    <RefreshCw
                      size={17}
                    />
                  )}

                  {assignedSession.status ===
                    'created' ||
                  assignedSession.status ===
                    'disconnected'
                    ? t(
                        'sessions.actions.start',
                        'Start',
                      )
                    : t(
                        'sessions.actions.reconnect',
                        'Reconnect',
                      )}
                </button>
              )
            )}

            {qrCodeReady && (
              <button
                type="button"
                className="agent-show-qr-btn"
                onClick={() =>
                  setQrDisplayOpen(
                    true,
                  )
                }
                disabled={
                  sessionActionPending
                }
              >
                <QrCode
                  size={17}
                />

                {t(
                  'agent.showQrButton',
                  'Show QR Code',
                )}
              </button>
            )}

            {canUnlinkSession(
              assignedSession,
              canShutdownSessions,
            ) && (
              <button
                type="button"
                className="btn-secondary danger"
                onClick={() =>
                  void handleUnlinkAssignedSession()
                }
                disabled={
                  sessionActionPending
                }
              >
                {sessionAction ===
                'unlink' ? (
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

            {canForceKillSession(
              assignedSession,
              canShutdownSessions,
            ) && (
              <button
                type="button"
                className="btn-secondary danger"
                onClick={() =>
                  void handleKillAssignedSession()
                }
                disabled={
                  sessionActionPending
                }
              >
                {sessionAction ===
                'kill' ? (
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
                  'Kill Stuck',
                )}
              </button>
            )}

            {canReadTemplates && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() =>
                  navigate(
                    `/templates?session=${encodeURIComponent(
                      assignedSession.id,
                    )}`,
                  )
                }
              >
                <ClipboardList
                  size={17}
                />

                {t(
                  'templates.title',
                  'Templates',
                )}
              </button>
            )}
          </div>

          {showPairingPanel && (
            <div className="agent-pairing-panel">
              <div
                className="agent-pairing-tabs"
                role="tablist"
                aria-label={t(
                  'agent.pairingMethod',
                  'Pairing method',
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={
                    !pairingMode
                  }
                  className={`agent-pairing-tab ${
                    !pairingMode
                      ? 'active'
                      : ''
                  }`}
                  onClick={() =>
                    selectPairingTab(
                      false,
                    )
                  }
                >
                  <QrCode
                    size={16}
                  />

                  {t(
                    'sessions.pairing.tabQr',
                    'QR code',
                  )}
                </button>

                <button
                  type="button"
                  role="tab"
                  aria-selected={
                    pairingMode
                  }
                  className={`agent-pairing-tab ${
                    pairingMode
                      ? 'active'
                      : ''
                  }`}
                  onClick={() =>
                    selectPairingTab(
                      true,
                    )
                  }
                >
                  <Smartphone
                    size={16}
                  />

                  {t(
                    'sessions.pairing.tabPhone',
                    'Phone code',
                  )}
                </button>
              </div>

              {!pairingMode ? (
                <div
                  className="agent-qr-panel"
                  role="tabpanel"
                >
                  {qrCodeReady ? (
                    <div className="agent-qr-ready">
                      <div className="agent-qr-ready-copy">
                        <QrCode
                          size={28}
                          aria-hidden="true"
                        />

                        <div>
                          <strong>
                            {t(
                              'agent.qrReadyTitle',
                              'QR code ready',
                            )}
                          </strong>

                          <span>
                            {t(
                              'agent.qrReadyInlineHint',
                              'The QR will not open automatically. Open it when you are ready to scan.',
                            )}
                          </span>
                        </div>
                      </div>

                      <span className="agent-qr-ready-action-hint">
                        {t(
                          'agent.qrReadyControlHint',
                          'Use the green Show QR Code button in the Session controls above.',
                        )}
                      </span>
                    </div>
                  ) : (
                    <div className="agent-qr-loading">
                      <Loader2
                        size={32}
                        className="animate-spin"
                      />

                      <span>
                        {t(
                          'agent.qrGeneratingButtonHint',
                          'Generating QR code… The Show QR Code button will appear when it is ready.',
                        )}
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <div
                  className="agent-phone-pairing-panel"
                  role="tabpanel"
                >
                  {pairingError && (
                    <div
                      className="agent-session-warning agent-session-warning--error"
                      role="alert"
                    >
                      <AlertCircle
                        size={16}
                      />

                      <span>
                        {
                          pairingError
                        }
                      </span>
                    </div>
                  )}

                  {!pairingCode ? (
                    <>
                      <label
                        htmlFor="agent-pairing-phone"
                        className="agent-info-label"
                      >
                        {t(
                          'sessions.pairing.phoneLabel',
                          'Phone number',
                        )}
                      </label>

                      <CountryPhoneInput
                        id="agent-pairing-phone"
                        inputClassName="agent-pairing-input"
                        value={phoneNumber}
                        placeholder={t(
                          'sessions.pairing.localPhonePlaceholder',
                          'Local phone number',
                        )}
                        ariaLabel={t(
                          'sessions.pairing.countryCode',
                          'Country code',
                        )}
                        onChange={setPhoneNumber}
                        onKeyDown={event => {
                          if (
                            event.key === 'Enter' &&
                            assignedQrData &&
                            isValidPairingPhone(
                              phoneNumber,
                            )
                          ) {
                            void handleGeneratePairingCode();
                          }
                        }}
                      />

                      <button
                        type="button"
                        className="btn-primary"
                        onClick={() =>
                          void handleGeneratePairingCode()
                        }
                        disabled={
                          requestingPairing ||
                          !assignedQrData ||
                          !isValidPairingPhone(
                            phoneNumber,
                          )
                        }
                      >
                        {requestingPairing ? (
                          <Loader2
                            size={17}
                            className="animate-spin"
                          />
                        ) : (
                          <Smartphone
                            size={17}
                          />
                        )}

                        {t(
                          'sessions.pairing.generateButton',
                          'Generate pairing code',
                        )}
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="agent-info-label">
                        {t(
                          'sessions.pairing.codeLabel',
                          'Pairing code',
                        )}
                      </span>

                      <strong className="agent-pairing-code">
                        {pairingCode.substring(
                          0,
                          4,
                        )}
                        {' - '}
                        {pairingCode.substring(
                          4,
                        )}
                      </strong>

                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={
                          handleChangeNumber
                        }
                      >
                        {t(
                          'sessions.pairing.changeNumber',
                          'Change number',
                        )}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

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
              'The assigned WhatsApp session is currently unavailable for chat. Use the session management card above to start, stop, unlink, recover, or complete QR/pairing authentication for your assigned session.',
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

      <Modal
        open={
          qrDisplayOpen
        }
        onClose={() =>
          setQrDisplayOpen(
            false,
          )
        }
        title={t(
          'sessions.qr.title',
          'WhatsApp QR code',
        )}
        className="agent-qr-modal"
        closeLabel={t(
          'common.close',
          'Close',
        )}
      >
        <div className="agent-qr-modal-content">
          {assignedQrData?.qrCode ? (
            <>
              <div className="agent-qr-modal-image-wrap">
                <img
                  src={
                    assignedQrData.qrCode
                  }
                  alt={t(
                    'sessions.qr.title',
                    'WhatsApp QR code',
                  )}
                  className="agent-qr-modal-image"
                />
              </div>

              <div className="agent-qr-modal-copy">
                <strong>
                  {t(
                    'sessions.qr.scanToConnect',
                    'Scan to connect',
                  )}
                </strong>

                <span>
                  {t(
                    'agent.qrModalHint',
                    'Keep this window open while scanning. If WhatsApp rotates the QR, the latest code will replace this one automatically.',
                  )}
                </span>
              </div>
            </>
          ) : (
            <div className="agent-qr-modal-loading">
              <Loader2
                size={36}
                className="animate-spin"
              />

              <strong>
                {t(
                  'sessions.qr.generating',
                  'Generating QR code…',
                )}
              </strong>

              <span>
                {t(
                  'agent.qrModalWaitingHint',
                  'This popup will stay open and show the QR as soon as the latest code arrives.',
                )}
              </span>
            </div>
          )}
        </div>
      </Modal>

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






