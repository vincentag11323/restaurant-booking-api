import { exec } from "node:child_process";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const DB_PORT = 5498;
// Async on purpose: a sync exec would block the event loop serving the in-process PGlite socket.
const run = promisify(exec);

export const TEST_ENV = {
  DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres?sslmode=disable`,
  SESSION_SECRET: "jest-session-secret-jest-session-secret",
  AUTH_RATE_LIMIT: "10000",
  ADMIN_EMAIL: "admin@resortos.test",
  ADMIN_PASSWORD: "Admin12345!",
  AGENT_API_KEY: "jest-agent-key-jest-agent-key-jest-agent-key",
  ERROR_LOG_PATH: `${process.cwd()}/test-results/errors-jest.log`,
  ERROR_LOG_CONSOLE: "false",
  RESTAURANT_UTC_OFFSET: "+07:00",
  CORS_ORIGIN: "http://localhost:5173",
};

/** In-memory Postgres (PGlite) with migrations + seed, shared by every Jest test file. */
export default async function globalSetup() {
  // TEST_DATABASE_URL runs the suite on a real (empty) PostgreSQL, e.g. for true parallel races.
  const external = process.env.TEST_DATABASE_URL;
  const db = external ? null : await PGlite.create();
  const server = db ? new PGLiteSocketServer({ db, port: DB_PORT, host: "127.0.0.1", maxConnections: 10 }) : null;
  await server?.start();
  Object.assign(process.env, TEST_ENV, external ? { DATABASE_URL: external } : {});
  await run("npx prisma migrate deploy", { env: process.env });
  await run("npx tsx prisma/seed.ts", { env: process.env });
  Object.assign(globalThis, { __PGLITE__: { db, server } });
}
