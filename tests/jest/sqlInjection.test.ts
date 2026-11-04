// S18 (TEST_SCENARIOS_APP.md): SQL injection payloads in every input. Each request must get only its normal answer:
// never a 500, never SQL error text (in the body or errors.log), never another guest's data, no pg_sleep delay, and
// every table is still there afterwards. Runs on PGlite by default and on real PostgreSQL with TEST_DATABASE_URL.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import request from "supertest";
import { prisma } from "../../src/lib/db.js";
import { TEST_ENV } from "./globalSetup.js";
import { app, daysAhead, loginAdmin, registerGuest } from "./helpers.js";

const PAYLOADS = [
  "' OR '1'='1",
  "' OR 1=1--",
  "'; DROP TABLE \"User\";--",
  "'; DELETE FROM \"Reservation\";--",
  "1 UNION SELECT id, email, \"passwordHash\" FROM \"User\"--",
  "' UNION SELECT NULL,NULL,NULL--",
  "' AND pg_sleep(5)--",
  "'; SELECT pg_sleep(5);--",
  "1) OR pg_sleep(5)--",
  "admin'--",
  "' /* comment */ OR '1'='1",
  "\" OR \"\"=\"",
  "\\' OR 1=1 --",
  "%' OR '%'='",
  "%27%20OR%20%271%27%3D%271",
  "' OR 1=1; -- ʼ‘’",
];
/** Headers can only carry printable ASCII. */
const HEADER_PAYLOADS = PAYLOADS.filter((p) => /^[\x20-\x7e]+$/.test(p));

