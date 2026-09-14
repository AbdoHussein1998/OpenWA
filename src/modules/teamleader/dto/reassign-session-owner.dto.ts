import {
  ApiProperty,
} from '@nestjs/swagger';
import {
  IsUUID,
} from 'class-validator';

/**
 * Request body for assigning or transferring Session ownership to a Team
 * Leader.
 *
 * The Session id is supplied by the route. Depending on the route, the
 * current/source Team Leader may also be supplied by the route, but the
 * destination Team Leader always comes from this request body.
 *
 * This DTO is used for both:
 *
 * - assigning an ADMIN-created Session whose ownerTeamLeaderId is null; and
 * - transferring an existing Team Leader-owned Session to another Team Leader.
 */
export class ReassignAdminSessionDto {
  @ApiProperty({
    description:
      'Team Leader UUID that will become the owner of the Session.',
    format: 'uuid',
    example: '7f958a8f-f92d-4f22-b02f-2f856d0a94f3',
  })
  @IsUUID()
  targetTeamLeaderId!: string;
}

/**
 * Compatibility alias for callers that use the filename-oriented DTO name.
 * Both exports reference the same decorated runtime class.
 */
export {
  ReassignAdminSessionDto as ReassignSessionOwnerDto,
};
