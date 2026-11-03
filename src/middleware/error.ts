import type { NextFunction, Request, Response } from "express";
import { logFailure } from "../lib/error_log.js";
import { HttpError } from "../lib/errors.js";

/** Every failed response goes through here so it's logged (api_spec.md §8). */
export function sendFailure(req: Request, res: Response, status: number, message: string, error?: Error) {
  logFailure({ status, method: req.method, path: req.originalUrl.split("?")[0], message, userId: req.user?.id, ip: req.ip, error });
  res.status(status).json({ message });
}

export function notFoundRoute(req: Request, res: Response) {
  sendFailure(req, res, 404, "Route not found");
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    sendFailure(req, res, err.status, err.message);
    return;
  }
  // Malformed JSON from express.json()
  if (typeof err === "object" && err !== null && "type" in err && err.type === "entity.parse.failed") {
    sendFailure(req, res, 400, "Malformed JSON body");
    return;
  }
  sendFailure(req, res, 500, "Internal server error", err instanceof Error ? err : new Error(String(err)));
}
