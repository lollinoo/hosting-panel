import { X509Certificate } from "node:crypto";
import net from "node:net";
import { createServer, createSecureContext, type Server } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { probeServedFingerprint, waitForServed } from "../src/manual-tls-probe.js";

// Throwaway self-signed P-256 certificates (CN probe-a.test / probe-b.test, 100 years).
const CERT_A = "-----BEGIN CERTIFICATE-----\nMIIBhTCCASugAwIBAgIUF/P8rwauVbpoXj3zXyibutuptcMwCgYIKoZIzj0EAwIw\nFzEVMBMGA1UEAwwMcHJvYmUtYS50ZXN0MCAXDTI2MTEyMTAxMzgwMloYDzIxMjYx\nMDI4MDEzODAyWjAXMRUwEwYDVQQDDAxwcm9iZS1hLnRlc3QwWTATBgcqhkjOPQIB\nBggqhkjOPQMBBwNCAATsS7z3pIAzpz7TnfVVJZAw5AWakyt9Tt3syDYcOVqlGlVi\nAsK6Sv4Jkl47QY4x5L5Gd8+06Pd0ZHpI906N0u3Go1MwUTAdBgNVHQ4EFgQUuW4i\npvOSGDuYKMnvAst7cfXh/4QwHwYDVR0jBBgwFoAUuW4ipvOSGDuYKMnvAst7cfXh\n/4QwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiBTxTw4aMM1RbYQ\n3mrvqPRTezi2LHUHe+vrFXjtzh1cBQIhAIwiIcrGNDvIeuLliNt9665kqtLZSKDr\nOlooHAr+phEr\n-----END CERTIFICATE-----\n";
const KEY_A = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgcWdZ6kQ0CbERxUnh\n5B2QEcVFH9imG5L3Qx5X8SfgP6uhRANCAATsS7z3pIAzpz7TnfVVJZAw5AWakyt9\nTt3syDYcOVqlGlViAsK6Sv4Jkl47QY4x5L5Gd8+06Pd0ZHpI906N0u3G\n-----END PRIVATE KEY-----\n";
const CERT_B = "-----BEGIN CERTIFICATE-----\nMIIBhjCCASugAwIBAgIUT74DGAPH6hZgydicebouzMKIiWYwCgYIKoZIzj0EAwIw\nFzEVMBMGA1UEAwwMcHJvYmUtYi50ZXN0MCAXDTI2MTEyMTAxMzgwMloYDzIxMjYx\nMDI4MDEzODAyWjAXMRUwEwYDVQQDDAxwcm9iZS1iLnRlc3QwWTATBgcqhkjOPQIB\nBggqhkjOPQMBBwNCAASWh5EgOL7iM7XoibC7FGEcWd3WM4rks82rN50cNiirR5gu\nmATI7f3f8BQED5uvhr/3YfU5hVpTOQuDK9n9OAiHo1MwUTAdBgNVHQ4EFgQUngGO\nMvbsPnEvzwY8u00EtooKMFswHwYDVR0jBBgwFoAUngGOMvbsPnEvzwY8u00EtooK\nMFswDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEApvtpCwzfRybP\n9OVIdpf26D7sZIcj//O0omSXpL50abACIQDqaLpZgnGqkwroSM5TBHmsIvshGy0H\nDhrwlWQ0pUeOLQ==\n-----END CERTIFICATE-----\n";
const KEY_B = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgeqDprzrHQArKonuy\nbv3Fh2S7KqW7RZ/jF6HapbN89KOhRANCAASWh5EgOL7iM7XoibC7FGEcWd3WM4rk\ns82rN50cNiirR5gumATI7f3f8BQED5uvhr/3YfU5hVpTOQuDK9n9OAiH\n-----END PRIVATE KEY-----\n";

