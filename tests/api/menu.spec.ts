import { expect, test } from "@playwright/test";
import { registerGuest } from "./helpers.js";

test("the menu can be filtered by type", async ({ request }) => {
  const res = await request.get("/api/public/menus?type=SEASONAL_FINE_DINING");
  expect(res.status()).toBe(200);
  const names = (await res.json()).map((item: { name: string }) => item.name);
  expect(names).toContain("Seared Scallops");
  expect(names).not.toContain("Beef Steak");
});

test("recommendations hide dishes with the guest's allergens and list chef's picks first", async ({ request }) => {
  const { headers } = await registerGuest(request);
  await request.patch("/api/users/me", { headers, data: { allergies: ["fish", "gluten"] } });

  const res = await request.get("/api/users/menus/recommendations", { headers });
  expect(res.status()).toBe(200);
  const items: { name: string; chefPick: boolean; allergens: string[] }[] = await res.json();
  const names = items.map((i) => i.name);
  expect(names).not.toContain("Barramundi");
  expect(names).not.toContain("Fish & Chips");
  expect(names).not.toContain("Classic Burger");
  expect(names).toContain("Garden Salad");
  const firstNonPick = items.findIndex((i) => !i.chefPick);
  expect(items.slice(firstNonPick).some((i) => i.chefPick)).toBe(false);
});
