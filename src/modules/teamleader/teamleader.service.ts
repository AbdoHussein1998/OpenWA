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

import { createLogger } from '../../common/services/logger.service';
import { AuthService } from '../auth/auth.service';
import {
  ApiKey,
  ApiKeyRole,
} from '../auth/entities/api-key.entity';
import {
  EventsGateway,
  type ApiKeyEvictionReason,
} from '../events/events.gateway';
import { Session } from '../session/entities/session.entity';

import { CreateAgentDto } from './dto/create-agent.dto';
import { CreateTeamLeaderDto } from './dto/create-team-leader.dto';
import { Agent } from './entities/agent.entity';
import { TeamLeader } from './entities/team-leader.entity';

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

/**
 * Flattened ADMIN overview of an Agent, its owning Team Leader, and its
 * currently assigned Session (when one exists).
 *
 * Agent / Team Leader rows live in the `main` database while Session rows
 * live in the separate `data` database, so TeamLeaderService merges them
 * in memory rather than attempting a cross-database ORM join.
 */
export interface AdminAgentOverview {
  id: string;
  name: string;
  email: string | null;

  teamLeaderId: string;

  teamLeader: {
    id: string;
    name: string;
    email: string | null;
  };

  assignedSessionId: string | null;

  assignedSession: {
    id: string;
    name: string;
    status: Session['status'];
    phone: string | null;
    targetPhone: string | null;
  } | null;

  templateSendLimit24h: number | null;

  createdAt: Date;
  updatedAt: Date;
}

/**
 * ADMIN-facing Session summary used by Team Leader resource management.
 *
 * Deliberately excludes Session config/proxy/runtime-only internals that are
 * irrelevant to ownership delegation.
 */
export interface AdminSessionOverview {
  id: string;
  name: string;
  ownerTeamLeaderId: string | null;
  status: Session['status'];
  phone: string | null;
  targetPhone: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Resource graph that must be reviewed before a Team Leader can be deleted.
 */
export interface AdminTeamLeaderResources {
  teamLeader: TeamLeader;
  sessions: AdminSessionOverview[];
  agents: Array<{
    id: string;
    name: string;
    email: string | null;
    assignedSessionId: string | null;
    templateSendLimit24h: number | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
  canDelete: boolean;
}

@Injectable()
export class TeamLeaderService {
  private readonly logger = createLogger('TeamLeaderService');

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
   * The plaintext API key is returned only once.
   */
  async createTeamLeader(
    dto: CreateTeamLeaderDto,
  ): Promise<CreateTeamLeaderResult> {
    const name = dto.name.trim();
    const email = this.normalizeOptionalEmail(dto.email);

    try {
      return await this.mainDataSource.transaction(async manager => {
        const teamLeaderRepository = manager.getRepository(TeamLeader);

        if (email !== null) {
          const existing = await teamLeaderRepository.findOne({
            where: { email },
          });

          if (existing) {
            throw new ConflictException(
              'A Team Leader with this email already exists',
            );
          }
        }

        const teamLeader = teamLeaderRepository.create({
          name,
          email,
        });

        const savedTeamLeader = await teamLeaderRepository.save(teamLeader);

        const { rawKey } = await this.authService.createApiKeyInTransaction(
          manager,
          {
            name: `Team Leader: ${savedTeamLeader.name}`,
            role: ApiKeyRole.TEAM_LEADER,
            teamLeaderId: savedTeamLeader.id,
            agentId: null,
            allowedSessions: null,
          },
        );

        this.logger.log(
          `Team Leader created: ${savedTeamLeader.name}`,
          {
            teamLeaderId: savedTeamLeader.id,
            action: 'team_leader_created',
          },
        );

        return {
          teamLeader: savedTeamLeader,
          apiKey: rawKey,
        };
      });
    } catch (error) {
      if (error instanceof ConflictException) {
        throw error;
      }

      if (this.isUniqueConstraintError(error)) {
        throw new ConflictException(
          'A Team Leader with this email already exists',
        );
      }

      throw error;
    }
  }

