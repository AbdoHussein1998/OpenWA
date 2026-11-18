import { ApiKeyRole } from '../auth.levels.constants';

/** Sanitized, request-local actor identity. No credential hashes or plaintext. */
export interface AuthenticatedPrincipal {
  credentialId: string;
  credentialName: string;
  role: ApiKeyRole;
  teamLeaderId: string | null;
  agentId: string | null;
  allowedSessions: readonly string[] | null;
}
