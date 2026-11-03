// Logs (API_SPEC.md §8; TEST_SCENARIOS_APP.md S9, S10, S16).
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, jest } from "@jest/globals";
import type { Request } from "express";
import request from "supertest";
import { prisma } from "../../src/lib/db.js";
import { logChange, logFailure } from "../../src/lib/logs.js";
import { TEST_ENV } from "./globalSetup.js";
import { app, daysAhead, registerGuest, sessionCookie } from "./helpers.js";

afterAll(() => prisma.$disconnect());

type Line = { tag: string; record: Record<string, unknown> };

const tempLog = (name: string) => join(mkdtempSync(join(tmpdir(), "logs-")), "logs", name);
/** Every line is `[METHOD] {json}`. */
function parseLine(line: string): Line {
  const match = /^\[([A-Z]+)\] (.+)$/.exec(line);
  expect(match).not.toBeNull();
  return { tag: match![1], record: JSON.parse(match![2]) };
}
const rawLines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : []);
const lines = (path: string) => rawLines(path).map(parseLine);
const fakeReq = (fields: Partial<Request>) => ({ method: "PATCH", originalUrl: "/api/users/me", ip: "1.2.3.4", ...fields }) as Request;

describe("(S9) error log", () => {
  it("writes one [METHOD]-tagged JSON line per failure and prints the same line with console.error", () => {
    const path = tempLog("errors.log");
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    logFailure({ status: 400, method: "POST", path: "/api/x", message: "bad", ip: "1.2.3.4" }, { path, maxBytes: 1_000_000, console: true });
    logFailure({ status: 500, method: "GET", path: "/api/y", message: "boom", error: new TypeError("boom") }, { path, maxBytes: 1_000_000, console: true });
    const [first, second] = lines(path);
    expect(first.tag).toBe("POST");
    expect(first.record).toMatchObject({ status: 400, method: "POST", path: "/api/x", message: "bad", ip: "1.2.3.4" });
    expect(typeof first.record.time).toBe("string");
    expect(second.tag).toBe("GET");
    expect(second.record.error).toMatchObject({ name: "TypeError" });
    expect((second.record.error as { stack: string }).stack).toContain("TypeError: boom");
    expect(spy.mock.calls).toEqual(rawLines(path).map((line) => [line]));
    spy.mockRestore();
  });

  it("logs real request failures with the method tag and without bodies, query strings or secrets", async () => {
    const path = process.env.ERROR_LOG_PATH!;
    const before = rawLines(path).length;
    await request(app).post("/api/auth/login").send({ email: "nobody@test.dev", password: "SuperSecret1" });
    await request(app).get("/api/nope?email=secret@test.dev");
    await request(app).post("/api/auth/login").set("Content-Type", "application/json").send("{bad");
    await request(app).get("/api/users/me");
    // Parse only the new lines: the shared file may hold lines from earlier runs.
    const added = rawLines(path).slice(before).map(parseLine);
    expect(added.map(({ tag, record }) => [tag, record.status, record.method, record.path, record.message])).toEqual([
      ["POST", 401, "POST", "/api/auth/login", "Invalid email or password"],
      ["GET", 404, "GET", "/api/nope", "Route not found"],
      ["POST", 400, "POST", "/api/auth/login", "Malformed JSON body"],
      ["GET", 401, "GET", "/api/users/me", "Authentication required"],
    ]);
    expect(JSON.stringify(added)).not.toMatch(/SuperSecret1|secret@test\.dev|nobody@test\.dev/);
  });
});