  /** List all Team Leaders for the ADMIN management surface. */
  async listTeamLeaders(): Promise<TeamLeader[]> {
    return this.teamLeaderRepository.find({
      order: {
        createdAt: 'DESC',
      },
    });
  }

  /** Resolve one Team Leader. */
  async getTeamLeader(
    teamLeaderId: string,
  ): Promise<TeamLeader> {
    const teamLeader = await this.teamLeaderRepository.findOne({
      where: {
        id: teamLeaderId,
      },
    });

    if (!teamLeader) {
      throw new NotFoundException('Team Leader not found');
    }

    return teamLeader;
  }

  /** Resolve the currently authenticated Team Leader identity. */
  async getTeamLeaderIdentity(
    teamLeaderId: string,
  ): Promise<TeamLeader> {
    return this.getTeamLeader(teamLeaderId);
  }

  /**
   * Return the complete delegable resource graph for one Team Leader.
   *
   * This is intentionally assembled with separate reads because Team Leader /
   * Agent principals and Sessions live in different databases.
   */
  async getAdminTeamLeaderResources(
    teamLeaderId: string,
  ): Promise<AdminTeamLeaderResources> {
    const teamLeader = await this.getTeamLeader(teamLeaderId);

    const [sessions, agents] = await Promise.all([
      this.sessionRepository.find({
        where: {
          ownerTeamLeaderId: teamLeaderId,
        },
        order: {
          createdAt: 'DESC',
        },
      }),
      this.agentRepository.find({
        where: {
          teamLeaderId,
        },
        order: {
          createdAt: 'DESC',
        },
      }),
    ]);

    return {
      teamLeader,
      sessions: sessions.map(session => this.toAdminSessionOverview(session)),
      agents: agents.map(agent => ({
        id: agent.id,
        name: agent.name,
        email: agent.email,
        assignedSessionId: agent.assignedSessionId,
        templateSendLimit24h: agent.templateSendLimit24h,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      })),
      canDelete: sessions.length === 0 && agents.length === 0,
    };
  }

  /**
   * Transfer one Team Leader-owned Session to another Team Leader.
   *
   * An assigned Session is rejected. The Agent must first be explicitly
   * unassigned/moved through the ADMIN Agent management flow. Keeping the two
   * operations separate avoids pretending that the `main` and `data`
   * databases can participate in one atomic transaction.
   */
  async reassignAdminSession(
    sourceTeamLeaderId: string,
    sessionId: string,
    targetTeamLeaderId: string,
  ): Promise<AdminSessionOverview> {
    const [session] = await this.reassignAdminSessions(
      sourceTeamLeaderId,
      [sessionId],
      targetTeamLeaderId,
    );

    return session;
  }

