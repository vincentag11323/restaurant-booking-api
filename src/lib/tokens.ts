import { createHash, randomBytes } from "node:crypto";
import type { CookieOptions } from "express";
import { config } from "../config.js";

export const SESSION_COOKIE = "session";
export const sessionCookieOptions: CookieOptions = { httpOnly: true, sameSite: "lax", secure: config.isProduction, path: "/" };

/** A random 32-byte session token for the cookie; the Session table keeps only its SHA-256. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Secrets (session tokens, API keys) are stored only as this SHA-256 hex digest. */
export function sha256Hex(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
