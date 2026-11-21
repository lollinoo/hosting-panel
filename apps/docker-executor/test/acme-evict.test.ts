import { mkdtemp, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evictAcmeEntries, readAcmeStoreEntries } from "../src/acme-status.js";

// Self-signed P-256 leaves, notAfter 2126-10-28 (openssl req -x509 -days 36500), base64 of the PEM as Traefik stores them.
const SHOP = "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUJ4ekNDQVd5Z0F3SUJBZ0lVTTZHTmJEbjRUU3IxMG55UXBqcmRDbitiQit3d0NnWUlLb1pJemowRUF3SXcKSERFYU1CZ0dBMVVFQXd3UmMyaHZjQzVsZUdGdGNHeGxMblJsYzNRd0lCY05Nall4TVRJeE1ERXpPREUzV2hnUApNakV5TmpFd01qZ3dNVE00TVRkYU1Cd3hHakFZQmdOVkJBTU1FWE5vYjNBdVpYaGhiWEJzWlM1MFpYTjBNRmt3CkV3WUhLb1pJemowQ0FRWUlLb1pJemowREFRY0RRZ0FFbDduMmRZV1BjZjJXSWZlRXljR29ZWjMyaGQ3SE0zcGcKUFlNZkdLQURsYjBhVTlhQWVWSjV4OFZaSkxObXR4dkwwdVlJM1doejR3ekExb2JseExZT0RLT0JpVENCaGpBZApCZ05WSFE0RUZnUVVMZngrejl3NjU4Z1Fqb1dKQnBaZ3pRME4xTUl3SHdZRFZSMGpCQmd3Rm9BVUxmeCt6OXc2CjU4Z1Fqb1dKQnBaZ3pRME4xTUl3RHdZRFZSMFRBUUgvQkFVd0F3RUIvekF6QmdOVkhSRUVMREFxZ2hGemFHOXcKTG1WNFlXMXdiR1V1ZEdWemRJSVZkM2QzTG5Ob2IzQXVaWGhoYlhCc1pTNTBaWE4wTUFvR0NDcUdTTTQ5QkFNQwpBMGtBTUVZQ0lRRG5RbTJsU0V4UC8yU0JwUzVOSm56MUdaUXQzLzMxTDFYUXg2RFcvWlFpdXdJaEFPY1ZiMk9pCnI4VWwwQlM2MStTUFQrWFJpS29RczRIN2I4a0J6ZXJNUUhaMAotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg=="; // CN shop.example.test, SAN shop + www.shop
const WILD = "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUJ1ekNDQVdHZ0F3SUJBZ0lVWk52T0FpOE55UENxYWl3TzNzUnNtcDl6WWx3d0NnWUlLb1pJemowRUF3SXcKR3pFWk1CY0dBMVVFQXd3UUtpNTNMbVY0WVcxd2JHVXVkR1Z6ZERBZ0Z3MHlOakV4TWpFd01UTTRNVGRhR0E4eQpNVEkyTVRBeU9EQXhNemd4TjFvd0d6RVpNQmNHQTFVRUF3d1FLaTUzTG1WNFlXMXdiR1V1ZEdWemREQlpNQk1HCkJ5cUdTTTQ5QWdFR0NDcUdTTTQ5QXdFSEEwSUFCTDJ2U091Z3NzSytEZFNTK3J5cDcrRG1HUCtwRTA1ZDJkdGwKazAzZ0NTTUdEMzMxY2hIWHlnalpDQTNzUWtuS2IyY25TRkwwSTVqQmNKUU1yNmZRNVBHamdZQXdmakFkQmdOVgpIUTRFRmdRVXFlb2J1ZTBxVjg5L0hyNGUwcWFYRkYyM25IVXdId1lEVlIwakJCZ3dGb0FVcWVvYnVlMHFWODkvCkhyNGUwcWFYRkYyM25IVXdEd1lEVlIwVEFRSC9CQVV3QXdFQi96QXJCZ05WSFJFRUpEQWlnaEFxTG5jdVpYaGgKYlhCc1pTNTBaWE4wZ2c1M0xtVjRZVzF3YkdVdWRHVnpkREFLQmdncWhrak9QUVFEQWdOSUFEQkZBaUVBbEZnVQphN2xzcmZUWk1GZDk5dUQ5dDMreCtMNDhtK01NUTQwbHlUQjRuc1VDSUV2aEc2M2lPMFRTU2paQVVzb3hjcjhnCk1ZQjljdTNHWVZVMzBwcHFmNDRHCi0tLS0tRU5EIENFUlRJRklDQVRFLS0tLS0K"; // CN *.w.example.test, SAN *.w + w
const CN_ONLY = "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUJxekNDQVZDZ0F3SUJBZ0lVSlBuckZxSmkwb1cxMmhUNWh2dk40M215bTBRd0NnWUlLb1pJemowRUF3SXcKR2pFWU1CWUdBMVVFQXd3UFkyNHVaWGhoYlhCc1pTNTBaWE4wTUNBWERUSTJNVEV5TVRBeE16Z3hOMW9ZRHpJeApNall4TURJNE1ERXpPREUzV2pBYU1SZ3dGZ1lEVlFRRERBOWpiaTVsZUdGdGNHeGxMblJsYzNRd1dUQVRCZ2NxCmhrak9QUUlCQmdncWhrak9QUU1CQndOQ0FBVG9IN1B1ZVZsWkwybVhWMEszQ0RBOEJQcFNLemNkV0U5K3M4cysKQy8vbVFUVVhLZWlnVm5keXR0K0ovSHcvaWFrZUt6SkltN3ZwMlZzdWp4bUcraVFkbzNJd2NEQWRCZ05WSFE0RQpGZ1FVaENoTlV1YitMRi9PQTZrdTJDUDI3WXN5Tlhrd0h3WURWUjBqQkJnd0ZvQVVoQ2hOVXViK0xGL09BNmt1CjJDUDI3WXN5Tlhrd0R3WURWUjBUQVFIL0JBVXdBd0VCL3pBZEJnTlZIUkVFRmpBVWdoSnZkR2hsY2k1bGVHRnQKY0d4bExuUmxjM1F3Q2dZSUtvWkl6ajBFQXdJRFNRQXdSZ0loQU1lcW1Ba1NMZ2lOU01LNVhjMERmWDdVUDlHcQpQRGIraVN1M2pGckNxT2k2QWlFQXkzcDY5TUpnM0VHaFVPYVJaaEJRTFQ4NHBHeGt3OFUwbEVUdGdLMVQxRkU9Ci0tLS0tRU5EIENFUlRJRklDQVRFLS0tLS0K"; // CN cn.example.test, SAN other.example.test (CN is not a SAN)
const PLAIN = "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUJyekNDQVZhZ0F3SUJBZ0lVZEZzMEQ3RWFTa0ZBM2R1VVV4TlE0VkJJTnFNd0NnWUlLb1pJemowRUF3SXcKSFRFYk1Ca0dBMVVFQXd3U2NHeGhhVzR1WlhoaGJYQnNaUzUwWlhOME1DQVhEVEkyTVRFeU1UQXhNemd4TjFvWQpEekl4TWpZeE1ESTRNREV6T0RFM1dqQWRNUnN3R1FZRFZRUUREQkp3YkdGcGJpNWxlR0Z0Y0d4bExuUmxjM1F3CldUQVRCZ2NxaGtqT1BRSUJCZ2dxaGtqT1BRTUJCd05DQUFRbkg3cXJBRytIRHVVMmdweDhVVkRCS0lHcGpPVjIKNG5Cdmk2ZlVLR3JBYVdBZFkxQllWeHlWbW13TDY5RlJSTi82M3hwUWtpQTc5SkxkeklkQWdEWTZvM0l3Y0RBZApCZ05WSFE0RUZnUVVsZUtKeTVMdkJlRXV3bTNlbnIxbUF5UmhJeWd3SHdZRFZSMGpCQmd3Rm9BVWxlS0p5NUx2CkJlRXV3bTNlbnIxbUF5UmhJeWd3RHdZRFZSMFRBUUgvQkFVd0F3RUIvekFkQmdOVkhSRUVGakFVZ2hKd2JHRnAKYmk1bGVHRnRjR3hsTG5SbGMzUXdDZ1lJS29aSXpqMEVBd0lEUndBd1JBSWdEUG9ZZjRxK3lCb0dTbGNUdUVhVgpJSmx3QVo1WG54bFVBaXNRb0dxc28wd0NJQ0JPQmpaNW5ESDhNVUtSOXlxOHBxVkNwWTY0VXd6NzhMd1B1MmEyCnRibTcKLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQo="; // CN and SAN plain.example.test
const NOT_AFTER = "2126-10-28T01:38:17.000Z";

