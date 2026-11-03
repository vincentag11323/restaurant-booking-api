import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { ADMIN, AGENT_EMAIL, agentAuth, daysAhead, loginAdmin, registerGuest } from "./helpers.js";

const guestEmail = () => `chat-${randomUUID()}@test.dev`;
const slot = (days: number, startTime = "19:30") => ({ branch: "BRANCH_1", sector: "MAIN_HALL", date: daysAhead(days), startTime, partySize: 4 });

test.describe("assistant books on a guest's behalf", () => {
  test("creates a guest account, books it, and admins see it as booked by the AI assistant", async ({ request }) => {
    const agent = agentAuth();
    const email = guestEmail();
    const res = await request.post("/api/agent/reservations", {
      headers: agent.headers,
      data: { email, phone: "+62 811 555 0101", ...slot(22), specialRequests: "Window please", clientIp: "203.0.113.7" },
    });
    expect(res.status()).toBe(201);
    const booking = await res.json();
    expect(booking).toMatchObject({ source: "AGENT", partySize: 4, status: "CONFIRMED", specialRequests: "Window please" });
    expect(booking.code).toMatch(/^RSV-/);

    const admin = await loginAdmin(request);
    const log = await (await request.get(`/api/admin/reservations?q=${email}`, { headers: admin.headers })).json();
    expect(log.items[0]).toMatchObject({ id: booking.id, source: "AGENT", customer: { email, phone: "+62 811 555 0101" } });
  });

  test("retrying with the same Idempotency-Key returns the same booking", async ({ request }) => {
    const agent = agentAuth();
    const data = { email: guestEmail(), ...slot(23) };
    const headers = { ...agent.headers, "Idempotency-Key": `draft-${randomUUID()}` };
    const first = await request.post("/api/agent/reservations", { headers, data });
    const second = await request.post("/api/agent/reservations", { headers, data });
    expect([first.status(), second.status()]).toEqual([201, 200]);
    expect((await second.json()).id).toBe((await first.json()).id);
  });

  test("an email that hasn't signed up can hold only 1 upcoming assistant booking", async ({ request }) => {
    const agent = agentAuth();
    const email = guestEmail();
    expect((await request.post("/api/agent/reservations", { headers: agent.headers, data: { email, ...slot(24, "11:00") } })).status()).toBe(201);
    const second = await request.post("/api/agent/reservations", { headers: agent.headers, data: { email, ...slot(24, "13:30") } });
    expect(second.status()).toBe(400);
    expect(await second.json()).toEqual({ message: "This email already has a booking made with the assistant. To book a different time, sign up with this email in the app, cancel that booking there, then ask me again." });
  });

  test("a signed-up guest can hold 3 upcoming assistant bookings", async ({ request }) => {
    const agent = agentAuth();
    const { email } = await registerGuest(request);
    for (const startTime of ["11:00", "13:30", "17:00"]) {
      expect((await request.post("/api/agent/reservations", { headers: agent.headers, data: { email, ...slot(32, startTime) } })).status()).toBe(201);
    }
    const fourth = await request.post("/api/agent/reservations", { headers: agent.headers, data: { email, ...slot(32, "19:30") } });
    expect(await fourth.json()).toEqual({ message: "This email already has 3 upcoming assistant bookings. Sign in to manage them." });
  });

  test("the same booking rules and messages apply", async ({ request }) => {
    const agent = agentAuth();
    const res = await request.post("/api/agent/reservations", { headers: agent.headers, data: { email: guestEmail(), ...slot(25), partySize: 51 } });
    expect(await res.json()).toEqual({ message: "partySize: Party size must be between 1 and 50" });
  });
});

test.describe("assistant looks up one guest at a time", () => {
  test("returns only whether the email exists and its upcoming assistant bookings", async ({ request }) => {
    const agent = agentAuth();
    const email = guestEmail();
    const before = await request.post("/api/agent/guests/lookup", { headers: agent.headers, data: { email } });
    expect(await before.json()).toEqual({ exists: false, upcomingAssistantBookings: 0, assistantBookingLimit: 1 });

    await request.post("/api/agent/reservations", { headers: agent.headers, data: { email, ...slot(26) } });
    const after = await request.post("/api/agent/guests/lookup", { headers: agent.headers, data: { email: email.toUpperCase() } });
    expect(await after.json()).toEqual({ exists: true, upcomingAssistantBookings: 1, assistantBookingLimit: 1 });
  });

  test("refuses partial or non-email input", async ({ request }) => {
    const agent = agentAuth();
    for (const email of ["gmail", "%@test.dev", "*"]) {
      expect((await request.post("/api/agent/guests/lookup", { headers: agent.headers, data: { email } })).status()).toBe(400);
    }
  });
});

