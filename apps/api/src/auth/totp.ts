import { createHmac, randomBytes } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_MS = 30_000;

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCodeAt(secretBase32: string, step: number, digits: 6 | 8 = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secretBase32)).update(counter).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = h.readUInt32BE(off) & 0x7fffffff;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number,
  lastUsedStep: number | null,
): { ok: true; step: number } | { ok: false } {
  if (!/^\d{6}$/.test(code)) return { ok: false };
  const current = Math.floor(nowMs / STEP_MS);
  for (const step of [current - 1, current, current + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (totpCodeAt(secretBase32, step) === code) return { ok: true, step };
  }
  return { ok: false };
}

export function buildOtpauthUri(secretBase32: string, accountEmail: string, issuer: string): string {
  const i = encodeURIComponent(issuer);
  return `otpauth://totp/${i}:${encodeURIComponent(accountEmail)}?secret=${secretBase32}&issuer=${i}&algorithm=SHA1&digits=6&period=30`;
}
