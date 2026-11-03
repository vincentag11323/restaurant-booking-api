import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type { Express } from "express";
import request from "supertest";
import { TEST_ENV } from "./global-setup.js";

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
  jest.resetModules();
});

/** Loads a fresh copy of a module with the given env and no .env file. */
function load<T>(path: string, env: Record<string, string | undefined>): T {
  let mod!: T;
  jest.isolateModules(() => {
    jest.doMock("dotenv/config", () => ({}));
    // Keep the suite's current database (PGlite or TEST_DATABASE_URL).
    process.env = { ...TEST_ENV, DATABASE_URL: original.DATABASE_URL, ...env } as NodeJS.ProcessEnv;
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
    mod = require(path);
  });
  return mod;
}

describe("config", () => {
  it("fails fast when a required secret is missing", () => {
    expect(() => load("../../src/config.js", { JWT_ACCESS_SECRET: undefined })).toThrow("Missing required env var: JWT_ACCESS_SECRET");
  });

  it("falls back to documented defaults", () => {
    const { config } = load<typeof import("../../src/config.js")>("../../src/config.js", {
      PORT: undefined,
      CORS_ORIGIN: undefined,
      RESTAURANT_UTC_OFFSET: undefined,
      AUTH_RATE_LIMIT: undefined,
      NODE_ENV: undefined,
      ERROR_LOG_PATH: undefined,
      ERROR_LOG_MAX_BYTES: undefined,
      ERROR_LOG_CONSOLE: undefined,
      ACCESS_TOKEN_TTL: undefined,
    });
    expect(config).toMatchObject({
      port: 4000,
      corsOrigin: "http://localhost:5173",
      utcOffset: "+07:00",
      authRateLimit: 20,
      isProduction: false,
      errorLog: { path: "logs/errors.log", maxBytes: 5 * 1024 * 1024, console: true },
      accessTokenTtl: "15m",
    });
  });
});

describe("production mode", () => {
  it("trusts the hosting proxy and marks the refresh cookie Secure", async () => {
    const { createApp } = load<typeof import("../../src/app.js")>("../../src/app.js", { NODE_ENV: "production" });
    const app: Express = createApp();
    expect(app.get("trust proxy")).toBe(1);
    const res = await request(app).post("/api/auth/login").send({ email: "admin@resortos.test", password: "Admin12345!" });
    expect(res.headers["set-cookie"]?.[0]).toContain("Secure");
    const { prisma } = load<typeof import("../../src/lib/db.js")>("../../src/lib/db.js", {});
    await prisma.$disconnect();
  });
});

describe("auth rate limit", () => {
  it("answers 429 with the standard JSON error body", async () => {
    const { createApp } = load<typeof import("../../src/app.js")>("../../src/app.js", { AUTH_RATE_LIMIT: "2" });
    const app = createApp();
    for (let i = 0; i < 2; i++) await request(app).post("/api/auth/logout");
    const res = await request(app).post("/api/auth/logout");
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ message: "Too many attempts. Please wait a few minutes and try again." });
  });
});

describe("server entry point", () => {
  it("starts the app on the configured port", () => {
    const listen = jest.fn((_port: number, cb: () => void) => cb());
    const info = jest.spyOn(console, "info").mockImplementation(() => {});
    jest.isolateModules(() => {
      jest.doMock("../../src/app.js", () => ({ createApp: () => ({ listen }) }));
      jest.doMock("dotenv/config", () => ({}));
      process.env = { ...TEST_ENV, PORT: "4321" } as NodeJS.ProcessEnv;
      require("../../src/index.js");
    });
    expect(listen).toHaveBeenCalledWith(4321, expect.any(Function));
    expect(info).toHaveBeenCalledWith("ResortOS booking API listening on :4321");
    info.mockRestore();
  });
});
