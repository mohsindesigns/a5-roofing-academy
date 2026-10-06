import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Get, Module, Post } from '@nestjs/common';
import request from 'supertest';
import { z } from 'zod';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Principal } from '@a5/auth';
import {
  ApiController,
  ConflictError,
  CoreModule,
  CurrentPrincipal,
  InternalController,
  Public,
  RequirePermissions,
  ZBody,
  ZParam,
  ZQuery,
  ZResponse,
} from './index.js';
import {
  closeApp,
  createTestApp,
  principalHeaders,
  serviceHeaders,
  testLogger,
  testServiceConfig,
} from './testing/index.js';

const ORG = '0190a3b2-0000-7000-8000-0000000000d1';
const USER = '0190a3b2-0000-7000-8000-0000000000d2';

const widgetSchema = z.object({ id: z.string(), name: z.string() });

@ApiController('widgets')
class WidgetController {
  @Get()
  @RequirePermissions('programs.view')
  @ZResponse(z.object({ items: z.array(widgetSchema) }))
  list(
    @ZQuery(z.object({ limit: z.coerce.number().int().max(10).default(5) })) q: { limit: number },
  ) {
    return { items: [{ id: '1', name: 'Ridge cap', secretColumn: 'leak' }].slice(0, q.limit) };
  }

  @Post()
  @RequirePermissions('programs.create')
  create(
    @ZBody(z.object({ name: z.string().min(3) })) body: { name: string },
    @CurrentPrincipal() p: Principal,
  ) {
    if (body.name === 'duplicate')
      throw new ConflictError('WIDGET_EXISTS', 'A widget with this name already exists.');
    return { name: body.name, by: p.userId };
  }

  @Get(':id')
  @Public()
  one(@ZParam('id') id: string) {
    return { id };
  }

  @Get('boom/now')
  @Public()
  boom() {
    throw new Error('database password is hunter2');
  }
}

@InternalController('widgets')
class InternalWidgetController {
  @Get()
  list() {
    return { ok: true };
  }
}

const config = testServiceConfig('learning-service');

@Module({
  imports: [CoreModule.forRoot(config, testLogger())],
  controllers: [WidgetController, InternalWidgetController],
})
class TestModule {}

let app: NestExpressApplication;

beforeAll(async () => {
  app = await createTestApp(TestModule, config);
});
afterAll(() => closeApp(app));

describe('authentication and authorization', () => {
  it('rejects requests without a principal', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/widgets');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('returns 403 when a permission is missing', async () => {
    const headers = await principalHeaders({
      userId: USER,
      organizationId: ORG,
      permissions: ['programs.create'],
    });
    const res = await request(app.getHttpServer()).get('/api/v1/widgets').set(headers);
    expect(res.status).toBe(403);
    expect(res.body.error.details).toEqual({ required: ['programs.view'] });
  });

  it('rejects forged principal tokens', async () => {
    const headers = await principalHeaders(
      { userId: USER, organizationId: ORG, permissions: ['programs.view'] },
      'x'.repeat(40),
    );
    expect((await request(app.getHttpServer()).get('/api/v1/widgets').set(headers)).status).toBe(
      401,
    );
  });

  it('requires a service token for internal routes, even with a principal', async () => {
    const userHeaders = await principalHeaders({
      userId: USER,
      organizationId: ORG,
      permissions: ['programs.view'],
    });
    expect(
      (await request(app.getHttpServer()).get('/internal/widgets').set(userHeaders)).status,
    ).toBe(401);
    const svc = await serviceHeaders('gateway');
    expect((await request(app.getHttpServer()).get('/internal/widgets').set(svc)).status).toBe(200);
  });
});

describe('contracts', () => {
  it('strips properties that are not part of the response contract', async () => {
    const headers = await principalHeaders({
      userId: USER,
      organizationId: ORG,
      permissions: ['programs.view'],
    });
    const res = await request(app.getHttpServer()).get('/api/v1/widgets?limit=3').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toEqual({ id: '1', name: 'Ridge cap' });
  });

  it('reports validation errors per field', async () => {
    const headers = await principalHeaders({
      userId: USER,
      organizationId: ORG,
      permissions: ['programs.create'],
    });
    const res = await request(app.getHttpServer())
      .post('/api/v1/widgets')
      .set(headers)
      .send({ name: 'ab' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.fields[0].path).toBe('name');
  });

  it('validates params and query', async () => {
    expect((await request(app.getHttpServer()).get('/api/v1/widgets/not-a-uuid')).status).toBe(400);
    const headers = await principalHeaders({
      userId: USER,
      organizationId: ORG,
      permissions: ['programs.view'],
    });
    expect(
      (await request(app.getHttpServer()).get('/api/v1/widgets?limit=50').set(headers)).status,
    ).toBe(400);
  });

  it('passes domain errors through with code and message', async () => {
    const headers = await principalHeaders({
      userId: USER,
      organizationId: ORG,
      permissions: ['programs.create'],
    });
    const res = await request(app.getHttpServer())
      .post('/api/v1/widgets')
      .set(headers)
      .send({ name: 'duplicate' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'WIDGET_EXISTS',
      message: 'A widget with this name already exists.',
    });
  });

  it('never leaks internal error messages', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/widgets/boom/now');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });

  it('rejects malformed JSON with a clear message', async () => {
    const headers = await principalHeaders({
      userId: USER,
      organizationId: ORG,
      permissions: ['programs.create'],
    });
    const res = await request(app.getHttpServer())
      .post('/api/v1/widgets')
      .set({ ...headers, 'content-type': 'application/json' })
      .send('{"name":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MALFORMED_JSON');
  });
});

describe('logging', () => {
  it('never writes query strings (signed tokens) to logs', async () => {
    const lines: string[] = [];
    const { pino } = await import('pino');
    const { Writable } = await import('node:stream');
    const sink = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const cfg = testServiceConfig('learning-service');
    @Module({
      imports: [CoreModule.forRoot(cfg, pino({ level: 'info' }, sink))],
      controllers: [WidgetController],
    })
    class LoggedModule {}
    const logged = await createTestApp(LoggedModule, cfg);
    const headers = await principalHeaders({
      userId: USER,
      organizationId: ORG,
      permissions: ['programs.create'],
    });
    const res = await request(logged.getHttpServer())
      .get('/api/v1/widgets?token=super-secret-playback-token')
      .set(headers);
    expect(res.status).toBe(403);
    await closeApp(logged);
    const all = lines.join('');
    expect(all).toContain('request rejected');
    expect(all).not.toContain('super-secret-playback-token');
  });
});

describe('request context and health', () => {
  it('echoes a valid incoming request id', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/live')
      .set('x-request-id', 'req-12345678');
    expect(res.headers['x-request-id']).toBe('req-12345678');
  });

  it('reports readiness', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
