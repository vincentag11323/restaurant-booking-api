import { Router } from "express";
import { z } from "zod";
import { bookReservation, reservationSelect } from "../domain/reservations.js";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/db.js";
import { badRequest } from "../lib/errors.js";
import { logChange } from "../lib/logs.js";
import { AGENT_KEY_ERRORS, AGENT_SECURITY, CHANGE_ERRORS, errorResponses, jsonBody, jsonResponse, registry } from "../lib/openApi.js";
import { notify } from "../lib/notify.js";
import { jsonRateLimit } from "../lib/rateLimit.js";
import { parse } from "../lib/validate.js";
import { currentUser, requirePermission } from "../middleware/auth.js";
import { BOOKING_ERRORS, RESERVATION_EXAMPLE, createSchema, reservationSchema } from "./reservations.js";

/** Routes for the AI booking assistant (role AGENT). Thin on purpose: booking reuses bookReservation(). */
export const agentRouter = Router();

/** Owner rules: 1 upcoming assistant booking until the email signs up, then 3; more looks like spam (AGENT_SPEC.md §5.4). */
const LIMIT_NOT_SIGNED_UP = 1;
const LIMIT_SIGNED_UP = 3;
const STAFF_EMAIL_MESSAGE = "This email can't be booked through the assistant";
const IDEMPOTENCY_REUSED_MESSAGE = "Idempotency-Key was already used for another booking";
const NOT_SIGNED_UP_MESSAGE = "This email already has a booking made with the assistant. To book a different time, sign up with this email in the app, cancel that booking there, then ask me again.";

function assistantBookingLimit(guest: { passwordHash: string | null } | null): number {
  return guest?.passwordHash ? LIMIT_SIGNED_UP : LIMIT_NOT_SIGNED_UP;
}

const emailSchema = z.email().max(254).transform((e) => e.toLowerCase());

const onBehalfSchema = createSchema.extend({
  email: emailSchema,
  phone: z.string().trim().regex(/^\+?[0-9 -]{6,20}$/, "Invalid phone number").optional(),
  clientIp: z.string().max(64).optional(),
});

const idempotencyKeySchema = z.string().min(8).max(200).optional();
const lookupSchema = z.object({ email: emailSchema });
const LOOKUP_LIMIT_MESSAGE = "Too many lookups. Please slow down.";

/** Docs only: what a lookup returns. */
export const lookupResultSchema = z.object({ exists: z.boolean(), upcomingAssistantBookings: z.number().int(), assistantBookingLimit: z.number().int() });

