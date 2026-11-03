import { createHash, randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, jest } from "@jest/globals";
import request from "supertest";
import { prisma } from "../../src/lib/db.js";
import { TEST_ENV } from "./global-setup.js";
import { ADMIN, app, daysAhead, registerGuest } from "./helpers.js";

const AGENT_EMAIL = "assistant@resortos.internal";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const agent = { "X-Agent-Key": TEST_ENV.AGENT_API_KEY };

afterAll(() => prisma.$disconnect());

const email = () => `jest-agent-${randomUUID()}@test.dev`;
const booking = (days: number, startTime = "11:00") => ({ branch: "BRANCH_2", sector: "VIP_WING", date: daysAhead(days), startTime, partySize: 2 });
const book = (data: Record<string, unknown>, headers: Record<string, string> = {}) =>
  request(app).post("/api/agents/reservations").set(agent).set(headers).send(data);

describe("agent booking", () => {
  it("books for a new guest, records who booked, audits it and notifies the guest", async () => {
    const info = jest.spyOn(console, "info").mockImplementation(() => {});
    const guestEmail = email();
    const res = await book({ email: guestEmail, ...booking(51), clientIp: "198.51.100.4" });
    expect(res.status).toBe(201);

    const stored = await prisma.reservation.findUniqueOrThrow({ where: { id: res.body.id }, include: { user: true, createdBy: true } });
    expect(stored).toMatchObject({ source: "AGENT", user: { email: guestEmail, passwordHash: null, name: guestEmail.split("@")[0] }, createdBy: { role: "AGENT" } });
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "CREATE_RESERVATION", resourceId: res.body.id } });
    expect(entry.metadata).toEqual({ source: "AGENT", onBehalfOf: stored.userId, clientIp: "198.51.100.4" });
    expect(info).toHaveBeenCalledWith(expect.stringContaining(`to=${guestEmail}`));
    info.mockRestore();
  });

  it("reuses an existing guest account without changing it", async () => {
    const guest = await registerGuest({ phone: "+62 811 1" + "23 456" });
    const res = await book({ email: guest.email.toUpperCase(), phone: "+62 899 999 999", ...booking(52) });
    expect(res.status).toBe(201);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: guest.email } })).phone).toBe("+62 811 123 456");
    expect((await request(app).get("/api/users/reservations").set(guest.auth)).body.map((r: { id: string }) => r.id)).toContain(res.body.id);
  });

  it("returns the earlier booking for a repeated Idempotency-Key, and refuses the key for another email", async () => {
    const key = { "Idempotency-Key": `jest-${randomUUID()}` };
    const guestEmail = email();
    const first = await book({ email: guestEmail, ...booking(53) }, key);
    const again = await book({ email: guestEmail, ...booking(53) }, key);
    expect([first.status, again.status, again.body.id]).toEqual([201, 200, first.body.id]);
    expect(again.body).not.toHaveProperty("user");

    const other = await book({ email: email(), ...booking(53) }, key);
    expect(other.body).toEqual({ message: "Idempotency-Key was already used for another booking" });
  });

  it("won't book under an admin or assistant account's email", async () => {
    for (const staffEmail of [ADMIN.email, AGENT_EMAIL]) {
      expect((await book({ email: staffEmail, ...booking(54) })).body).toEqual({ message: "This email can't be booked through the assistant" });
    }
  });

  it("allows 1 upcoming assistant booking before sign-up, 2 after, and cancelled ones don't count", async () => {
    const guestEmail = email();
    const first = (await book({ email: guestEmail, ...booking(55, "11:00") })).body;
    expect((await book({ email: guestEmail, ...booking(55, "13:30") })).body).toEqual({ message: "This email already has a booking made with the assistant. To book a different time, sign up with this email in the app, cancel that booking there, then ask me again." });
    await prisma.reservation.update({ where: { id: first.id }, data: { status: "CANCELLED" } });
    expect((await book({ email: guestEmail, ...booking(55, "13:30") })).status).toBe(201);

    await request(app).post("/api/auth/register").send({ email: guestEmail, password: "Password123", name: "Claimed" });
    expect((await book({ email: guestEmail, ...booking(55, "17:00") })).status).toBe(201);
    expect((await book({ email: guestEmail, ...booking(55, "19:30") })).status).toBe(201);
    expect((await book({ email: guestEmail, ...booking(56, "11:00") })).body).toEqual({ message: "This email already has 3 upcoming assistant bookings. Sign in to manage them." });
  });

  // PGlite runs every connection in one session, so simultaneous transactions interleave in ways real
  // PostgreSQL never allows. This race is only meaningful on real PostgreSQL: npm run test:pg.
  const onRealPostgres = process.env.TEST_DATABASE_URL ? it : it.skip;
  onRealPostgres("enforces the per-email cap even for simultaneous confirmations (real PostgreSQL)", async () => {
    const guestEmail = email();
    const attempts = await Promise.all(["11:00", "13:30", "17:00"].map((t) => book({ email: guestEmail, ...booking(59, t) })));
    expect(attempts.map((r) => r.status).sort()).toEqual([201, 400, 400]);
    const guest = await prisma.user.findUniqueOrThrow({ where: { email: guestEmail } });
    expect(await prisma.reservation.count({ where: { userId: guest.id, source: "AGENT" } })).toBe(1);
  });

  it("rejects an invalid phone or idempotency key", async () => {
    expect((await book({ email: email(), phone: "call me", ...booking(56) })).body).toEqual({ message: "phone: Invalid phone number" });
    expect((await book({ email: email(), ...booking(56) }, { "Idempotency-Key": "short" })).status).toBe(400);
  });
});

