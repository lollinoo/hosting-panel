import { randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { ControlPlaneError } from "../common/control-plane.error.js";

const N = 32768;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const MAXMEM = 64 * 1024 * 1024;
const TEMP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function derive(plain: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(plain, salt, KEY_LEN, { N: n, r, p, maxmem: MAXMEM }, (e, k) => (e ? reject(e) : resolve(k))),
  );
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(plain, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const [tag, n, r, p, salt, hash] = stored.split("$");
    if (tag !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
    const expected = Buffer.from(hash, "base64");
    const actual = await derive(plain, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
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