  /**
   * Bulk-transfer Team Leader-owned Sessions to another Team Leader.
   *
   * Every Session must currently belong to sourceTeamLeaderId and none may be
   * assigned to an Agent. The transfer itself only mutates the `data` DB.
   */
  async reassignAdminSessions(
    sourceTeamLeaderId: string,
    sessionIds: readonly string[],
    targetTeamLeaderId: string,
  ): Promise<AdminSessionOverview[]> {
    const uniqueSessionIds = [...new Set(sessionIds)];

    if (uniqueSessionIds.length === 0) {
      throw new ConflictException('At least one Session is required');
    }

    await Promise.all([
      this.getTeamLeader(sourceTeamLeaderId),
      this.getTeamLeader(targetTeamLeaderId),
    ]);

    const sessions = await this.sessionRepository.find({
      where: {
        id: In(uniqueSessionIds),
        ownerTeamLeaderId: sourceTeamLeaderId,
      },
    });

    if (sessions.length !== uniqueSessionIds.length) {
      throw new NotFoundException(
        'One or more Sessions were not found under the source Team Leader',
      );
    }

    if (sourceTeamLeaderId === targetTeamLeaderId) {
      const byId = new Map(sessions.map(session => [session.id, session]));
      return uniqueSessionIds.map(sessionId =>
        this.toAdminSessionOverview(byId.get(sessionId)!),
      );
    }

    const assignedAgents = await this.agentRepository.find({
      where: {
        assignedSessionId: In(uniqueSessionIds),
      },
      select: {
        id: true,
        name: true,
        assignedSessionId: true,
      },
    });

    if (assignedAgents.length > 0) {
      const assignedSessionIds = [
        ...new Set(
          assignedAgents
            .map(agent => agent.assignedSessionId)
            .filter((value): value is string => value !== null),
        ),
      ];

      throw new ConflictException(
        `Cannot transfer assigned Sessions. Unassign their Agents first: ${assignedSessionIds.join(', ')}`,
      );
    }

    const transferred = await this.sessionRepository.manager.transaction(
      async manager => {
        const repository = manager.getRepository(Session);

        const current = await repository.find({
          where: {
            id: In(uniqueSessionIds),
            ownerTeamLeaderId: sourceTeamLeaderId,
          },
        });

        if (current.length !== uniqueSessionIds.length) {
          throw new ConflictException(
            'Session ownership changed while the transfer was being prepared',
          );
        }

        for (const session of current) {
          session.ownerTeamLeaderId = targetTeamLeaderId;
        }

        return repository.save(current);
      },
    );

    /**
     * Close the only meaningful cross-database race window: an Agent owned by
     * the source Team Leader may have been assigned after the pre-check but
     * before the data-DB ownership transaction committed. New assignments
     * after this point will already observe the target owner and therefore be
     * authorized only for the target Team Leader.
     */
    const assignmentsAfterTransfer = await this.agentRepository.find({
      where: {
        assignedSessionId: In(uniqueSessionIds),
      },
      select: {
        id: true,
        teamLeaderId: true,
        assignedSessionId: true,
      },
    });

    const invalidAssignments = assignmentsAfterTransfer.filter(
      agent => agent.teamLeaderId !== targetTeamLeaderId,
    );

    if (invalidAssignments.length > 0) {
      try {
        await this.sessionRepository.manager.transaction(async manager => {
          const repository = manager.getRepository(Session);
          const current = await repository.find({
            where: {
              id: In(uniqueSessionIds),
              ownerTeamLeaderId: targetTeamLeaderId,
            },
          });

          for (const session of current) {
            session.ownerTeamLeaderId = sourceTeamLeaderId;
          }

          if (current.length > 0) {
            await repository.save(current);
          }
        });
      } catch (rollbackError) {
        this.logger.error(
          'Failed to compensate Session ownership after a concurrent Agent assignment',
          undefined,
          {
            sourceTeamLeaderId,
            targetTeamLeaderId,
            sessionIds: uniqueSessionIds,
            error:
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError),
          },
        );
      }

      throw new ConflictException(
        'A Session became assigned during ownership transfer; retry after unassigning the Agent',
      );
    }

    const affectedTeamLeaderKeyIds = await this.getTeamLeaderApiKeyIds([
      sourceTeamLeaderId,
      targetTeamLeaderId,
    ]);

    this.evictApiKeys(
      affectedTeamLeaderKeyIds,
      'authorization_changed',
    );

    this.logger.log('Session ownership reassigned by ADMIN', {
      sourceTeamLeaderId,
      targetTeamLeaderId,
      sessionIds: uniqueSessionIds,
      action: 'admin_session_owner_reassigned',
    });

    const transferredById = new Map(
      transferred.map(session => [session.id, session]),
    );

    return uniqueSessionIds.map(sessionId =>
      this.toAdminSessionOverview(transferredById.get(sessionId)!),
    );
  }

