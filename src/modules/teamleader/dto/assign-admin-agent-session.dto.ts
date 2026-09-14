

/**
 * Admin-facing semantic alias for the existing Agent Session assignment DTO.
 *
 * The HTTP payload is intentionally identical for Team Leader self-service and
 * global Admin/Operator management:
 *
 * - a Session UUID assigns the Agent to that Session;
 * - null explicitly removes the Agent's current Session assignment.
 *
 * The difference between the two flows is business authorization/ownership,
 * not request-body shape:
 *
 * - Team Leader self-service requires the Session to already belong to the
 *   authenticated Team Leader.
 * - Admin assignment may move Session ownership to the Agent's Team Leader.
 *
 * Those rules belong in TeamLeaderService. Reusing the existing decorated DTO
 * keeps validation and Swagger metadata identical and avoids two definitions
 * drifting apart over time.
 */
export {
  AssignAgentSessionDto,
  AssignAgentSessionDto as AssignAdminAgentSessionDto,
} from './assign-agent-session.dto';



