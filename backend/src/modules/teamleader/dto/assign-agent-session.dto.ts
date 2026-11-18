

import {
  ApiProperty,
} from '@nestjs/swagger';

import {
  IsUUID,
  ValidateIf,
} from 'class-validator';

/**
 * Request body for assigning or unassigning an Agent's session.
 *
 * A non-null UUID assigns the Agent to that session.
 *
 * null explicitly removes the Agent's current assignment.
 *
 * Examples:
 *
 * Assign:
 *
 * {
 *   "sessionId": "0a941dac-a965-45e7-b318-74ae8be134f0"
 * }
 *
 * Unassign:
 *
 * {
 *   "sessionId": null
 * }
 *
 * The service MUST verify that:
 *
 * 1. the Agent belongs to the authenticated Team Leader
 * 2. the Session is owned by the same Team Leader
 *
 * This DTO performs syntax validation only.
 * It does not perform tenancy authorization.
 */
export class AssignAgentSessionDto {
  @ApiProperty({
    description:
      'Session UUID to assign to the Agent. Set to null to remove the current assignment.',
    example:
      '0a941dac-a965-45e7-b318-74ae8be134f0',
    nullable: true,
    required: true,
    format: 'uuid',
  })
  @ValidateIf(
    (_object, value) =>
      value !== null,
  )
  @IsUUID()
  sessionId!: string | null;
}


