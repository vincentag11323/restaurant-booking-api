import { describe, expect, it, jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { HttpError, notFound } from "../../src/lib/errors.js";
import { notify } from "../../src/lib/notify.js";
import { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } from "../../src/lib/tokens.js";
import { parse } from "../../src/lib/validate.js";
import { currentUser, requireRole } from "../../src/middleware/auth.js";
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
    errorHandler(new Error("secret stack"), {} as Request, res, next);
    errorHandler("a thrown string", {} as Request, res, next);
    errorHandler(null, {} as Request, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: "Internal server error" });
    expect(res.json).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });
});

describe("auth helpers", () => {
  it("round-trips access and refresh tokens", () => {
    expect(verifyAccessToken(signAccessToken({ id: "u1", role: "ADMIN" }))).toEqual({ id: "u1", role: "ADMIN" });
    expect(verifyRefreshToken(signRefreshToken("u1"))).toBe("u1");
  });

  it("refuses a refresh token used as an access token", () => {
    expect(() => verifyAccessToken(signRefreshToken("u1"))).toThrow();
  });

  it("currentUser throws 401 when no user is attached", () => {
    expect(() => currentUser({} as Request)).toThrow(new HttpError(401, "Authentication required"));
  });

  it("requireRole lets the right role through", () => {
    const next = jest.fn();
    requireRole("ADMIN")({ user: { id: "a", role: "ADMIN" } } as Request, {} as Response, next as unknown as NextFunction);
    expect(next).toHaveBeenCalled();
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