describe("(S16) success log: logChange", () => {
  it("writes exactly time, status, method, path (no query), action, resourceId, userId and ip, and prints it with console.log", () => {
    const path = tempLog("app.log");
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    logChange(fakeReq({ originalUrl: "/api/users/me?x=secret", auth: { userId: "u1", role: "USER" } }), { status: 200, action: "PROFILE_UPDATED", resourceId: "u1" }, { path, maxBytes: 1_000_000, console: true });
    const [line] = lines(path);
    expect(line.tag).toBe("PATCH");
    expect(Object.keys(line.record)).toEqual(["time", "status", "method", "path", "action", "resourceId", "userId", "ip"]);
    expect(line.record).toMatchObject({ status: 200, method: "PATCH", path: "/api/users/me", action: "PROFILE_UPDATED", resourceId: "u1", userId: "u1", ip: "1.2.3.4" });
    expect(spy.mock.calls).toEqual([[rawLines(path)[0]]]);
    spy.mockRestore();
  });

  it("adds count only when given, and prefers an explicit userId over the signed-in caller", () => {
    const path = tempLog("app.log");
    logChange(fakeReq({ method: "POST", originalUrl: "/api/auth/login" }), { status: 200, action: "SESSIONS_EXPIRED_DELETED", count: 2, userId: "u2" }, { path, maxBytes: 1_000_000, console: false });
    expect(Object.keys(lines(path)[0].record)).toEqual(["time", "status", "method", "path", "action", "count", "userId", "ip"]);
    expect(lines(path)[0].record).toMatchObject({ count: 2, userId: "u2" });
  });

  it("prints nothing when the console is off", () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    logChange(fakeReq({}), { status: 200, action: "PROFILE_UPDATED", userId: "u1" }, { path: tempLog("app.log"), maxBytes: 1_000_000, console: false });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("(S10) rotation: one live file and at most one old copy", () => {
  // Each line is 100–200 bytes, so a 200-byte limit holds two lines per file.
  const writers = {
    "error log": (path: string, n: number) => logFailure({ status: 404, method: "GET", path: `/n${n}`, message: "x".repeat(50) }, { path, maxBytes: 200, console: false }),
    "success log": (path: string, n: number) => logChange(fakeReq({ originalUrl: `/n${n}` }), { status: 200, action: "PROFILE_UPDATED", resourceId: "r1", userId: "u1" }, { path, maxBytes: 200, console: false }),
  };
  for (const [name, write] of Object.entries(writers)) {
    it(`${name}: renames to .1 past the limit and deletes the previous .1`, () => {
      const path = tempLog("x.log");
      for (let n = 1; n <= 10; n++) write(path, n);
      expect([path, `${path}.1`].map((p) => lines(p).map((l) => l.record.path))).toEqual([
        ["/n9", "/n10"],
        ["/n7", "/n8"],
      ]);
      expect(existsSync(`${path}.2`)).toBe(false);
    });
  }

  it("creates the log folder and file when they don't exist yet", () => {
    const path = tempLog("errors.log");
    logFailure({ status: 401, method: "GET", path: "/z", message: "no" }, { path, maxBytes: 10, console: false });
    expect(lines(path)).toHaveLength(1);
  });
});

describe("(S16) every successful database change writes one line to app.log", () => {
  const appLog = () => process.env.APP_LOG_PATH!;
  /** Lines written to app.log by `action()`. */
  async function linesFrom(action: () => Promise<unknown>) {
    const before = rawLines(appLog()).length;
    await action();
    return rawLines(appLog()).slice(before).map(parseLine);
  }
  const summary = (added: Line[]) => added.map(({ tag, record }) => [tag, record.status, record.action]);
  const tokenHash = (cookie: string) => createHash("sha256").update(cookie.slice("session=".length)).digest("hex");
  const sessionId = async (cookie: string) => (await prisma.session.findUniqueOrThrow({ where: { tokenHash: tokenHash(cookie) } })).id;
  const expire = (cookie: string) => prisma.session.update({ where: { tokenHash: tokenHash(cookie) }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const login = (email: string) => request(app).post("/api/auth/login").send({ email, password: "Password123" });
  const secrets: string[] = [TEST_ENV.AGENT_API_KEY, "Password123"];
  const allLines: Line[] = [];
  const track = async (action: () => Promise<unknown>) => {
    const added = await linesFrom(action);
    allLines.push(...added);
    return added;
  };

  it("sign-up, sign-in and sign-out", async () => {
    let guest!: Awaited<ReturnType<typeof registerGuest>>;
    const signUp = await track(async () => (guest = await registerGuest({ phone: "+62 811 555 0101" })));
    secrets.push(guest.email, guest.auth.Cookie.slice("session=".length), "+62 811 555 0101", "Jest Guest");
    expect(summary(signUp)).toEqual([
      ["POST", 201, "USER_CREATED"],
      ["POST", 201, "SESSION_CREATED"],
    ]);
    expect(signUp[0].record).toMatchObject({ path: "/api/auth/register", resourceId: guest.user.id, userId: guest.user.id });
    expect(signUp[1].record).toMatchObject({ resourceId: await sessionId(guest.auth.Cookie), userId: guest.user.id });

    await expire(guest.auth.Cookie);
    let cookie = "";
    const signIn = await track(async () => (cookie = sessionCookie(await login(guest.email))));
    expect(summary(signIn)).toEqual([
      ["POST", 200, "SESSIONS_EXPIRED_DELETED"],
      ["POST", 200, "SESSION_CREATED"],
    ]);
    expect(signIn[0].record).toMatchObject({ count: 1, userId: guest.user.id });
    expect(signIn[1].record).toMatchObject({ resourceId: await sessionId(cookie), userId: guest.user.id });

    const liveId = await sessionId(cookie);
    const signOut = await track(() => request(app).post("/api/auth/logout").set("Cookie", cookie));
    expect(summary(signOut)).toEqual([["POST", 200, "SESSION_DELETED"]]);
    expect(signOut[0].record).toMatchObject({ path: "/api/auth/logout", resourceId: liveId, userId: guest.user.id });

    const expiredCookie = sessionCookie(await login(guest.email));
    const expiredId = await sessionId(expiredCookie);
    await expire(expiredCookie);
    const expiredOut = await track(() => request(app).post("/api/auth/logout").set("Cookie", expiredCookie));
    expect(summary(expiredOut)).toEqual([["POST", 200, "SESSION_DELETED"]]);
    expect(expiredOut[0].record).toMatchObject({ resourceId: expiredId, userId: guest.user.id });

    // Nothing was deleted, so nothing is logged.
    expect(await track(() => request(app).post("/api/auth/logout").set("Cookie", "session=forged"))).toEqual([]);
    expect(await track(() => request(app).post("/api/auth/logout"))).toEqual([]);
  });

  it("profile and reservation changes; reads and failed changes write nothing", async () => {
    const guest = await registerGuest();
    secrets.push(guest.email, guest.auth.Cookie.slice("session=".length));
    expect(await track(() => request(app).get("/api/users/me").set(guest.auth))).toEqual([]);
    expect(await track(() => request(app).get("/api/users/reservations").set(guest.auth))).toEqual([]);

    const profile = await track(() => request(app).patch("/api/users/me").set(guest.auth).send({ allergies: ["gluten"] }));
    expect(summary(profile)).toEqual([["PATCH", 200, "PROFILE_UPDATED"]]);
    expect(profile[0].record).toMatchObject({ path: "/api/users/me", resourceId: guest.user.id, userId: guest.user.id });

    let reservation!: { id: string; code: string };
    const created = await track(async () => {
      reservation = (await request(app).post("/api/users/reservations").set(guest.auth).send({ branch: "BRANCH_1", sector: "MAIN_HALL", date: daysAhead(43), startTime: "11:00", partySize: 2 })).body;
    });
    const rescheduled = await track(() => request(app).patch(`/api/users/reservations/${reservation.id}`).set(guest.auth).send({ date: daysAhead(43), startTime: "13:30" }));
    const cancelled = await track(() => request(app).delete(`/api/users/reservations/${reservation.id}`).set(guest.auth));
    expect([...summary(created), ...summary(rescheduled), ...summary(cancelled)]).toEqual([
      ["POST", 201, "RESERVATION_CREATED"],
      ["PATCH", 200, "RESERVATION_RESCHEDULED"],
      ["DELETE", 200, "RESERVATION_CANCELLED"],
    ]);
    for (const [line] of [created, rescheduled, cancelled]) expect(line.record).toMatchObject({ resourceId: reservation.code, userId: guest.user.id });
    expect(rescheduled[0].record.path).toBe(`/api/users/reservations/${reservation.id}`);

    const failed = await track(() => request(app).post("/api/users/reservations").set(guest.auth).send({ branch: "BRANCH_1", sector: "MAIN_HALL", date: daysAhead(43), startTime: "11:00", partySize: 0 }));
    expect(failed).toEqual([]);
  });

  it("assistant bookings, an idempotent retry, and claiming an assistant-made account", async () => {
    const agentKey = { "X-Agent-Key": TEST_ENV.AGENT_API_KEY };
    const agent = await prisma.user.findUniqueOrThrow({ where: { email: "assistant@resortos.internal" } });
    const email = `jest-logs-${randomUUID()}@test.dev`;
    secrets.push(email);
    const booking = (startTime: string) => ({ email, branch: "BRANCH_2", sector: "VIP_WING", date: daysAhead(44), startTime, partySize: 2 });
    const retryKey = { "Idempotency-Key": `jest-logs-${randomUUID()}` };

    let first!: { code: string };
    const newGuest = await track(async () => {
      first = (await request(app).post("/api/agents/reservations").set(agentKey).set(retryKey).send(booking("11:00"))).body;
    });
    const guest = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(summary(newGuest)).toEqual([
      ["POST", 201, "GUEST_ACCOUNT_CREATED"],
      ["POST", 201, "RESERVATION_CREATED"],
    ]);
    expect(newGuest[0].record).toMatchObject({ path: "/api/agents/reservations", resourceId: guest.id, userId: agent.id });
    expect(newGuest[1].record).toMatchObject({ resourceId: first.code, userId: agent.id });

    expect(await track(() => request(app).post("/api/agents/reservations").set(agentKey).set(retryKey).send(booking("11:00")))).toEqual([]);

    const claim = await track(() => request(app).post("/api/auth/register").send({ email, password: "Password123", name: "Claimer" }));
    secrets.push("Claimer");
    expect(summary(claim)).toEqual([
      ["POST", 201, "USER_CLAIMED"],
      ["POST", 201, "SESSION_CREATED"],
    ]);
    expect(claim[0].record).toMatchObject({ resourceId: guest.id, userId: guest.id });

    const existing = await track(() => request(app).post("/api/agents/reservations").set(agentKey).send(booking("13:30")));
    expect(summary(existing)).toEqual([["POST", 201, "RESERVATION_CREATED"]]);
  });

  it("every line has a userId and no personal data or secrets", () => {
    expect(allLines.length).toBeGreaterThan(0);
    for (const { record } of allLines) expect(typeof record.userId).toBe("string");
    const text = JSON.stringify(allLines);
    for (const secret of secrets) expect(text).not.toContain(secret);
  });
});