// domain.main/sans are deliberately NOT the leaf names unless a test says so: names come from the leaf.
const entry = (main: string, certificate: string, sans?: string[]) => ({
  domain: sans ? { main, sans } : { main },
  certificate,
  key: "KEY-" + main,
  Store: "default",
});

const STORE = {
  le: {
    Account: { Email: "ops@example.test", PrivateKey: "ACCOUNT-KEY" },
    Certificates: [entry("shop.example.test", SHOP), entry("plain.example.test", PLAIN)],
  },
  "le-dns": {
    Account: { Email: "ops@example.test", PrivateKey: "DNS-ACCOUNT-KEY" },
    Certificates: [entry("w.example.test", WILD), entry("unrelated.example.test", CN_ONLY, [])],
  },
};

async function writeStore(store: unknown, mode = 0o600): Promise<{ dir: string; file: string; raw: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acme-evict-"));
  const file = path.join(dir, "acme.json");
  const raw = typeof store === "string" ? store : JSON.stringify(store, null, 2);
  await writeFile(file, raw, { mode });
  return { dir, file, raw };
}

const backups = async (dir: string) => (await readdir(dir)).filter((f) => f.includes(".hp-evict-")).sort();

describe("readAcmeStoreEntries", () => {
  it("lists le and le-dns entries with resolver#index ids, names from the leaf (CN included) and expiry", async () => {
    const { file } = await writeStore(STORE);
    const result = await readAcmeStoreEntries(file);
    expect(result.readable).toBe(true);
    expect(result.entries).toEqual([
      { id: "le#0", resolver: "le", main: "shop.example.test", names: ["shop.example.test", "www.shop.example.test"], notAfter: NOT_AFTER },
      { id: "le#1", resolver: "le", main: "plain.example.test", names: ["plain.example.test"], notAfter: NOT_AFTER },
      { id: "le-dns#0", resolver: "le-dns", main: "w.example.test", names: ["*.w.example.test", "w.example.test"], notAfter: NOT_AFTER },
      // Traefik keys on the CN even when it is not a SAN, and main/sans of the store entry are not consulted.
      { id: "le-dns#1", resolver: "le-dns", main: "unrelated.example.test", names: ["cn.example.test", "other.example.test"], notAfter: NOT_AFTER },
    ]);
  });

  it("never returns key material", async () => {
    const { file } = await writeStore(STORE);
    const out = JSON.stringify(await readAcmeStoreEntries(file));
    expect(out).not.toContain("KEY-");
    expect(out).not.toContain("ACCOUNT-KEY");
  });

  it("a missing resolver is readable and empty; other resolvers are ignored", async () => {
    const { file } = await writeStore({ other: { Certificates: [entry("x", SHOP)] } });
    expect(await readAcmeStoreEntries(file)).toEqual({ readable: true, entries: [] });
  });

  it("an unreadable file, garbage, an empty file or an unparsable leaf reads as unreadable, never as empty", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acme-evict-"));
    expect(await readAcmeStoreEntries(path.join(dir, "missing.json"))).toEqual({ readable: false, entries: [] });
    for (const raw of ['{"le":{"Certificates":[{"dom', "", "  \n", "[]", "null"]) {
      const { file } = await writeStore(raw);
      expect(await readAcmeStoreEntries(file)).toEqual({ readable: false, entries: [] });
    }
    const bad = await writeStore({ le: { Certificates: [entry("a.example.test", Buffer.from("nope").toString("base64"))] } });
    expect(await readAcmeStoreEntries(bad.file)).toEqual({ readable: false, entries: [] });
  });
});

