import {
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  AlertCircle,
  ArrowRightLeft,
  Loader2,
  Trash2,
  UserRound,
} from 'lucide-react';

import {
  Modal,
} from './Modal';

import {
  useAdminAgentsQuery,
  useAssignAdminAgentSessionMutation,
  useDeleteAdminAgentMutation,
} from '../hooks/queries';

import {
  useToast,
} from '../hooks/useToast';

import './AgentRetirementModal.css';

interface AgentRetirementModalProps {
  open: boolean;
  agentId: string | null;
  onClose: () => void;
  onRetired?: (agentId: string) => void;
}

type RetirementMode =
  | 'leave-unassigned'
  | 'delegate-session';

function errorMessage(
  error: unknown,
): string {
  return error instanceof Error
    ? error.message
    : 'Unexpected error';
}

/**
 * Shared Agent-principal retirement workflow.
 *
 * This component is intentionally used by both:
 *
 * - the global Admin Agents page; and
 * - AGENT credential deletion from the API Keys page.
 *
 * Deleting an Agent principal deletes its bound AGENT credentials through the
 * backend principal lifecycle. The WhatsApp Session is not owned by the Agent,
 * so it is never deleted here.
 *
 * When an Agent has a Session assignment the caller may either:
 *
 * 1. delete the Agent and leave that Session unassigned under its current
 *    Team Leader; or
 * 2. delegate the Session to another Agent first. The backend assignment flow
 *    remains authoritative and will align Session.ownerTeamLeaderId with the
 *    destination Agent's Team Leader.
 */
