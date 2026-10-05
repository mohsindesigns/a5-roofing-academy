# Service development guide

How to build a backend service in this monorepo. `apps/identity-service` is the reference
implementation; copy its structure. Read `docs/A5_SALES_ACADEMY_ARCHITECTURE.md` first.

## 1. Layout

```
apps/<name>-service/
  .env.development          PORT and DATABASE_URL defaults (committed, no secrets)
  package.json              scripts: build, typecheck, lint, test, dev, start, db:migrate, db:seed
  tsconfig.json             project references to every workspace package used
  vitest.config.ts          createVitestConfig from ../../vitest.shared.js
  src/
    main.ts                 bootstrapService({ config, title, module: (logger) => AppModule.register(config, logger) })
    config.ts               loadServiceConfig('<name>-service', <port>, extraEnvSchema)
    app.module.ts           CoreModule.forRoot, DatabaseModule.forRoot, RedisModule, EventsModule.forRoot, [DirectoryModule], feature modules
    database/
      schema.ts             Kysely table interfaces + <Name>Database interface (extends OutboxSchema/InboxSchema/DirectorySchema as needed)
      index.ts              Db / Trx type aliases
      migrations/0001_*.ts  up/down with raw SQL (sql`...`.execute(db))
      migrations/index.ts   static MigrationMap
      migrate.ts            CLI (copy identity-service)
    <feature>/              controller(s), service(s), repository(ies) per bounded feature
    seed/seed-<name>.ts     idempotent seed using @a5/seed-data; seed.ts CLI
  test/
    harness.ts              test DB + migrations + seed subset + createTestApp + principal headers
    *.test.ts               integration tests against real PostgreSQL and Redis
```

| Service               | Port | Database           | Gateway prefixes (`/api/v1/...`)                                              |
| --------------------- | ---- | ------------------ | ----------------------------------------------------------------------------- |
| identity-service      | 4010 | a5_identity        | auth, users, roles, permissions, organization, locations, departments, teams, settings, feature-flags |
| learning-service      | 4020 | a5_learning        | programs, enrollments, lessons, progress, learning                            |
| media-service         | 4030 | a5_media           | media (media/hls and media/dev-storage are public)                            |
| assessment-service    | 4040 | a5_assessment      | question-banks, questions, assessments, attempts                              |
| ai-coaching-service   | 4050 | a5_ai              | ai (streaming allowed)                                                        |
| certification-service | 4060 | a5_certification   | certifications, certificate-templates, certificates, signatories, stamps, certification-settings, certification-assets (uploads), certification-files (public signed), public/certificates (public) |
| notification-service  | 4070 | a5_notification    | notifications (notifications/stream is SSE), notification-templates, notification-rules |
| analytics-service     | 4080 | a5_analytics       | analytics, reports                                                            |
| audit-service         | 4090 | a5_audit           | audit                                                                         |

Controllers use exactly these prefixes via `@ApiController('<prefix>')` (it adds `api/v1/`).
Service-to-service endpoints use `@InternalController('<path>')` → `/internal/<path>`; they
require a service token and are never reachable through the gateway.

## 2. Request handling

* Validation: `@ZBody(schema)`, `@ZQuery(schema)`, `@ZParam('id')` with Zod schemas from
  `@a5/contracts` (`packages/contracts/src/<domain>.ts`). The web app imports the same schemas.
* Responses: always declare `@ZResponse(schema)`. The interceptor parses the response through the
  schema and strips unknown properties, so internal columns cannot leak. Map DB rows to DTOs.
* Authorization: `@RequirePermissions(...)` / `@RequireAnyPermission(...)` with keys from
  `@a5/permissions`. Inject the caller with `@CurrentPrincipal() p: Principal`.
* Data scope: for user-owned records call `p.scopeFilter('<permission>')` and translate it with
  `userScopeCondition(filter, { userColumn: 't.user_id', orgColumn: 't.organization_id' })` from
  `@a5/directory` (requires the directory projection tables). For single records, return
  `NotFoundError` (404) when out of scope so existence is not disclosed.
* Self-service endpoints (`/me/...`) use the caller's own id; require the self-service permission
  (`training.participate`, `assessments.take`, `ai_practice.use`, `certificates.view_own`).
