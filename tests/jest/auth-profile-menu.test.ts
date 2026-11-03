import { afterAll, describe, expect, it } from "@jest/globals";
import request from "supertest";
import { prisma } from "../../src/lib/db.js";
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

  it("refreshes with the cookie and rejects a tampered or orphaned one", async () => {
    const { agent, user } = await registerGuest();
    const ok = await agent.post("/api/auth/refresh");
    expect(ok.status).toBe(200);
    expect(ok.headers["set-cookie"]?.[0]).toMatch(/refreshToken=.*HttpOnly/);

    const tampered = await request(app).post("/api/auth/refresh").set("Cookie", "refreshToken=forged.token.value");
    expect(tampered.status).toBe(401);

    await prisma.user.delete({ where: { id: user.id } });
    const orphaned = await agent.post("/api/auth/refresh");
    expect(orphaned.status).toBe(401);
    expect(orphaned.body).toEqual({ message: "Invalid or expired refresh token" });
  });

  it("logs out by clearing the cookie", async () => {
    const { agent } = await registerGuest();
    expect((await agent.post("/api/auth/logout")).body).toEqual({ message: "Logged out" });
    expect((await agent.post("/api/auth/refresh")).status).toBe(401);
  });
});

describe("profile", () => {
  it("reads and updates the guest's own profile", async () => {
    const { auth } = await registerGuest();
    expect((await request(app).get("/api/me").set(auth)).body.name).toBe("Jest Guest");
    const res = await request(app).patch("/api/me").set(auth).send({ allergies: [" Gluten "], phone: null });
    expect(res.body).toMatchObject({ allergies: ["gluten"], phone: null });
  });

  it("rejects a missing or malformed bearer header", async () => {
    expect((await request(app).get("/api/me").set("Authorization", "Token abc")).body).toEqual({ message: "Authentication required" });
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
