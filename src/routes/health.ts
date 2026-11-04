import { Router } from "express";
import { z } from "zod";
import { jsonResponse, registry } from "../lib/openApi.js";

/** GET /api/public/health */
export const healthRouter = Router();

export const healthSchema = z.object({ status: z.literal("ok") });

registry.registerPath({
  method: "get",
  path: "/api/public/health",
  tags: ["Public"],
  summary: "Is the API up?",
  description: "Anyone may call it. Answers `ok` while the API is running; reads nothing.",
  responses: { 200: jsonResponse("The API is running.", healthSchema, { status: "ok" }) },
});

healthRouter.get("/", (_req, res) => {
  res.json({ status: "ok" });
});
