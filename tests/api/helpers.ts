import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect } from "@playwright/test";
import { todayLocal } from "../../src/domain/slots.js";

export const ADMIN = { email: "admin@resortos.test", password: "Admin12345!" };

export async function registerGuest(request: APIRequestContext, overrides: Record<string, unknown> = {}) {
  const email = `guest-${randomUUID()}@test.dev`;
  const res = await request.post("/api/auth/register", {
    data: { email, password: "Password123", name: "Test Guest", phone: "+62 812 0000 0000", ...overrides },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return { email, user: body.user, headers: { Authorization: `Bearer ${body.accessToken}` } };
}

export async function loginAdmin(request: APIRequestContext) {
  const res = await request.post("/api/auth/login", { data: ADMIN });
  expect(res.status()).toBe(200);
  const body = await res.json();
  return { headers: { Authorization: `Bearer ${body.accessToken}` } };
}

/** Restaurant-local date N days from today. Give each test its own offset so capacity checks don't collide. */
export function daysAhead(days: number): string {
  const [y, m, d] = todayLocal("+07:00").split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
