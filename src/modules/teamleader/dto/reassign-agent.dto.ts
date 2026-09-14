import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';

import {
  IsBoolean,
  IsOptional,
  IsUUID,
} from 'class-validator';

/**
 * Request body for moving one Agent to another Team Leader.
 *
 * Agent and Session principals live in different databases. The caller must
 * therefore make Session handling explicit whenever the Agent's current
 * assignment cannot remain valid under the target Team Leader.
 */
export class ReassignAdminAgentDto {
  @ApiProperty({
    description:
      'Team Leader UUID that will own the Agent after the move.',
    format: 'uuid',
    example: '7f958a8f-f92d-4f22-b02f-2f856d0a94f3',
  })
  @IsUUID()
  targetTeamLeaderId!: string;

  @ApiPropertyOptional({
    description:
      'When true, clear the Agent\'s current Session assignment while moving the Agent. Leave false only when the existing Session is already owned by the target Team Leader.',
    default: false,
    type: Boolean,
  })
  @IsOptional()
  @IsBoolean()
  unassignSession = false;
}

/**
 * Short domain-oriented alias. Both exports refer to the same decorated class.
 */
export {
  ReassignAdminAgentDto as ReassignAgentDto,
};
