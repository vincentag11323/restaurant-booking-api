import { expect, test } from "@playwright/test";
import { loginAdmin, registerGuest } from "./helpers.js";

test("health check answers ok", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("an unknown route is 404 with a JSON message", async ({ request }) => {
  const res = await request.get("/api/nope");
  expect(res.status()).toBe(404);
  expect(await res.json()).toEqual({ message: "Route not found" });
});

test("a malformed JSON body is 400", async ({ request }) => {
  const res = await request.post("/api/auth/login", { headers: { "Content-Type": "application/json" }, data: "{not json" });
  expect(res.status()).toBe(400);
  expect(await res.json()).toEqual({ message: "Malformed JSON body" });
});

test("a forged bearer token is 401", async ({ request }) => {
  const res = await request.get("/api/me", { headers: { Authorization: "Bearer not-a-real-token" } });
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ message: "Invalid or expired token" });
});

test("security headers are set", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["x-powered-by"]).toBeUndefined();
});

test("logout clears the refresh cookie so refresh stops working", async ({ request }) => {
  await registerGuest(request);
  expect((await request.post("/api/auth/refresh")).status()).toBe(200);
  const out = await request.post("/api/auth/logout");
  expect(out.status()).toBe(200);
  expect(await out.json()).toEqual({ message: "Logged out" });
  expect((await request.post("/api/auth/refresh")).status()).toBe(401);
});

test("registration rejects an invalid phone number", async ({ request }) => {
  const res = await request.post("/api/auth/register", { data: { email: "phone@test.dev", password: "Password123", name: "P", phone: "call me" } });
  expect(res.status()).toBe(400);
  expect((await res.json()).message).toBe("phone: Invalid phone number");
});

test("login rejects a malformed email before checking credentials", async ({ request }) => {
  const res = await request.post("/api/auth/login", { data: { email: "not-an-email", password: "x" } });
  expect(res.status()).toBe(400);
});

test("a guest can clear their phone number", async ({ request }) => {
  const { headers } = await registerGuest(request);
  const res = await request.patch("/api/me", { headers, data: { phone: null, name: "  Renamed  " } });
  expect(await res.json()).toMatchObject({ phone: null, name: "Renamed" });
});

test.describe("query validation", () => {
  test("availability requires a valid branch, sector and date", async ({ request }) => {
    const res = await request.get("/api/availability?branch=BRANCH_9&sector=MAIN_HALL&date=tomorrow");
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toContain("date: Expected date as YYYY-MM-DD");
  });

  test("menu rejects an unknown type", async ({ request }) => {
    expect((await request.get("/api/menu?type=BRUNCH")).status()).toBe(400);
  });

  test("admin page size is capped at 100", async ({ request }) => {
    const { headers } = await loginAdmin(request);
    expect((await request.get("/api/admin/reservations?pageSize=101", { headers })).status()).toBe(400);
  });

  test("admin stats default to today in restaurant time", async ({ request }) => {
    const { headers } = await loginAdmin(request);
    const stats = await (await request.get("/api/admin/stats", { headers })).json();
    const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
    expect(stats.date).toBe(today);
    expect(stats.utilization.map((u: { capacityUnits: number }) => u.capacityUnits)).toEqual([400, 32]);
  });
});