export function AgentRetirementModal({
  open,
  agentId,
  onClose,
  onRetired,
}: AgentRetirementModalProps) {
  const toast =
    useToast();

  const agentsQuery =
    useAdminAgentsQuery(
      open && Boolean(agentId),
    );

  const assignSessionMutation =
    useAssignAdminAgentSessionMutation();

  const deleteAgentMutation =
    useDeleteAdminAgentMutation();

  const [
    mode,
    setMode,
  ] = useState<RetirementMode>(
    'leave-unassigned',
  );

  const [
    targetAgentId,
    setTargetAgentId,
  ] = useState('');

  const [
    operationError,
    setOperationError,
  ] = useState<string | null>(
    null,
  );

  const agents =
    agentsQuery.data ?? [];

  const agent =
    useMemo(
      () =>
        agents.find(
          item =>
            item.id === agentId,
        ) ?? null,
      [
        agentId,
        agents,
      ],
    );

  const candidates =
    useMemo(() => {
      if (!agent) {
        return [];
      }

      return agents
        .filter(
          item =>
            item.id !== agent.id &&
            item.assignedSessionId === null,
        )
        .sort(
          (left, right) => {
            const leftSameTeam =
              left.teamLeaderId ===
              agent.teamLeaderId;

            const rightSameTeam =
              right.teamLeaderId ===
              agent.teamLeaderId;

            if (
              leftSameTeam !==
              rightSameTeam
            ) {
              return leftSameTeam
                ? -1
                : 1;
            }

            return left.name.localeCompare(
              right.name,
            );
          },
        );
    }, [
      agent,
      agents,
    ]);

  useEffect(() => {
    if (!open) {
      return;
    }

    setMode(
      'leave-unassigned',
    );
    setOperationError(
      null,
    );

    if (!agent) {
      setTargetAgentId('');
      return;
    }

    const preferred =
      candidates.find(
        candidate =>
          candidate.teamLeaderId ===
          agent.teamLeaderId,
      ) ??
      candidates[0];

    setTargetAgentId(
      preferred?.id ?? '',
    );
  }, [
    open,
    agent,
    candidates,
  ]);

  const isBusy =
    assignSessionMutation.isPending ||
    deleteAgentMutation.isPending;

  const canDelegate =
    Boolean(
      agent?.assignedSessionId,
    ) &&
    candidates.length > 0;

  const canSubmit =
    Boolean(agent) &&
    (
      mode ===
        'leave-unassigned' ||
      (
        canDelegate &&
        Boolean(targetAgentId)
      )
    );

  const close =
    () => {
      if (isBusy) {
        return;
      }

      setOperationError(null);
      onClose();
    };

  const retire =
    async () => {
      if (
        !agent ||
        !canSubmit
      ) {
        return;
      }

      setOperationError(null);

      let delegated = false;

      try {
        if (
          mode ===
            'delegate-session' &&
          agent.assignedSessionId
        ) {
          await assignSessionMutation.mutateAsync({
            agentId:
              targetAgentId,
            data: {
              sessionId:
                agent.assignedSessionId,
            },
          });

          delegated = true;
        }

        await deleteAgentMutation.mutateAsync(
          agent.id,
        );

        onRetired?.(
          agent.id,
        );

        toast.success(
          'Agent deleted',
          delegated
            ? `${agent.name} was deleted after its Session was delegated successfully.`
            : `${agent.name} and its Agent credentials were deleted. The WhatsApp Session was preserved.`,
        );

        onClose();
      } catch (error) {
        const message =
          errorMessage(error);

        setOperationError(
          delegated
            ? `The Session was delegated, but deleting the Agent failed: ${message}`
            : message,
        );

        toast.error(
          'Agent deletion failed',
          delegated
            ? 'The Session delegation succeeded but the Agent could not be deleted. Review the updated Agent list before retrying.'
            : message,
        );
      }
    };

  return (
    <Modal
      open={open}
      onClose={close}
      title={
        agent
          ? `Delete ${agent.name}`
          : 'Delete Agent'
      }
      className="agent-retirement-modal"
      hideCloseButton={isBusy}
      closeLabel="Close"
      footer={
        agent ? (
          <div className="agent-retirement-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={close}
              disabled={isBusy}
            >
              Cancel
            </button>

            <button
              type="button"
              className="btn-danger"
              onClick={() =>
                void retire()
              }
              disabled={
                !canSubmit ||
                isBusy
              }
            >
              {isBusy ? (
                <Loader2
                  size={16}
                  className="animate-spin"
                />
              ) : (
                <Trash2 size={16} />
              )}
              Delete Agent
            </button>
          </div>
        ) : undefined
      }
    >
      {agentsQuery.isLoading ? (
        <div className="agent-retirement-loading">
          <Loader2
            size={28}
            className="animate-spin"
          />
          Loading Agent resources...
        </div>
      ) : agentsQuery.isError ? (
        <div
          className="agent-retirement-error"
          role="alert"
        >
          <AlertCircle size={20} />
          <div>
            <strong>
              Agent data could not be loaded.
            </strong>
            <span>
              {errorMessage(
                agentsQuery.error,
              )}
            </span>
          </div>
        </div>
      ) : !agent ? (
        <div
          className="agent-retirement-error"
          role="status"
        >
          <AlertCircle size={20} />
          <div>
            <strong>
              Agent no longer exists.
            </strong>
            <span>
              The principal may already have been deleted or changed.
            </span>
          </div>
        </div>
      ) : (
        <div className="agent-retirement-content">
          <div className="agent-retirement-summary">
            <div className="agent-retirement-avatar">
              <UserRound size={21} />
            </div>

            <div>
              <strong>
                {agent.name}
              </strong>
              <span>
                {agent.email ??
                  'No email'}
              </span>
              <code>
                {agent.id}
              </code>
            </div>
          </div>

          <div className="agent-retirement-resource-grid">
            <div>
              <span>
                Team Leader
              </span>
              <strong>
                {agent.teamLeader.name}
              </strong>
            </div>

            <div>
              <span>
                Session
              </span>
              <strong>
                {agent.assignedSession
                  ?.name ??
                  (
                    agent.assignedSessionId
                      ? 'Assigned Session'
                      : 'Unassigned'
                  )}
              </strong>
            </div>
          </div>

          {agent.assignedSessionId ? (
            <div className="agent-retirement-options">
              <button
                type="button"
                className={
                  mode ===
                  'leave-unassigned'
                    ? 'agent-retirement-option agent-retirement-option--active'
                    : 'agent-retirement-option'
                }
                onClick={() =>
                  setMode(
                    'leave-unassigned',
                  )
                }
                disabled={isBusy}
              >
                <strong>
                  Delete Agent only
                </strong>
                <span>
                  Preserve the WhatsApp Session under {agent.teamLeader.name}, but leave it without an Agent assignment.
                </span>
              </button>

              <button
                type="button"
                className={
                  mode ===
                  'delegate-session'
                    ? 'agent-retirement-option agent-retirement-option--active'
                    : 'agent-retirement-option'
                }
                onClick={() =>
                  setMode(
                    'delegate-session',
                  )
                }
                disabled={
                  !canDelegate ||
                  isBusy
                }
              >
                <strong>
                  Delegate Session, then delete
                </strong>
                <span>
                  Assign the Session to another Agent first, then remove this Agent principal and its credentials.
                </span>
              </button>

              {mode ===
                'delegate-session' && (
                <label className="agent-retirement-target">
                  <span>
                    Destination Agent
                  </span>

                  <select
                    value={
                      targetAgentId
                    }
                    onChange={
                      event =>
                        setTargetAgentId(
                          event.target.value,
                        )
                    }
                    disabled={
                      isBusy ||
                      candidates.length === 0
                    }
                  >
                    <option value="">
                      Select an Agent
                    </option>

                    {candidates.map(
                      candidate => (
                        <option
                          key={
                            candidate.id
                          }
                          value={
                            candidate.id
                          }
                        >
                          {candidate.name}
                          {' · '}
                          {candidate.teamLeader.name}
                        </option>
                      ),
                    )}
                  </select>

                  <small>
                    Only currently unassigned Agents are offered here. If the destination belongs to another Team Leader, the backend will move Session ownership to that Team Leader as part of the assignment.
                  </small>
                </label>
              )}
            </div>
          ) : (
            <div className="agent-retirement-note">
              This Agent has no Session assignment. Deleting it removes only the Agent principal and its AGENT credentials.
            </div>
          )}

          {operationError && (
            <div
              className="agent-retirement-error"
              role="alert"
            >
              <AlertCircle size={19} />
              <div>
                <strong>
                  Operation did not complete.
                </strong>
                <span>
                  {operationError}
                </span>
              </div>
            </div>
          )}

          <div className="agent-retirement-warning">
            <Trash2 size={18} />
            <p>
              The Agent principal and all AGENT credentials bound to it will be permanently deleted. The WhatsApp Session itself is never deleted by this workflow.
            </p>
          </div>
        </div>
      )}
    </Modal>
  );
}
