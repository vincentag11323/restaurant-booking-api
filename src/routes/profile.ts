import { Router } from "express";
import { z } from "zod";
import type { User } from "../generated/prisma/client.js";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/db.js";
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

profileRouter.get("/", requirePermission("profile:own"), async (req, res) => {
  // Deleting a user deletes their sessions (cascade), so a signed-in caller's row always exists.
  const user = await prisma.user.findUniqueOrThrow({ where: { id: currentUser(req).id } });
  res.json(publicUser(user));
});

profileRouter.patch("/", requirePermission("profile:own"), async (req, res) => {
  const input = parse(updateProfileSchema, req.body);
  const user = await prisma.user.update({ where: { id: currentUser(req).id }, data: input });
  await audit(req, "UPDATE_PROFILE", { resourceId: user.id, metadata: { fields: Object.keys(input) } });
  res.json(publicUser(user));
});
