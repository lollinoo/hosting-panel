import { describe, expect, it } from "vitest";
import {
  MANUAL_TLS_ACTIONS,
  MANUAL_TLS_RESULT_SCHEMAS,
  ManualTlsIpcRequestSchema,
  SiteHostRouteSchema,
  SiteRoutesIpcRequestSchema,
  TlsVersionIdSchema,
} from "../src/ipc-schemas.js";

const V1 = `ctv_${"a".repeat(32)}`;
const V2 = `ctv_${"b".repeat(32)}`;
const FP = "0".repeat(63) + "f";
const put = { action: "putVersion", versionId: V1, fullchainPem: "chain", keyPem: "key", fingerprintSha256: FP };
const publish = { action: "publish", baseGeneration: 3, entries: [{ versionId: V1, assignedHosts: ["shop.example.com"] }], expect: [{ hostname: "shop.example.com", fingerprintSha256: FP }] };
const ok = (value: unknown) => ManualTlsIpcRequestSchema.safeParse(value).success;

describe("SiteHostRoute source", () => {
  const route = { hostname: "shop.example.com", tls: true, httpsRedirect: true, redirectTo: null };
  it("accepts source manual and nothing else", () => {
    expect(SiteHostRouteSchema.safeParse({ ...route, source: "manual" }).success).toBe(true);
    expect(SiteHostRouteSchema.safeParse(route).success).toBe(true);
    expect(SiteHostRouteSchema.safeParse({ ...route, source: "acme" }).success).toBe(false);
    expect(SiteHostRouteSchema.safeParse({ ...route, source: "" }).success).toBe(false);
  });
  it("parses through the site routes request and keeps the source", () => {
    const parsed = SiteRoutesIpcRequestSchema.parse({
      siteId: "s",
      serviceInstanceId: "i",
      containerName: "c",
      internalPort: 80,
      hosts: [{ ...route, source: "manual" }],
    });
    expect(parsed.hosts[0]?.source).toBe("manual");
  });
  it("lets the schema pass source with challenge (the executor refuses the pair with VALIDATION_ERROR)", () => {
    expect(SiteHostRouteSchema.safeParse({ ...route, source: "manual", challenge: "dns-01" }).success).toBe(true);
  });
});

