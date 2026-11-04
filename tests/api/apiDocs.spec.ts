// (S17) The Swagger UI page renders in a real browser under the API's security headers.
import { expect, test } from "@playwright/test";

test("(S17) the Swagger UI page shows the five route groups with no content-security-policy errors", async ({ page }) => {
  const cspErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("Content Security Policy")) cspErrors.push(message.text());
  });
  await page.goto("/api/public/docs");
  await expect(page).toHaveURL(/\/api\/public\/docs\/$/);
  for (const tag of ["Public", "Auth", "Users", "Admins", "Agents"]) {
    await expect(page.locator(".opblock-tag", { hasText: tag }).first()).toBeVisible();
  }
  await expect(page.getByText("ResortOS booking API").first()).toBeVisible();
  expect(cspErrors).toEqual([]);
});
