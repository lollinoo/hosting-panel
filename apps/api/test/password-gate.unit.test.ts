import * as crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/password.js";

// Counts the scrypt calls in flight; each one ends on a later macrotask, never in the tick that started it.
let inside = 0;
let most = 0;
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    scrypt: vi.fn((_p: unknown, _s: unknown, len: number, _o: unknown, cb: (e: Error | null, k: Buffer) => void) => {
      inside += 1;
      most = Math.max(most, inside);
      setTimeout(() => {
        inside -= 1;
        cb(null, Buffer.alloc(len, 1));
      }, 1);
    }),
  };
});

afterEach(() => {
  inside = 0;
  most = 0;
});

describe("the gate on password hashing", () => {
  it("of 30 calls started in one tick serves 18, refuses 12 with RATE_LIMITED and never runs more than 2 scrypt at once", async () => {
    const stored = await hashPassword("sentinel-pass-0001");
    most = 0;
    const calls = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? hashPassword("sentinel-pass-0001") : verifyPassword("sentinel-pass-0001", stored),
    );
    const results = await Promise.allSettled(calls);
    const refused = results.filter((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(18);
    expect(refused).toHaveLength(12);
    for (const r of refused) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "RATE_LIMITED" });
    expect(most).toBe(2);
    expect(vi.mocked(crypto.scrypt)).toHaveBeenCalledTimes(1 + 18);
  });

  it("lets 30 admitted calls wait beyond the bound, never runs more than 2, and refuses a plain call while more than 16 wait", async () => {
    const stored = await hashPassword("sentinel-pass-0001");
    most = 0;
    const admitted = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? hashPassword("sentinel-pass-0001", true) : verifyPassword("sentinel-pass-0001", stored, true),
    );
    const plain = verifyPassword("sentinel-pass-0001", stored);
    await expect(plain).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const results = await Promise.allSettled(admitted);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(30);
    expect(most).toBe(2);
  });

  it("serves again once the queue has drained", async () => {
    await Promise.allSettled(Array.from({ length: 30 }, () => hashPassword("sentinel-pass-0001")));
    await expect(hashPassword("sentinel-pass-0001")).resolves.toMatch(/^scrypt\$32768\$8\$1\$/);
  });
});
