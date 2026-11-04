// Interactive API docs (API_SPEC.md §7a; TEST_SCENARIOS_APP.md S17).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Router } from "express";
import request from "supertest";
import type { z } from "zod";
import { prisma } from "../../src/lib/db.js";
import { adminReservationPageSchema, adminReservationSchema, adminRouter, statsSchema } from "../../src/routes/admin.js";
import { agentRouter, lookupResultSchema } from "../../src/routes/agent.js";
import { authResponseSchema, authRouter, logoutSchema } from "../../src/routes/auth.js";
import { docsRouter } from "../../src/routes/docs.js";
import { healthRouter, healthSchema } from "../../src/routes/health.js";
import { menuItemSchema, menuRouter, recommendationsRouter } from "../../src/routes/menu.js";
import { profileRouter, userSchema } from "../../src/routes/profile.js";
import { availabilityRouter, reservationSchema, reservationsRouter, slotSchema } from "../../src/routes/reservations.js";
import { TEST_ENV } from "./globalSetup.js";
import { app, daysAhead, loginAdmin, registerGuest } from "./helpers.js";

afterAll(() => prisma.$disconnect());

/** Where app.ts mounts each leaf router. Express 5 keeps no mount-path strings, so the test holds them. */
const MOUNTS: [string, Router][] = [
  ["/api/public/health", healthRouter],
  ["/api/public/menus", menuRouter],
  ["/api/public/availabilities", availabilityRouter],
  ["/api/public/docs", docsRouter],
  ["/api/auth", authRouter],
  ["/api/users/me", profileRouter],
  ["/api/users/reservations", reservationsRouter],
  ["/api/users/menus/recommendations", recommendationsRouter],
  ["/api/admins", adminRouter],
  ["/api/agents", agentRouter],
];

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
}

const routeMethods = (layer: Layer) => Object.keys(layer.route?.methods ?? {}).filter((m) => m !== "_all");

function mountedOperations(): string[] {
  return MOUNTS.flatMap(([prefix, router]) =>
    (router.stack as Layer[]).flatMap((layer) =>
      routeMethods(layer).map((method) => `${method.toUpperCase()} ${prefix}${layer.route!.path === "/" ? "" : layer.route!.path.replace(/:(\w+)/g, "{$1}")}`),
    ),
  );
}

/** Every route-method pair the app answers, found by walking the whole router tree. */
function countRoutes(stack: Layer[]): number {
  return stack.reduce((sum, layer) => sum + routeMethods(layer).length + (layer.handle?.stack ? countRoutes(layer.handle.stack) : 0), 0);
}

interface Example {
  summary?: string;
  value: { message: string };
}
interface Operation {
  summary?: string;
  description?: string;
  tags?: string[];
  security?: Record<string, string[]>[];
  responses: Record<string, { content?: Record<string, { example?: unknown; examples?: Record<string, Example> }> }>;
}
interface Document {
  openapi: string;
  info: { title: string; description: string };
  tags: { name: string }[];
  paths: Record<string, Record<string, Operation>>;
  components: { securitySchemes: Record<string, unknown> };
}

let doc: Document;
beforeAll(async () => {
  const res = await request(app).get("/api/public/docs/openapi.json");
  expect(res.status).toBe(200);
  doc = res.body;
});

const operations = () => Object.entries(doc.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, method, path, op })));
const operation = (key: string) => {
  const found = operations().find((o) => o.key === key);
  expect(found).toBeDefined();
  return found!.op;
};
const messages = (key: string, status: number) => Object.values(operation(key).responses[status]?.content?.["application/json"]?.examples ?? {}).map((e) => e.value.message);

const RESERVATION_400 = [
  "startTime: startTime must be one of 11:00, 13:30, 17:00, 19:30",
  "partySize: Party size must be between 1 and 50",
  "Selected slot is in the past or too far ahead",
  "Insufficient capacity for the selected slot",
  "Table overlap conflict, please try again",
];
const CHANGE_400 = ["Only confirmed reservations can be changed", "Reservation slot has already started"];
const AGENT_400 = [
  "This email already has a booking made with the assistant. To book a different time, sign up with this email in the app, cancel that booking there, then ask me again.",
  "This email already has 3 upcoming assistant bookings. Sign in to manage them.",
  "This email can't be booked through the assistant",
  "Idempotency-Key was already used for another booking",
];

