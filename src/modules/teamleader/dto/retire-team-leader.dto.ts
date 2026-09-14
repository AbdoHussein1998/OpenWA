import {
  Type,
} from 'class-transformer';

import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';

import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';

/**
 * One Session ownership decision inside a Team Leader retirement plan.
 */
export class RetireTeamLeaderSessionDelegationDto {
  @ApiProperty({
    description:
      'Session UUID currently owned by the Team Leader being retired.',
    format: 'uuid',
  })
  @IsUUID()
  sessionId!: string;

  @ApiProperty({
    description:
      'Team Leader UUID that will become the Session owner.',
    format: 'uuid',
  })
  @IsUUID()
  targetTeamLeaderId!: string;
}

/**
 * One Agent ownership decision inside a Team Leader retirement plan.
 */
export class RetireTeamLeaderAgentDelegationDto {
  @ApiProperty({
    description:
      'Agent UUID currently owned by the Team Leader being retired.',
    format: 'uuid',
  })
  @IsUUID()
  agentId!: string;

  @ApiProperty({
    description:
      'Team Leader UUID that will own the Agent after retirement.',
    format: 'uuid',
  })
  @IsUUID()
  targetTeamLeaderId!: string;

  @ApiPropertyOptional({
    description:
      'When true, clear the Agent\'s current Session assignment while delegating the Agent. Use this when that assignment cannot remain valid under the target Team Leader.',
    default: false,
    type: Boolean,
  })
  @IsOptional()
  @IsBoolean()
  unassignSession = false;
}

/**
 * Complete resource-delegation plan for retiring a Team Leader.
 *
 * The Team Leader being retired is identified by the route path and must not
 * be accepted from the request body. The service handling retirement remains
 * authoritative: before deletion it must load the current resource graph and
 * reject a plan that omits, duplicates, or references resources not owned by
 * the retiring Team Leader.
 *
 * Empty arrays are valid when the Team Leader owns no resource of that kind.
 */
export class RetireTeamLeaderDto {
  @ApiProperty({
    description:
      'Per-Session ownership transfers that must be completed before the Team Leader is deleted.',
    type: () => [RetireTeamLeaderSessionDelegationDto],
    default: [],
  })
  @IsArray()
  @ArrayUnique(
    (
      item: RetireTeamLeaderSessionDelegationDto,
    ) => item.sessionId,
  )
  @ValidateNested({
    each: true,
  })
  @Type(
    () => RetireTeamLeaderSessionDelegationDto,
  )
  sessionReassignments: RetireTeamLeaderSessionDelegationDto[] = [];

  @ApiProperty({
    description:
      'Per-Agent ownership transfers that must be completed before the Team Leader is deleted.',
    type: () => [RetireTeamLeaderAgentDelegationDto],
    default: [],
  })
  @IsArray()
  @ArrayUnique(
    (
      item: RetireTeamLeaderAgentDelegationDto,
    ) => item.agentId,
  )
  @ValidateNested({
    each: true,
  })
  @Type(
    () => RetireTeamLeaderAgentDelegationDto,
  )
  agentReassignments: RetireTeamLeaderAgentDelegationDto[] = [];
}
