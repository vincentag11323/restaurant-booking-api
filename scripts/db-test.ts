// `npm run db-test`: an in-memory TEST database with fake data, rebuilt on every start (e2e_spec.md §2).
// Serves Postgres on DB_TEST_PORT (default 5433) until stopped. Never point production at it.
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const port = Number(process.env.DB_TEST_PORT ?? 5433);
// Async on purpose: a sync exec would block the event loop that serves the in-process database.
const run = promisify(exec);

const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 10 });
await server.start();

const env = {
  ...process.env,
  DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`,
  ADMIN_EMAIL: "admin@resortos.test",
  ADMIN_PASSWORD: "Admin12345!",
  AGENT_API_KEY: "e2e-only-agent-key-e2e-only-agent-key-0001",
};
await run("npx prisma migrate deploy", { env });
await run("npx tsx prisma/seed.ts", { env });
await run("npx tsx prisma/seed-test.ts", { env });

console.info(`
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  TEST DATABASE (fake data)  postgres://127.0.0.1:${port}                    │
  │  admin@resortos.test / Admin12345!                                       │
  │  assistant@resortos.internal: no password, X-Agent-Key only (role AGENT) │
  │  ayu@guests.test, budi@guests.test / Password123                         │
  │  citra@guests.test: guest account, not signed up                         │
  └──────────────────────────────────────────────────────────────────────────┘`);

const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
