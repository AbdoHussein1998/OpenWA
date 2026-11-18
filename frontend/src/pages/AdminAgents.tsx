import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from 'react';
import {
  useNavigate,
} from 'react-router-dom';
import {
  AlertCircle,
  ArrowRightLeft,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Smartphone,
  Trash2,
  UserRound,
  Users,
  Wifi,
} from 'lucide-react';

import {
  Modal,
} from '../components/Modal';

import {
  AgentRetirementModal,
} from '../components/AgentRetirementModal';

import {
  GeneratedKeyField,
} from '../components/GeneratedKeyField';

import {
  PageHeader,
} from '../components/PageHeader';

import {
  useAdminAgentsQuery,
  useAdminTeamLeadersQuery,
  useBulkReassignAdminAgentsMutation,
  useCreateAdminAgentMutation,
  useReassignAdminAgentMutation,
} from '../hooks/queries';

import {
  useDocumentTitle,
} from '../hooks/useDocumentTitle';

import {
  useToast,
} from '../hooks/useToast';

import {
  useRole,
} from '../hooks/useRole';

import type {
  AdminAgentOverview,
} from '../services/api';

import './AdminAgents.css';
import './AdminAgentsEnhancements.css';

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

function formatShortDate(
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

  return parsed.toLocaleDateString();
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
      character =>
        character.toUpperCase(),
    );
}

function statusClassName(
  status: string,
): string {
  const normalized =
    status
      .trim()
      .toLowerCase()
      .replace(
        /[^a-z0-9_-]+/g,
        '-',
      );

  return normalized || 'unknown';
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

function isValidEmail(
  value: string,
): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    value,
  );
}

function matchesSearch(
  agent: AdminAgentOverview,
  searchTerm: string,
): boolean {
  if (!searchTerm) {
    return true;
  }

  const session =
    agent.assignedSession;

  const searchableValues = [
    agent.name,
    agent.email,
    agent.id,
    agent.teamLeader.name,
    agent.teamLeader.email,
    agent.teamLeader.id,
    agent.assignedSessionId,
    session?.name,
    session?.id,
    session?.status,
    session?.phone,
    session?.targetPhone,
  ];

  return searchableValues.some(
    value =>
      value
        ?.toLowerCase()
        .includes(
          searchTerm,
        ) ?? false,
  );
}

