import { afterAll, describe, expect, it, jest } from "@jest/globals";
import request from "supertest";
import { prisma } from "../../src/lib/db.js";
import { app, daysAhead, registerGuest } from "./helpers.js";

afterAll(() => prisma.$disconnect());

const book = (auth: Record<string, string>, data: Record<string, unknown>) =>
  request(app).post("/api/reservations").set(auth).send({ branch: "BRANCH_1", sector: "MAIN_HALL", startTime: "11:00", partySize: 2, ...data });

describe("availability", () => {
  it("reports free units per sitting", async () => {
    const res = await request(app).get(`/api/availability?branch=BRANCH_2&sector=VIP_WING&date=${daysAhead(31)}`);
    expect(res.body.map((s: { startTime: string; freeUnits: number }) => [s.startTime, s.freeUnits])).toEqual([
      ["11:00", 4], ["13:30", 4], ["17:00", 4], ["19:30", 4],
    ]);
  });
});

describe("booking", () => {
  it("creates a booking without special requests, notifies and audits it", async () => {
    const info = jest.spyOn(console, "info").mockImplementation(() => {});
    const { auth, email, user } = await registerGuest();
    const res = await book(auth, { date: daysAhead(32) });
    expect(res.status).toBe(201);
    expect(res.body.specialRequests).toBeNull();
    expect(info).toHaveBeenCalledWith(expect.stringContaining(`to=${email}`));
    expect(await prisma.auditLog.count({ where: { action: "CREATE_RESERVATION", actorId: user.id } })).toBe(1);
    info.mockRestore();
  });

  it("lists only the guest's own bookings, newest sitting first", async () => {
    const { auth } = await registerGuest();
    const early = (await book(auth, { date: daysAhead(33) })).body;
    const late = (await book(auth, { date: daysAhead(34) })).body;
    expect((await request(app).get("/api/reservations").set(auth)).body.map((r: { id: string }) => r.id)).toEqual([late.id, early.id]);
  });

  it("reschedules keeping the party size when none is given", async () => {
    const { auth } = await registerGuest();
    const booking = (await book(auth, { date: daysAhead(35), partySize: 5 })).body;
    const moved = await request(app).patch(`/api/reservations/${booking.id}`).set(auth).send({ date: daysAhead(36), startTime: "13:30" });
    expect(moved.body).toMatchObject({ partySize: 5, tableIds: ["B1-MH-01", "B1-MH-02", "B1-MH-03"] });
    expect(await prisma.auditLog.count({ where: { action: "RESCHEDULE_RESERVATION", resourceId: booking.id } })).toBe(1);
  });

  it("refuses to change or cancel a booking whose sitting has started", async () => {
    const { auth, user } = await registerGuest();
    const started = await prisma.reservation.create({
      data: {
        code: "RSV-STRTD2",
        userId: user.id,
        branch: "BRANCH_1",
        sector: "MAIN_HALL",
        slotStart: new Date(Date.now() - 30 * 60_000),
        slotEnd: new Date(Date.now() + 120 * 60_000),
        partySize: 2,
        tableIds: [],
      },
    });
    const patch = await request(app).patch(`/api/reservations/${started.id}`).set(auth).send({ date: daysAhead(37), startTime: "11:00" });
    const del = await request(app).delete(`/api/reservations/${started.id}`).set(auth);
    expect([patch.body, del.body]).toEqual([
      { message: "Reservation slot has already started" },
      { message: "Reservation slot has already started" },
    ]);
  });

  it("reads one booking by id, and 404s an unknown id", async () => {
    const { auth } = await registerGuest();
    const booking = (await book(auth, { date: daysAhead(41) })).body;
    expect((await request(app).get(`/api/reservations/${booking.id}`).set(auth)).body).toEqual(booking);
    expect((await request(app).get("/api/reservations/unknown").set(auth)).body).toEqual({ message: "Reservation not found" });
  });

  it("refuses a party the free rooms cannot seat", async () => {
    const { auth } = await registerGuest();
    const date = daysAhead(42);
    expect((await book(auth, { date, sector: "VIP_WING", partySize: 40 })).status).toBe(201);
    expect((await book(auth, { date, sector: "VIP_WING", partySize: 14 })).body).toEqual({ message: "Insufficient capacity for the selected slot" });
  });

  it("refuses a booking further ahead than 60 days", async () => {
    const { auth } = await registerGuest();
    expect((await book(auth, { date: daysAhead(61) })).body).toEqual({ message: "Selected slot is in the past or too far ahead" });
  });
});
