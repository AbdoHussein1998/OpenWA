import {
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  Loader2,
  Trash2,
  Users,
  Smartphone,
} from 'lucide-react';

import {
  useAdminTeamLeaderResourcesQuery,
  useAdminTeamLeadersQuery,
  useDeleteAdminTeamLeaderMutation,
  useForceDeleteAdminTeamLeaderMutation,
  useRetireAdminTeamLeaderMutation,
} from '../hooks/queries';
import { useToast } from '../hooks/useToast';
import { Modal } from './Modal';

interface TeamLeaderRetirementModalProps {
  open: boolean;
  teamLeaderId: string | null;
  onClose: () => void;
  onRetired?: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Unexpected error';
}

export function TeamLeaderRetirementModal({
  open,
  teamLeaderId,
  onClose,
  onRetired,
}: TeamLeaderRetirementModalProps) {
  const toast = useToast();

  const resourcesQuery =
    useAdminTeamLeaderResourcesQuery(
      teamLeaderId ?? '',
      open && Boolean(teamLeaderId),
    );

  const teamLeadersQuery =
    useAdminTeamLeadersQuery(open);

  const retireMutation =
    useRetireAdminTeamLeaderMutation();

  const forceDeleteMutation =
    useForceDeleteAdminTeamLeaderMutation();

  const safeDeleteMutation =
    useDeleteAdminTeamLeaderMutation();

  const [targetTeamLeaderId, setTargetTeamLeaderId] =
    useState('');

  const resources = resourcesQuery.data;

  const availableTargets = useMemo(
    () =>
      (teamLeadersQuery.data ?? []).filter(
        teamLeader => teamLeader.id !== teamLeaderId,
      ),
    [teamLeadersQuery.data, teamLeaderId],
  );

  useEffect(() => {
    if (!open) {
      setTargetTeamLeaderId('');
      return;
    }

    setTargetTeamLeaderId(current => {
      if (
        current &&
        availableTargets.some(
          teamLeader => teamLeader.id === current,
        )
      ) {
        return current;
      }

      return availableTargets[0]?.id ?? '';
    });
  }, [open, availableTargets]);

  const isPending =
    retireMutation.isPending ||
    forceDeleteMutation.isPending ||
    safeDeleteMutation.isPending;

  const close = () => {
    if (!isPending) {
      onClose();
    }
  };

  const finish = () => {
    onRetired?.();
    onClose();
  };

  const delegateAndDelete = async () => {
    if (
      !teamLeaderId ||
      !resources ||
      !targetTeamLeaderId
    ) {
      return;
    }

    const ownedSessionIds = new Set(
      resources.sessions.map(session => session.id),
    );

    try {
      const result = await retireMutation.mutateAsync({
        teamLeaderId,
        data: {
          sessionReassignments: resources.sessions.map(
            session => ({
              sessionId: session.id,
              targetTeamLeaderId,
            }),
          ),
          agentReassignments: resources.agents.map(
            agent => ({
              agentId: agent.id,
              targetTeamLeaderId,
              /**
               * Preserve an Agent↔Session assignment when the Session is part
               * of the same retirement graph. Clear only stale/external
               * assignments that cannot safely move with the principal.
               */
              unassignSession:
                agent.assignedSessionId !== null &&
                !ownedSessionIds.has(agent.assignedSessionId),
            }),
          ),
        },
      });

      toast.success(
        'Team Leader retired',
        `${result.teamLeaderName} was deleted after delegating ${result.delegatedSessionIds.length} Session${result.delegatedSessionIds.length === 1 ? '' : 's'} and ${result.delegatedAgentIds.length} Agent${result.delegatedAgentIds.length === 1 ? '' : 's'}.`,
      );

      finish();
    } catch (error) {
      toast.error(
        'Team Leader retirement failed',
        errorMessage(error),
      );
    }
  };

  const forceDelete = async () => {
    if (!teamLeaderId || !resources) {
      return;
    }

    try {
      const result =
        await forceDeleteMutation.mutateAsync(teamLeaderId);

      toast.success(
        'Team Leader force-deleted',
        `${result.teamLeaderName} and all owned resources were permanently deleted.`,
      );

      finish();
    } catch (error) {
      toast.error(
        'Force deletion failed',
        errorMessage(error),
      );
    }
  };

  const safeDelete = async () => {
    if (!teamLeaderId || !resources?.canDelete) {
      return;
    }

    try {
      await safeDeleteMutation.mutateAsync(teamLeaderId);

      toast.success(
        'Team Leader deleted',
        `${resources.teamLeader.name} was deleted successfully.`,
      );

      finish();
    } catch (error) {
      toast.error(
        'Team Leader deletion failed',
        errorMessage(error),
      );
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      hideCloseButton={isPending}
      className="team-leader-retirement-modal"
      title={
        resources
          ? `Retire ${resources.teamLeader.name}`
          : 'Retire Team Leader'
      }
      footer={
        resources ? (
          <div
            style={{
              width: '100%',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '0.75rem',
              flexWrap: 'wrap',
            }}
          >
            <button
              type="button"
              className="btn-secondary"
              onClick={close}
              disabled={isPending}
            >
              Cancel
            </button>

            <div
              style={{
                display: 'flex',
                gap: '0.65rem',
                flexWrap: 'wrap',
                justifyContent: 'flex-end',
              }}
            >
              {resources.canDelete ? (
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => void safeDelete()}
                  disabled={isPending}
                >
                  {safeDeleteMutation.isPending ? (
                    <Loader2
                      size={16}
                      className="animate-spin"
                    />
                  ) : (
                    <Trash2 size={16} />
                  )}
                  Delete Team Leader
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => void delegateAndDelete()}
                    disabled={
                      isPending ||
                      !targetTeamLeaderId ||
                      availableTargets.length === 0
                    }
                  >
                    {retireMutation.isPending ? (
                      <Loader2
                        size={16}
                        className="animate-spin"
                      />
                    ) : (
                      <ArrowRightLeft size={16} />
                    )}
                    Delegate all & delete
                  </button>

                  <button
                    type="button"
                    className="btn-danger"
                    onClick={() => void forceDelete()}
                    disabled={isPending}
                  >
                    {forceDeleteMutation.isPending ? (
                      <Loader2
                        size={16}
                        className="animate-spin"
                      />
                    ) : (
                      <Trash2 size={16} />
                    )}
                    Force delete all
                  </button>
                </>
              )}
            </div>
          </div>
        ) : undefined
      }
    >
      {resourcesQuery.isLoading ? (
        <div
          style={{
            minHeight: 220,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.75rem',
          }}
        >
          <Loader2
            size={28}
            className="animate-spin"
          />
          Loading Team Leader resources...
        </div>
      ) : resourcesQuery.isError ? (
        <div
          role="alert"
          className="error-banner"
        >
          <AlertTriangle size={20} />
          <span className="error-banner-text">
            {errorMessage(resourcesQuery.error)}
          </span>
        </div>
      ) : resources ? (
        <div
          style={{
            display: 'grid',
            gap: '1rem',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: '0.75rem',
            }}
          >
            <div
              style={{
                padding: '0.9rem',
                border: '1px solid var(--border)',
                borderRadius: 10,
                background: 'var(--bg-light)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.45rem',
                  color: 'var(--text-secondary)',
                }}
              >
                <Smartphone size={17} />
                Sessions
              </div>
              <strong
                style={{
                  display: 'block',
                  marginTop: '0.35rem',
                  fontSize: '1.5rem',
                  color: 'var(--text-primary)',
                }}
              >
                {resources.sessions.length}
              </strong>
            </div>

            <div
              style={{
                padding: '0.9rem',
                border: '1px solid var(--border)',
                borderRadius: 10,
                background: 'var(--bg-light)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.45rem',
                  color: 'var(--text-secondary)',
                }}
              >
                <Users size={17} />
                Agents
              </div>
              <strong
                style={{
                  display: 'block',
                  marginTop: '0.35rem',
                  fontSize: '1.5rem',
                  color: 'var(--text-primary)',
                }}
              >
                {resources.agents.length}
              </strong>
            </div>
          </div>

          {!resources.canDelete && (
            <>
              <div
                style={{
                  padding: '0.85rem 1rem',
                  border: '1px solid rgba(245, 158, 11, 0.28)',
                  borderRadius: 10,
                  background: 'rgba(245, 158, 11, 0.08)',
                  color: 'var(--text-secondary)',
                  fontSize: '0.82rem',
                  lineHeight: 1.5,
                }}
              >
                <strong
                  style={{
                    display: 'block',
                    marginBottom: '0.25rem',
                    color: 'var(--text-primary)',
                  }}
                >
                  Choose how to retire this principal
                </strong>
                Delegate moves all owned Sessions and Agents to another Team
                Leader, preserves compatible Agent↔Session assignments, and
                then deletes this Team Leader. Force delete permanently removes
                the Team Leader and all owned resources.
              </div>

              <label
                style={{
                  display: 'grid',
                  gap: '0.4rem',
                }}
              >
                <span
                  style={{
                    fontSize: '0.78rem',
                    fontWeight: 700,
                    color: 'var(--text-primary)',
                  }}
                >
                  Delegate all resources to
                </span>
                <select
                  value={targetTeamLeaderId}
                  onChange={event =>
                    setTargetTeamLeaderId(event.target.value)
                  }
                  disabled={isPending || teamLeadersQuery.isLoading}
                >
                  {availableTargets.length === 0 ? (
                    <option value="">
                      No other Team Leader available
                    </option>
                  ) : (
                    availableTargets.map(teamLeader => (
                      <option
                        key={teamLeader.id}
                        value={teamLeader.id}
                      >
                        {teamLeader.name}
                        {teamLeader.email
                          ? ` · ${teamLeader.email}`
                          : ''}
                      </option>
                    ))
                  )}
                </select>
              </label>
            </>
          )}

          {resources.sessions.length > 0 && (
            <div>
              <strong
                style={{
                  color: 'var(--text-primary)',
                  fontSize: '0.82rem',
                }}
              >
                Sessions
              </strong>
              <div
                style={{
                  marginTop: '0.45rem',
                  display: 'grid',
                  gap: '0.35rem',
                  maxHeight: 140,
                  overflowY: 'auto',
                }}
              >
                {resources.sessions.map(session => (
                  <div
                    key={session.id}
                    style={{
                      padding: '0.55rem 0.65rem',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      background: 'var(--bg-light)',
                    }}
                  >
                    <strong
                      style={{
                        color: 'var(--text-primary)',
                        fontSize: '0.78rem',
                      }}
                    >
                      {session.name}
                    </strong>
                    <span
                      style={{
                        display: 'block',
                        marginTop: '0.15rem',
                        color: 'var(--text-muted)',
                        fontSize: '0.7rem',
                      }}
                    >
                      {session.status.replaceAll('_', ' ')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {resources.agents.length > 0 && (
            <div>
              <strong
                style={{
                  color: 'var(--text-primary)',
                  fontSize: '0.82rem',
                }}
              >
                Agents
              </strong>
              <div
                style={{
                  marginTop: '0.45rem',
                  display: 'grid',
                  gap: '0.35rem',
                  maxHeight: 140,
                  overflowY: 'auto',
                }}
              >
                {resources.agents.map(agent => (
                  <div
                    key={agent.id}
                    style={{
                      padding: '0.55rem 0.65rem',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      background: 'var(--bg-light)',
                    }}
                  >
                    <strong
                      style={{
                        color: 'var(--text-primary)',
                        fontSize: '0.78rem',
                      }}
                    >
                      {agent.name}
                    </strong>
                    <span
                      style={{
                        display: 'block',
                        marginTop: '0.15rem',
                        color: 'var(--text-muted)',
                        fontSize: '0.7rem',
                      }}
                    >
                      {agent.assignedSessionId
                        ? `Assigned Session: ${agent.assignedSessionId}`
                        : 'No Session assignment'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </Modal>
  );
}


