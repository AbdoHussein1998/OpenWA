import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from 'react';
import {
  AlertCircle,
  ArrowRightLeft,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Smartphone,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react';

import {
  Modal,
} from '../components/Modal';

import {
  TeamLeaderRetirementModal,
} from '../components/TeamLeaderRetirementModal';

import {
  PageHeader,
} from '../components/PageHeader';

import {
  GeneratedKeyField,
} from '../components/GeneratedKeyField';

import {
  useAdminTeamLeaderResourceSummaryQuery,
  useAdminTeamLeaderResourcesQuery,
  useAdminTeamLeadersQuery,
  useBulkReassignAdminAgentsMutation,
  useBulkReassignAdminSessionsMutation,
  useCreateAdminTeamLeaderMutation,
  useDeleteAdminTeamLeaderMutation,
  useForceDeleteAdminTeamLeaderMutation,
  useReassignAdminAgentMutation,
  useReassignAdminSessionMutation,
} from '../hooks/queries';

import {
  useDocumentTitle,
} from '../hooks/useDocumentTitle';

import {
  useToast,
} from '../hooks/useToast';

import type {
  AdminSessionOverview,
  TeamLeader,
} from '../services/api';

import './AdminTeamLeaders.css';

function errorMessage(
  error: unknown,
): string {
  return error instanceof Error
    ? error.message
    : 'Unexpected error';
}

function formatDateTime(
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

  return parsed.toLocaleDateString();
}

function matchesSearch(
  teamLeader: TeamLeader,
  searchTerm: string,
): boolean {
  if (!searchTerm) {
    return true;
  }

  return [
    teamLeader.name,
    teamLeader.email,
    teamLeader.id,
  ].some(
    value =>
      value
        ?.toLowerCase()
        .includes(
          searchTerm,
        ) ?? false,
  );
}


function sessionLabel(
  session: AdminSessionOverview,
): string {
  return `${session.name} (${session.status.replaceAll('_', ' ')})`;
}

export function AdminTeamLeaders() {
  useDocumentTitle(
    'Admin Team Leaders',
  );

  const toast =
    useToast();

  const teamLeadersQuery =
    useAdminTeamLeadersQuery();

  const resourceSummaryQuery =
    useAdminTeamLeaderResourceSummaryQuery();

  const createTeamLeaderMutation =
    useCreateAdminTeamLeaderMutation();

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
    createError,
    setCreateError,
  ] = useState<string | null>(null);

  const [
    createdCredential,
    setCreatedCredential,
  ] = useState<{
    name: string;
    apiKey: string;
  } | null>(null);

  const [
    managedTeamLeaderId,
    setManagedTeamLeaderId,
  ] = useState('');


  const [
    retirementTeamLeaderId,
    setRetirementTeamLeaderId,
  ] = useState<string | null>(null);

  const [
    deleteConfirmation,
    setDeleteConfirmation,
  ] = useState<
    'safe' | 'force' | null
  >(null);

  const [
    sessionTargetTeamLeaderId,
    setSessionTargetTeamLeaderId,
  ] = useState('');

  const [
    agentTargetTeamLeaderId,
    setAgentTargetTeamLeaderId,
  ] = useState('');

  const [
    selectedSessionIds,
    setSelectedSessionIds,
  ] = useState<Set<string>>(
    () => new Set(),
  );

  const [
    selectedAgentIds,
    setSelectedAgentIds,
  ] = useState<Set<string>>(
    () => new Set(),
  );

  const [
    unassignAgentSessions,
    setUnassignAgentSessions,
  ] = useState(true);

  const resourcesQuery =
    useAdminTeamLeaderResourcesQuery(
      managedTeamLeaderId,
      Boolean(managedTeamLeaderId),
    );

  const reassignSessionMutation =
    useReassignAdminSessionMutation();

  const bulkReassignSessionsMutation =
    useBulkReassignAdminSessionsMutation();

  const reassignAgentMutation =
    useReassignAdminAgentMutation();

  const bulkReassignAgentsMutation =
    useBulkReassignAdminAgentsMutation();

  const deleteTeamLeaderMutation =
    useDeleteAdminTeamLeaderMutation();

  const forceDeleteTeamLeaderMutation =
    useForceDeleteAdminTeamLeaderMutation();

  const teamLeaders =
    teamLeadersQuery.data ??
    [];

  const resourceSummary =
    resourceSummaryQuery.data;

  const resourceCountsByTeamLeaderId =
    useMemo(
      () =>
        new Map(
          (
            resourceSummary
              ?.teamLeaders ?? []
          ).map(
            counts => [
              counts.teamLeaderId,
              counts,
            ],
          ),
        ),
      [resourceSummary],
    );

  const normalizedSearch =
    search
      .trim()
      .toLowerCase();

  const filteredTeamLeaders =
    useMemo(
      () =>
        teamLeaders.filter(
          teamLeader =>
            matchesSearch(
              teamLeader,
              normalizedSearch,
            ),
        ),
      [
        teamLeaders,
        normalizedSearch,
      ],
    );

  const availableTargets =
    useMemo(
      () =>
        teamLeaders.filter(
          teamLeader =>
            teamLeader.id !==
            managedTeamLeaderId,
        ),
      [
        teamLeaders,
        managedTeamLeaderId,
      ],
    );

  useEffect(() => {
    if (!managedTeamLeaderId) {
      return;
    }

    const defaultTarget =
      teamLeaders.find(
        teamLeader =>
          teamLeader.id !==
          managedTeamLeaderId,
      )?.id ?? '';

    setSessionTargetTeamLeaderId(
      defaultTarget,
    );
    setAgentTargetTeamLeaderId(
      defaultTarget,
    );
    setSelectedSessionIds(
      new Set(),
    );
    setSelectedAgentIds(
      new Set(),
    );
    setUnassignAgentSessions(
      true,
    );
  }, [
    managedTeamLeaderId,
    teamLeaders,
  ]);

  const resources =
    resourcesQuery.data;

  const assignedSessionIds =
    useMemo(
      () =>
        new Set(
          resources?.agents
            .map(
              agent =>
                agent.assignedSessionId,
            )
            .filter(
              (
                sessionId,
              ): sessionId is string =>
                sessionId !== null,
            ) ?? [],
        ),
      [resources],
    );

  const trimmedCreateName =
    createName.trim();

  const trimmedCreateEmail =
    createEmail.trim();

  const canCreateTeamLeader =
    trimmedCreateName.length > 0 &&
    trimmedCreateName.length <= 100 &&
    (
      !trimmedCreateEmail ||
      isValidEmail(
        trimmedCreateEmail,
      )
    );

  const isMutating =
    reassignSessionMutation.isPending ||
    bulkReassignSessionsMutation.isPending ||
    reassignAgentMutation.isPending ||
    bulkReassignAgentsMutation.isPending ||
    deleteTeamLeaderMutation.isPending ||
    forceDeleteTeamLeaderMutation.isPending;

  const refresh =
    () => {
      void Promise.all([
        teamLeadersQuery.refetch(),
        resourceSummaryQuery.refetch(),
      ]);

      if (managedTeamLeaderId) {
        void resourcesQuery.refetch();
      }
    };

  const openCreateTeamLeader =
    () => {
      setCreateName('');
      setCreateEmail('');
      setCreateError(null);
      setCreatedCredential(null);
      setShowCreateModal(true);
    };

  const closeCreateTeamLeader =
    () => {
      if (
        createTeamLeaderMutation.isPending
      ) {
        return;
      }

      setShowCreateModal(false);
      setCreateName('');
      setCreateEmail('');
      setCreateError(null);
      setCreatedCredential(null);
    };

  const createTeamLeader =
    async () => {
      if (!canCreateTeamLeader) {
        return;
      }

      setCreateError(null);

      try {
        const created =
          await createTeamLeaderMutation.mutateAsync({
            name:
              trimmedCreateName,
            ...(trimmedCreateEmail
              ? {
                  email:
                    trimmedCreateEmail,
                }
              : {}),
          });

        setCreatedCredential({
          name:
            created.teamLeader.name,
          apiKey:
            created.apiKey,
        });

        toast.success(
          'Team Leader created',
          `${created.teamLeader.name} was created successfully.`,
        );
      } catch (error) {
        const message =
          errorMessage(error);

        setCreateError(
          message,
        );

        toast.error(
          'Team Leader creation failed',
          message,
        );
      }
    };

  const closeManagement =
    () => {
      if (isMutating) {
        return;
      }

      setDeleteConfirmation(null);
      setManagedTeamLeaderId('');
    };

  const toggleSessionSelection =
    (
      sessionId: string,
      checked: boolean,
    ) => {
      setSelectedSessionIds(
        previous => {
          const next =
            new Set(previous);

          if (checked) {
            next.add(sessionId);
          } else {
            next.delete(sessionId);
          }

          return next;
        },
      );
    };

  const toggleAgentSelection =
    (
      agentId: string,
      checked: boolean,
    ) => {
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

  const transferSession =
    async (
      sessionId: string,
    ) => {
      if (
        !managedTeamLeaderId ||
        !sessionTargetTeamLeaderId
      ) {
        return;
      }

      try {
        await reassignSessionMutation.mutateAsync({
          teamLeaderId:
            managedTeamLeaderId,
          sessionId,
          data: {
            targetTeamLeaderId:
              sessionTargetTeamLeaderId,
          },
        });

        setSelectedSessionIds(
          previous => {
            const next =
              new Set(previous);
            next.delete(sessionId);
            return next;
          },
        );

        toast.success(
          'Session transferred',
          'Session ownership was reassigned successfully.',
        );
      } catch (error) {
        toast.error(
          'Session transfer failed',
          errorMessage(error),
        );
      }
    };

  const transferSelectedSessions =
    async () => {
      if (
        !managedTeamLeaderId ||
        !sessionTargetTeamLeaderId ||
        selectedSessionIds.size === 0
      ) {
        return;
      }

      try {
        await bulkReassignSessionsMutation.mutateAsync({
          teamLeaderId:
            managedTeamLeaderId,
          data: {
            sessionIds: [
              ...selectedSessionIds,
            ],
            targetTeamLeaderId:
              sessionTargetTeamLeaderId,
          },
        });

        setSelectedSessionIds(
          new Set(),
        );

        toast.success(
          'Sessions transferred',
          'The selected Sessions were reassigned successfully.',
        );
      } catch (error) {
        toast.error(
          'Bulk Session transfer failed',
          errorMessage(error),
        );
      }
    };

  const transferAgent =
    async (
      agentId: string,
    ) => {
      if (!agentTargetTeamLeaderId) {
        return;
      }

      try {
        await reassignAgentMutation.mutateAsync({
          agentId,
          data: {
            targetTeamLeaderId:
              agentTargetTeamLeaderId,
            unassignSession:
              unassignAgentSessions,
          },
        });

        setSelectedAgentIds(
          previous => {
            const next =
              new Set(previous);
            next.delete(agentId);
            return next;
          },
        );

        toast.success(
          'Agent moved',
          'The Agent was reassigned successfully.',
        );
      } catch (error) {
        toast.error(
          'Agent reassignment failed',
          errorMessage(error),
        );
      }
    };

  const transferSelectedAgents =
    async () => {
      if (
        !agentTargetTeamLeaderId ||
        selectedAgentIds.size === 0
      ) {
        return;
      }

      try {
        await bulkReassignAgentsMutation.mutateAsync({
          agentIds: [
            ...selectedAgentIds,
          ],
          targetTeamLeaderId:
            agentTargetTeamLeaderId,
          unassignSession:
            unassignAgentSessions,
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

  const deleteManagedTeamLeader =
    async () => {
      if (
        !managedTeamLeaderId ||
        !resources?.canDelete
      ) {
        return;
      }

      try {
        await deleteTeamLeaderMutation.mutateAsync(
          managedTeamLeaderId,
        );

        toast.success(
          'Team Leader deleted',
          `${resources.teamLeader.name} was deleted successfully.`,
        );

        setDeleteConfirmation(null);
        setManagedTeamLeaderId('');
      } catch (error) {
        toast.error(
          'Team Leader deletion failed',
          errorMessage(error),
        );
      }
    };

  const forceDeleteManagedTeamLeader =
    async () => {
      if (
        !managedTeamLeaderId ||
        !resources
      ) {
        return;
      }

      try {
        const result =
          await forceDeleteTeamLeaderMutation.mutateAsync(
            managedTeamLeaderId,
          );

        toast.success(
          'Team Leader force deleted',
          `${result.teamLeaderName} and ${result.deletedSessionIds.length} Session${result.deletedSessionIds.length === 1 ? '' : 's'} / ${result.deletedAgentIds.length} Agent${result.deletedAgentIds.length === 1 ? '' : 's'} were permanently deleted.`,
        );

        setDeleteConfirmation(null);
        setManagedTeamLeaderId('');
      } catch (error) {
        toast.error(
          'Force deletion failed',
          errorMessage(error),
        );
      }
    };


  if (
    teamLeadersQuery.isLoading
  ) {
    return (
      <div className="admin-team-leaders-page">
        <div className="admin-team-leaders-loading">
          <Loader2
            size={32}
            className="animate-spin"
          />

          <span>
            Loading Team Leaders...
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-team-leaders-page">
      <PageHeader
        title="Team Leaders"
        subtitle="Inspect Team Leader resources, transfer ownership, and safely retire management principals."
        actions={
          <div className="admin-team-leaders-header-actions">
            <button
              type="button"
              className="admin-team-leaders-create-btn"
              onClick={
                openCreateTeamLeader
              }
              disabled={
                createTeamLeaderMutation.isPending
              }
            >
              <Plus size={17} />
              New Team Leader
            </button>

            <button
              type="button"
              className="btn-secondary"
              onClick={refresh}
              disabled={
                teamLeadersQuery.isFetching ||
                resourceSummaryQuery.isFetching ||
                isMutating
              }
            >
              <RefreshCw
                size={17}
                className={
                  teamLeadersQuery.isFetching ||
                  resourceSummaryQuery.isFetching
                    ? 'animate-spin'
                    : undefined
                }
              />

              Refresh
            </button>
          </div>
        }
      />

      {teamLeadersQuery.isError && (
        <div
          className="admin-team-leaders-alert admin-team-leaders-alert--error"
          role="alert"
        >
          <AlertCircle
            size={20}
          />

          <div>
            <strong>
              Team Leaders could not be loaded.
            </strong>

            <span>
              {errorMessage(
                teamLeadersQuery.error,
              )}
            </span>
          </div>

          <button
            type="button"
            className="btn-secondary"
            onClick={refresh}
            disabled={
              teamLeadersQuery.isFetching
            }
          >
            Retry
          </button>
        </div>
      )}

      {resourceSummaryQuery.isError && (
        <div
          className="admin-team-leaders-alert admin-team-leaders-alert--error"
          role="alert"
        >
          <AlertCircle size={20} />

          <div>
            <strong>
              Resource counts could not be loaded.
            </strong>

            <span>
              {errorMessage(
                resourceSummaryQuery.error,
              )}
            </span>
          </div>

          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              void resourceSummaryQuery.refetch()
            }
            disabled={
              resourceSummaryQuery.isFetching
            }
          >
            Retry counts
          </button>
        </div>
      )}

      <section
        className="admin-team-leaders-summary-grid"
        aria-label="Team Leader overview"
      >
        <article className="admin-team-leaders-summary-card">
          <div className="admin-team-leaders-summary-icon">
            <Users size={20} />
          </div>

          <div>
            <span className="admin-team-leaders-summary-label">
              Team Leaders
            </span>

            <strong className="admin-team-leaders-summary-value">
              {resourceSummaryQuery.isLoading
                ? '…'
                : resourceSummaryQuery.isError
                  ? teamLeaders.length
                  : resourceSummary?.totals.teamLeaderCount ??
                    teamLeaders.length}
            </strong>

            <span className="admin-team-leaders-summary-hint">
              Total Team Leader principals
            </span>
          </div>
        </article>

        <article className="admin-team-leaders-summary-card">
          <div className="admin-team-leaders-summary-icon">
            <Smartphone size={20} />
          </div>

          <div>
            <span className="admin-team-leaders-summary-label">
              Owned Sessions
            </span>

            <strong className="admin-team-leaders-summary-value">
              {resourceSummaryQuery.isLoading
                ? '…'
                : resourceSummaryQuery.isError
                  ? '—'
                  : resourceSummary?.totals.sessionCount ?? 0}
            </strong>

            <span className="admin-team-leaders-summary-hint">
              Sessions assigned to all Team Leaders
            </span>
          </div>
        </article>

        <article className="admin-team-leaders-summary-card">
          <div className="admin-team-leaders-summary-icon">
            <UserRound size={20} />
          </div>

          <div>
            <span className="admin-team-leaders-summary-label">
              Agents
            </span>

            <strong className="admin-team-leaders-summary-value">
              {resourceSummaryQuery.isLoading
                ? '…'
                : resourceSummaryQuery.isError
                  ? '—'
                  : resourceSummary?.totals.agentCount ?? 0}
            </strong>

            <span className="admin-team-leaders-summary-hint">
              Agents across all Team Leaders
            </span>
          </div>
        </article>

        <article className="admin-team-leaders-summary-card">
          <div className="admin-team-leaders-summary-icon">
            <ShieldAlert size={20} />
          </div>

          <div>
            <span className="admin-team-leaders-summary-label">
              Unassigned Sessions
            </span>

            <strong className="admin-team-leaders-summary-value">
              {resourceSummaryQuery.isLoading
                ? '…'
                : resourceSummaryQuery.isError
                  ? '—'
                  : resourceSummary?.totals.unassignedSessionCount ?? 0}
            </strong>

            <span className="admin-team-leaders-summary-hint">
              Team Leader-owned Sessions with no Agent
            </span>
          </div>
        </article>
      </section>

      <section className="admin-team-leaders-section">
        <div className="admin-team-leaders-toolbar">
          <div>
            <h2>
              Team Leader inventory
            </h2>

            <p>
              Open a Team Leader to inspect owned Sessions and Agents before transferring resources or deleting the principal.
            </p>
          </div>

          <label className="admin-team-leaders-search">
            <Search
              size={17}
              aria-hidden="true"
            />

            <span className="sr-only">
              Search Team Leaders
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
              placeholder="Search name, email or Team Leader id"
              autoComplete="off"
            />
          </label>
        </div>

        {teamLeaders.length === 0 ? (
          <div className="admin-team-leaders-empty-state">
            <div className="admin-team-leaders-empty-icon">
              <Users size={30} />
            </div>

            <h3>
              No Team Leaders yet
            </h3>

            <p>
              Team Leaders will appear here after an Admin or Operator creates them.
            </p>
          </div>
        ) : filteredTeamLeaders.length === 0 ? (
          <div className="admin-team-leaders-empty-state admin-team-leaders-empty-state--compact">
            <Search size={28} />

            <h3>
              No matching Team Leaders
            </h3>

            <p>
              Try another name, email address, or Team Leader id.
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
          <div className="admin-team-leaders-table-container">
            <table className="admin-team-leaders-table">
              <thead>
                <tr>
                  <th>Team Leader</th>
                  <th>Email</th>
                  <th>Sessions</th>
                  <th>Agents</th>
                  <th>Team Leader ID</th>
                  <th>Created</th>
                  <th>Updated</th>
                  <th className="admin-team-leaders-actions-heading">
                    Actions
                  </th>
                </tr>
              </thead>

              <tbody>
                {filteredTeamLeaders.map(
                  teamLeader => (
                    <tr key={teamLeader.id}>
                      <td data-label="Team Leader">
                        <div className="admin-team-leaders-name-cell">
                          <div className="admin-team-leaders-avatar">
                            <UserRound size={18} />
                          </div>

                          <div>
                            <strong>
                              {teamLeader.name}
                            </strong>

                            <span>
                              Primary identity
                            </span>
                          </div>
                        </div>
                      </td>

                      <td data-label="Email">
                        {teamLeader.email ? (
                          <a
                            className="admin-team-leaders-email"
                            href={`mailto:${teamLeader.email}`}
                          >
                            {teamLeader.email}
                          </a>
                        ) : (
                          <span className="admin-team-leaders-muted">
                            No email
                          </span>
                        )}
                      </td>

                      <td
                        data-label="Sessions"
                        className="admin-team-leaders-count-cell"
                      >
                        <span
                          className="admin-team-leaders-count-badge admin-team-leaders-count-badge--sessions"
                          title="Sessions owned by this Team Leader"
                        >
                          {resourceSummaryQuery.isLoading
                            ? '…'
                            : resourceSummaryQuery.isError
                              ? '—'
                              : resourceCountsByTeamLeaderId.get(
                                  teamLeader.id,
                                )?.sessionCount ?? 0}
                        </span>
                      </td>

                      <td
                        data-label="Agents"
                        className="admin-team-leaders-count-cell"
                      >
                        <span
                          className="admin-team-leaders-count-badge admin-team-leaders-count-badge--agents"
                          title="Agents assigned to this Team Leader"
                        >
                          {resourceSummaryQuery.isLoading
                            ? '…'
                            : resourceSummaryQuery.isError
                              ? '—'
                              : resourceCountsByTeamLeaderId.get(
                                  teamLeader.id,
                                )?.agentCount ?? 0}
                        </span>
                      </td>

                      <td data-label="Team Leader ID">
                        <code
                          className="admin-team-leaders-id"
                          title={teamLeader.id}
                        >
                          {teamLeader.id}
                        </code>
                      </td>

                      <td
                        data-label="Created"
                        className="admin-team-leaders-date"
                      >
                        <span
                          title={
                            formatDateTime(
                              teamLeader.createdAt,
                            )
                          }
                        >
                          {formatDate(
                            teamLeader.createdAt,
                          )}
                        </span>
                      </td>

                      <td
                        data-label="Updated"
                        className="admin-team-leaders-date"
                      >
                        <span
                          title={
                            formatDateTime(
                              teamLeader.updatedAt,
                            )
                          }
                        >
                          {formatDate(
                            teamLeader.updatedAt,
                          )}
                        </span>
                      </td>

                      <td
                        data-label="Actions"
                        className="admin-team-leaders-actions-cell"
                      >
                        <button
                          type="button"
                          className="admin-team-leaders-manage-btn"
                          onClick={() =>
                            setManagedTeamLeaderId(
                              teamLeader.id,
                            )
                          }
                        >
                          <ArrowRightLeft size={16} />
                          Manage resources
                        </button>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Modal
        open={showCreateModal}
        onClose={
          closeCreateTeamLeader
        }
        title={
          createdCredential
            ? 'Team Leader created'
            : 'Create Team Leader'
        }
        className="admin-team-leaders-create-modal"
        hideCloseButton={
          createTeamLeaderMutation.isPending
        }
        footer={
          createdCredential ? (
            <button
              type="button"
              className="btn-secondary"
              onClick={
                closeCreateTeamLeader
              }
            >
              Close
            </button>
          ) : (
            <div className="admin-team-leaders-create-modal-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={
                  closeCreateTeamLeader
                }
                disabled={
                  createTeamLeaderMutation.isPending
                }
              >
                Cancel
              </button>

              <button
                type="button"
                className="admin-team-leaders-create-btn"
                onClick={() =>
                  void createTeamLeader()
                }
                disabled={
                  !canCreateTeamLeader ||
                  createTeamLeaderMutation.isPending
                }
              >
                {createTeamLeaderMutation.isPending ? (
                  <Loader2
                    size={16}
                    className="animate-spin"
                  />
                ) : (
                  <Plus size={16} />
                )}
                Create Team Leader
              </button>
            </div>
          )
        }
      >
        {createdCredential ? (
          <div className="admin-team-leaders-created-credential">
            <div className="admin-team-leaders-created-credential-copy">
              <strong>
                {createdCredential.name}
              </strong>
              <span>
                The Team Leader and its credential were created together.
              </span>
            </div>

            <GeneratedKeyField
              value={
                createdCredential.apiKey
              }
              label="Team Leader API key"
              description="This plaintext key is returned only once. Copy and store it securely before closing this dialog."
            />
          </div>
        ) : (
          <div className="admin-team-leaders-create-form">
            <label htmlFor="new-team-leader-name">
              <span>Name</span>
              <input
                id="new-team-leader-name"
                type="text"
                value={createName}
                maxLength={100}
                autoComplete="off"
                placeholder="Ahmed Hassan"
                disabled={
                  createTeamLeaderMutation.isPending
                }
                onChange={event => {
                  setCreateName(
                    event.target.value,
                  );
                  setCreateError(null);
                }}
              />
            </label>

            <label htmlFor="new-team-leader-email">
              <span>
                Email
                <small>Optional</small>
              </span>
              <input
                id="new-team-leader-email"
                type="email"
                value={createEmail}
                maxLength={255}
                autoComplete="email"
                placeholder="ahmed.hassan@example.com"
                disabled={
                  createTeamLeaderMutation.isPending
                }
                onChange={event => {
                  setCreateEmail(
                    event.target.value,
                  );
                  setCreateError(null);
                }}
                onKeyDown={event => {
                  if (
                    event.key === 'Enter' &&
                    canCreateTeamLeader &&
                    !createTeamLeaderMutation.isPending
                  ) {
                    void createTeamLeader();
                  }
                }}
              />
            </label>

            {trimmedCreateEmail &&
              !isValidEmail(
                trimmedCreateEmail,
              ) && (
                <p className="admin-team-leaders-field-error">
                  Enter a valid email address or leave the field empty.
                </p>
              )}

            {createError && (
              <div
                className="admin-team-leaders-alert admin-team-leaders-alert--error"
                role="alert"
              >
                <AlertCircle size={18} />
                <div>
                  <strong>
                    Team Leader could not be created.
                  </strong>
                  <span>{createError}</span>
                </div>
              </div>
            )}

            <p className="admin-team-leaders-create-hint">
              A TEAM_LEADER API key will be created atomically with the principal and shown once after creation.
            </p>
          </div>
        )}
      </Modal>

      <div
        className="admin-team-leaders-note"
        role="note"
      >
        <ShieldAlert size={18} />

        <p>
          Normal deletion remains blocked until no Sessions or Agents remain. Force delete is available for administrators who explicitly want to permanently remove the Team Leader and every owned resource.
        </p>
      </div>

      <Modal
        open={Boolean(
          resources &&
          deleteConfirmation,
        )}
        onClose={() => {
          if (!isMutating) {
            setDeleteConfirmation(null);
          }
        }}
        title={
          deleteConfirmation === 'force'
            ? 'Force delete Team Leader'
            : 'Delete Team Leader'
        }
        className="admin-team-leaders-delete-confirm-modal"
        hideCloseButton={isMutating}
        footer={
          resources && deleteConfirmation ? (
            <div className="admin-team-leaders-delete-confirm-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() =>
                  setDeleteConfirmation(null)
                }
                disabled={isMutating}
              >
                Cancel
              </button>

              <button
                type="button"
                className={
                  deleteConfirmation === 'force'
                    ? 'admin-team-leaders-force-delete-confirm-btn'
                    : 'admin-team-leaders-delete-btn'
                }
                onClick={() =>
                  deleteConfirmation === 'force'
                    ? void forceDeleteManagedTeamLeader()
                    : void deleteManagedTeamLeader()
                }
                disabled={
                  isMutating ||
                  (
                    deleteConfirmation === 'safe' &&
                    !resources.canDelete
                  )
                }
              >
                {deleteTeamLeaderMutation.isPending ||
                forceDeleteTeamLeaderMutation.isPending ? (
                  <Loader2
                    size={16}
                    className="animate-spin"
                  />
                ) : deleteConfirmation === 'force' ? (
                  <ShieldAlert size={16} />
                ) : (
                  <Trash2 size={16} />
                )}
                {deleteConfirmation === 'force'
                  ? 'Permanently delete everything'
                  : 'Delete Team Leader'}
              </button>
            </div>
          ) : undefined
        }
      >
        {resources && deleteConfirmation && (
          <div className="admin-team-leaders-delete-confirm-content">
            <div
              className={
                deleteConfirmation === 'force'
                  ? 'admin-team-leaders-delete-confirm-icon admin-team-leaders-delete-confirm-icon--danger'
                  : 'admin-team-leaders-delete-confirm-icon'
              }
            >
              {deleteConfirmation === 'force' ? (
                <ShieldAlert size={28} />
              ) : (
                <Trash2 size={28} />
              )}
            </div>

            <div className="admin-team-leaders-delete-confirm-copy">
              <strong>
                {deleteConfirmation === 'force'
                  ? `Permanently delete ${resources.teamLeader.name} and all owned resources?`
                  : `Delete ${resources.teamLeader.name}?`}
              </strong>

              {deleteConfirmation === 'force' ? (
                <>
                  <p>
                    This operation uses the normal Session deletion lifecycle first, then removes every Agent, principal-bound API key, and the Team Leader itself. It cannot be undone.
                  </p>

                  <div className="admin-team-leaders-force-delete-summary">
                    <div>
                      <span>Sessions</span>
                      <strong>{resources.sessions.length}</strong>
                    </div>
                    <div>
                      <span>Agents</span>
                      <strong>{resources.agents.length}</strong>
                    </div>
                    <div>
                      <span>Team Leader</span>
                      <strong>1</strong>
                    </div>
                  </div>

                  <p className="admin-team-leaders-force-delete-warning">
                    WhatsApp Session records and their dependent data will be deleted, not transferred. Agent and Team Leader credentials will stop authenticating immediately after principal deletion.
                  </p>
                </>
              ) : (
                <p>
                  This Team Leader has no remaining Sessions or Agents. Its principal and TEAM_LEADER credential will be removed.
                </p>
              )}
            </div>
          </div>
        )}
      </Modal>

      <TeamLeaderRetirementModal
        open={retirementTeamLeaderId !== null}
        teamLeaderId={retirementTeamLeaderId}
        onClose={() =>
          setRetirementTeamLeaderId(null)
        }
        onRetired={() =>
          setRetirementTeamLeaderId(null)
        }
      />

      <Modal
        open={Boolean(managedTeamLeaderId) && deleteConfirmation === null}
        onClose={closeManagement}
        title={
          resources
            ? `Manage ${resources.teamLeader.name}`
            : 'Manage Team Leader resources'
        }
        className="admin-team-leaders-management-modal"
        hideCloseButton={isMutating}
        footer={
          resources ? (
            <div className="admin-team-leaders-modal-footer">
              <div>
                <strong>
                  {resources.canDelete
                    ? 'Ready to delete'
                    : 'Resources still assigned'}
                </strong>
                <span>
                  {resources.canDelete
                    ? 'No Sessions or Agents remain under this Team Leader.'
                    : `${resources.sessions.length} Session${resources.sessions.length === 1 ? '' : 's'} and ${resources.agents.length} Agent${resources.agents.length === 1 ? '' : 's'} remain.`}
                </span>
              </div>

              <div className="admin-team-leaders-delete-actions">
                <button
                  type="button"
                  className="admin-team-leaders-delete-btn"
                  onClick={() =>
                    setDeleteConfirmation(
                      'safe',
                    )
                  }
                  disabled={
                    !resources.canDelete ||
                    isMutating
                  }
                >
                  <Trash2 size={16} />
                  Delete Team Leader
                </button>

                {!resources.canDelete && (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => {
                      const id =
                        managedTeamLeaderId;

                      if (!id) {
                        return;
                      }

                      setManagedTeamLeaderId('');
                      setDeleteConfirmation(null);
                      setRetirementTeamLeaderId(id);
                    }}
                    disabled={isMutating}
                  >
                    <ArrowRightLeft size={16} />
                    Delegate all & delete
                  </button>
                )}

                <button
                  type="button"
                  className="admin-team-leaders-force-delete-btn"
                  onClick={() =>
                    setDeleteConfirmation(
                      'force',
                    )
                  }
                  disabled={isMutating}
                >
                  <ShieldAlert size={16} />
                  Force delete all
                </button>
              </div>
            </div>
          ) : undefined
        }
      >
        {resourcesQuery.isLoading ? (
          <div className="admin-team-leaders-modal-loading">
            <Loader2
              size={28}
              className="animate-spin"
            />
            Loading resource graph...
          </div>
        ) : resourcesQuery.isError ? (
          <div
            className="admin-team-leaders-alert admin-team-leaders-alert--error"
            role="alert"
          >
            <AlertCircle size={20} />
            <div>
              <strong>
                Resources could not be loaded.
              </strong>
              <span>
                {errorMessage(
                  resourcesQuery.error,
                )}
              </span>
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                void resourcesQuery.refetch()
              }
            >
              Retry
            </button>
          </div>
        ) : resources ? (
          <div className="admin-team-leaders-resource-stack">
            <section className="admin-team-leaders-resource-panel admin-team-leaders-resource-panel--sessions">
              <div className="admin-team-leaders-resource-header">
                <div>
                  <h3>
                    <Smartphone size={18} />
                    Sessions
                    <span>{resources.sessions.length}</span>
                  </h3>
                  <p>
                    Assigned Sessions must be unassigned from their Agents before ownership can be transferred.
                  </p>
                </div>

                <div className="admin-team-leaders-transfer-controls">
                  <label>
                    <span>Transfer to</span>
                    <select
                      value={sessionTargetTeamLeaderId}
                      onChange={event =>
                        setSessionTargetTeamLeaderId(
                          event.target.value,
                        )
                      }
                      disabled={
                        availableTargets.length === 0 ||
                        isMutating
                      }
                    >
                      {availableTargets.length === 0 ? (
                        <option value="">
                          No other Team Leader
                        </option>
                      ) : (
                        availableTargets.map(
                          teamLeader => (
                            <option
                              key={teamLeader.id}
                              value={teamLeader.id}
                            >
                              {teamLeader.name}
                            </option>
                          ),
                        )
                      )}
                    </select>
                  </label>

                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() =>
                      void transferSelectedSessions()
                    }
                    disabled={
                      selectedSessionIds.size === 0 ||
                      !sessionTargetTeamLeaderId ||
                      isMutating
                    }
                  >
                    {bulkReassignSessionsMutation.isPending ? (
                      <Loader2
                        size={16}
                        className="animate-spin"
                      />
                    ) : (
                      <ArrowRightLeft size={16} />
                    )}
                    Transfer selected ({selectedSessionIds.size})
                  </button>
                </div>
              </div>

              {resources.sessions.length === 0 ? (
                <div className="admin-team-leaders-resource-empty">
                  No Sessions are owned by this Team Leader.
                </div>
              ) : (
                <div className="admin-team-leaders-resource-list">
                  {resources.sessions.map(
                    session => {
                      const assigned =
                        assignedSessionIds.has(
                          session.id,
                        );

                      return (
                        <div
                          key={session.id}
                          className="admin-team-leaders-resource-row"
                        >
                          <label className="admin-team-leaders-resource-select">
                            <input
                              type="checkbox"
                              checked={
                                selectedSessionIds.has(
                                  session.id,
                                )
                              }
                              onChange={event =>
                                toggleSessionSelection(
                                  session.id,
                                  event.target.checked,
                                )
                              }
                              disabled={
                                assigned ||
                                isMutating
                              }
                            />
                            <span className="sr-only">
                              Select {session.name}
                            </span>
                          </label>

                          <div className="admin-team-leaders-resource-main">
                            <strong>
                              {sessionLabel(session)}
                            </strong>
                            <code title={session.id}>
                              {session.id}
                            </code>
                            {assigned && (
                              <span className="admin-team-leaders-resource-warning">
                                Assigned to an Agent — move/unassign the Agent first.
                              </span>
                            )}
                          </div>

                          <button
                            type="button"
                            className="admin-team-leaders-inline-action"
                            onClick={() =>
                              void transferSession(
                                session.id,
                              )
                            }
                            disabled={
                              assigned ||
                              !sessionTargetTeamLeaderId ||
                              isMutating
                            }
                          >
                            <ArrowRightLeft size={15} />
                            Transfer
                          </button>
                        </div>
                      );
                    },
                  )}
                </div>
              )}
            </section>

            <section className="admin-team-leaders-resource-panel admin-team-leaders-resource-panel--agents">
              <div className="admin-team-leaders-resource-header">
                <div>
                  <h3>
                    <Users size={18} />
                    Agents
                    <span>{resources.agents.length}</span>
                  </h3>
                  <p>
                    Moving an Agent can explicitly clear its Session assignment so the transfer cannot create an invalid cross-Team-Leader relationship.
                  </p>
                </div>

                <div className="admin-team-leaders-transfer-controls">
                  <label>
                    <span>Move to</span>
                    <select
                      value={agentTargetTeamLeaderId}
                      onChange={event =>
                        setAgentTargetTeamLeaderId(
                          event.target.value,
                        )
                      }
                      disabled={
                        availableTargets.length === 0 ||
                        isMutating
                      }
                    >
                      {availableTargets.length === 0 ? (
                        <option value="">
                          No other Team Leader
                        </option>
                      ) : (
                        availableTargets.map(
                          teamLeader => (
                            <option
                              key={teamLeader.id}
                              value={teamLeader.id}
                            >
                              {teamLeader.name}
                            </option>
                          ),
                        )
                      )}
                    </select>
                  </label>

                  <label className="admin-team-leaders-unassign-toggle">
                    <input
                      type="checkbox"
                      checked={unassignAgentSessions}
                      onChange={event =>
                        setUnassignAgentSessions(
                          event.target.checked,
                        )
                      }
                      disabled={isMutating}
                    />
                    Clear current Session assignment while moving
                  </label>

                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() =>
                      void transferSelectedAgents()
                    }
                    disabled={
                      selectedAgentIds.size === 0 ||
                      !agentTargetTeamLeaderId ||
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
                    Move selected ({selectedAgentIds.size})
                  </button>
                </div>
              </div>

              {resources.agents.length === 0 ? (
                <div className="admin-team-leaders-resource-empty">
                  No Agents belong to this Team Leader.
                </div>
              ) : (
                <div className="admin-team-leaders-resource-list">
                  {resources.agents.map(
                    agent => (
                      <div
                        key={agent.id}
                        className="admin-team-leaders-resource-row"
                      >
                        <label className="admin-team-leaders-resource-select">
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
                            disabled={isMutating}
                          />
                          <span className="sr-only">
                            Select {agent.name}
                          </span>
                        </label>

                        <div className="admin-team-leaders-resource-main">
                          <strong>
                            {agent.name}
                          </strong>
                          <span>
                            {agent.email ?? 'No email'}
                          </span>
                          <code title={agent.id}>
                            {agent.id}
                          </code>
                          {agent.assignedSessionId && (
                            <span className="admin-team-leaders-resource-warning">
                              Assigned Session: {agent.assignedSessionId}
                            </span>
                          )}
                        </div>

                        <button
                          type="button"
                          className="admin-team-leaders-inline-action"
                          onClick={() =>
                            void transferAgent(
                              agent.id,
                            )
                          }
                          disabled={
                            !agentTargetTeamLeaderId ||
                            isMutating
                          }
                        >
                          <ArrowRightLeft size={15} />
                          Move
                        </button>
                      </div>
                    ),
                  )}
                </div>
              )}
            </section>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
