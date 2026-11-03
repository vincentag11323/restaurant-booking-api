import { expect, test } from "@playwright/test";
import { daysAhead, registerGuest } from "./helpers.js";

const CODE_PATTERN = /^RSV-[A-HJ-NP-Z2-9]{6}$/;

test.describe("reservation lifecycle", () => {
  test("create, read, reschedule and soft-cancel a Main Hall booking", async ({ request }) => {
    const { headers } = await registerGuest(request);
    const date = daysAhead(3);

    const created = await request.post("/api/reservations", {
      headers,
      data: { branch: "BRANCH_1", sector: "MAIN_HALL", date, startTime: "19:30", partySize: 7, specialRequests: "Window seat" },
    });
    expect(created.status()).toBe(201);
    const booking = await created.json();
    expect(booking).toMatchObject({
      branch: "BRANCH_1",
      sector: "MAIN_HALL",
      partySize: 7,
      status: "CONFIRMED",
      specialRequests: "Window seat",
      tableIds: ["B1-MH-01", "B1-MH-02", "B1-MH-03", "B1-MH-04"],
    });
    expect(booking.code).toMatch(CODE_PATTERN);
    expect(booking.slotStart).toBe(`${date}T12:30:00.000Z`);
    expect(booking.slotEnd).toBe(`${date}T15:00:00.000Z`);

    const read = await request.get(`/api/reservations/${booking.id}`, { headers });
    expect(await read.json()).toEqual(booking);
    const list = await request.get("/api/reservations", { headers });
    expect((await list.json()).map((r: { id: string }) => r.id)).toEqual([booking.id]);

    const moved = await request.patch(`/api/reservations/${booking.id}`, {
      headers,
      data: { date, startTime: "17:00", partySize: 3 },
    });
    expect(moved.status()).toBe(200);
    expect(await moved.json()).toMatchObject({ slotStart: `${date}T10:00:00.000Z`, partySize: 3, tableIds: ["B1-MH-01", "B1-MH-02"] });

    const slots = await (await request.get(`/api/availability?branch=BRANCH_1&sector=MAIN_HALL&date=${date}`)).json();
    expect(slots.find((s: { startTime: string }) => s.startTime === "19:30").freeUnits).toBe(50);
    expect(slots.find((s: { startTime: string }) => s.startTime === "17:00").freeUnits).toBe(48);

    const cancelled = await request.delete(`/api/reservations/${booking.id}`, { headers });
    expect(cancelled.status()).toBe(200);
    const cancelledBody = await cancelled.json();
    expect(cancelledBody).toMatchObject({ status: "CANCELLED", tableIds: ["B1-MH-01", "B1-MH-02"] });
    expect(cancelledBody.cancelledAt).toEqual(expect.any(String));

    const after = await (await request.get(`/api/availability?branch=BRANCH_1&sector=MAIN_HALL&date=${date}`)).json();
    expect(after.find((s: { startTime: string }) => s.startTime === "17:00").freeUnits).toBe(50);

    const again = await request.delete(`/api/reservations/${booking.id}`, { headers });
    expect(again.status()).toBe(400);
    expect(await again.json()).toEqual({ message: "Only confirmed reservations can be changed" });
  });

  test("a failed reschedule keeps the original booking and its tables", async ({ request }) => {
    const { headers } = await registerGuest(request);
    const date = daysAhead(4);
    const book = (startTime: string, partySize: number) =>
      request.post("/api/reservations", { headers, data: { branch: "BRANCH_2", sector: "VIP_WING", date, startTime, partySize } });

    await book("11:00", 50);
    const small = await (await book("13:30", 10)).json();

    const res = await request.patch(`/api/reservations/${small.id}`, { headers, data: { date, startTime: "11:00" } });
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ message: "Insufficient capacity for the selected slot" });
    const unchanged = await (await request.get(`/api/reservations/${small.id}`, { headers })).json();
    expect(unchanged).toMatchObject({ slotStart: small.slotStart, tableIds: ["B2-VIP-1"] });
  });
});