describe("evictAcmeEntries", () => {
  const now = new Date("2026-11-21T10:15:30.123Z");

  it("removes only the covering entries, backs up byte-identically with 0600 and rewrites 0600", async () => {
    const { dir, file, raw } = await writeStore(STORE, 0o644);
    const result = await evictAcmeEntries(file, ["shop.example.test"], now);
    expect(result.evicted).toEqual([
      { id: "le#0", resolver: "le", main: "shop.example.test", names: ["shop.example.test", "www.shop.example.test"] },
    ]);
    // The other name of the evicted certificate stays ACME and is re-ordered at start.
    expect(result.collateralHosts).toEqual(["www.shop.example.test"]);

    const backupName = "acme.json.hp-evict-20261121T101530Z.bak";
    expect(result.backupPath).toBe(path.join(dir, backupName));
    expect(await backups(dir)).toEqual([backupName]);
    expect((await readFile(result.backupPath!)).toString("utf8")).toBe(raw);
    expect((await stat(result.backupPath!)).mode & 0o777).toBe(0o600);

    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.le.Certificates).toEqual(STORE.le.Certificates.slice(1));
    expect(after["le-dns"]).toEqual(STORE["le-dns"]); // accounts and the other resolver untouched
    expect(after.le.Account).toEqual(STORE.le.Account);
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("a one-level wildcard entry covers the host; the apex and deeper names are collateral", async () => {
    const { file } = await writeStore(STORE);
    const result = await evictAcmeEntries(file, ["x.w.example.test", "PLAIN.example.test"], now);
    expect(result.evicted.map((e) => e.id)).toEqual(["le#1", "le-dns#0"]);
    expect(result.collateralHosts).toEqual(["w.example.test"]);
    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after.le.Certificates.map((c: { domain: { main: string } }) => c.domain.main)).toEqual(["shop.example.test"]);
    expect(after["le-dns"].Certificates).toHaveLength(1);
  });

  it("does not let a wildcard cover two levels or the apex", async () => {
    const { file, raw } = await writeStore(STORE);
    const result = await evictAcmeEntries(file, ["a.b.w.example.test"], now);
    expect(result).toEqual({ backupPath: null, evicted: [], collateralHosts: [] });
    expect(await readFile(file, "utf8")).toBe(raw);
  });

  it("matches the CN of the leaf even when it is not a SAN and ignores domain.main/sans", async () => {
    const { file } = await writeStore(STORE);
    const byCn = await evictAcmeEntries(file, ["cn.example.test"], now);
    expect(byCn.evicted.map((e) => e.id)).toEqual(["le-dns#1"]);
    expect(byCn.collateralHosts).toEqual(["other.example.test"]);

    const second = await writeStore(STORE);
    const byMain = await evictAcmeEntries(second.file, ["unrelated.example.test"], now);
    expect(byMain.evicted).toEqual([]); // main of the store entry is not a name of its leaf
  });

  it("nothing matching writes nothing: no backup, store bytes and mode untouched", async () => {
    const { dir, file, raw } = await writeStore(STORE, 0o644);
    const result = await evictAcmeEntries(file, ["nobody.example.test"], now);
    expect(result).toEqual({ backupPath: null, evicted: [], collateralHosts: [] });
    expect(await readFile(file, "utf8")).toBe(raw);
    expect((await stat(file)).mode & 0o777).toBe(0o644);
    expect(await backups(dir)).toEqual([]);
  });

  it("keeps the newest 5 backups and leaves unrelated files alone", async () => {
    const { dir, file } = await writeStore(STORE);
    const stamps = ["20260101T000000Z", "20260102T000000Z", "20260103T000000Z", "20260104T000000Z", "20260105T000000Z", "20260106T000000Z"];
    for (const stamp of stamps) {
      const backup = path.join(dir, `acme.json.hp-evict-${stamp}.bak`);
      await writeFile(backup, "old");
      await utimes(backup, new Date(0), new Date(0)); // retention goes by the stamp, not the mtime
    }
    await writeFile(path.join(dir, "acme.json.hp-evict-note.bak"), "keep");
    await writeFile(path.join(dir, "other.json.hp-evict-20200101T000000Z.bak"), "keep");
    await evictAcmeEntries(file, ["shop.example.test"], now);
    expect(await backups(dir)).toEqual([
      "acme.json.hp-evict-20260103T000000Z.bak",
      "acme.json.hp-evict-20260104T000000Z.bak",
      "acme.json.hp-evict-20260105T000000Z.bak",
      "acme.json.hp-evict-20260106T000000Z.bak",
      "acme.json.hp-evict-20261121T101530Z.bak",
      "acme.json.hp-evict-note.bak",
      "other.json.hp-evict-20200101T000000Z.bak",
    ]);
  });

  it("refuses an unparsable store without writing anything", async () => {
    for (const raw of ['{"le":{"Certificates":[{"dom', "", "[]"]) {
      const { dir, file } = await writeStore(raw);
      await expect(evictAcmeEntries(file, ["shop.example.test"], now)).rejects.toThrow(/acme/i);
      expect(await readFile(file, "utf8")).toBe(raw);
      expect(await backups(dir)).toEqual([]);
    }
  });

  it("refuses when any entry has an unparsable leaf, even one that is not asked for", async () => {
    const { dir, file, raw } = await writeStore({
      le: { Certificates: [entry("shop.example.test", SHOP), entry("broken.example.test", Buffer.from("nope").toString("base64"))] },
    });
    await expect(evictAcmeEntries(file, ["shop.example.test"], now)).rejects.toThrow(/acme/i);
    expect(await readFile(file, "utf8")).toBe(raw);
    expect(await backups(dir)).toEqual([]);
  });

  it("a missing store has nothing to evict", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acme-evict-"));
    const result = await evictAcmeEntries(path.join(dir, "acme.json"), ["shop.example.test"], now);
    expect(result).toEqual({ backupPath: null, evicted: [], collateralHosts: [] });
    expect(await readdir(dir)).toEqual([]);
  });

  it("never leaks key material in the refusal message", async () => {
    const { file } = await writeStore('{"le":{"Certificates":[{"key":"SECRET-KEY"');
    const error = await evictAcmeEntries(file, ["shop.example.test"], now).catch((e: Error) => e);
    expect(String((error as Error).message)).not.toContain("SECRET-KEY");
  });
});
