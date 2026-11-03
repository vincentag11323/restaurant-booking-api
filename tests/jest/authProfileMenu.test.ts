import { createHash, randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "@jest/globals";
import request from "supertest";
import { prisma } from "../../src/lib/db.js";
import { ADMIN, app, daysAhead, registerGuest, sessionCookie } from "./helpers.js";

afterAll(() => prisma.$disconnect());

const EXPIRED = { message: "Invalid or expired token" };
const forgedCookie = () => `session=${randomBytes(32).toString("base64url")}`;
/** The Session row behind a `session=<token>` Cookie header (only the token's SHA-256 is stored). */
const tokenHash = (cookie: string) => createHash("sha256").update(cookie.slice("session=".length)).digest("hex");
const sessionRow = (cookie: string) => prisma.session.findUnique({ where: { tokenHash: tokenHash(cookie) } });
const expire = (cookie: string) => prisma.session.update({ where: { tokenHash: tokenHash(cookie) }, data: { expiresAt: new Date(Date.now() - 1000) } });

describe("auth", () => {
  it("registers with a phone and audits it", async () => {
    const { user, email } = await registerGuest({ phone: "+62 811 000 111" });
    expect(user).toMatchObject({ email, phone: "+62 811 000 111", role: "USER" });
    expect(await prisma.auditLog.count({ where: { action: "REGISTER", actorId: user.id } })).toBe(1);
  });

  it("stores emails lowercase so login is case-insensitive", async () => {
    const { email } = await registerGuest();
    const res = await request(app).post("/api/auth/login").send({ email: email.toUpperCase(), password: "Password123" });
    expect(res.status).toBe(200);
  });

  it("rejects duplicate registration", async () => {
    const { email } = await registerGuest();
    const res = await request(app).post("/api/auth/register").send({ email, password: "Password123", name: "Twice" });
    expect(res.body).toEqual({ message: "Email is already registered" });
  });

  it("gives the same 401 for an unknown email and a wrong password", async () => {
    const unknown = await request(app).post("/api/auth/login").send({ email: "nobody@test.dev", password: "Password123" });
    const wrong = await request(app).post("/api/auth/login").send({ email: ADMIN.email, password: "nope" });
    expect([unknown.status, wrong.status]).toEqual([401, 401]);
    expect(unknown.body).toEqual(wrong.body);
  });

  it("raises exactly one security alert when an IP keeps failing logins", async () => {
    for (let i = 0; i < 11; i++) {
      await request(app).post("/api/auth/login").send({ email: "attacker@test.dev", password: `guess-${i}` });
    }
    const alerts = await prisma.auditLog.count({
      where: { action: "SECURITY_ALERT", timestamp: { gte: new Date(Date.now() - 5 * 60_000) }, metadata: { path: ["reason"], equals: "Repeated failed logins from one IP" } },
    });
    expect(alerts).toBe(1);
  });

  it("signs in with a 1-hour HttpOnly session cookie and returns only the user", async () => {
    const res = await request(app).post("/api/auth/register").send({ email: `jest-cookie-${Date.now()}@test.dev`, password: "Password123", name: "Cookie" });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(["user"]);
    const cookie: string = res.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toMatch(/^session=/);
    expect(cookie).toContain("Max-Age=3600");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    const login = await request(app).post("/api/auth/login").send(ADMIN);
    expect(Object.keys(login.body)).toEqual(["user"]);
    expect(login.headers["set-cookie"]?.[0]).toMatch(/^session=.*Max-Age=3600/);
  });

  it("never re-issues the session cookie on later calls", async () => {
    const { auth } = await registerGuest();
    const me = await request(app).get("/api/users/me").set(auth);
    expect(me.status).toBe(200);
    expect(me.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects a forged session cookie", async () => {
    for (const cookie of ["session=forged", forgedCookie()]) {
      const res = await request(app).get("/api/users/me").set("Cookie", cookie);
      expect([res.status, res.body]).toEqual([401, EXPIRED]);
    }
  });

  it("does not accept the session as a Bearer token", async () => {
    const { auth } = await registerGuest();
    const token = auth.Cookie.slice("session=".length);
    const res = await request(app).get("/api/users/me").set("Authorization", `Bearer ${token}`);
    expect([res.status, res.body]).toEqual([401, { message: "Authentication required" }]);
  });

  it("logs out by clearing the session cookie", async () => {
    const { agent } = await registerGuest();
    const out = await agent.post("/api/auth/logout");
    expect(out.body).toEqual({ message: "Logged out" });
    expect(out.headers["set-cookie"]?.[0]).toMatch(/^session=;.*Path=\/;.*Expires=Thu, 01 Jan 1970/);
    const me = await agent.get("/api/users/me");
    expect([me.status, me.body]).toEqual([401, { message: "Authentication required" }]);
  });

  it("treats a valid session for a deleted account as expired", async () => {
    const { auth, user } = await registerGuest();
    await prisma.user.delete({ where: { id: user.id } });
    const res = await request(app).get("/api/users/me").set(auth);
    expect([res.status, res.body]).toEqual([401, { message: "Invalid or expired token" }]);
  });
});

describe("server-side sessions", () => {
  it("stores only the SHA-256 of a random 43-character token, valid for 1 hour", async () => {
    const { auth, user } = await registerGuest();
    const token = auth.Cookie.slice("session=".length);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await sessionRow(auth.Cookie);
    expect(row).toMatchObject({ userId: user.id, tokenHash: tokenHash(auth.Cookie) });
    expect(JSON.stringify(row)).not.toContain(token);
    expect(Math.abs((row!.expiresAt.getTime() - row!.createdAt.getTime()) / 1000 - 3600)).toBeLessThanOrEqual(2);
  });

  it("(A14) signing out ends the session at once, even for a saved copy of the cookie", async () => {
    const { auth } = await registerGuest();
    const copy = { ...auth };
    const out = await request(app).post("/api/auth/logout").set(auth);
    expect([out.status, out.body]).toEqual([200, { message: "Logged out" }]);
    const me = await request(app).get("/api/users/me").set(copy);
    expect([me.status, me.body]).toEqual([401, EXPIRED]);
    expect(await sessionRow(copy.Cookie)).toBeNull();
  });

  it("(A15) a session older than 1 hour is refused, and signing in again deletes the old row", async () => {
    const { auth, user, email } = await registerGuest();
    await expire(auth.Cookie);
    const me = await request(app).get("/api/users/me").set(auth);
    expect([me.status, me.body]).toEqual([401, EXPIRED]);

    const login = await request(app).post("/api/auth/login").send({ email, password: "Password123" });
    expect(login.status).toBe(200);
    expect(await sessionRow(auth.Cookie)).toBeNull();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
  });

  it("(A16) signing out on one device leaves the other devices signed in", async () => {
    const { auth: deviceA, email } = await registerGuest();
    const deviceB = { Cookie: sessionCookie(await request(app).post("/api/auth/login").send({ email, password: "Password123" })) };
    await request(app).post("/api/auth/logout").set(deviceA);
    expect((await request(app).get("/api/users/me").set(deviceB)).status).toBe(200);
    const a = await request(app).get("/api/users/me").set(deviceA);
    expect([a.status, a.body]).toEqual([401, EXPIRED]);
  });

  it("(S13) an old or forged cookie is ignored by sign-in, sign-up and the public routes", async () => {
    const { auth: expired } = await registerGuest();
    await expire(expired.Cookie);
    for (const cookie of [forgedCookie(), expired.Cookie]) {
      const login = await request(app).post("/api/auth/login").set("Cookie", cookie).send(ADMIN);
      expect(login.status).toBe(200);
      expect(sessionCookie(login)).not.toBe(cookie);
      const register = await request(app).post("/api/auth/register").set("Cookie", cookie).send({ email: `jest-s13-${randomBytes(6).toString("hex")}@test.dev`, password: "Password123", name: "S13" });
      expect(register.status).toBe(201);
      expect((await request(app).get("/api/public/menus").set("Cookie", cookie)).status).toBe(200);
      expect((await request(app).get(`/api/public/availabilities?branch=BRANCH_1&sector=MAIN_HALL&date=${daysAhead(30)}`).set("Cookie", cookie)).status).toBe(200);
    }
  });

  it("signing out with a forged cookie answers 200 and touches no other session", async () => {
    const { auth } = await registerGuest();
    const out = await request(app).post("/api/auth/logout").set("Cookie", forgedCookie());
    expect([out.status, out.body]).toEqual([200, { message: "Logged out" }]);
    expect((await request(app).get("/api/users/me").set(auth)).status).toBe(200);
  });

  it("signing out with an expired cookie deletes its row", async () => {
    const { auth } = await registerGuest();
    await expire(auth.Cookie);
    expect((await request(app).post("/api/auth/logout").set(auth)).status).toBe(200);
    expect(await sessionRow(auth.Cookie)).toBeNull();
  });
});

describe("profile", () => {
  it("reads and updates the guest's own profile", async () => {
    const { auth } = await registerGuest();
    expect((await request(app).get("/api/users/me").set(auth)).body.name).toBe("Jest Guest");
    const res = await request(app).patch("/api/users/me").set(auth).send({ allergies: [" Gluten "], phone: null });
    expect(res.body).toMatchObject({ allergies: ["gluten"], phone: null });
  });

  it("rejects a request without a session cookie", async () => {
    const res = await request(app).get("/api/users/me");
    expect([res.status, res.body]).toEqual([401, { message: "Authentication required" }]);
  });
});

describe("menu", () => {
  it("lists all dishes or one type", async () => {
    expect((await request(app).get("/api/public/menus")).body).toHaveLength(10);
    const seasonal = (await request(app).get("/api/public/menus?type=SEASONAL_FINE_DINING")).body;
    expect(seasonal.every((d: { type: string }) => d.type === "SEASONAL_FINE_DINING")).toBe(true);
  });

  it("recommends everything to a guest without allergies, chef's picks first", async () => {
    const { auth } = await registerGuest();
    const items: { chefPick: boolean }[] = (await request(app).get("/api/users/menus/recommendations").set(auth)).body;
    expect(items).toHaveLength(10);
    expect(items.slice(0, 3).every((i) => i.chefPick)).toBe(true);
  });

  it("matches allergens case-insensitively", async () => {
    const { auth } = await registerGuest();
    await request(app).patch("/api/users/me").set(auth).send({ allergies: ["DAIRY"] });
    const names = (await request(app).get("/api/users/menus/recommendations").set(auth)).body.map((i: { name: string }) => i.name);
    expect(names).not.toContain("Beef Steak");
    expect(names).toContain("Garden Salad");
  });
});