describe("agent guest lookup", () => {
  const lookup = (body: unknown) => request(app).post("/api/agents/guests/lookup").set(agent).send(body as object);

  it("answers only exists + upcoming count, and audits every lookup", async () => {
    const guestEmail = email();
    expect((await lookup({ email: guestEmail })).body).toEqual({ exists: false, upcomingAssistantBookings: 0, assistantBookingLimit: 1 });
    await book({ email: guestEmail, ...booking(57) });
    expect((await lookup({ email: guestEmail })).body).toEqual({ exists: true, upcomingAssistantBookings: 1, assistantBookingLimit: 1 });
    const signedUp = await registerGuest();
    expect((await lookup({ email: signedUp.email })).body).toEqual({ exists: true, upcomingAssistantBookings: 0, assistantBookingLimit: 3 });
    expect(await prisma.auditLog.count({ where: { action: "VIEW_GUEST", metadata: { path: ["found"], equals: true } } })).toBeGreaterThan(0);
  });

  it("treats staff accounts as not found", async () => {
    expect((await lookup({ email: ADMIN.email })).body).toEqual({ exists: false, upcomingAssistantBookings: 0, assistantBookingLimit: 1 });
  });

  it("refuses anything but a single exact email", async () => {
    expect((await lookup({ email: "gmail" })).status).toBe(400);
    expect((await lookup({ emails: ["a@b.co", "c@d.co"] })).status).toBe(400);
  });
});

