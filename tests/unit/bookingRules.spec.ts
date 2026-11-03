import { expect, test } from "@playwright/test";
import { pickTables, unitsNeeded } from "../../src/domain/allocation.js";
import { computeSlot, isBookable, localDayRange, todayLocal } from "../../src/domain/slots.js";

test.describe("2.5-hour slot computation", () => {
  test("19:30 local (UTC+7) slot runs 12:30 to 15:00 UTC", () => {
    const { slotStart, slotEnd } = computeSlot("2026-12-24", "19:30", "+07:00");
    expect(slotStart.toISOString()).toBe("2026-12-24T12:30:00.000Z");
    expect(slotEnd.toISOString()).toBe("2026-12-24T15:00:00.000Z");
  });

  test("a slot that has started is not bookable", () => {
    const now = new Date("2026-12-24T12:31:00Z");
    expect(isBookable(new Date("2026-12-24T12:30:00Z"), now)).toBe(false);
  });

  test("slots up to 60 days ahead are bookable, beyond that they are not", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(isBookable(new Date("2026-03-01T00:00:00Z"), now)).toBe(true);
    expect(isBookable(new Date("2026-03-03T00:00:00Z"), now)).toBe(false);
  });

  test("today in restaurant time rolls over at local midnight", () => {
    expect(todayLocal("+07:00", new Date("2026-12-24T17:30:00Z"))).toBe("2026-12-25");
    expect(todayLocal("+07:00", new Date("2026-12-24T16:30:00Z"))).toBe("2026-12-24");
  });

  test("a local day range covers local midnight to midnight", () => {
    const { start, end } = localDayRange("2026-12-24", "2026-12-25", "+07:00");
    expect(start.toISOString()).toBe("2026-12-23T17:00:00.000Z");
    expect(end.toISOString()).toBe("2026-12-25T17:00:00.000Z");
  });
});

test.describe("table allocation", () => {
  test("Main Hall joins one two-seat table per two guests, rounding up", () => {
    expect(unitsNeeded("MAIN_HALL", 1)).toBe(1);
    expect(unitsNeeded("MAIN_HALL", 7)).toBe(4);
    expect(unitsNeeded("MAIN_HALL", 50)).toBe(25);
  });

  test("VIP Wing merges 1 to 4 rooms of 13 seats", () => {
    expect(unitsNeeded("VIP_WING", 13)).toBe(1);
    expect(unitsNeeded("VIP_WING", 14)).toBe(2);
    expect(unitsNeeded("VIP_WING", 50)).toBe(4);
  });

  test("picks the lowest-numbered free tables so joined tables sit together", () => {
    const all = ["B1-MH-10", "B1-MH-02", "B1-MH-01", "B1-MH-03"];
    expect(pickTables(all, new Set(["B1-MH-02"]), 2)).toEqual(["B1-MH-01", "B1-MH-03"]);
  });

  test("returns null when free tables cannot seat the party", () => {
    expect(pickTables(["B1-VIP-1", "B1-VIP-2"], new Set(["B1-VIP-1"]), 2)).toBeNull();
  });
});
