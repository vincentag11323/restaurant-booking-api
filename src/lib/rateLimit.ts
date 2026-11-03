import rateLimit from "express-rate-limit";
import { sendFailure } from "../middleware/error.js";

/** express-rate-limit with the API's JSON error body, and the 429 written to the failure log. */
export function jsonRateLimit(options: { windowMs: number; limit: number; message: string }) {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    handler: (req, res) => sendFailure(req, res, 429, options.message),
  });
}
