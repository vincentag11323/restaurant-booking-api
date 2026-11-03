import type { Request } from "express";
import { prisma } from "./db.js";

export type AuditAction =
  | "REGISTER"
  | "LOGIN_SUCCESS"
  | "LOGIN_FAILED"
  | "UPDATE_PROFILE"
  | "CREATE_RESERVATION"
  | "RESCHEDULE_RESERVATION"
  | "CANCEL_RESERVATION"
  | "VIEW_RESERVATION_DETAIL"
  | "EXPORT_RESERVATIONS"
  | "SECURITY_ALERT";

export async function audit(
  req: Request,
  action: AuditAction,
  opts: { actorId?: string | null; resourceId?: string; metadata?: Record<string, unknown> } = {},
) {
  await prisma.auditLog.create({
    data: {
      action,
      actorId: opts.actorId ?? req.user?.id ?? null,
      resourceId: opts.resourceId,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
      metadata: opts.metadata as object | undefined,
    },
  });
}

export async function securityAlert(req: Request, reason: string, metadata: Record<string, unknown> = {}) {
  console.warn(`[SECURITY_ALERT] ${reason}`, metadata);
  await audit(req, "SECURITY_ALERT", { metadata: { reason, ...metadata } });
}

const FAILED_LOGIN_THRESHOLD = 10;
const FAILED_LOGIN_WINDOW_MS = 5 * 60_000;

/** Raises one alert per window once an IP reaches the failed-login threshold. */
export async function checkFailedLogins(req: Request) {
  const since = new Date(Date.now() - FAILED_LOGIN_WINDOW_MS);
  const [count, alreadyAlerted] = await Promise.all([
    prisma.auditLog.count({ where: { action: "LOGIN_FAILED", ipAddress: req.ip, timestamp: { gte: since } } }),
    prisma.auditLog.count({ where: { action: "SECURITY_ALERT", ipAddress: req.ip, timestamp: { gte: since } } }),
  ]);
  if (count >= FAILED_LOGIN_THRESHOLD && alreadyAlerted === 0) {
    await securityAlert(req, "Repeated failed logins from one IP", { ip: req.ip, count });
  }
}
