import { Router } from "express";
import { z } from "zod";
import { MAX_PARTY_SIZE } from "../domain/allocation.js";
import { availability, bookReservation, claimConfirmed, reservationSelect, resolveSlot, withAllocation } from "../domain/reservations.js";
import { SLOT_START_TIMES } from "../domain/slots.js";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/db.js";
import { badRequest, notFound } from "../lib/errors.js";
import { logChange } from "../lib/logs.js";
import { CHANGE_ERRORS, FORBIDDEN_ERROR, SESSION_SECURITY, SIGN_IN_ERRORS, errorResponses, jsonBody, jsonResponse, registry } from "../lib/openApi.js";
import { notify } from "../lib/notify.js";
import { branchEnum, dateString, parse, sectorEnum } from "../lib/validate.js";
import { currentUser, requirePermission } from "../middleware/auth.js";

export const reservationsRouter = Router();
export const availabilityRouter = Router();

const slotTime = z.enum(SLOT_START_TIMES, { error: `startTime must be one of ${SLOT_START_TIMES.join(", ")}` });
const partySizeMessage = `Party size must be between 1 and ${MAX_PARTY_SIZE}`;
const partySize = z.number().int().min(1, partySizeMessage).max(MAX_PARTY_SIZE, partySizeMessage);

/** Shared with the assistant's booking route, so both apply identical rules and messages. */
export const createSchema = z.object({
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

/** Docs only: the `:id` in /api/users/reservations/{id} and /api/admins/reservations/{id}. */
export const idParams = z.object({ id: z.string() });

/** Docs only: one sitting from availability(). */
export const slotSchema = z.object({
  startTime: slotTime,
  slotStart: z.iso.datetime(),
  slotEnd: z.iso.datetime(),
  totalUnits: z.number().int(),
  freeUnits: z.number().int(),
  bookable: z.boolean(),
});

/** Docs only: a booking as returned to clients (reservationSelect). */
export const reservationSchema = z.object({
  id: z.string(),
  code: z.string(),
  source: z.enum(["APP", "AGENT"]),
  branch: branchEnum,
  sector: sectorEnum,
  slotStart: z.iso.datetime(),
  slotEnd: z.iso.datetime(),
  partySize: z.number().int(),
  specialRequests: z.string().nullable(),
  status: z.enum(["CONFIRMED", "SEATED", "COMPLETED", "CANCELLED", "NO_SHOW"]),
  tableIds: z.array(z.string()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  cancelledAt: z.iso.datetime().nullable(),
});

export const RESERVATION_EXAMPLE = {
  id: "cm3k2x7a10002abcd1234efgh",
  code: "RSV-7K3Q9X",
  source: "APP",
  branch: "BRANCH_1",
  sector: "MAIN_HALL",
  slotStart: "2026-11-20T12:30:00.000Z",
  slotEnd: "2026-11-20T15:00:00.000Z",
  partySize: 4,
  specialRequests: "Window seat, please",
  status: "CONFIRMED",
  tableIds: ["B1-MH-01", "B1-MH-02"],
  createdAt: "2026-11-04T09:00:00.000Z",
  updatedAt: "2026-11-04T09:00:00.000Z",
  cancelledAt: null,
};
const CREATE_EXAMPLE = { branch: "BRANCH_1", sector: "MAIN_HALL", date: "2026-11-20", startTime: "19:30", partySize: 4, specialRequests: "Window seat, please" };

/** The booking 400 messages shared with the assistant's route (API_SPEC.md §3). */
export const BOOKING_ERRORS = [
  "startTime: startTime must be one of 11:00, 13:30, 17:00, 19:30",
  "partySize: Party size must be between 1 and 50",
  "Selected slot is in the past or too far ahead",
  "Insufficient capacity for the selected slot",
  "Table overlap conflict, please try again",
];
const CHANGE_BOOKING_ERRORS = ["Only confirmed reservations can be changed", "Reservation slot has already started"];
const NOT_FOUND = { 404: ["Reservation not found"] };
const GUEST_ERRORS = { ...SIGN_IN_ERRORS, 403: [FORBIDDEN_ERROR] };

registry.registerPath({
  method: "get",
  path: "/api/public/availabilities",
  tags: ["Public"],
  summary: "Free tables or rooms per sitting on one day",
  description: "Anyone may call it, including the AI assistant. One entry per sitting (11:00, 13:30, 17:00, 19:30). `freeUnits` counts free two-seat tables (Main Hall) or 13-seat rooms (VIP). `bookable` is false once a sitting has started or when it is more than 60 days ahead.",
  request: { query: availabilityQuery },
  responses: {
    200: jsonResponse("The four sittings.", z.array(slotSchema), [{ startTime: "19:30", slotStart: "2026-11-20T12:30:00.000Z", slotEnd: "2026-11-20T15:00:00.000Z", totalUnits: 50, freeUnits: 47, bookable: true }]),
    ...errorResponses({ 400: ["date: Expected date as YYYY-MM-DD", 'branch: Invalid option: expected one of "BRANCH_1"|"BRANCH_2"'] }),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/users/reservations",
  tags: ["Users"],
  security: SESSION_SECURITY,
  summary: "My bookings",
  description: "Signed-in guests only (admins get 403). The caller's own bookings, latest sitting first, including cancelled ones.",
  responses: { 200: jsonResponse("The caller's bookings.", z.array(reservationSchema), [RESERVATION_EXAMPLE]), ...errorResponses(GUEST_ERRORS) },
});

registry.registerPath({
  method: "get",
  path: "/api/users/reservations/{id}",
  tags: ["Users"],
  security: SESSION_SECURITY,
  summary: "One of my bookings",
  description: "Signed-in guests only. Someone else's booking answers 404, the same as a missing one, so ids can't be probed.",
  request: { params: idParams },
  responses: { 200: jsonResponse("The booking.", reservationSchema, RESERVATION_EXAMPLE), ...errorResponses(GUEST_ERRORS, NOT_FOUND) },
});

registry.registerPath({
  method: "post",
  path: "/api/users/reservations",
  tags: ["Users"],
  security: SESSION_SECURITY,
  summary: "Book a table",
  description:
    "Signed-in guests only (admins can't book: 403). Picks free tables (Main Hall joins one two-seat table per two guests; VIP takes one to four 13-seat rooms) in one transaction. Writes a `CREATE_RESERVATION` audit row and a `RESERVATION_CREATED` line in app.log, and sends a confirmation.",
  request: { body: jsonBody(createSchema, CREATE_EXAMPLE) },
  responses: { 201: jsonResponse("Booked.", reservationSchema, RESERVATION_EXAMPLE), ...errorResponses(GUEST_ERRORS, CHANGE_ERRORS, { 400: BOOKING_ERRORS }) },
});

registry.registerPath({
  method: "patch",
  path: "/api/users/reservations/{id}",
  tags: ["Users"],
  security: SESSION_SECURITY,
  summary: "Change the time (and party size) of my booking",
  description:
    "Signed-in guests only; confirmed bookings whose sitting hasn't started. The old tables are released and new ones taken in one transaction, so a full new time keeps the original booking. Writes a `RESCHEDULE_RESERVATION` audit row and a `RESERVATION_RESCHEDULED` line in app.log.",
  request: { params: idParams, body: jsonBody(rescheduleSchema, { date: "2026-11-21", startTime: "17:00", partySize: 2 }) },
  responses: {
    200: jsonResponse("The changed booking.", reservationSchema, { ...RESERVATION_EXAMPLE, slotStart: "2026-11-21T10:00:00.000Z", slotEnd: "2026-11-21T12:30:00.000Z", partySize: 2, tableIds: ["B1-MH-01"] }),
    ...errorResponses(GUEST_ERRORS, CHANGE_ERRORS, { 400: [...BOOKING_ERRORS, ...CHANGE_BOOKING_ERRORS] }, NOT_FOUND),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/users/reservations/{id}",
  tags: ["Users"],
  security: SESSION_SECURITY,
  summary: "Cancel my booking",
  description: "Signed-in guests only; confirmed bookings whose sitting hasn't started. The booking is kept and marked `CANCELLED`; its tables are freed. Writes a `CANCEL_RESERVATION` audit row and a `RESERVATION_CANCELLED` line in app.log.",
  request: { params: idParams },
  responses: {
    200: jsonResponse("The cancelled booking.", reservationSchema, { ...RESERVATION_EXAMPLE, status: "CANCELLED", cancelledAt: "2026-11-05T08:00:00.000Z" }),
    ...errorResponses(GUEST_ERRORS, CHANGE_ERRORS, { 400: CHANGE_BOOKING_ERRORS }, NOT_FOUND),
  },
});

availabilityRouter.get("/", async (req, res) => {
  const { branch, sector, date } = parse(availabilityQuery, req.query);
  res.json(await availability(branch, sector, date, SLOT_START_TIMES));
});

reservationsRouter.use(requirePermission("reservations:own"));

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
    where: { userId: currentUser(req).userId },
    select: reservationSelect,
    orderBy: { slotStart: "desc" },
  });
  res.json(reservations);
});

reservationsRouter.get("/:id", async (req, res) => {
  res.json(await findOwned(currentUser(req).userId, req.params.id));
});

reservationsRouter.post("/", async (req, res) => {
  const user = currentUser(req);
  const input = parse(createSchema, req.body);
  const reservation = await bookReservation(input, { userId: user.userId, createdById: user.userId, source: "APP" });

  await audit(req, "CREATE_RESERVATION", { resourceId: reservation.id, metadata: { source: "APP" } });
  logChange(req, { status: 201, action: "RESERVATION_CREATED", resourceId: reservation.code });
  const { email } = await prisma.user.findUniqueOrThrow({ where: { id: user.userId }, select: { email: true } });
  await notify(email, "Booking confirmed", `Reservation ${reservation.code} at ${reservation.slotStart.toISOString()}`);
  res.status(201).json(reservation);
});

/** Reschedule: old tables are released and new ones taken in one transaction, so failure keeps the old booking. */
reservationsRouter.patch("/:id", async (req, res) => {
  const user = currentUser(req);
  const existing = await findOwned(user.userId, req.params.id);
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
  logChange(req, { status: 200, action: "RESERVATION_RESCHEDULED", resourceId: reservation.code });
  res.json(reservation);
});

/** Soft cancel: keeps the record, frees the tables. */
reservationsRouter.delete("/:id", async (req, res) => {
  const existing = await findOwned(currentUser(req).userId, req.params.id);
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
  logChange(req, { status: 200, action: "RESERVATION_CANCELLED", resourceId: reservation.code });
  res.json(reservation);
});
