import http from 'http';
import { AddressInfo } from 'net';
import { of, lastValueFrom, isEmpty } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { SessionProxyInterceptor, FORWARDED_HEADER } from './session-proxy.interceptor';
import type { Session } from './entities/session.entity';

/**
 * The forwarding decision IS the security surface: forwarding when the session is local answers a
 * request twice; not forwarding when the owner is live strands the caller with a conflict; ever
 * forwarding a forwarded request is a loop between two nodes that both think the other owns the
 * session. The matrix below pins every arm, and the mechanics tests run against a real HTTP server
 * because header pass-through and body re-serialisation are exactly the parts a stubbed fetch
 * would vacuously approve.
 */
describe('SessionProxyInterceptor', () => {
  const row = (over: Partial<Session> = {}): Partial<Session> => ({
    id: 'sess-1',
    nodeId: 'peer-node',
    nodeUrl: 'http://127.0.0.1:9',
    leaseExpiresAt: new Date(Date.now() + 60_000),
    ...over,
  });

  type Req = {
    headers: Record<string, string>;
    params: Record<string, string>;
    method: string;
    originalUrl: string;
    body?: unknown;
  };

  const request = (over: Partial<Req> = {}): Req => ({
    headers: { 'x-api-key': 'k-123', 'content-type': 'application/json' },
    params: { sessionId: 'sess-1' },
    method: 'GET',
    originalUrl: '/api/sessions/sess-1/messages?limit=5',
    ...over,
  });

  const makeResponse = () => {
    const res = {
      status: jest.fn(),
      setHeader: jest.fn(),
      send: jest.fn(),
      end: jest.fn(),
      json: jest.fn(),
    };
    res.status.mockReturnValue(res);
    return res;
  };

  const build = (opts: {
    myUrl?: string;
    row?: Partial<Session> | null;
    sessionScoped?: boolean;
    req?: Req;
    timeoutMs?: number;
  }) => {
    const req = opts.req ?? request();
    const res = makeResponse();
    const findOne = jest.fn().mockResolvedValue(opts.row === undefined ? row() : opts.row);
    const interceptor = new SessionProxyInterceptor(
      { getAllAndOverride: jest.fn().mockReturnValue(opts.sessionScoped ?? false) } as never,
      { findOne } as never,
      { nodeId: 'me', nodeUrl: opts.myUrl ?? 'http://127.0.0.1:2785' } as never,
      { get: jest.fn().mockReturnValue(opts.timeoutMs ?? 5000) } as never,
    );
    const context = {
      getType: () => 'http',
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;
    const handle = jest.fn(() => of('handled-locally'));
    const next: CallHandler = { handle };
    return { interceptor, context, next, handle, res, findOne, req };
  };

  const ranLocally = async (result: Awaited<ReturnType<SessionProxyInterceptor['intercept']>>): Promise<boolean> =>
    lastValueFrom(result, { defaultValue: 'EMPTY' }).then(v => v === 'handled-locally');

  describe('the forwarding decision', () => {
    it('is inert without NODE_URL on this node — no lookup, handled locally', async () => {
      const { interceptor, context, next, findOne } = build({ myUrl: '' });
      expect(await ranLocally(await interceptor.intercept(context, next))).toBe(true);
      expect(findOne).not.toHaveBeenCalled();
    });

    it('never forwards a forwarded request (loop guard), even when the owner looks remote', async () => {
      const req = request({ headers: { [FORWARDED_HEADER]: 'peer-node', 'x-api-key': 'k' } });
      const { interceptor, context, next, findOne } = build({ req });
      expect(await ranLocally(await interceptor.intercept(context, next))).toBe(true);
      expect(findOne).not.toHaveBeenCalled();
    });

    it('ignores routes without a session dimension', async () => {
      const { interceptor, context, next, findOne } = build({ req: request({ params: {} }) });
      expect(await ranLocally(await interceptor.intercept(context, next))).toBe(true);
      expect(findOne).not.toHaveBeenCalled();
    });

    it('reads :id only on @SessionScoped controllers', async () => {
      const req = request({ params: { id: 'sess-1' } });
      const scoped = build({ req, sessionScoped: true, row: row({ nodeId: 'me' }) });
      expect(await ranLocally(await scoped.interceptor.intercept(scoped.context, scoped.next))).toBe(true);
      expect(scoped.findOne).toHaveBeenCalled();

      const unscoped = build({ req: request({ params: { id: 'sess-1' } }), sessionScoped: false });
      expect(await ranLocally(await unscoped.interceptor.intercept(unscoped.context, unscoped.next))).toBe(true);
      expect(unscoped.findOne).not.toHaveBeenCalled();
    });

    it.each([
      ['unknown session', null],
      ['unowned session', row({ nodeId: null })],
      ['owned by this node', row({ nodeId: 'me' })],
      ['owner lease lapsed (takeover semantics)', row({ leaseExpiresAt: new Date(Date.now() - 1000) })],
      ['owner without a nodeUrl', row({ nodeUrl: null })],
    ])('handles locally when the owner is not a live routable peer: %s', async (_label, ownerRow) => {
      const { interceptor, context, next } = build({ row: ownerRow });
      expect(await ranLocally(await interceptor.intercept(context, next))).toBe(true);
    });
  });

  describe('the forward itself (real upstream server)', () => {
    let server: http.Server;
    let serverUrl: string;
    let seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }>;

    beforeAll(async () => {
      seen = [];
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
          seen.push({ method: req.method, url: req.url, headers: req.headers, body });
          res.writeHead(201, { 'content-type': 'application/json', 'x-hop-by-hop': 'must-not-relay' });
          res.end(JSON.stringify({ servedBy: 'the-owner' }));
        });
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
    });

    beforeEach(() => {
      seen = [];
    });

    it('relays method, path, query, body and auth to the owner, and the owner’s answer back', async () => {
      const req = request({
        method: 'POST',
        originalUrl: '/api/sessions/sess-1/messages/send-text?trace=1',
        body: { chatId: '628@c.us', text: 'halo' },
      });
      const { interceptor, context, next, handle, res } = build({ req, row: row({ nodeUrl: serverUrl }) });

      const result = await interceptor.intercept(context, next);
      // EMPTY: the response was written directly; nothing may flow to the route handler.
      expect(await lastValueFrom(result.pipe(isEmpty()))).toBe(true);
      expect(handle).not.toHaveBeenCalled();

      expect(seen).toHaveLength(1);
      expect(seen[0].method).toBe('POST');
      expect(seen[0].url).toBe('/api/sessions/sess-1/messages/send-text?trace=1');
      expect(seen[0].headers['x-api-key']).toBe('k-123');
      expect(seen[0].headers[FORWARDED_HEADER]).toBe('me');
      expect(JSON.parse(seen[0].body)).toEqual({ chatId: '628@c.us', text: 'halo' });

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.setHeader).toHaveBeenCalledWith('content-type', 'application/json');
      expect(res.setHeader).toHaveBeenCalledWith('x-openwa-served-by', 'peer-node');
      expect(res.setHeader).not.toHaveBeenCalledWith('x-hop-by-hop', expect.anything());
      const sentBody = (res.send.mock.calls[0] as [Buffer])[0];
      expect(JSON.parse(String(sentBody))).toEqual({ servedBy: 'the-owner' });
    });

    it('a GET carries no body', async () => {
      const { interceptor, context, next } = build({ req: request(), row: row({ nodeUrl: serverUrl }) });

      await interceptor.intercept(context, next);

      expect(seen[0].method).toBe('GET');
      expect(seen[0].body).toBe('');
    });

    it('an unreachable owner answers 503 with the owner named, never a hang or a crash', async () => {
      const { interceptor, context, next, handle, res } = build({
        row: row({ nodeUrl: 'http://127.0.0.1:1' }),
        timeoutMs: 2000,
      });

      await interceptor.intercept(context, next);

      expect(res.status).toHaveBeenCalledWith(503);
      const errorBody = (res.json.mock.calls[0] as [{ statusCode: number; message: string }])[0];
      expect(errorBody.statusCode).toBe(503);
      expect(errorBody.message).toContain('peer-node');
      expect(handle).not.toHaveBeenCalled();
    });
  });
});
