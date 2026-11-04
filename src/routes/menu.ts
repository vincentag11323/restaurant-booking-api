import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { FORBIDDEN_ERROR, SESSION_SECURITY, SIGN_IN_ERRORS, errorResponses, jsonResponse, registry } from "../lib/openApi.js";
import { parse } from "../lib/validate.js";
import { currentUser, requirePermission } from "../middleware/auth.js";

/** Public: GET /api/public/menus. */
export const menuRouter = Router();
/** Signed-in guests: GET /api/users/menus/recommendations. */
export const recommendationsRouter = Router();

const menuQuery = z.object({ type: z.enum(["SEASONAL_FINE_DINING", "A_LA_CARTE"]).optional() });

/** Docs only: one dish. */
export const menuItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.enum(["SEASONAL_FINE_DINING", "A_LA_CARTE"]),
  priceCents: z.number().int(),
  allergens: z.array(z.string()),
  chefPick: z.boolean(),
});
const DISH_EXAMPLE = { id: "cm3k2x7a10001abcd1234efgh", name: "Beef Steak", description: "Grain-fed sirloin, peppercorn sauce, hand-cut fries.", type: "A_LA_CARTE", priceCents: 28_500_000, allergens: ["dairy"], chefPick: true };

registry.registerPath({
  method: "get",
  path: "/api/public/menus",
  tags: ["Public"],
  summary: "The menu",
  description: "Anyone may call it. All dishes, or only one menu with `?type=`. Sorted by menu, then name.",
  request: { query: menuQuery },
  responses: {
    200: jsonResponse("The dishes.", z.array(menuItemSchema), [DISH_EXAMPLE]),
    ...errorResponses({ 400: ['type: Invalid option: expected one of "SEASONAL_FINE_DINING"|"A_LA_CARTE"'] }),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/users/menus/recommendations",
  tags: ["Users"],
  security: SESSION_SECURITY,
  summary: "Dishes that are safe for my allergies",
  description: "Signed-in guests only (admins get 403). Every dish without the guest's allergens, chef's picks first.",
  responses: { 200: jsonResponse("Allergy-safe dishes.", z.array(menuItemSchema), [DISH_EXAMPLE]), ...errorResponses(SIGN_IN_ERRORS, { 403: [FORBIDDEN_ERROR] }) },
});

menuRouter.get("/", async (req, res) => {
  const { type } = parse(menuQuery, req.query);
  res.json(await prisma.menuItem.findMany({ where: { type }, orderBy: [{ type: "asc" }, { name: "asc" }] }));
});

/** v1 "recommendations": allergy-safe dishes, chef's picks first. */
recommendationsRouter.get("/", requirePermission("menu:recommendations"), async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: currentUser(req).userId } });
  const allergies = new Set(user.allergies.map((a) => a.toLowerCase()));
  const items = await prisma.menuItem.findMany({ orderBy: [{ chefPick: "desc" }, { name: "asc" }] });
  res.json(items.filter((item) => !item.allergens.some((a) => allergies.has(a.toLowerCase()))));
});
