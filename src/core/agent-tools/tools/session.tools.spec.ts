import type { AuthService } from '../../../modules/auth/auth.service';
import type { SessionTenantAccessService } from '../../../modules/access-control/session-tenant-access.service';
import { SessionScopes } from '../../../modules/access-control/session-scope';
import type { SessionService } from '../../../modules/session/session.service';

import type { AnyToolDescriptor } from '../tool-descriptor';
import { invokeTool } from '../tool-invoker';
import { sessionTools } from './session.tools';

// Covers every current sessionTools handler via the real invokeTool path:
//
// credential validation
//   -> capability check
//   -> tenant authorization / aggregate SessionScope resolution
//   -> Zod validation
//   -> handler
//
// agent-tools.module.ts is pure Nest wiring, stays at 0% coverage, and is intentionally not a target.

const ALL_SCOPE = SessionScopes.all();

function makeAuth(): Pick<
  AuthService,
  'validateApiKey' | 'hasPermission' | 'hasCapability'
> {
  return {
    validateApiKey: jest.fn().mockResolvedValue({
      id: 'k1',
      allowedSessions: null,
    }),
    hasPermission: jest.fn().mockReturnValue(true),
    hasCapability: jest.fn().mockReturnValue(true),
  };
}

function makeSessionTenantAccess(): Pick<
  SessionTenantAccessService,
  'assertSessionAccess' | 'getEffectiveSessionScope'
> {
  return {
    assertSessionAccess: jest.fn().mockResolvedValue(undefined),
    getEffectiveSessionScope: jest.fn().mockResolvedValue(ALL_SCOPE),
  };
}

function makeTools(
  svc: SessionService,
): Map<string, AnyToolDescriptor> {
  return new Map(
    sessionTools(svc).map(tool => [
      tool.name,
      tool,
    ]),
  );
}

async function run(
  tool: AnyToolDescriptor,
  input: unknown,
): Promise<unknown> {
  return invokeTool(
    tool,
    input,
    'key',
    makeAuth() as unknown as AuthService,
    makeSessionTenantAccess() as unknown as SessionTenantAccessService,
  );
}

describe('sessionTools', () => {
  it('SessionFindAll uses the effective SessionScope and maps entities to DTOs', async () => {
    const findAll = jest.fn().mockResolvedValue([
      {
        id: 's1',
        name: 'main',
        status: 'ready',
      },
    ]);

    const isActive = jest.fn().mockReturnValue(true);

    const out = (await run(
      makeTools({
        findAll,
        isActive,
      } as unknown as SessionService).get(
        'SessionFindAll',
      )!,
      {
        limit: 5,
      },
    )) as Array<{
      id: string;
      engineLoaded: boolean;
    }>;

    expect(findAll).toHaveBeenCalledWith(
      ALL_SCOPE,
      {
        limit: 5,
        offset: undefined,
      },
    );

    expect(isActive).toHaveBeenCalledWith(
      's1',
    );

    expect(out).toEqual([
      expect.objectContaining({
        id: 's1',
        engineLoaded: true,
      }),
    ]);
  });

  it('SessionFindOne delegates to findOne and maps to the response DTO', async () => {
    const findOne = jest.fn().mockResolvedValue({
      id: 's1',
      name: 'main',
      status: 'ready',
    });

    const isActive = jest.fn().mockReturnValue(false);

    const out = (await run(
      makeTools({
        findOne,
        isActive,
      } as unknown as SessionService).get(
        'SessionFindOne',
      )!,
      {
        sessionId: 's1',
      },
    )) as {
      id: string;
      engineLoaded: boolean;
    };

    expect(findOne).toHaveBeenCalledWith(
      's1',
    );

    expect(out.id).toBe('s1');
    expect(out.engineLoaded).toBe(false);
  });

  it('SessionGetChats delegates to getChats with paging', async () => {
    const getChats = jest
      .fn()
      .mockResolvedValue([
        {
          id: 'c1',
        },
      ]);

    const out = await run(
      makeTools({
        getChats,
      } as unknown as SessionService).get(
        'SessionGetChats',
      )!,
      {
        sessionId: 's1',
        limit: 20,
        offset: 10,
      },
    );

    expect(getChats).toHaveBeenCalledWith(
      's1',
      {
        limit: 20,
        offset: 10,
      },
    );

    expect(out).toEqual([
      {
        id: 'c1',
      },
    ]);
  });

  it('SessionGetStats uses the effective SessionScope', async () => {
    const stats = {
      total: 2,
      active: 1,
      ready: 1,
      disconnected: 1,
    };

    const getStats = jest
      .fn()
      .mockResolvedValue(stats);

    const out = await run(
      makeTools({
        getStats,
      } as unknown as SessionService).get(
        'SessionGetStats',
      )!,
      {},
    );

    expect(getStats).toHaveBeenCalledWith(
      ALL_SCOPE,
    );

    expect(out).toEqual(stats);
  });

  it('SessionMarkChatRead maps the sendSeen result to a success field', async () => {
    const sendSeen = jest
      .fn()
      .mockResolvedValue(true);

    const out = await run(
      makeTools({
        sendSeen,
      } as unknown as SessionService).get(
        'SessionMarkChatRead',
      )!,
      {
        sessionId: 's1',
        chatId: '628111@c.us',
      },
    );

    expect(sendSeen).toHaveBeenCalledWith(
      's1',
      '628111@c.us',
    );

    expect(out).toEqual({
      success: true,
    });
  });

  it('SessionMarkChatUnread maps the markUnread result to a success field', async () => {
    const markUnread = jest
      .fn()
      .mockResolvedValue(true);

    const out = await run(
      makeTools({
        markUnread,
      } as unknown as SessionService).get(
        'SessionMarkChatUnread',
      )!,
      {
        sessionId: 's1',
        chatId: '628111@c.us',
      },
    );

    expect(markUnread).toHaveBeenCalledWith(
      's1',
      '628111@c.us',
    );

    expect(out).toEqual({
      success: true,
    });
  });

  it('SessionSendChatState delegates to sendChatState and reports success', async () => {
    const sendChatState = jest
      .fn()
      .mockResolvedValue(undefined);

    const out = await run(
      makeTools({
        sendChatState,
      } as unknown as SessionService).get(
        'SessionSendChatState',
      )!,
      {
        sessionId: 's1',
        chatId: '628111@c.us',
        state: 'typing',
      },
    );

    expect(
      sendChatState,
    ).toHaveBeenCalledWith(
      's1',
      '628111@c.us',
      'typing',
    );

    expect(out).toEqual({
      success: true,
    });
  });
});
