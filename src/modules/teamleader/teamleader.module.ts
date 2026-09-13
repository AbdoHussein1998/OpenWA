



import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { ApiKey } from '../auth/entities/api-key.entity';

import { Session } from '../session/entities/session.entity';

import { AdminAgentController } from './admin-agent.controller';
import { AdminTeamLeaderController } from './admin-teamleader.controller';
import { AgentController } from './agent.controller';
import { AgentTemplateQuotaService } from './agent-template-quota.service';
import { AgentTemplateSendUsage } from './entities/agent-template-send-usage.entity';
import { Agent } from './entities/agent.entity';
import { TeamLeader } from './entities/team-leader.entity';
import { TeamLeaderController } from './teamleader.controller';
import { TeamLeaderService } from './teamleader.service';

@Module({
  imports: [
    /**
     * Management identities, credentials, and Agent template-quota usage
     * records live in the `main` database.
     */
    TypeOrmModule.forFeature(
      [
        TeamLeader,
        Agent,
        ApiKey,
        AgentTemplateSendUsage,
      ],
      'main',
    ),

    /**
     * WhatsApp sessions live in the separate `data` database.
     *
     * TeamLeaderService injects Repository<Session> directly for:
     *
     * - verifying session ownership before Agent assignment
     * - preventing legacy Team Leader deletion while sessions are still owned
     * - resolving assigned Session metadata for the ADMIN Agent overview
     *
     * Do not import SessionModule merely for these repository operations.
     * SessionModule should be introduced when TeamLeaderService actually
     * injects SessionService for the retirement delete-all lifecycle.
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
     * TeamLeaderService uses AuthService.createApiKeyInTransaction() to
     * provision TEAM_LEADER / AGENT credentials atomically with their
     * principal rows.
     */
    AuthModule,
  ],

  controllers: [
    AdminTeamLeaderController,
    AdminAgentController,
    TeamLeaderController,
    AgentController,
  ],

  providers: [
    TeamLeaderService,
    AgentTemplateQuotaService,
  ],

  /**
   * TeamLeaderService is exported for principal/session access checks and
   * management integrations.
   *
   * AgentTemplateQuotaService is exported so MessageModule can apply the
   * quota only around the dedicated stored-template send endpoint without
   * duplicating Agent repository/quota logic.
   */
  exports: [
    TeamLeaderService,
    AgentTemplateQuotaService,
  ],
})
export class TeamLeaderModule {}