  /**
   * Delete a Team Leader only after all delegable resources have been handled.
   *
   * Unlike the older cascade-based behavior, Agents are now also blockers.
   * This prevents an ADMIN deletion from silently destroying Agent principals
   * instead of explicitly reassigning/deleting them first.
   */
  async deleteTeamLeader(
    teamLeaderId: string,
  ): Promise<void> {
    const teamLeader = await this.getTeamLeader(teamLeaderId);

    const [ownedSessionCount, ownedAgentCount] = await Promise.all([
      this.sessionRepository.count({
        where: {
          ownerTeamLeaderId: teamLeaderId,
        },
      }),
      this.agentRepository.count({
        where: {
          teamLeaderId,
        },
      }),
    ]);

    if (ownedSessionCount > 0 || ownedAgentCount > 0) {
      throw new ConflictException(
        'Cannot delete Team Leader while they still own Sessions or Agents; reassign or delete those resources first',
      );
    }

    const keyIds = await this.getTeamLeaderCredentialIds(teamLeaderId);

    await this.mainDataSource.transaction(async manager => {
      const repository = manager.getRepository(TeamLeader);
      const current = await repository.findOne({
        where: {
          id: teamLeaderId,
        },
      });

      if (!current) {
        throw new NotFoundException('Team Leader not found');
      }

      await repository.remove(current);
    });

    this.evictApiKeys(keyIds, 'deleted');

    this.logger.log(`Team Leader deleted: ${teamLeader.name}`, {
      teamLeaderId,
      action: 'team_leader_deleted',
    });
  }

  // ---------------------------------------------------------------------------
  // Agents
  // ---------------------------------------------------------------------------

  /**
   * Create an Agent owned by the specified Team Leader and provision its
   * AGENT API key atomically.
   *
   * teamLeaderId must come from authenticated context, never from
   * CreateAgentDto.
   */
  async createAgent(
    teamLeaderId: string,
    dto: CreateAgentDto,
  ): Promise<CreateAgentResult> {
    const name = dto.name.trim();
    const email = dto.email ? this.normalizeEmail(dto.email) : null;

    return this.mainDataSource.transaction(async manager => {
      const teamLeaderRepository = manager.getRepository(TeamLeader);
      const agentRepository = manager.getRepository(Agent);

      const teamLeader = await teamLeaderRepository.findOne({
        where: {
          id: teamLeaderId,
        },
      });

      if (!teamLeader) {
        throw new NotFoundException('Team Leader not found');
      }

      const agent = agentRepository.create({
        name,
        email,
        teamLeaderId: teamLeader.id,
        assignedSessionId: null,
        templateSendLimit24h: dto.templateSendLimit24h ?? null,
      });

      const savedAgent = await agentRepository.save(agent);

      const { rawKey } = await this.authService.createApiKeyInTransaction(
        manager,
        {
          name: `Agent: ${savedAgent.name}`,
          role: ApiKeyRole.AGENT,
          agentId: savedAgent.id,
          teamLeaderId: null,
          allowedSessions: null,
        },
      );

      this.logger.log(`Agent created: ${savedAgent.name}`, {
        agentId: savedAgent.id,
        teamLeaderId: savedAgent.teamLeaderId,
        action: 'agent_created',
      });

      return {
        agent: savedAgent,
        apiKey: rawKey,
      };
    });
  }

  /**
   * Replace an Agent's AGENT API key atomically in the main database.
   */
  async rotateAgentApiKey(
    teamLeaderId: string,
    agentId: string,
  ): Promise<CreateAgentResult> {
    let previousKeyIds: string[] = [];

    const result = await this.mainDataSource.transaction(async manager => {
      const agentRepository = manager.getRepository(Agent);
      const apiKeyRepository = manager.getRepository(ApiKey);

      const agent = await agentRepository.findOne({
        where: {
          id: agentId,
          teamLeaderId,
        },
      });

      if (!agent) {
        throw new NotFoundException('Agent not found');
      }

      const previousKeys = await apiKeyRepository.find({
        where: {
          agentId: agent.id,
          role: ApiKeyRole.AGENT,
        },
      });

      previousKeyIds = previousKeys.map(key => key.id);

      if (previousKeys.length > 0) {
        await apiKeyRepository.remove(previousKeys);
      }

      const { rawKey } = await this.authService.createApiKeyInTransaction(
        manager,
        {
          name: `Agent: ${agent.name}`,
          role: ApiKeyRole.AGENT,
          agentId: agent.id,
          teamLeaderId: null,
          allowedSessions: null,
        },
      );

      return {
        agent,
        apiKey: rawKey,
      };
    });

    this.evictApiKeys(previousKeyIds, 'revoked');

    this.logger.log(`Agent API key rotated: ${result.agent.name}`, {
      agentId: result.agent.id,
      teamLeaderId: result.agent.teamLeaderId,
      revokedKeyCount: previousKeyIds.length,
      action: 'agent_api_key_rotated',
    });

    return result;
  }

