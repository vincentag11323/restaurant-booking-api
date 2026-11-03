import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { todayLocal } from "../../src/domain/slots.js";
import { TEST_API_PORT } from "../../playwright.config.js";

export const ADMIN = { email: "admin@resortos.test", password: "Admin12345!" };
export const AGENT_EMAIL = "assistant@resortos.internal";
export const AGENT_API_KEY = "test-agent-key-test-agent-key-test-agent-key";
const API = `http://127.0.0.1:${TEST_API_PORT}`;

/**
 * Signs in with plain fetch so the test's own request context keeps no cookie; callers send
 * the returned `Cookie` header explicitly, which lets one test act as a guest and an admin.
 */
async function signIn(path: string, data: Record<string, unknown>, status: number) {
  const res = await fetch(`${API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  expect(res.status).toBe(status);
  const session = res.headers.getSetCookie().find((c) => c.startsWith("session="));
  expect(session).toBeDefined();
  return { body: await res.json(), headers: { Cookie: session!.split(";")[0] } };
}

export async function registerGuest(_request: unknown, overrides: Record<string, unknown> = {}) {
  const email = `guest-${randomUUID()}@test.dev`;
  const { body, headers } = await signIn("/api/auth/register", { email, password: "Password123", name: "Test Guest", phone: "+62 812 0000 0000", ...overrides }, 201);
  return { email, user: body.user, headers };
}

export async function loginAdmin(_request: unknown) {
  return { headers: (await signIn("/api/auth/login", ADMIN, 200)).headers };
}

export function agentAuth() {
  return { headers: { "X-Agent-Key": AGENT_API_KEY } };
}

/** Restaurant-local date N days from today. Give each test its own offset so capacity checks don't collide. */
export function daysAhead(days: number): string {
  const [y, m, d] = todayLocal("+07:00").split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
