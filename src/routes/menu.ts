import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { parse } from "../lib/validate.js";
import { currentUser, requireAuth } from "../middleware/auth.js";

export const menuRouter = Router();

const menuQuery = z.object({ type: z.enum(["SEASONAL_FINE_DINING", "A_LA_CARTE"]).optional() });

menuRouter.get("/", async (req, res) => {
  const { type } = parse(menuQuery, req.query);
  res.json(await prisma.menuItem.findMany({ where: { type }, orderBy: [{ type: "asc" }, { name: "asc" }] }));
});

/** v1 "recommendations": allergy-safe dishes, chef's picks first. */
menuRouter.get("/recommendations", requireAuth, async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: currentUser(req).id } });
  const allergies = new Set(user.allergies.map((a) => a.toLowerCase()));
  const items = await prisma.menuItem.findMany({ orderBy: [{ chefPick: "desc" }, { name: "asc" }] });
  res.json(items.filter((item) => !item.allergens.some((a) => allergies.has(a.toLowerCase()))));
});
