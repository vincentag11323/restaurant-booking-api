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
npm run db:seed        # dining tables, menu, admin account from ADMIN_EMAIL / ADMIN_PASSWORD
npm run dev            # http://localhost:4000/api/health
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

* **Playwright** (`tests/unit`, `tests/api`): black-box checks of the HTTP contract in `api_spec.md`.
* **Jest** (`tests/jest`): supertest against `createApp()` plus direct unit tests, with a 100% statement/branch/function/line threshold over `src/` (excluding `src/generated`). It uses `@swc/jest` because `ts-jest` doesn't support TypeScript 7. The HTML report is in `coverage/lcov-report/index.html`.

## Layout

| Path | What lives there |
|---|---|
| `src/domain/` | Booking rules: fixed slots (`slots.ts`), table allocation (`allocation.ts`), reservation transactions (`reservations.ts`) |
| `src/routes/` | One router per resource: `auth`, `profile`, `reservations` (+ availability), `menu`, `admin` |
| `src/lib/` | DB client, JWT, Zod helpers, audit log, notification stub |
| `prisma/` | Schema, migrations (the init migration adds the append-only `AuditLog` trigger), seed |
| `tests/unit/`, `tests/api/` | Playwright suites |
| `tests/jest/` | Jest suites (coverage) |

## Production notes

* Set `NODE_ENV=production`, long random `JWT_*` secrets, `CORS_ORIGIN` to the web app's URL, and serve over HTTPS (the refresh cookie is `Secure` in production).
* `npm run build && npm start`. Apply migrations with `npm run db:migrate`.
* Give the app's database role only `INSERT, SELECT` on `"AuditLog"`.
