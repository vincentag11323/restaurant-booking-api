import { afterAll, describe, expect, it } from "@jest/globals";
import jwt from "jsonwebtoken";
import request from "supertest";
import { prisma } from "../../src/lib/db.js";
import { TEST_ENV } from "./global-setup.js";
import { ADMIN, app, registerGuest } from "./helpers.js";

afterAll(() => prisma.$disconnect());

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
    const me = await request(app).get("/api/me").set(auth);
    expect(me.status).toBe(200);
    expect(me.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects a forged, expired or wrongly signed session cookie", async () => {
    const { user } = await registerGuest();
    const expired = jwt.sign({ role: "USER", exp: Math.floor(Date.now() / 1000) - 60 }, TEST_ENV.SESSION_SECRET, { subject: user.id });
    const wrongSecret = jwt.sign({ role: "USER" }, "some-other-secret-some-other-secret", { subject: user.id, expiresIn: 3600 });
    for (const token of ["forged.token.value", expired, wrongSecret]) {
      const res = await request(app).get("/api/me").set("Cookie", `session=${token}`);
      expect([res.status, res.body]).toEqual([401, { message: "Invalid or expired token" }]);
    }
  });

  it("does not accept the session as a Bearer token", async () => {
    const { auth } = await registerGuest();
    const token = auth.Cookie.slice("session=".length);
    const res = await request(app).get("/api/me").set("Authorization", `Bearer ${token}`);
    expect([res.status, res.body]).toEqual([401, { message: "Authentication required" }]);
  });

  it("logs out by clearing the session cookie", async () => {
    const { agent } = await registerGuest();
    const out = await agent.post("/api/auth/logout");
    expect(out.body).toEqual({ message: "Logged out" });
    expect(out.headers["set-cookie"]?.[0]).toMatch(/^session=;.*Path=\/;.*Expires=Thu, 01 Jan 1970/);
    const me = await agent.get("/api/me");
    expect([me.status, me.body]).toEqual([401, { message: "Authentication required" }]);
  });

  it("treats a valid session for a deleted account as expired", async () => {
    const { auth, user } = await registerGuest();
    await prisma.user.delete({ where: { id: user.id } });
    const res = await request(app).get("/api/me").set(auth);
    expect([res.status, res.body]).toEqual([401, { message: "Invalid or expired token" }]);
  });
});

describe("profile", () => {
  it("reads and updates the guest's own profile", async () => {
    const { auth } = await registerGuest();
    expect((await request(app).get("/api/me").set(auth)).body.name).toBe("Jest Guest");
    const res = await request(app).patch("/api/me").set(auth).send({ allergies: [" Gluten "], phone: null });
    expect(res.body).toMatchObject({ allergies: ["gluten"], phone: null });
  });

  it("rejects a request without a session cookie", async () => {
    const res = await request(app).get("/api/me");
    expect([res.status, res.body]).toEqual([401, { message: "Authentication required" }]);
  });
});

describe("menu", () => {
  it("lists all dishes or one type", async () => {
    expect((await request(app).get("/api/menu")).body).toHaveLength(10);
    const seasonal = (await request(app).get("/api/menu?type=SEASONAL_FINE_DINING")).body;
    expect(seasonal.every((d: { type: string }) => d.type === "SEASONAL_FINE_DINING")).toBe(true);
  });

  it("recommends everything to a guest without allergies, chef's picks first", async () => {
    const { auth } = await registerGuest();
    const items: { chefPick: boolean }[] = (await request(app).get("/api/menu/recommendations").set(auth)).body;
    expect(items).toHaveLength(10);
    expect(items.slice(0, 3).every((i) => i.chefPick)).toBe(true);
  });

  it("matches allergens case-insensitively", async () => {
    const { auth } = await registerGuest();
    await request(app).patch("/api/me").set(auth).send({ allergies: ["DAIRY"] });
    const names = (await request(app).get("/api/menu/recommendations").set(auth)).body.map((i: { name: string }) => i.name);
    expect(names).not.toContain("Beef Steak");
    expect(names).toContain("Garden Salad");
  });
});
