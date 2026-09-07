

import {
  ApiProperty,
} from '@nestjs/swagger';

import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Request body for creating a Team Leader.
 *
 * Only identity-profile fields are accepted from the request.
 *
 * The following fields must NEVER be accepted here:
 *
 * - role
 * - teamLeaderId
 * - agentId
 * - apiKeyHash
 * - allowedSessions
 * - passwordHash
 *
 * The TEAM_LEADER API key is provisioned internally by
 * TeamLeaderService as part of the same main-database transaction.
 */
export class CreateTeamLeaderDto {
  @ApiProperty({
    description:
      'Human-readable name of the Team Leader',
    example: 'Ahmed Hassan',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    description:
      'Email address of the Team Leader',
    example: 'ahmed.hassan@example.com',
    maxLength: 255,
  })
  @IsEmail()
  @IsNotEmpty()
  @MaxLength(255)
  email!: string;
}


