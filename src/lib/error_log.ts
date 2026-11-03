// Failure log (api_spec.md §8): one JSON line per failed request in logs/errors.log, also printed with
// console.error. Rotates at the size limit, keeping at most 3 old files. Never logs bodies or secrets.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

const KEEP_OLD_FILES = 3;

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

/** errors.log → errors.log.1 → .2 → .3; the oldest is dropped. */
function rotate(path: string, maxBytes: number) {
  if (!existsSync(path) || statSync(path).size <= maxBytes) return;
  rmSync(`${path}.${KEEP_OLD_FILES}`, { force: true });
  for (let i = KEEP_OLD_FILES - 1; i >= 1; i--) {
    if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
  }
  renameSync(path, `${path}.1`);
}

export function logFailure(failure: Failure, options = config.errorLog) {
  const { error, ...fields } = failure;
  const line = JSON.stringify({
    time: new Date().toISOString(),
    ...fields,
    ...(error ? { error: { name: error.name, stack: error.stack } } : {}),
  });
  mkdirSync(dirname(options.path), { recursive: true });
  rotate(options.path, options.maxBytes);
  appendFileSync(options.path, `${line}\n`);
  if (options.console) console.error(`[failure] ${line}`);
}
