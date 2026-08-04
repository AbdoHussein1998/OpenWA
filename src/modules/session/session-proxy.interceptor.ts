import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EMPTY, Observable } from 'rxjs';
import type { Request, Response } from 'express';
import { Session } from './entities/session.entity';
import { SessionOwnershipService } from './session-ownership.service';
import { SESSION_SCOPED_KEY } from '../auth/decorators/auth.decorators';
import { createLogger } from '../../common/services/logger.service';

/** The request headers a forwarded call carries over. Everything else is this hop's business. */
const FORWARDED_REQUEST_HEADERS = ['x-api-key', 'authorization', 'content-type', 'accept'] as const;

/** The response headers relayed back. Deliberately short: hop-by-hop headers must not leak through. */
const RELAYED_RESPONSE_HEADERS = ['content-type', 'content-disposition', 'x-content-type-options'] as const;

/** Marks a request as already forwarded once. Whatever happens, it is never forwarded again. */
export const FORWARDED_HEADER = 'x-openwa-forwarded';

/**
 * Routes a session-scoped request to the node hosting the session's engine.
 *
 * The ownership lease records WHERE each session runs; this is the piece that acts on it: a request
 * landing on the wrong node — a load balancer round-robining across replicas knows nothing about
 * session placement — is forwarded to the owner's `nodeUrl` and the owner's response is relayed
 * back. Interceptor rather than middleware so it runs AFTER the API-key guard: a node only spends
 * outbound work on requests that authenticated here first (the owner authenticates them again —
 * both nodes share the auth database).
 *
 * Entirely inert unless the operator configured routing: without NODE_URL on this node the
 * interceptor never even looks up the session, so single-node deployments pay nothing.
 *
 * Deliberate decisions:
 * - A LAPSED owner does not forward: the session is adoptable, and the local node handling the
 *   request (a POST /start claims it here) is the takeover semantic, not an error.
 * - A live owner WITHOUT a nodeUrl cannot be reached; the request proceeds locally and the
 *   engine-level "held by another node" conflict answers it — precise, if unrouteable.
 * - One hop only: a forwarded request is never forwarded again (FORWARDED_HEADER), so stale
 *   ownership data degrades to a wrong-node answer instead of a loop.
 */
@Injectable()
export class SessionProxyInterceptor implements NestInterceptor {
  private readonly logger = createLogger('SessionProxyInterceptor');

  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(Session, 'data')
    private readonly sessions: Repository<Session>,
    @Optional()
    private readonly ownership?: SessionOwnershipService,
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http' || !this.ownership) return next.handle();
    // Routing is opt-in per deployment: a node that never announced its own URL is not part of a
    // routed topology, and the per-request ownership lookup would be pure overhead.
    if (!this.ownership.nodeUrl) return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    if (request.headers[FORWARDED_HEADER]) return next.handle();

    const sessionId = this.sessionIdOf(context, request);
    if (!sessionId) return next.handle();

    const owner = await this.sessions.findOne({
      where: { id: sessionId },
      select: { id: true, nodeId: true, nodeUrl: true, leaseExpiresAt: true },
    });
    if (!owner?.nodeId || owner.nodeId === this.ownership.nodeId) return next.handle();
    const leaseLive = owner.leaseExpiresAt != null && owner.leaseExpiresAt > new Date();
    if (!leaseLive || !owner.nodeUrl) return next.handle();

    await this.forward(request, context.switchToHttp().getResponse<Response>(), owner.nodeId, owner.nodeUrl);
    // The response has been written; complete without emitting so nothing downstream re-answers it.
    return EMPTY;
  }

  private sessionIdOf(context: ExecutionContext, request: Request): string | undefined {
    const params = (request.params ?? {}) as Record<string, string | undefined>;
    if (params.sessionId) return params.sessionId;
    const sessionScoped = this.reflector.getAllAndOverride<boolean>(SESSION_SCOPED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    return sessionScoped ? params.id : undefined;
  }

  private async forward(
    request: Request,
    response: Response,
    ownerNodeId: string,
    ownerNodeUrl: string,
  ): Promise<void> {
    const target = new URL(request.originalUrl, ownerNodeUrl).toString();
    const timeoutMs = this.configService?.get<number>('session.proxyTimeoutMs', 60_000) ?? 60_000;

    const headers: Record<string, string> = { [FORWARDED_HEADER]: this.ownership?.nodeId ?? '1' };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }

    const hasBody = !['GET', 'HEAD'].includes(request.method);
    try {
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        // The body has already been parsed by this hop's JSON body-parser; re-serialising it is
        // byte-equivalent for the JSON API surface (there are no multipart session routes).
        body: hasBody ? JSON.stringify(request.body ?? {}) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });

      response.status(upstream.status);
      for (const name of RELAYED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) response.setHeader(name, value);
      }
      response.setHeader('x-openwa-served-by', ownerNodeId);
      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.length > 0) response.send(body);
      else response.end();
    } catch (error) {
      this.logger.warn(`Forwarding to session owner '${ownerNodeId}' failed`, {
        target,
        error: error instanceof Error ? error.message : String(error),
      });
      response.status(503).json({
        statusCode: 503,
        message:
          `this session is hosted on node '${ownerNodeId}', which could not be reached from this node — ` +
          'check the owner node and its NODE_URL',
        error: 'Service Unavailable',
      });
    }
  }
}