  /** ADMIN-only global Agent overview. */
  async getAdminAgents(): Promise<AdminAgentOverview[]> {
    const agents = await this.agentRepository.find({
      relations: {
        teamLeader: true,
      },
      order: {
        createdAt: 'DESC',
      },
    });

    return this.buildAdminAgentOverviews(agents);
  }

  /** Resolve one Agent for the ADMIN management surface. */
  async getAdminAgent(
    agentId: string,
  ): Promise<AdminAgentOverview> {
    const agent = await this.agentRepository.findOne({
      where: {
        id: agentId,
      },
      relations: {
        teamLeader: true,
      },
    });

    if (!agent) {
      throw new NotFoundException('Agent not found');
    }

    const [overview] = await this.buildAdminAgentOverviews([agent]);
    return overview;
  }

  /**
   * Move one Agent to another Team Leader.
   *
   * If the Agent has an assigned Session and the target Team Leader does not
   * own that Session, the caller must explicitly request unassignment. This
   * preserves the invariant:
   *
   *   Agent.teamLeaderId === Session.ownerTeamLeaderId
   */
  async reassignAdminAgent(
    agentId: string,
    targetTeamLeaderId: string,
    unassignSession: boolean,
  ): Promise<AdminAgentOverview> {
    const [agent] = await this.reassignAdminAgents(
      [agentId],
      targetTeamLeaderId,
      unassignSession,
    );

    return agent;
  }

  /**
   * Bulk-move Agents to another Team Leader.
   *
   * The entire main-DB mutation is transactional. Session ownership is never
   * modified here; cross-database Session transfer remains a separate ADMIN
   * operation.
   */
  async reassignAdminAgents(
    agentIds: readonly string[],
    targetTeamLeaderId: string,
    unassignSession: boolean,
  ): Promise<AdminAgentOverview[]> {
    const uniqueAgentIds = [...new Set(agentIds)];

    if (uniqueAgentIds.length === 0) {
      throw new ConflictException('At least one Agent is required');
    }

    await this.getTeamLeader(targetTeamLeaderId);

    const agents = await this.agentRepository.find({
      where: {
        id: In(uniqueAgentIds),
      },
    });

    if (agents.length !== uniqueAgentIds.length) {
      throw new NotFoundException('One or more Agents were not found');
    }

    const assignmentsToPreserve = agents
      .filter(
        agent =>
          agent.teamLeaderId !== targetTeamLeaderId &&
          agent.assignedSessionId !== null &&
          !unassignSession,
      )
      .map(agent => agent.assignedSessionId!)
      .filter((value, index, values) => values.indexOf(value) === index);

    if (assignmentsToPreserve.length > 0) {
      const targetOwnedSessions = await this.sessionRepository.find({
        where: {
          id: In(assignmentsToPreserve),
          ownerTeamLeaderId: targetTeamLeaderId,
        },
        select: {
          id: true,
        },
      });

      if (targetOwnedSessions.length !== assignmentsToPreserve.length) {
        throw new ConflictException(
          'One or more Agents are assigned to Sessions not owned by the target Team Leader; set unassignSession=true or transfer ownership after unassigning',
        );
      }
    }

    const changedAgentIds = agents
      .filter(
        agent =>
          agent.teamLeaderId !== targetTeamLeaderId ||
          (unassignSession && agent.assignedSessionId !== null),
      )
      .map(agent => agent.id);

    if (changedAgentIds.length > 0) {
      await this.mainDataSource.transaction(async manager => {
        const teamLeaderRepository = manager.getRepository(TeamLeader);
        const agentRepository = manager.getRepository(Agent);

        const targetTeamLeader = await teamLeaderRepository.findOne({
          where: {
            id: targetTeamLeaderId,
          },
        });

        if (!targetTeamLeader) {
          throw new NotFoundException('Team Leader not found');
        }

        const currentAgents = await agentRepository.find({
          where: {
            id: In(uniqueAgentIds),
          },
        });

        if (currentAgents.length !== uniqueAgentIds.length) {
          throw new NotFoundException('One or more Agents were not found');
        }

        if (!unassignSession) {
          const currentAssignmentsToPreserve = currentAgents
            .filter(
              agent =>
                agent.teamLeaderId !== targetTeamLeaderId &&
                agent.assignedSessionId !== null,
            )
            .map(agent => agent.assignedSessionId!)
            .filter((value, index, values) => values.indexOf(value) === index);

          if (currentAssignmentsToPreserve.length > 0) {
            const targetOwnedSessions = await this.sessionRepository.find({
              where: {
                id: In(currentAssignmentsToPreserve),
                ownerTeamLeaderId: targetTeamLeaderId,
              },
              select: {
                id: true,
              },
            });

            if (
              targetOwnedSessions.length !==
              currentAssignmentsToPreserve.length
            ) {
              throw new ConflictException(
                'One or more Agents are assigned to Sessions not owned by the target Team Leader; set unassignSession=true before moving them',
              );
            }
          }
        }

        for (const agent of currentAgents) {
          agent.teamLeaderId = targetTeamLeaderId;

          if (unassignSession) {
            agent.assignedSessionId = null;
          }
        }

        await agentRepository.save(currentAgents);
      });

      const keyIds = await this.getAgentApiKeyIds(changedAgentIds);
      this.evictApiKeys(keyIds, 'authorization_changed');
    }

    this.logger.log('Agents reassigned by ADMIN', {
      agentIds: uniqueAgentIds,
      targetTeamLeaderId,
      unassignSession,
      action: 'admin_agents_reassigned',
    });

    const overviews = await this.getAdminAgentsByIds(uniqueAgentIds);
    const overviewsById = new Map(overviews.map(agent => [agent.id, agent]));

    return uniqueAgentIds.map(agentId => overviewsById.get(agentId)!);
  }

