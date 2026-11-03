import { expect, test } from "@playwright/test";
import { daysAhead, loginAdmin, registerGuest } from "./helpers.js";

test.describe("admin is read-only and admin-only", () => {
  test("a guest token is forbidden", async ({ request }) => {
    const { headers } = await registerGuest(request);
    const res = await request.get("/api/admin/stats", { headers });
    expect(res.status()).toBe(403);
    expect(await res.json()).toEqual({ message: "Forbidden" });
  });

  test("there are no admin write routes", async ({ request }) => {
    const { headers } = await loginAdmin(request);
    expect((await request.post("/api/admin/reservations", { headers, data: {} })).status()).toBe(404);
    expect((await request.delete("/api/admin/reservations/anything", { headers })).status()).toBe(404);
  });
});

test.describe("admin booking log", () => {
  test("stats, search, filters, detail and export for one day", async ({ request }) => {
    const admin = await loginAdmin(request);
    const guest = await registerGuest(request, { name: "Ayu Lestari" });
    const date = daysAhead(20);
    const book = async (data: Record<string, unknown>) =>
      (await request.post("/api/reservations", { headers: guest.headers, data: { branch: "BRANCH_1", date, ...data } })).json();

    const mainHall = await book({ sector: "MAIN_HALL", startTime: "19:30", partySize: 6, specialRequests: "Birthday cake" });
    await book({ sector: "VIP_WING", startTime: "17:00", partySize: 20 });
    const toCancel = await book({ sector: "MAIN_HALL", startTime: "11:00", partySize: 2 });
    await request.delete(`/api/reservations/${toCancel.id}`, { headers: guest.headers });

    const stats = await (await request.get(`/api/admin/stats?date=${date}&branch=BRANCH_1`, { headers: admin.headers })).json();
    expect(stats).toEqual({
      date,
      totalBookings: 2,
      totalCovers: 26,
      cancellations: 1,
      utilization: [
        { sector: "MAIN_HALL", usedUnits: 3, capacityUnits: 200, rate: 0.015 },
        { sector: "VIP_WING", usedUnits: 2, capacityUnits: 16, rate: 0.125 },
      ],
    });

    const byCode = await (await request.get(`/api/admin/reservations?q=${mainHall.code}`, { headers: admin.headers })).json();
    expect(byCode.total).toBe(1);
    expect(byCode.items[0]).toMatchObject({ id: mainHall.id, customer: { name: "Ayu Lestari", email: guest.email } });

    const byName = await (await request.get(`/api/admin/reservations?q=ayu lest&from=${date}&to=${date}`, { headers: admin.headers })).json();
    expect(byName.total).toBe(3);

    const cancelled = await (
      await request.get(`/api/admin/reservations?status=CANCELLED&sector=MAIN_HALL&from=${date}&to=${date}`, { headers: admin.headers })
    ).json();
    expect(cancelled.items.map((r: { id: string }) => r.id)).toEqual([toCancel.id]);

    const paged = await (await request.get(`/api/admin/reservations?from=${date}&to=${date}&pageSize=2&page=2`, { headers: admin.headers })).json();
    expect(paged).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(paged.items).toHaveLength(1);

    const detail = await request.get(`/api/admin/reservations/${mainHall.id}`, { headers: admin.headers });
    expect(detail.status()).toBe(200);
    expect(await detail.json()).toMatchObject({ specialRequests: "Birthday cake", tableIds: ["B1-MH-01", "B1-MH-02", "B1-MH-03"] });

    const csv = await request.get(`/api/admin/reservations/export?format=csv&from=${date}&to=${date}`, { headers: admin.headers });
    expect(csv.headers()["content-type"]).toContain("text/csv");
    expect(csv.headers()["content-disposition"]).toContain("attachment");
    const lines = (await csv.text()).trim().split("\n");
    expect(lines[0]).toBe("code,status,branch,sector,slotStart,slotEnd,partySize,tableIds,customerName,customerEmail,customerPhone,specialRequests,createdAt,cancelledAt");
    expect(lines).toHaveLength(4);

    const json = await request.get(`/api/admin/reservations/export?format=json&from=${date}&to=${date}`, { headers: admin.headers });
    expect(json.headers()["content-type"]).toContain("application/json");
    expect(await json.json()).toHaveLength(3);
  });

  test("an unknown reservation detail is 404", async ({ request }) => {
    const { headers } = await loginAdmin(request);
    expect((await request.get("/api/admin/reservations/missing", { headers })).status()).toBe(404);
  });
});
