import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  databaseUrl: required("DATABASE_URL"),
  jwtAccessSecret: required("JWT_ACCESS_SECRET"),
  jwtRefreshSecret: required("JWT_REFRESH_SECRET"),
  utcOffset: process.env.RESTAURANT_UTC_OFFSET ?? "+07:00",
  authRateLimit: Number(process.env.AUTH_RATE_LIMIT ?? 20),
  errorLog: {
    path: process.env.ERROR_LOG_PATH ?? "logs/errors.log",
    maxBytes: Number(process.env.ERROR_LOG_MAX_BYTES ?? 5 * 1024 * 1024),
    console: process.env.ERROR_LOG_CONSOLE !== "false",
  },
  isProduction: process.env.NODE_ENV === "production",
};
