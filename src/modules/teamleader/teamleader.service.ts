



import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  InjectDataSource,
  InjectRepository,
} from '@nestjs/typeorm';
import {
  DataSource,
  In,
  QueryFailedError,
  Repository,
} from 'typeorm';

import {
  ApiKey,
  ApiKeyRole,
} from '../auth/entities/api-key.entity';
import { AuthService } from '../auth/auth.service';

import { Session } from '../session/entities/session.entity';

import {
  EventsGateway,
  type ApiKeyEvictionReason,
} from '../events/events.gateway';

import { createLogger } from '../../common/services/logger.service';

import { TeamLeader } from './entities/team-leader.entity';
import { Agent } from './entities/agent.entity';

import { CreateTeamLeaderDto } from './dto/create-team-leader.dto';
import { CreateAgentDto } from './dto/create-agent.dto';

export interface CreateTeamLeaderResult {
  teamLeader: TeamLeader;

  /**
   * Plaintext API key.
   *
   * Returned exactly once at creation time.
   * It is never persisted in plaintext.
   */
  apiKey: string;
}

export interface CreateAgentResult {
  agent: Agent;

  /**
   * Plaintext API key.
   *
   * Returned exactly once at creation time.
   */
  apiKey: string;
}

@Injectable()
export class TeamLeaderService {
  private readonly logger =
    createLogger('TeamLeaderService');

  constructor(
    /**
     * Main database:
     *
     * - TeamLeader
     * - Agent
     * - ApiKey
     *
     * Team Leader / Agent principal creation and credential provisioning
     * must be atomic inside this database.
     */
    @InjectDataSource('main')
    private readonly mainDataSource: DataSource,

    @InjectRepository(TeamLeader, 'main')
    private readonly teamLeaderRepository: Repository<TeamLeader>,

    @InjectRepository(Agent, 'main')
    private readonly agentRepository: Repository<Agent>,

    @InjectRepository(ApiKey, 'main')
    private readonly apiKeyRepository: Repository<ApiKey>,

    /**
     * Sessions live in the separate data database.
     *
     * There intentionally cannot be a database FK between Agent and
     * Session or between TeamLeader and Session.
     */
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,

    private readonly authService: AuthService,

    /**
     * Used only for best-effort WebSocket eviction.
     *
     * Resolving EventsGateway lazily avoids requiring TeamLeaderModule
     * to statically depend on EventsModule.
     */
    private readonly moduleRef: ModuleRef,
  ) {}

  // ---------------------------------------------------------------------------
  // Team Leaders
  // ---------------------------------------------------------------------------

  /**
   * Create a Team Leader and its TEAM_LEADER API key atomically.
   *
   * Either both records commit or neither does.
   *
   * The plaintext API key is returned only once.
   */
  async createTeamLeader(
    dto: CreateTeamLeaderDto,
  ): Promise<CreateTeamLeaderResult> {
    const name = dto.name.trim();
    const email = this.normalizeEmail(dto.email);

    try {
      return await this.mainDataSource.transaction(
        async manager => {
          const teamLeaderRepository =
            manager.getRepository(TeamLeader);

          /**
           * Give the caller a clean 409 instead of relying only on the
           * unique database constraint.
           *
           * The unique constraint still remains authoritative for races.
           */
          const existing =
            await teamLeaderRepository.findOne({
              where: {
                email,
              },
            });

          if (existing) {
            throw new ConflictException(
              'A Team Leader with this email already exists',
            );
          }

          const teamLeader =
            teamLeaderRepository.create({
              name,
              email,
            });

          const savedTeamLeader =
            await teamLeaderRepository.save(
              teamLeader,
            );

          const {
            rawKey,
          } =
            await this.authService.createApiKeyInTransaction(
              manager,
              {
                name:
                  `Team Leader: ${savedTeamLeader.name}`,

                role:
                  ApiKeyRole.TEAM_LEADER,

                teamLeaderId:
                  savedTeamLeader.id,

                agentId: null,

                /**
                 * Tenant ownership is authoritative.
                 *
                 * allowedSessions is an optional additional ceiling and
                 * must not be populated merely because this is a Team
                 * Leader key.
                 */
                allowedSessions: null,
              },
            );

          this.logger.log(
            `Team Leader created: ${savedTeamLeader.name}`,
            {
              teamLeaderId:
                savedTeamLeader.id,

              action:
                'team_leader_created',
            },
          );

          return {
            teamLeader:
              savedTeamLeader,

            apiKey:
              rawKey,
          };
        },
      );
    } catch (error) {
      if (
        error instanceof
        ConflictException
      ) {
        throw error;
      }

      if (
        this.isUniqueConstraintError(
          error,
        )
      ) {
        throw new ConflictException(
          'A Team Leader with this email already exists',
        );
      }

      throw error;
    }
  }

