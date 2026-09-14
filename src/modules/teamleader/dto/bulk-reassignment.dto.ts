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
 * ids are required to be unique so the service can compare the requested set
 * with the rows it actually resolves from the data database.
 */
export class BulkReassignAdminSessionsDto {
  @ApiProperty({
    description:
      'Unique Session UUIDs to transfer.',
    type: [String],
    format: 'uuid',
    minItems: 1,
    uniqueItems: true,
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
 * All listed Agents are moved in one main-database transaction. Session
 * ownership is not changed by this DTO; unassignSession only controls whether
 * the Agents' existing Session assignments are cleared during the move.
 */
export class BulkReassignAdminAgentsDto {
  @ApiProperty({
    description:
      'Unique Agent UUIDs to move.',
    type: [String],
    format: 'uuid',
    minItems: 1,
    uniqueItems: true,
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
      'When true, clear Session assignments for all selected Agents as part of the move.',
    default: false,
    type: Boolean,
  })
  @IsOptional()
  @IsBoolean()
  unassignSession = false;
}

/** Convenience aliases with shorter names for new imports. */
export {
  BulkReassignAdminAgentsDto as BulkReassignAgentsDto,
  BulkReassignAdminSessionsDto as BulkReassignSessionsDto,
};

/**
 * Compile-time union for helpers that can accept either bulk request shape.
 * NestJS route handlers should use one of the concrete DTO classes above so
 * runtime validation and Swagger metadata remain unambiguous.
 */
export type BulkReassignmentDto =
  | BulkReassignAdminAgentsDto
  | BulkReassignAdminSessionsDto;
