import jwt from "jsonwebtoken";
import { config } from "../config.js";
import type { Role } from "../generated/prisma/enums.js";

export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60_000;

export interface AuthUser {
  id: string;
  role: Role;
}

export function signAccessToken(user: AuthUser): string {
  return jwt.sign({ role: user.role }, config.jwtAccessSecret, { subject: user.id, expiresIn: config.accessTokenTtl });
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({}, config.jwtRefreshSecret, { subject: userId, expiresIn: REFRESH_TOKEN_TTL_MS / 1000 });
}

export function verifyAccessToken(token: string): AuthUser {
  const payload = jwt.verify(token, config.jwtAccessSecret) as jwt.JwtPayload;
  return { id: payload.sub as string, role: payload.role as Role };
}

export function verifyRefreshToken(token: string): string {
  const payload = jwt.verify(token, config.jwtRefreshSecret) as jwt.JwtPayload;
  return payload.sub as string;
}
