import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsUUID,
} from 'class-validator';

/**
 * Bulk Session ownership transfer.
 *
 * All listed Sessions are transferred to the same target Team Leader. Session
 * ids must be unique so the service can compare the requested set with the
 * rows resolved from the data database and fail cleanly on missing resources.
 *
 * Assigned Sessions are still subject to the service-layer ownership rules;
 * this DTO does not bypass Agent/Team Leader consistency checks.
 */
export class BulkReassignAdminSessionsDto {
  @ApiProperty({
    description: 'Unique Session UUIDs to transfer.',
    type: [String],
    minItems: 1,
    uniqueItems: true,
    example: [
      '2b859606-3998-4604-a228-e6001e43e828',
      '72aa3f02-c57e-4d4d-9bef-56b7204953af',
    ],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID(undefined, {
    each: true,
  })
  sessionIds!: string[];

  @ApiProperty({
    description:
      'Team Leader UUID that will own every selected Session.',
    format: 'uuid',
    example: '7f958a8f-f92d-4f22-b02f-2f856d0a94f3',
  })
  @IsUUID()
  targetTeamLeaderId!: string;
}

/**
 * Bulk Agent transfer.
 *
 * All listed Agents are moved to the same target Team Leader in one main-DB
 * transaction. Session ownership is not implicitly changed by this request.
 *
 * If an Agent has a Session assignment that is not already owned by the
 * target Team Leader, callers must set unassignSession=true. This keeps the
 * invariant:
 *
 *   Agent.teamLeaderId === Session.ownerTeamLeaderId
 */
export class BulkReassignAdminAgentsDto {
  @ApiProperty({
    description: 'Unique Agent UUIDs to move.',
    type: [String],
    minItems: 1,
    uniqueItems: true,
    example: [
      'a6a0ec5b-b7ef-4ab9-8f25-0dbfba763888',
      '97ba1ebd-08b0-42ad-a29a-5c61dbac481f',
    ],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID(undefined, {
    each: true,
  })
  agentIds!: string[];

  @ApiProperty({
    description:
      'Team Leader UUID that will own every selected Agent.',
    format: 'uuid',
    example: '7f958a8f-f92d-4f22-b02f-2f856d0a94f3',
  })
  @IsUUID()
  targetTeamLeaderId!: string;

  @ApiPropertyOptional({
    description:
      'When true, clear existing Session assignments for the selected Agents while moving them. Leave false only when every retained Session is already owned by the target Team Leader.',
    default: false,
    type: Boolean,
  })
  @IsOptional()
  @IsBoolean()
  unassignSession = false;
}

/** Convenience aliases retained for existing imports. */
export {
  BulkReassignAdminAgentsDto as BulkReassignAgentsDto,
  BulkReassignAdminSessionsDto as BulkReassignSessionsDto,
};

/**
 * Compile-time union for helpers that accept either bulk reassignment body.
 * NestJS route handlers should continue to use one of the concrete DTO classes
 * above so class-validator and Swagger metadata remain unambiguous at runtime.
 */
export type BulkReassignmentDto =
  | BulkReassignAdminAgentsDto
  | BulkReassignAdminSessionsDto;
