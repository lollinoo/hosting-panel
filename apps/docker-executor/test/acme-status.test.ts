import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyAcmeError, parseAcmeFailures, readAcmeCertificates } from "../src/acme-status.js";

const fixture = path.join(import.meta.dirname, "fixtures", "acme.json");
const fixtureCert = (JSON.parse(await readFile(fixture, "utf8")) as { le: { Certificates: { certificate: string }[] } })
  .le.Certificates[0]!.certificate; // hotel.it, notAfter 2036-11-06
// Self-signed P-256 leaf for hotel.it, notAfter 2029-08-16, to compare two expiries.
const olderCert =
  "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUJlekNDQVNHZ0F3SUJBZ0lVQ3NVdjdsVm9zTE5xUkZwakw0WTNIQytybE5jd0NnWUlLb1pJemowRUF3SXcKRXpFUk1BOEdBMVVFQXd3SWFHOTBaV3d1YVhRd0hoY05Nall4TVRJd01URTFNREUxV2hjTk1qa3dPREUyTVRFMQpNREUxV2pBVE1SRXdEd1lEVlFRRERBaG9iM1JsYkM1cGREQlpNQk1HQnlxR1NNNDlBZ0VHQ0NxR1NNNDlBd0VICkEwSUFCRTYxaUpjV3N5d3VHR0lOYjVMWCt5cjBxSHhvZm9BVlhpaWt3K3p3a0JubkdRTFBlQjRER1NPNXBuSHMKZHV3dy9qdHlQdncxTXJ5Mm51SGNoV1lha3k2alV6QlJNQjBHQTFVZERnUVdCQlI5bFVlNFJNKysxOVRybE9mSApXS3VOaVhTc0lqQWZCZ05WSFNNRUdEQVdnQlI5bFVlNFJNKysxOVRybE9mSFdLdU5pWFNzSWpBUEJnTlZIUk1CCkFmOEVCVEFEQVFIL01Bb0dDQ3FHU000OUJBTUNBMGdBTUVVQ0lRRDZWejh6SkJjV0EydnBOTU02NEZVN2NWaDgKRWlWeWp2cHhMd2I3V2lLUVZRSWdEZy9Bb3VkOHlva2xOcVhJeVVnQWJsai8wVXloRW5JK1ZodW9YaEEyeHA4PQotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg==";

const entry = (main: string, certificate = fixtureCert, sans?: unknown) => ({
  domain: sans === undefined ? { main } : { main, sans },
  certificate,
  key: "x",
  Store: "default",
});

async function writeStore(store: unknown): Promise<string> {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), "acme-")), "acme.json");
  await writeFile(file, JSON.stringify(store));
  return file;
}

describe("readAcmeCertificates", () => {
  it("reads hostnames and expiry, never the key", async () => {
    const store = JSON.parse(await readFile(fixture, "utf8"));
    const result = await readAcmeCertificates(fixture);
    expect(result.readable).toBe(true);
    expect(result.certificates.map((c) => c.hostname)).toEqual(["hotel.it", "www.hotel.it"]);
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
    expect(await readAcmeCertificates(fixture, ["other"])).toEqual({ readable: true, certificates: [] });
  });

  it("reads le and le-dns from one store", async () => {
    const file = await writeStore({
      le: { Certificates: [entry("hotel.it")] },
      "le-dns": { Certificates: [entry("shop.it")] },
    });
    const result = await readAcmeCertificates(file);
    expect(result.readable).toBe(true);
    expect(result.certificates.map((c) => c.hostname).sort()).toEqual(["hotel.it", "shop.it"]);
    expect(await readAcmeCertificates(file, ["le-dns"])).toMatchObject({ certificates: [{ hostname: "shop.it" }] });
  });

  it("a SAN becomes its own hostname", async () => {
    const file = await writeStore({
      "le-dns": {
        Certificates: [entry("shop.it", fixtureCert, ["www.shop.it", 7]), entry("bar.it", fixtureCert, "www.bar.it")],
      },
    });
    const { certificates } = await readAcmeCertificates(file);
    expect(certificates.map((c) => c.hostname)).toEqual(["shop.it", "www.shop.it", "bar.it"]);
    expect(certificates[1]).toEqual({ ...certificates[0], hostname: "www.shop.it" });
  });

  it("the latest expiry wins when both resolvers hold a name", async () => {
    for (const [le, leDns] of [
      [fixtureCert, olderCert],
      [olderCert, fixtureCert],
    ] as const) {
      const file = await writeStore({
        le: { Certificates: [entry("hotel.it", le)] },
        "le-dns": { Certificates: [entry("x.hotel.it", leDns, ["hotel.it"])] },
      });
      const { certificates } = await readAcmeCertificates(file);
      expect(certificates.filter((c) => c.hostname === "hotel.it")).toEqual([
        expect.objectContaining({ notAfter: "2036-11-06T04:46:29.000Z" }),
      ]);
    }
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

  const failure = (providerName: string, error: string) =>
    JSON.stringify({
      level: "error",
      providerName,
      domains: ["hotel.it"],
      error,
      time: "2026-11-09T10:00:00Z",
      message: "Unable to obtain ACME certificate for domains",
    });

  it("a le-dns failure is dns_provider unless rate limited or CAA", () => {
    const p = (error: string) => parseAcmeFailures([failure("le-dns.acme", error)], 0)[0]?.problem;
    expect(p("cloudflare: failed to find zone hotel.it.: zone could not be found")).toBe("dns_provider");
    expect(p("urn:ietf:params:acme:error:dns :: DNS problem: NXDOMAIN looking up TXT")).toBe("dns_provider");
    expect(p("urn:ietf:params:acme:error:connection :: x")).toBe("dns_provider");
    expect(p("urn:ietf:params:acme:error:rateLimited :: too many")).toBe("rate_limited");
    expect(p("urn:ietf:params:acme:error:caa :: CAA record forbids")).toBe("caa_blocked");
  });

  it("a le failure is classified as before", () => {
    for (const error of [
      "urn:ietf:params:acme:error:dns :: DNS problem: NXDOMAIN",
      "urn:ietf:params:acme:error:connection :: x",
      "cloudflare: failed to find zone",
    ]) {
      expect(parseAcmeFailures([failure("le.acme", error)], 0)[0]?.problem).toBe(classifyAcmeError(error));
    }
  });

  it("failure detail never contains a DNS credential value", () => {
    const token = "cf-T0ken-9f8e7d6c5b4a";
    const line = failure("le-dns.acme", `cloudflare: invalid token ${token} (abc) for zone`);
    const [got] = parseAcmeFailures([line], 0, [token, "abc"]);
    expect(got?.detail).not.toContain(token);
    expect(got?.detail).toContain("[REDACTED]");
    expect(got?.detail).toContain("(abc)"); // shorter than 4 characters: not a credential
    expect(parseAcmeFailures([line], 0)[0]?.detail).toContain("cloudflare: invalid token");
  });

  it("a credential that contains a shorter one is removed whole, longest first", () => {
    const line = failure("le-dns.acme", "httpreq: 401 for user-9f8e7d6c-tail");
    const [got] = parseAcmeFailures([line], 0, ["user", "user-9f8e7d6c-tail"]);
    expect(got?.detail).toContain("401 for [REDACTED]");
    expect(got?.detail).not.toContain("tail");
  });
});