// Database error text. Not "pg_sleep": free-text fields and logged paths legitimately carry the payload itself.
const SQL_ERROR = /syntax error|SQLSTATE|unterminated|PrismaClient|Invalid `prisma|relation "|column "|42601|42P01|P20\d\d|postgres/i;
const MAX_MS = 2000;
const agentKey = { "X-Agent-Key": TEST_ENV.AGENT_API_KEY };

type Res = { status: number; text: string; body: unknown };
let requests = 0;
let slowestMs = 0;

/** Times one request and checks the parts every S18 answer shares. */
async function send(allowed: number[], make: () => request.Test): Promise<Res> {
  const start = Date.now();
  const res = await make();
  const ms = Date.now() - start;
  requests += 1;
  slowestMs = Math.max(slowestMs, ms);
  expect(allowed).toContain(res.status);
  expect(res.text).not.toMatch(SQL_ERROR);
  expect(ms).toBeLessThan(MAX_MS);
  return { status: res.status, text: res.text, body: res.body };
}

const errorLines = () => (existsSync(process.env.ERROR_LOG_PATH!) ? readFileSync(process.env.ERROR_LOG_PATH!, "utf8").trim().split("\n").filter(Boolean) : []);
let errorLogStart = 0;
let counts: Record<string, number>;
const tableCounts = async () => ({
  diningTables: await prisma.diningTable.count(),
  menuItems: await prisma.menuItem.count(),
  apiKeys: await prisma.apiKey.count(),
  admins: await prisma.user.count({ where: { role: "ADMIN" } }),
  agents: await prisma.user.count({ where: { role: "AGENT" } }),
});

let guest: Awaited<ReturnType<typeof registerGuest>>;
let other: Awaited<ReturnType<typeof registerGuest>>;
let admin: { Cookie: string };
let ownId: string;
let otherId: string;

beforeAll(async () => {
  errorLogStart = errorLines().length;
  counts = await tableCounts();
  guest = await registerGuest();
  other = await registerGuest();
  admin = await loginAdmin();
  const mine = await request(app).post("/api/users/reservations").set(guest.auth).send({ branch: "BRANCH_2", sector: "MAIN_HALL", date: daysAhead(50), startTime: "11:00", partySize: 2 });
  const theirs = await request(app).post("/api/users/reservations").set(other.auth).send({ branch: "BRANCH_2", sector: "MAIN_HALL", date: daysAhead(50), startTime: "13:30", partySize: 2 });
  expect([mine.status, theirs.status]).toEqual([201, 201]);
  ownId = mine.body.id;
  otherId = theirs.body.id;
});

afterAll(() => prisma.$disconnect());

describe("S18 SQL injection", () => {
  it("sign-in email and password", async () => {
    for (const p of PAYLOADS) {
      await send([400], () => request(app).post("/api/auth/login").send({ email: p, password: "Password123" }));
      // Some payloads (e.g. admin'--@test.dev) are valid email syntax: then it's the normal 401.
      await send([400, 401], () => request(app).post("/api/auth/login").send({ email: `${p}@test.dev`, password: "x" }));
      // A payload password for a real account must never sign in.
      await send([401], () => request(app).post("/api/auth/login").send({ email: guest.email, password: p }));
      await send([401], () => request(app).post("/api/auth/login").send({ email: "admin@resortos.test", password: p }));
    }
  });

  it("sign-up fields: invalid ones are refused, free text is stored as typed", async () => {
    for (const p of PAYLOADS) {
      await send([400], () => request(app).post("/api/auth/register").send({ email: p, password: "Password123", name: "S18" }));
      await send([400], () => request(app).post("/api/auth/register").send({ email: `s18-${randomUUID()}@test.dev`, password: "Password123", name: "S18", phone: p }));
    }
    const email = `s18-${randomUUID()}@test.dev`;
    const res = await send([201], () => request(app).post("/api/auth/register").send({ email, password: PAYLOADS[2], name: PAYLOADS[0] }));
    expect(res.body).toMatchObject({ user: { email, name: PAYLOADS[0], role: "USER" } });
    await send([200], () => request(app).post("/api/auth/login").send({ email, password: PAYLOADS[2] }));
  });

  it("the session cookie", async () => {
    for (const p of HEADER_PAYLOADS) {
      for (const value of [p, encodeURIComponent(p)]) {
        await send([401], () => request(app).get("/api/users/me").set("Cookie", `session=${value}`));
        await send([401], () => request(app).get("/api/admins/reservations").set("Cookie", `session=${value}`));
        await send([200], () => request(app).post("/api/auth/logout").set("Cookie", `session=${value}`));
      }
    }
    // A logout with a payload cookie deleted no real session.
    await send([200], () => request(app).get("/api/users/me").set(guest.auth));
  });

  it("X-Agent-Key and Idempotency-Key", async () => {
    for (const p of HEADER_PAYLOADS) {
      await send([401], () => request(app).post("/api/agents/guests/lookup").set("X-Agent-Key", p).send({ email: guest.email }));
      await send([401], () => request(app).post("/api/agents/reservations").set("X-Agent-Key", `${TEST_ENV.AGENT_API_KEY}${p}`).send({}));
    }
    // A run id after the payload keeps keys unique on a reused database; after "--" it is still inside the comment.
    const run = randomUUID().slice(0, 8);
    for (const payload of HEADER_PAYLOADS) {
      const p = payload.length < 8 ? payload : `${payload} ${run}`;
      const body = { email: `s18-idem-${randomUUID()}@test.dev`, branch: "BRANCH_2", sector: "MAIN_HALL", date: daysAhead(50), startTime: "17:00", partySize: 1 };
      const first = await send([201, 400], () => request(app).post("/api/agents/reservations").set(agentKey).set("Idempotency-Key", p).send(body));
      if (p.length < 8) {
        expect(first.status).toBe(400);
        continue;
      }
      expect(first.status).toBe(201);
      // The key is stored as typed and finds exactly that booking again.
      const again = await send([200], () => request(app).post("/api/agents/reservations").set(agentKey).set("Idempotency-Key", p).send(body));
      expect((again.body as { id: string }).id).toBe((first.body as { id: string }).id);
      expect((await prisma.reservation.findUniqueOrThrow({ where: { idempotencyKey: p } })).id).toBe((first.body as { id: string }).id);
    }
  });

  it("assistant booking and lookup bodies", async () => {
    for (const p of PAYLOADS) {
      const base = { email: `s18-agent-${randomUUID()}@test.dev`, branch: "BRANCH_2", sector: "MAIN_HALL", date: daysAhead(50), startTime: "19:30", partySize: 1 };
      for (const field of ["email", "phone", "branch", "sector", "date", "startTime", "partySize"]) {
        await send([400], () => request(app).post("/api/agents/reservations").set(agentKey).send({ ...base, [field]: p }));
      }
      await send([400], () => request(app).post("/api/agents/guests/lookup").set(agentKey).send({ email: p }));
      const lookup = await send([200, 400], () => request(app).post("/api/agents/guests/lookup").set(agentKey).send({ email: `${p}@test.dev` }));
      if (lookup.status === 200) expect(lookup.body).toEqual({ exists: false, upcomingAssistantBookings: 0, assistantBookingLimit: 1 });
    }
    // Free text (specialRequests, clientIp) is stored exactly as sent.
    const res = await send([201], () =>
      request(app).post("/api/agents/reservations").set(agentKey).send({ email: `s18-free-${randomUUID()}@test.dev`, branch: "BRANCH_2", sector: "MAIN_HALL", date: daysAhead(50), startTime: "19:30", partySize: 1, specialRequests: PAYLOADS[2], clientIp: PAYLOADS[6] }),
    );
    expect((res.body as { specialRequests: string }).specialRequests).toBe(PAYLOADS[2]);
  });

  it("guest booking bodies and :id", async () => {
    const base = { branch: "BRANCH_2", sector: "MAIN_HALL", date: daysAhead(50), startTime: "17:00", partySize: 1 };
    for (const p of PAYLOADS) {
      for (const field of ["branch", "sector", "date", "startTime", "partySize"]) {
        await send([400], () => request(app).post("/api/users/reservations").set(guest.auth).send({ ...base, [field]: p }));
      }
      for (const field of ["date", "startTime", "partySize"]) {
        await send([400], () => request(app).patch(`/api/users/reservations/${ownId}`).set(guest.auth).send({ date: daysAhead(50), startTime: "19:30", [field]: p }));
      }
      const id = encodeURIComponent(p);
      await send([404], () => request(app).get(`/api/users/reservations/${id}`).set(guest.auth));
      await send([404], () => request(app).patch(`/api/users/reservations/${id}`).set(guest.auth).send({ date: daysAhead(50), startTime: "19:30" }));
      await send([404], () => request(app).delete(`/api/users/reservations/${id}`).set(guest.auth));
      await send([404], () => request(app).get(`/api/users/reservations/${otherId}${id}`).set(guest.auth));
    }
    const res = await send([201], () => request(app).post("/api/users/reservations").set(guest.auth).send({ ...base, specialRequests: PAYLOADS[0] }));
    expect((res.body as { specialRequests: string }).specialRequests).toBe(PAYLOADS[0]);
    // Still only the caller's own bookings, and the other guest's booking is untouched.
    const list = await send([200], () => request(app).get("/api/users/reservations").set(guest.auth));
    expect((list.body as { id: string }[]).map((r) => r.id)).not.toContain(otherId);
    expect(await prisma.reservation.count({ where: { userId: guest.user.id } })).toBe((list.body as unknown[]).length);
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: otherId } })).status).toBe("CONFIRMED");
  });

  it("profile fields, then recommendations built from the stored allergies", async () => {
    for (const p of PAYLOADS) {
      await send([400], () => request(app).patch("/api/users/me").set(guest.auth).send({ phone: p }));
      const res = await send([200], () => request(app).patch("/api/users/me").set(guest.auth).send({ name: p, allergies: [p.slice(0, 40)] }));
      expect(res.body).toMatchObject({ email: guest.email, name: p.trim(), role: "USER" });
      await send([200], () => request(app).get("/api/users/menus/recommendations").set(guest.auth));
    }
  });

  it("public query parameters", async () => {
    for (const p of PAYLOADS) {
      const ok = { branch: "BRANCH_1", sector: "MAIN_HALL", date: daysAhead(50) };
      for (const field of ["branch", "sector", "date"]) {
        await send([400], () => request(app).get("/api/public/availabilities").query({ ...ok, [field]: p }));
      }
      await send([400], () => request(app).get("/api/public/menus").query({ type: p }));
    }
  });

  it("admin search, filters and :id", async () => {
    for (const p of PAYLOADS) {
      for (const field of ["branch", "sector", "status", "source", "from", "to", "page", "pageSize"]) {
        await send([400], () => request(app).get("/api/admins/reservations").set(admin).query({ [field]: p }));
      }
      for (const field of ["branch", "sector", "status", "source", "from", "to", "format"]) {
        await send([400], () => request(app).get("/api/admins/reservations/export").set(admin).query({ [field]: p }));
      }
      for (const field of ["date", "branch"]) {
        await send([400], () => request(app).get("/api/admins/stats").set(admin).query({ [field]: p }));
      }
      await send([404], () => request(app).get(`/api/admins/reservations/${encodeURIComponent(p)}`).set(admin));

      // q is a value, never SQL: every hit really contains the text (here: only the guest who saved it as a name).
      const res = await send([200], () => request(app).get("/api/admins/reservations").set(admin).query({ q: p, pageSize: 100 }));
      const { items, total } = res.body as { items: { code: string; customer: { name: string; email: string; phone: string | null } }[]; total: number };
      const needle = p.trim().toLowerCase();
      for (const item of items) {
        const { name, email, phone } = item.customer;
        expect([item.code.toLowerCase(), name.toLowerCase(), email.toLowerCase(), (phone ?? "").toLowerCase()].some((v) => v.includes(needle))).toBe(true);
      }
      expect(total).toBeLessThan(await prisma.reservation.count());
      await send([200], () => request(app).get("/api/admins/reservations/export").set(admin).query({ q: p, format: "json" }));
    }
  });

  it("left every table in place, wrote no 500 or SQL error to errors.log, and nothing was slow", async () => {
    expect(await tableCounts()).toEqual(counts);
    expect(await prisma.user.count({ where: { id: { in: [guest.user.id, other.user.id] } } })).toBe(2);
    const added = errorLines().slice(errorLogStart);
    expect(added.length).toBeGreaterThan(0);
    expect(added.filter((line) => line.includes('"status":500'))).toEqual([]);
    expect(added.filter((line) => SQL_ERROR.test(line))).toEqual([]);
    // Printed so a run's size is visible in the output.
    console.info(`S18: ${requests} requests, slowest ${slowestMs} ms (limit ${MAX_MS} ms)`);
    expect(requests).toBeGreaterThan(500);
  });
});
