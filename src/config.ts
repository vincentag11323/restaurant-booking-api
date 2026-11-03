import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const TTL_UNIT_SECONDS = { s: 1, m: 60, h: 3600 } as const;

/** APP_LOG_* / ERROR_LOG_*: file path, rotation size (default 5 MB) and whether to print to the console. */
function logOptions(prefix: "APP_LOG" | "ERROR_LOG", defaultPath: string) {
  return {
    path: process.env[`${prefix}_PATH`] ?? defaultPath,
    maxBytes: Number(process.env[`${prefix}_MAX_BYTES`] ?? 5 * 1024 * 1024),
    console: process.env[`${prefix}_CONSOLE`] !== "false",
  };
}

/** Parses "<positive int><s|m|h>", e.g. 1h, 30m or 8s. */
function ttlSeconds(value: string): number {
  const match = /^([1-9]\d*)(s|m|h)$/.exec(value);
  if (!match) throw new Error(`Invalid SESSION_TTL: ${value} (use e.g. 1h, 30m or 8s)`);
  return Number(match[1]) * TTL_UNIT_SECONDS[match[2] as keyof typeof TTL_UNIT_SECONDS];
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  databaseUrl: required("DATABASE_URL"),
  utcOffset: process.env.RESTAURANT_UTC_OFFSET ?? "+07:00",
  authRateLimit: Number(process.env.AUTH_RATE_LIMIT ?? 20),
  // Fixed session lifetime from sign-in, never extended; the e2e run shortens it to test real expiry. Default 1 hour.
  sessionTtlSeconds: ttlSeconds(process.env.SESSION_TTL ?? "1h"),
  errorLog: logOptions("ERROR_LOG", "logs/errors.log"),
  appLog: logOptions("APP_LOG", "logs/app.log"),
  isProduction: process.env.NODE_ENV === "production",
};
