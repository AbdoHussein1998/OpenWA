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
 * This operation moves the Agent principal itself. It does not implicitly
 * transfer Session ownership across databases.
 *
 * If the Agent currently has a Session assignment, that assignment may remain
 * only when the Session is already owned by the target Team Leader. Otherwise
 * the caller must explicitly set unassignSession=true before the Agent can be
 * moved safely.
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
 * Compatibility alias for callers that use the shorter domain-oriented name.
 * Both exports reference the same decorated runtime class.
 */
export {
  ReassignAdminAgentDto as ReassignAgentDto,
};