* Always filter tenant data by `p.organizationId`.
* Errors: throw `NotFoundError`, `ForbiddenError`, `ConflictError(code, message)`,
  `PreconditionError(code, message)` (422), `ValidationError(fields)` or `AppError(status, code,
  message)`. Messages are written for the end user and say what to do next. No generic
  "Something went wrong".
* No business logic in controllers. Services own transactions.

## 3. Data

* Kysely, raw SQL migrations with working `down`. Table types in `schema.ts`.
* UUIDv7 ids from `uuidv7()` (`@a5/observability`). `created_at`, `updated_at` (+ trigger via
  `addUpdatedAtTrigger`), `created_by`, `updated_by` on mutable aggregates.
* Index for the real query patterns; add partial/unique indexes for invariants (e.g. one active
  certificate per user and definition).
* Immutable history: never update attempts, sessions, snapshots or versions after they are final;
  write new rows.
* Every threshold / policy is data (columns or validated JSONB config), never a constant.
* Postgres `DATE` values are returned as `'YYYY-MM-DD'` strings, `BIGINT`/`NUMERIC` as numbers.

## 4. Events

* Producing: inside the same transaction as the state change call
  `await this.events.emit(trx, <definition>, payload, { subject })` (`EventBus` from
  `@a5/nest-kit`). Contracts live in `packages/events/src/catalog.ts`; payloads are validated.
* Audit: `await this.events.audit(trx, { action, resourceType, resourceId, actorDisplay, before, after, reason })`
  for every administrative or sensitive mutation.
* Consuming: a provider method decorated `@OnEvent(<definition>)`; wrap effects in
  `processOnce(db, '<handler-name>', event, async (trx) => { ... })` (`@a5/messaging`). Handlers
  must be idempotent and tolerate out-of-order delivery (compare timestamps/revisions, upsert).
* Directory projection: services that need people/team data import `DirectoryModule` from
  `@a5/directory`, create tables in their first migration with `createDirectoryTables(db)` and
  `createInboxTable(db)`; `DirectoryReader` provides lookups. Seeds fill it directly with
  `applyDirectoryUser/Team/Unit` and `directoryUsers()/directoryTeams()/directoryUnits()` from
  `@a5/seed-data`.
* The outbox relay and consumers start automatically in `worker`/`all` roles.

## 5. Background work

* `QueueFactory` (`@a5/messaging`, injectable): `queues.add('<service>.<job>', name, data, { jobId })`
  and `queues.worker('<service>.<job>', processor)`. Register workers in `onModuleInit` only when
  `runsWorkers(config)` is true. Use deterministic `jobId`s for idempotency. Never do slow work in
  the HTTP request.
* Locks: `DistributedLock.withLock(name, ttlMs, fn)`; always backed by a DB constraint.
* Cache: `Cache.getOrSet(key, ttl, loader)` and `Cache.bump(namespace)` for invalidation after
  commits. Never cache secrets, answers or transcripts.

## 6. Tests

* Integration tests run against the local PostgreSQL (`TEST_DATABASE_URL`, default
  `postgres://a5:a5_dev_password@127.0.0.1:5432/postgres`) and Redis (`TEST_REDIS_URL`).
* Harness: `createTestDatabase(name)`, `migrateToLatest`, seed, `createTestApp(module, config)`
  from `@a5/nest-kit/testing`, `principalHeaders({ userId, organizationId, permissions, scope,
  managedTeamIds, managedUserIds })`, `serviceHeaders('<svc>')`. Use `testRedisNamespace`.
* Cover: happy paths, validation errors, permission denials (403), out-of-scope access (404),
  managers limited to their teams, idempotency of event handlers, concurrency where relevant.
* Commands (from the service directory): `pnpm exec tsc -b`, `pnpm exec vitest run`,
  `pnpm exec eslint src test` (root config).

## 7. Seeds

* `src/seed/seed-<name>.ts` exports a function used by both the CLI and tests; it is idempotent
  (skip when the seed rows exist). Use ids and content from `@a5/seed-data` (`PROGRAM`, `PHASES`,
  `ASSESSMENTS`, `SCENARIOS`, `CERTIFICATION`, `JOURNEYS`, `PEOPLE`, `SEED_NOW`). Believable A5
  content only — never "John Doe" or lorem ipsum.

## 8. Definition of done (backend)

API implemented with validation, permissions and scope, persistence with migrations, events and
audit where relevant, tests passing, typecheck and lint clean, OpenAPI documented through Zod
contracts, seed data in place.
