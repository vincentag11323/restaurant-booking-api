import bcrypt from "bcryptjs";
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { audit, checkFailedLogins } from "../lib/audit.js";
import { prisma } from "../lib/db.js";
import { HttpError, badRequest } from "../lib/errors.js";
import { logChange } from "../lib/logs.js";
import { CHANGE_ERRORS, RATE_LIMIT_ERROR, errorResponses, jsonBody, jsonResponse, registry } from "../lib/openApi.js";
import { SESSION_COOKIE, newSessionToken, sessionCookieOptions, sha256Hex } from "../lib/tokens.js";
import { parse } from "../lib/validate.js";
import { USER_EXAMPLE, publicUser, userSchema } from "./profile.js";

export const authRouter = Router();

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

/** Docs only: what sign-up and sign-in return. */
export const authResponseSchema = z.object({ user: userSchema });
/** Docs only: what sign-out returns. */
export const logoutSchema = z.object({ message: z.literal("Logged out") });

const AUTH_ERRORS = { 429: [RATE_LIMIT_ERROR] };
const SESSION_COOKIE_HEADER = {
  "Set-Cookie": { description: "`session=<random token>; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax` (plus `Secure` in production).", schema: { type: "string" as const } },
};

registry.registerPath({
  method: "post",
  path: "/api/auth/register",
  tags: ["Auth"],
  summary: "Sign up and sign in",
  description:
    "Anyone may call it. Creates a guest account and signs it in (sets the `session` cookie). Signing up with an email the AI assistant already booked for claims that password-less account and keeps its bookings. Writes a `REGISTER` audit row and `USER_CREATED` (or `USER_CLAIMED`) plus `SESSION_CREATED` lines in app.log.",
  request: { body: jsonBody(registerSchema, { email: "ayu@example.com", password: "Password123", name: "Ayu Lestari", phone: "+62 811 0000 001" }) },
  responses: {
    201: { ...jsonResponse("Signed up and signed in.", authResponseSchema, { user: USER_EXAMPLE }), headers: SESSION_COOKIE_HEADER },
    ...errorResponses({ 400: ["Email is already registered", "password: Password must be at least 8 characters", "phone: Invalid phone number"] }, CHANGE_ERRORS, AUTH_ERRORS),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/login",
  tags: ["Auth"],
  summary: "Sign in",
  description:
    "Anyone may call it. Checks the email and password and sets the `session` cookie, valid for 1 hour. Also deletes this person's sessions that had already run out. An unknown email, a wrong password and an account the assistant made but nobody signed up for all get the same 401. Writes `LOGIN_SUCCESS` or `LOGIN_FAILED` audit rows and `SESSION_CREATED` (and `SESSIONS_EXPIRED_DELETED`) lines in app.log.",
  request: { body: jsonBody(loginSchema, { email: "ayu@example.com", password: "Password123" }) },
  responses: {
    200: { ...jsonResponse("Signed in.", authResponseSchema, { user: USER_EXAMPLE }), headers: SESSION_COOKIE_HEADER },
    ...errorResponses({ 400: ["email: Invalid email address"], 401: ["Invalid email or password"] }, CHANGE_ERRORS, AUTH_ERRORS),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/logout",
  tags: ["Auth"],
  summary: "Sign out this browser",
  description:
    "Anyone may call it. Deletes this cookie's session, so the cookie and any saved copy stop working at once; other devices stay signed in. Clears the cookie. Works with no cookie or an old one. Writes `SESSION_DELETED` in app.log when a session was deleted.",
  responses: { 200: jsonResponse("Signed out.", logoutSchema, { message: "Logged out" }), ...errorResponses(CHANGE_ERRORS, AUTH_ERRORS) },
});

/**
 * Starts a session valid for SESSION_TTL from now, never extended: stores only the token's SHA-256 and
 * sets the cookie. Clears that user's expired rows on the way, so no cleanup job is needed.
 */
async function startSession(req: Request, res: Response, userId: string, status: number) {
  const now = new Date();
  const { count: expiredDeleted } = await prisma.session.deleteMany({ where: { userId, expiresAt: { lte: now } } });
  const token = newSessionToken();
  const session = await prisma.session.create({
    data: { tokenHash: sha256Hex(token), userId, expiresAt: new Date(now.getTime() + config.sessionTtlSeconds * 1000) },
    select: { id: true },
  });
  res.cookie(SESSION_COOKIE, token, { ...sessionCookieOptions, maxAge: config.sessionTtlSeconds * 1000 });
  if (expiredDeleted > 0) logChange(req, { status, action: "SESSIONS_EXPIRED_DELETED", count: expiredDeleted, userId });
  logChange(req, { status, action: "SESSION_CREATED", resourceId: session.id, userId });
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
  logChange(req, { status: 201, action: claimable ? "USER_CLAIMED" : "USER_CREATED", resourceId: user.id, userId: user.id });
  await startSession(req, res, user.id, 201);
  res.status(201).json({ user: publicUser(user) });
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
  await startSession(req, res, user.id, 200);
  res.json({ user: publicUser(user) });
});

/** Deletes this cookie's session (live or expired), so any copy of the cookie stops working. Other devices stay signed in. */
authRouter.post("/logout", async (req, res) => {
  const token: unknown = req.cookies?.[SESSION_COOKIE];
  if (typeof token === "string") {
    const session = await prisma.session.findUnique({ where: { tokenHash: sha256Hex(token) }, select: { id: true, userId: true } });
    if (session) {
      await prisma.session.deleteMany({ where: { id: session.id } });
      logChange(req, { status: 200, action: "SESSION_DELETED", resourceId: session.id, userId: session.userId });
    }
  }
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions);
  res.json({ message: "Logged out" });
});
