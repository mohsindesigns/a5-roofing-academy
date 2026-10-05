import { Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiProduces } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import type { Principal } from '@a5/auth';
import { ai } from '@a5/contracts';
import {
  ApiController,
  CurrentPrincipal,
  RequireAnyPermission,
  RequirePermissions,
  ZBody,
  ZParam,
  ZQuery,
  ZResponse,
} from '@a5/nest-kit';
import { CatalogService } from '../scenarios/catalog.service.js';
import { ConversationEngine, type TurnEvent } from './conversation.engine.js';
import { SessionsService } from './sessions.service.js';

const HEARTBEAT_MS = 15_000;

/** `Accept: application/json` (without text/event-stream) selects the non-streaming response. */
function wantsJson(req: Request): boolean {
  const accept = (req.header('accept') ?? '').toLowerCase();
  return accept.includes('application/json') && !accept.includes('text/event-stream');
}

@ApiController('ai/practice', 'ai-practice')
export class PracticeController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('scenarios')
  @RequirePermissions('ai_practice.use')
  @ZResponse(ai.practiceScenarioPageSchema)
  list(
    @CurrentPrincipal() p: Principal,
    @ZQuery(ai.listPracticeScenariosQuerySchema)
    q: z.infer<typeof ai.listPracticeScenariosQuerySchema>,
  ) {
    return this.catalog.list(p, q);
  }

  /** What the representative knows before knocking. Never includes the hidden concern. */
  @Get('scenarios/:id')
  @RequirePermissions('ai_practice.use')
  @ZResponse(ai.practiceScenarioBriefSchema)
  brief(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.catalog.brief(p, id);
  }
}

@ApiController('ai/sessions', 'ai-practice')
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly engine: ConversationEngine,
  ) {}

  /** Start a session. With a lesson grant the session counts as the assigned lesson attempt. */
  @Post()
  @RequirePermissions('ai_practice.use')
  @ZResponse(ai.sessionSchema)
  start(
    @CurrentPrincipal() p: Principal,
    @ZBody(ai.startSessionRequestSchema) body: ai.StartSessionRequest,
  ) {
    return this.sessions.start(p, body);
  }

  @Get(':id')
  @RequireAnyPermission('ai_practice.use', 'ai_scenarios.update')
  @ZResponse(ai.sessionSchema)
  get(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.sessions.get(p, id);
  }

  /**
   * Send the representative's message and receive the homeowner's reply.
   * Default: Server-Sent Events (`accepted`, `delta`*, then `done` or `error`).
   * With `Accept: application/json`: one JSON object once the reply is complete.
   */
  @Post(':id/messages')
  @HttpCode(200)
  @RequireAnyPermission('ai_practice.use', 'ai_scenarios.update')
  @ApiProduces('text/event-stream', 'application/json')
  @ApiOkResponse({
    description: 'SSE stream (accepted, delta, done, error) or JSON (Accept: application/json)',
  })
  async send(
    @Req() req: Request,
    @Res() res: Response,
    @CurrentPrincipal() p: Principal,
    @ZParam('id') id: string,
    @ZBody(ai.sendMessageRequestSchema) body: ai.SendMessageRequest,
  ): Promise<void> {
    const turn = this.engine.handleTurn(
      { userId: p.userId, organizationId: p.organizationId },
      id,
      {
        text: body.text,
        audio: body.audioRef ? { ref: body.audioRef } : undefined,
        retry: body.retry,
        clientMessageId: body.clientMessageId,
      },
    );
    // Validation, ownership and concurrency errors surface here, before any byte is written,
    // and are answered by the regular JSON error filter.
    const first = await turn.next();

    if (wantsJson(req)) {
      let accepted: Extract<TurnEvent, { type: 'accepted' }> | null = null;
      let done: Extract<TurnEvent, { type: 'done' }> | null = null;
      let error: Extract<TurnEvent, { type: 'error' }> | null = null;
      const handle = (e: TurnEvent) => {
        if (e.type === 'accepted') accepted = e;
        else if (e.type === 'done') done = e;
        else if (e.type === 'error') error = e;
      };
      if (!first.done) handle(first.value);
      for await (const event of turn) handle(event);
      const a = accepted as Extract<TurnEvent, { type: 'accepted' }> | null;
      const d = done as Extract<TurnEvent, { type: 'done' }> | null;
      const err = error as Extract<TurnEvent, { type: 'error' }> | null;
      const state = d ?? (await this.sessions.status(id));
      res.status(200).json(
        ai.sendMessageResponseSchema.parse({
          repMessage: a?.repMessage ?? null,
          reply: d?.message ?? null,
          sessionEnded: d?.sessionEnded ?? state.status !== 'active',
          endReason: d?.endReason ?? null,
          status: state.status,
          turnCount: state.turnCount,
          turnsRemaining: state.turnsRemaining,
          error: err ? { code: err.code, message: err.message, retryable: err.retryable } : null,
        }),
      );
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const open = () => !res.writableEnded && !res.destroyed;
    const write = (event: string, data: unknown) => {
      if (open()) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (open()) res.write(': keep-alive\n\n');
    }, HEARTBEAT_MS);
    const send = (e: TurnEvent) => {
      switch (e.type) {
        case 'accepted':
          return write('accepted', { repMessage: e.repMessage, retried: e.retried });
        case 'delta':
          return write('delta', { text: e.text });
        case 'done':
          return write('done', {
            messageId: e.message.id,
            message: e.message,
            sessionEnded: e.sessionEnded,
            endReason: e.endReason,
            status: e.status,
            turnCount: e.turnCount,
            turnsRemaining: e.turnsRemaining,
          });
        case 'error':
          return write('error', { code: e.code, message: e.message, retryable: e.retryable });
      }
    };
    try {
      if (!first.done) send(first.value);
      // The turn runs to completion even if the client disconnects, so the reply is saved.
      for await (const event of turn) send(event);
    } catch {
      write('error', {
        code: 'AI_TURN_FAILED',
        message: 'The homeowner simulator is unavailable. Your conversation is saved — retry.',
        retryable: true,
      });
    } finally {
      clearInterval(heartbeat);
      if (open()) res.end();
    }
  }

  @Post(':id/end')
  @HttpCode(200)
  @RequireAnyPermission('ai_practice.use', 'ai_scenarios.update')
  @ZResponse(ai.sessionSchema)
  end(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.sessions.end(p, id);
  }

  @Post(':id/evaluation/retry')
  @HttpCode(200)
  @RequireAnyPermission('ai_practice.use', 'ai_scenarios.update')
  @ZResponse(ai.sessionSchema)
  retryEvaluation(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.sessions.retryEvaluation(p, id);
  }
}

@ApiController('ai/me', 'ai-practice')
export class MySessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get('sessions')
  @RequirePermissions('ai_practice.use')
  @ZResponse(ai.sessionPageSchema)
  history(
    @CurrentPrincipal() p: Principal,
    @ZQuery(ai.mySessionsQuerySchema) q: z.infer<typeof ai.mySessionsQuerySchema>,
  ) {
    return this.sessions.history(p, q);
  }
}

@ApiController('ai/scenarios', 'ai-admin')
export class TestRunController {
  constructor(private readonly sessions: SessionsService) {}

  /** Admin test run of any non-archived scenario (drafts included). Flagged as a test and excluded from analytics. */
  @Post(':id/test-sessions')
  @RequirePermissions('ai_scenarios.update')
  @ZResponse(ai.sessionSchema)
  start(@CurrentPrincipal() p: Principal, @ZParam('id') id: string) {
    return this.sessions.start(p, { scenarioId: id, modality: 'text' }, { test: true });
  }
}
