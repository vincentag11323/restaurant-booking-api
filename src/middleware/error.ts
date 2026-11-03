import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/errors.js";

export function notFoundRoute(_req: Request, res: Response) {
  res.status(404).json({ message: "Route not found" });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ message: err.message });
    return;
  }
  // Malformed JSON from express.json()
  if (typeof err === "object" && err !== null && "type" in err && err.type === "entity.parse.failed") {
    res.status(400).json({ message: "Malformed JSON body" });
    return;
  }
  console.error(err);
  res.status(500).json({ message: "Internal server error" });
}
