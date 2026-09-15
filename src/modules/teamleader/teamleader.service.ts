import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
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
import { SessionService } from '../session/session.service';

import { CreateAgentDto } from './dto/create-agent.dto';
import { CreateTeamLeaderDto } from './dto/create-team-leader.dto';
import { RetireTeamLeaderDto } from './dto/retire-team-leader.dto';
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

/**
 * Compact authoritative resource counts for the global Team Leader inventory.
 *
 * Counts are produced directly from the management principal/session stores
 * rather than from the generic Session list endpoint, so pagination or
 * dashboard filtering cannot make the Admin table under-count ownership.
 */
export interface AdminTeamLeaderResourceSummary {
  totals: {
    teamLeaderCount: number;
    sessionCount: number;
    agentCount: number;
    unassignedSessionCount: number;
  };
  teamLeaders: Array<{
    teamLeaderId: string;
    sessionCount: number;
    agentCount: number;
    unassignedSessionCount: number;
  }>;
}

/**
 * Summary returned by the destructive Admin/Operator force-delete flow.
 *
 * Session deletion is intentionally delegated to SessionService so runtime
 * engines, browser profiles, ownership claims, and cross-database Agent
 * assignments are retired through the normal Session lifecycle.
 */
export interface ForceDeleteTeamLeaderResult {
  teamLeaderId: string;
  teamLeaderName: string;
  deletedSessionIds: string[];
  deletedAgentIds: string[];
}

export interface RetireTeamLeaderResult {
  teamLeaderId: string;
  teamLeaderName: string;
  delegatedSessionIds: string[];
  delegatedAgentIds: string[];
  preservedAgentSessionAssignments: number;
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

    /**
     * Full Session lifecycle owner used only by destructive Team Leader
     * retirement. It is optional here so direct-construction unit tests that
     * exercise the non-destructive TeamLeaderService surface remain source-
     * compatible; TeamLeaderModule provides it in the running application.
     *
     * Keep this optional dependency last: TypeScript does not allow a required
     * constructor parameter after an optional parameter.
     */
    @Optional()
    private readonly sessionService?: SessionService,
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
   * Return authoritative resource counts for every Team Leader in one
   * management request.
   *
   * Team Leader / Agent rows live in `main` and Session rows live in `data`,
   * so the service performs one read per store and aggregates in memory. This
   * avoids the N+1 request pattern that would result from asking the dashboard
   * to fetch /:id/resources for every Team Leader.
   *
   * `unassignedSessionCount` means a Session has a Team Leader owner but no
   * Agent currently references that Session through assignedSessionId.
   */
  async getAdminTeamLeaderResourceSummary(): Promise<AdminTeamLeaderResourceSummary> {
    const [teamLeaders, sessions, agents] = await Promise.all([
      this.teamLeaderRepository.find({
        select: {
          id: true,
        },
      }),
      this.sessionRepository.find({
        select: {
          id: true,
          ownerTeamLeaderId: true,
        },
      }),
      this.agentRepository.find({
        select: {
          id: true,
          teamLeaderId: true,
          assignedSessionId: true,
        },
      }),
    ]);

    const teamLeaderIds =
      new Set(
        teamLeaders.map(
          teamLeader => teamLeader.id,
        ),
      );

    const countsByTeamLeaderId =
      new Map<
        string,
        {
          sessionCount: number;
          agentCount: number;
          unassignedSessionCount: number;
        }
      >(
        teamLeaders.map(
          teamLeader => [
            teamLeader.id,
            {
              sessionCount: 0,
              agentCount: 0,
              unassignedSessionCount: 0,
            },
          ],
        ),
      );

    const assignedSessionIds =
      new Set(
        agents
          .map(
            agent => agent.assignedSessionId,
          )
          .filter(
            (
              sessionId,
            ): sessionId is string =>
              sessionId !== null,
          ),
      );

    for (const agent of agents) {
      const counts =
        countsByTeamLeaderId.get(
          agent.teamLeaderId,
        );

      if (counts) {
        counts.agentCount += 1;
      }
    }

    let sessionCount = 0;
    let unassignedSessionCount = 0;

    for (const session of sessions) {
      const ownerTeamLeaderId =
        session.ownerTeamLeaderId;

      if (
        !ownerTeamLeaderId ||
        !teamLeaderIds.has(
          ownerTeamLeaderId,
        )
      ) {
        continue;
      }

      const counts =
        countsByTeamLeaderId.get(
          ownerTeamLeaderId,
        );

      if (!counts) {
        continue;
      }

      counts.sessionCount += 1;
      sessionCount += 1;

      if (
        !assignedSessionIds.has(
          session.id,
        )
      ) {
        counts.unassignedSessionCount += 1;
        unassignedSessionCount += 1;
      }
    }

    return {
      totals: {
        teamLeaderCount: teamLeaders.length,
        sessionCount,
        agentCount: agents.filter(
          agent =>
            teamLeaderIds.has(
              agent.teamLeaderId,
            ),
        ).length,
        unassignedSessionCount,
      },
      teamLeaders: teamLeaders.map(
        teamLeader => {
          const counts =
            countsByTeamLeaderId.get(
              teamLeader.id,
            );

          return {
            teamLeaderId: teamLeader.id,
            sessionCount:
              counts?.sessionCount ?? 0,
            agentCount:
              counts?.agentCount ?? 0,
            unassignedSessionCount:
              counts?.unassignedSessionCount ?? 0,
          };
        },
      ),
    };
  }

