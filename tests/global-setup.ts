import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Server } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { TEST_API_PORT } from "../playwright.config.js";

const DB_PORT = 5499;
// Async on purpose: execSync would block the event loop that serves the in-process PGlite socket.
const run = promisify(exec);

/** Boots an in-memory Postgres (PGlite), applies migrations + seed, and starts the API. */
export default async function globalSetup() {
  // TEST_DATABASE_URL runs the suite on a real (empty) PostgreSQL, e.g. for true parallel races.
  const external = process.env.TEST_DATABASE_URL;
  const db = external ? null : await PGlite.create();
  const dbServer = db ? new PGLiteSocketServer({ db, port: DB_PORT, host: "127.0.0.1", maxConnections: 10 }) : null;
  await dbServer?.start();

  Object.assign(process.env, {
    DATABASE_URL: external ?? `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres?sslmode=disable`,
    JWT_ACCESS_SECRET: "test-access-secret-test-access-secret",
    JWT_REFRESH_SECRET: "test-refresh-secret-test-refresh-secret",
    AUTH_RATE_LIMIT: "10000",
    ADMIN_EMAIL: "admin@resortos.test",
    ADMIN_PASSWORD: "Admin12345!",
    AGENT_EMAIL: "assistant@resortos.internal",
    AGENT_PASSWORD: "Agent12345!",
    ERROR_LOG_PATH: `${process.cwd()}/test-results/errors-e2e.log`,
    ERROR_LOG_CONSOLE: "false",
  });
  await run("npx prisma migrate deploy", { env: process.env });
  await run("npx tsx prisma/seed.ts", { env: process.env });

  const { createApp } = await import("../src/app.js");
  const api: Server = await new Promise((resolve) => {
    const server = createApp().listen(TEST_API_PORT, "127.0.0.1", () => resolve(server));
  });

  return async () => {
    api.close();
    await dbServer?.stop();
    await db?.close();
  };
}
