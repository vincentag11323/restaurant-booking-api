import bcrypt from "bcryptjs";
import { type Response, Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import type { Role } from "../generated/prisma/enums.js";
import { audit, checkFailedLogins } from "../lib/audit.js";
import { prisma } from "../lib/db.js";
import { HttpError, badRequest } from "../lib/errors.js";
import { REFRESH_TOKEN_TTL_MS, signAccessToken, signRefreshToken, verifyRefreshToken } from "../lib/tokens.js";
import { parse } from "../lib/validate.js";
import { publicUser } from "./profile.js";

export const authRouter = Router();

const REFRESH_COOKIE = "refreshToken";
const BCRYPT_COST = 12;
// Compared against when the email is unknown, so both failure paths take the same bcrypt time.
const DUMMY_HASH = bcrypt.hashSync("timing-equaliser", BCRYPT_COST);

const registerSchema = z.object({
  email: z.email().max(254).transform((e) => e.toLowerCase()),
  password: z.string().min(8, "Password must be at least 8 characters").max(72),
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().regex(/^\+?[0-9 -]{6,20}$/, "Invalid phone number").optional(),
});

const loginSchema = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  password: z.string().min(1),
});

function issueTokens(res: Response, user: { id: string; role: Role }) {
  res.cookie(REFRESH_COOKIE, signRefreshToken(user.id), {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProduction,
    maxAge: REFRESH_TOKEN_TTL_MS,
    path: "/api/auth",
  });
  return signAccessToken(user);
}

authRouter.post("/register", async (req, res) => {
  const input = parse(registerSchema, req.body);
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  // A password-less guest account (created by the assistant) is claimed by signing up with its email.
  const claimable = existing?.role === "USER" && existing.passwordHash === null;
  if (existing && !claimable) throw badRequest("Email is already registered");

  const data = { name: input.name, phone: input.phone, passwordHash: await bcrypt.hash(input.password, BCRYPT_COST) };
  const user = claimable
    ? await prisma.user.update({ where: { id: existing.id }, data })
    : await prisma.user.create({ data: { ...data, email: input.email } });
  await audit(req, "REGISTER", { actorId: user.id, resourceId: user.id, metadata: { claimedGuestAccount: claimable } });
  res.status(201).json({ accessToken: issueTokens(res, user), user: publicUser(user) });
});

authRouter.post("/login", async (req, res) => {
  const input = parse(loginSchema, req.body);
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  // Unknown email, unclaimed guest account and wrong password all take the same time and give the same answer.
  const passwordOk = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user?.passwordHash || !passwordOk) {
    await audit(req, "LOGIN_FAILED", { actorId: null, metadata: { email: input.email } });
    await checkFailedLogins(req);
    throw new HttpError(401, "Invalid email or password");
  }
  await audit(req, "LOGIN_SUCCESS", { actorId: user.id });
  res.json({ accessToken: issueTokens(res, user), user: publicUser(user) });
});

authRouter.post("/refresh", async (req, res) => {
  const token: unknown = req.cookies?.[REFRESH_COOKIE];
  let userId: string;
  try {
    if (typeof token !== "string") throw new Error("missing");
    userId = verifyRefreshToken(token);
  } catch {
    throw new HttpError(401, "Invalid or expired refresh token");
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new HttpError(401, "Invalid or expired refresh token");
  res.json({ accessToken: issueTokens(res, user), user: publicUser(user) });
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(REFRESH_COOKIE, { path: "/api/auth" });
  res.json({ message: "Logged out" });
});
