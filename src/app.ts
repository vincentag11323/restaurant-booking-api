import cookieParser from "cookie-parser";
import cors from "cors";
import express, { Router } from "express";
import helmet from "helmet";
import { config } from "./config.js";
import { adminRouter } from "./routes/admin.js";
import { agentRouter } from "./routes/agent.js";
import { HttpError } from "./lib/errors.js";
import { RATE_LIMIT_ERROR } from "./lib/openApi.js";
import { jsonRateLimit } from "./lib/rateLimit.js";
import { requireAdmin, requireAgentKey, requireSession } from "./middleware/auth.js";
import { errorHandler, notFoundRoute } from "./middleware/error.js";
import { authRouter } from "./routes/auth.js";
import { docsRouter } from "./routes/docs.js";
import { healthRouter } from "./routes/health.js";
import { menuRouter, recommendationsRouter } from "./routes/menu.js";
import { profileRouter } from "./routes/profile.js";
import { availabilityRouter, reservationsRouter } from "./routes/reservations.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function createApp() {
  const app = express();
  // Behind a hosting proxy, trust its X-Forwarded-For so rate limits and audit IPs use the real client.
  if (config.isProduction) app.set("trust proxy", 1);

  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  // CSRF: on top of SameSite=Lax, a state-changing request sent from another site's page is refused.
  app.use((req, _res, next) => {
    const origin = req.get("origin");
    if (origin !== undefined && origin !== config.corsOrigin && !SAFE_METHODS.has(req.method)) throw new HttpError(403, "Cross-origin request blocked");
    next();
  });
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  // Route groups (API_SPEC.md, "Route groups"): every path starts with one group.
  const publicRoutes = Router().use("/health", healthRouter).use("/menus", menuRouter).use("/availabilities", availabilityRouter);
  if (config.apiDocs) publicRoutes.use("/docs", docsRouter);
  app.use("/api/public", publicRoutes);

  const authLimiter = jsonRateLimit({ windowMs: 15 * 60_000, limit: config.authRateLimit, message: RATE_LIMIT_ERROR });
  app.use("/api/auth", authLimiter, authRouter);

  const userRoutes = Router()
    .use("/me", profileRouter)
    .use("/reservations", reservationsRouter)
    .use("/menus/recommendations", recommendationsRouter);
  app.use("/api/users", requireSession, userRoutes);
  app.use("/api/admins", requireSession, requireAdmin, adminRouter);
  app.use("/api/agents", requireAgentKey, agentRouter);

  app.use(notFoundRoute);
  app.use(errorHandler);
  return app;
}
