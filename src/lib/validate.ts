import { z } from "zod";
import { badRequest } from "./errors.js";

/** Parses input with a Zod schema, throwing a 400 with a readable message on failure. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
      .join("; ");
    throw badRequest(message);
  }
  return result.data;
}

export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected date as YYYY-MM-DD");
export const branchEnum = z.enum(["BRANCH_1", "BRANCH_2"]);
export const sectorEnum = z.enum(["MAIN_HALL", "VIP_WING"]);
export const statusEnum = z.enum(["CONFIRMED", "SEATED", "COMPLETED", "CANCELLED", "NO_SHOW"]);
