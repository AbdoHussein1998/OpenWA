import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { ApiKey } from '../auth/entities/api-key.entity';
import { Session } from '../session/entities/session.entity';
import { SessionModule } from '../session/session.module';

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
     * WhatsApp Sessions live in the separate `data` database.
     *
     * TeamLeaderService still injects Repository<Session> directly for
     * ownership checks, summaries, and resource graphs.
     */
    TypeOrmModule.forFeature(
      [
        Session,
      ],
      'data',
    ),

    /**
     * AuthModule exports AuthService for principal-bound credential creation.
     */
    AuthModule,

    /**
     * Force Team Leader deletion must retire owned Sessions through the full
     * SessionService lifecycle instead of deleting Session rows directly.
     * SessionModule exports SessionService and does not import TeamLeaderModule,
     * so this dependency remains one-directional.
     */
    SessionModule,
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

  exports: [
    TeamLeaderService,
    AgentTemplateQuotaService,
  ],
})
export class TeamLeaderModule {}
