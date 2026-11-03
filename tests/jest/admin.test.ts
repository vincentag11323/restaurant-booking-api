import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import request from "supertest";
import { generateReservationCode } from "../../src/domain/reservations.js";
import { computeSlot } from "../../src/domain/slots.js";
import { prisma } from "../../src/lib/db.js";
import { app, daysAhead, loginAdmin, registerGuest } from "./helpers.js";

let admin: Record<string, string>;
beforeAll(async () => {
  admin = await loginAdmin();
});
afterAll(() => prisma.$disconnect());

describe("admin stats", () => {
  it("returns zero covers for a day with no bookings", async () => {
    const res = await request(app).get(`/api/admins/stats?date=${daysAhead(45)}&branch=BRANCH_2`).set(admin);
    expect(res.body).toMatchObject({ totalBookings: 0, totalCovers: 0, cancellations: 0 });
    expect(res.body.utilization).toEqual([
      { sector: "MAIN_HALL", usedUnits: 0, capacityUnits: 200, rate: 0 },
      { sector: "VIP_WING", usedUnits: 0, capacityUnits: 16, rate: 0 },
    ]);
  });
});

describe("admin booking log", () => {
  it("filters by open-ended date ranges and searches by phone", async () => {
    const guest = await registerGuest({ phone: "+62 899 4242 4242" });
    const date = daysAhead(46);
    const booking = (
      await request(app).post("/api/users/reservations").set(guest.auth).send({ branch: "BRANCH_2", sector: "VIP_WING", date, startTime: "13:30", partySize: 3 })
    ).body;

    const fromOnly = (await request(app).get(`/api/admins/reservations?from=${date}&q=4242 4242`).set(admin)).body;
    const toOnly = (await request(app).get(`/api/admins/reservations?to=${date}&q=4242 4242`).set(admin)).body;
    const lowerCode = (await request(app).get(`/api/admins/reservations?q=${booking.code.toLowerCase()}`).set(admin)).body;
    expect([fromOnly.total, toOnly.total, lowerCode.total]).toEqual([1, 1, 1]);
    expect(lowerCode.items[0].customer).toEqual({ name: "Jest Guest", email: guest.email, phone: "+62 899 4242 4242" });
  });

  it("audits detail views", async () => {
    const guest = await registerGuest();
    const booking = (
      await request(app).post("/api/users/reservations").set(guest.auth).send({ branch: "BRANCH_1", sector: "MAIN_HALL", date: daysAhead(47), startTime: "17:00", partySize: 2 })
    ).body;
    expect((await request(app).get(`/api/admins/reservations/${booking.id}`).set(admin)).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: "VIEW_RESERVATION_DETAIL", resourceId: booking.id } })).toBe(1);
  });

  it("exports JSON and raises a security alert above 1,000 rows", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const guest = await registerGuest();
    const date = daysAhead(48);
    const { slotStart, slotEnd } = computeSlot(date, "11:00", "+07:00");
    await prisma.reservation.createMany({
      data: Array.from({ length: 1001 }, () => ({
        code: generateReservationCode(),
        userId: guest.user.id,
        branch: "BRANCH_1" as const,
        sector: "MAIN_HALL" as const,
        slotStart,
        slotEnd,
        partySize: 2,
        tableIds: [],
      })),
      skipDuplicates: true,
    });
    const rows = await prisma.reservation.count({ where: { slotStart } });

    const res = await request(app).get(`/api/admins/reservations/export?format=json&from=${date}&to=${date}`).set(admin);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toHaveLength(rows);
    expect(warn).toHaveBeenCalledWith("[SECURITY_ALERT] Bulk booking export", expect.objectContaining({ rows }));
    expect(await prisma.auditLog.count({ where: { action: "EXPORT_RESERVATIONS", metadata: { path: ["rows"], equals: rows } } })).toBe(1);
    warn.mockRestore();
  });

  it("exports CSV by default with empty cells for missing values", async () => {
    const guest = await registerGuest();
    const date = daysAhead(49);
    await request(app).post("/api/users/reservations").set(guest.auth).send({ branch: "BRANCH_2", sector: "MAIN_HALL", date, startTime: "19:30", partySize: 1 });
    const csv = (await request(app).get(`/api/admins/reservations/export?from=${date}&to=${date}&branch=BRANCH_2`).set(admin)).text;
    const cells = csv.trim().split("\n")[1].split(",");
    expect(cells[0]).toMatch(/^RSV-/);
    expect(cells[7]).toBe("B2-MH-01");
    expect(cells[10]).toBe("");
    expect(cells[13]).toBe("");
  });
});
