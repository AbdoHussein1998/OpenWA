



import {
  useMemo,
  useState,
} from 'react';

import {
  useNavigate,
} from 'react-router-dom';

import {
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Smartphone,
  Trash2,
  Unlink,
  UserRound,
  Users,
} from 'lucide-react';

import {
  PageHeader,
} from '../components/PageHeader';

import {
  Modal,
} from '../components/Modal';

import {
  GeneratedKeyField,
} from '../components/GeneratedKeyField';

import {
  copyToClipboard,
} from '../utils/clipboard';

import {
  useToast,
} from '../hooks/useToast';

import {
  useDocumentTitle,
} from '../hooks/useDocumentTitle';

import {
  useAssignTeamLeaderAgentSessionMutation,
  useCreateTeamLeaderAgentMutation,
  useDeleteTeamLeaderAgentMutation,
  useReissueTeamLeaderAgentApiKeyMutation,
  useSessionsQuery,
  useTeamLeaderAgentsQuery,
  useTeamLeaderMeQuery,
} from '../hooks/queries';

import type {
  Agent,
  CreateAgentInput,
  Session,
} from '../services/api';

import './TeamLeader.css';

type TemplateQuotaMode =
  | 'unlimited'
  | 'disabled'
  | 'custom';

interface AgentFormState {
  agentName: string;
  agentEmail: string;
  templateQuotaMode: TemplateQuotaMode;
  templateQuotaLimit: string;
}

interface AgentCredentialResult {
  agent: Agent;
  apiKey: string;
  reason: 'created' | 'reissued';
}

const EMPTY_FORM: AgentFormState = {
  agentName: '',
  agentEmail: '',
  templateQuotaMode: 'unlimited',
  templateQuotaLimit: '',
};

function errorMessage(
  error: unknown,
): string {
  return error instanceof Error
    ? error.message
    : 'Unexpected error';
}

function formatDate(
  value: string,
): string {
  const parsed =
    new Date(
      value,
    );

  if (
    Number.isNaN(
      parsed.getTime(),
    )
  ) {
    return value;
  }

  return parsed.toLocaleString();
}

