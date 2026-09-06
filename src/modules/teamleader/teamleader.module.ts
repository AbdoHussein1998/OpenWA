




import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { ApiKey } from '../auth/entities/api-key.entity';

import { Session } from '../session/entities/session.entity';

import { TeamLeader } from './entities/team-leader.entity';
import { Agent } from './entities/agent.entity';

import { TeamLeaderService } from './teamleader.service';

import { AdminTeamLeaderController } from './admin-teamleader.controller';
import { TeamLeaderController } from './teamleader.controller';
import { AgentController } from './agent.controller';

@Module({
  imports: [
    /**
     * Management identities and their API credentials live in the
     * `main` database.
     */
    TypeOrmModule.forFeature(
      [
        TeamLeader,
        Agent,
        ApiKey,
      ],
      'main',
    ),

    /**
     * WhatsApp sessions live in the separate `data` database.
     *
     * TeamLeaderService needs the Session repository for:
     *
     * - verifying session ownership before Agent assignment
     * - preventing deletion of a Team Leader that still owns sessions
     */
    TypeOrmModule.forFeature(
      [
        Session,
      ],
      'data',
    ),

    /**
     * AuthModule exports AuthService.
     *
     * TeamLeaderService uses AuthService.createApiKeyInTransaction()
     * to provision TEAM_LEADER / AGENT credentials atomically with
     * their principal rows.
     */
    AuthModule,
  ],

  controllers: [
    AdminTeamLeaderController,
    TeamLeaderController,
    AgentController,
  ],

  providers: [
    TeamLeaderService,
  ],

  /**
   * Export the service so other modules can use Team Leader / Agent
   * management operations without duplicating repository logic.
   */
  exports: [
    TeamLeaderService,
  ],
})
export class TeamLeaderModule {}


