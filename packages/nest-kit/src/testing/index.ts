import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { pino } from 'pino';
import { PRINCIPAL_HEADER, SERVICE_TOKEN_HEADER, signPrincipalToken, signServiceToken, type PrincipalData } from '@a5/auth';
import type { Producer } from '@a5/events';
import type { Logger } from '@a5/observability';
import type { DataScope, PermissionKey, PermissionMap } from '@a5/permissions';
import { configureApplication } from '../bootstrap.js';
import type { ServiceRuntimeConfig } from '../config.js';

export const TEST_INTERNAL_SECRET = 'test-internal-secret-0123456789abcdef0123';

export function testLogger(): Logger {
  return pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' });
}

export function testServiceConfig(
  serviceName: Producer,
  overrides: Partial<ServiceRuntimeConfig> = {},
): ServiceRuntimeConfig {
  return {
    serviceName,
    nodeEnv: 'test',
    role: 'all',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    redisUrl: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379',
    redisNamespace: `test:${serviceName}:${Math.random().toString(36).slice(2, 10)}`,
    internalAuthSecret: TEST_INTERNAL_SECRET,
    databasePoolMax: 5,
    databaseStatementTimeoutMs: 10_000,
    swaggerEnabled: false,
    bodyLimit: '1mb',
    shutdownGraceMs: 5_000,
    serviceUrls: {},
    publicAppUrl: 'http://localhost:5173',
    ...overrides,
  };
}

export async function createTestApp(
  module: unknown,
  config: ServiceRuntimeConfig,
  configure?: (app: NestExpressApplication) => void | Promise<void>,
  options: { parseBodies?: boolean } = {},
): Promise<NestExpressApplication> {
  const ref = await Test.createTestingModule({ imports: [module as never] }).compile();
  const app = ref.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  configureApplication(app, config, options);
  await configure?.(app);
  await app.init();
  return app;
}

export interface TestPrincipalInput {
  userId: string;
  organizationId: string;
  displayName?: string;
  roles?: string[];
  /** Either explicit scopes, or a list of permissions that all get `scope`. */
  permissions?: PermissionMap | PermissionKey[];
  scope?: DataScope;
  managedTeamIds?: string[];
  managedUserIds?: string[];
  sessionId?: string | null;
}

export async function principalHeaders(
  input: TestPrincipalInput,
  secret = TEST_INTERNAL_SECRET,
): Promise<Record<string, string>> {
  const permissions: PermissionMap = Array.isArray(input.permissions)
    ? Object.fromEntries(input.permissions.map((p) => [p, input.scope ?? 'organization']))
    : (input.permissions ?? {});
  const data: PrincipalData = {
    userId: input.userId,
    organizationId: input.organizationId,
    sessionId: input.sessionId ?? null,
    displayName: input.displayName ?? 'Test User',
    roles: input.roles ?? [],
    permissions,
    managedTeamIds: input.managedTeamIds ?? [],
    managedUserIds: input.managedUserIds ?? [],
  };
  return { [PRINCIPAL_HEADER]: await signPrincipalToken(data, secret) };
}

export async function serviceHeaders(service: string, secret = TEST_INTERNAL_SECRET): Promise<Record<string, string>> {
  return { [SERVICE_TOKEN_HEADER]: await signServiceToken(service, secret) };
}

export async function closeApp(app: INestApplication | undefined): Promise<void> {
  await app?.close();
}