registry.registerPath({
  method: "post",
  path: "/api/agents/reservations",
  tags: ["Agents"],
  security: AGENT_SECURITY,
  summary: "Book for a guest by email",
  description:
    "The AI assistant only. Finds the guest by email, or creates a password-less guest account that sign-up can claim later. An email that hasn't signed up may hold 1 upcoming assistant booking; a signed-up guest 3. The same `Idempotency-Key` again returns the same booking (200) instead of a second one. Writes a `CREATE_RESERVATION` audit row, `GUEST_ACCOUNT_CREATED` (new email) and `RESERVATION_CREATED` lines in app.log, and notifies the guest.",
  request: {
    headers: z.object({ "Idempotency-Key": idempotencyKeySchema }),
    body: jsonBody(onBehalfSchema, { email: "ayu@example.com", phone: "+62 811 0000 001", branch: "BRANCH_1", sector: "MAIN_HALL", date: "2026-11-20", startTime: "19:30", partySize: 4, clientIp: "198.51.100.4" }),
  },
  responses: {
    201: jsonResponse("Booked.", reservationSchema, { ...RESERVATION_EXAMPLE, source: "AGENT", specialRequests: null }),
    200: jsonResponse("A retry with the same Idempotency-Key: the earlier booking.", reservationSchema, { ...RESERVATION_EXAMPLE, source: "AGENT", specialRequests: null }),
    ...errorResponses(AGENT_KEY_ERRORS, CHANGE_ERRORS, {
      400: [...BOOKING_ERRORS, NOT_SIGNED_UP_MESSAGE, `This email already has ${LIMIT_SIGNED_UP} upcoming assistant bookings. Sign in to manage them.`, STAFF_EMAIL_MESSAGE, IDEMPOTENCY_REUSED_MESSAGE],
    }),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/agents/guests/lookup",
  tags: ["Agents"],
  security: AGENT_SECURITY,
  summary: "Look up one guest by exact email",
  description:
    "The AI assistant only; 60 per minute. Says only whether the email has a guest account and how many upcoming assistant bookings it holds against its limit. Admin and assistant accounts show as not found. Writes a `VIEW_GUEST` audit row.",
  request: { body: jsonBody(lookupSchema, { email: "ayu@example.com" }) },
  responses: {
    200: jsonResponse("What the assistant may know.", lookupResultSchema, { exists: true, upcomingAssistantBookings: 1, assistantBookingLimit: 3 }),
    ...errorResponses(AGENT_KEY_ERRORS, CHANGE_ERRORS, { 400: ["email: Invalid email address"], 429: [LOOKUP_LIMIT_MESSAGE] }),
  },
});

function upcomingAssistantBookings(userId: string, db: Pick<typeof prisma, "reservation"> = prisma) {
  return db.reservation.count({
    where: { userId, source: "AGENT", status: "CONFIRMED", slotStart: { gt: new Date() } },
  });
}

agentRouter.post("/reservations", requirePermission("reservation:create_on_behalf"), async (req, res) => {
  const agent = currentUser(req);
  const { email, phone, clientIp, ...booking } = parse(onBehalfSchema, req.body);
  const idempotencyKey = parse(idempotencyKeySchema, req.get("idempotency-key"));

  if (idempotencyKey) {
    const earlier = await prisma.reservation.findUnique({ where: { idempotencyKey }, select: { ...reservationSelect, user: { select: { email: true } } } });
    if (earlier) {
      if (earlier.user.email !== email) throw badRequest(IDEMPOTENCY_REUSED_MESSAGE);
      const { user: _user, ...reservation } = earlier;
      res.status(200).json(reservation);
      return;
    }
  }

  // Password-less guest account: sign-up with this email claims it later (AGENT_SPEC.md D1).
  // INSERT ... ON CONFLICT DO NOTHING, then read: unlike upsert, this stays atomic when several
  // confirmations for a new email arrive at once (found on real PostgreSQL).
  const { count: created } = await prisma.user.createMany({ data: [{ email, phone, name: email.split("@")[0], passwordHash: null }], skipDuplicates: true });
  const guest = await prisma.user.findUniqueOrThrow({ where: { email } });
  if (created === 1) logChange(req, { status: 201, action: "GUEST_ACCOUNT_CREATED", resourceId: guest.id });
  if (guest.role !== "USER") throw badRequest(STAFF_EMAIL_MESSAGE);

  // The cap is checked inside the booking transaction while holding the guest's row lock, so simultaneous
  // confirmations for one email queue up instead of all reading the same count.
  const reservation = await bookReservation(booking, { userId: guest.id, createdById: agent.userId, source: "AGENT", idempotencyKey }, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${guest.id} FOR UPDATE`;
    const limit = assistantBookingLimit(guest);
    if ((await upcomingAssistantBookings(guest.id, tx)) >= limit) {
      throw badRequest(limit === LIMIT_SIGNED_UP ? `This email already has ${LIMIT_SIGNED_UP} upcoming assistant bookings. Sign in to manage them.` : NOT_SIGNED_UP_MESSAGE);
    }
  });
  await audit(req, "CREATE_RESERVATION", { resourceId: reservation.id, metadata: { source: "AGENT", onBehalfOf: guest.id, clientIp } });
  logChange(req, { status: 201, action: "RESERVATION_CREATED", resourceId: reservation.code });
  await notify(email, "Booking confirmed", `Reservation ${reservation.code} at ${reservation.slotStart.toISOString()}`);
  res.status(201).json(reservation);
});

const lookupLimiter = jsonRateLimit({ windowMs: 60_000, limit: 60, message: LOOKUP_LIMIT_MESSAGE });

/** One guest per request, exact email, minimal answer. Listing and searching are admin-only. */
agentRouter.post("/guests/lookup", requirePermission("guest:read_one"), lookupLimiter, async (req, res) => {
  const { email } = parse(lookupSchema, req.body);
  const found = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true, passwordHash: true } });
  const guest = found?.role === "USER" ? found : null;
  await audit(req, "VIEW_GUEST", { resourceId: found?.id, metadata: { found: Boolean(guest) } });
  res.json({
    exists: Boolean(guest),
    upcomingAssistantBookings: guest ? await upcomingAssistantBookings(guest.id) : 0,
    assistantBookingLimit: assistantBookingLimit(guest),
  });
});
