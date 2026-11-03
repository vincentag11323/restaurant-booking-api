import { expect, test } from "@playwright/test";
import { ADMIN, registerGuest } from "./helpers.js";

test.describe("guest auth", () => {
  test("registering returns an access token and the public profile", async ({ request }) => {
    const { user, email } = await registerGuest(request);
    expect(user).toEqual({ id: expect.any(String), email, name: "Test Guest", phone: "+62 812 0000 0000", allergies: [], role: "USER" });
    expect(user).not.toHaveProperty("passwordHash");
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

  test("the refresh cookie issues a new access token", async ({ request }) => {
    await registerGuest(request);
    const res = await request.post("/api/auth/refresh");
    expect(res.status()).toBe(200);
    expect((await res.json()).accessToken).toEqual(expect.any(String));
  });

  test("refresh without a cookie gets 401", async ({ playwright, baseURL }) => {
    const fresh = await playwright.request.newContext({ baseURL });
    const res = await fresh.post("/api/auth/refresh");
    expect(res.status()).toBe(401);
    await fresh.dispose();
  });
});

test.describe("profile", () => {
  test("requires a token", async ({ request }) => {
    const res = await request.get("/api/me");
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({ message: "Authentication required" });
  });

  test("allergies are saved as lowercase tags", async ({ request }) => {
    const { headers } = await registerGuest(request);
    const res = await request.patch("/api/me", { headers, data: { allergies: ["Shellfish", "NUTS"] } });
    expect(res.status()).toBe(200);
    expect((await res.json()).allergies).toEqual(["shellfish", "nuts"]);
  });
});
