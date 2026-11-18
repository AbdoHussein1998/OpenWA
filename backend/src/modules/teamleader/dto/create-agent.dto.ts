


import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';

import {
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
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

  @ApiPropertyOptional({
    description:
      'Maximum number of stored-template sends allowed in a rolling 24-hour window. Null or omitted means unlimited; 0 disables stored-template sending.',
    example: 20,
    minimum: 0,
    nullable: true,
    type: Number,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  templateSendLimit24h?: number | null;
}


