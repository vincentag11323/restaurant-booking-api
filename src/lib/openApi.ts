// OpenAPI 3.1 document (API_SPEC.md §7a). Each route file registers its own paths beside the route, reusing the
// Zod schemas that validate the request, so the docs can't drift from the real rules.
import { OpenAPIRegistry, OpenApiGeneratorV31, type ResponseConfig } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

export const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "sessionCookie", {
  type: "apiKey",
  in: "cookie",
  name: "session",
  description: "Set by POST /api/auth/register or /api/auth/login. Lasts 1 hour from sign-in; sign-out ends it at once.",
});
registry.registerComponent("securitySchemes", "agentKey", {
  type: "apiKey",
  in: "header",
  name: "X-Agent-Key",
  description: "The AI booking assistant's key (AGENT_API_KEY).",
});

export const SESSION_SECURITY = [{ sessionCookie: [] }];
export const AGENT_SECURITY = [{ agentKey: [] }];

export const messageSchema = z.object({ message: z.string() });

type ErrorStatus = 400 | 401 | 403 | 404 | 429;
export type ErrorMessages = Partial<Record<ErrorStatus, string[]>>;

export const CSRF_ERROR = "Cross-origin request blocked";
export const RATE_LIMIT_ERROR = "Too many attempts. Please wait a few minutes and try again.";
/** Every POST, PATCH and DELETE: the CSRF origin rule. */
export const CHANGE_ERRORS: ErrorMessages = { 403: [CSRF_ERROR] };
export const FORBIDDEN_ERROR = "Forbidden";
export const SIGN_IN_ERRORS: ErrorMessages = { 401: ["Authentication required", "Invalid or expired token"] };
export const ADMIN_ERRORS: ErrorMessages = { ...SIGN_IN_ERRORS, 403: [FORBIDDEN_ERROR] };
export const AGENT_KEY_ERRORS: ErrorMessages = { 401: ["Authentication required", "Invalid API key"] };

const STATUS_DESCRIPTIONS: Record<ErrorStatus, string> = {
  400: "Bad input",
  401: "Not signed in, or the sign-in or key isn't valid",
  403: "Signed in but not allowed, or a change sent from another site",
  404: "Not found",
  429: "Too many requests",
};

/** One response per status, with one named example per exact `{ message }`. Groups are merged per status. */
export function errorResponses(...groups: ErrorMessages[]): Record<number, ResponseConfig> {
  const merged = new Map<ErrorStatus, string[]>();
  for (const group of groups) {
    for (const [key, messages] of Object.entries(group)) {
      const status = Number(key) as ErrorStatus;
      merged.set(status, [...(merged.get(status) ?? []), ...messages]);
    }
  }
  const responses: Record<number, ResponseConfig> = {};
  for (const [status, messages] of merged) {
    const examples = Object.fromEntries(messages.map((message) => [message, { summary: message, value: { message } }]));
    responses[status] = { description: STATUS_DESCRIPTIONS[status], content: { "application/json": { schema: messageSchema, examples } } };
  }
  return responses;
}

/** A JSON success response with one example. */
export function jsonResponse(description: string, schema: z.ZodType, example: unknown): ResponseConfig {
  return { description, content: { "application/json": { schema, example } } };
}

/** A JSON request body with one example. */
export function jsonBody(schema: z.ZodType, example: unknown) {
  return { required: true, content: { "application/json": { schema, example } } };
}

const DESCRIPTION = `The ResortOS restaurant booking API. JSON in and out; times in answers are UTC, dates you send are the restaurant's local \`YYYY-MM-DD\`.

**Signing in.** Guests and admins sign in with \`POST /api/auth/login\` (or sign up with \`/api/auth/register\`), which sets an HttpOnly \`session\` cookie. A session lasts 1 hour from sign-in and is never extended. Signing out ends it at once, even for a saved copy of the cookie.

**The assistant's key.** The AI booking assistant sends \`X-Agent-Key\` instead of a cookie.

**Route groups.** \`/api/public\`: anyone, nothing is read. \`/api/auth\`: anyone, rate-limited. \`/api/users\`: the session cookie. \`/api/admins\`: the session cookie of an admin. \`/api/agents\`: the assistant's key. A cookie means nothing on \`/api/agents\`, and the key means nothing on \`/api/users\` or \`/api/admins\`.

**Errors** are always \`{ "message": string }\`. Changes (POST, PATCH, DELETE) sent from another site get \`403 ${CSRF_ERROR}\`.`;

/** Builds the whole document from every path registered so far (call after the routes are loaded). */
export function buildApiDocument() {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: { title: "ResortOS booking API", version: "1.0.0", description: DESCRIPTION },
    tags: [
      { name: "Public", description: "No sign-in: health, menus, free sittings and these docs." },
      { name: "Auth", description: "Sign up, sign in and sign out." },
      { name: "Users", description: "A signed-in guest's profile, bookings and recommendations." },
      { name: "Admins", description: "Read-only booking log, stats and exports for admins." },
      { name: "Agents", description: "The AI booking assistant's two routes." },
    ],
  });
}
