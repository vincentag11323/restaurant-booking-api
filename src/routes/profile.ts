import { Router } from "express";
import { z } from "zod";
import type { User } from "../generated/prisma/client.js";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/db.js";
import { logChange } from "../lib/logs.js";
import { CHANGE_ERRORS, SESSION_SECURITY, SIGN_IN_ERRORS, errorResponses, jsonBody, jsonResponse, registry } from "../lib/openApi.js";
import { parse } from "../lib/validate.js";
import { currentUser, requirePermission } from "../middleware/auth.js";

export const profileRouter = Router();

export function publicUser(user: Pick<User, "id" | "email" | "name" | "phone" | "allergies" | "role">) {
  return { id: user.id, email: user.email, name: user.name, phone: user.phone, allergies: user.allergies, role: user.role };
}

const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().regex(/^\+?[0-9 -]{6,20}$/, "Invalid phone number").nullable().optional(),
  allergies: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20).optional(),
});

/** Docs only: what publicUser() returns. */
export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  allergies: z.array(z.string()),
  role: z.enum(["USER", "ADMIN", "AGENT"]),
});
export const USER_EXAMPLE = { id: "cm3k2x7a10000abcd1234efgh", email: "ayu@example.com", name: "Ayu Lestari", phone: "+62 811 0000 001", allergies: ["fish"], role: "USER" };

registry.registerPath({
  method: "get",
  path: "/api/users/me",
  tags: ["Users"],
  security: SESSION_SECURITY,
  summary: "My profile",
  description: "Any signed-in guest or admin. Returns the caller's own profile; never a password or hash.",
  responses: { 200: jsonResponse("The caller's profile.", userSchema, USER_EXAMPLE), ...errorResponses(SIGN_IN_ERRORS) },
});

registry.registerPath({
  method: "patch",
  path: "/api/users/me",
  tags: ["Users"],
  security: SESSION_SECURITY,
  summary: "Change my name, phone or allergies",
  description: "Any signed-in guest or admin. Send only the fields to change; `phone: null` clears it. Allergies are saved as lowercase tags. Writes an `UPDATE_PROFILE` audit row and a `PROFILE_UPDATED` line in app.log.",
  request: { body: jsonBody(updateProfileSchema, { allergies: ["Gluten", "shellfish"], phone: null }) },
  responses: {
    200: jsonResponse("The updated profile.", userSchema, { ...USER_EXAMPLE, phone: null, allergies: ["gluten", "shellfish"] }),
    ...errorResponses(SIGN_IN_ERRORS, CHANGE_ERRORS, { 400: ["phone: Invalid phone number"] }),
  },
});

profileRouter.get("/", requirePermission("profile:own"), async (req, res) => {
  // Deleting a user deletes their sessions (cascade), so a signed-in caller's row always exists.
  const user = await prisma.user.findUniqueOrThrow({ where: { id: currentUser(req).userId } });
  res.json(publicUser(user));
});

profileRouter.patch("/", requirePermission("profile:own"), async (req, res) => {
  const input = parse(updateProfileSchema, req.body);
  const user = await prisma.user.update({ where: { id: currentUser(req).userId }, data: input });
  await audit(req, "UPDATE_PROFILE", { resourceId: user.id, metadata: { fields: Object.keys(input) } });
  logChange(req, { status: 200, action: "PROFILE_UPDATED", resourceId: user.id });
  res.json(publicUser(user));
});
