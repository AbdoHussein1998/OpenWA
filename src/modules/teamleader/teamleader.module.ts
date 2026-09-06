

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Agent } from './entities/agent.entity';
import { TeamLeader } from './entities/team-leader.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature(
      [TeamLeader, Agent],
      'main',
    ),
  ],
})
export class TeamLeaderModule {}