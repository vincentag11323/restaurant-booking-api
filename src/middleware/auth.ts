import type { NextFunction, Request, Response } from "express";
import type { Role } from "../generated/prisma/enums.js";
import { HttpError } from "../lib/errors.js";
import { type AuthUser, verifyAccessToken } from "../lib/tokens.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.get("authorization");
  if (!header?.startsWith("Bearer ")) throw new HttpError(401, "Authentication required");
  try {
    req.user = verifyAccessToken(header.slice("Bearer ".length));
  } catch {
    throw new HttpError(401, "Invalid or expired token");
  }
  next();
}

export function requireRole(role: Role) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (currentUser(req).role !== role) throw new HttpError(403, "Forbidden");
    next();
  };
}

/** Use after requireAuth; narrows req.user to non-null. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, "Authentication required");
  return req.user;
}
