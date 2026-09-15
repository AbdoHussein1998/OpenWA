import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Trans,
  useTranslation,
} from 'react-i18next';
import {
  Eye,
  Filter,
  Layers3,
  Loader2,
  Play,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Skull,
  Square,
  Trash2,
  Unlink,
  UserCheck,
  UserMinus,
  Users,
} from 'lucide-react';
import type { TFunction } from 'i18next';

import {
  sessionApi,
  type AccountRestriction,
  type CreateSessionInput,
  type Session,
  type SessionConfig,
} from '../services/api';
import {
  queryKeys,
  useAdminAgentsQuery,
  useAdminTeamLeadersQuery,
  useAssignAdminAgentSessionMutation,
  useSetAdminSessionOwnerMutation,
  useTeamLeaderAgentsQuery,
} from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  canForceKillSession,
  canUnlinkSession,
  classifyUnlinkError,
  isSessionStarted,
  replaceSession,
} from '../utils/sessionActions';
import {
  invalidateSessionQueries,
  reconcileSessionCache,
} from '../utils/sessionMutation';
import {
  canCreateSession,
  filterSessions,
  isValidPairingPhone,
  sessionNameIssues,
} from '../utils/sessionForm';
import { useToast } from '../hooks/useToast';
import { useRole } from '../hooks/useRole';
import { useSessionPairing } from '../hooks/useSessionPairing';
import { useSessionFeed } from '../hooks/useSessionFeed';
import type {
  ConnectionStage,
  SessionConnectionStageEvent,
} from '../hooks/useWebSocket';
import { useSessionCreateForm } from '../hooks/useSessionCreateForm';
import { PageHeader } from '../components/PageHeader';
import { CustomSelect } from '../components/CustomSelect';
import { Modal } from '../components/Modal';
import { CountryPhoneInput } from '../components/CountryPhoneInput';
import './Sessions.css';
import './SessionsSummary.css';

type AdminAssignmentMode = 'team_leader' | 'agent';

interface ConnectionProgress {
  attemptId: string;
  events: SessionConnectionStageEvent[];
}

const TARGET_PHONE_PATTERN = /^\+?[1-9]\d{6,14}$/;
const ALLOWED_PROXY_PROTOCOLS = new Set([
  'http:',
  'https:',
  'socks4:',
  'socks5:',
]);

function restrictionTitle(
  restriction: AccountRestriction,
  t: TFunction,
): string {
  const parts = [
    t(`sessions.restriction.${restriction.kind}`),
    restriction.code,
  ];

  if (restriction.expiresAt) {
    parts.push(
      t('sessions.restriction.until', {
        date: new Date(
          restriction.expiresAt,
        ).toLocaleString(),
      }),
    );
  }

  return parts.join(' · ');
}

