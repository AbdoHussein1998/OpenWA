







import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  sessionApi,
  webhookApi,
  templateApi,
  apiKeyApi,
  auditApi,
  infraApi,
  pluginsApi,
  pluginInstancesApi,
  statsApi,
  adminTeamLeaderApi,
  adminAgentApi,
  teamLeaderApi,
  agentApi,
  type Webhook,
  type WebhookFilters,
  type TemplatePayload,
  type StatsPeriod,
  type CreateInstanceInput,
  type UpdateInstanceInput,
  type CreateSessionInput,
  type CreateTeamLeaderInput,
  type CreateAgentInput,
  type BulkReassignAdminAgentsInput,
  type BulkReassignAdminSessionsInput,
  type ReassignAdminAgentInput,
  type ReassignAdminSessionInput,
  type AssignAdminAgentSessionInput,
  type GenericApiKeyRole,
} from '../services/api';

// ── Query Keys ────────────────────────────────────────────────────────

export const queryKeys = {
  sessions: ['sessions'] as const,
  sessionStats: ['sessions', 'stats'] as const,
  adminTeamLeaders: ['admin', 'team-leaders'] as const,
  adminTeamLeaderResources: (teamLeaderId: string) =>
    ['admin', 'team-leaders', teamLeaderId, 'resources'] as const,
  adminAgents: ['admin', 'agents'] as const,
  teamLeaderMe: ['team-leader', 'me'] as const,
  teamLeaderAgents: ['team-leader', 'agents'] as const,
  agentMe: ['agent', 'me'] as const,
  sessionGroups: (sessionId: string) => ['sessions', sessionId, 'groups'] as const,
  sessionChats: (sessionId: string) => ['sessions', sessionId, 'chats'] as const,
  webhooks: ['webhooks'] as const,
  templates: (sessionId: string) => ['sessions', sessionId, 'templates'] as const,
  apiKeys: ['apiKeys'] as const,
  logs: (params: { severity?: string; page: number; limit: number }) => ['logs', params] as const,
  infraStatus: ['infra', 'status'] as const,
  plugins: ['plugins'] as const,
  pluginInstances: (pluginId: string) => ['plugins', pluginId, 'instances'] as const,
  engines: ['engines'] as const,
  currentEngine: ['engines', 'current'] as const,
  statsOverview: ['stats', 'overview'] as const,
  statsMessages: (period: string) => ['stats', 'messages', period] as const,
};

// ── Session Queries ───────────────────────────────────────────────────

export function useSessionsQuery() {
  return useQuery({
    queryKey: queryKeys.sessions,
    queryFn: sessionApi.list,
    staleTime: 30_000,
  });
}

export function useCreateSessionMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateSessionInput) =>
      sessionApi.create(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.sessions,
      });
    },
  });
}

export function useSessionStatsQuery() {
  return useQuery({
    queryKey: queryKeys.sessionStats,
    queryFn: sessionApi.getStats,
    staleTime: 30_000,
  });
}

export function useSessionGroupsQuery(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.sessionGroups(sessionId),
    queryFn: () => sessionApi.getGroups(sessionId),
    enabled: enabled && !!sessionId,
    staleTime: 60_000,
  });
}

export function useSessionChatsQuery(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.sessionChats(sessionId),
    queryFn: () => sessionApi.getChats(sessionId),
    enabled: enabled && !!sessionId,
    staleTime: 60_000,
  });
}

export function useStopSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => sessionApi.stop(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

// ── Webhook Queries ───────────────────────────────────────────────────

export function useWebhooksQuery() {
  return useQuery({
    queryKey: queryKeys.webhooks,
    queryFn: webhookApi.listAll,
    staleTime: 30_000,
    // Normalize `events` to an array at the data boundary so every consumer (list render + edit
    // modal) can trust the declared string[] shape. A malformed payload then renders as no tags
    // instead of taking down the whole SPA via events.map() in the ErrorBoundary.
    select: webhooks => webhooks.map(w => ({ ...w, events: Array.isArray(w.events) ? w.events : [] })),
  });
}

export function useCreateWebhookMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; url: string; events: string[]; filters?: WebhookFilters | null }) =>
      webhookApi.create(params.sessionId, { url: params.url, events: params.events, filters: params.filters }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });
    },
  });
}

export function useUpdateWebhookMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; id: string; data: Partial<Webhook> }) =>
      webhookApi.update(params.sessionId, params.id, params.data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });
    },
  });
}

export function useDeleteWebhookMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; id: string }) => webhookApi.delete(params.sessionId, params.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });
    },
  });
}

// ── Template Queries ─────────────────────────────────────────────────────────

export function useTemplatesQuery(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.templates(sessionId),
    queryFn: () => templateApi.list(sessionId),
    enabled: enabled && !!sessionId,
    staleTime: 30_000,
  });
}

export function useCreateTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; data: TemplatePayload }) =>
      templateApi.create(params.sessionId, params.data),
    onSuccess: (_template, params) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.templates(params.sessionId) });
    },
  });
}

