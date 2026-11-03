import type { Sector } from "../generated/prisma/enums.js";

export const MAX_PARTY_SIZE = 50;
export const MAIN_HALL_TABLE_SEATS = 2;
export const VIP_ROOM_SEATS = 13;

/** Main Hall joins ⌈party / 2⌉ two-seat tables; VIP Wing merges ⌈party / 13⌉ rooms (1–4). */
export function unitsNeeded(sector: Sector, partySize: number): number {
  const seatsPerUnit = sector === "MAIN_HALL" ? MAIN_HALL_TABLE_SEATS : VIP_ROOM_SEATS;
  return Math.ceil(partySize / seatsPerUnit);
}

/**
 * Picks the lowest-numbered free tables so joined tables sit next to each other.
 * Returns null when there isn't enough capacity.
 */
export function pickTables(allTableIds: string[], takenTableIds: Set<string>, needed: number): string[] | null {
  const free = allTableIds
    .filter((id) => !takenTableIds.has(id))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  return free.length >= needed ? free.slice(0, needed) : null;
}
