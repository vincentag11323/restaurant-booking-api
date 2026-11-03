import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { SLOT_START_TIMES, localDayRange, todayLocal } from "../domain/slots.js";
import { reservationSelect } from "../domain/reservations.js";
import type { Prisma } from "../generated/prisma/client.js";
import { audit, securityAlert } from "../lib/audit.js";
import { prisma } from "../lib/db.js";
import { notFound } from "../lib/errors.js";
import { branchEnum, dateString, parse, sectorEnum, statusEnum } from "../lib/validate.js";
import { requirePermission } from "../middleware/auth.js";

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
  const { date, branch } = parse(
    z.object({ date: dateString.default(todayLocal(config.utcOffset)), branch: branchEnum.optional() }),
    req.query,
  );
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
  const { format, ...filters } = parse(filtersSchema.extend({ format: z.enum(["csv", "json"]).default("csv") }), req.query);
  const rows = await findAll(filters, EXPORT_ROW_CAP);

  await audit(req, "EXPORT_RESERVATIONS", { metadata: { rows: rows.length, format, filters } });
  if (rows.length > BULK_EXPORT_ALERT_ROWS) {
    await securityAlert(req, "Bulk booking export", { rows: rows.length, adminId: req.user?.id });
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