  /**
   * Delete an Agent as ADMIN.
   *
   * The Agent does not own its assigned Session; deleting the Agent therefore
   * removes only the assignment/principal and leaves the Session intact.
   */
  async deleteAdminAgent(
    agentId: string,
  ): Promise<void> {
    const agent = await this.agentRepository.findOne({
      where: {
        id: agentId,
      },
    });

    if (!agent) {
      throw new NotFoundException('Agent not found');
    }

    const keyIds = await this.getAgentApiKeyIds([agentId]);

    await this.mainDataSource.transaction(async manager => {
      const agentRepository = manager.getRepository(Agent);
      const current = await agentRepository.findOne({
        where: {
          id: agentId,
        },
      });

      if (!current) {
        throw new NotFoundException('Agent not found');
      }

      await agentRepository.remove(current);
    });

    this.evictApiKeys(keyIds, 'deleted');

    this.logger.log(`Agent deleted by ADMIN: ${agent.name}`, {
      agentId: agent.id,
      teamLeaderId: agent.teamLeaderId,
      assignedSessionId: agent.assignedSessionId,
      action: 'admin_agent_deleted',
    });
  }

  /** List only Agents owned by the specified Team Leader. */
  async listAgents(
    teamLeaderId: string,
  ): Promise<Agent[]> {
    await this.getTeamLeader(teamLeaderId);

    return this.agentRepository.find({
      where: {
        teamLeaderId,
      },
      order: {
        createdAt: 'DESC',
      },
    });
  }

  /** Resolve an Agent while enforcing Team Leader ownership. */
  async getAgentForTeamLeader(
    teamLeaderId: string,
    agentId: string,
  ): Promise<Agent> {
    const agent = await this.agentRepository.findOne({
      where: {
        id: agentId,
        teamLeaderId,
      },
    });

    if (!agent) {
      throw new NotFoundException('Agent not found');
    }

    return agent;
  }

  /** Resolve the authenticated Agent identity. */
  async getAgentIdentity(
    agentId: string,
  ): Promise<Agent> {
    const agent = await this.agentRepository.findOne({
      where: {
        id: agentId,
      },
    });

    if (!agent) {
      throw new NotFoundException('Agent not found');
    }

    return agent;
  }

