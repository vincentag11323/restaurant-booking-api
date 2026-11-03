// Route groups and their middleware (API_SPEC.md, "Route groups"; TEST_SCENARIOS_APP.md S2, S4, S11–S15).
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "@jest/globals";
import request from "supertest";
import { prisma } from "../../src/lib/db.js";
import { sha256Hex } from "../../src/lib/tokens.js";
import { TEST_ENV } from "./globalSetup.js";
import { ADMIN, app, daysAhead, loginAdmin, registerGuest } from "./helpers.js";

afterAll(() => prisma.$disconnect());

const KEY = { "X-Agent-Key": TEST_ENV.AGENT_API_KEY };
const AUTH_REQUIRED = { message: "Authentication required" };
const EXPIRED = { message: "Invalid or expired token" };
const INVALID_KEY = { message: "Invalid API key" };
const FORBIDDEN = { message: "Forbidden" };

const lookup = (headers: Record<string, string>) => request(app).post("/api/agents/guests/lookup").set(headers).send({ email: "a@b.co" });
const agentBooking = (headers: Record<string, string>) =>
  request(app)
    .post("/api/agents/reservations")
    .set(headers)
    .send({ email: `jest-rules-${randomUUID()}@test.dev`, branch: "BRANCH_2", sector: "VIP_WING", date: daysAhead(70), startTime: "11:00", partySize: 2 });

describe("/api/public: no middleware", () => {
  it("(S12, S13) health, menus and availabilities work for anyone; any cookie or key sent is not read", async () => {
    const paths = ["/api/public/health", "/api/public/menus", `/api/public/availabilities?branch=BRANCH_1&sector=MAIN_HALL&date=${daysAhead(30)}`];
    const callers: Record<string, string>[] = [{}, KEY, { Cookie: "session=forged" }, { "X-Agent-Key": "wrong-key-wrong-key-wrong-key-wrong-key" }];
    for (const path of paths) {
      for (const headers of callers) {
        expect([path, headers, (await request(app).get(path).set(headers)).status]).toEqual([path, headers, 200]);
      }
    }
  });
});

describe("/api/auth: rate limit only", () => {
  it("doesn't read the assistant's key", async () => {
    expect((await request(app).post("/api/auth/login").set(KEY).send(ADMIN)).status).toBe(200);
  });
});

describe("/api/users and /api/admins: sign-in check", () => {
  it("(S4) the assistant's key alone is not a sign-in: 401 Authentication required", async () => {
    for (const path of ["/api/users/me", "/api/users/reservations", "/api/users/menus/recommendations", "/api/admins/stats"]) {
      const res = await request(app).get(path).set(KEY);
      expect([path, res.status, res.body]).toEqual([path, 401, AUTH_REQUIRED]);
    }
  });

  it("a guest's cookie still works when a key is sent too (the key isn't read)", async () => {
    const { auth } = await registerGuest();
    expect((await request(app).get("/api/users/me").set(auth).set(KEY)).status).toBe(200);
  });

  it("(S2) a guest on /api/admins gets 403 Forbidden", async () => {
    const { auth } = await registerGuest();
    const res = await request(app).get("/api/admins/stats").set(auth);
    expect([res.status, res.body]).toEqual([403, FORBIDDEN]);
  });

  it("RBAC: an admin can't book or get recommendations (403 Forbidden)", async () => {
    const admin = await loginAdmin();
    const book = await request(app).post("/api/users/reservations").set(admin).send({ branch: "BRANCH_1", sector: "MAIN_HALL", date: daysAhead(71), startTime: "11:00", partySize: 2 });
    expect([book.status, book.body]).toEqual([403, FORBIDDEN]);
    const recommendations = await request(app).get("/api/users/menus/recommendations").set(admin);
    expect([recommendations.status, recommendations.body]).toEqual([403, FORBIDDEN]);
  });

  it("reads the role from the user row on every request, so a role change applies at once", async () => {
    const { auth, user } = await registerGuest();
    expect((await request(app).get("/api/admins/stats").set(auth)).status).toBe(403);
    await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
    expect((await request(app).get("/api/admins/stats").set(auth)).status).toBe(200);
  });
});

describe("/api/agents: agent key check", () => {
  it("(S11) guest and admin cookies mean nothing here: 401 Authentication required", async () => {
    const guest = await registerGuest();
    const admin = await loginAdmin();
    for (const headers of [guest.auth, admin]) {
      for (const res of [await agentBooking(headers), await lookup(headers)]) {
        expect([res.status, res.body]).toEqual([401, AUTH_REQUIRED]);
      }
    }
  });

  it("a missing or empty key is 401 Authentication required", async () => {
    const callers: Record<string, string>[] = [{}, { "X-Agent-Key": "" }];
    for (const headers of callers) {
      const res = await lookup(headers);
      expect([res.status, res.body]).toEqual([401, AUTH_REQUIRED]);
    }
  });

  it("(S14) a key whose owner isn't AGENT is 401 Invalid API key", async () => {
    const { user } = await registerGuest();
    const key = randomBytes(32).toString("base64url");
    await prisma.apiKey.create({ data: { name: "not the assistant", keyHash: sha256Hex(key), userId: user.id } });
    const res = await lookup({ "X-Agent-Key": key });
    expect([res.status, res.body]).toEqual([401, INVALID_KEY]);
  });
});

describe("(S15) removing a user ends their sessions and key at once", () => {
  it("a deleted guest's or admin's cookie gets 401 Invalid or expired token", async () => {
    const guest = await registerGuest();
    const admin = await registerGuest();
    await prisma.user.update({ where: { id: admin.user.id }, data: { role: "ADMIN" } });
    expect((await request(app).get("/api/admins/stats").set(admin.auth)).status).toBe(200);

    await prisma.user.deleteMany({ where: { id: { in: [guest.user.id, admin.user.id] } } });
    for (const path of ["/api/users/me", "/api/users/reservations", "/api/users/menus/recommendations"]) {
      const res = await request(app).get(path).set(guest.auth);
      expect([path, res.status, res.body]).toEqual([path, 401, EXPIRED]);
    }
    const stats = await request(app).get("/api/admins/stats").set(admin.auth);
    expect([stats.status, stats.body]).toEqual([401, EXPIRED]);
    expect(await prisma.session.count({ where: { userId: { in: [guest.user.id, admin.user.id] } } })).toBe(0);
  });

  it("a deleted assistant account's key gets 401 Invalid API key", async () => {
    const key = randomBytes(32).toString("base64url");
    const agent = await prisma.user.create({
      data: { email: `jest-agent-${randomUUID()}@resortos.internal`, name: "Second assistant", role: "AGENT", apiKey: { create: { name: "test key", keyHash: sha256Hex(key) } } },
    });
    expect((await lookup({ "X-Agent-Key": key })).status).toBe(200);
    await prisma.user.delete({ where: { id: agent.id } });
    expect(await prisma.apiKey.count({ where: { userId: agent.id } })).toBe(0);
    const res = await lookup({ "X-Agent-Key": key });
    expect([res.status, res.body]).toEqual([401, INVALID_KEY]);
  });
});