describe("ids and fingerprints", () => {
  it("TlsVersionIdSchema is ctv_ + 32 lowercase hex", () => {
    expect(TlsVersionIdSchema.safeParse(V1).success).toBe(true);
    for (const bad of ["", "ctv_", `ctv_${"A".repeat(32)}`, `ctv_${"a".repeat(31)}`, `ctv_${"a".repeat(33)}`, `cti_${"a".repeat(32)}`, `${V1}\n`, `../${V1}`]) {
      expect(TlsVersionIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
  it("fingerprints are 64 lowercase hex, without colons", () => {
    for (const bad of [FP.toUpperCase(), FP.slice(1), `${FP}0`, FP.match(/.{2}/g)?.join(":") ?? ""]) {
      expect(ok({ ...put, fingerprintSha256: bad }), bad).toBe(false);
    }
    expect(ok({ ...publish, expect: [{ hostname: "a", notFingerprintSha256: "x" }] })).toBe(false);
    expect(ok({ ...publish, expect: [{ hostname: "a", notFingerprintSha256: FP }] })).toBe(true);
  });
});

describe("ManualTlsIpcRequestSchema", () => {
  it("covers exactly the five actions", () => {
    expect([...MANUAL_TLS_ACTIONS]).toEqual(["putVersion", "publish", "probe", "inventory", "gc"]);
    expect(Object.keys(MANUAL_TLS_RESULT_SCHEMAS)).toEqual([...MANUAL_TLS_ACTIONS]);
  });

  it("accepts one valid request per action and defaults evictAcme to false", () => {
    for (const request of [put, publish, { action: "probe", hostnames: ["a.example.com"] }, { action: "inventory" }, { action: "gc", baseGeneration: 0 }]) {
      expect(ok(request), JSON.stringify(request).slice(0, 40)).toBe(true);
    }
    const parsed = ManualTlsIpcRequestSchema.parse(publish);
    expect(parsed.action === "publish" && parsed.evictAcme).toBe(false);
    expect(ManualTlsIpcRequestSchema.parse({ ...publish, evictAcme: true })).toMatchObject({ evictAcme: true });
  });

  it("is strict on every action and refuses unknown actions", () => {
    for (const request of [put, publish, { action: "probe", hostnames: ["a"] }, { action: "inventory" }, { action: "gc", baseGeneration: 0 }]) {
      expect(ok({ ...request, extra: 1 })).toBe(false);
    }
    expect(ok({ ...publish, entries: [{ versionId: V1, assignedHosts: ["a"], extra: 1 }] })).toBe(false);
    expect(ok({ ...publish, expect: [{ hostname: "a", extra: 1 }] })).toBe(false);
    expect(ok({ action: "delete" })).toBe(false);
    expect(ok({})).toBe(false);
  });

  it("limits the PEM sizes: fullchain 600000, key 64000, not empty", () => {
    expect(ok({ ...put, fullchainPem: "x".repeat(600_000) })).toBe(true);
    expect(ok({ ...put, fullchainPem: "x".repeat(600_001) })).toBe(false);
    expect(ok({ ...put, keyPem: "x".repeat(64_000) })).toBe(true);
    expect(ok({ ...put, keyPem: "x".repeat(64_001) })).toBe(false);
    expect(ok({ ...put, fullchainPem: "" })).toBe(false);
    expect(ok({ ...put, keyPem: "" })).toBe(false);
  });

  it("limits publish: 500 entries, 64 hosts per entry (at least 1), 200 expectations, generation >= 0", () => {
    const entries = (n: number) => Array.from({ length: n }, () => ({ versionId: V1, assignedHosts: ["a"] }));
    expect(ok({ ...publish, entries: entries(500) })).toBe(true);
    expect(ok({ ...publish, entries: entries(501) })).toBe(false);
    expect(ok({ ...publish, entries: [] })).toBe(true);
    expect(ok({ ...publish, entries: [{ versionId: V2, assignedHosts: [] }] })).toBe(false);
    expect(ok({ ...publish, entries: [{ versionId: V2, assignedHosts: Array.from({ length: 64 }, (_, i) => `h${i}`) }] })).toBe(true);
    expect(ok({ ...publish, entries: [{ versionId: V2, assignedHosts: Array.from({ length: 65 }, (_, i) => `h${i}`) }] })).toBe(false);
    const expectations = (n: number) => Array.from({ length: n }, (_, i) => ({ hostname: `h${i}`, fingerprintSha256: FP }));
    expect(ok({ ...publish, expect: expectations(200) })).toBe(true);
    expect(ok({ ...publish, expect: expectations(201) })).toBe(false);
    expect(ok({ ...publish, baseGeneration: -1 })).toBe(false);
    expect(ok({ ...publish, baseGeneration: 1.5 })).toBe(false);
    expect(ok({ ...publish, evictAcme: "yes" })).toBe(false);
  });

  it("bounds hostnames (1..253) and the probe list (1..200)", () => {
    expect(ok({ action: "probe", hostnames: [] })).toBe(false);
    expect(ok({ action: "probe", hostnames: [""] })).toBe(false);
    expect(ok({ action: "probe", hostnames: ["a".repeat(254)] })).toBe(false);
    expect(ok({ action: "probe", hostnames: Array.from({ length: 201 }, (_, i) => `h${i}`) })).toBe(false);
    expect(ok({ action: "gc", baseGeneration: -1 })).toBe(false);
  });

  it("rejects a malformed version id anywhere", () => {
    expect(ok({ ...put, versionId: "../x" })).toBe(false);
    expect(ok({ ...publish, entries: [{ versionId: "ctv_x", assignedHosts: ["a"] }] })).toBe(false);
  });
});

describe("MANUAL_TLS_RESULT_SCHEMAS", () => {
  const served = [{ hostname: "shop.example.com", fingerprintSha256: FP }, { hostname: "b.example.com", fingerprintSha256: null }];
  it("parses a result per action", () => {
    const s = MANUAL_TLS_RESULT_SCHEMAS;
    expect(s.putVersion.safeParse({ versionId: V1, written: false }).success).toBe(true);
    expect(
      s.publish.safeParse({
        generation: 4,
        outcome: "acme_eviction_required",
        served: [],
        violations: [{ kind: "acme_eviction_required", hostname: "shop", versionId: V1, blockerIds: ["acme:le:shop"] }],
        evicted: [{ resolver: "le", main: "shop" }],
        collateralHosts: ["other"],
      }).success,
    ).toBe(true);
    expect(s.probe.safeParse({ served }).success).toBe(true);
    expect(
      s.inventory.safeParse({
        generation: 2,
        verified: true,
        versions: [{ versionId: V1, fingerprintSha256: FP, notAfter: "2027-01-01T00:00:00.000Z", names: ["shop"] }],
        entries: [{ versionId: V1, assignedHosts: ["shop"] }],
        missing: [V2],
        acme: [{ id: "acme:le:shop", resolver: "le", names: ["shop"], notAfter: "2027-01-01T00:00:00Z" }],
      }).success,
    ).toBe(true);
    expect(s.gc.safeParse({ removed: [V2] }).success).toBe(true);
  });

  it("is strict, so a PEM or key field can never ride along", () => {
    expect(MANUAL_TLS_RESULT_SCHEMAS.putVersion.safeParse({ versionId: V1, written: true, keyPem: "k" }).success).toBe(false);
    expect(MANUAL_TLS_RESULT_SCHEMAS.probe.safeParse({ served: [{ hostname: "a", fingerprintSha256: FP, fullchainPem: "x" }] }).success).toBe(false);
  });

  it("refuses an unknown publish outcome or violation kind", () => {
    const base = { generation: 1, served: [], violations: [], evicted: [], collateralHosts: [] };
    expect(MANUAL_TLS_RESULT_SCHEMAS.publish.safeParse({ ...base, outcome: "ok" }).success).toBe(false);
    expect(MANUAL_TLS_RESULT_SCHEMAS.publish.safeParse({ ...base, outcome: "served" }).success).toBe(true);
    expect(
      MANUAL_TLS_RESULT_SCHEMAS.publish.safeParse({ ...base, outcome: "captures_host", violations: [{ kind: "nope", hostname: "a", versionId: null, blockerIds: [] }] }).success,
    ).toBe(false);
  });
});
