import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/errors.js";
import { type Permission, can } from "../lib/permissions.js";
import { type AuthUser, verifyAccessToken } from "../lib/tokens.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** Authenticates the bearer token, then checks the role grants the permission (401 without a valid token, 403 without the permission). */
export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.get("authorization");
    if (!header?.startsWith("Bearer ")) throw new HttpError(401, "Authentication required");
    try {
      req.user = verifyAccessToken(header.slice("Bearer ".length));
    } catch {
      throw new HttpError(401, "Invalid or expired token");
    }
    if (!can(req.user.role, permission)) throw new HttpError(403, "Forbidden");
    next();
  };
}

/** Use after requirePermission; narrows req.user to non-null. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, "Authentication required");
  return req.user;
}