export function AdminAgents() {
  useDocumentTitle(
    'Admin Agents',
  );

  const navigate =
    useNavigate();

  const toast =
    useToast();

  const {
    canManagePrincipals,
  } = useRole();

  const agentsQuery =
    useAdminAgentsQuery();

  const teamLeadersQuery =
    useAdminTeamLeadersQuery();

  const reassignAgentMutation =
    useReassignAdminAgentMutation();

  const bulkReassignAgentsMutation =
    useBulkReassignAdminAgentsMutation();

  const createAgentMutation =
    useCreateAdminAgentMutation();

  const [
    search,
    setSearch,
  ] = useState('');

  const [
    showCreateModal,
    setShowCreateModal,
  ] = useState(false);

  const [
    createName,
    setCreateName,
  ] = useState('');

  const [
    createEmail,
    setCreateEmail,
  ] = useState('');

  const [
    createTeamLeaderId,
    setCreateTeamLeaderId,
  ] = useState('');

  const [
    createTemplateLimit,
    setCreateTemplateLimit,
  ] = useState('');

  const [
    createError,
    setCreateError,
  ] = useState<string | null>(
    null,
  );

  const [
    createdAgentCredential,
    setCreatedAgentCredential,
  ] = useState<{
    name: string;
    apiKey: string;
  } | null>(null);

  const [
    retiringAgentId,
    setRetiringAgentId,
  ] = useState<string | null>(
    null,
  );

  const [
    selectedAgentIds,
    setSelectedAgentIds,
  ] = useState<Set<string>>(
    () => new Set(),
  );

  const [
    bulkTargetTeamLeaderId,
    setBulkTargetTeamLeaderId,
  ] = useState('');

  const [
    bulkUnassignSession,
    setBulkUnassignSession,
  ] = useState(true);

  const [
    managedAgentId,
    setManagedAgentId,
  ] = useState('');

  const [
    individualTargetTeamLeaderId,
    setIndividualTargetTeamLeaderId,
  ] = useState('');

  const [
    individualUnassignSession,
    setIndividualUnassignSession,
  ] = useState(true);

  const agents =
    agentsQuery.data ??
    [];

  const teamLeaders =
    teamLeadersQuery.data ??
    [];

  const trimmedCreateName =
    createName.trim();

  const trimmedCreateEmail =
    createEmail.trim();

  const parsedTemplateLimit =
    createTemplateLimit === ''
      ? null
      : Number(createTemplateLimit);

  const createTemplateLimitValid =
    parsedTemplateLimit === null ||
    (
      Number.isInteger(
        parsedTemplateLimit,
      ) &&
      parsedTemplateLimit >= 0
    );

  const canCreateAgent =
    trimmedCreateName.length > 0 &&
    trimmedCreateName.length <= 100 &&
    Boolean(createTeamLeaderId) &&
    (
      !trimmedCreateEmail ||
      isValidEmail(
        trimmedCreateEmail,
      )
    ) &&
    createTemplateLimitValid;

  const managedAgent =
    useMemo(
      () =>
        agents.find(
          agent =>
            agent.id ===
            managedAgentId,
        ) ?? null,
      [
        agents,
        managedAgentId,
      ],
    );

  useEffect(() => {
    if (!managedAgent) {
      setIndividualTargetTeamLeaderId('');
      return;
    }

    const defaultTarget =
      teamLeaders.find(
        teamLeader =>
          teamLeader.id !==
          managedAgent.teamLeaderId,
      )?.id ?? '';

    setIndividualTargetTeamLeaderId(
      defaultTarget,
    );
    setIndividualUnassignSession(
      Boolean(
        managedAgent.assignedSessionId,
      ),
    );
  }, [
    managedAgent,
    teamLeaders,
  ]);

  useEffect(() => {
    if (
      showCreateModal &&
      !createTeamLeaderId &&
      teamLeaders.length > 0
    ) {
      setCreateTeamLeaderId(
        teamLeaders[0].id,
      );
    }
  }, [
    showCreateModal,
    createTeamLeaderId,
    teamLeaders,
  ]);

  /**
   * Fail closed in the UI if the authenticated role changes while this page
   * remains mounted. Backend authorization is still authoritative, but stale
   * mutation state must not remain interactable after losing permission.
   */
  useEffect(() => {
    if (canManagePrincipals) {
      return;
    }

    setShowCreateModal(false);
    setCreateError(null);
    setCreatedAgentCredential(null);
    setRetiringAgentId(null);
    setSelectedAgentIds(new Set());
    setBulkTargetTeamLeaderId('');
    setManagedAgentId('');
    setIndividualTargetTeamLeaderId('');
  }, [canManagePrincipals]);

  const normalizedSearch =
    search
      .trim()
      .toLowerCase();

  const filteredAgents =
    useMemo(
      () =>
        agents.filter(
          agent =>
            matchesSearch(
              agent,
              normalizedSearch,
            ),
        ),
      [
        agents,
        normalizedSearch,
      ],
    );

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

  const readyCount =
    agents.filter(
      agent =>
        agent.assignedSession?.status ===
        'ready',
    ).length;

  const staleAssignmentCount =
    agents.filter(
      agent =>
        Boolean(
          agent.assignedSessionId,
        ) &&
        !agent.assignedSession,
    ).length;

  const allFilteredSelected =
    filteredAgents.length > 0 &&
    filteredAgents.every(
      agent =>
        selectedAgentIds.has(
          agent.id,
        ),
    );

  const bulkMoveCandidateIds =
    useMemo(
      () =>
        agents
          .filter(
            agent =>
              selectedAgentIds.has(
                agent.id,
              ) &&
              agent.teamLeaderId !==
                bulkTargetTeamLeaderId,
          )
          .map(
            agent =>
              agent.id,
          ),
      [
        agents,
        selectedAgentIds,
        bulkTargetTeamLeaderId,
      ],
    );

  const isMutating =
    reassignAgentMutation.isPending ||
    bulkReassignAgentsMutation.isPending ||
    createAgentMutation.isPending;

  const openCreateAgent =
    () => {
      if (!canManagePrincipals) {
        return;
      }

      setCreateName('');
      setCreateEmail('');
      setCreateTeamLeaderId(
        teamLeaders[0]?.id ?? '',
      );
      setCreateTemplateLimit('');
      setCreateError(null);
      setCreatedAgentCredential(null);
      setShowCreateModal(true);
    };

  const closeCreateAgent =
    () => {
      if (
        createAgentMutation.isPending
      ) {
        return;
      }

      setShowCreateModal(false);
      setCreateError(null);
      setCreatedAgentCredential(null);
    };

  const createAgent =
    async () => {
      if (
        !canManagePrincipals ||
        !canCreateAgent
      ) {
        return;
      }

      setCreateError(null);

      try {
        const created =
          await createAgentMutation.mutateAsync({
            teamLeaderId:
              createTeamLeaderId,
            data: {
              name:
                trimmedCreateName,
              ...(trimmedCreateEmail
                ? {
                    email:
                      trimmedCreateEmail,
                  }
                : {}),
              templateSendLimit24h:
                parsedTemplateLimit,
            },
          });

        setCreatedAgentCredential({
          name:
            created.agent.name,
          apiKey:
            created.apiKey,
        });

        toast.success(
          'Agent created',
          `${created.agent.name} was created successfully.`,
        );
      } catch (error) {
        const message =
          errorMessage(error);

        setCreateError(
          message,
        );

        toast.error(
          'Agent creation failed',
          message,
        );
      }
    };

  const refresh =
    () => {
      void Promise.all([
        agentsQuery.refetch(),
        teamLeadersQuery.refetch(),
      ]);
    };

  const openSession =
    () => {
      navigate(
        '/sessions',
      );
    };

  const openChats =
    (sessionId: string) => {
      navigate(
        `/chats?session=${encodeURIComponent(
          sessionId,
        )}`,
      );
    };

  const toggleAgentSelection =
    (
      agentId: string,
      checked: boolean,
    ) => {
      if (!canManagePrincipals) {
        return;
      }

      setSelectedAgentIds(
        previous => {
          const next =
            new Set(previous);

          if (checked) {
            next.add(agentId);
          } else {
            next.delete(agentId);
          }

          return next;
        },
      );
    };

  const toggleAllFiltered =
    (
      checked: boolean,
    ) => {
      if (!canManagePrincipals) {
        return;
      }

      setSelectedAgentIds(
        previous => {
          const next =
            new Set(previous);

          for (
            const agent of
            filteredAgents
          ) {
            if (checked) {
              next.add(agent.id);
            } else {
              next.delete(agent.id);
            }
          }

          return next;
        },
      );
    };

  const bulkMoveAgents =
    async () => {
      if (
        !canManagePrincipals ||
        selectedAgentIds.size === 0 ||
        !bulkTargetTeamLeaderId
      ) {
        return;
      }

      if (bulkMoveCandidateIds.length === 0) {
        toast.info(
          'No Agents to move',
          'Every selected Agent already belongs to the destination Team Leader.',
        );
        return;
      }

      try {
        await bulkReassignAgentsMutation.mutateAsync({
          agentIds:
            bulkMoveCandidateIds,
          targetTeamLeaderId:
            bulkTargetTeamLeaderId,
          unassignSession:
            bulkUnassignSession,
        });

        setSelectedAgentIds(
          new Set(),
        );

        toast.success(
          'Agents moved',
          'The selected Agents were reassigned successfully.',
        );
      } catch (error) {
        toast.error(
          'Bulk Agent reassignment failed',
          errorMessage(error),
        );
      }
    };

  const moveManagedAgent =
    async () => {
      if (
        !canManagePrincipals ||
        !managedAgent ||
        !individualTargetTeamLeaderId
      ) {
        return;
      }

      try {
        await reassignAgentMutation.mutateAsync({
          agentId:
            managedAgent.id,
          data: {
            targetTeamLeaderId:
              individualTargetTeamLeaderId,
            unassignSession:
              individualUnassignSession,
          },
        });

        toast.success(
          'Agent moved',
          `${managedAgent.name} was reassigned successfully.`,
        );

        setManagedAgentId('');
      } catch (error) {
        toast.error(
          'Agent reassignment failed',
          errorMessage(error),
        );
      }
    };

  if (
    agentsQuery.isLoading
  ) {
    return (
      <div className="admin-agents-page">
        <div className="admin-agents-loading">
          <Loader2
            size={32}
            className="animate-spin"
          />

          <span>
            Loading Agents...
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-agents-page">
      <PageHeader
        title="Agents"
        subtitle={
          canManagePrincipals
            ? 'Move Agents between Team Leaders, resolve Session assignment conflicts, and delete Agent principals safely.'
            : 'View Agents, their Team Leaders, Session assignments, status, and quota information.'
        }
        actions={
          <div className="admin-agents-header-actions">
            {canManagePrincipals && (
              <button
                type="button"
                className="admin-agents-create-btn"
                onClick={
                  openCreateAgent
                }
                disabled={
                  teamLeaders.length === 0 ||
                  createAgentMutation.isPending
                }
              >
                <Plus size={17} />
                New Agent
              </button>
            )}

            <button
              type="button"
              className="btn-secondary"
              onClick={refresh}
              disabled={
                agentsQuery.isFetching ||
                teamLeadersQuery.isFetching ||
                isMutating
              }
            >
              <RefreshCw
                size={17}
                className={
                  agentsQuery.isFetching ||
                  teamLeadersQuery.isFetching
                    ? 'animate-spin'
                    : undefined
                }
              />

              Refresh
            </button>
          </div>
        }
      />

      {(agentsQuery.isError ||
        teamLeadersQuery.isError) && (
        <div
          className="admin-agents-alert admin-agents-alert--error"
          role="alert"
        >
          <AlertCircle size={20} />

          <div>
            <strong>
              Administration data could not be loaded.
            </strong>

            <span>
              {errorMessage(
                agentsQuery.error ??
                  teamLeadersQuery.error,
              )}
            </span>
          </div>

          <button
            type="button"
            className="btn-secondary"
            onClick={refresh}
            disabled={
              agentsQuery.isFetching ||
              teamLeadersQuery.isFetching
            }
          >
            Retry
          </button>
        </div>
      )}

      <section
        className="admin-agents-summary-grid"
        aria-label="Agent overview"
      >
        <article className="admin-agents-summary-card">
          <div className="admin-agents-summary-icon">
            <Users size={20} />
          </div>

          <div>
            <span className="admin-agents-summary-label">
              Agents
            </span>

            <strong className="admin-agents-summary-value">
              {agents.length}
            </strong>

            <span className="admin-agents-summary-hint">
              Across all Team Leaders
            </span>
          </div>
        </article>

        <article className="admin-agents-summary-card">
          <div className="admin-agents-summary-icon">
            <Smartphone size={20} />
          </div>

          <div>
            <span className="admin-agents-summary-label">
              Assigned
            </span>

            <strong className="admin-agents-summary-value">
              {assignedCount}
            </strong>

            <span className="admin-agents-summary-hint">
              Agents with a Session id
            </span>
          </div>
        </article>

        <article className="admin-agents-summary-card">
          <div className="admin-agents-summary-icon">
            <UserRound size={20} />
          </div>

          <div>
            <span className="admin-agents-summary-label">
              Unassigned
            </span>

            <strong className="admin-agents-summary-value">
              {unassignedCount}
            </strong>

            <span className="admin-agents-summary-hint">
              Waiting for assignment
            </span>
          </div>
        </article>

        <article className="admin-agents-summary-card">
          <div className="admin-agents-summary-icon">
            <Wifi size={20} />
          </div>

          <div>
            <span className="admin-agents-summary-label">
              Ready sessions
            </span>

            <strong className="admin-agents-summary-value">
              {readyCount}
            </strong>

            <span className="admin-agents-summary-hint">
              {staleAssignmentCount > 0
                ? `${staleAssignmentCount} stale assignment${staleAssignmentCount === 1 ? '' : 's'}`
                : 'No stale assignments detected'}
            </span>
          </div>
        </article>
      </section>

      <section className="admin-agents-section">
        <div className="admin-agents-toolbar">
          <div>
            <h2>
              Agent inventory
            </h2>

            <p>
              {canManagePrincipals
                ? 'Select Agents for a bulk Team Leader move, or use the row actions for an individual reassignment or deletion.'
                : 'View Agent identity, Team Leader ownership, Session assignment, connection status, and template quota.'}
            </p>
          </div>

          <label className="admin-agents-search">
            <Search
              size={17}
              aria-hidden="true"
            />

            <span className="sr-only">
              Search Agents
            </span>

            <input
              type="search"
              value={search}
              onChange={
                (
                  event:
                    ChangeEvent<HTMLInputElement>,
                ) =>
                  setSearch(
                    event.target.value,
                  )
              }
              placeholder="Search Agent, Team Leader, Session or phone"
              autoComplete="off"
            />
          </label>
        </div>

        {canManagePrincipals && agents.length > 0 && (
          <div className="admin-agents-bulk-bar">
            <div className="admin-agents-bulk-selection">
              <strong>
                {selectedAgentIds.size} selected
              </strong>
              <button
                type="button"
                className="admin-agents-text-button"
                onClick={() =>
                  setSelectedAgentIds(
                    new Set(),
                  )
                }
                disabled={
                  selectedAgentIds.size === 0 ||
                  isMutating
                }
              >
                Clear
              </button>
            </div>

            <label className="admin-agents-bulk-field">
              <span>
                Move to Team Leader
              </span>
              <select
                value={bulkTargetTeamLeaderId}
                onChange={event =>
                  setBulkTargetTeamLeaderId(
                    event.target.value,
                  )
                }
                disabled={
                  teamLeaders.length === 0 ||
                  isMutating
                }
              >
                <option value="">
                  Select Team Leader
                </option>
                {teamLeaders.map(
                  teamLeader => (
                    <option
                      key={teamLeader.id}
                      value={teamLeader.id}
                    >
                      {teamLeader.name}
                    </option>
                  ),
                )}
              </select>
            </label>

            <label className="admin-agents-bulk-checkbox">
              <input
                type="checkbox"
                checked={bulkUnassignSession}
                onChange={event =>
                  setBulkUnassignSession(
                    event.target.checked,
                  )
                }
                disabled={isMutating}
              />
              Clear Session assignments when moving
            </label>

            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                void bulkMoveAgents()
              }
              disabled={
                selectedAgentIds.size === 0 ||
                !bulkTargetTeamLeaderId ||
                bulkMoveCandidateIds.length === 0 ||
                isMutating
              }
            >
              {bulkReassignAgentsMutation.isPending ? (
                <Loader2
                  size={16}
                  className="animate-spin"
                />
              ) : (
                <ArrowRightLeft size={16} />
              )}
              Move selected
            </button>
          </div>
        )}

        {agents.length === 0 ? (
          <div className="admin-agents-empty-state">
            <div className="admin-agents-empty-icon">
              <Users size={30} />
            </div>

            <h3>
              No Agents yet
            </h3>

            <p>
              Agents will appear here after they are created under a Team Leader.
            </p>
          </div>
        ) : filteredAgents.length === 0 ? (
          <div className="admin-agents-empty-state admin-agents-empty-state--compact">
            <Search size={28} />

            <h3>
              No matching Agents
            </h3>

            <p>
              Try another name, Team Leader, Session id, or phone number.
            </p>

            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                setSearch('')
              }
            >
              Clear search
            </button>
          </div>
        ) : (
          <div className="admin-agents-table-wrap">
            <table className="admin-agents-table">
              <thead>
                <tr>
                  {canManagePrincipals && (
                    <th className="admin-agents-select-column">
                      <input
                        type="checkbox"
                        checked={allFilteredSelected}
                        onChange={event =>
                          toggleAllFiltered(
                            event.target.checked,
                          )
                        }
                        aria-label="Select all visible Agents"
                        disabled={isMutating}
                      />
                    </th>
                  )}
                  <th>Agent</th>
                  <th>Team Leader</th>
                  <th>Session</th>
                  <th>Configured phone</th>
                  <th>Connected phone</th>
                  <th>Status</th>
                  <th>Template quota</th>
                  <th>Created</th>
                  <th className="admin-agents-actions-column">
                    Actions
                  </th>
                </tr>
              </thead>

              <tbody>
                {filteredAgents.map(
                  agent => {
                    const session =
                      agent.assignedSession;

                    return (
                      <tr key={agent.id}>
                        {canManagePrincipals && (
                          <td className="admin-agents-select-cell">
                            <input
                              type="checkbox"
                              checked={
                                selectedAgentIds.has(
                                  agent.id,
                                )
                              }
                              onChange={event =>
                                toggleAgentSelection(
                                  agent.id,
                                  event.target.checked,
                                )
                              }
                              aria-label={`Select ${agent.name}`}
                              disabled={isMutating}
                            />
                          </td>
                        )}

                        <td>
                          <div className="admin-agents-identity-cell">
                            <strong>
                              {agent.name}
                            </strong>

                            <span>
                              {agent.email ??
                                'No email'}
                            </span>

                            <code title={agent.id}>
                              {agent.id}
                            </code>
                          </div>
                        </td>

                        <td>
                          <div className="admin-agents-identity-cell">
                            <strong>
                              {agent.teamLeader.name}
                            </strong>

                            <span>
                              {agent.teamLeader.email ??
                                'No email'}
                            </span>
                          </div>
                        </td>

                        <td>
                          {session ? (
                            <div className="admin-agents-session-cell">
                              <strong>
                                {session.name}
                              </strong>

                              <code title={session.id}>
                                {session.id}
                              </code>
                            </div>
                          ) : agent.assignedSessionId ? (
                            <div className="admin-agents-session-cell">
                              <span className="admin-agents-status-pill admin-agents-status-pill--warning">
                                Missing session
                              </span>

                              <code title={agent.assignedSessionId}>
                                {agent.assignedSessionId}
                              </code>

                              <span className="admin-agents-muted">
                                The assignment id exists, but the Session could not be resolved.
                              </span>
                            </div>
                          ) : (
                            <span className="admin-agents-status-pill admin-agents-status-pill--unassigned">
                              Unassigned
                            </span>
                          )}
                        </td>

                        <td className="admin-agents-phone">
                          {session?.targetPhone ??
                            '—'}
                        </td>

                        <td className="admin-agents-phone">
                          {session?.phone ??
                            '—'}
                        </td>

                        <td>
                          {session ? (
                            <span
                              className={`admin-agents-status-pill admin-agents-status-pill--${statusClassName(
                                session.status,
                              )}`}
                            >
                              {statusLabel(
                                session.status,
                              )}
                            </span>
                          ) : (
                            <span className="admin-agents-muted">
                              —
                            </span>
                          )}
                        </td>

                        <td>
                          <span className="admin-agents-status-pill admin-agents-status-pill--quota">
                            {templateQuotaLabel(
                              agent.templateSendLimit24h,
                            )}
                          </span>
                        </td>

                        <td>
                          <span
                            className="admin-agents-date"
                            title={
                              formatDate(
                                agent.createdAt,
                              )
                            }
                          >
                            {formatShortDate(
                              agent.createdAt,
                            )}
                          </span>
                        </td>

                        <td>
                          <div className="admin-agents-row-actions">
                            {canManagePrincipals && (
                              <button
                                type="button"
                                className="admin-agents-action-btn"
                                onClick={() =>
                                  setManagedAgentId(
                                    agent.id,
                                  )
                                }
                                disabled={isMutating}
                              >
                                <ArrowRightLeft size={16} />
                                Move
                              </button>
                            )}

                            {session ? (
                              <>
                                <button
                                  type="button"
                                  className="admin-agents-action-btn"
                                  onClick={openSession}
                                  title="Open Sessions"
                                >
                                  <Smartphone size={16} />
                                  Session
                                </button>

                                <button
                                  type="button"
                                  className="admin-agents-action-btn"
                                  onClick={() =>
                                    openChats(
                                      session.id,
                                    )
                                  }
                                  title={`Open chats for ${session.name}`}
                                >
                                  <ExternalLink size={16} />
                                  Chats
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="admin-agents-action-btn"
                                onClick={openSession}
                              >
                                <Smartphone size={16} />
                                Sessions
                              </button>
                            )}

                            {canManagePrincipals && (
                              <button
                                type="button"
                                className="admin-agents-action-btn admin-agents-action-btn--danger"
                                onClick={() =>
                                  setRetiringAgentId(
                                    agent.id,
                                  )
                                }
                                disabled={isMutating}
                              >
                                <Trash2 size={16} />
                                Delete
                              </button>
                            )}
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

      {canManagePrincipals && (
        <Modal
          open={showCreateModal}
          onClose={
            closeCreateAgent
          }
          title={
            createdAgentCredential
              ? 'Agent created'
              : 'Create Agent'
          }
          className="admin-agents-create-modal"
          hideCloseButton={
            createAgentMutation.isPending
          }
          closeLabel="Close"
          footer={
            createdAgentCredential ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={
                  closeCreateAgent
                }
              >
                Close
              </button>
            ) : (
              <div className="admin-agents-create-modal-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={
                    closeCreateAgent
                  }
                  disabled={
                    createAgentMutation.isPending
                  }
                >
                  Cancel
                </button>

                <button
                  type="button"
                  className="admin-agents-create-btn"
                  onClick={() =>
                    void createAgent()
                  }
                  disabled={
                    !canCreateAgent ||
                    createAgentMutation.isPending
                  }
                >
                  {createAgentMutation.isPending ? (
                    <Loader2
                      size={16}
                      className="animate-spin"
                    />
                  ) : (
                    <Plus size={16} />
                  )}
                  Create Agent
                </button>
              </div>
            )
          }
        >
          {createdAgentCredential ? (
            <div className="admin-agents-created-credential">
              <div>
                <strong>
                  {createdAgentCredential.name}
                </strong>
                <span>
                  The Agent principal and its AGENT credential were created together.
                </span>
              </div>

              <GeneratedKeyField
                value={
                  createdAgentCredential.apiKey
                }
                label="Agent API key"
                description="This plaintext key is returned only once. Copy and store it securely before closing this dialog."
              />
            </div>
          ) : (
            <div className="admin-agents-create-form">
              <label htmlFor="admin-agent-team-leader">
                <span>
                  Team Leader
                </span>
                <select
                  id="admin-agent-team-leader"
                  value={
                    createTeamLeaderId
                  }
                  onChange={
                    event =>
                      setCreateTeamLeaderId(
                        event.target.value,
                      )
                  }
                  disabled={
                    createAgentMutation.isPending
                  }
                >
                  <option value="">
                    Select Team Leader
                  </option>

                  {teamLeaders.map(
                    teamLeader => (
                      <option
                        key={
                          teamLeader.id
                        }
                        value={
                          teamLeader.id
                        }
                      >
                        {teamLeader.name}
                      </option>
                    ),
                  )}
                </select>
              </label>

              <label htmlFor="admin-agent-name">
                <span>
                  Agent name
                </span>
                <input
                  id="admin-agent-name"
                  type="text"
                  maxLength={100}
                  value={createName}
                  placeholder="Mohamed Ali"
                  autoComplete="off"
                  disabled={
                    createAgentMutation.isPending
                  }
                  onChange={
                    event => {
                      setCreateName(
                        event.target.value,
                      );
                      setCreateError(null);
                    }
                  }
                />
              </label>

              <label htmlFor="admin-agent-email">
                <span>
                  Email
                  <small>
                    Optional
                  </small>
                </span>
                <input
                  id="admin-agent-email"
                  type="email"
                  maxLength={255}
                  value={createEmail}
                  placeholder="mohamed.ali@example.com"
                  autoComplete="email"
                  disabled={
                    createAgentMutation.isPending
                  }
                  onChange={
                    event => {
                      setCreateEmail(
                        event.target.value,
                      );
                      setCreateError(null);
                    }
                  }
                />
              </label>

              <label htmlFor="admin-agent-template-limit">
                <span>
                  Template send limit / 24h
                  <small>
                    Blank = unlimited
                  </small>
                </span>
                <input
                  id="admin-agent-template-limit"
                  type="number"
                  min={0}
                  step={1}
                  value={
                    createTemplateLimit
                  }
                  placeholder="Unlimited"
                  disabled={
                    createAgentMutation.isPending
                  }
                  onChange={
                    event => {
                      setCreateTemplateLimit(
                        event.target.value,
                      );
                      setCreateError(null);
                    }
                  }
                  onKeyDown={
                    event => {
                      if (
                        event.key === 'Enter' &&
                        canCreateAgent &&
                        !createAgentMutation.isPending
                      ) {
                        void createAgent();
                      }
                    }
                  }
                />
              </label>

              {trimmedCreateEmail &&
                !isValidEmail(
                  trimmedCreateEmail,
                ) && (
                  <p className="admin-agents-field-error">
                    Enter a valid email address or leave it blank.
                  </p>
                )}

              {!createTemplateLimitValid && (
                <p className="admin-agents-field-error">
                  Template limit must be a whole number greater than or equal to 0.
                </p>
              )}

              {createError && (
                <div
                  className="admin-agents-alert admin-agents-alert--error"
                  role="alert"
                >
                  <AlertCircle size={18} />
                  <div>
                    <strong>
                      Agent could not be created.
                    </strong>
                    <span>
                      {createError}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </Modal>
      )}

      {canManagePrincipals && (
        <AgentRetirementModal
          open={
            retiringAgentId !== null
          }
          agentId={
            retiringAgentId
          }
          onClose={() =>
            setRetiringAgentId(
              null,
            )
          }
          onRetired={
            retiredAgentId => {
              setSelectedAgentIds(
                previous => {
                  const next =
                    new Set(previous);
                  next.delete(
                    retiredAgentId,
                  );
                  return next;
                },
              );

              if (
                managedAgentId ===
                retiredAgentId
              ) {
                setManagedAgentId('');
              }

              setRetiringAgentId(
                null,
              );
            }
          }
        />
      )}

      {canManagePrincipals && (
        <Modal
          open={Boolean(managedAgent)}
          onClose={() => {
            if (!isMutating) {
              setManagedAgentId('');
            }
          }}
          title={
            managedAgent
              ? `Move ${managedAgent.name}`
              : 'Move Agent'
          }
          className="admin-agents-move-modal"
          hideCloseButton={isMutating}
          footer={
            managedAgent ? (
              <div className="admin-agents-modal-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() =>
                    setManagedAgentId('')
                  }
                  disabled={isMutating}
                >
                  Cancel
                </button>

                <button
                  type="button"
                  className="btn-primary"
                  onClick={() =>
                    void moveManagedAgent()
                  }
                  disabled={
                    !individualTargetTeamLeaderId ||
                    isMutating
                  }
                >
                  {reassignAgentMutation.isPending ? (
                    <Loader2
                      size={16}
                      className="animate-spin"
                    />
                  ) : (
                    <ArrowRightLeft size={16} />
                  )}
                  Move Agent
                </button>
              </div>
            ) : undefined
          }
        >
          {managedAgent && (
            <div className="admin-agents-move-form">
              <div className="admin-agents-current-owner">
                <span>
                  Current Team Leader
                </span>
                <strong>
                  {managedAgent.teamLeader.name}
                </strong>
                <code>
                  {managedAgent.teamLeaderId}
                </code>
              </div>

              <label className="admin-agents-form-field">
                <span>
                  New Team Leader
                </span>
                <select
                  value={individualTargetTeamLeaderId}
                  onChange={event =>
                    setIndividualTargetTeamLeaderId(
                      event.target.value,
                    )
                  }
                  disabled={isMutating}
                >
                  <option value="">
                    Select Team Leader
                  </option>
                  {teamLeaders
                    .filter(
                      teamLeader =>
                        teamLeader.id !==
                        managedAgent.teamLeaderId,
                    )
                    .map(
                      teamLeader => (
                        <option
                          key={teamLeader.id}
                          value={teamLeader.id}
                        >
                          {teamLeader.name}
                        </option>
                      ),
                    )}
                </select>
              </label>

              <label className="admin-agents-move-checkbox">
                <input
                  type="checkbox"
                  checked={individualUnassignSession}
                  onChange={event =>
                    setIndividualUnassignSession(
                      event.target.checked,
                    )
                  }
                  disabled={isMutating}
                />
                <span>
                  <strong>
                    Clear current Session assignment
                  </strong>
                  <small>
                    {managedAgent.assignedSessionId
                      ? `Currently assigned to ${managedAgent.assignedSessionId}. Keep this enabled unless that Session is already owned by the destination Team Leader.`
                      : 'This Agent currently has no Session assignment.'}
                  </small>
                </span>
              </label>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
