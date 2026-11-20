import { randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { ControlPlaneError } from "../common/control-plane.error.js";

const N = 32768;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const MAXMEM = 64 * 1024 * 1024;
const TEMP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
// scrypt runs on the 4 threads of the pool that also checks every session token: keep 2 free.
const MAX_RUNNING = 2;
const MAX_WAITING = 16;
let running = 0;
const waiting: (() => void)[] = [];

/** Throws RATE_LIMITED when 2 password checks run and 16 wait. */
export function assertPasswordGateOpen(): void {
  if (running + waiting.length >= MAX_RUNNING + MAX_WAITING) {
    throw new ControlPlaneError("RATE_LIMITED", "Too many sign-in requests right now. Try again in a minute.");
  }
}

/** Password checks in the gate, running plus waiting. */
export function passwordGateLoad(): number {
  return running + waiting.length;
}

/** The running line of password checks of each account, keyed by the normalized email. */
export const passwordCheckLines = new Map<string, Promise<void>>();

/** Runs check after the earlier password checks of the same account, so one account holds at most one gate place (LR-M1). */
export function oneCheckPerAccount<T>(email: string, check: () => Promise<T>): Promise<T> {
  const key = email.trim().toLowerCase();
  const previous = passwordCheckLines.get(key) ?? Promise.resolve();
  const result = previous.then(check);
  const done = result.then(() => undefined, () => undefined);
  passwordCheckLines.set(key, done);
  void done.then(() => {
    if (passwordCheckLines.get(key) === done) passwordCheckLines.delete(key);
  });
  return result;
}

// admitted: the caller already passed assertPasswordGateOpen, so it waits instead of being refused.
async function derive(plain: string, salt: Buffer, n: number, r: number, p: number, admitted = false): Promise<Buffer> {
  if (!admitted) assertPasswordGateOpen();
  if (running < MAX_RUNNING) running += 1;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await new Promise((resolve, reject) =>
      scrypt(plain, salt, KEY_LEN, { N: n, r, p, maxmem: MAXMEM }, (e, k) => (e ? reject(e) : resolve(k))),
    );
  } finally {
    // Hand the slot to the next waiter, or give it back.
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  }
}

/** admitted: as for verifyPassword. */
export async function hashPassword(plain: string, admitted = false): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(plain, salt, N, R, P, admitted);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** admitted: the caller passed assertPasswordGateOpen before counting the try, so the check is never refused. */
export async function verifyPassword(plain: string, stored: string, admitted = false): Promise<boolean> {
  try {
    const [tag, n, r, p, salt, hash] = stored.split("$");
    if (tag !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
    const expected = Buffer.from(hash, "base64");
    const actual = await derive(plain, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p), admitted);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    return false;
  }
}

export function assertPasswordPolicy(plain: string): void {
  if (plain.length < 12) {
    throw new ControlPlaneError("VALIDATION_ERROR", "Password must be at least 12 characters.");
  }
}

export function generateTemporaryPassword(): string {
  return Array.from({ length: 16 }, () => TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)]).join("");
}
