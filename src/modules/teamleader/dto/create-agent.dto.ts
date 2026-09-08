

import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';

import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Request body for creating an Agent.
 *
 * The Agent's Team Leader is NEVER accepted from the request body.
 * teamLeaderId is derived from the authenticated Team Leader API key.
 *
 * The following fields must not be accepted here:
 *
 * - teamLeaderId
 * - assignedSessionId
 * - assignedPhone
 * - apiKeyHash
 * - agentId
 * - role
 *
 * Agent credentials are provisioned internally by TeamLeaderService.
 */
export class CreateAgentDto {
  @ApiProperty({
    description:
      'Human-readable name of the Agent',
    example: 'Mohamed Ali',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    description:
      'Optional email address of the Agent',
    example: 'mohamed.ali@example.com',
    maxLength: 255,
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;
}


