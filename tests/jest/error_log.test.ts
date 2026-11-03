import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, jest } from "@jest/globals";
import request from "supertest";
import { logFailure } from "../../src/lib/error_log.js";
import { prisma } from "../../src/lib/db.js";
import { app } from "./helpers.js";

afterAll(() => prisma.$disconnect());

const tempLog = () => join(mkdtempSync(join(tmpdir(), "errlog-")), "logs", "errors.log");
const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("failure log", () => {
  it("appends one JSON line per failure and prints it with console.error", () => {
    const path = tempLog();
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    logFailure({ status: 400, method: "POST", path: "/api/x", message: "bad", ip: "1.2.3.4" }, { path, maxBytes: 1_000_000, console: true });
    logFailure({ status: 500, method: "GET", path: "/api/y", message: "boom", error: new TypeError("boom") }, { path, maxBytes: 1_000_000, console: true });
    const [first, second] = lines(path);
    expect(first).toMatchObject({ status: 400, method: "POST", path: "/api/x", message: "bad", ip: "1.2.3.4" });
    expect(typeof first.time).toBe("string");
    expect(second.error).toMatchObject({ name: "TypeError" });
    expect(second.error.stack).toContain("TypeError: boom");
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("rotates past the size limit and keeps at most 3 old files", () => {
    const path = tempLog();
    // Each line is ~120 bytes, so a 200-byte limit holds two lines per file.
    const write = (n: number) => logFailure({ status: 404, method: "GET", path: `/n${n}`, message: "x".repeat(50) }, { path, maxBytes: 200, console: false });
    for (let n = 1; n <= 10; n++) write(n);
    expect([path, `${path}.1`, `${path}.2`, `${path}.3`].map((p) => lines(p).map((l) => l.path))).toEqual([
      ["/n9", "/n10"],
      ["/n7", "/n8"],
      ["/n5", "/n6"],
      ["/n3", "/n4"],
    ]);
    expect(existsSync(`${path}.4`)).toBe(false);
  });

  it("creates the log folder and file when they don't exist yet", () => {
    const path = tempLog();
    logFailure({ status: 401, method: "GET", path: "/z", message: "no" }, { path, maxBytes: 10, console: false });
    expect(lines(path)).toHaveLength(1);
  });

  it("logs real request failures without bodies, query strings or secrets", async () => {
    const before = existsSync(process.env.ERROR_LOG_PATH!) ? lines(process.env.ERROR_LOG_PATH!).length : 0;
    await request(app).post("/api/auth/login").send({ email: "nobody@test.dev", password: "SuperSecret1" });
    await request(app).get("/api/nope?email=secret@test.dev");
    await request(app).post("/api/auth/login").set("Content-Type", "application/json").send("{bad");
    const added = lines(process.env.ERROR_LOG_PATH!).slice(before);
    expect(added.map((l) => [l.status, l.method, l.path, l.message])).toEqual([
      [401, "POST", "/api/auth/login", "Invalid email or password"],
      [404, "GET", "/api/nope", "Route not found"],
      [400, "POST", "/api/auth/login", "Malformed JSON body"],
    ]);
    expect(JSON.stringify(added)).not.toMatch(/SuperSecret1|secret@test\.dev/);
  });
});