test.describe("RBAC", () => {
  test("the assistant gets 403 on every route that isn't its own", async ({ request }) => {
    const agent = agentAuth();
    const forbidden = [
      request.get("/api/reservations", { headers: agent.headers }),
      request.post("/api/reservations", { headers: agent.headers, data: slot(27) }),
      request.get("/api/me", { headers: agent.headers }),
      request.patch("/api/me", { headers: agent.headers, data: { name: "x" } }),
      request.get("/api/menu/recommendations", { headers: agent.headers }),
      request.get("/api/admin/stats", { headers: agent.headers }),
      request.get("/api/admin/reservations?q=gmail", { headers: agent.headers }),
      request.get("/api/admin/reservations/export", { headers: agent.headers }),
    ];
    for (const res of await Promise.all(forbidden)) {
      expect(res.status()).toBe(403);
      expect(await res.json()).toEqual({ message: "Forbidden" });
    }
  });

  test("guests and admins get 403 on assistant routes; no credentials get 401", async ({ request }) => {
    const guest = await registerGuest(request);
    const admin = await loginAdmin(request);
    for (const headers of [guest.headers, admin.headers]) {
      expect((await request.post("/api/agent/reservations", { headers, data: { email: guestEmail(), ...slot(28) } })).status()).toBe(403);
      expect((await request.post("/api/agent/guests/lookup", { headers, data: { email: "a@b.co" } })).status()).toBe(403);
    }
    expect((await request.post("/api/agent/guests/lookup", { data: { email: "a@b.co" } })).status()).toBe(401);
  });

  test("a wrong X-Agent-Key gets 401", async ({ request }) => {
    const res = await request.post("/api/agent/guests/lookup", { headers: { "X-Agent-Key": "wrong-key-wrong-key-wrong-key-wrong-key" }, data: { email: "a@b.co" } });
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ message: "Invalid API key" });
  });

  test("the assistant's account can't sign in with a password", async ({ request }) => {
    const res = await request.post("/api/auth/login", { data: { email: AGENT_EMAIL, password: "Agent12345!" } });
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ message: "Invalid email or password" });
  });

  test("admins stay read-only: they cannot create bookings", async ({ request }) => {
    const admin = await loginAdmin(request);
    expect((await request.post("/api/reservations", { headers: admin.headers, data: slot(29) })).status()).toBe(403);
  });

  test("the assistant's service account can't be claimed through sign-up", async ({ request }) => {
    const res = await request.post("/api/auth/register", { data: { email: AGENT_EMAIL, password: "Password123", name: "Imposter" } });
    expect(await res.json()).toEqual({ message: "Email is already registered" });
    expect((await request.post("/api/auth/register", { data: { email: ADMIN.email, password: "Password123", name: "x" } })).status()).toBe(400);
  });
});

test.describe("guest accounts created by the assistant", () => {
  test("can't sign in until claimed, then sign-up claims them with their bookings", async ({ request, playwright, baseURL }) => {
    const agent = agentAuth();
    const email = guestEmail();
    const booking = await (await request.post("/api/agent/reservations", { headers: agent.headers, data: { email, ...slot(30) } })).json();

    const login = await request.post("/api/auth/login", { data: { email, password: "anything" } });
    expect(login.status()).toBe(401);
    expect(await login.json()).toEqual({ message: "Invalid email or password" });

    const guest = await playwright.request.newContext({ baseURL });
    const claim = await guest.post("/api/auth/register", { data: { email, password: "Password123", name: "Dewi", phone: "+62 812 000 999" } });
    expect(claim.status()).toBe(201);
    const { user } = await claim.json();
    expect(user).toMatchObject({ email, name: "Dewi", phone: "+62 812 000 999", role: "USER" });
    const mine = await (await guest.get("/api/reservations")).json();
    expect(mine.map((r: { id: string }) => r.id)).toEqual([booking.id]);

    expect((await guest.post("/api/auth/register", { data: { email, password: "Password456", name: "Again" } })).status()).toBe(400);
    await guest.dispose();
  });
});

test.describe("admin sees who booked", () => {
  test("filters by source, counts assistant bookings, and exports the source", async ({ request }) => {
    const agent = agentAuth();
    const admin = await loginAdmin(request);
    const date = daysAhead(31);
    const viaAgent = await (await request.post("/api/agent/reservations", { headers: agent.headers, data: { email: guestEmail(), ...slot(31, "11:00") } })).json();
    const guest = await registerGuest(request);
    const viaApp = await (await request.post("/api/reservations", { headers: guest.headers, data: slot(31, "13:30") })).json();
    expect(viaApp.source).toBe("APP");

    const agentOnly = await (await request.get(`/api/admin/reservations?source=AGENT&from=${date}&to=${date}`, { headers: admin.headers })).json();
    expect(agentOnly.items.map((r: { id: string }) => r.id)).toEqual([viaAgent.id]);

    const stats = await (await request.get(`/api/admin/stats?date=${date}&branch=BRANCH_1`, { headers: admin.headers })).json();
    expect(stats).toMatchObject({ totalBookings: 2, agentBookings: 1 });

    const csv = await (await request.get(`/api/admin/reservations/export?from=${date}&to=${date}`, { headers: admin.headers })).text();
    expect(csv.split("\n")[0]).toContain(",source");
    expect(csv).toContain(",AGENT");
  });
});