describe("agent API key", () => {
  it("rejects a wrong X-Agent-Key", async () => {
    const res = await request(app).post("/api/agents/guests/lookup").set("X-Agent-Key", "wrong-key-wrong-key-wrong-key-wrong-key").send({ email: "a@b.co" });
    expect([res.status, res.body]).toEqual([401, { message: "Invalid API key" }]);
  });

  it("does not accept a guest session sent as a Bearer token", async () => {
    const guest = await registerGuest();
    const res = await request(app).post("/api/agents/guests/lookup").set("Authorization", `Bearer ${guest.auth.Cookie.slice("session=".length)}`).send({ email: "a@b.co" });
    expect([res.status, res.body]).toEqual([401, { message: "Authentication required" }]);
  });

  it("the assistant's account can't sign in with a password", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: AGENT_EMAIL, password: "Agent12345!" });
    expect([res.status, res.body]).toEqual([401, { message: "Invalid email or password" }]);
  });

  it("the seed stores only the SHA-256 of the key, in the assistant's one ApiKey row, and no password", async () => {
    const account = await prisma.user.findUniqueOrThrow({ where: { email: AGENT_EMAIL }, include: { apiKey: true } });
    expect(account).toMatchObject({ role: "AGENT", passwordHash: null });
    expect(account.apiKey).toMatchObject({ name: "AI booking assistant", keyHash: sha256(TEST_ENV.AGENT_API_KEY) });
  });

  it("re-seeding with a new key replaces the hash in the same row, and the old key stops working", async () => {
    const run = promisify(exec);
    const newKey = `rotated-key-${randomUUID()}`;
    try {
      await run("npx tsx prisma/seed.ts", { env: { ...process.env, AGENT_API_KEY: newKey } });
      const account = await prisma.user.findUniqueOrThrow({ where: { email: AGENT_EMAIL }, include: { apiKey: true } });
      expect(account.apiKey?.keyHash).toBe(sha256(newKey));
      expect(await prisma.apiKey.count({ where: { userId: account.id } })).toBe(1);
      const old = await request(app).post("/api/agents/guests/lookup").set(agent).send({ email: "a@b.co" });
      expect([old.status, old.body]).toEqual([401, { message: "Invalid API key" }]);
    } finally {
      await run("npx tsx prisma/seed.ts", { env: process.env });
    }
    expect((await request(app).post("/api/agents/guests/lookup").set(agent).send({ email: "a@b.co" })).status).toBe(200);
  });

  it("the seed refuses a key shorter than 32 characters", async () => {
    const run = promisify(exec);
    await expect(run("npx tsx prisma/seed.ts", { env: { ...process.env, AGENT_API_KEY: "too-short" } })).rejects.toThrow("AGENT_API_KEY must be at least 32 characters");
  });

  it("the seed warns instead of silently skipping when AGENT_API_KEY is not set", async () => {
    const run = promisify(exec);
    const { stderr } = await run("npx tsx prisma/seed.ts", { env: { ...process.env, AGENT_API_KEY: "" } });
    expect(stderr).toContain("AGENT_API_KEY is not set: the AI assistant's account was not created/updated");
  });

  it("the seed refuses to overwrite an assistant row that is not role AGENT", async () => {
    await prisma.user.update({ where: { email: AGENT_EMAIL }, data: { role: "USER" } });
    try {
      const run = promisify(exec);
      await expect(run("npx tsx prisma/seed.ts", { env: process.env })).rejects.toThrow(
        "assistant@resortos.internal belongs to a non-AGENT account; refusing to put the API key on it",
      );
    } finally {
      await prisma.user.update({ where: { email: AGENT_EMAIL }, data: { role: "AGENT" } });
    }
  });
});

describe("RBAC and guest-account claim", () => {
  it("forbids a guest from assistant routes", async () => {
    const guest = await registerGuest();
    const res = await request(app).post("/api/agents/guests/lookup").set(guest.auth).send({ email: "a@b.co" });
    expect([res.status, res.body]).toEqual([403, { message: "Forbidden" }]);
  });

  it("an assistant-created guest account can't log in until sign-up claims it", async () => {
    const guestEmail = email();
    await book({ email: guestEmail, ...booking(58) });
    expect((await request(app).post("/api/auth/login").send({ email: guestEmail, password: "Password123" })).status).toBe(401);

    const claim = await request(app).post("/api/auth/register").send({ email: guestEmail, password: "Password123", name: "Rina" });
    expect(claim.status).toBe(201);
    expect(claim.body.user).toMatchObject({ email: guestEmail, name: "Rina", role: "USER" });
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "REGISTER", actorId: claim.body.user.id } });
    expect(entry.metadata).toEqual({ claimedGuestAccount: true });
    expect((await request(app).post("/api/auth/login").send({ email: guestEmail, password: "Password123" })).status).toBe(200);
  });
});
