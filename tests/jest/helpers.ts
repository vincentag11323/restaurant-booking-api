import { randomUUID } from "node:crypto";
import { expect } from "@jest/globals";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { todayLocal } from "../../src/domain/slots.js";

export const app = createApp();
export const ADMIN = { email: "admin@resortos.test", password: "Admin12345!" };

/** The `session=...` pair from a sign-in response, ready to send as a Cookie header. */
export function sessionCookie(res: { headers: Record<string, unknown> }): string {
  const cookies = (res.headers["set-cookie"] ?? []) as string[];
  const session = cookies.find((c) => c.startsWith("session="));
  expect(session).toBeDefined();
  return session!.split(";")[0];
}

/** Registers a fresh guest. The returned agent keeps the session cookie; `auth` sends it explicitly. */
export async function registerGuest(overrides: Record<string, unknown> = {}) {
  const agent = request.agent(app);
  const email = `jest-${randomUUID()}@test.dev`;
  const res = await agent.post("/api/auth/register").send({ email, password: "Password123", name: "Jest Guest", ...overrides });
  expect(res.status).toBe(201);
  return { agent, email, user: res.body.user as { id: string }, auth: { Cookie: sessionCookie(res) } };
}

export async function loginAdmin() {
  const res = await request(app).post("/api/auth/login").send(ADMIN);
  expect(res.status).toBe(200);
  return { Cookie: sessionCookie(res) };
}

/** Restaurant-local date N days from today. Jest files use offsets 30+ so they never collide with each other. */
export function daysAhead(days: number): string {
  const [y, m, d] = todayLocal("+07:00").split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
