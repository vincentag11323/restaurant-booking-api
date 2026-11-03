import { Router } from "express";
import { z } from "zod";
import { MAX_PARTY_SIZE } from "../domain/allocation.js";
import { availability, claimConfirmed, generateReservationCode, reservationSelect, resolveSlot, withAllocation } from "../domain/reservations.js";
import { SLOT_START_TIMES } from "../domain/slots.js";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/db.js";
import { badRequest, notFound } from "../lib/errors.js";
import { notify } from "../lib/notify.js";
import { branchEnum, dateString, parse, sectorEnum } from "../lib/validate.js";
import { currentUser, requireAuth } from "../middleware/auth.js";

export const reservationsRouter = Router();
export const availabilityRouter = Router();

const slotTime = z.enum(SLOT_START_TIMES, { error: `startTime must be one of ${SLOT_START_TIMES.join(", ")}` });
const partySizeMessage = `Party size must be between 1 and ${MAX_PARTY_SIZE}`;
const partySize = z.number().int().min(1, partySizeMessage).max(MAX_PARTY_SIZE, partySizeMessage);

const createSchema = z.object({
  branch: branchEnum,
  sector: sectorEnum,
  date: dateString,
  startTime: slotTime,
  partySize,
  specialRequests: z.string().trim().max(500).optional(),
});

const rescheduleSchema = z.object({
  date: dateString,
  startTime: slotTime,
  partySize: partySize.optional(),
});

const availabilityQuery = z.object({ branch: branchEnum, sector: sectorEnum, date: dateString });

availabilityRouter.get("/", async (req, res) => {
  const { branch, sector, date } = parse(availabilityQuery, req.query);
  res.json(await availability(branch, sector, date, SLOT_START_TIMES));
});

reservationsRouter.use(requireAuth);

/** Loads a reservation owned by the current user; another user's ID is a 404 (no IDOR probing). */
async function findOwned(userId: string, id: string) {
  const reservation = await prisma.reservation.findFirst({ where: { id, userId }, select: reservationSelect });
  if (!reservation) throw notFound();
  return reservation;
}

function assertModifiable(reservation: { status: string; slotStart: Date }) {
  if (reservation.status !== "CONFIRMED") throw badRequest("Only confirmed reservations can be changed");
  if (reservation.slotStart <= new Date()) throw badRequest("Reservation slot has already started");
}

reservationsRouter.get("/", async (req, res) => {
  const reservations = await prisma.reservation.findMany({
    where: { userId: currentUser(req).id },
    select: reservationSelect,
    orderBy: { slotStart: "desc" },
  });
  res.json(reservations);
});

reservationsRouter.get("/:id", async (req, res) => {
  res.json(await findOwned(currentUser(req).id, req.params.id));
});

reservationsRouter.post("/", async (req, res) => {
  const user = currentUser(req);
  const input = parse(createSchema, req.body);
  const { slotStart, slotEnd } = resolveSlot(input.date, input.startTime);

  const reservation = await withAllocation(async (tx, allocate) => {
    const tableIds = await allocate(tx, input.branch, input.sector, slotStart, input.partySize);
    return tx.reservation.create({
      data: {
        code: generateReservationCode(),
        userId: user.id,
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

  await audit(req, "CREATE_RESERVATION", { resourceId: reservation.id });
  const { email } = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { email: true } });
  await notify(email, "Booking confirmed", `Reservation ${reservation.id} at ${slotStart.toISOString()}`);
  res.status(201).json(reservation);
});

/** Reschedule: old tables are released and new ones taken in one transaction, so failure keeps the old booking. */
reservationsRouter.patch("/:id", async (req, res) => {
  const user = currentUser(req);
  const existing = await findOwned(user.id, req.params.id);
  assertModifiable(existing);
  const input = parse(rescheduleSchema, req.body);
  const { slotStart, slotEnd } = resolveSlot(input.date, input.startTime);
  const newPartySize = input.partySize ?? existing.partySize;

  const reservation = await withAllocation(async (tx, allocate) => {
    await claimConfirmed(tx, existing.id);
    await tx.reservationTable.deleteMany({ where: { reservationId: existing.id } });
    const tableIds = await allocate(tx, existing.branch, existing.sector, slotStart, newPartySize);
    return tx.reservation.update({
      where: { id: existing.id },
      data: {
        slotStart,
        slotEnd,
        partySize: newPartySize,
        tableIds,
        allocations: { create: tableIds.map((tableId) => ({ tableId, slotStart })) },
      },
      select: reservationSelect,
    });
  });

  await audit(req, "RESCHEDULE_RESERVATION", {
    resourceId: reservation.id,
    metadata: { from: existing.slotStart, to: slotStart, partySize: newPartySize },
  });
  res.json(reservation);
});

/** Soft cancel: keeps the record, frees the tables. */
reservationsRouter.delete("/:id", async (req, res) => {
  const existing = await findOwned(currentUser(req).id, req.params.id);
  assertModifiable(existing);
  const reservation = await prisma.$transaction(async (tx) => {
    await claimConfirmed(tx, existing.id);
    await tx.reservationTable.deleteMany({ where: { reservationId: existing.id } });
    return tx.reservation.update({
      where: { id: existing.id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
      select: reservationSelect,
    });
  });
  await audit(req, "CANCEL_RESERVATION", { resourceId: reservation.id });
  res.json(reservation);
});
