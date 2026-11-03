import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { ADMIN, registerGuest } from "./helpers.js";

test.describe("guest auth", () => {
  test("registering returns the public profile and a session cookie", async ({ request }) => {
    const { user, email } = await registerGuest(request);
    expect(user).toEqual({ id: expect.any(String), email, name: "Test Guest", phone: "+62 812 0000 0000", allergies: [], role: "USER" });
    expect(user).not.toHaveProperty("passwordHash");

    const res = await request.post("/api/auth/register", { data: { email: `cookie-${randomUUID()}@test.dev`, password: "Password123", name: "Cookie" } });
    expect(res.status()).toBe(201);
    expect(Object.keys(await res.json())).toEqual(["user"]);
    const cookie = res.headersArray().find((h) => h.name.toLowerCase() === "set-cookie")?.value ?? "";
    expect(cookie).toMatch(/^session=/);
    for (const attribute of ["Max-Age=3600", "Path=/", "HttpOnly", "SameSite=Lax"]) expect(cookie).toContain(attribute);
  });

  test("registering an existing email is rejected", async ({ request }) => {
    const { email } = await registerGuest(request);
    const res = await request.post("/api/auth/register", { data: { email, password: "Password123", name: "Again" } });
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ message: "Email is already registered" });
  });

  test("a short password is rejected", async ({ request }) => {
    const res = await request.post("/api/auth/register", { data: { email: "short@test.dev", password: "abc", name: "Short" } });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toContain("Password must be at least 8 characters");
  });

  test("a wrong password gets 401", async ({ request }) => {
    const res = await request.post("/api/auth/login", { data: { email: ADMIN.email, password: "wrong-password" } });
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ message: "Invalid email or password" });
  });

  test("the session cookie authenticates GET /api/users/me", async ({ request }) => {
    const { headers, email } = await registerGuest(request);
    const res = await request.get("/api/users/me", { headers });
    expect(res.status()).toBe(200);
    expect((await res.json()).email).toBe(email);
  });

  test("(A14) after sign-out the same cookie is refused at once", async ({ request }) => {
    const { headers } = await registerGuest(request);
    expect((await request.get("/api/users/me", { headers })).status()).toBe(200);
    const out = await request.post("/api/auth/logout", { headers });
    expect(out.status()).toBe(200);
    const res = await request.get("/api/users/me", { headers });
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ message: "Invalid or expired token" });
  });

  test("there is no refresh route", async ({ request }) => {
    const res = await request.post("/api/auth/refresh");
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ message: "Route not found" });
  });

  test("the session sent as a Bearer token gets 401", async ({ request }) => {
    const { headers } = await registerGuest(request);
    const res = await request.get("/api/users/me", { headers: { Authorization: `Bearer ${headers.Cookie.slice("session=".length)}` } });
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ message: "Authentication required" });
  });
});

test.describe("profile", () => {
  test("requires a session", async ({ request }) => {
    const res = await request.get("/api/users/me");
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ message: "Authentication required" });
  });

  test("allergies are saved as lowercase tags", async ({ request }) => {
    const { headers } = await registerGuest(request);
    const res = await request.patch("/api/users/me", { headers, data: { allergies: ["Shellfish", "NUTS"] } });
    expect(res.status()).toBe(200);
    expect((await res.json()).allergies).toEqual(["shellfish", "nuts"]);
  });
});
