import { invokeTool } from '../tool-invoker';
import { labelTools } from './label.tools';
import { smartToolResult } from '../../../modules/mcp/tool-result';
import type { LabelService } from '../../../modules/label/label.service';
import type { AuthService } from '../../../modules/auth/auth.service';
import type { SessionTenantAccessService } from '../../../modules/access-control/session-tenant-access.service';

function makeAuth(): Pick<AuthService, 'validateApiKey' | 'hasPermission' | 'hasCapability'> {
  return {
    validateApiKey: jest.fn().mockResolvedValue({
      id: 'k1',
      role: 'operator',
      allowedSessions: null,
    }),
    hasPermission: jest.fn().mockReturnValue(true),
    hasCapability: jest.fn().mockReturnValue(true),
  };
}

function makeSessionTenantAccess(): Pick<SessionTenantAccessService, 'assertSessionAccess'> {
  return {
    assertSessionAccess: jest.fn().mockResolvedValue(undefined),
  };
}

// The engine's four label writes resolve void. Every write tool must map that to an object result:
// the MCP mount formats results with smartToolResult, and an undefined result used to throw there —
// reported to the agent as `Internal error` AFTER the write had already executed on WhatsApp, so
// the agent retried an operation that had succeeded.
describe('label write tools', () => {
  const writes = [
    ['LabelUpsert', 'upsertLabel', { sessionId: 's1', labelId: '7', name: 'VIP' }],
    ['LabelDelete', 'deleteLabel', { sessionId: 's1', labelId: '7' }],
    ['LabelAddToChat', 'addLabelToChat', { sessionId: 's1', chatId: '628111@c.us', labelId: '7' }],
    ['LabelRemoveFromChat', 'removeLabelFromChat', { sessionId: 's1', chatId: '628111@c.us', labelId: '7' }],
  ] as const;

  it.each(writes)('%s resolves an object result the MCP mount can format', async (toolName, method, input) => {
    const svc = {
      [method]: jest.fn().mockResolvedValue(undefined),
    } as unknown as LabelService;

    const tool = labelTools(svc).find(t => t.name === toolName)!;

    const out = await invokeTool(
      tool,
      input,
      'key',
      makeAuth() as unknown as AuthService,
      makeSessionTenantAccess() as unknown as SessionTenantAccessService,
    );

    expect(out).toEqual({ success: true });

    // The exact formatting step the MCP server runs on the result (mcp.server.ts).
    const formatted = smartToolResult(out as object);
    expect(formatted.content[0]).toEqual({
      type: 'text',
      text: '{"success":true}',
    });
  });

  it('LabelUpsert forwards only name/color to the service', async () => {
    const upsertLabel = jest.fn().mockResolvedValue(undefined);
    const svc = {
      upsertLabel,
    } as unknown as LabelService;

    const tool = labelTools(svc).find(t => t.name === 'LabelUpsert')!;

    await invokeTool(
      tool,
      {
        sessionId: 's1',
        labelId: '7',
        name: 'VIP',
        color: 3,
      },
      'key',
      makeAuth() as unknown as AuthService,
      makeSessionTenantAccess() as unknown as SessionTenantAccessService,
    );

    expect(upsertLabel).toHaveBeenCalledWith(
      's1',
      '7',
      {
        name: 'VIP',
        color: 3,
      },
    );
  });
});
