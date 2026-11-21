import { createHash } from "node:crypto";
import dns from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseClient, DomainRow } from "@hosting-panel/database";
import { AppModule } from "../src/app.module.js";
import type { ControlPlaneRuntimeConfig } from "../src/tokens.js";
import { DNS_LOOKUP_TOKEN } from "../src/tokens.js";
import {
  buildSiteHostRoutes,
  certRetryAt,
  desiredWordpressUrl,
  evaluateDns,
  manualCertRetryAt,
  nextDnsCheckAt,
  routePlanHash,
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
    // Fail closed: without a request time the 15-min gap cannot be enforced.
    expect(manualCertRetryAt(click, { ...row, certRequestedAt: null })).toBeNull();
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

describe("route plan challenge", () => {
  const row = (hostname: string, over: Partial<DomainRow> = {}): DomainRow =>
    ({
      hostname,
      isPrimary: hostname === "a.test",
      status: "active",
      certStatus: "requested",
      certExpiresAt: null,
      certChallenge: "http-01",
      ...over,
    }) as DomainRow;

  it("routes carry challenge only for dns-01 TLS hosts", () => {
    const hosts = buildSiteHostRoutes(
      [row("a.test", { certChallenge: "dns-01" }), row("b.test"), row("c.test", { certChallenge: "dns-01", certStatus: "none" })],
      now,
    );
    expect(hosts.map((h) => h.challenge)).toEqual(["dns-01", undefined, undefined]);
    expect("challenge" in hosts[1]!).toBe(false);
    expect(buildSiteHostRoutes([row("a.test", { certChallenge: "dns-01" })], now, { acmeEnabled: false })[0]).not.toHaveProperty("challenge");
  });

  it("the plan hash of http-01 routes is unchanged; a dns-01 host changes it", () => {
    const http = buildSiteHostRoutes([row("a.test"), row("b.test")], now);
    const legacy = createHash("sha256")
      .update(JSON.stringify({ hosts: http.map((h) => [h.hostname, h.tls, h.httpsRedirect, h.redirectTo]), wordpressUrl: "https://a.test" }))
      .digest("hex");
    expect(routePlanHash(http, "https://a.test")).toBe(legacy);
    const dns01 = buildSiteHostRoutes([row("a.test", { certChallenge: "dns-01" }), row("b.test")], now);
    expect(routePlanHash(dns01, "https://a.test")).not.toBe(legacy);
  });
});

describe("app module DNS lookup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["HP_DNS_RESOLVERS"];
  });

  it("the default lookup uses HP_DNS_RESOLVERS", async () => {
    process.env["HP_DNS_RESOLVERS"] = "127.0.0.1:5353";
    const servers = vi.spyOn(dns.promises.Resolver.prototype, "setServers").mockImplementation(() => undefined);
    vi.spyOn(dns.promises.Resolver.prototype, "resolve4").mockResolvedValue([]);
    vi.spyOn(dns.promises.Resolver.prototype, "resolve6").mockResolvedValue([]);
    const mod = AppModule.register({ config: {} as ControlPlaneRuntimeConfig, dbClient: {} as DatabaseClient });
    const provider = mod.providers!.find((p) => typeof p === "object" && "provide" in p && p.provide === DNS_LOOKUP_TOKEN);
    const lookup = (provider as { useValue: { lookup(h: string): Promise<unknown> } }).useValue;
    await lookup.lookup("hotel.it");
    expect(servers).toHaveBeenCalledWith(["127.0.0.1:5353"]);
  });
});

describe("route plan of manual hosts", () => {
  const row = (hostname: string, over: Partial<DomainRow> = {}): DomainRow =>
    ({
      hostname,
      isPrimary: hostname === "a.test",
      status: "active",
      certMode: "acme",
      certStatus: "none",
      certExpiresAt: null,
      certChallenge: "http-01",
      ...over,
    }) as DomainRow;
  const manual = (hostname: string, over: Partial<DomainRow> = {}): DomainRow =>
    row(hostname, { certMode: "manual", certStatus: "active", certExpiresAt: new Date("2027-01-01T00:00:00Z"), ...over });

  it("a manual host serves https with a redirect, with or without ACME", () => {
    for (const acmeEnabled of [true, false]) {
      expect(buildSiteHostRoutes([manual("a.test")], now, { acmeEnabled })).toEqual([
        { hostname: "a.test", tls: true, httpsRedirect: true, redirectTo: null, source: "manual" },
      ]);
    }
  });

  it("an expired or still pending manual certificate keeps https (no silent fallback)", () => {
    for (const over of [{ certExpiresAt: new Date("2025-01-01T00:00:00Z") }, { certStatus: "none" as const, certExpiresAt: null }]) {
      const [h] = buildSiteHostRoutes([manual("a.test", over)], now);
      expect(h).toMatchObject({ tls: true, httpsRedirect: true, source: "manual" });
    }
  });

  it("a manual host never carries a challenge and the transition plan does not redirect", () => {
    const [h] = buildSiteHostRoutes([manual("a.test", { certChallenge: "dns-01" })], now, { transition: true });
    expect(h).toEqual({ hostname: "a.test", tls: true, httpsRedirect: false, redirectTo: null, source: "manual" });
    expect(h).not.toHaveProperty("challenge");
  });

  it("an ACME row has no source key and a manual primary is the https redirect target", () => {
    const hosts = buildSiteHostRoutes([manual("a.test"), row("b.test")], now, { acmeEnabled: false });
    expect(hosts[1]).toEqual({ hostname: "b.test", tls: false, httpsRedirect: false, redirectTo: "https://a.test" });
    expect("source" in hosts[1]!).toBe(false);
  });

  it("a manual non-primary redirects to an http primary only as the primary says", () => {
    const hosts = buildSiteHostRoutes([row("a.test"), manual("b.test")], now, { acmeEnabled: false });
    expect(hosts[0]).toMatchObject({ tls: false, redirectTo: null });
    expect(hosts[1]).toMatchObject({ tls: true, httpsRedirect: true, redirectTo: "http://a.test", source: "manual" });
  });

  it("desiredWordpressUrl is https for a manual primary, even without ACME", () => {
    expect(desiredWordpressUrl([manual("a.test")], now, "http://a.test", false)).toBe("https://a.test");
    expect(desiredWordpressUrl([manual("a.test", { certStatus: "none", certExpiresAt: null })], now, null, false)).toBe("https://a.test");
    expect(desiredWordpressUrl([row("a.test")], now, null, false)).toBe("http://a.test");
  });

  it("the hash differs for a manual host and an ACME host stays byte-identical", () => {
    const acme = buildSiteHostRoutes([row("a.test", { certStatus: "active", certExpiresAt: new Date("2027-01-01T00:00:00Z") })], now);
    const legacy = createHash("sha256")
      .update(JSON.stringify({ hosts: acme.map((h) => [h.hostname, h.tls, h.httpsRedirect, h.redirectTo]), wordpressUrl: "https://a.test" }))
      .digest("hex");
    expect(routePlanHash(acme, "https://a.test")).toBe(legacy);
    const man = buildSiteHostRoutes([manual("a.test")], now);
    expect(man[0]).toMatchObject({ tls: true, httpsRedirect: true, redirectTo: null });
    expect(routePlanHash(man, "https://a.test")).not.toBe(legacy);
    expect(routePlanHash(man, "https://a.test")).toBe(
      createHash("sha256")
        .update(JSON.stringify({ hosts: [["a.test", true, true, null, "manual"]], wordpressUrl: "https://a.test" }))
        .digest("hex"),
    );
  });
});
