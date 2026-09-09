import {
  useMemo,
  useState,
} from 'react';
import {
  useNavigate,
} from 'react-router-dom';
import {
  Check,
  Clipboard,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
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
  useToast,
} from '../hooks/useToast';

import {
  useDocumentTitle,
} from '../hooks/useDocumentTitle';

import {
  useAssignTeamLeaderAgentSessionMutation,
  useCreateSessionMutation,
  useCreateTeamLeaderAgentMutation,
  useDeleteTeamLeaderAgentMutation,
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

interface ProvisioningFormState {
  agentName: string;
  agentEmail: string;
  sessionName: string;
  targetPhone: string;
}

interface ProvisioningOutcome {
  session: Session;
  agentInput: CreateAgentInput;
  agent?: Agent;
  apiKey?: string;
  assigned: boolean;
  failedStage?: 'agent' | 'assignment';
  error?: string;
}

const EMPTY_FORM: ProvisioningFormState = {
  agentName: '',
  agentEmail: '',
  sessionName: '',
  targetPhone: '',
};

const SESSION_NAME_PATTERN =
  /^[a-zA-Z0-9-]{3,50}$/;

const TARGET_PHONE_PATTERN =
  /^\+?[1-9]\d{6,14}$/;

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
    new Date(value);

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
    .replaceAll('_', ' ')
    .replace(
      /\b\w/g,
      char =>
        char.toUpperCase(),
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

  /**
   * Phase-5 orchestration:
   *
   * 1. Create tenant-owned session.
   * 2. Create Agent + API key.
   * 3. Assign Agent to that session.
   *
   * These are deliberately three backend operations. We preserve any
   * successfully-created resource when a later step fails and surface a
   * retry path instead of pretending this cross-resource workflow is one
   * database transaction.
   */
  const createSessionMutation =
    useCreateSessionMutation();

  const createAgentMutation =
    useCreateTeamLeaderAgentMutation();

  const assignMutation =
    useAssignTeamLeaderAgentSessionMutation();

  const deleteAgentMutation =
    useDeleteTeamLeaderAgentMutation();

  const [
    showCreateModal,
    setShowCreateModal,
  ] = useState(false);

  const [
    form,
    setForm,
  ] =
    useState<ProvisioningFormState>(
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
    provisioningOutcome,
    setProvisioningOutcome,
  ] =
    useState<ProvisioningOutcome | null>(
      null,
    );

  const [
    isRetryingProvisioning,
    setIsRetryingProvisioning,
  ] =
    useState(false);

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

  const [
    copiedApiKey,
    setCopiedApiKey,
  ] =
    useState(false);

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

      for (const agent of agents) {
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

  const isProvisioning =
    createSessionMutation.isPending ||
    createAgentMutation.isPending ||
    assignMutation.isPending;

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
        isProvisioning
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
    (
      field:
        keyof ProvisioningFormState,
      value: string,
    ) => {
      setForm(
        current => ({
          ...current,
          [field]:
            value,
        }),
      );

      if (formError) {
        setFormError(
          null,
        );
      }
    };

  const validateProvisioningForm =
    (): string | null => {
      const agentName =
        form.agentName.trim();

      const agentEmail =
        form.agentEmail.trim();

      const sessionName =
        form.sessionName.trim();

      const targetPhone =
        form.targetPhone.trim();

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
        !SESSION_NAME_PATTERN.test(
          sessionName,
        )
      ) {
        return 'Session name must be 3-50 characters and contain only letters, numbers, and hyphens.';
      }

      if (
        targetPhone &&
        !TARGET_PHONE_PATTERN.test(
          targetPhone,
        )
      ) {
        return 'Target phone must be a valid international number with 7-15 digits, optionally prefixed with +.';
      }

      return null;
    };

  const handleProvision =
    async () => {
      const validationError =
        validateProvisioningForm();

      if (
        validationError
      ) {
        setFormError(
          validationError,
        );
        return;
      }

      setFormError(
        null,
      );

      const agentInput: CreateAgentInput = {
        name:
          form.agentName.trim(),
        ...(form.agentEmail.trim()
          ? {
              email:
                form.agentEmail.trim(),
            }
          : {}),
      };

      let createdSession:
        Session;

      try {
        createdSession =
          await createSessionMutation.mutateAsync(
            {
              name:
                form.sessionName.trim(),
              ...(form.targetPhone.trim()
                ? {
                    targetPhone:
                      form.targetPhone.trim(),
                  }
                : {}),
            },
          );
      } catch (error) {
        setFormError(
          errorMessage(
            error,
          ),
        );
        return;
      }

      let createdAgent:
        Agent;

      let apiKey:
        string;

      try {
        const result =
          await createAgentMutation.mutateAsync(
            agentInput,
          );

        createdAgent =
          result.agent;

        apiKey =
          result.apiKey;
      } catch (error) {
        setShowCreateModal(
          false,
        );

        setProvisioningOutcome(
          {
            session:
              createdSession,
            agentInput,
            assigned:
              false,
            failedStage:
              'agent',
            error:
              errorMessage(
                error,
              ),
          },
        );

        toast.warning(
          'Session created, Agent not created',
          'The session was kept. Retry Agent creation from the recovery dialog.',
        );

        return;
      }

      try {
        const assignedAgent =
          await assignMutation.mutateAsync(
            {
              agentId:
                createdAgent.id,
              sessionId:
                createdSession.id,
            },
          );

        setProvisioningOutcome(
          {
            session:
              createdSession,
            agentInput,
            agent:
              assignedAgent,
            apiKey,
            assigned:
              true,
          },
        );

        setShowCreateModal(
          false,
        );

        toast.success(
          'Agent session created',
          `${assignedAgent.name} is assigned to ${createdSession.name}.`,
        );
      } catch (error) {
        setShowCreateModal(
          false,
        );

        setProvisioningOutcome(
          {
            session:
              createdSession,
            agentInput,
            agent:
              createdAgent,
            apiKey,
            assigned:
              false,
            failedStage:
              'assignment',
            error:
              errorMessage(
                error,
              ),
          },
        );

        toast.warning(
          'Agent created, assignment failed',
          'The Agent and session were kept. Retry the assignment from the recovery dialog.',
        );
      }
    };

  const retryProvisioning =
    async () => {
      const outcome =
        provisioningOutcome;

      if (
        !outcome ||
        !outcome.failedStage
      ) {
        return;
      }

      setIsRetryingProvisioning(
        true,
      );

      try {
        if (
          outcome.failedStage ===
          'agent'
        ) {
          const result =
            await createAgentMutation.mutateAsync(
              outcome.agentInput,
            );

          try {
            const assignedAgent =
              await assignMutation.mutateAsync(
                {
                  agentId:
                    result.agent.id,
                  sessionId:
                    outcome.session.id,
                },
              );

            setProvisioningOutcome(
              {
                ...outcome,
                agent:
                  assignedAgent,
                apiKey:
                  result.apiKey,
                assigned:
                  true,
                failedStage:
                  undefined,
                error:
                  undefined,
              },
            );

            toast.success(
              'Provisioning recovered',
              `${assignedAgent.name} is now assigned to ${outcome.session.name}.`,
            );
          } catch (error) {
            setProvisioningOutcome(
              {
                ...outcome,
                agent:
                  result.agent,
                apiKey:
                  result.apiKey,
                assigned:
                  false,
                failedStage:
                  'assignment',
                error:
                  errorMessage(
                    error,
                  ),
              },
            );
          }

          return;
        }

        if (
          outcome.failedStage ===
            'assignment' &&
          outcome.agent
        ) {
          const assignedAgent =
            await assignMutation.mutateAsync(
              {
                agentId:
                  outcome.agent.id,
                sessionId:
                  outcome.session.id,
              },
            );

          setProvisioningOutcome(
            {
              ...outcome,
              agent:
                assignedAgent,
              assigned:
                true,
              failedStage:
                undefined,
              error:
                undefined,
            },
          );

          toast.success(
            'Assignment recovered',
            `${assignedAgent.name} is now assigned to ${outcome.session.name}.`,
          );
        }
      } catch (error) {
        setProvisioningOutcome(
          current =>
            current
              ? {
                  ...current,
                  error:
                    errorMessage(
                      error,
                    ),
                }
              : current,
        );
      } finally {
        setIsRetryingProvisioning(
          false,
        );
      }
    };

  const handleCopyApiKey =
    async () => {
      const apiKey =
        provisioningOutcome?.apiKey;

      if (!apiKey) {
        return;
      }

      try {
        await navigator.clipboard.writeText(
          apiKey,
        );

        setCopiedApiKey(
          true,
        );

        toast.success(
          'API key copied',
          'Store it securely. The plaintext key cannot be retrieved later.',
        );

        window.setTimeout(
          () =>
            setCopiedApiKey(
              false,
            ),
          2000,
        );
      } catch {
        toast.error(
          'Copy failed',
          'Select the API key manually and copy it.',
        );
      }
    };

  const closeProvisioningOutcome =
    () => {
      setProvisioningOutcome(
        null,
      );
      setCopiedApiKey(
        false,
      );
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
      } catch (error) {
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
      } catch (error) {
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

        setDeleteAgentTarget(
          null,
        );
      } catch (error) {
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
        `/chats?session=${encodeURIComponent(sessionId)}`,
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
            ? `Manage Agents and tenant-owned WhatsApp sessions for ${meQuery.data.name}.`
            : 'Manage your Agents and assigned WhatsApp sessions.'
        }
        badge={
          meQuery.data ? (
            <span className="team-leader-identity-badge">
              <UserRound
                size={14}
              />

              {
                meQuery.data.email
              }
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
              className="btn-primary"
              onClick={
                openCreateModal
              }
            >
              <Plus
                size={18}
              />

              Create Agent Session
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
            Agents with an active session assignment
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
            Sessions returned by the tenant-scoped API
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
              Assign one tenant-owned WhatsApp session to each Agent.
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
              Create your first Agent together with a tenant-owned WhatsApp session.
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

              Create Agent Session
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
        title="Create Agent Session"
        className="team-leader-modal"
        hideCloseButton={
          isProvisioning
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
                isProvisioning
              }
            >
              Cancel
            </button>

            <button
              type="button"
              className="btn-primary"
              onClick={() =>
                void handleProvision()
              }
              disabled={
                isProvisioning
              }
            >
              {isProvisioning ? (
                <Loader2
                  size={17}
                  className="animate-spin"
                />
              ) : (
                <Plus
                  size={17}
                />
              )}

              {isProvisioning
                ? 'Creating...'
                : 'Create Agent Session'}
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
                The Team Leader ownership is derived from your authenticated API key.
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
          </div>
        </div>

        <div className="team-leader-form-divider" />

        <div className="team-leader-form-section">
          <div className="team-leader-form-section-title">
            <span className="team-leader-step">
              2
            </span>

            <div>
              <strong>
                WhatsApp session
              </strong>

              <span>
                The session is created inside your tenant and then assigned to the Agent.
              </span>
            </div>
          </div>

          <div className="team-leader-form-grid">
            <label>
              <span>
                Session name
              </span>

              <input
                type="text"
                value={
                  form.sessionName
                }
                onChange={
                  event =>
                    updateForm(
                      'sessionName',
                      event.target.value,
                    )
                }
                maxLength={
                  50
                }
                placeholder="support-01"
                autoComplete="off"
              />

              <small>
                3-50 characters; letters, numbers and hyphens only.
              </small>
            </label>

            <label>
              <span>
                Target phone
              </span>

              <input
                type="tel"
                value={
                  form.targetPhone
                }
                onChange={
                  event =>
                    updateForm(
                      'targetPhone',
                      event.target.value,
                    )
                }
                maxLength={
                  20
                }
                placeholder="+201234567890"
                autoComplete="off"
              />

              <small>
                Optional display/intention metadata; not used for authorization.
              </small>
            </label>
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

        <div className="team-leader-workflow-note">
          <strong>
            Creation order
          </strong>

          <span>
            Session → Agent/API key → assignment. If a later step fails, completed resources are kept and a recovery action is shown.
          </span>
        </div>
      </Modal>

      <Modal
        open={
          Boolean(
            provisioningOutcome,
          )
        }
        onClose={
          closeProvisioningOutcome
        }
        title={
          provisioningOutcome?.failedStage
            ? 'Provisioning needs attention'
            : 'Agent Session Created'
        }
        className="team-leader-modal"
        hideCloseButton={
          isRetryingProvisioning
        }
        footer={
          provisioningOutcome ? (
            <>
              {provisioningOutcome.failedStage && (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() =>
                    void retryProvisioning()
                  }
                  disabled={
                    isRetryingProvisioning
                  }
                >
                  {isRetryingProvisioning ? (
                    <Loader2
                      size={17}
                      className="animate-spin"
                    />
                  ) : (
                    <RefreshCw
                      size={17}
                    />
                  )}

                  Retry {
                    provisioningOutcome.failedStage ===
                    'agent'
                      ? 'Agent creation'
                      : 'assignment'
                  }
                </button>
              )}

              <button
                type="button"
                className="btn-secondary"
                onClick={
                  closeProvisioningOutcome
                }
                disabled={
                  isRetryingProvisioning
                }
              >
                Close
              </button>
            </>
          ) : null
        }
      >
        {provisioningOutcome && (
          <div className="team-leader-result">
            <div
              className={`team-leader-result-status ${
                provisioningOutcome.failedStage
                  ? 'team-leader-result-status--warning'
                  : 'team-leader-result-status--success'
              }`}
            >
              {provisioningOutcome.failedStage ? (
                <RefreshCw
                  size={22}
                />
              ) : (
                <Check
                  size={22}
                />
              )}

              <div>
                <strong>
                  {provisioningOutcome.failedStage
                    ? 'Partial provisioning completed'
                    : 'Provisioning completed'}
                </strong>

                <span>
                  {provisioningOutcome.failedStage ===
                  'agent'
                    ? 'The session exists, but the Agent was not created.'
                    : provisioningOutcome.failedStage ===
                        'assignment'
                      ? 'The session and Agent exist, but assignment did not complete.'
                      : 'The Agent is assigned to the new session.'}
                </span>
              </div>
            </div>

            <dl className="team-leader-result-details">
              <div>
                <dt>
                  Session
                </dt>

                <dd>
                  {
                    provisioningOutcome.session.name
                  }
                </dd>
              </div>

              <div>
                <dt>
                  Session ID
                </dt>

                <dd>
                  <code>
                    {
                      provisioningOutcome.session.id
                    }
                  </code>
                </dd>
              </div>

              <div>
                <dt>
                  Agent
                </dt>

                <dd>
                  {provisioningOutcome.agent?.name ??
                    provisioningOutcome.agentInput.name}
                </dd>
              </div>

              <div>
                <dt>
                  Assignment
                </dt>

                <dd>
                  {provisioningOutcome.assigned
                    ? 'Assigned'
                    : 'Not assigned'}
                </dd>
              </div>
            </dl>

            {provisioningOutcome.error && (
              <div
                className="team-leader-inline-error"
                role="alert"
              >
                {
                  provisioningOutcome.error
                }
              </div>
            )}

            {provisioningOutcome.apiKey && (
              <div className="team-leader-api-key-panel">
                <div>
                  <strong>
                    Agent API key
                  </strong>

                  <span>
                    This plaintext key is returned only once. Save it before closing this dialog.
                  </span>
                </div>

                <div className="team-leader-api-key-row">
                  <input
                    type="text"
                    readOnly
                    value={
                      provisioningOutcome.apiKey
                    }
                    aria-label="Agent API key"
                  />

                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() =>
                      void handleCopyApiKey()
                    }
                  >
                    {copiedApiKey ? (
                      <Check
                        size={17}
                      />
                    ) : (
                      <Clipboard
                        size={17}
                      />
                    )}

                    {copiedApiKey
                      ? 'Copied'
                      : 'Copy'}
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
                Sessions already assigned to another Agent are disabled. The backend also enforces this invariant.
              </small>
            </label>

            {sessions.length ===
              0 && (
              <div className="team-leader-inline-warning">
                No tenant-owned sessions are available. Create an Agent Session first.
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