test.describe("booking validation", () => {
  const base = { branch: "BRANCH_1", sector: "MAIN_HALL", startTime: "11:00", partySize: 2 };

  test("rejects a start time that is not a fixed slot", async ({ request }) => {
    const { headers } = await registerGuest(request);
    const res = await request.post("/api/reservations", { headers, data: { ...base, date: daysAhead(5), startTime: "12:00" } });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toBe("startTime: startTime must be one of 11:00, 13:30, 17:00, 19:30");
  });

  test("rejects a party larger than 50", async ({ request }) => {
    const { headers } = await registerGuest(request);
    const res = await request.post("/api/reservations", { headers, data: { ...base, date: daysAhead(5), partySize: 51 } });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toBe("partySize: Party size must be between 1 and 50");
  });

  test("rejects a date in the past", async ({ request }) => {
    const { headers } = await registerGuest(request);
    const res = await request.post("/api/reservations", { headers, data: { ...base, date: daysAhead(-1) } });
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ message: "Selected slot is in the past or too far ahead" });
  });

  test("rejects a booking when the sector is full", async ({ request }) => {
    const { headers } = await registerGuest(request);
    const data = { branch: "BRANCH_1", sector: "VIP_WING", date: daysAhead(6), startTime: "19:30" };
    expect((await request.post("/api/reservations", { headers, data: { ...data, partySize: 40 } })).status()).toBe(201);
    const res = await request.post("/api/reservations", { headers, data: { ...data, partySize: 13 } });
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ message: "Insufficient capacity for the selected slot" });
  });

  test("simultaneous bookings for the last capacity never double-book", async ({ request }) => {
    const guests = await Promise.all([registerGuest(request), registerGuest(request), registerGuest(request)]);
    const data = { branch: "BRANCH_2", sector: "VIP_WING", date: daysAhead(7), startTime: "17:00", partySize: 50 };
    const results = await Promise.all(guests.map(({ headers }) => request.post("/api/reservations", { headers, data })));
    const statuses = results.map((r) => r.status()).sort();
    expect(statuses).toEqual([201, 400, 400]);
    for (const r of results.filter((r) => r.status() === 400)) {
      expect(["Insufficient capacity for the selected slot", "Table overlap conflict, please try again"]).toContain((await r.json()).message);
    }
  });
});

test.describe("concurrent changes to one booking", () => {
  test("a reschedule racing a cancel never leaves a cancelled booking holding tables", async ({ request }) => {
    const { headers } = await registerGuest(request);
    const date = daysAhead(9);
    for (let attempt = 0; attempt < 5; attempt++) {
      const booking = await (
        await request.post("/api/reservations", { headers, data: { branch: "BRANCH_2", sector: "VIP_WING", date, startTime: "11:00", partySize: 50 } })
      ).json();
      await Promise.all([
        request.patch(`/api/reservations/${booking.id}`, { headers, data: { date, startTime: "19:30" } }),
        request.delete(`/api/reservations/${booking.id}`, { headers }),
      ]);
      const final = await (await request.get(`/api/reservations/${booking.id}`, { headers })).json();
      const slots = await (await request.get(`/api/availability?branch=BRANCH_2&sector=VIP_WING&date=${date}`)).json();
      const held = slots.reduce((sum: number, s: { totalUnits: number; freeUnits: number }) => sum + s.totalUnits - s.freeUnits, 0);
      expect(final.status).toBe("CANCELLED");
      expect(held).toBe(0);
    }
  });
});

test.describe("access control", () => {
  test("bookings require a token", async ({ request }) => {
    expect((await request.get("/api/reservations")).status()).toBe(401);
  });

  test("an unknown reservation is 404", async ({ request }) => {
    const { headers } = await registerGuest(request);
    const res = await request.get("/api/reservations/does-not-exist", { headers });
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ message: "Reservation not found" });
  });

  test("another guest's reservation is 404 for read, reschedule and cancel (IDOR)", async ({ request }) => {
    const owner = await registerGuest(request);
    const intruder = await registerGuest(request);
    const date = daysAhead(8);
    const booking = await (
      await request.post("/api/reservations", {
        headers: owner.headers,
        data: { branch: "BRANCH_1", sector: "MAIN_HALL", date, startTime: "13:30", partySize: 2 },
      })
    ).json();

    const url = `/api/reservations/${booking.id}`;
    expect((await request.get(url, { headers: intruder.headers })).status()).toBe(404);
    expect((await request.patch(url, { headers: intruder.headers, data: { date, startTime: "11:00" } })).status()).toBe(404);
    expect((await request.delete(url, { headers: intruder.headers })).status()).toBe(404);
    expect((await (await request.get(url, { headers: owner.headers })).json()).status).toBe("CONFIRMED");
  });
});
