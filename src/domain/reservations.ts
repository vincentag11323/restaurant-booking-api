import { Prisma } from "../generated/prisma/client.js";
import type { Branch, Sector } from "../generated/prisma/enums.js";
import { config } from "../config.js";
import { prisma } from "../lib/db.js";
import { badRequest } from "../lib/errors.js";
import { pickTables, unitsNeeded } from "./allocation.js";
import { type SlotStartTime, computeSlot, isBookable } from "./slots.js";

type Tx = Prisma.TransactionClient;

/** Fields returned to clients (never userId / allocation internals). */
export const reservationSelect = {
  id: true,
  branch: true,
  sector: true,
  slotStart: true,
  slotEnd: true,
  partySize: true,
  specialRequests: true,
  status: true,
  tableIds: true,
  createdAt: true,
  updatedAt: true,
  cancelledAt: true,
} satisfies Prisma.ReservationSelect;

export function resolveSlot(date: string, startTime: SlotStartTime) {
  const slot = computeSlot(date, startTime, config.utcOffset);
  if (!isBookable(slot.slotStart)) throw badRequest("Selected slot is in the past or too far ahead");
  return slot;
}

/** Finds free tables for a slot inside a transaction, or throws a capacity error. */
async function allocateTables(tx: Tx, branch: Branch, sector: Sector, slotStart: Date, partySize: number) {
  const [tables, taken] = await Promise.all([
    tx.diningTable.findMany({ where: { branch, sector }, select: { id: true } }),
    tx.reservationTable.findMany({ where: { slotStart, table: { branch, sector } }, select: { tableId: true } }),
  ]);
  const picked = pickTables(
    tables.map((t) => t.id),
    new Set(taken.map((t) => t.tableId)),
    unitsNeeded(sector, partySize),
  );
  if (!picked) throw badRequest("Insufficient capacity for the selected slot");
  return picked;
}

/** Runs a booking transaction, mapping a unique-constraint race to a 400 overlap error. */
export async function withAllocation<T>(fn: (tx: Tx, allocate: typeof allocateTables) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction((tx) => fn(tx, allocateTables));
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw badRequest("Table overlap conflict, please try again");
    }
    throw err;
  }
}

/** Remaining tables/rooms per slot for a branch, sector and date. */
export async function availability(branch: Branch, sector: Sector, date: string, startTimes: readonly SlotStartTime[]) {
  const total = await prisma.diningTable.count({ where: { branch, sector } });
  return Promise.all(
    startTimes.map(async (startTime) => {
      const { slotStart, slotEnd } = computeSlot(date, startTime, config.utcOffset);
      const taken = await prisma.reservationTable.count({ where: { slotStart, table: { branch, sector } } });
      return { startTime, slotStart, slotEnd, totalUnits: total, freeUnits: total - taken, bookable: isBookable(slotStart) };
    }),
  );
}
