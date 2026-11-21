import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  findManualCaptures,
  planManualCertificates,
  servedCertificate,
  traefikCertificateKey,
  traefikCertificateNames,
  traefikNameMatches,
  type SniCertificate,
} from "../src/tls-sni.js";

const acme = (id: string, ...names: string[]): SniCertificate => ({ id, source: "acme", names });
const manual = (id: string, ...names: string[]): SniCertificate => ({ id, source: "manual", names });
const entry = (versionId: string, names: string[], assignedHosts: string[]) => ({ versionId, names, assignedHosts });
const kinds = (plan: ReturnType<typeof planManualCertificates>) => plan.violations.map((v) => `${v.kind}:${v.hostname}`);

describe("traefik names and keys", () => {
  it("indexes the CN once, the DNS SANs that differ from it, and the IPs (the quirk compares raw case)", () => {
    expect(traefikCertificateNames({ commonName: "Shop", dnsNames: ["shop", "zz.shop", "Shop"], ipAddresses: ["10.0.0.1"] })).toEqual([
      "shop",
      "shop",
      "zz.shop",
      "10.0.0.1",
    ]);
  });

  it("skips a SAN equal to the CN (E13) and keeps a CN that is not a SAN (E14)", () => {
    expect(traefikCertificateNames({ commonName: "shop", dnsNames: ["shop", "zz.shop"] })).toEqual(["shop", "zz.shop"]);
    expect(traefikCertificateNames({ commonName: "plain", dnsNames: ["zzz"] })).toEqual(["plain", "zzz"]);
    expect(traefikCertificateNames({ commonName: "", dnsNames: ["a.test"] })).toEqual(["a.test"]);
    expect(traefikCertificateNames({ commonName: null, dnsNames: ["a.test"] })).toEqual(["a.test"]);
  });

  it("sorts in byte order, so '*' is below every hostname", () => {
    expect(traefikCertificateKey(["zz.shop", "shop"])).toBe("shop,zz.shop");
    expect(traefikCertificateKey(["a.w", "*.w"])).toBe("*.w,a.w");
    expect(traefikCertificateKey(["*.w"]) < traefikCertificateKey(["a.w"])).toBe(true);
  });

  it("matches exact names and one-level wildcards only (E5)", () => {
    expect(traefikNameMatches("b.w", "*.w")).toBe(true);
    expect(traefikNameMatches("B.W", "*.w")).toBe(true);
    expect(traefikNameMatches("x.b.w", "*.w")).toBe(false);
    expect(traefikNameMatches("w", "*.w")).toBe(false);
    expect(traefikNameMatches("e.w", "e.w")).toBe(true);
    expect(traefikNameMatches("e.w", "f.w")).toBe(false);
    expect(traefikNameMatches("shop", "shop.")).toBe(false);
    expect(traefikNameMatches("b.w", "*.w.")).toBe(true);
  });
});

describe("servedCertificate", () => {
  it("returns nothing when no name matches", () => {
    expect(servedCertificate("x.test", [manual("m", "a.test")])).toEqual({ winner: null, tie: [] });
  });

  it("E1: equal keys are a tie, no winner", () => {
    const m = manual("m", "shop");
    const a = acme("a", "shop");
    expect(servedCertificate("shop", [a, m])).toEqual({ winner: null, tie: [a, m] });
  });

  it("E2: the superset (higher key) wins", () => {
    const m = manual("m", "shop", "zz.shop");
    expect(servedCertificate("shop", [m, acme("a", "shop")]).winner).toBe(m);
  });

  it("E3: the lower key loses", () => {
    const a = acme("a", "shop");
    expect(servedCertificate("shop", [manual("m", "aa", "shop"), a]).winner).toBe(a);
  });

  it("E5: an exact certificate beats a wildcard, the wildcard serves the other siblings", () => {
    const all = [manual("wild", "*.w"), manual("exact", "e.w"), acme("a", "a.w")];
    expect(servedCertificate("e.w", all).winner?.id).toBe("exact");
    expect(servedCertificate("a.w", all).winner?.id).toBe("a");
    expect(servedCertificate("b.w", all).winner?.id).toBe("wild");
    expect(servedCertificate("x.b.w", all).winner).toBeNull();
    expect(servedCertificate("w", all).winner).toBeNull();
  });

  it("E14: a CN-only name takes part in the key", () => {
    const cn = manual("cn", "plain", "zzz");
    expect(servedCertificate("plain", [cn, acme("a", "plain")]).winner).toBe(cn);
  });
});

