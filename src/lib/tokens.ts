import { createHash } from "node:crypto";
import type { CookieOptions } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import type { Role } from "../generated/prisma/enums.js";

export const SESSION_COOKIE = "session";
export const sessionCookieOptions: CookieOptions = { httpOnly: true, sameSite: "lax", secure: config.isProduction, path: "/" };

export interface AuthUser {
  id: string;
  role: Role;
}

export function signSessionToken(user: AuthUser): string {
  return jwt.sign({ role: user.role }, config.sessionSecret, { subject: user.id, expiresIn: config.sessionTtlSeconds });
}

export function verifySessionToken(token: string): AuthUser {
  const payload = jwt.verify(token, config.sessionSecret, { algorithms: ["HS256"] }) as jwt.JwtPayload;
  return { id: payload.sub as string, role: payload.role as Role };
}

/** The agent API key is stored only as this SHA-256 hex digest (User.apiKeyHash). */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
