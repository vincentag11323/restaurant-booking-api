import { randomInt } from "node:crypto";
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
  code: true,
  source: true,
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

// No 0/O or 1/I, so codes survive being read aloud at the host stand.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** "RSV-7K3Q9X": 32^6 ≈ 1 billion codes; a collision fails the unique index and surfaces as a 400 retry. */
export function generateReservationCode(): string {
  const chars = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
  return `RSV-${chars.join("")}`;
}

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

/**
 * Re-checks "still CONFIRMED" inside the transaction. The conditional UPDATE takes the row lock,
 * so a concurrent cancel/reschedule of the same booking waits, then sees the new status and fails here.
 */
export async function claimConfirmed(tx: Tx, id: string) {
  const { count } = await tx.reservation.updateMany({ where: { id, status: "CONFIRMED" }, data: { updatedAt: new Date() } });
  if (count === 0) throw badRequest("Only confirmed reservations can be changed");
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

export interface BookingInput {
  branch: Branch;
  sector: Sector;
  date: string;
  startTime: SlotStartTime;
  partySize: number;
  specialRequests?: string;
}

/** The one booking code path, shared by guests (app) and the assistant (on a guest's behalf). */
export function bookReservation(
  input: BookingInput,
  who: { userId: string; createdById: string; source: "APP" | "AGENT"; idempotencyKey?: string },
) {
  const { slotStart, slotEnd } = resolveSlot(input.date, input.startTime);
  return withAllocation(async (tx, allocate) => {
    const tableIds = await allocate(tx, input.branch, input.sector, slotStart, input.partySize);
    return tx.reservation.create({
      data: {
        code: generateReservationCode(),
        userId: who.userId,
        createdById: who.createdById,
        source: who.source,
        idempotencyKey: who.idempotencyKey,
        branch: input.branch,
        sector: input.sector,
        slotStart,
        slotEnd,
        partySize: input.partySize,
        specialRequests: input.specialRequests,
        tableIds,
        allocations: { create: tableIds.map((tableId) => ({ tableId, slotStart })) },
      },
      select: reservationSelect,
    });
  });
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