describe("planManualCertificates", () => {
  it("accepts a manual superset over ACME (E2) and a lower-key ACME sibling that stays (E5/E7)", () => {
    const plan = planManualCertificates({
      entries: [entry("m1", ["*.w", "e.w"], ["e.w"])],
      acme: [acme("a1", "a.w")],
      guardHosts: ["a.w"],
    });
    expect(plan).toEqual({ violations: [], evictAcmeIds: [], collateralHosts: [] });
    const superset = planManualCertificates({
      entries: [entry("m1", ["shop", "zz.shop"], ["shop"])],
      acme: [acme("a1", "shop")],
      guardHosts: [],
    });
    expect(superset.violations).toEqual([]);
  });

  it("E1: an equal-key ACME certificate needs eviction, and names the ACME ids", () => {
    const plan = planManualCertificates({ entries: [entry("m1", ["shop"], ["shop"])], acme: [acme("a1", "shop")], guardHosts: [] });
    expect(plan.violations).toEqual([{ kind: "acme_eviction_required", hostname: "shop", versionId: "m1", blockerIds: ["a1"] }]);
    expect(plan.evictAcmeIds).toEqual(["a1"]);
    expect(plan.collateralHosts).toEqual([]);
  });

  it("E3: a lower-key manual certificate loses to ACME, eviction required", () => {
    const plan = planManualCertificates({ entries: [entry("m1", ["aa", "shop"], ["shop"])], acme: [acme("a1", "shop")], guardHosts: [] });
    expect(kinds(plan)).toEqual(["acme_eviction_required:shop"]);
  });

  it("E4/eviction collateral: the evicted entry's other names fall back to ACME and are guarded (R2)", () => {
    const ok = planManualCertificates({
      entries: [entry("m1", ["shop"], ["shop"])],
      acme: [acme("a1", "shop", "zz")],
      guardHosts: [],
    });
    expect(ok.evictAcmeIds).toEqual(["a1"]);
    expect(ok.collateralHosts).toEqual(["zz"]);
    expect(kinds(ok)).toEqual(["acme_eviction_required:shop"]);
    const captured = planManualCertificates({
      entries: [entry("m1", ["shop"], ["shop"]), entry("wild", ["*.t"], ["a.t"])],
      acme: [acme("a1", "shop", "x.t")],
      guardHosts: [],
    });
    expect(captured.collateralHosts).toEqual(["x.t"]);
    expect(kinds(captured)).toEqual(["acme_eviction_required:shop", "captures_host:x.t"]);
  });

  it("R1: another manual entry in the way is manual_overlap, never an eviction", () => {
    const plan = planManualCertificates({
      entries: [entry("m1", ["shop"], ["shop"]), entry("m2", ["shop", "zz.shop"], ["zz.shop"])],
      acme: [],
      guardHosts: [],
    });
    expect(plan.violations).toContainEqual({ kind: "manual_overlap", hostname: "shop", versionId: "m1", blockerIds: ["m2"] });
    expect(plan.evictAcmeIds).toEqual([]);
  });

  it("R3: two manual entries with the same key overlap even on different hosts", () => {
    const plan = planManualCertificates({
      entries: [entry("m1", ["a.test", "b.test"], ["a.test"]), entry("m2", ["b.test", "a.test"], ["b.test"])],
      acme: [],
      guardHosts: [],
    });
    expect(plan.violations).toEqual([
      { kind: "manual_overlap", hostname: "a.test", versionId: "m1", blockerIds: ["m2"] },
      { kind: "manual_overlap", hostname: "b.test", versionId: "m2", blockerIds: ["m1"] },
    ]);
  });

  it("E6: a routed host (new ACME sibling) under a loaded wildcard is captured", () => {
    const plan = planManualCertificates({ entries: [entry("wild", ["*.w"], ["b.w"])], acme: [], guardHosts: ["c.w"] });
    expect(plan.violations).toEqual([{ kind: "captures_host", hostname: "c.w", versionId: "wild", blockerIds: ["wild"] }]);
  });

  it("E12: back to ACME while a manual wildcard still covers the host is captured", () => {
    const plan = planManualCertificates({ entries: [entry("wild", ["*.w"], ["d.w"])], acme: [], guardHosts: ["b.w"] });
    expect(kinds(plan)).toEqual(["captures_host:b.w"]);
  });

  it("E13/E14: a CN capture of another host is refused", () => {
    const names = traefikCertificateNames({ commonName: "plain", dnsNames: ["zzz"] });
    const plan = planManualCertificates({
      entries: [entry("cn", names, ["zzz"])],
      acme: [acme("a1", "plain")],
      guardHosts: ["plain"],
    });
    expect(plan.violations).toEqual([{ kind: "captures_host", hostname: "plain", versionId: "cn", blockerIds: ["cn"] }]);
  });

  it("E1 on a guard host: a manual/ACME tie is a capture risk", () => {
    const plan = planManualCertificates({ entries: [entry("m1", ["g.test"], ["x.test"])], acme: [acme("a1", "g.test")], guardHosts: ["g.test"] });
    expect(kinds(plan)).toEqual(["captures_host:g.test"]);
  });

  it("the panel host as guard: a manual wildcard covering it is refused, an exact ACME entry beats it", () => {
    const wild = [entry("wild", ["*.example.com"], ["a.example.com"])];
    expect(planManualCertificates({ entries: wild, acme: [], guardHosts: ["panel.example.com"] }).violations).toHaveLength(1);
    expect(planManualCertificates({ entries: wild, acme: [acme("p", "panel.example.com")], guardHosts: ["panel.example.com"] }).violations).toEqual([]);
  });

  it("E15: an empty manual set has nothing to refuse", () => {
    expect(planManualCertificates({ entries: [], acme: [acme("a", "shop")], guardHosts: ["shop"] })).toEqual({
      violations: [],
      evictAcmeIds: [],
      collateralHosts: [],
    });
  });

  it("an assigned host is never also a guard host", () => {
    const plan = planManualCertificates({ entries: [entry("m1", ["*.w"], ["b.w"])], acme: [], guardHosts: ["b.w"] });
    expect(plan.violations).toEqual([]);
  });
});

describe("findManualCaptures", () => {
  const wild = [{ versionId: "wild", names: ["*.w"] }];
  it("E6: a new sibling under a loaded wildcard is captured", () => {
    expect(findManualCaptures("c.w", wild, [])).toEqual(["wild"]);
  });
  it("E5/E7: an existing exact ACME certificate keeps winning", () => {
    expect(findManualCaptures("a.w", wild, [acme("a", "a.w")])).toEqual([]);
  });
  it("E12: back to ACME, another loaded entry still covers the host", () => {
    expect(findManualCaptures("b.w", wild, [])).toEqual(["wild"]);
  });
  it("is empty for an uncovered host, and names every manual entry of a tie", () => {
    expect(findManualCaptures("x.b.w", wild, [])).toEqual([]);
    expect(findManualCaptures("shop", [{ versionId: "m", names: ["shop"] }], [acme("a", "shop")])).toEqual(["m"]);
  });
});

describe("browser safety", () => {
  it("imports nothing from node:", () => {
    const source = readFileSync(new URL("../src/tls-sni.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/^import\s/m);
  });
});