export function useUpdateTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; id: string; data: Partial<TemplatePayload> }) =>
      templateApi.update(params.sessionId, params.id, params.data),
    onSuccess: (_template, params) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.templates(params.sessionId) });
    },
  });
}

export function useDeleteTemplateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; id: string }) => templateApi.delete(params.sessionId, params.id),
    onSuccess: (_template, params) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.templates(params.sessionId) });
    },
  });
}

// ── Team Leader / Agent Queries ───────────────────────────────────────

export function useAdminTeamLeadersQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.adminTeamLeaders,
    queryFn: adminTeamLeaderApi.list,
    enabled,
    staleTime: 30_000,
  });
}

export function useAdminAgentsQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.adminAgents,
    queryFn: adminAgentApi.list,
    enabled,
    staleTime: 30_000,
  });
}

export function useAdminTeamLeaderResourcesQuery(
  teamLeaderId: string,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.adminTeamLeaderResources(teamLeaderId),
    queryFn: () => adminTeamLeaderApi.getResources(teamLeaderId),
    enabled: enabled && Boolean(teamLeaderId),
    staleTime: 15_000,
  });
}

export function useCreateAdminTeamLeaderMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateTeamLeaderInput) =>
      adminTeamLeaderApi.create(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminTeamLeaders,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.apiKeys,
      });
    },
  });
}

export function useDeleteAdminTeamLeaderMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (teamLeaderId: string) =>
      adminTeamLeaderApi.delete(teamLeaderId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminTeamLeaders,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminAgents,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.apiKeys,
      });
    },
  });
}


export function useForceDeleteAdminTeamLeaderMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (teamLeaderId: string) =>
      adminTeamLeaderApi.forceDelete(teamLeaderId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminTeamLeaders,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminAgents,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.sessions,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.apiKeys,
      });
      // Prefix invalidation also drops any cached per-Team-Leader resource graph.
      void queryClient.invalidateQueries({
        queryKey: ['admin', 'team-leaders'],
      });
    },
  });
}

export function useCreateAdminAgentMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      teamLeaderId,
      data,
    }: {
      teamLeaderId: string;
      data: CreateAgentInput;
    }) =>
      adminTeamLeaderApi.createAgent(
        teamLeaderId,
        data,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminAgents,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.apiKeys,
      });
    },
  });
}

export function useSetAdminSessionOwnerMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      sessionId,
      data,
    }: {
      sessionId: string;
      data: ReassignAdminSessionInput;
    }) =>
      adminTeamLeaderApi.setSessionOwner(
        sessionId,
        data,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.sessions,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminAgents,
      });
      // Prefix invalidation refreshes the Team Leader inventory and every
      // cached Team Leader resource graph.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminTeamLeaders,
      });
    },
  });
}

export function useAssignAdminAgentSessionMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      agentId,
      data,
    }: {
      agentId: string;
      data: AssignAdminAgentSessionInput;
    }) =>
      adminAgentApi.assignSession(
        agentId,
        data,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.sessions,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminAgents,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminTeamLeaders,
      });
    },
  });
}

export function useReassignAdminSessionMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      teamLeaderId,
      sessionId,
      data,
    }: {
      teamLeaderId: string;
      sessionId: string;
      data: ReassignAdminSessionInput;
    }) =>
      adminTeamLeaderApi.reassignSession(
        teamLeaderId,
        sessionId,
        data,
      ),
    onSuccess: (_session, params) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminTeamLeaderResources(params.teamLeaderId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminTeamLeaderResources(params.data.targetTeamLeaderId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminAgents,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.sessions,
      });
    },
  });
}

export function useBulkReassignAdminSessionsMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      teamLeaderId,
      data,
    }: {
      teamLeaderId: string;
      data: BulkReassignAdminSessionsInput;
    }) =>
      adminTeamLeaderApi.bulkReassignSessions(teamLeaderId, data),
    onSuccess: (_sessions, params) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminTeamLeaderResources(params.teamLeaderId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminTeamLeaderResources(params.data.targetTeamLeaderId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminAgents,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.sessions,
      });
    },
  });
}

export function useReassignAdminAgentMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      agentId,
      data,
    }: {
      agentId: string;
      data: ReassignAdminAgentInput;
    }) => adminAgentApi.reassign(agentId, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminAgents,
      });
      // Prefix invalidation refreshes both the Team Leader list and every
      // currently cached resource graph, including source and target owners.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminTeamLeaders,
      });
    },
  });
}

export function useBulkReassignAdminAgentsMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: BulkReassignAdminAgentsInput) =>
      adminAgentApi.bulkReassign(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminAgents,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminTeamLeaders,
      });
    },
  });
}

export function useDeleteAdminAgentMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (agentId: string) => adminAgentApi.delete(agentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminAgents,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.adminTeamLeaders,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.apiKeys,
      });
    },
  });
}

export function useTeamLeaderMeQuery() {
  return useQuery({
    queryKey: queryKeys.teamLeaderMe,
    queryFn: teamLeaderApi.me,
    staleTime: 60_000,
  });
}

export function useTeamLeaderAgentsQuery() {
  return useQuery({
    queryKey: queryKeys.teamLeaderAgents,
    queryFn: teamLeaderApi.listAgents,
    staleTime: 30_000,
  });
}

export function useCreateTeamLeaderAgentMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateAgentInput) =>
      teamLeaderApi.createAgent(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.teamLeaderAgents,
      });
    },
  });
}

export function useReissueTeamLeaderAgentApiKeyMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (agentId: string) =>
      teamLeaderApi.reissueAgentApiKey(agentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.teamLeaderAgents,
      });
    },
  });
}

export function useDeleteTeamLeaderAgentMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (agentId: string) =>
      teamLeaderApi.deleteAgent(agentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.teamLeaderAgents,
      });
    },
  });
}

export function useAssignTeamLeaderAgentSessionMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      agentId,
      sessionId,
    }: {
      agentId: string;
      sessionId: string | null;
    }) =>
      teamLeaderApi.assignAgentSession(
        agentId,
        sessionId,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.teamLeaderAgents,
      });
    },
  });
}

export function useAgentMeQuery() {
  return useQuery({
    queryKey: queryKeys.agentMe,
    queryFn: agentApi.me,
    staleTime: 30_000,
  });
}

// ── API Key Queries ───────────────────────────────────────────────────

export function useApiKeysQuery() {
  return useQuery({
    queryKey: queryKeys.apiKeys,
    queryFn: apiKeyApi.list,
    staleTime: 30_000,
  });
}

export function useCreateApiKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      role: GenericApiKeyRole;
      allowedIps?: string[];
      allowedSessions?: string[];
      expiresAt?: string;
    }) => apiKeyApi.create(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

/**
 * Reissue an existing API key in place.
 *
 * The mutation result contains the one-time plaintext replacement key. Do not
 * write it into TanStack query data, sessionStorage, localStorage, or any other
 * persistent browser storage; UI components should keep it only in transient
 * React/mutation state long enough to display or copy it.
 */
export function useReissueApiKeyMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => apiKeyApi.reissue(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

export function useDeleteApiKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiKeyApi.delete(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

export function useRevokeApiKeyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiKeyApi.revoke(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });
}

// ── Logs Queries ──────────────────────────────────────────────────────

export function useLogsQuery(params: { severity?: string; page: number; limit: number }) {
  return useQuery({
    queryKey: queryKeys.logs(params),
    queryFn: () =>
      auditApi.list({
        severity: params.severity,
        limit: params.limit,
        offset: (params.page - 1) * params.limit,
      }),
    staleTime: 15_000,
  });
}

// ── Infrastructure Queries ────────────────────────────────────────────

export function useInfraStatusQuery() {
  return useQuery({
    queryKey: queryKeys.infraStatus,
    queryFn: infraApi.getStatus,
    staleTime: 30_000,
  });
}

export function useInfraConfigQuery() {
  return useQuery({
    queryKey: ['infra', 'config'],
    queryFn: infraApi.getConfig,
    staleTime: 30_000,
  });
}

// ── Plugin Queries ────────────────────────────────────────────────────

export function usePluginsQuery() {
  return useQuery({
    queryKey: queryKeys.plugins,
    queryFn: pluginsApi.list,
    staleTime: 30_000,
  });
}

export function usePluginInstancesQuery(pluginId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.pluginInstances(pluginId),
    queryFn: () => pluginInstancesApi.list(pluginId),
    enabled,
    staleTime: 30_000,
  });
}

export function useCreateInstanceMutation(pluginId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateInstanceInput) => pluginInstancesApi.create(pluginId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pluginInstances(pluginId) });
    },
  });
}

export function useRegenerateInstanceSecretMutation(pluginId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (instanceId: string) => pluginInstancesApi.regenerateSecret(pluginId, instanceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pluginInstances(pluginId) });
    },
  });
}

export function useUpdateInstanceMutation(pluginId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { instanceId: string; body: UpdateInstanceInput }) =>
      pluginInstancesApi.update(pluginId, params.instanceId, params.body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pluginInstances(pluginId) });
    },
  });
}

export function useDeleteInstanceMutation(pluginId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (instanceId: string) => pluginInstancesApi.remove(pluginId, instanceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pluginInstances(pluginId) });
    },
  });
}

export function useEnginesQuery() {
  return useQuery({
    queryKey: queryKeys.engines,
    queryFn: pluginsApi.getEngines,
    staleTime: 60_000,
  });
}

export function useCurrentEngineQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.currentEngine,
    queryFn: pluginsApi.getCurrentEngine,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

// ── Stats Queries ─────────────────────────────────────────────────────
// /stats/* is ADMIN-only; a non-admin key gets 403 → don't retry, let the UI fall back gracefully.

export function useStatsOverviewQuery() {
  return useQuery({
    queryKey: queryKeys.statsOverview,
    queryFn: statsApi.getOverview,
    staleTime: 30_000,
    retry: false,
  });
}

export function useStatsMessagesQuery(period: StatsPeriod) {
  return useQuery({
    queryKey: queryKeys.statsMessages(period),
    queryFn: () => statsApi.getMessages(period),
    staleTime: 30_000,
    retry: false,
  });
}







