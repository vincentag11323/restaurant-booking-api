// One auth check per route group (api_spec.md, "Route groups"). Each check reads only its own credential
// and passes { userId, role } to the route in req.auth; routes never read identity from the body or query.
import type { NextFunction, Request, Response } from "express";
import type { Role } from "../generated/prisma/enums.js";
import { prisma } from "../lib/db.js";
import { HttpError } from "../lib/errors.js";
import { type Permission, can } from "../lib/permissions.js";
import { SESSION_COOKIE, sha256Hex } from "../lib/tokens.js";

export interface AuthContext {
  userId: string;
  role: Role;
  /** Set for cookie sign-ins, not for the assistant's key. */
  sessionId?: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/** /api/users and /api/admins: the `session` cookie only. The role is read from the user row, so a change applies at once. */
export async function requireSession(req: Request, _res: Response, next: NextFunction) {
  const token: unknown = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== "string") throw new HttpError(401, "Authentication required");
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256Hex(token) },
    select: { id: true, expiresAt: true, user: { select: { id: true, role: true } } },
  });
  if (!session || session.expiresAt <= new Date()) throw new HttpError(401, "Invalid or expired token");
  req.auth = { userId: session.user.id, role: session.user.role, sessionId: session.id };
  next();
}

/** /api/admins: after requireSession. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (currentUser(req).role !== "ADMIN") throw new HttpError(403, "Forbidden");
  next();
}

/** /api/agents: the X-Agent-Key header only; the key's owner must be the AGENT account. */
export async function requireAgentKey(req: Request, _res: Response, next: NextFunction) {
  const key = req.get("x-agent-key");
  if (!key) throw new HttpError(401, "Authentication required");
  const apiKey = await prisma.apiKey.findUnique({ where: { keyHash: sha256Hex(key) }, select: { user: { select: { id: true, role: true } } } });
  if (apiKey?.user.role !== "AGENT") throw new HttpError(401, "Invalid API key");
  req.auth = { userId: apiKey.user.id, role: "AGENT" };
  next();
}

/** Second RBAC layer, per route: the group middleware has already signed the caller in. */
export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!can(currentUser(req).role, permission)) throw new HttpError(403, "Forbidden");
    next();
  };
}

/** The caller set by the group middleware. */
export function currentUser(req: Request): AuthContext {
  if (!req.auth) throw new HttpError(401, "Authentication required");
  return req.auth;
}
