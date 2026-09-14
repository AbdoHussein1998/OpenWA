import {
  ApiProperty,
} from '@nestjs/swagger';

import {
  IsUUID,
} from 'class-validator';

/**
 * Request body for transferring ownership of one Session.
 *
 * The Session id and current/source Team Leader id belong in the route path.
 * Only the destination Team Leader is accepted from the request body.
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
 * Domain-oriented alias retained for callers that prefer the filename-based
 * DTO name. Both exports refer to the same decorated runtime class.
 */
export {
  ReassignAdminSessionDto as ReassignSessionOwnerDto,
};