function sessionStatusLabel(
  status: Session['status'],
): string {
  return status
    .replaceAll(
      '_',
      ' ',
    )
    .replace(
      /\b\w/g,
      char =>
        char.toUpperCase(),
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

function templateQuotaFromForm(
  form: AgentFormState,
): number | null {
  if (
    form.templateQuotaMode ===
    'unlimited'
  ) {
    return null;
  }

  if (
    form.templateQuotaMode ===
    'disabled'
  ) {
    return 0;
  }

  return Number.parseInt(
    form.templateQuotaLimit,
    10,
  );
}

export function TeamLeader() {
  useDocumentTitle(
    'Team Leader',
  );

  const navigate =
    useNavigate();

  const toast =
    useToast();

  const meQuery =
    useTeamLeaderMeQuery();

  const agentsQuery =
    useTeamLeaderAgentsQuery();

  const sessionsQuery =
    useSessionsQuery();

  const createAgentMutation =
    useCreateTeamLeaderAgentMutation();

  const assignMutation =
    useAssignTeamLeaderAgentSessionMutation();

  const deleteAgentMutation =
    useDeleteTeamLeaderAgentMutation();

  const reissueAgentKeyMutation =
    useReissueTeamLeaderAgentApiKeyMutation();

  const [
    showCreateModal,
    setShowCreateModal,
  ] =
    useState(false);

  const [
    form,
    setForm,
  ] =
    useState<AgentFormState>(
      EMPTY_FORM,
    );

  const [
    formError,
    setFormError,
  ] =
    useState<string | null>(
      null,
    );

  const [
    agentCredentialResult,
    setAgentCredentialResult,
  ] =
    useState<AgentCredentialResult | null>(
      null,
    );

  /**
   * Plaintext Agent keys are intentionally kept only in memory.
   *
   * The backend stores only a hash/prefix and cannot reconstruct an
   * existing plaintext key. This map therefore contains only keys that
   * were created or reissued while this Team Leader page is mounted.
   */
  const [
    knownAgentKeys,
    setKnownAgentKeys,
  ] =
    useState<Record<string, string>>(
      {},
    );

  const [
    copiedAgentId,
    setCopiedAgentId,
  ] =
    useState<string | null>(
      null,
    );

  const [
    assignmentAgent,
    setAssignmentAgent,
  ] =
    useState<Agent | null>(
      null,
    );

  const [
    selectedSessionId,
    setSelectedSessionId,
  ] =
    useState('');

  const [
    deleteAgentTarget,
    setDeleteAgentTarget,
  ] =
    useState<Agent | null>(
      null,
    );

  const agents =
    agentsQuery.data ??
    [];

  const sessions =
    sessionsQuery.data ??
    [];

  const sessionsById =
    useMemo(
      () =>
        new Map(
          sessions.map(
            session => [
              session.id,
              session,
            ],
          ),
        ),
      [
        sessions,
      ],
    );

  const assignedAgentBySessionId =
    useMemo(() => {
      const map =
        new Map<
          string,
          Agent
        >();

      for (
        const agent of
        agents
      ) {
        if (
          agent.assignedSessionId
        ) {
          map.set(
            agent.assignedSessionId,
            agent,
          );
        }
      }

      return map;
    }, [
      agents,
    ]);

  const assignedCount =
    agents.filter(
      agent =>
        Boolean(
          agent.assignedSessionId,
        ),
    ).length;

  const unassignedCount =
    agents.length -
    assignedCount;

  const isInitialLoading =
    meQuery.isLoading ||
    agentsQuery.isLoading ||
    sessionsQuery.isLoading;

  const isRefreshing =
    meQuery.isFetching ||
    agentsQuery.isFetching ||
    sessionsQuery.isFetching;

  const combinedLoadError =
    [
      meQuery.error,
      agentsQuery.error,
      sessionsQuery.error,
    ].find(
      Boolean,
    );

  const openCreateModal =
    () => {
      setForm(
        EMPTY_FORM,
      );

      setFormError(
        null,
      );

      setShowCreateModal(
        true,
      );
    };

  const closeCreateModal =
    () => {
      if (
        createAgentMutation.isPending
      ) {
        return;
      }

      setShowCreateModal(
        false,
      );

      setFormError(
        null,
      );
    };

  const updateForm =
    <
      K extends keyof AgentFormState,
    >(
      field: K,
      value:
        AgentFormState[K],
    ) => {
      setForm(
        current => ({
          ...current,
          [field]:
            value,
        }),
      );

      if (
        formError
      ) {
        setFormError(
          null,
        );
      }
    };

  const validateAgentForm =
    (): string | null => {
      const agentName =
        form.agentName.trim();

      const agentEmail =
        form.agentEmail.trim();

      if (!agentName) {
        return 'Agent name is required.';
      }

      if (
        agentName.length >
        100
      ) {
        return 'Agent name must be 100 characters or fewer.';
      }

      if (
        agentEmail &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
          agentEmail,
        )
      ) {
        return 'Agent email must be a valid email address.';
      }

      if (
        form.templateQuotaMode ===
        'custom'
      ) {
        const rawLimit =
          form.templateQuotaLimit.trim();

        if (
          !/^\d+$/.test(
            rawLimit,
          )
        ) {
          return 'Custom template quota must be a whole number.';
        }

        const limit =
          Number.parseInt(
            rawLimit,
            10,
          );

        if (
          !Number.isSafeInteger(
            limit,
          ) ||
          limit < 1
        ) {
          return 'Custom template quota must be a positive whole number.';
        }
      }

      return null;
    };

  const handleCreateAgent =
    async () => {
      const validationError =
        validateAgentForm();

      if (
        validationError
      ) {
        setFormError(
          validationError,
        );

        return;
      }

      const agentInput:
        CreateAgentInput = {
          name:
            form.agentName.trim(),
          ...(form.agentEmail.trim()
            ? {
                email:
                  form.agentEmail.trim(),
              }
            : {}),
          templateSendLimit24h:
            templateQuotaFromForm(
              form,
            ),
        };

      setFormError(
        null,
      );

      try {
        const result =
          await createAgentMutation.mutateAsync(
            agentInput,
          );

        setShowCreateModal(
          false,
        );

        setKnownAgentKeys(
          current => ({
            ...current,
            [result.agent.id]:
              result.apiKey,
          }),
        );

        setAgentCredentialResult(
          {
            agent:
              result.agent,
            apiKey:
              result.apiKey,
            reason:
              'created',
          },
        );

        toast.success(
          'Agent created',
          `${result.agent.name} was created. Assign a session when ready.`,
        );
      } catch (
        error
      ) {
        setFormError(
          errorMessage(
            error,
          ),
        );
      }
    };

  const closeAgentCredential =
    () => {
      setAgentCredentialResult(
        null,
      );
    };

  const copyAgentApiKey =
    async (
      agentId: string,
    ) => {
      const apiKey =
        knownAgentKeys[agentId];

      if (!apiKey) {
        return;
      }

      const copied =
        await copyToClipboard(
          apiKey,
        );

      if (!copied) {
        toast.error(
          'Copy failed',
          'The API key could not be copied to the clipboard.',
        );
        return;
      }

      setCopiedAgentId(
        agentId,
      );

      window.setTimeout(
        () => {
          setCopiedAgentId(
            current =>
              current ===
              agentId
                ? null
                : current,
          );
        },
        1600,
      );
    };

  const reissueAgentApiKey =
    async (
      agent: Agent,
    ) => {
      if (
        reissueAgentKeyMutation.isPending
      ) {
        return;
      }

      try {
        const result =
          await reissueAgentKeyMutation.mutateAsync(
            agent.id,
          );

        setKnownAgentKeys(
          current => ({
            ...current,
            [agent.id]:
              result.apiKey,
          }),
        );

        setAgentCredentialResult(
          {
            agent:
              result.agent,
            apiKey:
              result.apiKey,
            reason:
              'reissued',
          },
        );

        toast.success(
          'Agent API key reissued',
          `${agent.name} now has a new API key. The previous key is no longer valid.`,
        );
      } catch (
        error
      ) {
        toast.error(
          'API key reissue failed',
          errorMessage(
            error,
          ),
        );
      }
    };

  const openAssignmentModal =
    (
      agent: Agent,
    ) => {
      setAssignmentAgent(
        agent,
      );

      setSelectedSessionId(
        agent.assignedSessionId ??
          '',
      );
    };

  const closeAssignmentModal =
    () => {
      if (
        assignMutation.isPending
      ) {
        return;
      }

      setAssignmentAgent(
        null,
      );

      setSelectedSessionId(
        '',
      );
    };

  const saveAssignment =
    async () => {
      const agent =
        assignmentAgent;

      if (!agent) {
        return;
      }

      if (
        !selectedSessionId
      ) {
        toast.warning(
          'Choose a session',
          'Select a session or use Unassign.',
        );

        return;
      }

      try {
        const updated =
          await assignMutation.mutateAsync(
            {
              agentId:
                agent.id,
              sessionId:
                selectedSessionId,
            },
          );

        toast.success(
          'Assignment updated',
          `${updated.name} is now assigned to ${sessionsById.get(selectedSessionId)?.name ?? 'the selected session'}.`,
        );

        closeAssignmentModal();
      } catch (
        error
      ) {
        toast.error(
          'Assignment failed',
          errorMessage(
            error,
          ),
        );
      }
    };

  const unassignAgent =
    async (
      agent: Agent,
    ) => {
      try {
        await assignMutation.mutateAsync(
          {
            agentId:
              agent.id,
            sessionId:
              null,
          },
        );

        toast.success(
          'Agent unassigned',
          `${agent.name} no longer has an assigned session.`,
        );

        if (
          assignmentAgent?.id ===
          agent.id
        ) {
          closeAssignmentModal();
        }
      } catch (
        error
      ) {
        toast.error(
          'Unassign failed',
          errorMessage(
            error,
          ),
        );
      }
    };

  const confirmDeleteAgent =
    async () => {
      const agent =
        deleteAgentTarget;

      if (!agent) {
        return;
      }

      try {
        await deleteAgentMutation.mutateAsync(
          agent.id,
        );

        toast.success(
          'Agent deleted',
          `${agent.name} was deleted. Its session, if any, was kept.`,
        );

        setKnownAgentKeys(
          current => {
            const next = {
              ...current,
            };

            delete next[agent.id];

            return next;
          },
        );

        setDeleteAgentTarget(
          null,
        );
      } catch (
        error
      ) {
        toast.error(
          'Delete failed',
          errorMessage(
            error,
          ),
        );
      }
    };

  const refreshAll =
    () => {
      void Promise.all([
        meQuery.refetch(),
        agentsQuery.refetch(),
        sessionsQuery.refetch(),
      ]);
    };

  const openChats =
    (
      sessionId: string,
    ) => {
      navigate(
        `/chats?session=${encodeURIComponent(
          sessionId,
        )}`,
      );
    };

  if (
    isInitialLoading
  ) {
    return (
      <div className="team-leader-page">
        <div className="team-leader-loading">
          <Loader2
            className="animate-spin"
            size={32}
          />

          <span>
            Loading Team Leader workspace...
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="team-leader-page">
      <PageHeader
        title="Team Leader"
        subtitle={
          meQuery.data
            ? `Manage Agents and session assignments for ${meQuery.data.name}. Session operations are handled from the Sessions tab.`
            : 'Manage your Agents and their WhatsApp session assignments.'
        }
        badge={
          meQuery.data ? (
            <span className="team-leader-identity-badge">
              <UserRound
                size={14}
              />

              {meQuery.data.email ||
                meQuery.data.name}
            </span>
          ) : undefined
        }
        actions={
          <div className="team-leader-header-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={
                refreshAll
              }
              disabled={
                isRefreshing
              }
            >
              <RefreshCw
                size={17}
                className={
                  isRefreshing
                    ? 'animate-spin'
                    : undefined
                }
              />

              Refresh
            </button>

            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                navigate(
                  '/sessions',
                )
              }
            >
              <Smartphone
                size={17}
              />

              Sessions
            </button>

            <button
              type="button"
              className="btn-primary"
              onClick={
                openCreateModal
              }
            >
              <Plus
                size={18}
              />

              Create Agent
            </button>
          </div>
        }
      />

      {combinedLoadError && (
        <div
          className="team-leader-alert team-leader-alert--error"
          role="alert"
        >
          <strong>
            Some workspace data could not be loaded.
          </strong>

          <span>
            {errorMessage(
              combinedLoadError,
            )}
          </span>
        </div>
      )}

      <section
        className="team-leader-summary-grid"
        aria-label="Team Leader summary"
      >
        <article className="team-leader-summary-card">
          <span className="team-leader-summary-label">
            Agents
          </span>

          <strong className="team-leader-summary-value">
            {
              agents.length
            }
          </strong>

          <span className="team-leader-summary-hint">
            Principals owned by this Team Leader
          </span>
        </article>

        <article className="team-leader-summary-card">
          <span className="team-leader-summary-label">
            Assigned
          </span>

          <strong className="team-leader-summary-value">
            {
              assignedCount
            }
          </strong>

          <span className="team-leader-summary-hint">
            Agents with a session assignment
          </span>
        </article>

        <article className="team-leader-summary-card">
          <span className="team-leader-summary-label">
            Unassigned
          </span>

          <strong className="team-leader-summary-value">
            {
              unassignedCount
            }
          </strong>

          <span className="team-leader-summary-hint">
            Agents waiting for a session assignment
          </span>
        </article>

        <article className="team-leader-summary-card">
          <span className="team-leader-summary-label">
            Sessions
          </span>

          <strong className="team-leader-summary-value">
            {
              sessions.length
            }
          </strong>

          <span className="team-leader-summary-hint">
            Sessions available for assignment
          </span>
        </article>
      </section>

      <section className="team-leader-section">
        <div className="team-leader-section-header">
          <div>
            <h2>
              Agents
            </h2>

            <p>
              Create Agents independently, then assign, reassign, or unassign an existing tenant-owned session.
            </p>
          </div>
        </div>

        {agents.length ===
        0 ? (
          <div className="team-leader-empty-state">
            <div className="team-leader-empty-icon">
              <Users
                size={28}
              />
            </div>

            <h3>
              No Agents yet
            </h3>

            <p>
              Create your first Agent. Session creation and operational controls remain in the Sessions tab.
            </p>

            <button
              type="button"
              className="btn-primary"
              onClick={
                openCreateModal
              }
            >
              <Plus
                size={18}
              />

              Create Agent
            </button>
          </div>
        ) : (
          <div className="team-leader-table-wrap">
            <table className="team-leader-table">
              <thead>
                <tr>
                  <th>
                    Agent
                  </th>

                  <th>
                    API key
                  </th>

                  <th>
                    Template quota
                  </th>

                  <th>
                    Session
                  </th>

                  <th>
                    Configured phone
                  </th>

                  <th>
                    Connected phone
                  </th>

                  <th>
                    Status
                  </th>

                  <th>
                    Created
                  </th>

                  <th className="team-leader-actions-column">
                    Actions
                  </th>
                </tr>
              </thead>

              <tbody>
                {agents.map(
                  agent => {
                    const session =
                      agent.assignedSessionId
                        ? sessionsById.get(
                            agent.assignedSessionId,
                          )
                        : undefined;

                    const knownApiKey =
                      knownAgentKeys[
                        agent.id
                      ];

                    const reissuingThisAgent =
                      reissueAgentKeyMutation.isPending &&
                      reissueAgentKeyMutation.variables ===
                        agent.id;

                    return (
                      <tr
                        key={
                          agent.id
                        }
                      >
                        <td>
                          <div className="team-leader-agent-cell">
                            <strong>
                              {
                                agent.name
                              }
                            </strong>

                            <span>
                              {agent.email ??
                                'No email'}
                            </span>
                          </div>
                        </td>

                        <td>
                          {knownApiKey ? (
                            <div
                              style={{
                                display:
                                  'flex',
                                alignItems:
                                  'center',
                                gap:
                                  '0.4rem',
                                minWidth:
                                  0,
                              }}
                            >
                              <code
                                title={
                                  knownApiKey
                                }
                                style={{
                                  display:
                                    'inline-block',
                                  maxWidth:
                                    '210px',
                                  overflow:
                                    'hidden',
                                  textOverflow:
                                    'ellipsis',
                                  whiteSpace:
                                    'nowrap',
                                }}
                              >
                                {
                                  knownApiKey
                                }
                              </code>

                              <button
                                type="button"
                                className="team-leader-action-btn"
                                onClick={() =>
                                  void copyAgentApiKey(
                                    agent.id,
                                  )
                                }
                                title="Copy Agent API key"
                                aria-label={`Copy API key for ${agent.name}`}
                                style={{
                                  padding:
                                    '0.35rem',
                                }}
                              >
                                {copiedAgentId ===
                                agent.id ? (
                                  <Check
                                    size={15}
                                  />
                                ) : (
                                  <Copy
                                    size={15}
                                  />
                                )}
                              </button>
                            </div>
                          ) : (
                            <div
                              style={{
                                display:
                                  'flex',
                                alignItems:
                                  'center',
                                gap:
                                  '0.5rem',
                                flexWrap:
                                  'wrap',
                              }}
                            >
                              <span className="team-leader-muted">
                                Not recoverable
                              </span>

                              <button
                                type="button"
                                className="team-leader-action-btn"
                                onClick={() =>
                                  void reissueAgentApiKey(
                                    agent,
                                  )
                                }
                                disabled={
                                  reissueAgentKeyMutation.isPending
                                }
                                title="Reissue Agent API key"
                              >
                                {reissuingThisAgent ? (
                                  <Loader2
                                    size={15}
                                    className="animate-spin"
                                  />
                                ) : (
                                  <KeyRound
                                    size={15}
                                  />
                                )}

                                Reissue
                              </button>
                            </div>
                          )}
                        </td>

                        <td>
                          <span className="team-leader-status-pill">
                            {templateQuotaLabel(
                              agent.templateSendLimit24h,
                            )}
                          </span>
                        </td>

                        <td>
                          {session ? (
                            <div className="team-leader-session-cell">
                              <strong>
                                {
                                  session.name
                                }
                              </strong>

                              <code>
                                {
                                  session.id
                                }
                              </code>
                            </div>
                          ) : agent.assignedSessionId ? (
                            <div className="team-leader-session-cell">
                              <strong>
                                Assigned
                              </strong>

                              <code>
                                {
                                  agent.assignedSessionId
                                }
                              </code>

                              <span className="team-leader-muted">
                                Session is not present in the current authorized session list.
                              </span>
                            </div>
                          ) : (
                            <span className="team-leader-status-pill team-leader-status-pill--unassigned">
                              Unassigned
                            </span>
                          )}
                        </td>

                        <td className="team-leader-phone">
                          {session?.targetPhone ??
                            '—'}
                        </td>

                        <td className="team-leader-phone">
                          {session?.phone ??
                            '—'}
                        </td>

                        <td>
                          {session ? (
                            <span
                              className={`team-leader-status-pill team-leader-status-pill--${session.status}`}
                            >
                              {sessionStatusLabel(
                                session.status,
                              )}
                            </span>
                          ) : (
                            <span className="team-leader-muted">
                              —
                            </span>
                          )}
                        </td>

                        <td>
                          <span
                            title={
                              formatDate(
                                agent.createdAt,
                              )
                            }
                          >
                            {new Date(
                              agent.createdAt,
                            ).toLocaleDateString()}
                          </span>
                        </td>

                        <td>
                          <div className="team-leader-row-actions">
                            {agent.assignedSessionId && (
                              <>
                                <button
                                  type="button"
                                  className="team-leader-action-btn"
                                  onClick={() =>
                                    navigate(
                                      '/sessions',
                                    )
                                  }
                                  title="Manage session"
                                >
                                  <Smartphone
                                    size={16}
                                  />

                                  Session
                                </button>

                                <button
                                  type="button"
                                  className="team-leader-action-btn"
                                  onClick={() =>
                                    openChats(
                                      agent.assignedSessionId!,
                                    )
                                  }
                                  title="Open chats"
                                >
                                  <ExternalLink
                                    size={16}
                                  />

                                  Chats
                                </button>
                              </>
                            )}

                            <button
                              type="button"
                              className="team-leader-action-btn"
                              onClick={() =>
                                openAssignmentModal(
                                  agent,
                                )
                              }
                            >
                              <RefreshCw
                                size={16}
                              />

                              {agent.assignedSessionId
                                ? 'Reassign'
                                : 'Assign'}
                            </button>

                            {agent.assignedSessionId && (
                              <button
                                type="button"
                                className="team-leader-action-btn"
                                onClick={() =>
                                  void unassignAgent(
                                    agent,
                                  )
                                }
                                disabled={
                                  assignMutation.isPending
                                }
                              >
                                <Unlink
                                  size={16}
                                />

                                Unassign
                              </button>
                            )}

                            <button
                              type="button"
                              className="team-leader-action-btn team-leader-action-btn--danger"
                              onClick={() =>
                                setDeleteAgentTarget(
                                  agent,
                                )
                              }
                            >
                              <Trash2
                                size={16}
                              />

                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  },
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Modal
        open={
          showCreateModal
        }
        onClose={
          closeCreateModal
        }
        title="Create Agent"
        className="team-leader-modal"
        hideCloseButton={
          createAgentMutation.isPending
        }
        footer={
          <>
            <button
              type="button"
              className="btn-secondary"
              onClick={
                closeCreateModal
              }
              disabled={
                createAgentMutation.isPending
              }
            >
              Cancel
            </button>

            <button
              type="button"
              className="btn-primary"
              onClick={() =>
                void handleCreateAgent()
              }
              disabled={
                createAgentMutation.isPending
              }
            >
              {createAgentMutation.isPending ? (
                <Loader2
                  size={17}
                  className="animate-spin"
                />
              ) : (
                <Plus
                  size={17}
                />
              )}

              {createAgentMutation.isPending
                ? 'Creating...'
                : 'Create Agent'}
            </button>
          </>
        }
      >
        <div className="team-leader-form-section">
          <div className="team-leader-form-section-title">
            <span className="team-leader-step">
              1
            </span>

            <div>
              <strong>
                Agent identity
              </strong>

              <span>
                The Team Leader ownership is derived from your authenticated API key. Session assignment is handled separately after creation.
              </span>
            </div>
          </div>

          <div className="team-leader-form-grid">
            <label>
              <span>
                Agent name
              </span>

              <input
                type="text"
                value={
                  form.agentName
                }
                onChange={
                  event =>
                    updateForm(
                      'agentName',
                      event.target.value,
                    )
                }
                maxLength={
                  100
                }
                placeholder="Mohamed Ali"
                autoComplete="off"
              />
            </label>

            <label>
              <span>
                Agent email
              </span>

              <input
                type="email"
                value={
                  form.agentEmail
                }
                onChange={
                  event =>
                    updateForm(
                      'agentEmail',
                      event.target.value,
                    )
                }
                maxLength={
                  255
                }
                placeholder="mohamed.ali@example.com"
                autoComplete="off"
              />

              <small>
                Optional
              </small>
            </label>

            <label>
              <span>
                Stored-template quota
              </span>

              <select
                value={
                  form.templateQuotaMode
                }
                onChange={
                  event =>
                    updateForm(
                      'templateQuotaMode',
                      event.target.value as TemplateQuotaMode,
                    )
                }
              >
                <option value="unlimited">
                  Unlimited
                </option>

                <option value="disabled">
                  Disabled
                </option>

                <option value="custom">
                  Custom rolling 24h limit
                </option>
              </select>

              <small>
                Unlimited = no Agent stored-template limit; Disabled = 0 sends; Custom = N successful stored-template sends per rolling 24 hours.
              </small>
            </label>

            {form.templateQuotaMode ===
              'custom' && (
              <label>
                <span>
                  Custom template limit
                </span>

                <input
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  value={
                    form.templateQuotaLimit
                  }
                  onChange={
                    event =>
                      updateForm(
                        'templateQuotaLimit',
                        event.target.value,
                      )
                  }
                  placeholder="20"
                  autoComplete="off"
                />

                <small>
                  Positive whole number. The backend enforces the rolling 24-hour window.
                </small>
              </label>
            )}
          </div>
        </div>

        {formError && (
          <div
            className="team-leader-inline-error"
            role="alert"
          >
            {
              formError
            }
          </div>
        )}
      </Modal>

      <Modal
        open={
          Boolean(
            agentCredentialResult,
          )
        }
        onClose={
          closeAgentCredential
        }
        title={
          agentCredentialResult?.reason ===
          'reissued'
            ? 'Agent API Key Reissued'
            : 'Agent Created'
        }
        className="team-leader-modal"
        footer={
          agentCredentialResult ? (
            <button
              type="button"
              className="btn-secondary"
              onClick={
                closeAgentCredential
              }
            >
              Close
            </button>
          ) : undefined
        }
      >
        {agentCredentialResult && (
          <div className="team-leader-result">
            <div className="team-leader-result-status team-leader-result-status--success">
              <Check
                size={22}
              />

              <div>
                <strong>
                  {agentCredentialResult.reason ===
                  'reissued'
                    ? 'Agent API key reissued'
                    : 'Agent created'}
                </strong>

                <span>
                  {agentCredentialResult.reason ===
                  'reissued'
                    ? 'The previous Agent API key is no longer valid. Copy the replacement key now.'
                    : 'The Agent has not been assigned a session automatically. Use Assign when you are ready.'}
                </span>
              </div>
            </div>

            <dl className="team-leader-result-details">
              <div>
                <dt>
                  Agent
                </dt>

                <dd>
                  {
                    agentCredentialResult.agent.name
                  }
                </dd>
              </div>

              <div>
                <dt>
                  Template quota
                </dt>

                <dd>
                  {templateQuotaLabel(
                    agentCredentialResult.agent.templateSendLimit24h,
                  )}
                </dd>
              </div>

              <div>
                <dt>
                  Assignment
                </dt>

                <dd>
                  {agentCredentialResult.agent.assignedSessionId
                    ? 'Assigned'
                    : 'Unassigned'}
                </dd>
              </div>
            </dl>

            <div className="team-leader-api-key-panel">
              <GeneratedKeyField
                value={
                  agentCredentialResult.apiKey
                }
                label="Agent API key"
                description={
                  agentCredentialResult.reason ===
                  'reissued'
                    ? 'This replacement plaintext key is returned only once. The old key is invalid. Copy and store the new key now.'
                    : 'This plaintext key is returned only once. It is hidden by default; Copy always copies the complete key.'
                }
              />
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={
          Boolean(
            assignmentAgent,
          )
        }
        onClose={
          closeAssignmentModal
        }
        title={
          assignmentAgent?.assignedSessionId
            ? 'Reassign Agent'
            : 'Assign Agent'
        }
        className="team-leader-modal"
        hideCloseButton={
          assignMutation.isPending
        }
        footer={
          assignmentAgent ? (
            <>
              {assignmentAgent.assignedSessionId && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() =>
                    void unassignAgent(
                      assignmentAgent,
                    )
                  }
                  disabled={
                    assignMutation.isPending
                  }
                >
                  <Unlink
                    size={17}
                  />

                  Unassign
                </button>
              )}

              <button
                type="button"
                className="btn-secondary"
                onClick={
                  closeAssignmentModal
                }
                disabled={
                  assignMutation.isPending
                }
              >
                Cancel
              </button>

              <button
                type="button"
                className="btn-primary"
                onClick={() =>
                  void saveAssignment()
                }
                disabled={
                  assignMutation.isPending ||
                  !selectedSessionId
                }
              >
                {assignMutation.isPending && (
                  <Loader2
                    size={17}
                    className="animate-spin"
                  />
                )}

                Save assignment
              </button>
            </>
          ) : null
        }
      >
        {assignmentAgent && (
          <div className="team-leader-assignment-form">
            <div className="team-leader-assignment-agent">
              <UserRound
                size={20}
              />

              <div>
                <strong>
                  {
                    assignmentAgent.name
                  }
                </strong>

                <span>
                  {assignmentAgent.email ??
                    'No email'}
                </span>
              </div>
            </div>

            <label>
              <span>
                Session
              </span>

              <select
                value={
                  selectedSessionId
                }
                onChange={
                  event =>
                    setSelectedSessionId(
                      event.target.value,
                    )
                }
              >
                <option value="">
                  Select a session
                </option>

                {sessions.map(
                  session => {
                    const assignedTo =
                      assignedAgentBySessionId.get(
                        session.id,
                      );

                    const assignedToOtherAgent =
                      Boolean(
                        assignedTo &&
                          assignedTo.id !==
                            assignmentAgent.id,
                      );

                    return (
                      <option
                        key={
                          session.id
                        }
                        value={
                          session.id
                        }
                        disabled={
                          assignedToOtherAgent
                        }
                      >
                        {session.name}
                        {session.targetPhone
                          ? ` · ${session.targetPhone}`
                          : ''}
                        {assignedToOtherAgent
                          ? ` · assigned to ${assignedTo?.name}`
                          : ''}
                      </option>
                    );
                  },
                )}
              </select>

              <small>
                Sessions already assigned to another Agent are disabled. The backend remains authoritative for the assignment invariant.
              </small>
            </label>

            {sessions.length ===
              0 && (
              <div className="team-leader-inline-warning">
                No tenant-owned sessions are available. Create and manage sessions from the Sessions tab.

                <div
                  style={{
                    marginTop:
                      '0.75rem',
                  }}
                >
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      closeAssignmentModal();
                      navigate(
                        '/sessions',
                      );
                    }}
                  >
                    <Smartphone
                      size={17}
                    />

                    Open Sessions
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={
          Boolean(
            deleteAgentTarget,
          )
        }
        onClose={() => {
          if (
            !deleteAgentMutation.isPending
          ) {
            setDeleteAgentTarget(
              null,
            );
          }
        }}
        title="Delete Agent"
        className="team-leader-modal"
        hideCloseButton={
          deleteAgentMutation.isPending
        }
        footer={
          deleteAgentTarget ? (
            <>
              <button
                type="button"
                className="btn-secondary"
                onClick={() =>
                  setDeleteAgentTarget(
                    null,
                  )
                }
                disabled={
                  deleteAgentMutation.isPending
                }
              >
                Cancel
              </button>

              <button
                type="button"
                className="btn-danger"
                onClick={() =>
                  void confirmDeleteAgent()
                }
                disabled={
                  deleteAgentMutation.isPending
                }
              >
                {deleteAgentMutation.isPending ? (
                  <Loader2
                    size={17}
                    className="animate-spin"
                  />
                ) : (
                  <Trash2
                    size={17}
                  />
                )}

                Delete Agent
              </button>
            </>
          ) : null
        }
      >
        {deleteAgentTarget && (
          <div className="team-leader-delete-copy">
            <p>
              Delete <strong>{deleteAgentTarget.name}</strong>?
            </p>

            <p>
              The Agent principal and its AGENT API key will be removed. Its WhatsApp session is not deleted and remains owned by this Team Leader.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}



