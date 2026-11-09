import dns from "node:dns";
import { describe, expect, it } from "vitest";
import {
  certRetryAt,
  evaluateDns,
  manualCertRetryAt,
  nextDnsCheckAt,
} from "../src/sites/domain-policy.js";
import { createNodeDnsLookup, type ResolverLike } from "../src/sites/dns-check.js";

const IP = "203.0.113.7";
const now = new Date("2026-01-01T00:00:00Z");
const mins = (d: Date): number => (d.getTime() - now.getTime()) / 60_000;

describe("domain policy", () => {
  it("evaluateDns flags any AAAA as ipv6_conflict", () => {
    expect(evaluateDns({ a: [IP], aaaa: ["2001:db8::1"] }, IP)).toBe("ipv6_conflict");
    expect(evaluateDns({ a: [IP], aaaa: [] }, IP)).toBe("ok");
  });
  it("an A record set mixing this server and another is points_elsewhere", () => {
    expect(evaluateDns({ a: [IP, "198.51.100.1"], aaaa: [] }, IP)).toBe("points_elsewhere");
  });
  it("no A record is not_found", () => {
    expect(evaluateDns({ a: [], aaaa: ["2001:db8::1"] }, IP)).toBe("not_found");
  });
  it("retry schedule never retries a rate limit before 24 h", () => {
    for (let n = 0; n <= 10; n++) expect(mins(certRetryAt(now, "rate_limited", n))).toBeGreaterThanOrEqual(1440);
  });
  it("the other failures back off 15 min, 1 h, 3 h, 6 h, then daily (attempts counted before increment)", () => {
    expect([0, 1, 2, 3, 4, 9].map((n) => mins(certRetryAt(now, "other", n)))).toEqual([15, 60, 180, 360, 1440, 1440]);
  });
  it("DNS checks back off 1, 2, 5, 10, 30, 60 min, then 6 h, and every 6 h once ok", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((n) => mins(nextDnsCheckAt(now, "not_found", n)))).toEqual([1, 2, 5, 10, 30, 60, 360, 360]);
    expect(mins(nextDnsCheckAt(now, "ok", 5))).toBe(360);
  });
  it("manualCertRetryAt never allows two attempts within 15 min", () => {
    const T = new Date("2026-01-01T10:00:00Z");
    const row = {
      certStatus: "failed" as const,
      certProblem: "other" as const,
      certRequestedAt: T,
      certRetryAt: new Date(T.getTime() + 60 * 60_000),
    };
    const click = new Date(T.getTime() + 2 * 60_000);
    expect(manualCertRetryAt(click, row)).toEqual(new Date(T.getTime() + 15 * 60_000));
    expect(manualCertRetryAt(new Date(T.getTime() + 30 * 60_000), row)).toEqual(new Date(T.getTime() + 30 * 60_000));
    expect(manualCertRetryAt(click, { ...row, certProblem: "rate_limited" })).toBeNull();
    expect(manualCertRetryAt(click, { ...row, certStatus: "requested" })).toBeNull();
  });
  it("createNodeDnsLookup maps NODATA to an empty list and rethrows other errors", async () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    const make = (v6: () => Promise<string[]>): ResolverLike => ({
      setServers: () => undefined,
      resolve4: async () => [IP],
      resolve6: v6,
    });
    const ok = createNodeDnsLookup(["1.1.1.1"], () => make(() => Promise.reject(err(dns.NODATA))));
    expect(await ok.lookup("a.test")).toEqual({ a: [IP], aaaa: [] });
    const bad = createNodeDnsLookup(["1.1.1.1"], () => make(() => Promise.reject(err(dns.TIMEOUT))));
    await expect(bad.lookup("a.test")).rejects.toThrow();
  });
});
