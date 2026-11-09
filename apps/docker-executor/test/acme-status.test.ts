import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyAcmeError, parseAcmeFailures, readAcmeCertificates } from "../src/acme-status.js";

const fixture = path.join(import.meta.dirname, "fixtures", "acme.json");

describe("readAcmeCertificates", () => {
  it("reads hostnames and expiry, never the key", async () => {
    const store = JSON.parse(await (await import("node:fs/promises")).readFile(fixture, "utf8"));
    const result = await readAcmeCertificates(fixture);
    expect(result.readable).toBe(true);
    expect(result.certificates).toHaveLength(1);
    expect(result.certificates[0]).toMatchObject({
      hostname: "hotel.it",
      notAfter: "2036-11-06T04:46:29.000Z",
    });
    const out = JSON.stringify(result);
    expect(out).not.toContain(store.le.Certificates[0].key);
    expect(out).not.toContain(store.le.Account.PrivateKey);
  });

  it("a truncated acme.json reads as unreadable, never as empty", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acme-"));
    const file = path.join(dir, "acme.json");
    await writeFile(file, '{"le":{"Certificates":[{"dom');
    expect(await readAcmeCertificates(file)).toEqual({ readable: false, certificates: [] });
  });

  it("an empty or whitespace-only file reads as unreadable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acme-"));
    for (const [name, body] of [["a.json", ""], ["b.json", "  \n"]] as const) {
      const file = path.join(dir, name);
      await writeFile(file, body);
      expect(await readAcmeCertificates(file)).toEqual({ readable: false, certificates: [] });
    }
  });

  it("a missing file is unreadable, a missing resolver is readable and empty", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acme-"));
    expect(await readAcmeCertificates(path.join(dir, "nope.json"))).toEqual({ readable: false, certificates: [] });
    expect(await readAcmeCertificates(fixture, "other")).toEqual({ readable: true, certificates: [] });
  });
});

describe("classifyAcmeError", () => {
  it("maps the ACME problem types", () => {
    const c = classifyAcmeError;
    expect(c("urn:ietf:params:acme:error:rateLimited :: too many certificates (5) already issued")).toBe("rate_limited");
    expect(c("urn:ietf:params:acme:error:connection :: 203.0.113.9: Timeout during connect (likely firewall problem)")).toBe("port_80_blocked");
    expect(c("urn:ietf:params:acme:error:unauthorized :: Invalid response from http://hotel.it/.well-known/acme-challenge/x: 404")).toBe("not_pointing");
    expect(c("urn:ietf:params:acme:error:caa")).toBe("caa_blocked");
    expect(c("boom")).toBe("other");
  });
});

describe("parseAcmeFailures", () => {
  const obtain = JSON.stringify({
    level: "error",
    domains: ["hotel.it"],
    error: "urn:ietf:params:acme:error:rateLimited :: too many",
    time: "2026-11-09T10:00:00Z",
    message: "Unable to obtain ACME certificate for domains",
  });

  it("keeps only recent ACME errors", () => {
    const lines = [obtain, "not json"];
    const got = parseAcmeFailures(lines, Date.parse("2026-11-09T09:59:00Z"));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ hostname: "hotel.it", kind: "obtain", problem: "rate_limited" });
    expect(parseAcmeFailures(lines, Date.parse("2026-11-09T10:01:00Z"))).toEqual([]);
  });

  it("reads renewal failures", () => {
    const line = JSON.stringify({
      level: "error",
      error: "urn:ietf:params:acme:error:connection :: x",
      time: "2026-11-09T10:00:00Z",
      message: "Error renewing ACME certificate: {hotel.it [www.hotel.it]}",
    });
    expect(parseAcmeFailures([line], 0)).toMatchObject([
      { hostname: "hotel.it", kind: "renew", problem: "port_80_blocked" },
    ]);
  });
});