const fp = (pem: string): string => new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase();
const FP_A = fp(CERT_A);
const FP_B = fp(CERT_B);

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function serve(pick: (servername: string) => "a" | "b"): Promise<number> {
  const contexts = {
    a: createSecureContext({ cert: CERT_A, key: KEY_A }),
    b: createSecureContext({ cert: CERT_B, key: KEY_B }),
  };
  const server = createServer({ SNICallback: (name, cb) => cb(null, contexts[pick(name)]) }, (s) => {
    s.on("error", () => undefined);
    s.end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as net.AddressInfo).port;
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

const fast = { host: "127.0.0.1", intervalMs: 20, deadlineMs: 2_000 } as const;

describe("probeServedFingerprint", () => {
  it("returns the lowercase colon-free SHA-256 of the SNI-selected certificate", async () => {
    const port = await serve((name) => (name === "b.example.test" ? "b" : "a"));
    expect(await probeServedFingerprint("127.0.0.1", port, "a.example.test")).toBe(FP_A);
    expect(await probeServedFingerprint("127.0.0.1", port, "b.example.test")).toBe(FP_B);
    expect(FP_A).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects with ECONNREFUSED on a closed port", async () => {
    const port = await freePort();
    await expect(probeServedFingerprint("127.0.0.1", port, "x.test")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});

describe("waitForServed", () => {
  it("waits for a certificate switch made mid-test and needs two consecutive matches", async () => {
    let current: "a" | "b" = "a";
    let handshakes = 0;
    const port = await serve(() => {
      handshakes += 1;
      return current;
    });
    setTimeout(() => (current = "b"), 120);
    const started = Date.now();
    const report = await waitForServed([{ hostname: "shop.test", fingerprintSha256: FP_B }], { ...fast, port });
    expect(report).toEqual({ served: true, observed: { "shop.test": FP_B }, unmatched: [] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(handshakes).toBeGreaterThanOrEqual(3);
  });

  it("does not report served after a single match followed by a flip back", async () => {
    let calls = 0;
    const port = await serve(() => (++calls === 2 ? "b" : "a"));
    const report = await waitForServed([{ hostname: "shop.test", fingerprintSha256: FP_B }], {
      ...fast,
      port,
      deadlineMs: 400,
    });
    expect(report.served).toBe(false);
  });

  it("supports notFingerprint for removed hosts and mixed expectations", async () => {
    const port = await serve((name) => (name === "new.test" ? "b" : "a"));
    const report = await waitForServed(
      [
        { hostname: "new.test", fingerprintSha256: FP_B.toUpperCase() },
        { hostname: "old.test", notFingerprintSha256: FP_B },
      ],
      { ...fast, port },
    );
    expect(report.served).toBe(true);
    expect(report.observed).toEqual({ "new.test": FP_B, "old.test": FP_A });
  });

  it("reports unmatched hostnames and the observed fingerprint at the deadline", async () => {
    const port = await serve(() => "a");
    const report = await waitForServed(
      [
        { hostname: "ok.test", fingerprintSha256: FP_A },
        { hostname: "stuck.test", fingerprintSha256: FP_B },
        { hostname: "gone.test", notFingerprintSha256: FP_A },
      ],
      { ...fast, port, deadlineMs: 300 },
    );
    expect(report.served).toBe(false);
    expect(report.unmatched.sort()).toEqual(["gone.test", "stuck.test"]);
    expect(report.observed["stuck.test"]).toBe(FP_A);
  });

  it("counts an unreachable endpoint as no match, even for notFingerprint", async () => {
    const port = await freePort();
    const started = Date.now();
    const report = await waitForServed([{ hostname: "x.test", notFingerprintSha256: FP_A }], {
      ...fast,
      port,
      deadlineMs: 200,
    });
    expect(report).toEqual({ served: false, observed: { "x.test": null }, unmatched: ["x.test"] });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("uses the fallback endpoint when the primary refuses the connection", async () => {
    const refused = await freePort();
    const live = await serve(() => "b");
    const report = await waitForServed([{ hostname: "shop.test", fingerprintSha256: FP_B }], {
      ...fast,
      port: refused,
      fallback: { host: "127.0.0.1", port: live },
    });
    expect(report.served).toBe(true);
  });
});
