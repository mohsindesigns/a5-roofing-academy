# A5 Roofing Sales Academy

Onboarding, sales training, AI objection practice, assessments, certification and manager
oversight for A5 Roofing — built as a set of NestJS services behind an API gateway with a React
web app.

- Architecture and decisions: [`docs/A5_SALES_ACADEMY_ARCHITECTURE.md`](docs/A5_SALES_ACADEMY_ARCHITECTURE.md)
- How to build a service: [`docs/SERVICE_DEVELOPMENT_GUIDE.md`](docs/SERVICE_DEVELOPMENT_GUIDE.md)

## Repository

```
apps/
  web/                      React + Vite SPA (http://localhost:5173 in development)
  gateway/                  API gateway / BFF (http://localhost:4000)
  identity-service/         users, sessions, roles & permissions, organization
  learning-service/         programs, lessons, enrollment, progress
  media-service/            uploads, HLS processing, playback, watch telemetry
  assessment-service/       question banks, quizzes, attempts, grading
  ai-coaching-service/      AI homeowner role-play and scorecards
  certification-service/    certifications, templates, issuance, verification
  notification-service/     in-app + email notifications, real-time stream
  analytics-service/        dashboards, reports, exports
  audit-service/            immutable audit log
packages/                   shared libraries (contracts, events, permissions, rules, nest-kit, …)
infra/                      Dockerfiles, nginx, database init, dev scripts
e2e/                        Playwright end-to-end tests and screenshot tooling
```

## Requirements

- Node.js 22.12+ (see `.nvmrc`) and pnpm 10 (`corepack enable`)
- PostgreSQL 16 and Redis 7 — either your own, or `docker compose up -d postgres redis minio mailpit`
- ffmpeg on the PATH for video processing (media-service)

## First run

```bash
pnpm install
pnpm keys:generate          # creates .env with development secrets (Ed25519 keys, HMAC secrets)
pnpm db:create              # one database per service (skip when using docker compose postgres)
pnpm build
pnpm db:migrate             # runs every service's migrations
pnpm db:seed                # A5 Roofing demo organization, people, program, scores, certificates
pnpm dev                    # all services in watch mode + the web app
```

Open http://localhost:5173 and sign in with a seeded account. Every seeded account uses the
development password `RidgeLine-2026!` (override with `SEED_PASSWORD` before seeding).

| Account                             | Role                                             |
| ----------------------------------- | ------------------------------------------------ |
| priya.raman@a5roofing.example       | Super Administrator                              |
| grant.holloway@a5roofing.example    | Administrator                                    |
| shelby.hartman@a5roofing.example    | Training Administrator, Trainer                  |
| danielle.okafor@a5roofing.example   | Manager — Dallas Residential A                   |
| andre.coleman@a5roofing.example     | Manager — Dallas Residential B                   |
| hector.villanueva@a5roofing.example | Trainer                                          |
| ruth.abernathy@a5roofing.example    | Auditor                                          |
| marcus.delgado@a5roofing.example    | Sales Representative (Week 2)                    |
| brianna.castillo@a5roofing.example  | Sales Representative (awaiting manager sign-off) |
| ashlyn.pierce@a5roofing.example     | Sales Representative (certified)                 |

`pnpm dev identity gateway` starts only matching services; `--no-web` skips Vite.

## Everything in containers

```bash
pnpm keys:generate
docker compose up --build
docker compose run --rm identity-service node dist/seed/seed.js   # repeat for each service
```

Web: http://localhost:8080 · Mailpit: http://localhost:8025 · MinIO console: http://localhost:9001

## Quality gates

```bash
pnpm lint          # ESLint (typescript-eslint, react-hooks)
pnpm typecheck     # tsc across every project
pnpm test          # unit + integration tests (needs PostgreSQL and Redis; see TEST_DATABASE_URL / TEST_REDIS_URL)
pnpm build         # production builds
pnpm test:e2e      # Playwright against a running stack
```

Integration tests create a throw-away database per test file on the server in
`TEST_DATABASE_URL` (default `postgres://a5:a5_dev_password@127.0.0.1:5432/postgres`) and use an
isolated Redis key namespace, so suites run in parallel safely.

## Configuration

Every service validates its environment at start-up and refuses to boot with missing or unsafe
values (see `.env.example`). Production must provide its own secrets, `COOKIE_SECURE=true`,
`EXPOSE_ACTIVATION_LINKS=false`, S3-compatible storage and SMTP. AI features use the
development simulator until `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) is configured.

API documentation: each service serves Swagger at `/docs` (non-production); the gateway merges
them at `http://localhost:4000/api/v1/openapi.json`.
