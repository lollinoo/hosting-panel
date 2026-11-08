import { describe, expect, it } from "vitest";
import {
  assertPasswordPolicy,
  generateTemporaryPassword,
  hashPassword,
  verifyPassword,
} from "../src/auth/password.js";
import { buildOtpauthUri, generateTotpSecret, totpCodeAt, verifyTotp } from "../src/auth/totp.js";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("password", () => {
  it("hashes and verifies a password", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h.startsWith("scrypt$32768$8$1$")).toBe(true);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong horse battery", h)).toBe(false);
  });
  it("two hashes of the same password differ", async () => {
    expect(await hashPassword("same-password-123")).not.toBe(await hashPassword("same-password-123"));
  });
  it("verifyPassword returns false on malformed hash", async () => {
    expect(await verifyPassword("x", "garbage")).toBe(false);
    expect(await verifyPassword("x", "scrypt$a$b$c$d$e")).toBe(false);
  });
  it("rejects passwords shorter than 12 chars", () => {
    expect(() => assertPasswordPolicy("short")).toThrow();
    expect(() => assertPasswordPolicy("twelve-chars")).not.toThrow();
  });
  it("temporary password is 16 unambiguous chars", () => {
    expect(generateTemporaryPassword()).toMatch(/^[A-HJ-NP-Za-km-z2-9]{16}$/);
  });
});

describe("totp", () => {
  it("RFC 6238 SHA1 vectors", () => {
    expect(totpCodeAt(SECRET, Math.floor(59 / 30), 8)).toBe("94287082");
    expect(totpCodeAt(SECRET, Math.floor(1111111109 / 30), 8)).toBe("07081804");
    expect(totpCodeAt(SECRET, Math.floor(1234567890 / 30), 8)).toBe("89005924");
  });
  it("generates a 32-char base32 secret", () => {
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });
  it("accepts current and ±1 step, rejects ±2", () => {
    const now = 1_700_000_000_000;
    const s = Math.floor(now / 30000);
    for (const d of [-1, 0, 1]) {
      expect(verifyTotp(SECRET, totpCodeAt(SECRET, s + d), now, null)).toEqual({ ok: true, step: s + d });
    }
    for (const d of [-2, 2]) {
      expect(verifyTotp(SECRET, totpCodeAt(SECRET, s + d), now, null).ok).toBe(false);
    }
    expect(verifyTotp(SECRET, "12345678", now, null).ok).toBe(false);
  });
  it("rejects a TOTP code reused within its window", () => {
    const now = 1_700_000_000_000;
    const code = totpCodeAt(SECRET, Math.floor(now / 30000));
    const first = verifyTotp(SECRET, code, now, null);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(verifyTotp(SECRET, code, now, first.step).ok).toBe(false);
  });
  it("otpauth uri encodes issuer and email", () => {
    expect(buildOtpauthUri("ABC", "a+b@x.io", "Hosting Panel")).toBe(
      "otpauth://totp/Hosting%20Panel:a%2Bb%40x.io?secret=ABC&issuer=Hosting%20Panel&algorithm=SHA1&digits=6&period=30",
    );
  });
});
