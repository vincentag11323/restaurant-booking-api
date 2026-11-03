import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import request from "supertest";
import { prisma } from "../../src/lib/db.js";
import { ADMIN, app, daysAhead, registerGuest } from "./helpers.js";

const AGENT = { email: "assistant@resortos.internal", password: "Agent12345!" };
let agent: Record<string, string>;

beforeAll(async () => {
  const res = await request(app).post("/api/auth/login").send(AGENT);
  agent = { Authorization: `Bearer ${res.body.accessToken}` };
});
afterAll(() => prisma.$disconnect());

const email = () => `jest-agent-${randomUUID()}@test.dev`;
const booking = (days: number, startTime = "11:00") => ({ branch: "BRANCH_2", sector: "VIP_WING", date: daysAhead(days), startTime, partySize: 2 });
const book = (data: Record<string, unknown>, headers: Record<string, string> = {}) =>
  request(app).post("/api/agent/reservations").set(agent).set(headers).send(data);

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
    expect((await request(app).get("/api/reservations").set(guest.auth)).body.map((r: { id: string }) => r.id)).toContain(res.body.id);
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
    for (const staffEmail of [ADMIN.email, AGENT.email]) {
      expect((await book({ email: staffEmail, ...booking(54) })).body).toEqual({ message: "This email can't be booked through the assistant" });
    }
  });

  it("caps upcoming assistant bookings per email at 2, but cancelled ones don't count", async () => {
    const guestEmail = email();
    const first = (await book({ email: guestEmail, ...booking(55, "11:00") })).body;
    await book({ email: guestEmail, ...booking(55, "13:30") });
    expect((await book({ email: guestEmail, ...booking(55, "17:00") })).status).toBe(400);
    await prisma.reservation.update({ where: { id: first.id }, data: { status: "CANCELLED" } });
    expect((await book({ email: guestEmail, ...booking(55, "17:00") })).status).toBe(201);
  });

  it("enforces the per-email cap even for simultaneous confirmations", async () => {
    const guestEmail = email();
    const attempts = await Promise.all(["11:00", "13:30", "17:00"].map((t) => book({ email: guestEmail, ...booking(59, t) })));
    expect(attempts.map((r) => r.status).sort()).toEqual([201, 201, 400]);
    const guest = await prisma.user.findUniqueOrThrow({ where: { email: guestEmail } });
    expect(await prisma.reservation.count({ where: { userId: guest.id, source: "AGENT" } })).toBe(2);
  });

  it("rejects an invalid phone or idempotency key", async () => {
    expect((await book({ email: email(), phone: "call me", ...booking(56) })).body).toEqual({ message: "phone: Invalid phone number" });
    expect((await book({ email: email(), ...booking(56) }, { "Idempotency-Key": "short" })).status).toBe(400);
  });
});

describe("agent guest lookup", () => {
  const lookup = (body: unknown) => request(app).post("/api/agent/guests/lookup").set(agent).send(body as object);

  it("answers only exists + upcoming count, and audits every lookup", async () => {
    const guestEmail = email();
    expect((await lookup({ email: guestEmail })).body).toEqual({ exists: false, upcomingAssistantBookings: 0 });
    await book({ email: guestEmail, ...booking(57) });
    expect((await lookup({ email: guestEmail })).body).toEqual({ exists: true, upcomingAssistantBookings: 1 });
    expect(await prisma.auditLog.count({ where: { action: "VIEW_GUEST", metadata: { path: ["found"], equals: true } } })).toBeGreaterThan(0);
  });

  it("treats staff accounts as not found", async () => {
    expect((await lookup({ email: ADMIN.email })).body).toEqual({ exists: false, upcomingAssistantBookings: 0 });
  });

  it("refuses anything but a single exact email", async () => {
    expect((await lookup({ email: "gmail" })).status).toBe(400);
    expect((await lookup({ emails: ["a@b.co", "c@d.co"] })).status).toBe(400);
  });
});

describe("RBAC and guest-account claim", () => {
  it("forbids a guest from assistant routes", async () => {
    const guest = await registerGuest();
    const res = await request(app).post("/api/agent/guests/lookup").set(guest.auth).send({ email: "a@b.co" });
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
