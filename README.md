# resortos-booking-api

REST API for the ResortOS restaurant booking app: guest accounts, table reservations in fixed 2.5-hour slots, an allergy-aware menu, and a read-only admin booking log.

Express 5 · TypeScript · Prisma 7 · PostgreSQL · Zod · Playwright

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
| `src/routes/` | One router per resource: `auth`, `profile`, `reservations` (+ availability), `menu`, `admin`, `agent` (the assistant's two routes) |
| `src/lib/` | DB client, session tokens and agent key hash, Zod helpers, permissions (RBAC), audit log, failure log, rate limits, notification stub |
| `prisma/` | Schema, migrations (the init migration adds the append-only `AuditLog` trigger), seed |
| `tests/unit/`, `tests/api/` | Playwright suites |
| `tests/jest/` | Jest suites (coverage) |

## Production notes

* Set `NODE_ENV=production`, an `AGENT_API_KEY` of at least 32 characters, `CORS_ORIGIN` to the web app's URL, and serve over HTTPS (the session cookie is `Secure` in production).
* `npm run build && npm start`. Apply migrations with `npm run db:migrate`.
* Give the app's database role only `INSERT, SELECT` on `"AuditLog"`.

## Failure log
Every 4xx/5xx response is written as one JSON line to `logs/errors.log` (`ERROR_LOG_PATH`) and printed with `console.error`. No bodies, passwords or query strings. The file rotates at 5 MB (`ERROR_LOG_MAX_BYTES`) and keeps 3 old copies.

## Sessions
* Guests and admins: signing in sets an `HttpOnly`, `SameSite=Lax` cookie `session` on path `/`, valid for a fixed `SESSION_TTL` from sign-in (default `1h`, e.g. `30m` or `8s`) and never extended. There is no refresh: after it ends every call returns `401` and the guest signs in again. `Authorization: Bearer` is not accepted.
* The AI assistant sends `X-Agent-Key: <AGENT_API_KEY>`. The seed stores only its SHA-256 on `assistant@resortos.internal`, which has no password; a wrong key gets `401 Invalid API key`.
* Origin rule (CSRF): a request other than GET/HEAD/OPTIONS whose `Origin` header isn't `CORS_ORIGIN` gets `403 Cross-origin request blocked`.
* In development, open the web app at `http://localhost:5173`, not `127.0.0.1`: the browser then sends `Origin: http://127.0.0.1:5173`, which isn't `CORS_ORIGIN`, so sign-in and every other POST get `403`.
