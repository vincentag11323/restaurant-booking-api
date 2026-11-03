// Logs (api_spec.md §8): logs/app.log for every successful database change, logs/errors.log for every failed
// request. One `[METHOD] {json}` line each, also printed to the console. Never logs bodies, query strings,
// secrets or personal data.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Request } from "express";
import { config } from "../config.js";

export interface LogOptions {
  path: string;
  maxBytes: number;
  console: boolean;
}

export interface Failure {
  status: number;
  method: string;
  /** Path only: query strings can carry personal data (e.g. ?q=email). */
  path: string;
  message: string;
  userId?: string;
  ip?: string;
  /** Unexpected (5xx) errors keep their name and stack for debugging. */
  error?: Error;
}

export type ChangeAction =
  | "USER_CREATED"
  | "USER_CLAIMED"
  | "SESSION_CREATED"
  | "SESSIONS_EXPIRED_DELETED"
  | "SESSION_DELETED"
  | "PROFILE_UPDATED"
  | "RESERVATION_CREATED"
  | "RESERVATION_RESCHEDULED"
  | "RESERVATION_CANCELLED"
  | "GUEST_ACCOUNT_CREATED";

export interface Change {
  status: number;
  action: ChangeAction;
  resourceId?: string;
  /** Only on SESSIONS_EXPIRED_DELETED: how many rows were removed. */
  count?: number;
  /** Defaults to the signed-in caller; sign-up and sign-in pass the account just signed in. */
  userId?: string;
}

/** Over the limit, the file becomes `.1` and the previous `.1` is deleted: one live file, at most one old copy. */
function rotate(path: string, maxBytes: number) {
  if (!existsSync(path) || statSync(path).size <= maxBytes) return;
  rmSync(`${path}.1`, { force: true });
  renameSync(path, `${path}.1`);
}

function writeLine(method: string, record: object, options: LogOptions, print: (line: string) => void) {
  const line = `[${method}] ${JSON.stringify(record)}`;
  mkdirSync(dirname(options.path), { recursive: true });
  rotate(options.path, options.maxBytes);
  appendFileSync(options.path, `${line}\n`);
  if (options.console) print(line);
}

export function logFailure(failure: Failure, options: LogOptions = config.errorLog) {
  const { error, ...fields } = failure;
  const record = { time: new Date().toISOString(), ...fields, ...(error ? { error: { name: error.name, stack: error.stack } } : {}) };
  writeLine(failure.method, record, options, (line) => console.error(line));
}

/** Call after the database write succeeded, before responding. */
export function logChange(req: Request, change: Change, options: LogOptions = config.appLog) {
  const record = {
    time: new Date().toISOString(),
    status: change.status,
    method: req.method,
    path: req.originalUrl.split("?")[0],
    action: change.action,
    count: change.count,
    resourceId: change.resourceId,
    userId: change.userId ?? req.auth?.userId,
    ip: req.ip,
  };
  writeLine(req.method, record, options, (line) => console.log(line));
}