describe("(S17) the OpenAPI document", () => {
  it("is OpenAPI 3.1 with a plain-language introduction", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("ResortOS booking API");
    for (const words of ["session", "1 hour", "X-Agent-Key", "/api/public", "/api/auth", "/api/users", "/api/admins", "/api/agents", '{ "message": string }']) {
      expect(doc.info.description).toContain(words);
    }
    expect(doc.tags.map((t) => t.name)).toEqual(["Public", "Auth", "Users", "Admins", "Agents"]);
  });

  it("drift guard: documents exactly the routes the app mounts", () => {
    const mounted = mountedOperations();
    expect(new Set(mounted).size).toBe(mounted.length);
    expect(operations().map((o) => o.key).sort()).toEqual([...mounted].sort());
    expect(countRoutes((app as unknown as { router: { stack: Layer[] } }).router.stack)).toBe(mounted.length);
  });

  it("gives every operation a summary, a description, one group tag, a success example and the group's security", () => {
    const groups: Record<string, { tag: string; security?: Record<string, string[]>[] }> = {
      public: { tag: "Public" },
      auth: { tag: "Auth" },
      users: { tag: "Users", security: [{ sessionCookie: [] }] },
      admins: { tag: "Admins", security: [{ sessionCookie: [] }] },
      agents: { tag: "Agents", security: [{ agentKey: [] }] },
    };
    for (const { key, path, op } of operations()) {
      const group = groups[path.split("/")[2]];
      expect([key, op.summary?.length ? "summary" : "", op.description?.length ? "description" : "", op.tags, op.security]).toEqual([key, "summary", "description", [group.tag], group.security]);
      const success = Object.entries(op.responses).filter(([status]) => /^[23]/.test(status));
      expect([key, success.length > 0]).toEqual([key, true]);
      for (const [status, response] of success) {
        if (status.startsWith("3")) continue;
        const media = Object.values(response.content ?? {});
        expect([key, status, media.length > 0 && media.every((m) => m.example !== undefined || m.examples !== undefined)]).toEqual([key, status, true]);
      }
    }
  });

  it("has the exact security schemes", () => {
    expect(doc.components.securitySchemes).toEqual({
      sessionCookie: expect.objectContaining({ type: "apiKey", in: "cookie", name: "session" }),
      agentKey: expect.objectContaining({ type: "apiKey", in: "header", name: "X-Agent-Key" }),
    });
  });

  it("lists the group errors on every operation, and the CSRF 403 on every change", () => {
    for (const { key, method, path } of operations()) {
      if (method !== "get") expect([key, messages(key, 403)]).toEqual([key, expect.arrayContaining(["Cross-origin request blocked"])]);
      if (path.startsWith("/api/users/") || path.startsWith("/api/admins/")) {
        expect([key, messages(key, 401)]).toEqual([key, ["Authentication required", "Invalid or expired token"]]);
      }
      if (path.startsWith("/api/admins/")) expect([key, messages(key, 403)]).toEqual([key, ["Forbidden"]]);
      if (path.startsWith("/api/agents/")) expect([key, messages(key, 401)]).toEqual([key, ["Authentication required", "Invalid API key"]]);
      if (path.startsWith("/api/auth/")) expect([key, messages(key, 429)]).toEqual([key, ["Too many attempts. Please wait a few minutes and try again."]]);
    }
  });

  it("lists each route's exact error messages from the spec", () => {
    expect(messages("POST /api/auth/login", 401)).toEqual(["Invalid email or password"]);
    expect(messages("POST /api/auth/register", 400)).toEqual(expect.arrayContaining(["Email is already registered", "password: Password must be at least 8 characters", "phone: Invalid phone number"]));
    expect(messages("POST /api/users/reservations", 400)).toEqual(expect.arrayContaining(RESERVATION_400));
    expect(messages("PATCH /api/users/reservations/{id}", 400)).toEqual(expect.arrayContaining([...RESERVATION_400, ...CHANGE_400]));
    expect(messages("DELETE /api/users/reservations/{id}", 400)).toEqual(CHANGE_400);
    expect(messages("POST /api/agents/reservations", 400)).toEqual(expect.arrayContaining([...RESERVATION_400, ...AGENT_400]));
    expect(messages("POST /api/agents/guests/lookup", 429)).toEqual(["Too many lookups. Please slow down."]);
    for (const key of ["GET /api/users/reservations/{id}", "PATCH /api/users/reservations/{id}", "DELETE /api/users/reservations/{id}", "GET /api/admins/reservations/{id}"]) {
      expect([key, messages(key, 404)]).toEqual([key, ["Reservation not found"]]);
    }
    for (const key of ["GET /api/users/reservations", "POST /api/users/reservations", "GET /api/users/menus/recommendations"]) {
      expect([key, messages(key, 403)]).toEqual([key, expect.arrayContaining(["Forbidden"])]);
    }
  });
});

