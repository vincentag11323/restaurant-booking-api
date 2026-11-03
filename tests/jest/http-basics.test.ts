import { afterAll, describe, expect, it } from "@jest/globals";
import request from "supertest";
import { prisma } from "../../src/lib/db.js";
import { app, daysAhead, loginAdmin, registerGuest } from "./helpers.js";

afterAll(() => prisma.$disconnect());

describe("HTTP basics", () => {
  it("answers the health check", async () => {
    expect((await request(app).get("/api/health")).body).toEqual({ status: "ok" });
  });

  it("returns JSON 404 for unknown routes", async () => {
    const res = await request(app).get("/api/unknown");
    expect([res.status, res.body]).toEqual([404, { message: "Route not found" }]);
  });

  it("returns JSON 400 for a malformed body", async () => {
    const res = await request(app).post("/api/auth/login").set("Content-Type", "application/json").send("{oops");
    expect([res.status, res.body]).toEqual([400, { message: "Malformed JSON body" }]);
  });

  it("rejects a forged token", async () => {
    const res = await request(app).get("/api/reservations").set("Authorization", "Bearer forged");
    expect([res.status, res.body]).toEqual([401, { message: "Invalid or expired token" }]);
  });

  it("prefixes field validation messages with the field", async () => {
    const { auth } = await registerGuest();
    const res = await request(app).post("/api/reservations").set(auth).send({ branch: "BRANCH_1", sector: "MAIN_HALL", date: daysAhead(38), startTime: "11:00", partySize: 0 });
    expect(res.body).toEqual({ message: "partySize: Party size must be between 1 and 50" });
  });
});

describe("cancellation", () => {
  it("soft-cancels once, frees the tables and audits it; a second cancel is refused", async () => {
    const { auth } = await registerGuest();
    const date = daysAhead(39);
    const booking = (await request(app).post("/api/reservations").set(auth).send({ branch: "BRANCH_2", sector: "MAIN_HALL", date, startTime: "17:00", partySize: 4 })).body;

    const cancelled = await request(app).delete(`/api/reservations/${booking.id}`).set(auth);
    expect(cancelled.body).toMatchObject({ status: "CANCELLED", tableIds: ["B2-MH-01", "B2-MH-02"] });
    expect(await prisma.reservationTable.count({ where: { reservationId: booking.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "CANCEL_RESERVATION", resourceId: booking.id } })).toBe(1);

    const again = await request(app).patch(`/api/reservations/${booking.id}`).set(auth).send({ date, startTime: "19:30" });
    expect(again.body).toEqual({ message: "Only confirmed reservations can be changed" });
  });
});

describe("admin edge cases", () => {
  it("404s an unknown detail and neutralises formula cells in CSV", async () => {
    const admin = await loginAdmin();
    expect((await request(app).get("/api/admin/reservations/nope").set(admin)).status).toBe(404);

    const guest = await registerGuest({ name: "+SUM(A1)" });
    const date = daysAhead(40);
    await request(app).post("/api/reservations").set(guest.auth).send({ branch: "BRANCH_1", sector: "VIP_WING", date, startTime: "11:00", partySize: 2, specialRequests: "Line one\nline two" });
    const csv = (await request(app).get(`/api/admin/reservations/export?format=csv&from=${date}&to=${date}&sector=VIP_WING`).set(admin)).text;
    expect(csv).toContain(",'+SUM(A1),");
    expect(csv).toContain('"Line one\nline two"');
  });
});
