

import {
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  Validate,
} from 'class-validator';
import {
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';

import {
  ApiKeyRole,
} from '../entities/api-key.entity';
import {
  IsIpOrCidrConstraint,
} from './is-ip-or-cidr.validator';

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
    description: 'Allowed IP addresses or CIDR ranges (whitelist)',
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
      'Session ids this key may act on — the server-generated UUIDs, not session names. ' +
      'They are matched by exact equality against the id in the request path. ' +
      'Omit or leave empty to allow access to every session permitted by the key role.',
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
    description: 'Expiration date in ISO 8601 format',
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
      'First 12 characters of the API key, used only as a non-secret identifier',
    example: 'owa_k1_abc12',
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

  /**
   * Principal binding for TEAM_LEADER credentials.
   *
   * This is intentionally nullable because ordinary ADMIN / OPERATOR /
   * VIEWER keys and AGENT credentials are not bound to a Team Leader
   * principal through this column.
   *
   * It is optional in this DTO while the controller migration is being
   * completed, because existing controller response mappings do not yet
   * include this property.
   */
  @ApiPropertyOptional({
    description:
      'Team Leader principal id when this credential belongs to a Team Leader',
    type: String,
    nullable: true,
    example: '6f9ff30c-f2be-45dd-84b1-24682dd22076',
  })
  teamLeaderId?: string | null;

  /**
   * Principal binding for AGENT credentials.
   *
   * It is nullable because all non-Agent credentials have no Agent
   * principal binding.
   *
   * It remains optional in this DTO until all controller response
   * mappings explicitly include it.
   */
  @ApiPropertyOptional({
    description:
      'Agent principal id when this credential belongs to an Agent',
    type: String,
    nullable: true,
    example: 'd8027649-af83-4eba-9815-c44896916cb8',
  })
  agentId?: string | null;

  @ApiPropertyOptional({
    description:
      'IP addresses or CIDR ranges allowed to use this credential',
    type: [String],
  })
  allowedIps?: string[];

  @ApiPropertyOptional({
    description:
      'Session ids this credential is explicitly scoped to',
    type: [String],
  })
  allowedSessions?: string[];

  @ApiProperty()
  isActive!: boolean;

  @ApiPropertyOptional({
    description:
      'Credential expiration date, when configured',
  })
  expiresAt?: Date;

  @ApiPropertyOptional({
    description:
      'Most recent time this credential was used',
  })
  lastUsedAt?: Date;

  @ApiProperty()
  usageCount!: number;

  @ApiProperty()
  createdAt!: Date;
}

export class ApiKeyCreatedResponseDto extends ApiKeyResponseDto {
  @ApiProperty({
    description:
      'Full plaintext API key. Returned only when the credential has just been created or reissued and must not be persisted by the server.',
    example:
      'owa_k1_abc123def456789012345678901234567890123456789012345678901234',
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

  @ApiPropertyOptional({
    description:
      'Allowed IP addresses or CIDR ranges (whitelist)',
    type: [String],
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
      'Session ids this credential may act on',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedSessions?: string[];

  @ApiPropertyOptional({
    description: 'Expiration date in ISO 8601 format',
    example: '2027-12-31T23:59:59Z',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

