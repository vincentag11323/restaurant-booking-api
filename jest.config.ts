import type { Config } from "jest";

const config: Config = {
  roots: ["<rootDir>/tests/jest"],
  testMatch: ["**/*.test.ts"],
  // swc only strips types; it doesn't need TypeScript's JS API (absent in TypeScript 7), unlike ts-jest.
  transform: { "^.+\\.ts$": ["@swc/jest", { jsc: { target: "es2022" }, module: { type: "commonjs" } }] },
  // Source uses NodeNext-style ".js" import specifiers for ".ts" files.
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
  globalSetup: "<rootDir>/tests/jest/global-setup.ts",
  globalTeardown: "<rootDir>/tests/jest/global-teardown.ts",
  // One shared database: run files serially so capacity checks are deterministic.
  maxWorkers: 1,
  testTimeout: 30_000,
  collectCoverageFrom: ["src/**/*.ts", "!src/generated/**"],
  coverageProvider: "v8",
  coverageReporters: ["text", "text-summary", "lcov"],
  coverageThreshold: { global: { statements: 100, branches: 100, functions: 100, lines: 100 } },
};

export default config;
