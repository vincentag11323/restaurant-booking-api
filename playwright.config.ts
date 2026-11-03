import { defineConfig } from "@playwright/test";

export const TEST_API_PORT = 4100;

export default defineConfig({
  testDir: "tests",
  // tests/jest is the Jest suite (npm run test:jest)
  testIgnore: "**/jest/**",
  globalSetup: "./tests/globalSetup.ts",
  // API tests share one database; run serially so capacity assertions are deterministic.
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${TEST_API_PORT}` },
});
