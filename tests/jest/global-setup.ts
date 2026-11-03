import { exec } from "node:child_process";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const DB_PORT = 5498;
// Async on purpose: a sync exec would block the event loop serving the in-process PGlite socket.
const run = promisify(exec);

export const TEST_ENV = {
  DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres?sslmode=disable`,
  JWT_ACCESS_SECRET: "jest-access-secret-jest-access-secret",
  JWT_REFRESH_SECRET: "jest-refresh-secret-jest-refresh-secret",
  AUTH_RATE_LIMIT: "10000",
  ADMIN_EMAIL: "admin@resortos.test",
  ADMIN_PASSWORD: "Admin12345!",
  AGENT_EMAIL: "assistant@resortos.internal",
  AGENT_PASSWORD: "Agent12345!",
  RESTAURANT_UTC_OFFSET: "+07:00",
  CORS_ORIGIN: "http://localhost:5173",
};

/** In-memory Postgres (PGlite) with migrations + seed, shared by every Jest test file. */
export default async function globalSetup() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: DB_PORT, host: "127.0.0.1", maxConnections: 10 });
  await server.start();
  Object.assign(process.env, TEST_ENV);
  await run("npx prisma migrate deploy", { env: process.env });
  await run("npx tsx prisma/seed.ts", { env: process.env });
  Object.assign(globalThis, { __PGLITE__: { db, server } });
}
