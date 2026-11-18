import { Controller, Post, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { CurrentApiKey } from './decorators/auth.decorators';
import { ApiKey } from './entities/api-key.entity';
import { ValidateApiKeyResponseDto } from './dto';

@ApiTags('auth')
@Controller('auth')
export class AuthValidateController {
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate an API key' })
  @ApiHeader({ name: 'X-API-Key', description: 'API key to validate' })
  @ApiResponse({ status: 200, description: 'API key is valid', type: ValidateApiKeyResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid or missing API key' })
  validate(@CurrentApiKey() apiKey?: ApiKey): { valid: boolean; role?: string } {
    // This route is behind the global API-key guard. The guard authenticates
    // the credential and validates its client-IP restriction before this handler.
    // There is no session ID here, so this endpoint does not verify access to
    // any particular session. Reauthenticating here would count usage twice.
    // The false branch is retained only as defense-in-depth.
    if (!apiKey) {
      return { valid: false };
    }
    return { valid: true, role: apiKey.role };
  }
}
