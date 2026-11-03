import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { config } from "./config.js";
import { adminRouter } from "./routes/admin.js";
import { agentRouter } from "./routes/agent.js";
import { jsonRateLimit } from "./lib/rate_limit.js";
import { errorHandler, notFoundRoute } from "./middleware/error.js";
import { authRouter } from "./routes/auth.js";
import { menuRouter } from "./routes/menu.js";
import { profileRouter } from "./routes/profile.js";
import { availabilityRouter, reservationsRouter } from "./routes/reservations.js";

export function createApp() {
  const app = express();
  // Behind a hosting proxy, trust its X-Forwarded-For so rate limits and audit IPs use the real client.
  if (config.isProduction) app.set("trust proxy", 1);

  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  const authLimiter = jsonRateLimit({ windowMs: 15 * 60_000, limit: config.authRateLimit, message: "Too many attempts. Please wait a few minutes and try again." });
  app.use("/api/auth", authLimiter, authRouter);
  app.use("/api/me", profileRouter);
  app.use("/api/menu", menuRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/agent", agentRouter);
  app.use("/api/availability", availabilityRouter);
  app.use("/api/reservations", reservationsRouter);

  app.use(notFoundRoute);
  app.use(errorHandler);
  return app;
}
