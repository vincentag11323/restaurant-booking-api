import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/db.js";
import { HttpError } from "../lib/errors.js";
import { type Permission, can } from "../lib/permissions.js";
import { type AuthUser, SESSION_COOKIE, sha256Hex, verifySessionToken } from "../lib/tokens.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** The assistant sends X-Agent-Key; guests and admins send the session cookie. Authorization is never read. */
async function authenticate(req: Request): Promise<AuthUser> {
  const apiKey = req.get("x-agent-key");
  if (apiKey !== undefined) {
    const key = await prisma.apiKey.findUnique({ where: { keyHash: sha256Hex(apiKey) }, select: { user: { select: { id: true, role: true } } } });
    if (key?.user.role !== "AGENT") throw new HttpError(401, "Invalid API key");
    return key.user;
  }
  const token: unknown = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== "string") throw new HttpError(401, "Authentication required");
  try {
    return verifySessionToken(token);
  } catch {
    throw new HttpError(401, "Invalid or expired token");
  }
}

/** Authenticates the caller, then checks the role grants the permission (401 without valid credentials, 403 without the permission). */
export function requirePermission(permission: Permission) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    req.user = await authenticate(req);
    if (!can(req.user.role, permission)) throw new HttpError(403, "Forbidden");
    next();
  };
}

/** Use after requirePermission; narrows req.user to non-null. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, "Authentication required");
  return req.user;
}