function isValidProxyUrl(value: string): boolean {
  const trimmed = value.trim();

  if (!trimmed) {
    return true;
  }

  if (trimmed.length > 255) {
    return false;
  }

  try {
    const url = new URL(trimmed);
    return (
      ALLOWED_PROXY_PROTOCOLS.has(
        url.protocol,
      ) &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function getNumericConfigValue(
  config: Record<string, unknown> | undefined,
  key: string,
): number | '' {
  const value = config?.[key];
  return typeof value === 'number'
    ? value
    : '';
}

function getBooleanConfigValue(
  config: Record<string, unknown> | undefined,
  key: string,
): boolean {
  return config?.[key] === true;
}

export function Sessions() {
  const { t } = useTranslation();
  useDocumentTitle(t('sessions.title'));

  const toast = useToast();
  const {
    canManageSessions,
    canStartSessions,
    canShutdownSessions,
    canManagePrincipals,
    isTeamLeader,
  } = useRole();
  const queryClient = useQueryClient();

  const adminTeamLeadersQuery =
    useAdminTeamLeadersQuery(canManagePrincipals);
  const adminAgentsQuery =
    useAdminAgentsQuery(canManagePrincipals);
  const teamLeaderAgentsQuery =
    useTeamLeaderAgentsQuery(isTeamLeader);
  const setAdminSessionOwnerMutation =
    useSetAdminSessionOwnerMutation();
  const assignAdminAgentSessionMutation =
    useAssignAdminAgentSessionMutation();

  const [sessions, setSessions] =
    useState<Session[]>([]);
  const [loading, setLoading] =
    useState(true);
  const initialLoadDone = useRef(false);
  const [error, setError] =
    useState<string | null>(null);
  const [searchQuery, setSearchQuery] =
    useState('');
  const [statusFilter, setStatusFilter] =
    useState('all');
  const [selectedSession, setSelectedSession] =
    useState<Session | null>(null);
  const [assignmentSessionId, setAssignmentSessionId] =
    useState<string | null>(null);
  const [assignmentMode, setAssignmentMode] =
    useState<AdminAssignmentMode>('team_leader');
  const [assignmentTeamLeaderId, setAssignmentTeamLeaderId] =
    useState('');
  const [assignmentAgentId, setAssignmentAgentId] =
    useState('');
  const [deleteConfirmId, setDeleteConfirmId] =
    useState<string | null>(null);
  const [killConfirmId, setKillConfirmId] =
    useState<string | null>(null);
  const [unlinkConfirmId, setUnlinkConfirmId] =
    useState<string | null>(null);
  const [unlinkingId, setUnlinkingId] =
    useState<string | null>(null);
  const [sessionConfig, setSessionConfig] =
    useState<SessionConfig | null>(null);
  const [savingConfig, setSavingConfig] =
    useState(false);
  const [connectionProgress, setConnectionProgress] =
    useState<Record<string, ConnectionProgress>>({});

  const fetchSessions = useCallback(
    async (): Promise<Session[]> => {
      try {
        if (!initialLoadDone.current) {
          setLoading(true);
        }

        const data = await sessionApi.list();
        setSessions(data);
        setError(null);

        void invalidateSessionQueries(
          queryClient,
          queryKeys.sessions,
        );

        return data;
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t('sessions.create.errorDefault'),
        );

        return [];
      } finally {
        initialLoadDone.current = true;
        setLoading(false);
      }
    },
    [queryClient, t],
  );

  const sessionsRef = useRef<Session[]>([]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

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
  } = useSessionPairing({
    sessions,
    sessionsRef,
    reloadSessions: fetchSessions,
  });

  const {
    showCreateModal,
    setShowCreateModal,
    createInput,
    setCreateInput,
    creating,
    handleCreate,
  } = useSessionCreateForm({
    onCreated: newSession => {
      setSessions(current => [
        ...current,
        newSession,
      ]);

      void invalidateSessionQueries(
        queryClient,
        queryKeys.sessions,
      );
    },
    onFailed: message =>
      setError(message),
  });

  const setCreateConfigValue = useCallback(
    (
      key: string,
      value: unknown,
    ) => {
      setCreateInput(current => ({
        ...current,
        config: {
          ...(current.config ?? {}),
          [key]: value,
        },
      }));
    },
    [setCreateInput],
  );

  const applySessionResponse = useCallback(
    async (updated: Session) => {
      sessionsRef.current = replaceSession(
        sessionsRef.current,
        updated,
      );
      setSessions(sessionsRef.current);
      setSelectedSession(current =>
        current?.id === updated.id
          ? updated
          : current,
      );
      dismissQrForSession(updated.id);

      await reconcileSessionCache(
        queryClient,
        queryKeys.sessions,
        updated,
      );
    },
    [dismissQrForSession, queryClient],
  );

  useSessionFeed({
    sessions,
    sessionsRef,
    onQRCode: applyQrPush,
    onSessionRestriction: useCallback(() => {
      void fetchSessions();
    }, [fetchSessions]),
    onSessionConnectionStage: useCallback(
      (
        event: SessionConnectionStageEvent,
      ) => {
        setConnectionProgress(current => {
          const existing =
            current[event.sessionId];
          const previousEvents =
            existing?.attemptId ===
            event.attemptId
              ? existing.events
              : [];

          if (
            previousEvents.some(
              previous =>
                previous.stage === event.stage,
            )
          ) {
            return current;
          }

          return {
            ...current,
            [event.sessionId]: {
              attemptId: event.attemptId,
              events: [
                ...previousEvents,
                event,
              ],
            },
          };
        });
      },
      [],
    ),
    onSessionStatus: useCallback(
      (event: {
        sessionId: string;
        status: string;
      }) => {
        const previous =
          sessionsRef.current.find(
            session =>
              session.id === event.sessionId,
          );

        if (
          previous &&
          previous.status === event.status
        ) {
          return;
        }

        sessionsRef.current =
          sessionsRef.current.map(
            session =>
              session.id === event.sessionId
                ? {
                    ...session,
                    status:
                      event.status as Session['status'],
                    engineLoaded: undefined,
                  }
                : session,
          );

        setSessions(sessionsRef.current);

        void invalidateSessionQueries(
          queryClient,
          queryKeys.sessions,
        );

        if (event.status === 'ready') {
          toast.success(
            t('sessions.toasts.readyTitle'),
            t('sessions.toasts.readyDesc'),
          );
        } else if (
          event.status === 'disconnected'
        ) {
          void fetchSessions();
          toast.warning(
            t(
              'sessions.toasts.disconnectedTitle',
            ),
            t(
              'sessions.toasts.disconnectedDesc',
            ),
          );
        } else if (
          event.status === 'action_required'
        ) {
          void fetchSessions();
          toast.warning(
            t(
              'sessions.toasts.actionRequiredTitle',
            ),
            t(
              'sessions.toasts.actionRequiredDesc',
            ),
          );
        } else if (
          event.status === 'failed'
        ) {
          void fetchSessions();
          toast.error(
            t('sessions.toasts.failedTitle'),
            t('sessions.toasts.failedDesc'),
          );
        }
      },
      [fetchSessions, queryClient, t, toast],
    ),
  });

  useEffect(() => {
    void fetchSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDelete = async (
    id: string,
  ) => {
    const session = sessions.find(
      item => item.id === id,
    );

    try {
      await sessionApi.delete(id);
      setSessions(current =>
        current.filter(
          item => item.id !== id,
        ),
      );
      await invalidateSessionQueries(
        queryClient,
        queryKeys.sessions,
      );

      toast.success(
        t('sessions.delete.successTitle'),
        session
          ? t(
              'sessions.delete.successDescNamed',
              {
                name: session.name,
              },
            )
          : t(
              'sessions.delete.successDescGeneric',
            ),
      );
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('sessions.delete.errorDefault');

      console.error(
        'Failed to delete:',
        err,
      );
      toast.error(
        t('sessions.delete.errorTitle'),
        message,
      );
    } finally {
      setDeleteConfirmId(null);
    }
  };

  const handleStart = async (
    id: string,
  ) => {
    if (!canStartSessions) {
      return;
    }

    const session = sessions.find(
      item => item.id === id,
    );

    if (
      session &&
      ['initializing', 'qr_ready'].includes(
        session.status,
      )
    ) {
      if (canManageSessions) {
        handleShowQR(id);
      }
      return;
    }

    try {
      const started =
        await sessionApi.start(id);

      setSessions(current =>
        replaceSession(
          current,
          started,
        ),
      );
      await fetchSessions();

      if (canManageSessions) {
        handleShowQR(id);
      }
    } catch (err) {
      console.error(
        'Failed to start:',
        err,
      );

      const code = (
        err as {
          code?: string;
        } | null | undefined
      )?.code;

      if (
        code ===
        'SESSION_NAME_TEARDOWN_PENDING'
      ) {
        const message =
          err instanceof Error && err.message
            ? err.message
            : t(
                'sessions.start.teardownPending',
              );

        toast.warning(
          t(
            'sessions.start.teardownPendingTitle',
          ),
          message,
        );
        await fetchSessions();
        return;
      }

      const fresh = await fetchSessions();
      const current = fresh.find(
        item => item.id === id,
      );

      if (
        canManageSessions &&
        current?.status !== 'ready'
      ) {
        handleShowQR(id);
      }
    }
  };

  const selectedSessionId =
    selectedSession?.id ?? null;

  useEffect(() => {
    setSessionConfig(null);

    if (
      !selectedSessionId ||
      !canManageSessions
    ) {
      return;
    }

    let cancelled = false;

    sessionApi
      .getConfig(selectedSessionId)
      .then(config => {
        if (!cancelled) {
          setSessionConfig(config);
        }
      })
      .catch(() => {
        // Keep the config row absent when the read fails.
      });

    return () => {
      cancelled = true;
    };
  }, [
    selectedSessionId,
    canManageSessions,
  ]);

  const handleAutoRejectToggle = async (
    next: boolean,
  ) => {
    if (
      !canManageSessions ||
      !selectedSessionId ||
      !sessionConfig
    ) {
      return;
    }

    const previous = sessionConfig;
    setSessionConfig({
      ...sessionConfig,
      autoRejectCalls: next,
    });
    setSavingConfig(true);

    try {
      setSessionConfig(
        await sessionApi.updateConfig(
          selectedSessionId,
          {
            autoRejectCalls: next,
          },
        ),
      );
    } catch (err) {
      setSessionConfig(previous);
      toast.error(
        t('sessions.details.autoRejectCalls'),
        err instanceof Error
          ? err.message
          : t('common.unknownError'),
      );
    } finally {
      setSavingConfig(false);
    }
  };

  const handleStop = async (
    id: string,
  ) => {
    if (!canShutdownSessions) {
      return;
    }

    try {
      const updated =
        await sessionApi.stop(id);
      await applySessionResponse(updated);
    } catch (err) {
      console.error(
        'Failed to stop:',
        err,
      );
      await fetchSessions();
    }
  };

  const handleForceKill = async (
    id: string,
  ) => {
    if (!canShutdownSessions) {
      return;
    }

    try {
      const updated =
        await sessionApi.forceKill(id);
      await applySessionResponse(updated);
      toast.success(
        t('sessions.forceKill.successTitle'),
        t('sessions.forceKill.success'),
      );
    } catch (err) {
      console.error(
        'Failed to force-kill:',
        err,
      );
      toast.error(
        t('sessions.forceKill.failedTitle'),
        t('sessions.forceKill.failed'),
      );
      await fetchSessions();
    } finally {
      setKillConfirmId(null);
    }
  };

  const handleUnlink = async (
    id: string,
  ) => {
    if (
      !canShutdownSessions ||
      unlinkingId
    ) {
      return;
    }

    setUnlinkingId(id);

    try {
      const updated =
        await sessionApi.logout(id);
      await applySessionResponse(updated);
      toast.success(
        t('sessions.unlink.successTitle'),
        t('sessions.unlink.success'),
      );
    } catch (err) {
      console.error(
        'Failed to unlink:',
        err,
      );
      await fetchSessions();

      if (
        classifyUnlinkError(err) ===
        'incomplete'
      ) {
        const message =
          err instanceof Error && err.message
            ? err.message
            : t(
                'sessions.unlink.incomplete',
              );

        toast.warning(
          t(
            'sessions.unlink.incompleteTitle',
          ),
          message,
        );
      } else {
        toast.error(
          t('sessions.unlink.failedTitle'),
          t('sessions.unlink.failed'),
        );
      }
    } finally {
      setUnlinkConfirmId(null);
      setUnlinkingId(null);
    }
  };

  const assignmentSession =
    assignmentSessionId
      ? sessions.find(
          session =>
            session.id === assignmentSessionId,
        ) ?? null
      : null;

  const adminTeamLeaders =
    adminTeamLeadersQuery.data ?? [];
  const adminAgents =
    adminAgentsQuery.data ?? [];

  const currentAssignedAgent =
    assignmentSession
      ? adminAgents.find(
          agent =>
            agent.assignedSessionId ===
            assignmentSession.id,
        ) ?? null
      : null;

  const currentOwnerTeamLeader =
    assignmentSession?.ownerTeamLeaderId
      ? adminTeamLeaders.find(
          teamLeader =>
            teamLeader.id ===
            assignmentSession.ownerTeamLeaderId,
        ) ?? null
      : null;

  const assignmentBusy =
    setAdminSessionOwnerMutation.isPending ||
    assignAdminAgentSessionMutation.isPending;

  const openAssignmentModal = (
    session: Session,
  ) => {
    const assignedAgent =
      adminAgents.find(
        agent =>
          agent.assignedSessionId ===
          session.id,
      );

    setAssignmentSessionId(session.id);
    setAssignmentMode(
      assignedAgent
        ? 'agent'
        : 'team_leader',
    );
    setAssignmentAgentId(
      assignedAgent?.id ?? '',
    );
    setAssignmentTeamLeaderId(
      session.ownerTeamLeaderId ?? '',
    );
  };

  const closeAssignmentModal = () => {
    if (assignmentBusy) {
      return;
    }

    setAssignmentSessionId(null);
    setAssignmentAgentId('');
    setAssignmentTeamLeaderId('');
    setAssignmentMode('team_leader');
  };

  const assignSessionToTeamLeader = async () => {
    if (
      !assignmentSession ||
      !assignmentTeamLeaderId ||
      assignmentBusy
    ) {
      return;
    }

    try {
      await setAdminSessionOwnerMutation.mutateAsync({
        sessionId: assignmentSession.id,
        data: {
          targetTeamLeaderId:
            assignmentTeamLeaderId,
        },
      });

      await fetchSessions();
      toast.success(
        t('sessions.assignment.teamLeaderSuccessTitle', {
          defaultValue: 'Session assigned',
        }),
        t('sessions.assignment.teamLeaderSuccessDescription', {
          defaultValue:
            'Session ownership was assigned to the selected Team Leader.',
        }),
      );
      closeAssignmentModal();
    } catch (err) {
      toast.error(
        t('sessions.assignment.failedTitle', {
          defaultValue: 'Assignment failed',
        }),
        err instanceof Error
          ? err.message
          : t('common.unknownError'),
      );
    }
  };

  const assignSessionToAgent = async () => {
    if (
      !assignmentSession ||
      !assignmentAgentId ||
      assignmentBusy
    ) {
      return;
    }

    try {
      await assignAdminAgentSessionMutation.mutateAsync({
        agentId: assignmentAgentId,
        data: {
          sessionId: assignmentSession.id,
        },
      });

      await fetchSessions();
      toast.success(
        t('sessions.assignment.agentSuccessTitle', {
          defaultValue: 'Agent assigned',
        }),
        t('sessions.assignment.agentSuccessDescription', {
          defaultValue:
            'The Session was assigned to the Agent and ownership was synchronized to that Agent\'s Team Leader.',
        }),
      );
      closeAssignmentModal();
    } catch (err) {
      toast.error(
        t('sessions.assignment.failedTitle', {
          defaultValue: 'Assignment failed',
        }),
        err instanceof Error
          ? err.message
          : t('common.unknownError'),
      );
    }
  };

  const unassignCurrentAgent = async () => {
    if (
      !currentAssignedAgent ||
      assignmentBusy
    ) {
      return;
    }

    try {
      await assignAdminAgentSessionMutation.mutateAsync({
        agentId: currentAssignedAgent.id,
        data: {
          sessionId: null,
        },
      });

      setAssignmentAgentId('');
      await fetchSessions();
      toast.success(
        t('sessions.assignment.agentUnassignedTitle', {
          defaultValue: 'Agent unassigned',
        }),
        t('sessions.assignment.agentUnassignedDescription', {
          defaultValue:
            'The Agent assignment was cleared. Team Leader ownership was left unchanged.',
        }),
      );
    } catch (err) {
      toast.error(
        t('sessions.assignment.failedTitle', {
          defaultValue: 'Assignment failed',
        }),
        err instanceof Error
          ? err.message
          : t('common.unknownError'),
      );
    }
  };

  const formatLastActive = (
    date?: string | null,
  ) => {
    if (!date) {
      return t('common.never');
    }

    const diff =
      Date.now() -
      new Date(date).getTime();

    if (diff < 60_000) {
      return t('common.justNow');
    }

    if (diff < 3_600_000) {
      return t('common.minAgo', {
        count: Math.floor(
          diff / 60_000,
        ),
      });
    }

    return new Date(
      date,
    ).toLocaleDateString();
  };

  const formatStatus = (
    status: string,
  ) =>
    t(`sessionStatus.${status}`, {
      defaultValue: status,
    });

  const formatConnectionStage = (
    stage: ConnectionStage,
  ): string => {
    switch (stage) {
      case 'qr_ready':
        return t(
          'sessions.connectionStage.qrReady',
          {
            defaultValue: 'QR ready',
          },
        );
      case 'qr_scanned':
        return t(
          'sessions.connectionStage.qrScanned',
          {
            defaultValue: 'QR scanned',
          },
        );
      case 'authenticated':
        return t(
          'sessions.connectionStage.authenticated',
          {
            defaultValue:
              'WhatsApp accepted authentication',
          },
        );
      case 'authenticating':
        return t(
          'sessions.connectionStage.authenticating',
          {
            defaultValue:
              'Preparing WhatsApp Web',
          },
        );
      case 'runtime_connected':
        return t(
          'sessions.connectionStage.runtimeConnected',
          {
            defaultValue:
              'WhatsApp runtime connected',
          },
        );
      case 'identity_ready':
        return t(
          'sessions.connectionStage.identityReady',
          {
            defaultValue:
              'Account identity loaded',
          },
        );
      case 'event_bridge_ready':
        return t(
          'sessions.connectionStage.eventBridgeReady',
          {
            defaultValue:
              'Message event bridge attached',
          },
        );
      case 'ready':
        return t(
          'sessions.connectionStage.ready',
          {
            defaultValue: 'Session ready',
          },
        );
    }
  };

  const assignedSessionIds =
    useMemo(() => {
      const ids =
        new Set<string>();

      if (canManagePrincipals) {
        for (
          const agent of
          adminAgentsQuery.data ?? []
        ) {
          if (agent.assignedSessionId) {
            ids.add(
              agent.assignedSessionId,
            );
          }
        }
      } else if (isTeamLeader) {
        for (
          const agent of
          teamLeaderAgentsQuery.data ?? []
        ) {
          if (agent.assignedSessionId) {
            ids.add(
              agent.assignedSessionId,
            );
          }
        }
      }

      return ids;
    }, [
      adminAgentsQuery.data,
      canManagePrincipals,
      isTeamLeader,
      teamLeaderAgentsQuery.data,
    ]);

  const assignmentDataLoading =
    canManagePrincipals
      ? adminAgentsQuery.isLoading
      : isTeamLeader
        ? teamLeaderAgentsQuery.isLoading
        : false;

  const assignmentDataAvailable =
    canManagePrincipals
      ? !adminAgentsQuery.isError
      : isTeamLeader
        ? !teamLeaderAgentsQuery.isError
        : false;

  const totalSessionCount =
    sessions.length;

  const assignedSessionCount =
    assignmentDataAvailable
      ? sessions.reduce(
          (count, session) =>
            count +
            (assignedSessionIds.has(
              session.id,
            )
              ? 1
              : 0),
          0,
        )
      : null;

  const unassignedSessionCount =
    assignedSessionCount === null
      ? null
      : totalSessionCount -
        assignedSessionCount;

  const filteredSessions =
    filterSessions(
      sessions,
      searchQuery,
      statusFilter,
    );
  const existingSessionNames =
    sessions.map(session => session.name);
  const nameIssues = createInput.name
    ? sessionNameIssues(
        createInput.name,
        existingSessionNames,
      )
    : [];

  const targetPhone =
    createInput.targetPhone ?? '';
  const proxyUrl =
    createInput.proxyUrl ?? '';
  const maxReconnectAttempts =
    getNumericConfigValue(
      createInput.config,
      'maxReconnectAttempts',
    );
  const reconnectBaseDelay =
    getNumericConfigValue(
      createInput.config,
      'reconnectBaseDelay',
    );
  const autoRejectCalls =
    getBooleanConfigValue(
      createInput.config,
      'autoRejectCalls',
    );

  const targetPhoneValid =
    !targetPhone.trim() ||
    TARGET_PHONE_PATTERN.test(
      targetPhone.trim(),
    );
  const proxyUrlValid =
    isValidProxyUrl(proxyUrl);
  const maxReconnectAttemptsValid =
    maxReconnectAttempts === '' ||
    (Number.isInteger(
      maxReconnectAttempts,
    ) &&
      maxReconnectAttempts >= 0 &&
      maxReconnectAttempts <= 20);
  const reconnectBaseDelayValid =
    reconnectBaseDelay === '' ||
    (Number.isInteger(
      reconnectBaseDelay,
    ) &&
      reconnectBaseDelay >= 1_000 &&
      reconnectBaseDelay <= 300_000);

  const sessionNameMinLengthValid =
    createInput.name.length >= 3;

  const createFormValid =
    canCreateSession(
      createInput.name,
      existingSessionNames,
    ) &&
    sessionNameMinLengthValid &&
    targetPhoneValid &&
    proxyUrlValid &&
    maxReconnectAttemptsValid &&
    reconnectBaseDelayValid;

  const activeConnectionProgress =
    qrData
      ? connectionProgress[
          qrData.sessionId
        ]
      : undefined;
  const activeConnectionEvents =
    activeConnectionProgress?.events ?? [];
  const latestConnectionEvent =
    activeConnectionEvents.at(-1);
  const hasPostLinkProgress =
    activeConnectionEvents.some(
      event => event.stage !== 'qr_ready',
    );

  const connectionProgressPanel =
    activeConnectionProgress &&
    hasPostLinkProgress ? (
      <div
        className="qr-instructions"
        role="status"
        aria-live="polite"
      >
        <p className="pairing-instructions-title">
          {t(
            'sessions.connectionStage.connecting',
            {
              defaultValue:
                'Connecting WhatsApp',
            },
          )}
        </p>

        {activeConnectionEvents
          .filter(
            event =>
              event.stage !== 'qr_ready',
          )
          .map(event => (
            <p
              className="qr-step"
              key={`${event.attemptId}:${event.stage}`}
            >
              <strong>✓</strong>{' '}
              {formatConnectionStage(
                event.stage,
              )}
            </p>
          ))}

        {latestConnectionEvent?.stage !==
          'ready' && (
          <p className="qr-auto-refresh">
            <Loader2
              size={14}
              className="animate-spin"
            />{' '}
            {t(
              'sessions.connectionStage.waiting',
              {
                defaultValue:
                  'Waiting for the next connection stage…',
              },
            )}
          </p>
        )}

        <p className="input-hint">
          {t(
            'sessions.connectionStage.attempt',
            {
              defaultValue:
                'Attempt {{attemptId}} · {{seconds}}s',
              attemptId:
                activeConnectionProgress.attemptId.slice(
                  0,
                  8,
                ),
              seconds: (
                (latestConnectionEvent?.elapsedMs ??
                  0) / 1000
              ).toFixed(1),
            },
          )}
        </p>
      </div>
    ) : null;

  if (loading) {
    return (
      <div
        className="sessions-page"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '400px',
        }}
      >
        <Loader2
          className="animate-spin"
          size={32}
        />
      </div>
    );
  }

  return (
    <div className="sessions-page">
      <PageHeader
        title={t('sessions.title')}
        subtitle={t('sessions.subtitle')}
        actions={
          canManageSessions ? (
            <button
              className="btn-primary"
              onClick={() =>
                setShowCreateModal(true)
              }
            >
              <Plus size={18} />
              {t('sessions.newSession')}
            </button>
          ) : null
        }
      />

      <section
        className="sessions-summary-grid"
        aria-label="Session assignment overview"
      >
        <article className="sessions-summary-card">
          <div className="sessions-summary-icon">
            <Layers3 size={20} />
          </div>
          <div>
            <span className="sessions-summary-label">
              {t(
                'sessions.summary.total',
                {
                  defaultValue:
                    'Total Sessions',
                },
              )}
            </span>
            <strong className="sessions-summary-value">
              {totalSessionCount}
            </strong>
            <span className="sessions-summary-hint">
              {t(
                'sessions.summary.totalHint',
                {
                  defaultValue:
                    'All Sessions visible to this account',
                },
              )}
            </span>
          </div>
        </article>

        <article className="sessions-summary-card sessions-summary-card--assigned">
          <div className="sessions-summary-icon">
            <UserCheck size={20} />
          </div>
          <div>
            <span className="sessions-summary-label">
              {t(
                'sessions.summary.assigned',
                {
                  defaultValue:
                    'Assigned Sessions',
                },
              )}
            </span>
            <strong className="sessions-summary-value">
              {assignmentDataLoading
                ? '…'
                : assignedSessionCount ??
                  '—'}
            </strong>
            <span className="sessions-summary-hint">
              {assignmentDataAvailable
                ? t(
                    'sessions.summary.assignedHint',
                    {
                      defaultValue:
                        'Sessions assigned to Agents',
                    },
                  )
                : t(
                    'sessions.summary.assignmentUnavailable',
                    {
                      defaultValue:
                        'Assignment data unavailable for this role',
                    },
                  )}
            </span>
          </div>
        </article>

        <article className="sessions-summary-card sessions-summary-card--unassigned">
          <div className="sessions-summary-icon">
            <UserMinus size={20} />
          </div>
          <div>
            <span className="sessions-summary-label">
              {t(
                'sessions.summary.unassigned',
                {
                  defaultValue:
                    'Unassigned Sessions',
                },
              )}
            </span>
            <strong className="sessions-summary-value">
              {assignmentDataLoading
                ? '…'
                : unassignedSessionCount ??
                  '—'}
            </strong>
            <span className="sessions-summary-hint">
              {assignmentDataAvailable
                ? t(
                    'sessions.summary.unassignedHint',
                    {
                      defaultValue:
                        'Sessions with no Agent assignment',
                    },
                  )
                : t(
                    'sessions.summary.assignmentUnavailable',
                    {
                      defaultValue:
                        'Assignment data unavailable for this role',
                    },
                  )}
            </span>
          </div>
        </article>
      </section>

      <div className="filters-bar">
        <div className="search-input">
          <Search size={18} />
          <input
            type="text"
            placeholder={t(
              'sessions.searchPlaceholder',
            )}
            value={searchQuery}
            onChange={event =>
              setSearchQuery(
                event.target.value,
              )
            }
          />
        </div>

        <div className="filter-group">
          <Filter size={16} />
          <CustomSelect
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              {
                value: 'all',
                label: t(
                  'sessions.filter.all',
                ),
              },
              {
                value: 'active',
                label: t(
                  'sessions.filter.active',
                ),
              },
              {
                value: 'inactive',
                label: t(
                  'sessions.filter.inactive',
                ),
              },
              {
                value: 'connecting',
                label: t(
                  'sessions.filter.connecting',
                ),
              },
            ]}
          />
        </div>
      </div>

      {error && (
        <div
          style={{
            background:
              'rgba(239, 68, 68, 0.12)',
            padding: '1rem',
            borderRadius: '8px',
            color: 'var(--error)',
            marginBottom: '1rem',
          }}
        >
          {error}
        </div>
      )}

      {showCreateModal &&
        canManageSessions && (
          <Modal
            open
            onClose={() =>
              setShowCreateModal(false)
            }
            title={t(
              'sessions.create.title',
            )}
            closeLabel={t('common.close')}
            footer={
              <>
                <button
                  className="btn-secondary"
                  onClick={() =>
                    setShowCreateModal(false)
                  }
                  disabled={creating}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="btn-primary"
                  onClick={() =>
                    void handleCreate()
                  }
                  disabled={
                    creating ||
                    !createFormValid
                  }
                >
                  {creating ? (
                    <Loader2
                      className="animate-spin"
                      size={16}
                    />
                  ) : (
                    t('common.create')
                  )}
                </button>
              </>
            }
          >
            <div
              style={{
                display: 'grid',
                gap: '1rem',
              }}
            >
              <div>
                <label htmlFor="sess-name">
                  {t('sessions.create.label')}
                </label>
                <input
                  id="sess-name"
                  type="text"
                  placeholder={t(
                    'sessions.create.placeholder',
                  )}
                  value={createInput.name}
                  onChange={event => {
                    const value =
                      event.target.value
                        .toLowerCase()
                        .replace(/\s+/g, '-');

                    setCreateInput(current => ({
                      ...current,
                      name: value,
                    }));
                  }}
                  onKeyDown={event => {
                    if (
                      event.key === 'Enter' &&
                      createFormValid &&
                      !creating
                    ) {
                      void handleCreate();
                    }
                  }}
                />
                <p className="input-hint">
                  <Trans
                    i18nKey="sessions.create.hint"
                    components={{
                      code: <code />,
                    }}
                  />
                </p>
                {createInput.name.length > 0 &&
                  !sessionNameMinLengthValid && (
                    <p className="input-error">
                      {t(
                        'sessions.create.tooShort',
                        {
                          defaultValue:
                            'Session name must be at least 3 characters.',
                        },
                      )}
                    </p>
                  )}
                {nameIssues.includes(
                  'format',
                ) && (
                  <p className="input-error">
                    {t(
                      'sessions.create.invalidChars',
                    )}
                  </p>
                )}
                {nameIssues.includes(
                  'too-long',
                ) && (
                  <p className="input-error">
                    {t(
                      'sessions.create.tooLong',
                      {
                        length:
                          createInput.name.length,
                      },
                    )}
                  </p>
                )}
                {nameIssues.includes(
                  'duplicate',
                ) && (
                  <p className="input-error">
                    {t(
                      'sessions.create.duplicate',
                    )}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="sess-target-phone">
                  {t(
                    'sessions.create.targetPhoneLabel',
                    {
                      defaultValue:
                        'Target phone (optional)',
                    },
                  )}
                </label>
                <CountryPhoneInput
                  id="sess-target-phone"
                  value={targetPhone}
                  placeholder="Local phone number"
                  ariaLabel={t(
                    'sessions.create.targetPhoneCountry',
                    {
                      defaultValue:
                        'Target phone country code',
                    },
                  )}
                  onChange={value =>
                    setCreateInput(current => ({
                      ...current,
                      targetPhone: value,
                    }))
                  }
                />
                {!targetPhoneValid && (
                  <p className="input-error">
                    {t(
                      'sessions.create.targetPhoneInvalid',
                      {
                        defaultValue:
                          'Choose a country code and enter a valid phone number. The complete international number must contain 7 to 15 digits.',
                      },
                    )}
                  </p>
                )}
              </div>

              <div className="detail-item detail-item-toggle">
                <div className="detail-toggle-row">
                  <span
                    className="detail-label"
                    id="create-auto-reject-calls-label"
                  >
                    {t(
                      'sessions.details.autoRejectCalls',
                    )}
                  </span>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      aria-labelledby="create-auto-reject-calls-label"
                      checked={autoRejectCalls}
                      onChange={event =>
                        setCreateConfigValue(
                          'autoRejectCalls',
                          event.target.checked,
                        )
                      }
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
                <small className="detail-hint">
                  {t(
                    'sessions.details.autoRejectCallsHint',
                  )}
                </small>
              </div>

              <div>
                <label htmlFor="sess-max-reconnect-attempts">
                  {t(
                    'sessions.create.maxReconnectAttemptsLabel',
                    {
                      defaultValue:
                        'Max reconnect attempts (optional)',
                    },
                  )}
                </label>
                <input
                  id="sess-max-reconnect-attempts"
                  type="number"
                  min={0}
                  max={20}
                  step={1}
                  value={maxReconnectAttempts}
                  placeholder={t(
                    'sessions.create.unlimitedPlaceholder',
                    {
                      defaultValue:
                        'Unlimited',
                    },
                  )}
                  onChange={event =>
                    setCreateConfigValue(
                      'maxReconnectAttempts',
                      event.target.value === ''
                        ? undefined
                        : Number(
                            event.target.value,
                          ),
                    )
                  }
                />
                {!maxReconnectAttemptsValid && (
                  <p className="input-error">
                    {t(
                      'sessions.create.maxReconnectAttemptsInvalid',
                      {
                        defaultValue:
                          'Enter an integer from 0 to 20, or leave it blank for unlimited reconnects.',
                      },
                    )}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="sess-reconnect-base-delay">
                  {t(
                    'sessions.create.reconnectBaseDelayLabel',
                    {
                      defaultValue:
                        'Reconnect base delay in ms (optional)',
                    },
                  )}
                </label>
                <input
                  id="sess-reconnect-base-delay"
                  type="number"
                  min={1000}
                  max={300000}
                  step={1000}
                  value={reconnectBaseDelay}
                  placeholder="5000"
                  onChange={event =>
                    setCreateConfigValue(
                      'reconnectBaseDelay',
                      event.target.value === ''
                        ? undefined
                        : Number(
                            event.target.value,
                          ),
                    )
                  }
                />
                {!reconnectBaseDelayValid && (
                  <p className="input-error">
                    {t(
                      'sessions.create.reconnectBaseDelayInvalid',
                      {
                        defaultValue:
                          'Enter an integer from 1000 to 300000 milliseconds.',
                      },
                    )}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="sess-proxy-url">
                  {t(
                    'sessions.create.proxyUrlLabel',
                    {
                      defaultValue:
                        'Proxy URL (optional)',
                    },
                  )}
                </label>
                <input
                  id="sess-proxy-url"
                  type="text"
                  maxLength={255}
                  placeholder="http://proxy-host:8080"
                  value={proxyUrl}
                  onChange={event =>
                    setCreateInput(current => ({
                      ...current,
                      proxyUrl:
                        event.target.value,
                    }))
                  }
                />
                {!proxyUrlValid && (
                  <p className="input-error">
                    {t(
                      'sessions.create.proxyUrlInvalid',
                      {
                        defaultValue:
                          'Use a valid http, https, socks4, or socks5 proxy URL.',
                      },
                    )}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="sess-proxy-type">
                  {t(
                    'sessions.create.proxyTypeLabel',
                    {
                      defaultValue:
                        'Proxy type',
                    },
                  )}
                </label>
                <select
                  id="sess-proxy-type"
                  value={
                    createInput.proxyType ??
                    'http'
                  }
                  onChange={event =>
                    setCreateInput(current => ({
                      ...current,
                      proxyType:
                        event.target.value as CreateSessionInput['proxyType'],
                    }))
                  }
                >
                  <option value="http">
                    http
                  </option>
                  <option value="https">
                    https
                  </option>
                  <option value="socks4">
                    socks4
                  </option>
                  <option value="socks5">
                    socks5
                  </option>
                </select>
              </div>
            </div>
          </Modal>
        )}

      {qrData && canManageSessions && (
        <Modal
          open
          onClose={handleCloseQRModal}
          className="qr-modal"
          closeLabel={t('common.close')}
          title={
            <span className="modal-title">
              {pairingMode
                ? t(
                    'sessions.pairing.tabPhone',
                  )
                : t(
                    'sessions.qr.title',
                  )}
              <span className="session-name">
                {qrData.sessionName}
              </span>
            </span>
          }
        >
          <div style={{ textAlign: 'center' }}>
            {!pairingCode &&
              !hasPostLinkProgress && (
                <div
                  className="pairing-tabs"
                  role="tablist"
                >
                  <button
                    role="tab"
                    aria-selected={!pairingMode}
                    className={`pairing-tab-btn ${
                      !pairingMode
                        ? 'active'
                        : ''
                    }`}
                    onClick={() =>
                      selectPairingTab(false)
                    }
                  >
                    {t(
                      'sessions.pairing.tabQr',
                    )}
                  </button>
                  <button
                    role="tab"
                    aria-selected={pairingMode}
                    className={`pairing-tab-btn ${
                      pairingMode
                        ? 'active'
                        : ''
                    }`}
                    onClick={() =>
                      selectPairingTab(true)
                    }
                  >
                    {t(
                      'sessions.pairing.tabPhone',
                    )}
                  </button>
                </div>
              )}

            {connectionProgressPanel ??
              (!pairingMode ? (
                qrData.qrCode ? (
                  <>
                    <img
                      src={qrData.qrCode}
                      alt="QR"
                      style={{
                        maxWidth: '280px',
                        borderRadius: '12px',
                      }}
                    />
                    <div className="qr-instructions">
                      <p className="qr-step">
                        <Trans
                          i18nKey="sessions.qr.step1"
                          components={{
                            strong: <strong />,
                          }}
                        />
                      </p>
                      <p className="qr-step">
                        <Trans
                          i18nKey="sessions.qr.step2"
                          components={{
                            strong: <strong />,
                          }}
                        />
                      </p>
                      <p className="qr-step">
                        <Trans
                          i18nKey="sessions.qr.step3"
                          components={{
                            strong: <strong />,
                          }}
                        />
                      </p>
                    </div>
                    <p className="qr-auto-refresh">
                      <RefreshCw
                        size={14}
                        className="spin-slow"
                      />{' '}
                      {t(
                        'sessions.qr.autoRefresh',
                      )}
                    </p>
                  </>
                ) : (
                  <div
                    style={{
                      padding: '2rem',
                    }}
                  >
                    <Loader2
                      className="animate-spin"
                      size={48}
                    />
                    <p>
                      {t(
                        'sessions.qr.generating',
                      )}
                    </p>
                  </div>
                )
              ) : (
                <div
                  className="pairing-container"
                  role="tabpanel"
                >
                  {pairingError && (
                    <div className="pairing-error">
                      {pairingError}
                    </div>
                  )}

                  {!pairingCode ? (
                    <div className="pairing-form">
                      <label
                        htmlFor="pairing-phone"
                        className="pairing-label"
                      >
                        {t(
                          'sessions.pairing.phoneLabel',
                        )}
                      </label>
                      <CountryPhoneInput
                        id="pairing-phone"
                        inputClassName="pairing-input"
                        value={phoneNumber}
                        placeholder={t(
                          'sessions.pairing.localPhonePlaceholder',
                          {
                            defaultValue:
                              'Local phone number',
                          },
                        )}
                        ariaLabel={t(
                          'sessions.pairing.countryCode',
                          {
                            defaultValue:
                              'Country code',
                          },
                        )}
                        onChange={setPhoneNumber}
                        onKeyDown={event => {
                          if (
                            event.key === 'Enter' &&
                            isValidPairingPhone(
                              phoneNumber,
                            )
                          ) {
                            void handleGeneratePairingCode();
                          }
                        }}
                      />
                      <p
                        className="input-hint"
                        style={{
                          marginBottom:
                            '1.5rem',
                        }}
                      >
                        {t(
                          'sessions.pairing.phoneHint',
                        )}
                      </p>
                      <button
                        className="btn-primary"
                        onClick={() =>
                          void handleGeneratePairingCode()
                        }
                        disabled={
                          requestingPairing ||
                          !isValidPairingPhone(
                            phoneNumber,
                          )
                        }
                        style={{
                          width: '100%',
                          justifyContent:
                            'center',
                        }}
                      >
                        {requestingPairing ? (
                          <>
                            <Loader2
                              className="animate-spin"
                              size={16}
                            />
                            <span
                              style={{
                                marginLeft:
                                  '0.5rem',
                              }}
                            >
                              {t(
                                'sessions.pairing.generating',
                              )}
                            </span>
                          </>
                        ) : (
                          t(
                            'sessions.pairing.generateButton',
                          )
                        )}
                      </button>
                    </div>
                  ) : (
                    <>
                      <label
                        style={{
                          display: 'block',
                          fontWeight: 600,
                          color:
                            'var(--text-secondary)',
                        }}
                      >
                        {t(
                          'sessions.pairing.codeLabel',
                        )}
                      </label>
                      <div className="pairing-code-display">
                        {pairingCode.substring(
                          0,
                          4,
                        )}{' '}
                        -{' '}
                        {pairingCode.substring(
                          4,
                        )}
                      </div>
                      <div className="qr-instructions">
                        <p className="pairing-instructions-title">
                          {t(
                            'sessions.pairing.instructions',
                          )}
                        </p>
                        <p className="qr-step">
                          <Trans
                            i18nKey="sessions.pairing.step1"
                            components={{
                              strong: (
                                <strong />
                              ),
                            }}
                          />
                        </p>
                        <p className="qr-step">
                          <Trans
                            i18nKey="sessions.pairing.step2"
                            components={{
                              strong: (
                                <strong />
                              ),
                            }}
                          />
                        </p>
                        <p className="qr-step">
                          <Trans
                            i18nKey="sessions.pairing.step3"
                            components={{
                              strong: (
                                <strong />
                              ),
                            }}
                          />
                        </p>
                        <p className="qr-step">
                          <Trans
                            i18nKey="sessions.pairing.step4"
                            components={{
                              strong: (
                                <strong />
                              ),
                            }}
                          />
                        </p>
                      </div>
                      <div
                        style={{
                          marginTop: '1.5rem',
                        }}
                      >
                        <button
                          className="btn-secondary"
                          onClick={
                            handleChangeNumber
                          }
                          style={{
                            width: '100%',
                          }}
                        >
                          {t(
                            'sessions.pairing.changeNumber',
                          )}
                        </button>
                      </div>
                      <p className="qr-auto-refresh">
                        <RefreshCw
                          size={14}
                          className="spin-slow"
                        />{' '}
                        {t(
                          'sessions.pairing.waitingConnection',
                        )}
                      </p>
                    </>
                  )}
                </div>
              ))}
          </div>
        </Modal>
      )}

      {assignmentSession &&
        canManagePrincipals && (
          <Modal
            open
            onClose={closeAssignmentModal}
            title={t('sessions.assignment.title', {
              defaultValue: `Assign ${assignmentSession.name}`,
            })}
            closeLabel={t('common.close')}
            hideCloseButton={assignmentBusy}
            footer={
              <>
                <button
                  className="btn-secondary"
                  onClick={closeAssignmentModal}
                  disabled={assignmentBusy}
                >
                  {t('common.cancel')}
                </button>

                <button
                  className="btn-primary"
                  onClick={() =>
                    void (
                      assignmentMode === 'agent'
                        ? assignSessionToAgent()
                        : assignSessionToTeamLeader()
                    )
                  }
                  disabled={
                    assignmentBusy ||
                    (assignmentMode === 'agent'
                      ? !assignmentAgentId
                      : !assignmentTeamLeaderId)
                  }
                >
                  {assignmentBusy ? (
                    <Loader2
                      size={16}
                      className="animate-spin"
                    />
                  ) : (
                    <Users size={16} />
                  )}
                  {t('sessions.assignment.confirm', {
                    defaultValue: 'Assign',
                  })}
                </button>
              </>
            }
          >
            <div
              style={{
                display: 'grid',
                gap: '1rem',
              }}
            >
              <div className="detail-grid">
                <div className="detail-item">
                  <span className="detail-label">
                    {t('sessions.details.sessionId')}
                  </span>
                  <span className="detail-value mono">
                    {assignmentSession.id}
                  </span>
                </div>

                <div className="detail-item">
                  <span className="detail-label">
                    {t('sessions.assignment.currentOwner', {
                      defaultValue: 'Current Team Leader',
                    })}
                  </span>
                  <span className="detail-value">
                    {currentOwnerTeamLeader?.name ??
                      assignmentSession.ownerTeamLeaderId ??
                      t('sessions.assignment.unassigned', {
                        defaultValue: 'Unassigned',
                      })}
                  </span>
                </div>

                <div className="detail-item">
                  <span className="detail-label">
                    {t('sessions.assignment.currentAgent', {
                      defaultValue: 'Current Agent',
                    })}
                  </span>
                  <span className="detail-value">
                    {currentAssignedAgent?.name ??
                      t('sessions.assignment.unassigned', {
                        defaultValue: 'Unassigned',
                      })}
                  </span>
                </div>
              </div>

              {(adminTeamLeadersQuery.isError ||
                adminAgentsQuery.isError) && (
                <div
                  role="alert"
                  style={{
                    color: 'var(--error)',
                  }}
                >
                  {t('sessions.assignment.loadError', {
                    defaultValue:
                      'Team Leaders or Agents could not be loaded. Refresh and try again.',
                  })}
                </div>
              )}

              <label htmlFor="session-assignment-mode">
                {t('sessions.assignment.assignTo', {
                  defaultValue: 'Assign to',
                })}
              </label>
              <select
                id="session-assignment-mode"
                value={assignmentMode}
                disabled={assignmentBusy}
                onChange={event =>
                  setAssignmentMode(
                    event.target.value as AdminAssignmentMode,
                  )
                }
              >
                <option value="team_leader">
                  {t('sessions.assignment.teamLeader', {
                    defaultValue: 'Team Leader',
                  })}
                </option>
                <option value="agent">
                  {t('sessions.assignment.agent', {
                    defaultValue: 'Agent',
                  })}
                </option>
              </select>

              {assignmentMode === 'team_leader' ? (
                <>
                  <label htmlFor="session-assignment-team-leader">
                    {t('sessions.assignment.teamLeader', {
                      defaultValue: 'Team Leader',
                    })}
                  </label>
                  <select
                    id="session-assignment-team-leader"
                    value={assignmentTeamLeaderId}
                    disabled={
                      assignmentBusy ||
                      adminTeamLeadersQuery.isLoading
                    }
                    onChange={event =>
                      setAssignmentTeamLeaderId(
                        event.target.value,
                      )
                    }
                  >
                    <option value="">
                      {adminTeamLeadersQuery.isLoading
                        ? t('common.loading', {
                            defaultValue: 'Loading...',
                          })
                        : t('sessions.assignment.selectTeamLeader', {
                            defaultValue: 'Select a Team Leader',
                          })}
                    </option>
                    {adminTeamLeaders.map(teamLeader => (
                      <option
                        key={teamLeader.id}
                        value={teamLeader.id}
                      >
                        {teamLeader.name}
                      </option>
                    ))}
                  </select>

                  {currentAssignedAgent && (
                    <p className="input-hint">
                      {t('sessions.assignment.ownerConflictHint', {
                        defaultValue:
                          'This Session is currently assigned to an Agent. Direct Team Leader transfer must remain compatible with that Agent, or clear/reassign the Agent first.',
                      })}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <label htmlFor="session-assignment-agent">
                    {t('sessions.assignment.agent', {
                      defaultValue: 'Agent',
                    })}
                  </label>
                  <select
                    id="session-assignment-agent"
                    value={assignmentAgentId}
                    disabled={
                      assignmentBusy ||
                      adminAgentsQuery.isLoading
                    }
                    onChange={event =>
                      setAssignmentAgentId(
                        event.target.value,
                      )
                    }
                  >
                    <option value="">
                      {adminAgentsQuery.isLoading
                        ? t('common.loading', {
                            defaultValue: 'Loading...',
                          })
                        : t('sessions.assignment.selectAgent', {
                            defaultValue: 'Select an Agent',
                          })}
                    </option>
                    {adminAgents.map(agent => (
                      <option
                        key={agent.id}
                        value={agent.id}
                      >
                        {agent.name} · {agent.teamLeader.name}
                        {agent.assignedSessionId &&
                        agent.assignedSessionId !== assignmentSession.id
                          ? ' · currently assigned'
                          : ''}
                      </option>
                    ))}
                  </select>

                  <p className="input-hint">
                    {t('sessions.assignment.agentOwnershipHint', {
                      defaultValue:
                        "Assigning to an Agent automatically sets Session ownership to that Agent's Team Leader. If another Agent currently has this Session, that old assignment is cleared automatically.",
                    })}
                  </p>

                  {currentAssignedAgent && (
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() =>
                        void unassignCurrentAgent()
                      }
                      disabled={assignmentBusy}
                    >
                      {t('sessions.assignment.unassignAgent', {
                        defaultValue: 'Unassign current Agent',
                      })}
                    </button>
                  )}
                </>
              )}
            </div>
          </Modal>
        )}

      {selectedSession && (
        <Modal
          open
          onClose={() =>
            setSelectedSession(null)
          }
          title={t(
            'sessions.details.title',
          )}
          closeLabel={t('common.close')}
          footer={
            <button
              className="btn-secondary"
              onClick={() =>
                setSelectedSession(null)
              }
            >
              {t('common.close')}
            </button>
          }
        >
          <div className="detail-grid">
            <div className="detail-item">
              <span className="detail-label">
                {t('sessions.details.name')}
              </span>
              <span className="detail-value">
                {selectedSession.name}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">
                {t('sessions.details.status')}
              </span>
              <span
                className={`status-badge ${selectedSession.status}`}
              >
                {formatStatus(
                  selectedSession.status,
                )}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">
                {t(
                  'sessions.details.sessionId',
                )}
              </span>
              <span className="detail-value mono">
                {selectedSession.id}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">
                {t('sessions.details.phone')}
              </span>
              <span className="detail-value">
                {selectedSession.phone ||
                  t(
                    'sessions.details.phoneNone',
                  )}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">
                {t(
                  'sessions.details.created',
                )}
              </span>
              <span className="detail-value">
                {new Date(
                  selectedSession.createdAt,
                ).toLocaleString()}
              </span>
            </div>
            <div className="detail-item">
              <span className="detail-label">
                {t(
                  'sessions.details.lastActive',
                )}
              </span>
              <span className="detail-value">
                {selectedSession.lastActive
                  ? new Date(
                      selectedSession.lastActive,
                    ).toLocaleString()
                  : t('common.never')}
              </span>
            </div>

            {sessionConfig && (
              <div className="detail-item detail-item-toggle">
                <div className="detail-toggle-row">
                  <span
                    className="detail-label"
                    id="auto-reject-calls-label"
                  >
                    {t(
                      'sessions.details.autoRejectCalls',
                    )}
                  </span>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      aria-labelledby="auto-reject-calls-label"
                      checked={
                        sessionConfig.autoRejectCalls
                      }
                      disabled={
                        !canManageSessions ||
                        savingConfig
                      }
                      onChange={event =>
                        void handleAutoRejectToggle(
                          event.target.checked,
                        )
                      }
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
                <small className="detail-hint">
                  {t(
                    'sessions.details.autoRejectCallsHint',
                  )}
                </small>
              </div>
            )}
          </div>
        </Modal>
      )}

      {deleteConfirmId &&
        canManageSessions && (
          <Modal
            open
            onClose={() =>
              setDeleteConfirmId(null)
            }
            title={t(
              'sessions.delete.title',
            )}
            className="confirm-modal"
            closeLabel={t('common.close')}
            footer={
              <>
                <button
                  className="btn-secondary"
                  onClick={() =>
                    setDeleteConfirmId(null)
                  }
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="btn-danger"
                  onClick={() =>
                    void handleDelete(
                      deleteConfirmId,
                    )
                  }
                >
                  {t('common.delete')}
                </button>
              </>
            }
          >
            <p>
              <Trans
                i18nKey="sessions.delete.message"
                values={{
                  name: sessions.find(
                    session =>
                      session.id ===
                      deleteConfirmId,
                  )?.name,
                }}
                components={{
                  strong: <strong />,
                }}
              />
            </p>
            <p className="text-muted">
              {t(
                'sessions.delete.warning',
              )}
            </p>
          </Modal>
        )}

      {killConfirmId &&
        canShutdownSessions && (
          <Modal
            open
            onClose={() =>
              setKillConfirmId(null)
            }
            title={t(
              'sessions.forceKill.title',
            )}
            className="confirm-modal"
            closeLabel={t('common.close')}
            footer={
              <>
                <button
                  className="btn-secondary"
                  onClick={() =>
                    setKillConfirmId(null)
                  }
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="btn-danger"
                  onClick={() =>
                    void handleForceKill(
                      killConfirmId,
                    )
                  }
                >
                  {t(
                    'sessions.forceKill.confirm',
                  )}
                </button>
              </>
            }
          >
            <p>
              <Trans
                i18nKey="sessions.forceKill.message"
                values={{
                  name: sessions.find(
                    session =>
                      session.id ===
                      killConfirmId,
                  )?.name,
                }}
                components={{
                  strong: <strong />,
                }}
              />
            </p>
            <p className="text-muted">
              {t(
                'sessions.forceKill.warning',
              )}
            </p>
          </Modal>
        )}

      {unlinkConfirmId &&
        canShutdownSessions && (
          <Modal
            open
            onClose={() =>
              setUnlinkConfirmId(null)
            }
            title={t(
              'sessions.unlink.title',
            )}
            className="confirm-modal"
            closeLabel={t('common.close')}
            footer={
              <>
                <button
                  className="btn-secondary"
                  onClick={() =>
                    setUnlinkConfirmId(null)
                  }
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="btn-danger"
                  onClick={() =>
                    void handleUnlink(
                      unlinkConfirmId,
                    )
                  }
                  disabled={
                    unlinkingId !== null
                  }
                >
                  {t(
                    'sessions.unlink.confirm',
                  )}
                </button>
              </>
            }
          >
            <p>
              <Trans
                i18nKey="sessions.unlink.message"
                values={{
                  name: sessions.find(
                    session =>
                      session.id ===
                      unlinkConfirmId,
                  )?.name,
                }}
                components={{
                  strong: <strong />,
                }}
              />
            </p>
            <p className="text-muted">
              {t(
                'sessions.unlink.warning',
              )}
            </p>
          </Modal>
        )}

      <div className="sessions-grid">
        {filteredSessions.length === 0 ? (
          <div className="empty-state">
            <QrCode size={48} />
            <h3>
              {t('sessions.empty.title')}
            </h3>
            <p>
              {t(
                'sessions.empty.description',
              )}
            </p>
          </div>
        ) : (
          filteredSessions.map(session => (
            <div
              key={session.id}
              className="session-card"
            >
              <div className="card-header">
                <h3 title={session.name}>
                  {session.name}
                </h3>
                <div className="session-card-badges">
                  <span
                    className={`status-pill ${session.status}`}
                  >
                    {formatStatus(
                      session.status,
                    )}
                  </span>

                  {assignmentDataAvailable ? (
                    <span
                      className={`session-assignment-badge ${
                        assignedSessionIds.has(
                          session.id,
                        )
                          ? 'assigned'
                          : 'unassigned'
                      }`}
                      title={
                        assignedSessionIds.has(
                          session.id,
                        )
                          ? t(
                              'sessions.assignment.assignedTitle',
                              {
                                defaultValue:
                                  'Assigned to an Agent',
                              },
                            )
                          : t(
                              'sessions.assignment.unassignedTitle',
                              {
                                defaultValue:
                                  'Not assigned to any Agent',
                              },
                            )
                      }
                    >
                      {assignedSessionIds.has(
                        session.id,
                      ) ? (
                        <>
                          <UserCheck size={13} />
                          {t(
                            'sessions.assignment.assigned',
                            {
                              defaultValue:
                                'Assigned',
                            },
                          )}
                        </>
                      ) : (
                        <>
                          <UserMinus size={13} />
                          {t(
                            'sessions.assignment.unassigned',
                            {
                              defaultValue:
                                'Unassigned',
                            },
                          )}
                        </>
                      )}
                    </span>
                  ) : null}
                </div>
              </div>

              {session.status ===
                'initializing' ||
              session.status === 'qr_ready' ? (
                <div className="qr-placeholder">
                  <QrCode
                    size={80}
                    className="qr-icon"
                  />
                  <p>
                    {session.status ===
                    'qr_ready'
                      ? t(
                          'sessions.qr.scanToConnect',
                        )
                      : t(
                          'sessions.qr.preparing',
                        )}
                  </p>
                  {canManageSessions && (
                    <button
                      className="btn-sm"
                      onClick={() =>
                        handleShowQR(
                          session.id,
                        )
                      }
                      disabled={
                        session.status !==
                        'qr_ready'
                      }
                    >
                      {session.status ===
                      'qr_ready'
                        ? t(
                            'sessions.qr.showQr',
                          )
                        : t(
                            'sessions.qr.loading',
                          )}
                    </button>
                  )}
                </div>
              ) : (
                <div className="session-info">
                  <div className="info-row">
                    <span className="info-label">
                      {t(
                        'sessions.card.phone',
                      )}
                    </span>
                    <span className="info-value">
                      {session.phone || '—'}
                    </span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">
                      {t(
                        'sessions.card.sessionId',
                      )}
                    </span>
                    <span className="info-value mono">
                      {session.id.substring(
                        0,
                        12,
                      )}
                    </span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">
                      {t(
                        'sessions.card.lastActive',
                      )}
                    </span>
                    <span className="info-value">
                      {formatLastActive(
                        session.lastActive,
                      )}
                    </span>
                  </div>

                  {(session.status === 'failed' ||
                    session.status ===
                      'action_required') &&
                  session.lastError ? (
                    <div className="info-row session-error">
                      <span className="info-label">
                        {t(
                          'sessions.card.error',
                        )}
                      </span>
                      <span
                        className="info-value error-text"
                        title={
                          session.lastError
                        }
                      >
                        {session.lastError}
                      </span>
                    </div>
                  ) : null}

                  {session.restriction ? (
                    <div className="info-row session-restriction">
                      <span className="info-label">
                        {t(
                          'sessions.card.restriction',
                        )}
                      </span>
                      <span
                        className="info-value restriction-text"
                        title={restrictionTitle(
                          session.restriction,
                          t,
                        )}
                      >
                        {t(
                          `sessions.restriction.${session.restriction.kind}`,
                        )}
                      </span>
                    </div>
                  ) : null}
                </div>
              )}

              <div className="card-actions">
                <button
                  className="btn-action"
                  onClick={() =>
                    setSelectedSession(
                      session,
                    )
                  }
                >
                  <Eye size={16} />
                  {t('sessions.actions.view')}
                </button>

                {canManagePrincipals && (
                  <button
                    className="btn-action"
                    onClick={() =>
                      openAssignmentModal(session)
                    }
                  >
                    <Users size={16} />
                    {t('sessions.actions.assignment', {
                      defaultValue:
                        session.ownerTeamLeaderId
                          ? 'Assignment'
                          : 'Assign',
                    })}
                  </button>
                )}

                {isSessionStarted(session) ? (
                  canShutdownSessions ? (
                    <button
                      className="btn-action"
                      onClick={() =>
                        void handleStop(
                          session.id,
                        )
                      }
                    >
                      <Square size={16} />
                      {t(
                        'sessions.actions.stop',
                      )}
                    </button>
                  ) : null
                ) : canStartSessions &&
                  (session.status === 'created' ||
                    session.status ===
                      'disconnected') ? (
                  <button
                    className="btn-action"
                    onClick={() =>
                      void handleStart(
                        session.id,
                      )
                    }
                  >
                    <Play size={16} />
                    {t(
                      'sessions.actions.start',
                    )}
                  </button>
                ) : canStartSessions ? (
                  <button
                    className="btn-action"
                    onClick={() =>
                      void handleStart(
                        session.id,
                      )
                    }
                  >
                    <RefreshCw size={16} />
                    {t(
                      'sessions.actions.reconnect',
                    )}
                  </button>
                ) : null}

                {canUnlinkSession(
                  session,
                  canShutdownSessions,
                ) && (
                  <button
                    className="btn-action danger"
                    onClick={() =>
                      setUnlinkConfirmId(
                        session.id,
                      )
                    }
                  >
                    <Unlink size={16} />
                    {t(
                      'sessions.actions.unlink',
                    )}
                  </button>
                )}

                {canManageSessions && (
                  <button
                    className="btn-action danger"
                    onClick={() =>
                      setDeleteConfirmId(
                        session.id,
                      )
                    }
                  >
                    <Trash2 size={16} />
                    {t(
                      'sessions.actions.delete',
                    )}
                  </button>
                )}

                {canForceKillSession(
                  session,
                  canShutdownSessions,
                ) && (
                  <button
                    className="btn-action danger"
                    onClick={() =>
                      setKillConfirmId(
                        session.id,
                      )
                    }
                  >
                    <Skull size={16} />
                    {t(
                      'sessions.actions.killStuck',
                    )}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