  /** Delete an Agent belonging to the authenticated Team Leader. */
  async deleteAgent(
    teamLeaderId: string,
    agentId: string,
  ): Promise<void> {
    const agent = await this.getAgentForTeamLeader(teamLeaderId, agentId);
    const keyIds = await this.getAgentApiKeyIds([agent.id]);

    await this.mainDataSource.transaction(async manager => {
      const agentRepository = manager.getRepository(Agent);
      const current = await agentRepository.findOne({
        where: {
          id: agentId,
          teamLeaderId,
        },
      });

      if (!current) {
        throw new NotFoundException('Agent not found');
      }

      await agentRepository.remove(current);
    });

    this.evictApiKeys(keyIds, 'deleted');

    this.logger.log(`Agent deleted: ${agent.name}`, {
      agentId: agent.id,
      teamLeaderId,
      action: 'agent_deleted',
    });
  }

  /**
   * Assign or unassign an Agent's WhatsApp Session.
   *
   * For a non-null assignment both the Agent and Session must belong to the
   * authenticated Team Leader. A Session may be assigned to at most one Agent.
   */
  async assignAgentSession(
    teamLeaderId: string,
    agentId: string,
    sessionId: string | null,
  ): Promise<Agent> {
    const agent = await this.getAgentForTeamLeader(teamLeaderId, agentId);

    if (sessionId !== null) {
      const session = await this.sessionRepository.findOne({
        where: {
          id: sessionId,
          ownerTeamLeaderId: teamLeaderId,
        },
      });

      if (!session) {
        throw new NotFoundException('Session not found');
      }

      const existingAssignment = await this.agentRepository.findOne({
        where: {
          assignedSessionId: sessionId,
        },
      });

      if (existingAssignment && existingAssignment.id !== agent.id) {
        throw new ConflictException(
          'Session is already assigned to another Agent',
        );
      }
    }

    const previousSessionId = agent.assignedSessionId;

    if (previousSessionId === sessionId) {
      return agent;
    }

    agent.assignedSessionId = sessionId;
    const saved = await this.agentRepository.save(agent);

    const keyIds = await this.getAgentApiKeyIds([agent.id]);
    this.evictApiKeys(keyIds, 'authorization_changed');

    this.logger.log(
      sessionId === null
        ? `Agent session unassigned: ${saved.name}`
        : `Agent session assigned: ${saved.name}`,
      {
        agentId: saved.id,
        teamLeaderId: saved.teamLeaderId,
        previousSessionId,
        newSessionId: sessionId,
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

  /** Convenience wrapper for an explicit unassign operation. */
  async unassignAgentSession(
    teamLeaderId: string,
    agentId: string,
  ): Promise<Agent> {
    return this.assignAgentSession(teamLeaderId, agentId, null);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async buildAdminAgentOverviews(
    agents: Agent[],
  ): Promise<AdminAgentOverview[]> {
    if (agents.length === 0) {
      return [];
    }

    const assignedSessionIds = [
      ...new Set(
        agents
          .map(agent => agent.assignedSessionId)
          .filter((sessionId): sessionId is string => sessionId !== null),
      ),
    ];

    let sessions: Session[] = [];

    if (assignedSessionIds.length > 0) {
      sessions = await this.sessionRepository.find({
        where: {
          id: In(assignedSessionIds),
        },
      });
    }

    const sessionsById = new Map(
      sessions.map(session => [session.id, session]),
    );

    return agents.map(agent => {
      if (!agent.teamLeader) {
        throw new ConflictException(
          `Agent ${agent.id} has no resolvable Team Leader relation`,
        );
      }

      const assignedSession = agent.assignedSessionId
        ? sessionsById.get(agent.assignedSessionId) ?? null
        : null;

      return {
        id: agent.id,
        name: agent.name,
        email: agent.email,
        teamLeaderId: agent.teamLeaderId,
        teamLeader: {
          id: agent.teamLeader.id,
          name: agent.teamLeader.name,
          email: agent.teamLeader.email,
        },
        assignedSessionId: agent.assignedSessionId,
        assignedSession: assignedSession
          ? {
              id: assignedSession.id,
              name: assignedSession.name,
              status: assignedSession.status,
              phone: assignedSession.phone,
              targetPhone: assignedSession.targetPhone,
            }
          : null,
        templateSendLimit24h: agent.templateSendLimit24h,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      };
    });
  }

  private async getAdminAgentsByIds(
    agentIds: readonly string[],
  ): Promise<AdminAgentOverview[]> {
    if (agentIds.length === 0) {
      return [];
    }

    const agents = await this.agentRepository.find({
      where: {
        id: In([...agentIds]),
      },
      relations: {
        teamLeader: true,
      },
    });

    return this.buildAdminAgentOverviews(agents);
  }

  private toAdminSessionOverview(
    session: Session,
  ): AdminSessionOverview {
    return {
      id: session.id,
      name: session.name,
      ownerTeamLeaderId: session.ownerTeamLeaderId,
      status: session.status,
      phone: session.phone,
      targetPhone: session.targetPhone,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  /**
   * Get every management credential that will disappear if the Team Leader
   * principal is deleted.
   */
  private async getTeamLeaderCredentialIds(
    teamLeaderId: string,
  ): Promise<string[]> {
    const agents = await this.agentRepository.find({
      where: {
        teamLeaderId,
      },
      select: {
        id: true,
      },
    });

    const directKeyIds = await this.getTeamLeaderApiKeyIds([teamLeaderId]);
    const agentKeyIds = await this.getAgentApiKeyIds(
      agents.map(agent => agent.id),
    );

    return [...new Set([...directKeyIds, ...agentKeyIds])];
  }

  private async getTeamLeaderApiKeyIds(
    teamLeaderIds: readonly string[],
  ): Promise<string[]> {
    if (teamLeaderIds.length === 0) {
      return [];
    }

    const keys = await this.apiKeyRepository.find({
      where: {
        teamLeaderId: In([...teamLeaderIds]),
        role: ApiKeyRole.TEAM_LEADER,
      },
      select: {
        id: true,
      },
    });

    return keys.map(key => key.id);
  }

  private async getAgentApiKeyIds(
    agentIds: readonly string[],
  ): Promise<string[]> {
    if (agentIds.length === 0) {
      return [];
    }

    const keys = await this.apiKeyRepository.find({
      where: {
        agentId: In([...agentIds]),
        role: ApiKeyRole.AGENT,
      },
      select: {
        id: true,
      },
    });

    return keys.map(key => key.id);
  }

  /** Best-effort WebSocket eviction after authorization changes. */
  private evictApiKeys(
    keyIds: readonly string[],
    reason: ApiKeyEvictionReason,
  ): void {
    if (keyIds.length === 0) {
      return;
    }

    try {
      const gateway = this.moduleRef.get(EventsGateway, {
        strict: false,
      });

      if (!gateway) {
        return;
      }

      for (const keyId of keyIds) {
        gateway.evictApiKey(keyId, reason);
      }
    } catch (error) {
      this.logger.warn(
        'Failed to evict WebSocket connections after Team Leader authorization change',
        {
          keyIds: [...keyIds],
          reason,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  private normalizeOptionalEmail(
    email: string | null | undefined,
  ): string | null {
    if (email == null) {
      return null;
    }

    const normalized = this.normalizeEmail(email);
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeEmail(
    email: string,
  ): string {
    return email.trim().toLowerCase();
  }

  /** Handle the unique-constraint race on Team Leader email creation. */
  private isUniqueConstraintError(
    error: unknown,
  ): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }

    const driverError = (
      error as QueryFailedError & {
        driverError?: {
          code?: string;
          errno?: number;
          message?: string;
        };
      }
    ).driverError;

    const code = driverError?.code ?? '';
    const message = driverError?.message ?? error.message ?? '';

    return (
      code === 'SQLITE_CONSTRAINT' ||
      code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      code === '23505' ||
      message.toLowerCase().includes('unique constraint')
    );
  }
}
