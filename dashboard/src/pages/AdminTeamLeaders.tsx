import {
  useMemo,
  useState,
  type ChangeEvent,
} from 'react';
import {
  AlertCircle,
  Loader2,
  Mail,
  RefreshCw,
  Search,
  UserRound,
  Users,
} from 'lucide-react';

import {
  PageHeader,
} from '../components/PageHeader';

import {
  useAdminTeamLeadersQuery,
} from '../hooks/queries';

import {
  useDocumentTitle,
} from '../hooks/useDocumentTitle';

import type {
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

function wasCreatedInLastThirtyDays(
  teamLeader: TeamLeader,
): boolean {
  const createdAt =
    new Date(
      teamLeader.createdAt,
    );

  if (
    Number.isNaN(
      createdAt.getTime(),
    )
  ) {
    return false;
  }

  const thirtyDaysAgo =
    Date.now() -
    30 *
      24 *
      60 *
      60 *
      1000;

  return (
    createdAt.getTime() >=
    thirtyDaysAgo
  );
}

export function AdminTeamLeaders() {
  useDocumentTitle(
    'Admin Team Leaders',
  );

  const teamLeadersQuery =
    useAdminTeamLeadersQuery();

  const [
    search,
    setSearch,
  ] =
    useState('');

  const teamLeaders =
    teamLeadersQuery.data ??
    [];

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

  const withEmailCount =
    teamLeaders.filter(
      teamLeader =>
        Boolean(
          teamLeader.email,
        ),
    ).length;

  const withoutEmailCount =
    teamLeaders.length -
    withEmailCount;

  const recentCount =
    teamLeaders.filter(
      wasCreatedInLastThirtyDays,
    ).length;

  const refresh =
    () => {
      void teamLeadersQuery.refetch();
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
        subtitle="View every Team Leader principal managed by the OpenWA administration layer."
        actions={
          <button
            type="button"
            className="btn-secondary"
            onClick={
              refresh
            }
            disabled={
              teamLeadersQuery.isFetching
            }
          >
            <RefreshCw
              size={17}
              className={
                teamLeadersQuery.isFetching
                  ? 'animate-spin'
                  : undefined
              }
            />

            Refresh
          </button>
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
            onClick={
              refresh
            }
            disabled={
              teamLeadersQuery.isFetching
            }
          >
            Retry
          </button>
        </div>
      )}

      <section
        className="admin-team-leaders-summary-grid"
        aria-label="Team Leader overview"
      >
        <article className="admin-team-leaders-summary-card">
          <div className="admin-team-leaders-summary-icon">
            <Users
              size={20}
            />
          </div>

          <div>
            <span className="admin-team-leaders-summary-label">
              Team Leaders
            </span>

            <strong className="admin-team-leaders-summary-value">
              {teamLeaders.length}
            </strong>

            <span className="admin-team-leaders-summary-hint">
              Total management principals
            </span>
          </div>
        </article>

        <article className="admin-team-leaders-summary-card">
          <div className="admin-team-leaders-summary-icon">
            <Mail
              size={20}
            />
          </div>

          <div>
            <span className="admin-team-leaders-summary-label">
              With email
            </span>

            <strong className="admin-team-leaders-summary-value">
              {withEmailCount}
            </strong>

            <span className="admin-team-leaders-summary-hint">
              Optional email is configured
            </span>
          </div>
        </article>

        <article className="admin-team-leaders-summary-card">
          <div className="admin-team-leaders-summary-icon">
            <UserRound
              size={20}
            />
          </div>

          <div>
            <span className="admin-team-leaders-summary-label">
              Name only
            </span>

            <strong className="admin-team-leaders-summary-value">
              {withoutEmailCount}
            </strong>

            <span className="admin-team-leaders-summary-hint">
              No email configured
            </span>
          </div>
        </article>

        <article className="admin-team-leaders-summary-card">
          <div className="admin-team-leaders-summary-icon">
            <RefreshCw
              size={20}
            />
          </div>

          <div>
            <span className="admin-team-leaders-summary-label">
              New in 30 days
            </span>

            <strong className="admin-team-leaders-summary-value">
              {recentCount}
            </strong>

            <span className="admin-team-leaders-summary-hint">
              Recently created principals
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
              Name is the primary identity. Email is optional and is shown only as secondary contact metadata.
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
              value={
                search
              }
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

        {teamLeaders.length ===
        0 ? (
          <div className="admin-team-leaders-empty-state">
            <div className="admin-team-leaders-empty-icon">
              <Users
                size={30}
              />
            </div>

            <h3>
              No Team Leaders yet
            </h3>

            <p>
              Team Leaders will appear here after an Admin creates them.
            </p>
          </div>
        ) : filteredTeamLeaders.length ===
          0 ? (
          <div className="admin-team-leaders-empty-state admin-team-leaders-empty-state--compact">
            <Search
              size={28}
            />

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
                setSearch(
                  '',
                )
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
                  <th>
                    Team Leader
                  </th>

                  <th>
                    Email
                  </th>

                  <th>
                    Team Leader ID
                  </th>

                  <th>
                    Created
                  </th>

                  <th>
                    Updated
                  </th>
                </tr>
              </thead>

              <tbody>
                {filteredTeamLeaders.map(
                  teamLeader => (
                    <tr
                      key={
                        teamLeader.id
                      }
                    >
                      <td
                        data-label="Team Leader"
                      >
                        <div className="admin-team-leaders-name-cell">
                          <div className="admin-team-leaders-avatar">
                            <UserRound
                              size={18}
                            />
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

                      <td
                        data-label="Email"
                      >
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
                        data-label="Team Leader ID"
                      >
                        <code
                          className="admin-team-leaders-id"
                          title={
                            teamLeader.id
                          }
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
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div
        className="admin-team-leaders-note"
        role="note"
      >
        <AlertCircle
          size={18}
        />

        <p>
          Team Leader retirement is intentionally not exposed here yet. The retirement workflow should be added after the backend supports explicit reassignment or delete-all behavior.
        </p>
      </div>
    </div>
  );
}
