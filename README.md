# resortos-booking-api

REST API for the ResortOS restaurant booking app: guest accounts, table reservations in fixed 2.5-hour slots, an allergy-aware menu, and a read-only admin booking log.

Express 5 · TypeScript · Prisma 7 · PostgreSQL · Zod · Playwright

**Docs:** [docs/API.md](docs/API.md) (every endpoint, who may call it, exact errors, logs) and [docs/DATABASE.md](docs/DATABASE.md) (every table and column), both in plain words.

Specs live in the planning repo (`../requirements/`): `PRD_BOOKING_v1.md` (scope), `api_spec.md` (endpoints), `data_model.md` (schema).

## Run locally

```bash
cp .env.example .env
npm install            # also runs `prisma generate`
npm run db:local       # terminal 1: embedded Postgres (PGlite) persisted in ./.pglite
npm run db:migrate     # terminal 2
npm run db:seed        # dining tables, menu, admin account (ADMIN_EMAIL / ADMIN_PASSWORD), assistant account storing only the SHA-256 of AGENT_API_KEY
npm run dev            # http://localhost:4000/api/public/health
```

`npm run db:local` is for development only. To use a real Postgres instead, run `docker compose up -d` (or point `DATABASE_URL` at any Postgres 17) and skip `db:local`.

## Test

```bash
npm test               # Playwright (unit + API) then Jest with coverage
npm run test:e2e       # Playwright only: tests/unit, tests/api
npm run test:jest      # Jest only: tests/jest, fails below 100% coverage
npm run typecheck
```

Neither suite needs a database. Each boots its own in-memory PGlite (Playwright on port 5499, Jest on 5498), applies the migrations and seeds.

**Real PostgreSQL (true parallel races):** PGlite runs everything in one session, so it can't judge real concurrency. Point the suites at an empty Postgres database: `TEST_DATABASE_URL=postgresql://user@localhost:5432/empty_db npm run test:pg`. One race test runs only in this mode.

**Test database for manual or e2e use:** `npm run db-test` (fake data, port 5433) and `npm run start:test` (API on 4400).

* **Playwright** (`tests/unit`, `tests/api`): black-box checks of the HTTP contract in `api_spec.md`.
* **Jest** (`tests/jest`): supertest against `createApp()` plus direct unit tests, with a 100% statement/branch/function/line threshold over `src/` (excluding `src/generated`). It uses `@swc/jest` because `ts-jest` doesn't support TypeScript 7. The HTML report is in `coverage/lcov-report/index.html`.

## Layout

| Path | What lives there |
|---|---|
| `src/domain/` | Booking rules: fixed slots (`slots.ts`), table allocation (`allocation.ts`), reservation transactions (`reservations.ts`) |
| `src/routes/` | One router per resource: `auth`, `profile`, `reservations` (+ availability), `menu` (+ recommendations), `admin`, `agent` (the assistant's two routes); `app.ts` mounts them in the route groups |
| `src/middleware/` | The auth check per route group (`requireSession`, `requireAdmin`, `requireAgentKey`), the error handler |
| `src/lib/` | DB client, session tokens and SHA-256, Zod helpers, permissions (RBAC), audit log, app and error logs, rate limits, notification stub |
| `docs/` | Plain-language guides: `API.md`, `DATABASE.md` |
| `prisma/` | Schema, migrations (the init migration adds the append-only `AuditLog` trigger), seed |
| `tests/unit/`, `tests/api/` | Playwright suites |
| `tests/jest/` | Jest suites (coverage) |

## Production notes

* Set `NODE_ENV=production`, an `AGENT_API_KEY` of at least 32 characters, `CORS_ORIGIN` to the web app's URL, and serve over HTTPS (the session cookie is `Secure` in production).
* `npm run build && npm start`. Apply migrations with `npm run db:migrate`.
* Give the app's database role only `INSERT, SELECT` on `"AuditLog"`.

## Logs
* `logs/app.log` (`APP_LOG_PATH`): one line for every request that changed the database and succeeded (sign-up, sign-in, sign-out, profile and booking changes), also printed with `console.log`.
* `logs/errors.log` (`ERROR_LOG_PATH`): one line for every 4xx/5xx response, also printed with `console.error`.
* Every line starts with the HTTP method in brackets, then JSON: `[POST] {"time":…,"action":"RESERVATION_CREATED",…}`. No bodies, passwords, tokens, keys, query strings or personal data.
* Each file is renamed to `.1` once it passes 5 MB (`APP_LOG_MAX_BYTES`, `ERROR_LOG_MAX_BYTES`) and the previous `.1` is deleted: one live file and at most one old copy. Old `errors.log.2` / `.3` files from earlier versions are no longer touched and can be deleted by hand. `APP_LOG_CONSOLE=false` / `ERROR_LOG_CONSOLE=false` stop the printing.

## Sessions
* Guests and admins: signing in sets an `HttpOnly`, `SameSite=Lax` cookie `session` on path `/` holding a random token, valid for a fixed `SESSION_TTL` from sign-in (default `1h`, e.g. `30m` or `8s`) and never extended. The server keeps one `Session` row per signed-in browser with only the token's SHA-256. There is no refresh: after it ends every call returns `401` and the guest signs in again. `Authorization: Bearer` is not accepted.
* Signing out deletes that browser's `Session` row, so the cookie and any copy of it stop working at once; other devices stay signed in. Deleting a user deletes their sessions.
* The AI assistant sends `X-Agent-Key: <AGENT_API_KEY>`. The seed stores only its SHA-256 in the `ApiKey` table, on `assistant@resortos.internal` (no password); re-seeding with a new key replaces it. A wrong key gets `401 Invalid API key`.
* Route groups: `/api/public` (no sign-in), `/api/auth` (rate limit), `/api/users` (session cookie), `/api/admins` (session cookie + admin), `/api/agents` (assistant key). See [docs/API.md](docs/API.md).
* Origin rule (CSRF): a request other than GET/HEAD/OPTIONS whose `Origin` header isn't `CORS_ORIGIN` gets `403 Cross-origin request blocked`.
* In development, open the web app at `http://localhost:5173`, not `127.0.0.1`: the browser then sends `Origin: http://127.0.0.1:5173`, which isn't `CORS_ORIGIN`, so sign-in and every other POST get `403`.