  /**
   * Assign or change the Team Leader owner of one Session directly.
   *
   * This method also supports ADMIN-created Sessions whose
   * ownerTeamLeaderId is currently null.
   *
   * If an Agent is already assigned to the Session, the target Team Leader
   * must be that Agent's Team Leader. Moving an assigned Session across Team
   * Leaders must go through assignAdminAgentSession(), which updates both the
   * Agent assignment and Session ownership coherently.
   */
  async setAdminSessionOwner(
    sessionId: string,
    targetTeamLeaderId: string,
  ): Promise<AdminSessionOverview> {
    await this.getTeamLeader(targetTeamLeaderId);

    const session = await this.sessionRepository.findOne({
      where: {
        id: sessionId,
      },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    const assignedAgent = await this.agentRepository.findOne({
      where: {
        assignedSessionId: sessionId,
      },
      select: {
        id: true,
        teamLeaderId: true,
        assignedSessionId: true,
      },
    });

    if (
      assignedAgent &&
      assignedAgent.teamLeaderId !== targetTeamLeaderId
    ) {
      throw new ConflictException(
        'Session is assigned to an Agent belonging to another Team Leader; reassign the Session through the Agent assignment flow',
      );
    }

    const previousOwnerTeamLeaderId = session.ownerTeamLeaderId;

    if (previousOwnerTeamLeaderId === targetTeamLeaderId) {
      return this.toAdminSessionOverview(session);
    }

    const saved = await this.sessionRepository.manager.transaction(
      async manager => {
        const repository = manager.getRepository(Session);

        const current = await repository.findOne({
          where: {
            id: sessionId,
          },
        });

        if (!current) {
          throw new NotFoundException('Session not found');
        }

        if (
          current.ownerTeamLeaderId !== previousOwnerTeamLeaderId
        ) {
          throw new ConflictException(
            'Session ownership changed while the assignment was being prepared',
          );
        }

        current.ownerTeamLeaderId = targetTeamLeaderId;

        return repository.save(current);
      },
    );

    /**
     * Close the cross-database race where an Agent may have been assigned
     * after the pre-check but before the data-DB ownership update committed.
     */
    const assignmentAfterUpdate = await this.agentRepository.findOne({
      where: {
        assignedSessionId: sessionId,
      },
      select: {
        id: true,
        teamLeaderId: true,
        assignedSessionId: true,
      },
    });

    if (
      assignmentAfterUpdate &&
      assignmentAfterUpdate.teamLeaderId !== targetTeamLeaderId
    ) {
      await this.compensateSessionOwner(
        sessionId,
        targetTeamLeaderId,
        previousOwnerTeamLeaderId,
        'direct ADMIN Session ownership assignment',
      );

      throw new ConflictException(
        'Session became assigned to an Agent belonging to another Team Leader during ownership assignment; retry the operation',
      );
    }

    const affectedTeamLeaderIds = [
      previousOwnerTeamLeaderId,
      targetTeamLeaderId,
    ].filter(
      (value): value is string =>
        value !== null,
    );

    const [
      teamLeaderKeyIds,
      agentKeyIds,
    ] = await Promise.all([
      this.getTeamLeaderApiKeyIds(affectedTeamLeaderIds),
      assignmentAfterUpdate
        ? this.getAgentApiKeyIds([
            assignmentAfterUpdate.id,
          ])
        : Promise.resolve([]),
    ]);

    this.evictApiKeys(
      [
        ...new Set([
          ...teamLeaderKeyIds,
          ...agentKeyIds,
        ]),
      ],
      'authorization_changed',
    );

    this.logger.log(
      'Session Team Leader ownership assigned by ADMIN',
      {
        sessionId,
        previousOwnerTeamLeaderId,
        targetTeamLeaderId,
        assignedAgentId:
          assignmentAfterUpdate?.id ??
          null,
        action:
          'admin_session_owner_assigned',
      },
    );

    return this.toAdminSessionOverview(saved);
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


  /**
   * Delegate every current Team Leader resource according to a complete
   * retirement plan and then delete the now-empty Team Leader principal.
   *
   * TEAM_LEADER credentials represent a principal, so deleting one from the
   * dashboard must retire or delegate the principal instead of deleting only
   * the credential row.
   */
  async retireTeamLeader(
    teamLeaderId: string,
    dto: RetireTeamLeaderDto,
  ): Promise<RetireTeamLeaderResult> {
    const teamLeader = await this.getTeamLeader(teamLeaderId);
    const resources = await this.getAdminTeamLeaderResources(teamLeaderId);

    const sessionPlans = new Map(
      dto.sessionReassignments.map(item => [item.sessionId, item]),
    );
    const agentPlans = new Map(
      dto.agentReassignments.map(item => [item.agentId, item]),
    );

    const currentSessionIds = resources.sessions.map(session => session.id);
    const currentAgentIds = resources.agents.map(agent => agent.id);

    const planCoversExactly = (
      currentIds: readonly string[],
      plannedIds: readonly string[],
    ): boolean => {
      if (currentIds.length !== plannedIds.length) {
        return false;
      }

      const current = new Set(currentIds);
      return plannedIds.every(id => current.has(id));
    };

    if (
      !planCoversExactly(
        currentSessionIds,
        dto.sessionReassignments.map(item => item.sessionId),
      )
    ) {
      throw new ConflictException(
        'Retirement plan must include every Session currently owned by the Team Leader exactly once',
      );
    }

    if (
      !planCoversExactly(
        currentAgentIds,
        dto.agentReassignments.map(item => item.agentId),
      )
    ) {
      throw new ConflictException(
        'Retirement plan must include every Agent currently owned by the Team Leader exactly once',
      );
    }

    const targetTeamLeaderIds = [
      ...new Set([
        ...dto.sessionReassignments.map(item => item.targetTeamLeaderId),
        ...dto.agentReassignments.map(item => item.targetTeamLeaderId),
      ]),
    ];

    if (targetTeamLeaderIds.includes(teamLeaderId)) {
      throw new ConflictException(
        'A retiring Team Leader cannot be the destination of its own resources',
      );
    }

    await Promise.all(
      targetTeamLeaderIds.map(targetId => this.getTeamLeader(targetId)),
    );

    const originalAssignments = new Map(
      resources.agents.map(agent => [agent.id, agent.assignedSessionId]),
    );

    const preservedAssignments: Array<{
      agentId: string;
      sessionId: string;
    }> = [];

    for (const agent of resources.agents) {
      const plan = agentPlans.get(agent.id);

      if (!plan) {
        throw new ConflictException(
          `Retirement plan is missing Agent ${agent.id}`,
        );
      }

      if (!agent.assignedSessionId) {
        continue;
      }

      const sessionPlan = sessionPlans.get(agent.assignedSessionId);
      const assignmentCanSurvive =
        sessionPlan !== undefined &&
        sessionPlan.targetTeamLeaderId === plan.targetTeamLeaderId;

      if (!assignmentCanSurvive && !plan.unassignSession) {
        throw new ConflictException(
          `Agent ${agent.id} cannot keep Session ${agent.assignedSessionId} because the Agent and Session are not delegated to the same Team Leader`,
        );
      }

      if (assignmentCanSurvive && !plan.unassignSession) {
        preservedAssignments.push({
          agentId: agent.id,
          sessionId: agent.assignedSessionId,
        });
      }
    }

    const sessionGroups = new Map<string, string[]>();
    for (const item of dto.sessionReassignments) {
      const ids = sessionGroups.get(item.targetTeamLeaderId) ?? [];
      ids.push(item.sessionId);
      sessionGroups.set(item.targetTeamLeaderId, ids);
    }

    const agentGroups = new Map<string, string[]>();
    for (const item of dto.agentReassignments) {
      const ids = agentGroups.get(item.targetTeamLeaderId) ?? [];
      ids.push(item.agentId);
      agentGroups.set(item.targetTeamLeaderId, ids);
    }

    try {
      if (currentAgentIds.length > 0) {
        await this.mainDataSource.transaction(async manager => {
          const repository = manager.getRepository(Agent);
          const currentAgents = await repository.find({
            where: {
              id: In(currentAgentIds),
              teamLeaderId,
            },
          });

          if (currentAgents.length !== currentAgentIds.length) {
            throw new ConflictException(
              'Agent ownership changed while the retirement plan was being prepared',
            );
          }

          for (const agent of currentAgents) {
            agent.assignedSessionId = null;
          }

          if (currentAgents.length > 0) {
            await repository.save(currentAgents);
          }
        });

        const agentKeyIds = await this.getAgentApiKeyIds(currentAgentIds);
        this.evictApiKeys(agentKeyIds, 'authorization_changed');
      }

      for (const [targetTeamLeaderId, sessionIds] of sessionGroups) {
        if (sessionIds.length > 0) {
          await this.reassignAdminSessions(
            teamLeaderId,
            sessionIds,
            targetTeamLeaderId,
          );
        }
      }

      for (const [targetTeamLeaderId, agentIds] of agentGroups) {
        if (agentIds.length > 0) {
          await this.reassignAdminAgents(
            agentIds,
            targetTeamLeaderId,
            true,
          );
        }
      }

      for (const assignment of preservedAssignments) {
        await this.assignAdminAgentSession(
          assignment.agentId,
          assignment.sessionId,
        );
      }

      const [remainingSessionCount, remainingAgentCount] = await Promise.all([
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

      if (remainingSessionCount > 0 || remainingAgentCount > 0) {
        throw new ConflictException(
          'Team Leader resources changed during retirement; retry after concurrent changes stop',
        );
      }

      await this.deleteTeamLeader(teamLeaderId);
    } catch (error) {
      try {
        if (currentAgentIds.length > 0) {
          await this.mainDataSource.transaction(async manager => {
            const repository = manager.getRepository(Agent);
            const currentAgents = await repository.find({
              where: {
                id: In(currentAgentIds),
              },
            });

            for (const agent of currentAgents) {
              agent.teamLeaderId = teamLeaderId;
              agent.assignedSessionId = null;
            }

            if (currentAgents.length > 0) {
              await repository.save(currentAgents);
            }
          });
        }

        if (currentSessionIds.length > 0) {
          await this.sessionRepository.manager.transaction(async manager => {
            const repository = manager.getRepository(Session);
            const currentSessions = await repository.find({
              where: {
                id: In(currentSessionIds),
              },
            });

            for (const session of currentSessions) {
              session.ownerTeamLeaderId = teamLeaderId;
            }

            if (currentSessions.length > 0) {
              await repository.save(currentSessions);
            }
          });
        }

        if (currentAgentIds.length > 0) {
          await this.mainDataSource.transaction(async manager => {
            const repository = manager.getRepository(Agent);
            const currentAgents = await repository.find({
              where: {
                id: In(currentAgentIds),
                teamLeaderId,
              },
            });

            for (const agent of currentAgents) {
              agent.assignedSessionId =
                originalAssignments.get(agent.id) ?? null;
            }

            if (currentAgents.length > 0) {
              await repository.save(currentAgents);
            }
          });

          const agentKeyIds = await this.getAgentApiKeyIds(currentAgentIds);
          this.evictApiKeys(agentKeyIds, 'authorization_changed');
        }

        const teamLeaderKeyIds = await this.getTeamLeaderApiKeyIds([
          teamLeaderId,
          ...targetTeamLeaderIds,
        ]);
        this.evictApiKeys(teamLeaderKeyIds, 'authorization_changed');
      } catch (rollbackError) {
        this.logger.error(
          'Failed to fully compensate Team Leader retirement',
          rollbackError instanceof Error
            ? rollbackError.stack
            : undefined,
          {
            teamLeaderId,
            error:
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError),
            action: 'team_leader_retirement_compensation_failed',
          },
        );
      }

      throw error;
    }

    this.logger.log(
      `Team Leader retired after resource delegation: ${teamLeader.name}`,
      {
        teamLeaderId,
        delegatedSessionIds: currentSessionIds,
        delegatedAgentIds: currentAgentIds,
        preservedAgentSessionAssignments: preservedAssignments.length,
        action: 'team_leader_retired',
      },
    );

    return {
      teamLeaderId,
      teamLeaderName: teamLeader.name,
      delegatedSessionIds: currentSessionIds,
      delegatedAgentIds: currentAgentIds,
      preservedAgentSessionAssignments: preservedAssignments.length,
    };
  }

  /**
   * Permanently delete a Team Leader and every resource owned by that
   * principal.
   *
   * This is deliberately separate from deleteTeamLeader(), which remains the
   * safe/default operation and still refuses to delete a non-empty principal.
   *
   * Cross-database deletion cannot be atomic because Sessions live in `data`
   * while Team Leader / Agent principals and credentials live in `main`.
   * Therefore the destructive flow is ordered fail-safe:
   *
   * 1. Delete every owned Session through SessionService.delete().
   * 2. Only after all Session lifecycle deletions succeed, delete Agents and
   *    the Team Leader together in one main-database transaction.
   * 3. Evict every affected principal credential from WebSocket state.
   *
   * If a Session deletion fails, the Team Leader and Agents are intentionally
   * left intact so the operation can be inspected/retried instead of silently
   * orphaning management principals.
   */
  async forceDeleteTeamLeader(
    teamLeaderId: string,
  ): Promise<ForceDeleteTeamLeaderResult> {
    const teamLeader = await this.getTeamLeader(teamLeaderId);

    if (!this.sessionService) {
      throw new InternalServerErrorException(
        'Session lifecycle service is unavailable for force deletion',
      );
    }

    const deletedSessionIds: string[] = [];

    /**
     * Re-read the owned Session set after each pass. This closes the common
     * cross-database race where an ownership change lands while the destructive
     * operation is already running. Five passes is intentionally bounded so a
     * continuously-mutating installation cannot hold the request forever.
     */
    const maxSessionDeletePasses = 5;

    for (let pass = 0; pass < maxSessionDeletePasses; pass += 1) {
      const sessions = await this.sessionRepository.find({
        where: {
          ownerTeamLeaderId: teamLeaderId,
        },
        order: {
          createdAt: 'ASC',
        },
      });

      if (sessions.length === 0) {
        break;
      }

      for (const session of sessions) {
        try {
          await this.sessionService.delete(session.id);
          deletedSessionIds.push(session.id);
        } catch (error) {
          if (error instanceof NotFoundException) {
            // The Session disappeared after the ownership snapshot. Treat it
            // as already retired and continue with the current resource graph.
            continue;
          }

          this.logger.error(
            'Force Team Leader deletion stopped because a Session could not be deleted',
            error instanceof Error ? error.message : String(error),
            {
              teamLeaderId,
              sessionId: session.id,
              deletedSessionIds,
              action: 'team_leader_force_delete_session_failed',
            },
          );

          throw error;
        }
      }
    }

    const remainingSessionCount = await this.sessionRepository.count({
      where: {
        ownerTeamLeaderId: teamLeaderId,
      },
    });

    if (remainingSessionCount > 0) {
      throw new ConflictException(
        'Team Leader resources changed repeatedly during force deletion; retry after concurrent Session changes stop',
      );
    }

    const mainDeletion = await this.mainDataSource.transaction(async manager => {
      const teamLeaderRepository = manager.getRepository(TeamLeader);
      const agentRepository = manager.getRepository(Agent);
      const apiKeyRepository = manager.getRepository(ApiKey);

      const currentTeamLeader = await teamLeaderRepository.findOne({
        where: {
          id: teamLeaderId,
        },
      });

      if (!currentTeamLeader) {
        throw new NotFoundException('Team Leader not found');
      }

      const agents = await agentRepository.find({
        where: {
          teamLeaderId,
        },
        select: {
          id: true,
          name: true,
        },
      });

      const agentIds = agents.map(agent => agent.id);

      const keyWhere = [
        {
          teamLeaderId,
        },
        ...(agentIds.length > 0
          ? [
              {
                agentId: In(agentIds),
              },
            ]
          : []),
      ];

      const keys = await apiKeyRepository.find({
        where: keyWhere,
        select: {
          id: true,
        },
      });

      /**
       * AgentTemplateSendUsage and principal API keys are FK-cascaded from
       * Agent/TeamLeader rows in the main database.
       */
      if (agentIds.length > 0) {
        await agentRepository.delete({
          id: In(agentIds),
        });
      }

      await teamLeaderRepository.remove(currentTeamLeader);

      return {
        agentIds,
        keyIds: keys.map(key => key.id),
      };
    });

    this.evictApiKeys(mainDeletion.keyIds, 'deleted');

    this.logger.warn(
      `Team Leader force-deleted with all resources: ${teamLeader.name}`,
      {
        teamLeaderId,
        deletedSessionCount: deletedSessionIds.length,
        deletedAgentCount: mainDeletion.agentIds.length,
        deletedSessionIds,
        deletedAgentIds: mainDeletion.agentIds,
        action: 'team_leader_force_deleted',
      },
    );

    return {
      teamLeaderId,
      teamLeaderName: teamLeader.name,
      deletedSessionIds,
      deletedAgentIds: mainDeletion.agentIds,
    };
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
   * Assign or unassign a Session for one Agent as ADMIN.
   *
   * A non-null assignment makes the Agent's Team Leader authoritative for
   * Session ownership:
   *
   *   Session.ownerTeamLeaderId = Agent.teamLeaderId
   *
   * If another Agent currently holds the Session assignment, that Agent is
   * explicitly unassigned in the same main-database transaction that assigns
   * the target Agent. The Session itself is never deleted.
   *
   * Because Agent rows and Session rows live in different databases, the
   * ownership update is committed first and is compensated on a subsequent
   * main-database failure.
   *
   * sessionId === null removes only the Agent assignment. It deliberately
   * preserves the Session's Team Leader owner.
   */
  async assignAdminAgentSession(
    agentId: string,
    sessionId: string | null,
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

    if (sessionId === null) {
      if (agent.assignedSessionId === null) {
        const [overview] =
          await this.buildAdminAgentOverviews([
            agent,
          ]);

        return overview;
      }

      const previousSessionId =
        agent.assignedSessionId;

      await this.mainDataSource.transaction(
        async manager => {
          const repository =
            manager.getRepository(Agent);

          const current =
            await repository.findOne({
              where: {
                id: agentId,
              },
            });

          if (!current) {
            throw new NotFoundException(
              'Agent not found',
            );
          }

          if (
            current.assignedSessionId ===
            null
          ) {
            return;
          }

          current.assignedSessionId =
            null;

          await repository.save(current);
        },
      );

      const keyIds =
        await this.getAgentApiKeyIds([
          agentId,
        ]);

      this.evictApiKeys(
        keyIds,
        'authorization_changed',
      );

      this.logger.log(
        'Agent Session unassigned by ADMIN',
        {
          agentId,
          teamLeaderId:
            agent.teamLeaderId,
          previousSessionId,
          action:
            'admin_agent_session_unassigned',
        },
      );

      return this.getAdminAgent(agentId);
    }

    const session =
      await this.sessionRepository.findOne({
        where: {
          id: sessionId,
        },
      });

    if (!session) {
      throw new NotFoundException(
        'Session not found',
      );
    }

    /**
     * Main-DB FK integrity should already guarantee this Team Leader exists,
     * but resolving it explicitly makes a stale/corrupt principal fail closed.
     */
    await this.getTeamLeader(
      agent.teamLeaderId,
    );

    const targetTeamLeaderId =
      agent.teamLeaderId;

    const previousOwnerTeamLeaderId =
      session.ownerTeamLeaderId;

    const existingAssignments =
      await this.agentRepository.find({
        where: {
          assignedSessionId:
            sessionId,
        },
        select: {
          id: true,
          teamLeaderId: true,
          assignedSessionId: true,
        },
      });

    const onlyTargetAlreadyAssigned =
      existingAssignments.length === 1 &&
      existingAssignments[0].id ===
        agentId;

    if (
      agent.assignedSessionId ===
        sessionId &&
      session.ownerTeamLeaderId ===
        targetTeamLeaderId &&
      onlyTargetAlreadyAssigned
    ) {
      const [overview] =
        await this.buildAdminAgentOverviews([
          agent,
        ]);

      return overview;
    }

    let ownerChanged = false;

    if (
      previousOwnerTeamLeaderId !==
      targetTeamLeaderId
    ) {
      await this.sessionRepository.manager.transaction(
        async manager => {
          const repository =
            manager.getRepository(
              Session,
            );

          const current =
            await repository.findOne({
              where: {
                id:
                  sessionId,
              },
            });

          if (!current) {
            throw new NotFoundException(
              'Session not found',
            );
          }

          if (
            current.ownerTeamLeaderId !==
            previousOwnerTeamLeaderId
          ) {
            throw new ConflictException(
              'Session ownership changed while the Agent assignment was being prepared',
            );
          }

          current.ownerTeamLeaderId =
            targetTeamLeaderId;

          await repository.save(
            current,
          );
        },
      );

      ownerChanged = true;
    }

    let changedAgentIds: string[] = [];
    let previousAgentAssignments: Array<{
      id: string;
      assignedSessionId: string | null;
    }> = [];
    let targetPreviousSessionId =
      agent.assignedSessionId;

    try {
      const assignmentResult =
        await this.mainDataSource.transaction(
          async manager => {
            const repository =
              manager.getRepository(
                Agent,
              );

            const targetAgent =
              await repository.findOne({
                where: {
                  id:
                    agentId,
                },
              });

            if (!targetAgent) {
              throw new NotFoundException(
                'Agent not found',
              );
            }

            /**
             * The Agent may itself have moved Team Leaders concurrently.
             * Do not silently bind a Session to stale ownership information.
             */
            if (
              targetAgent.teamLeaderId !==
              targetTeamLeaderId
            ) {
              throw new ConflictException(
                'Agent Team Leader changed while the Session assignment was being prepared',
              );
            }

            targetPreviousSessionId =
              targetAgent.assignedSessionId;

            const currentAssignees =
              await repository.find({
                where: {
                  assignedSessionId:
                    sessionId,
                },
              });

            const changedIds =
              new Set<string>([
                targetAgent.id,
              ]);

            const previousAssignments =
              new Map<
                string,
                string | null
              >();

            previousAssignments.set(
              targetAgent.id,
              targetAgent.assignedSessionId,
            );

            for (
              const currentAssignee of
              currentAssignees
            ) {
              if (
                !previousAssignments.has(
                  currentAssignee.id,
                )
              ) {
                previousAssignments.set(
                  currentAssignee.id,
                  currentAssignee.assignedSessionId,
                );
              }
              if (
                currentAssignee.id ===
                targetAgent.id
              ) {
                continue;
              }

              currentAssignee.assignedSessionId =
                null;

              changedIds.add(
                currentAssignee.id,
              );
            }

            targetAgent.assignedSessionId =
              sessionId;

            const entitiesById =
              new Map<string, Agent>();

            for (
              const currentAssignee of
              currentAssignees
            ) {
              entitiesById.set(
                currentAssignee.id,
                currentAssignee,
              );
            }

            entitiesById.set(
              targetAgent.id,
              targetAgent,
            );

            await repository.save([
              ...entitiesById.values(),
            ]);

            return {
              changedAgentIds: [
                ...changedIds,
              ],
              previousAssignments: [
                ...previousAssignments.entries(),
              ].map(
                ([
                  id,
                  assignedSessionId,
                ]) => ({
                  id,
                  assignedSessionId,
                }),
              ),
            };
          },
        );

      changedAgentIds =
        assignmentResult.changedAgentIds;
      previousAgentAssignments =
        assignmentResult.previousAssignments;
    } catch (error) {
      if (ownerChanged) {
        await this.compensateSessionOwner(
          sessionId,
          targetTeamLeaderId,
          previousOwnerTeamLeaderId,
          'ADMIN Agent Session assignment',
        );
      }

      throw error;
    }

    /**
     * Validate the invariant after both database mutations. If a concurrent
     * ownership change occurred after our data-DB commit, fail closed rather
     * than returning an apparently valid assignment.
     */
    const finalSession =
      await this.sessionRepository.findOne({
        where: {
          id:
            sessionId,
        },
      });

    if (
      !finalSession ||
      finalSession.ownerTeamLeaderId !==
        targetTeamLeaderId
    ) {
      await this.compensateAgentAssignments(
        previousAgentAssignments,
        agentId,
        sessionId,
        'ADMIN Agent Session assignment post-check',
      );

      if (!finalSession) {
        throw new NotFoundException(
          'Session not found',
        );
      }

      throw new ConflictException(
        'Session ownership changed concurrently after Agent assignment; retry the operation',
      );
    }

    const affectedTeamLeaderIds = [
      previousOwnerTeamLeaderId,
      targetTeamLeaderId,
    ].filter(
      (value): value is string =>
        value !== null,
    );

    const [
      agentKeyIds,
      teamLeaderKeyIds,
    ] = await Promise.all([
      this.getAgentApiKeyIds(
        changedAgentIds,
      ),
      ownerChanged
        ? this.getTeamLeaderApiKeyIds(
            affectedTeamLeaderIds,
          )
        : Promise.resolve([]),
    ]);

    this.evictApiKeys(
      [
        ...new Set([
          ...agentKeyIds,
          ...teamLeaderKeyIds,
        ]),
      ],
      'authorization_changed',
    );

    this.logger.log(
      'Agent Session assigned by ADMIN',
      {
        agentId,
        sessionId,
        targetTeamLeaderId,
        previousOwnerTeamLeaderId,
        previousAgentSessionId:
          targetPreviousSessionId,
        displacedAgentIds:
          changedAgentIds.filter(
            id => id !== agentId,
          ),
        action:
          'admin_agent_session_assigned',
      },
    );

    return this.getAdminAgent(agentId);
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

  /**
   * Best-effort compensation for the main-DB side of an ADMIN Session
   * assignment when the cross-database post-check fails.
   *
   * Compensation is guarded so it only rewrites rows that still look like
   * the mutation performed by assignAdminAgentSession().
   */
  private async compensateAgentAssignments(
    previousAssignments: ReadonlyArray<{
      id: string;
      assignedSessionId: string | null;
    }>,
    targetAgentId: string,
    assignedSessionId: string,
    operation: string,
  ): Promise<void> {
    if (previousAssignments.length === 0) {
      return;
    }

    try {
      await this.mainDataSource.transaction(
        async manager => {
          const repository =
            manager.getRepository(
              Agent,
            );

          const ids =
            previousAssignments.map(
              item => item.id,
            );

          const currentAgents =
            await repository.find({
              where: {
                id: In(ids),
              },
            });

          const previousById =
            new Map(
              previousAssignments.map(
                item => [
                  item.id,
                  item.assignedSessionId,
                ],
              ),
            );

          const toSave: Agent[] = [];

          for (
            const currentAgent of
            currentAgents
          ) {
            const expectedCurrentAssignment =
              currentAgent.id ===
              targetAgentId
                ? assignedSessionId
                : null;

            if (
              currentAgent.assignedSessionId !==
              expectedCurrentAssignment
            ) {
              continue;
            }

            currentAgent.assignedSessionId =
              previousById.get(
                currentAgent.id,
              ) ??
              null;

            toSave.push(
              currentAgent,
            );
          }

          if (toSave.length > 0) {
            await repository.save(
              toSave,
            );
          }
        },
      );
    } catch (rollbackError) {
      this.logger.error(
        'Failed to compensate Agent assignments after cross-database management failure',
        rollbackError instanceof Error
          ? rollbackError.stack
          : undefined,
        {
          targetAgentId,
          assignedSessionId,
          operation,
          affectedAgentIds:
            previousAssignments.map(
              item => item.id,
            ),
          error:
            rollbackError instanceof Error
              ? rollbackError.message
              : String(
                  rollbackError,
                ),
        },
      );
    }
  }

  /**
   * Best-effort compensation for a data-DB Session ownership mutation that
   * must be reverted after a later cross-database step fails.
   *
   * The expected-owner predicate prevents this helper from overwriting a
   * clearly different ownership state written after the operation began.
   */
  private async compensateSessionOwner(
    sessionId: string,
    expectedOwnerTeamLeaderId: string,
    restoreOwnerTeamLeaderId: string | null,
    operation: string,
  ): Promise<void> {
    try {
      await this.sessionRepository.manager.transaction(
        async manager => {
          const repository =
            manager.getRepository(
              Session,
            );

          const current =
            await repository.findOne({
              where: {
                id:
                  sessionId,
                ownerTeamLeaderId:
                  expectedOwnerTeamLeaderId,
              },
            });

          if (!current) {
            return;
          }

          current.ownerTeamLeaderId =
            restoreOwnerTeamLeaderId;

          await repository.save(
            current,
          );
        },
      );
    } catch (rollbackError) {
      this.logger.error(
        'Failed to compensate Session ownership after cross-database management failure',
        rollbackError instanceof Error
          ? rollbackError.stack
          : undefined,
        {
          sessionId,
          expectedOwnerTeamLeaderId,
          restoreOwnerTeamLeaderId,
          operation,
          error:
            rollbackError instanceof Error
              ? rollbackError.message
              : String(
                  rollbackError,
                ),
        },
      );
    }
  }

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
