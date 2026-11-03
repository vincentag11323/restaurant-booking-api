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

/** Raises an alert exactly when an IP hits the failed-login threshold within the window. */
export async function checkFailedLogins(req: Request) {
  const count = await prisma.auditLog.count({
    where: {
      action: "LOGIN_FAILED",
      ipAddress: req.ip,
      timestamp: { gte: new Date(Date.now() - FAILED_LOGIN_WINDOW_MS) },
    },
  });
  if (count === FAILED_LOGIN_THRESHOLD) {
    await securityAlert(req, "Repeated failed logins from one IP", { ip: req.ip, count });
  }
}