  /**
   * List all Team Leaders.
   *
   * This is intended for the ADMIN management surface.
   */
  async listTeamLeaders(): Promise<TeamLeader[]> {
    return this.teamLeaderRepository.find({
      order: {
        createdAt: 'DESC',
      },
    });
  }

  /**
   * Resolve one Team Leader.
   *
   * ADMIN management routes may use this directly.
   */
  async getTeamLeader(
    teamLeaderId: string,
  ): Promise<TeamLeader> {
    const teamLeader =
      await this.teamLeaderRepository.findOne({
        where: {
          id: teamLeaderId,
        },
      });

    if (!teamLeader) {
      throw new NotFoundException(
        'Team Leader not found',
      );
    }

    return teamLeader;
  }

  /**
   * Resolve the currently authenticated Team Leader identity.
   *
   * Kept as a separate semantic method so the eventual
   * GET /team-leader/me controller does not need repository knowledge.
   */
  async getTeamLeaderIdentity(
    teamLeaderId: string,
  ): Promise<TeamLeader> {
    return this.getTeamLeader(
      teamLeaderId,
    );
  }

  /**
   * Delete a Team Leader.
   *
   * Business rule:
   *
   * A Team Leader that still owns any WhatsApp session cannot be
   * deleted. We return 409 instead of silently setting Session owner
   * fields to NULL.
   *
   * Once the ownership check passes:
   *
   * - Agent rows cascade-delete through the main DB FK
   * - Team Leader / Agent API keys cascade-delete through their FKs
   * - live WebSocket connections for those keys are evicted
   */
  async deleteTeamLeader(
    teamLeaderId: string,
  ): Promise<void> {
    const teamLeader =
      await this.getTeamLeader(
        teamLeaderId,
      );

    /**
     * Session belongs to a different database, so this ownership check
     * cannot participate in the main DB transaction.
     */
    const ownedSessionCount =
      await this.sessionRepository.count({
        where: {
          ownerTeamLeaderId:
            teamLeaderId,
        },
      });

    if (ownedSessionCount > 0) {
      throw new ConflictException(
        'Cannot delete Team Leader while they still own sessions',
      );
    }

    /**
     * Capture affected credential IDs before the FK cascade removes
     * them so their live WebSocket connections can be terminated after
     * the transaction commits.
     */
    const keyIds =
      await this.getTeamLeaderCredentialIds(
        teamLeaderId,
      );

    await this.mainDataSource.transaction(
      async manager => {
        const repository =
          manager.getRepository(
            TeamLeader,
          );

        /**
         * Re-read inside the transaction so a concurrent administrative
         * delete results in the same public 404 semantics.
         */
        const current =
          await repository.findOne({
            where: {
              id: teamLeaderId,
            },
          });

        if (!current) {
          throw new NotFoundException(
            'Team Leader not found',
          );
        }

        await repository.remove(
          current,
        );
      },
    );

    this.evictApiKeys(
      keyIds,
      'deleted',
    );

    this.logger.log(
      `Team Leader deleted: ${teamLeader.name}`,
      {
        teamLeaderId,
        action:
          'team_leader_deleted',
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Agents
  // ---------------------------------------------------------------------------

  /**
   * Create an Agent owned by the specified Team Leader and provision
   * its AGENT API key atomically.
   *
   * teamLeaderId must come from authenticated context, never from
   * CreateAgentDto.
   */
  async createAgent(
    teamLeaderId: string,
    dto: CreateAgentDto,
  ): Promise<CreateAgentResult> {
    const name =
      dto.name.trim();

    const email =
      dto.email
        ? this.normalizeEmail(
            dto.email,
          )
        : null;

    return this.mainDataSource.transaction(
      async manager => {
        const teamLeaderRepository =
          manager.getRepository(
            TeamLeader,
          );

        const agentRepository =
          manager.getRepository(
            Agent,
          );

        /**
         * Ensure the authenticated Team Leader principal still exists.
         */
        const teamLeader =
          await teamLeaderRepository.findOne({
            where: {
              id:
                teamLeaderId,
            },
          });

        if (!teamLeader) {
          throw new NotFoundException(
            'Team Leader not found',
          );
        }

        const agent =
          agentRepository.create({
            name,
            email,

            teamLeaderId:
              teamLeader.id,

            assignedSessionId:
              null,
          });

        const savedAgent =
          await agentRepository.save(
            agent,
          );

        const {
          rawKey,
        } =
          await this.authService.createApiKeyInTransaction(
            manager,
            {
              name:
                `Agent: ${savedAgent.name}`,

              role:
                ApiKeyRole.AGENT,

              agentId:
                savedAgent.id,

              teamLeaderId:
                null,

              /**
               * Assignment is stored in Agent.assignedSessionId.
               *
               * Never copy Agent assignment into allowedSessions.
               */
              allowedSessions:
                null,
            },
          );

        this.logger.log(
          `Agent created: ${savedAgent.name}`,
          {
            agentId:
              savedAgent.id,

            teamLeaderId:
              savedAgent.teamLeaderId,

            action:
              'agent_created',
          },
        );

        return {
          agent:
            savedAgent,

          apiKey:
            rawKey,
        };
      },
    );
  }

  /**
   * List only Agents owned by the specified Team Leader.
   */
  async listAgents(
    teamLeaderId: string,
  ): Promise<Agent[]> {
    /**
     * Deliberately validate the Team Leader first.
     *
     * This distinguishes:
     *
     * existing Team Leader with zero Agents -> []
     * nonexistent Team Leader             -> 404
     */
    await this.getTeamLeader(
      teamLeaderId,
    );

    return this.agentRepository.find({
      where: {
        teamLeaderId,
      },

      order: {
        createdAt:
          'DESC',
      },
    });
  }

  /**
   * Resolve an Agent while enforcing Team Leader ownership.
   *
   * A foreign Agent intentionally looks nonexistent to the caller.
   */
  async getAgentForTeamLeader(
    teamLeaderId: string,
    agentId: string,
  ): Promise<Agent> {
    const agent =
      await this.agentRepository.findOne({
        where: {
          id:
            agentId,

          teamLeaderId,
        },
      });

    if (!agent) {
      throw new NotFoundException(
        'Agent not found',
      );
    }

    return agent;
  }

  /**
   * Resolve the authenticated Agent identity.
   *
   * GET /agent/me can call this using apiKey.agentId.
   */
  async getAgentIdentity(
    agentId: string,
  ): Promise<Agent> {
    const agent =
      await this.agentRepository.findOne({
        where: {
          id:
            agentId,
        },
      });

    if (!agent) {
      throw new NotFoundException(
        'Agent not found',
      );
    }

    return agent;
  }

  /**
   * Delete an Agent belonging to the authenticated Team Leader.
   *
   * Foreign Agents intentionally return 404.
   *
   * The linked AGENT API key is removed by the main DB FK cascade.
   */
  async deleteAgent(
    teamLeaderId: string,
    agentId: string,
  ): Promise<void> {
    /**
     * Validate tenant ownership before touching the principal.
     */
    const agent =
      await this.getAgentForTeamLeader(
        teamLeaderId,
        agentId,
      );

    const keys =
      await this.apiKeyRepository.find({
        where: {
          agentId:
            agent.id,

          role:
            ApiKeyRole.AGENT,
        },

        select: {
          id: true,
        },
      });

    const keyIds =
      keys.map(
        key => key.id,
      );

    await this.mainDataSource.transaction(
      async manager => {
        const agentRepository =
          manager.getRepository(
            Agent,
          );

        /**
         * Repeat the ownership predicate inside the transaction.
         */
        const current =
          await agentRepository.findOne({
            where: {
              id:
                agentId,

              teamLeaderId,
            },
          });

        if (!current) {
          throw new NotFoundException(
            'Agent not found',
          );
        }

        await agentRepository.remove(
          current,
        );
      },
    );

    this.evictApiKeys(
      keyIds,
      'deleted',
    );

    this.logger.log(
      `Agent deleted: ${agent.name}`,
      {
        agentId:
          agent.id,

        teamLeaderId,

        action:
          'agent_deleted',
      },
    );
  }

  /**
   * Assign or unassign an Agent's WhatsApp session.
   *
   * sessionId === null means unassign.
   *
   * Security requirements for a non-null assignment:
   *
   *     agent.teamLeaderId
   *         ===
   *     authenticated Team Leader id
   *
   * AND
   *
   *     session.ownerTeamLeaderId
   *         ===
   *     authenticated Team Leader id
   *
   * A foreign/nonexistent Agent or Session returns 404.
   */
  async assignAgentSession(
    teamLeaderId: string,
    agentId: string,
    sessionId: string | null,
  ): Promise<Agent> {
    const agent =
      await this.getAgentForTeamLeader(
        teamLeaderId,
        agentId,
      );

    if (sessionId !== null) {
      /**
       * Ownership is included directly in the query.
       *
       * This intentionally makes:
       *
       * - nonexistent session
       * - another Team Leader's session
       *
       * indistinguishable to the caller.
       */
      const session =
        await this.sessionRepository.findOne({
          where: {
            id:
              sessionId,

            ownerTeamLeaderId:
              teamLeaderId,
          },
        });

      if (!session) {
        throw new NotFoundException(
          'Session not found',
        );
      }

      /**
       * Enforce the application-level one-Agent-per-session invariant.
       *
       * Agent and Session live in different databases, so there cannot
       * be a cross-database FK for this relationship. Assignment is
       * therefore guarded explicitly in the service layer.
       *
       * The current Agent is allowed to keep its own assignment so the
       * operation remains idempotent.
       */
      const existingAssignment =
        await this.agentRepository.findOne({
          where: {
            assignedSessionId:
              sessionId,
          },
        });

      if (
        existingAssignment &&
        existingAssignment.id !== agent.id
      ) {
        throw new ConflictException(
          'Session is already assigned to another Agent',
        );
      }
    }

    const previousSessionId =
      agent.assignedSessionId;

    /**
     * Idempotent assignment.
     *
     * No authorization state changed, so there is no reason to evict
     * existing sockets.
     */
    if (
      previousSessionId ===
      sessionId
    ) {
      return agent;
    }

    agent.assignedSessionId =
      sessionId;

    const saved =
      await this.agentRepository.save(
        agent,
      );

    /**
     * Agent authorization changed immediately.
     *
     * Disconnect all sockets authenticated with this Agent's key so a
     * subscription authorized under the previous assignment cannot
     * continue receiving events.
     */
    const keys =
      await this.apiKeyRepository.find({
        where: {
          agentId:
            agent.id,

          role:
            ApiKeyRole.AGENT,
        },

        select: {
          id: true,
        },
      });

    this.evictApiKeys(
      keys.map(
        key => key.id,
      ),
      'authorization_changed',
    );

    this.logger.log(
      sessionId === null
        ? `Agent session unassigned: ${saved.name}`
        : `Agent session assigned: ${saved.name}`,
      {
        agentId:
          saved.id,

        teamLeaderId:
          saved.teamLeaderId,

        previousSessionId,

        newSessionId:
          sessionId,

        action:
          sessionId === null
            ? 'agent_session_unassigned'
            : previousSessionId
              ? 'agent_session_reassigned'
              : 'agent_session_assigned',
      },
    );

    return saved;
  }

  /**
   * Convenience wrapper for an explicit unassign operation.
   */
  async unassignAgentSession(
    teamLeaderId: string,
    agentId: string,
  ): Promise<Agent> {
    return this.assignAgentSession(
      teamLeaderId,
      agentId,
      null,
    );
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Get every management credential that will disappear if the Team
   * Leader principal is deleted.
   *
   * This includes:
   *
   * - the Team Leader's own key(s)
   * - every Agent key belonging to that Team Leader
   */
  private async getTeamLeaderCredentialIds(
    teamLeaderId: string,
  ): Promise<string[]> {
    const agents =
      await this.agentRepository.find({
        where: {
          teamLeaderId,
        },

        select: {
          id: true,
        },
      });

    const agentIds =
      agents.map(
        agent => agent.id,
      );

    const directKeys =
      await this.apiKeyRepository.find({
        where: {
          teamLeaderId,
          role:
            ApiKeyRole.TEAM_LEADER,
        },

        select: {
          id: true,
        },
      });

    let agentKeys: ApiKey[] = [];

    if (agentIds.length > 0) {
      agentKeys =
        await this.apiKeyRepository.find({
          where: {
            agentId:
              In(agentIds),

            role:
              ApiKeyRole.AGENT,
          },

          select: {
            id: true,
          },
        });
    }

    return [
      ...new Set([
        ...directKeys.map(
          key => key.id,
        ),

        ...agentKeys.map(
          key => key.id,
        ),
      ]),
    ];
  }

  /**
   * Best-effort WebSocket eviction.
   *
   * Database state remains authoritative. Failure to resolve or invoke
   * EventsGateway must not roll back an already committed principal or
   * assignment mutation.
   */
  private evictApiKeys(
    keyIds: readonly string[],
    reason: ApiKeyEvictionReason,
  ): void {
    if (keyIds.length === 0) {
      return;
    }

    try {
      const gateway =
        this.moduleRef.get(
          EventsGateway,
          {
            strict: false,
          },
        );

      if (!gateway) {
        return;
      }

      for (const keyId of keyIds) {
        gateway.evictApiKey(
          keyId,
          reason,
        );
      }
    } catch (error) {
      this.logger.warn(
        'Failed to evict WebSocket connections after Team Leader authorization change',
        {
          keyIds: [
            ...keyIds,
          ],

          reason,

          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
      );
    }
  }

  private normalizeEmail(
    email: string,
  ): string {
    return email
      .trim()
      .toLowerCase();
  }

  /**
   * Handle the database constraint race where two requests both pass
   * the pre-insert Team Leader email lookup.
   */
  private isUniqueConstraintError(
    error: unknown,
  ): boolean {
    if (
      !(
        error instanceof
        QueryFailedError
      )
    ) {
      return false;
    }

    const driverError =
      (
        error as QueryFailedError & {
          driverError?: {
            code?: string;
            errno?: number;
            message?: string;
          };
        }
      ).driverError;

    const code =
      driverError?.code ??
      '';

    const message =
      driverError?.message ??
      error.message ??
      '';

    /**
     * Main DB is currently SQLite, but accepting PostgreSQL's 23505 here
     * makes this helper harmless if that constraint changes later.
     */
    return (
      code ===
        'SQLITE_CONSTRAINT' ||
      code ===
        'SQLITE_CONSTRAINT_UNIQUE' ||
      code === '23505' ||
      message
        .toLowerCase()
        .includes(
          'unique constraint',
        )
    );
  }
}




