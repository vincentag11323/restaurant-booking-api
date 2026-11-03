import { afterAll, describe, expect, it } from "@jest/globals";
import request from "supertest";
import { prisma } from "../../src/lib/db.js";
import { TEST_ENV } from "./globalSetup.js";
import { app, daysAhead, loginAdmin, registerGuest } from "./helpers.js";

afterAll(() => prisma.$disconnect());

describe("HTTP basics", () => {
  it("answers the health check", async () => {
    expect((await request(app).get("/api/public/health")).body).toEqual({ status: "ok" });
  });

  it("returns JSON 404 for unknown routes", async () => {
    const res = await request(app).get("/api/unknown");
    expect([res.status, res.body]).toEqual([404, { message: "Route not found" }]);
  });

  it("returns JSON 400 for a malformed body", async () => {
    const res = await request(app).post("/api/auth/login").set("Content-Type", "application/json").send("{oops");
    expect([res.status, res.body]).toEqual([400, { message: "Malformed JSON body" }]);
  });

  it("rejects a forged session cookie", async () => {
    const res = await request(app).get("/api/users/reservations").set("Cookie", "session=forged");
    expect([res.status, res.body]).toEqual([401, { message: "Invalid or expired token" }]);
  });

  it("prefixes field validation messages with the field", async () => {
    const { auth } = await registerGuest();
    const res = await request(app).post("/api/users/reservations").set(auth).send({ branch: "BRANCH_1", sector: "MAIN_HALL", date: daysAhead(38), startTime: "11:00", partySize: 0 });
    expect(res.body).toEqual({ message: "partySize: Party size must be between 1 and 50" });
  });
});

describe("CSRF origin rule", () => {
  it("blocks a POST from a foreign Origin", async () => {
    const res = await request(app).post("/api/auth/login").set("Origin", "http://evil.example").send({ email: "admin@resortos.test", password: "Admin12345!" });
    expect([res.status, res.body]).toEqual([403, { message: "Cross-origin request blocked" }]);
  });

  it("lets a POST from the web app's Origin through", async () => {
    const res = await request(app).post("/api/auth/login").set("Origin", TEST_ENV.CORS_ORIGIN).send({ email: "admin@resortos.test", password: "wrong-password" });
    expect([res.status, res.body]).toEqual([401, { message: "Invalid email or password" }]);
  });

  it("lets a GET from a foreign Origin through", async () => {
    const res = await request(app).get("/api/public/health").set("Origin", "http://evil.example");
    expect(res.status).toBe(200);
  });
});

describe("cancellation", () => {
  it("soft-cancels once, frees the tables and audits it; a second cancel is refused", async () => {
    const { auth } = await registerGuest();
    const date = daysAhead(39);
    const booking = (await request(app).post("/api/users/reservations").set(auth).send({ branch: "BRANCH_2", sector: "MAIN_HALL", date, startTime: "17:00", partySize: 4 })).body;

    const cancelled = await request(app).delete(`/api/users/reservations/${booking.id}`).set(auth);
    expect(cancelled.body).toMatchObject({ status: "CANCELLED", tableIds: ["B2-MH-01", "B2-MH-02"] });
    expect(await prisma.reservationTable.count({ where: { reservationId: booking.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "CANCEL_RESERVATION", resourceId: booking.id } })).toBe(1);

    const again = await request(app).patch(`/api/users/reservations/${booking.id}`).set(auth).send({ date, startTime: "19:30" });
    expect(again.body).toEqual({ message: "Only confirmed reservations can be changed" });
  });
});

describe("admin edge cases", () => {
  it("404s an unknown detail and neutralises formula cells in CSV", async () => {
    const admin = await loginAdmin();
    expect((await request(app).get("/api/admins/reservations/nope").set(admin)).status).toBe(404);

    const guest = await registerGuest({ name: "+SUM(A1)" });
    const date = daysAhead(40);
    await request(app).post("/api/users/reservations").set(guest.auth).send({ branch: "BRANCH_1", sector: "VIP_WING", date, startTime: "11:00", partySize: 2, specialRequests: "Line one\nline two" });
    const csv = (await request(app).get(`/api/admins/reservations/export?format=csv&from=${date}&to=${date}&sector=VIP_WING`).set(admin)).text;
    expect(csv).toContain(",'+SUM(A1),");
    expect(csv).toContain('"Line one\nline two"');
  });
});
