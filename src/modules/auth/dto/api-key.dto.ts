import {
  IsString,
  IsOptional,
  IsArray,
  IsDateString,
  IsIn,
  MinLength,
  MaxLength,
  Validate,
} from 'class-validator';
import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';

import { ApiKeyRole } from '../entities/api-key.entity';
import { IsIpOrCidrConstraint } from './is-ip-or-cidr.validator';

/**
 * Roles that may be created or assigned through the generic
 * /auth/api-keys management API.
 *
 * TEAM_LEADER and AGENT credentials are intentionally excluded.
 * Those roles require a corresponding principal record and are
 * provisioned atomically by TeamLeaderService.
 */
const GENERIC_API_KEY_ROLES: ApiKeyRole[] = [
  ApiKeyRole.ADMIN,
  ApiKeyRole.OPERATOR,
  ApiKeyRole.VIEWER,
];

export class CreateApiKeyDto {
  @ApiProperty({
    description: 'Friendly name for the API key',
    example: 'Production Bot',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    description:
      'Role/permission level. Team Leader and Agent credentials must be created through principal management.',
    enum: GENERIC_API_KEY_ROLES,
    default: ApiKeyRole.OPERATOR,
  })
  @IsOptional()
  @IsIn(GENERIC_API_KEY_ROLES)
  role?: ApiKeyRole;

  @ApiPropertyOptional({
    description: 'Allowed IP addresses (whitelist)',
    example: [
      '192.168.1.1',
      '10.0.0.0/8',
    ],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Validate(
    IsIpOrCidrConstraint,
    {
      each: true,
    },
  )
  allowedIps?: string[];

  @ApiPropertyOptional({
    description:
      'Session **ids** this key may act on — the server-generated UUIDs, not session names. Matched by ' +
      'exact equality against the id in the request path, so a name never matches and would silently ' +
      'scope the key to nothing. Omit or leave empty to let the key reach every session.',
    example: [
      '0a941dac-a965-45e7-b318-74ae8be134f0',
      '8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a',
    ],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedSessions?: string[];

  @ApiPropertyOptional({
    description: 'Expiration date (ISO 8601)',
    example: '2027-12-31T23:59:59Z',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class ApiKeyResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({
    description:
      'First 8 characters of the key (for identification)',
  })
  keyPrefix!: string;

  /**
   * Responses intentionally expose the complete ApiKeyRole enum because
   * Admin-visible key records may legitimately belong to Team Leaders
   * or Agents even though generic key creation cannot mint those roles.
   */
  @ApiProperty({
    enum: ApiKeyRole,
  })
  role!: ApiKeyRole;

  @ApiPropertyOptional()
  allowedIps?: string[];

  @ApiPropertyOptional()
  allowedSessions?: string[];

  @ApiProperty()
  isActive!: boolean;

  @ApiPropertyOptional()
  expiresAt?: Date;

  @ApiPropertyOptional()
  lastUsedAt?: Date;

  @ApiProperty()
  usageCount!: number;

  @ApiProperty()
  createdAt!: Date;
}

export class ApiKeyCreatedResponseDto extends ApiKeyResponseDto {
  @ApiProperty({
    description:
      'Full API key (only shown once at creation)',
    example: 'owa_k1_abc123...',
  })
  apiKey!: string;
}

/**
 * Result of POST /auth/validate — the guard's verdict
 * on the presented key.
 */
export class ValidateApiKeyResponseDto {
  @ApiProperty({
    description:
      'Whether the presented API key is valid.',
    example: true,
  })
  valid!: boolean;

  @ApiPropertyOptional({
    enum: ApiKeyRole,
    description:
      "The key's role; present only when valid.",
  })
  role?: ApiKeyRole;
}

export class UpdateApiKeyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description:
      'Role/permission level. Team Leader and Agent roles cannot be assigned through generic API-key management.',
    enum: GENERIC_API_KEY_ROLES,
  })
  @IsOptional()
  @IsIn(GENERIC_API_KEY_ROLES)
  role?: ApiKeyRole;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Validate(
    IsIpOrCidrConstraint,
    {
      each: true,
    },
  )
  allowedIps?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedSessions?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}