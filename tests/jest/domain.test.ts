import { afterAll, describe, expect, it } from "@jest/globals";
import { pickTables, unitsNeeded } from "../../src/domain/allocation.js";
import { generateReservationCode, resolveSlot, withAllocation } from "../../src/domain/reservations.js";
import { computeSlot, isBookable, localDayRange, todayLocal } from "../../src/domain/slots.js";
import { prisma } from "../../src/lib/db.js";
import { HttpError } from "../../src/lib/errors.js";

afterAll(() => prisma.$disconnect());

describe("slots", () => {
  it("converts a local sitting into a UTC window", () => {
    const { slotStart, slotEnd } = computeSlot("2026-12-24", "11:00", "+07:00");
    expect(slotStart.toISOString()).toBe("2026-12-24T04:00:00.000Z");
    expect(slotEnd.toISOString()).toBe("2026-12-24T06:30:00.000Z");
  });

  it("rejects an impossible date", () => {
    expect(() => computeSlot("2026-02-30x", "11:00", "+07:00")).toThrow("Invalid date: 2026-02-30x");
  });

  it("handles offsets west of UTC and rejects malformed ones", () => {
    expect(todayLocal("-05:00", new Date("2026-12-25T03:00:00Z"))).toBe("2026-12-24");
    expect(() => todayLocal("UTC+7")).toThrow("Invalid UTC offset: UTC+7");
  });

  it("uses the current time when none is given", () => {
    expect(isBookable(new Date(Date.now() + 60_000))).toBe(true);
    expect(todayLocal("+00:00")).toBe(new Date().toISOString().slice(0, 10));
  });

  it("builds an inclusive multi-day range", () => {
    const { start, end } = localDayRange("2026-12-01", "2026-12-03", "+07:00");
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(72);
  });
});

describe("allocation", () => {
  it("needs one table per two guests and one room per thirteen", () => {
    expect(unitsNeeded("MAIN_HALL", 3)).toBe(2);
    expect(unitsNeeded("VIP_WING", 26)).toBe(2);
    expect(unitsNeeded("VIP_WING", 27)).toBe(3);
  });

  it("sorts table numbers numerically, not alphabetically", () => {
    expect(pickTables(["B1-MH-10", "B1-MH-9", "B1-MH-1"], new Set(), 2)).toEqual(["B1-MH-1", "B1-MH-9"]);
  });
});

describe("reservation helpers", () => {
  it("generates readable codes without ambiguous characters", () => {
    for (let i = 0; i < 200; i++) expect(generateReservationCode()).toMatch(/^RSV-[A-HJ-NP-Z2-9]{6}$/);
  });

  it("refuses a slot that already started", () => {
    expect(() => resolveSlot("2020-01-01", "11:00")).toThrow("Selected slot is in the past or too far ahead");
  });

  it("maps a unique-constraint race to a 400 overlap error", async () => {
    const attempt = withAllocation((tx) => tx.diningTable.create({ data: { id: "B1-MH-01", branch: "BRANCH_1", sector: "MAIN_HALL", seats: 2 } }));
    await expect(attempt).rejects.toEqual(new HttpError(400, "Table overlap conflict, please try again"));
  });

  it("rethrows other database errors untouched", async () => {
    const boom = new Error("disk full");
    await expect(withAllocation(async () => Promise.reject(boom))).rejects.toBe(boom);
  });

  it("the audit log refuses updates and deletes", async () => {
    const entry = await prisma.auditLog.create({ data: { action: "JEST_PROBE" } });
    await expect(prisma.auditLog.update({ where: { id: entry.id }, data: { action: "TAMPERED" } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
  });
});
