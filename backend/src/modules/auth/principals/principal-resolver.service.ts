import { Injectable } from '@nestjs/common';
import { ApiKey } from '../entities/api-key.entity';
import { AuthenticatedPrincipal } from './authenticated-principal';

/** Turns the validated credential into a safe actor context for application use. */
@Injectable()
export class PrincipalResolver {
  resolve(apiKey: ApiKey): AuthenticatedPrincipal {
    return {
      credentialId: apiKey.id,
      credentialName: apiKey.name,
      role: apiKey.role,
      teamLeaderId: apiKey.teamLeaderId ?? null,
      agentId: apiKey.agentId ?? null,
      allowedSessions: apiKey.allowedSessions?.length
        ? [...apiKey.allowedSessions]
        : null,
    };
  }
}
