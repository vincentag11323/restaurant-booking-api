import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { SLOT_START_TIMES, localDayRange, todayLocal } from "../domain/slots.js";
import { reservationSelect } from "../domain/reservations.js";
import type { Prisma } from "../generated/prisma/client.js";
import { audit, securityAlert } from "../lib/audit.js";
import { prisma } from "../lib/db.js";
import { notFound } from "../lib/errors.js";
import { ADMIN_ERRORS, SESSION_SECURITY, errorResponses, jsonResponse, registry } from "../lib/openApi.js";
import { branchEnum, dateString, parse, sectorEnum, statusEnum } from "../lib/validate.js";
import { currentUser, requirePermission } from "../middleware/auth.js";
import { RESERVATION_EXAMPLE, idParams, reservationSchema } from "./reservations.js";

/** Read-only by design (PRD v1): only GET routes live here. */
export const adminRouter = Router();
adminRouter.use(requirePermission("admin:read"));

const EXPORT_ROW_CAP = 10_000;
const BULK_EXPORT_ALERT_ROWS = 1_000;

const filtersSchema = z.object({
  branch: branchEnum.optional(),
  sector: sectorEnum.optional(),
  status: statusEnum.optional(),
  source: z.enum(["APP", "AGENT"]).optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

const listSchema = filtersSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const adminReservationSelect = {
  ...reservationSelect,
  user: { select: { name: true, email: true, phone: true } },
} satisfies Prisma.ReservationSelect;

/** No default here: "today" must be worked out per request, not once at start-up. */
const statsQuery = z.object({ date: dateString.optional(), branch: branchEnum.optional() });
const exportQuery = filtersSchema.extend({ format: z.enum(["csv", "json"]).default("csv") });

/** Docs only: the response shapes. */
export const adminReservationSchema = reservationSchema.extend({
  customer: z.object({ name: z.string(), email: z.string(), phone: z.string().nullable() }),
});
export const adminReservationPageSchema = z.object({ items: z.array(adminReservationSchema), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() });
export const statsSchema = z.object({
  date: z.string(),
  totalBookings: z.number().int(),
  agentBookings: z.number().int(),
  totalCovers: z.number().int(),
  cancellations: z.number().int(),
  utilization: z.array(z.object({ sector: sectorEnum, usedUnits: z.number().int(), capacityUnits: z.number().int(), rate: z.number() })),
});
const ADMIN_RESERVATION_EXAMPLE = { ...RESERVATION_EXAMPLE, customer: { name: "Ayu Lestari", email: "ayu@example.com", phone: "+62 811 0000 001" } };
const ADMIN_400 = { 400: ["date: Expected date as YYYY-MM-DD"] };

registry.registerPath({
  method: "get",
  path: "/api/admins/stats",
  tags: ["Admins"],
  security: SESSION_SECURITY,
  summary: "Numbers for one day",
  description: "Admins only. Bookings, assistant bookings, covers, cancellations and table use for one restaurant-local date (default today), for one branch or both.",
  request: { query: statsQuery },
  responses: {
    200: jsonResponse("The day's numbers.", statsSchema, {
      date: "2026-11-20",
      totalBookings: 12,
      agentBookings: 3,
      totalCovers: 41,
      cancellations: 1,
      utilization: [{ sector: "MAIN_HALL", usedUnits: 30, capacityUnits: 400, rate: 0.075 }, { sector: "VIP_WING", usedUnits: 2, capacityUnits: 32, rate: 0.0625 }],
    }),
    ...errorResponses(ADMIN_ERRORS, ADMIN_400),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/admins/reservations",
  tags: ["Admins"],
  security: SESSION_SECURITY,
  summary: "Search the booking log",
  description: "Admins only, read-only. Filters by branch, sector, status, source, local date range and `q` (a booking code exactly, or part of a name, email or phone). Latest sitting first, 20 per page by default (at most 100).",
  request: { query: listSchema },
  responses: {
    200: jsonResponse("One page of bookings with their customers.", adminReservationPageSchema, { items: [ADMIN_RESERVATION_EXAMPLE], total: 1, page: 1, pageSize: 20 }),
    ...errorResponses(ADMIN_ERRORS, { 400: ["pageSize: Too big: expected number to be <=100"] }),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/admins/reservations/export",
  tags: ["Admins"],
  security: SESSION_SECURITY,
  summary: "Download the booking log",
  description:
    "Admins only. The same filters as the search, as a CSV (default) or JSON file, at most 10,000 rows. CSV cells starting with `=`, `+`, `-` or `@` get a `'` in front so spreadsheets don't run them. Writes an `EXPORT_RESERVATIONS` audit row, and a `SECURITY_ALERT` when more than 1,000 rows are exported.",
  request: { query: exportQuery },
  responses: {
    200: {
      description: "A file download (`Content-Disposition: attachment`).",
      content: {
        "text/csv": { schema: z.string(), example: "code,status,branch,sector,slotStart,slotEnd,partySize,tableIds,customerName,customerEmail,customerPhone,specialRequests,createdAt,cancelledAt,source\n" },
        "application/json": { schema: z.array(adminReservationSchema), example: [ADMIN_RESERVATION_EXAMPLE] },
      },
    },
    ...errorResponses(ADMIN_ERRORS, ADMIN_400),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/admins/reservations/{id}",
  tags: ["Admins"],
  security: SESSION_SECURITY,
  summary: "One booking with its customer",
  description: "Admins only. Writes a `VIEW_RESERVATION_DETAIL` audit row.",
  request: { params: idParams },
  responses: { 200: jsonResponse("The booking.", adminReservationSchema, ADMIN_RESERVATION_EXAMPLE), ...errorResponses(ADMIN_ERRORS, { 404: ["Reservation not found"] }) },
});

type Filters = z.infer<typeof filtersSchema>;

function buildWhere({ branch, sector, status, source, from, to, q }: Filters): Prisma.ReservationWhereInput {
  const where: Prisma.ReservationWhereInput = { branch, sector, status, source };
  if (from || to) {
    const range = localDayRange(from ?? "1970-01-01", to ?? "9999-12-30", config.utcOffset);
    where.slotStart = { gte: range.start, lt: range.end };
  }
  if (q) {
    where.OR = [
      { code: q.toUpperCase() },
      { user: { name: { contains: q, mode: "insensitive" } } },
      { user: { email: { contains: q, mode: "insensitive" } } },
      { user: { phone: { contains: q } } },
    ];
  }
  return where;
}

type AdminRow = Prisma.ReservationGetPayload<{ select: typeof adminReservationSelect }>;

function toAdminReservation({ user, ...reservation }: AdminRow) {
  return { ...reservation, customer: user };
}

function findAll(filters: Filters, take?: number, skip?: number) {
  return prisma.reservation.findMany({
    where: buildWhere(filters),
    select: adminReservationSelect,
    orderBy: { slotStart: "desc" },
    take,
    skip,
  });
}

adminRouter.get("/stats", async (req, res) => {
  const query = parse(statsQuery, req.query);
  const { branch } = query;
  const date = query.date ?? todayLocal(config.utcOffset);
  const { start, end } = localDayRange(date, date, config.utcOffset);
  const onDate = { branch, slotStart: { gte: start, lt: end } };

  const [active, agentBookings, cancellations, tablesBySector] = await Promise.all([
    prisma.reservation.aggregate({ where: { ...onDate, status: { not: "CANCELLED" } }, _count: true, _sum: { partySize: true } }),
    prisma.reservation.count({ where: { ...onDate, status: { not: "CANCELLED" }, source: "AGENT" } }),
    prisma.reservation.count({ where: { ...onDate, status: "CANCELLED" } }),
    // Enum order: MAIN_HALL, then VIP_WING.
    prisma.diningTable.groupBy({ by: ["sector"], where: { branch }, _count: true, orderBy: { sector: "asc" } }),
  ]);
  // Built from the sectors that have tables, so capacity is never zero.
  const utilization = await Promise.all(
    tablesBySector.map(async ({ sector, _count: tables }) => {
      const usedUnits = await prisma.reservationTable.count({ where: { slotStart: { gte: start, lt: end }, table: { sector, branch } } });
      const capacityUnits = tables * SLOT_START_TIMES.length;
      return { sector, usedUnits, capacityUnits, rate: usedUnits / capacityUnits };
    }),
  );

  res.json({
    date,
    totalBookings: active._count,
    agentBookings,
    totalCovers: active._sum.partySize ?? 0,
    cancellations,
    utilization,
  });
});

adminRouter.get("/reservations", async (req, res) => {
  const { page, pageSize, ...filters } = parse(listSchema, req.query);
  const [rows, total] = await Promise.all([
    findAll(filters, pageSize, (page - 1) * pageSize),
    prisma.reservation.count({ where: buildWhere(filters) }),
  ]);
  res.json({ items: rows.map(toAdminReservation), total, page, pageSize });
});

const CSV_COLUMNS = [
  "code", "status", "branch", "sector", "slotStart", "slotEnd", "partySize", "tableIds",
  "customerName", "customerEmail", "customerPhone", "specialRequests", "createdAt", "cancelledAt", "source",
] as const;

function csvCell(value: unknown): string {
  if (value == null) return "";
  const text = value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join(" ") : String(value);
  // Quote when needed; prefix formula-like cells so spreadsheets don't execute them.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function toCsv(rows: AdminRow[]): string {
  const lines = rows.map((r) =>
    [
      r.code, r.status, r.branch, r.sector, r.slotStart, r.slotEnd, r.partySize, r.tableIds,
      r.user.name, r.user.email, r.user.phone, r.specialRequests, r.createdAt, r.cancelledAt, r.source,
    ].map(csvCell).join(","),
  );
  return [CSV_COLUMNS.join(","), ...lines].join("\n") + "\n";
}

adminRouter.get("/reservations/export", async (req, res) => {
  const { format, ...filters } = parse(exportQuery, req.query);
  const rows = await findAll(filters, EXPORT_ROW_CAP);

  await audit(req, "EXPORT_RESERVATIONS", { metadata: { rows: rows.length, format, filters } });
  if (rows.length > BULK_EXPORT_ALERT_ROWS) {
    await securityAlert(req, "Bulk booking export", { rows: rows.length, adminId: currentUser(req).userId });
  }

  const filename = `reservations-${todayLocal(config.utcOffset)}.${format}`;
  res.attachment(filename);
  if (format === "csv") {
    res.type("text/csv").send(toCsv(rows));
  } else {
    res.json(rows.map(toAdminReservation));
  }
});

adminRouter.get("/reservations/:id", async (req, res) => {
  const row = await prisma.reservation.findUnique({ where: { id: req.params.id }, select: adminReservationSelect });
  if (!row) throw notFound();
  await audit(req, "VIEW_RESERVATION_DETAIL", { resourceId: row.id });
  res.json(toAdminReservation(row));
});