describe("(S17) the documented response schemas match real responses", () => {
  const parses = (schema: z.ZodType, body: unknown) => {
    const result = schema.safeParse(body);
    expect(result.error?.issues ?? []).toEqual([]);
  };

  it("public, auth, users, admins and agents", async () => {
    parses(healthSchema, (await request(app).get("/api/public/health")).body);
    for (const item of (await request(app).get("/api/public/menus")).body) parses(menuItemSchema, item);
    for (const slot of (await request(app).get(`/api/public/availabilities?branch=BRANCH_1&sector=MAIN_HALL&date=${daysAhead(42)}`)).body) parses(slotSchema, slot);

    const email = `jest-docs-${randomUUID()}@test.dev`;
    const register = await request(app).post("/api/auth/register").send({ email, password: "Password123", name: "Docs" });
    parses(authResponseSchema, register.body);
    const guest = await registerGuest();
    parses(userSchema, (await request(app).get("/api/users/me").set(guest.auth)).body);
    const booked = await request(app).post("/api/users/reservations").set(guest.auth).send({ branch: "BRANCH_1", sector: "MAIN_HALL", date: daysAhead(42), startTime: "17:00", partySize: 2 });
    expect(booked.status).toBe(201);
    parses(reservationSchema, booked.body);
    for (const item of (await request(app).get("/api/users/menus/recommendations").set(guest.auth)).body) parses(menuItemSchema, item);

    const admin = await loginAdmin();
    parses(statsSchema, (await request(app).get("/api/admins/stats").set(admin)).body);
    parses(adminReservationPageSchema, (await request(app).get("/api/admins/reservations?pageSize=5").set(admin)).body);
    parses(adminReservationSchema, (await request(app).get(`/api/admins/reservations/${booked.body.id}`).set(admin)).body);

    parses(lookupResultSchema, (await request(app).post("/api/agents/guests/lookup").set("X-Agent-Key", TEST_ENV.AGENT_API_KEY).send({ email })).body);
    parses(logoutSchema, (await request(app).post("/api/auth/logout").set(guest.auth)).body);
  });
});

describe("(S17) the Swagger UI page", () => {
  it("redirects /api/public/docs to the folder URL so the page's relative assets load", async () => {
    const plain = await request(app).get("/api/public/docs");
    expect([plain.status, plain.headers.location]).toEqual([301, "/api/public/docs/"]);
    const withQuery = await request(app).get("/api/public/docs?x=1");
    expect([withQuery.status, withQuery.headers.location]).toEqual([301, "/api/public/docs/?x=1"]);
  });

  it("serves the page and its script", async () => {
    const page = await request(app).get("/api/public/docs/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toMatch(/^text\/html/);
    expect(page.text).toContain("swagger-ui");
    const init = await request(app).get("/api/public/docs/swagger-ui-init.js");
    expect(init.status).toBe(200);
    expect(init.text).toContain("openapi.json");
  });

  it("keeps the strict default content-security policy on the other routes", async () => {
    const csp = (await request(app).get("/api/public/menus")).headers["content-security-policy"];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
  });
});
