import {
  useMemo,
  useState,
  type ChangeEvent,
} from 'react';
import {
  useNavigate,
} from 'react-router-dom';
import {
  AlertCircle,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  Smartphone,
  UserRound,
  Users,
  Wifi,
} from 'lucide-react';

import {
  PageHeader,
} from '../components/PageHeader';

import {
  useAdminAgentsQuery,
} from '../hooks/queries';

import {
  useDocumentTitle,
} from '../hooks/useDocumentTitle';

import type {
  AdminAgentOverview,
} from '../services/api';

import './AdminAgents.css';

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

  const agentsQuery =
    useAdminAgentsQuery();

  const [
    search,
    setSearch,
  ] =
    useState('');

  const agents =
    agentsQuery.data ??
    [];

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

  const refresh =
    () => {
      void agentsQuery.refetch();
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
        subtitle="View every Agent across Team Leaders together with its current WhatsApp session assignment and status."
        actions={
          <button
            type="button"
            className="btn-secondary"
            onClick={
              refresh
            }
            disabled={
              agentsQuery.isFetching
            }
          >
            <RefreshCw
              size={17}
              className={
                agentsQuery.isFetching
                  ? 'animate-spin'
                  : undefined
              }
            />

            Refresh
          </button>
        }
      />

      {agentsQuery.isError && (
        <div
          className="admin-agents-alert admin-agents-alert--error"
          role="alert"
        >
          <AlertCircle
            size={20}
          />

          <div>
            <strong>
              Agents could not be loaded.
            </strong>

            <span>
              {errorMessage(
                agentsQuery.error,
              )}
            </span>
          </div>

          <button
            type="button"
            className="btn-secondary"
            onClick={
              refresh
            }
            disabled={
              agentsQuery.isFetching
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
            <Users
              size={20}
            />
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
            <Smartphone
              size={20}
            />
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
            <UserRound
              size={20}
            />
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
            <Wifi
              size={20}
            />
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
              Session assignment remains owned by the Team Leader workflow; this Admin page provides a global operational view.
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
              value={
                search
              }
              onChange={
                (event: ChangeEvent<HTMLInputElement>) =>
                  setSearch(
                    event.target.value,
                  )
              }
              placeholder="Search Agent, Team Leader, Session or phone"
              autoComplete="off"
            />
          </label>
        </div>

        {agents.length === 0 ? (
          <div className="admin-agents-empty-state">
            <div className="admin-agents-empty-icon">
              <Users
                size={30}
              />
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
            <Search
              size={28}
            />

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
                setSearch(
                  '',
                )
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
                  <th>
                    Agent
                  </th>

                  <th>
                    Team Leader
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
                    Template quota
                  </th>

                  <th>
                    Created
                  </th>

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
                      <tr
                        key={
                          agent.id
                        }
                      >
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
                            {new Date(
                              agent.createdAt,
                            ).toLocaleDateString()}
                          </span>
                        </td>

                        <td>
                          <div className="admin-agents-row-actions">
                            {session ? (
                              <>
                                <button
                                  type="button"
                                  className="admin-agents-action-btn"
                                  onClick={
                                    openSession
                                  }
                                  title="Open Sessions"
                                >
                                  <Smartphone
                                    size={16}
                                  />

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
                                  <ExternalLink
                                    size={16}
                                  />

                                  Chats
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="admin-agents-action-btn"
                                onClick={
                                  openSession
                                }
                              >
                                <Smartphone
                                  size={16}
                                />

                                Sessions
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
    </div>
  );
}
