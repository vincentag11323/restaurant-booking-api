import { describe, expect, it, jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { HttpError, notFound } from "../../src/lib/errors.js";
import { notify } from "../../src/lib/notify.js";
import jwt from "jsonwebtoken";
import { hashApiKey, signSessionToken, verifySessionToken } from "../../src/lib/tokens.js";
import { parse } from "../../src/lib/validate.js";
import { currentUser } from "../../src/middleware/auth.js";
import { errorHandler } from "../../src/middleware/error.js";

function fakeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response & typeof res;
}

describe("errors and validation", () => {
  it("notFound defaults to the reservation message but accepts another", () => {
    expect(notFound()).toEqual(new HttpError(404, "Reservation not found"));
    expect(notFound("Table not found").message).toBe("Table not found");
  });

  it("reports a top-level validation issue without a field prefix", () => {
    expect(() => parse(z.object({ a: z.string() }), ["not", "an", "object"])).toThrow(/^Invalid input/);
  });
});

describe("error handler", () => {
  const next = jest.fn() as unknown as NextFunction;

  it("hides unexpected errors behind a generic 500", () => {
    const res = fakeRes();
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const req = { method: "GET", originalUrl: "/api/x?q=1", ip: "1.2.3.4" } as Request;
    errorHandler(new Error("secret stack"), req, res, next);
    errorHandler("a thrown string", req, res, next);
    errorHandler(null, req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: "Internal server error" });
    expect(res.json).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });
});

describe("auth helpers", () => {
  it("round-trips a session token", () => {
    expect(verifySessionToken(signSessionToken({ id: "u1", role: "ADMIN" }))).toEqual({ id: "u1", role: "ADMIN" });
  });

  it("issues session tokens valid for 1 hour", () => {
    const { exp, iat } = JSON.parse(Buffer.from(signSessionToken({ id: "u1", role: "USER" }).split(".")[1], "base64url").toString());
    expect(exp - iat).toBe(3600);
  });

  it("refuses a token signed with another secret", () => {
    const token = jwt.sign({ role: "USER" }, "some-other-secret-some-other-secret", { subject: "u1", expiresIn: 3600 });
    expect(() => verifySessionToken(token)).toThrow();
  });

  it("hashes the agent API key as SHA-256 hex", () => {
    expect(hashApiKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("currentUser throws 401 when no user is attached", () => {
    expect(() => currentUser({} as Request)).toThrow(new HttpError(401, "Authentication required"));
  });
});

describe("notify", () => {
  it("logs the message (v1 delivery stub)", async () => {
    const spy = jest.spyOn(console, "info").mockImplementation(() => {});
    await notify("guest@test.dev", "Booking confirmed", "RSV-AAAAAA");
    expect(spy).toHaveBeenCalledWith('[notify] to=guest@test.dev subject="Booking confirmed" RSV-AAAAAA');
    spy.mockRestore();
  });
});
