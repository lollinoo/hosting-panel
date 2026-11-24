import { X509Certificate, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createSecureContext, createServer as createTlsServer, type SecureContext, type Server as TlsServer } from "node:tls";
import { signIpcRequest, type IpcSigningKey, type IpcVerificationKey } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueCert } from "../../api/test/fixtures/tls-certgen.js";
import {
  DockerEngineSocketAdapter,
  DockerExecutorIpcServer,
  ExecutorIpcClientError,
  InMemoryDockerSimulatorAdapter,
  MANUAL_TLS_PROBE_TIMEOUT_MS,
  MANUAL_TLS_PUBLISH_EVICT_TIMEOUT_MS,
  MANUAL_TLS_PUBLISH_TIMEOUT_MS,
  MANUAL_TLS_PUT_TIMEOUT_MS,
  MANUAL_TLS_QUICK_TIMEOUT_MS,
  ManualTlsStore,
  SignedDockerExecutorIpcClient,
} from "../src/index.js";

const SECRET = "0123456789abcdef0123456789abcdef-manual-tls-ipc";
const SIGNING_KEY: IpcSigningKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: SECRET };
const VERIFICATION_KEY: IpcVerificationKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: SECRET };
const ROUTE = "/v1/ingress/manual-tls";
const CANARY = "PEM-CANARY-9f3a1c7e";

let counter = 0;
const versionId = (): string => `ctv_${(++counter).toString(16).padStart(32, "0")}`;
const fingerprintOf = (pem: string): string => new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase();

function material(dns: readonly string[], key?: ReturnType<typeof issueCert>["key"]) {
  const cert = issueCert({ dns, ...(key ? { key } : {}) });
  return { versionId: versionId(), fullchainPem: cert.pem, keyPem: cert.keyPem, fingerprintSha256: fingerprintOf(cert.pem), cert };
}
const put = (m: ReturnType<typeof material>) => ({
  action: "putVersion" as const,
  versionId: m.versionId,
  fullchainPem: m.fullchainPem,
  keyPem: m.keyPem,
  fingerprintSha256: m.fingerprintSha256,
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

const errorOf = async (work: Promise<unknown>): Promise<ExecutorIpcClientError> => {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutorIpcClientError);
    return error as ExecutorIpcClientError;
  }
  throw new Error("expected the call to fail");
};

async function serve(executor: ConstructorParameters<typeof DockerExecutorIpcServer>[0]["executor"]) {
  const server = new DockerExecutorIpcServer({ executor, keyring: { "hmac-v1": VERIFICATION_KEY }, transport: "loopback-test" });
  cleanup.push(() => server.stop());
  const bound = await server.start();
  const client = new SignedDockerExecutorIpcClient({ signingKey: SIGNING_KEY, transport: "loopback-test", port: bound.port });
  const raw = async (body: unknown, signed = true) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const headers = signed
      ? signIpcRequest({ method: "POST", pathWithQuery: ROUTE, body: text, key: SIGNING_KEY, nonce: randomBytes(8).toString("hex") })
      : {};
    const res = await fetch(`http://127.0.0.1:${String(bound.port)}${ROUTE}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: text,
    });
    return { status: res.status, text: await res.text() };
  };
  return { client, raw };
}

describe("manual TLS over the signed IPC (simulator)", () => {
  type Expectation = { hostname: string; fingerprintSha256?: string; notFingerprintSha256?: string };
  const publish = (baseGeneration: number, entries: { versionId: string; assignedHosts: string[] }[], expect: Expectation[] = [], evictAcme?: boolean) => ({
    action: "publish" as const,
    baseGeneration,
    entries,
    expect,
    ...(evictAcme === undefined ? {} : { evictAcme }),
  });

  it("round trip: put (idempotent), publish served, probe, inventory, publish empty, gc", async () => {
    const simulator = new InMemoryDockerSimulatorAdapter();
    const { client } = await serve(simulator);
    const m = material(["shop.test"]);

    expect(await client.manualTls(put(m))).toEqual({ versionId: m.versionId, written: true });
    expect(await client.manualTls(put(m))).toEqual({ versionId: m.versionId, written: false });

    const first = await client.manualTls(
      publish(0, [{ versionId: m.versionId, assignedHosts: ["shop.test"] }], [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }]),
    );
    expect(first).toMatchObject({ generation: 1, outcome: "served", violations: [], evicted: [], collateralHosts: [] });
    expect(first.served).toEqual([{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }]);

    expect(await client.manualTls({ action: "probe", hostnames: ["shop.test", "other.test"] })).toEqual({
      served: [
        { hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 },
        { hostname: "other.test", fingerprintSha256: null },
      ],
    });

    const inventory = await client.manualTls({ action: "inventory" });
    expect(inventory).toMatchObject({ generation: 1, verified: true, missing: [], acme: [] });
    expect(inventory.versions).toEqual([
      { versionId: m.versionId, fingerprintSha256: m.fingerprintSha256, notAfter: expect.any(String), names: ["shop.test"] },
    ]);
    expect(inventory.entries).toEqual([{ versionId: m.versionId, assignedHosts: ["shop.test"] }]);
    expect(JSON.stringify(inventory)).not.toContain("PRIVATE KEY");

    const removed = await client.manualTls(publish(1, [], [{ hostname: "shop.test", notFingerprintSha256: m.fingerprintSha256 }]));
    expect(removed).toMatchObject({ generation: 2, outcome: "not_served_reverted" }); // no certificate at all: nothing is served
    expect(await client.manualTls({ action: "gc", baseGeneration: 2 })).toEqual({ removed: [] }); // reverted to the verified set
    const empty = await client.manualTls(publish(2, [], []));
    expect(empty).toMatchObject({ generation: 3, outcome: "served" });
    expect(await client.manualTls({ action: "gc", baseGeneration: 3 })).toEqual({ removed: [m.versionId] });
    expect(simulator.manualTlsCalls.filter((c) => (c as { action: string }).action === "putVersion")).toEqual([
      { action: "putVersion", versionId: m.versionId },
      { action: "putVersion", versionId: m.versionId },
    ]);
  });

  it("errors carry the executor-internal reason in details[0] and map to existing public codes", async () => {
    const { client } = await serve(new InMemoryDockerSimulatorAdapter());
    const m = material(["shop.test"]);
    await client.manualTls(put(m));

    const stale = await errorOf(client.manualTls(publish(5, [{ versionId: m.versionId, assignedHosts: ["shop.test"] }])));
    expect(stale).toMatchObject({ code: "CERTIFICATE_IN_USE", statusCode: 409, reason: "TLS_MANIFEST_CONFLICT" });

    const ghost = versionId();
    const missing = await errorOf(client.manualTls(publish(0, [{ versionId: ghost, assignedHosts: ["a.test"] }])));
    expect(missing).toMatchObject({ code: "CERTIFICATE_IN_USE", reason: "TLS_VERSION_MISSING" });
    expect(missing.versionIds).toEqual([ghost]);

    const other = material(["shop.test"]);
    const mismatch = await errorOf(client.manualTls({ ...put(other), fingerprintSha256: "0".repeat(64) }));
    expect(mismatch).toMatchObject({ code: "CERTIFICATE_INVALID", statusCode: 422, reason: "TLS_MATERIAL_INVALID" });

    const conflict = await errorOf(client.manualTls({ ...put(other), versionId: m.versionId }));
    expect(conflict).toMatchObject({ code: "CERTIFICATE_IN_USE", reason: "TLS_VERSION_CONFLICT" });
  });

  it("is strict: extra keys, bad ids, oversized PEM, unknown actions, oversized bodies and unsigned calls are refused", async () => {
    const { raw } = await serve(new InMemoryDockerSimulatorAdapter());
    const m = material(["shop.test"]);
    const base = put(m);
    const refused: unknown[] = [
      { ...base, extra: CANARY },
      { ...base, versionId: "ctv_short" },
      { ...base, fingerprintSha256: "ABC" },
      { ...base, fullchainPem: "x".repeat(600_001) },
      { ...base, keyPem: "x".repeat(64_001) },
      { action: "dump", fullchainPem: CANARY },
      { action: "publish", baseGeneration: -1, entries: [], expect: [] },
      { action: "publish", baseGeneration: 0, entries: [{ versionId: m.versionId, assignedHosts: [] }], expect: [] },
      { action: "publish", baseGeneration: 0, entries: [{ versionId: m.versionId, assignedHosts: ["a.test"], keyPem: CANARY }], expect: [] },
      { action: "probe", hostnames: [] },
      { action: "inventory", extra: true },
      { action: "gc" },
    ];
    for (const body of refused) {
      const res = await raw(body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(JSON.parse(res.text).error.code).toBe("VALIDATION_ERROR");
      expect(res.text).not.toContain(CANARY);
      expect(res.text).not.toContain("BEGIN");
    }
    // The size limits are the schema's: the largest legal PEM pair fits the 1 MiB transport limit.
    const max = await raw({ ...base, fullchainPem: "x".repeat(600_000), keyPem: "y".repeat(64_000) });
    expect(max.status).toBe(422); // parsed, then refused as unusable material
    const huge = await raw({ ...base, fullchainPem: CANARY.repeat(80_000) });
    expect(huge.status).toBe(400);
    expect(huge.text).not.toContain(CANARY);
    expect((await raw("{not json", true)).status).toBe(400);
    expect((await raw(base, false)).status).toBe(401);
  });

  it("never echoes PEM or key material in an error body, even for material it parsed and refused", async () => {
    const { raw } = await serve(new InMemoryDockerSimulatorAdapter());
    const m = material(["shop.test"]);
    const bodies = [
      { ...put(m), keyPem: `-----BEGIN PRIVATE KEY-----\n${CANARY}\n-----END PRIVATE KEY-----\n` },
      { ...put(m), fullchainPem: `-----BEGIN CERTIFICATE-----\n${CANARY}\n-----END CERTIFICATE-----\n` },
      { ...put(m), fingerprintSha256: "1".repeat(64) },
    ];
    for (const body of bodies) {
      const res = await raw(body);
      expect(res.status).toBe(422);
      const error = JSON.parse(res.text).error;
      expect(error.code).toBe("CERTIFICATE_INVALID");
      expect(error.details[0].reason).toBe("TLS_MATERIAL_INVALID");
      for (const secret of [CANARY, "BEGIN", m.keyPem.split("\n")[1]!, m.fullchainPem.split("\n")[1]!]) {
        expect(res.text).not.toContain(secret);
      }
    }
  });

  it("per-action client timeouts", () => {
    expect([MANUAL_TLS_PUT_TIMEOUT_MS, MANUAL_TLS_PUBLISH_TIMEOUT_MS, MANUAL_TLS_PUBLISH_EVICT_TIMEOUT_MS, MANUAL_TLS_PROBE_TIMEOUT_MS, MANUAL_TLS_QUICK_TIMEOUT_MS]).toEqual([
      15_000, 30_000, 90_000, 25_000, 10_000,
    ]);
  });

  describe("simulator outcomes", () => {
    it("acme_eviction_required refuses without the flag and nothing changes; with it the ACME entry goes and the manual one is served", async () => {
      const simulator = new InMemoryDockerSimulatorAdapter();
      const { client } = await serve(simulator);
      const m = material(["shop.test"]);
      simulator.issueCertificate("shop.test", "2126-01-01T00:00:00.000Z");
      await client.manualTls(put(m));
      const entries = [{ versionId: m.versionId, assignedHosts: ["shop.test"] }];
      const expectation = [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }];

      const refused = await client.manualTls(publish(0, entries, expectation));
      expect(refused).toMatchObject({ generation: 0, outcome: "acme_eviction_required", evicted: [] });
      expect(refused.violations[0]).toMatchObject({ kind: "acme_eviction_required", hostname: "shop.test", versionId: m.versionId });
      expect((await client.manualTls({ action: "inventory" })).entries).toEqual([]);

      const evicted = await client.manualTls(publish(0, entries, expectation, true));
      expect(evicted).toMatchObject({ generation: 1, outcome: "served", evicted: [{ resolver: "le", main: "shop.test" }] });
      expect((await simulator.getCertificateStatus({ failuresSince: "2020-01-01T00:00:00.000Z" })).certificates).toEqual([]);
    });

    it("captures_host (a loaded wildcard would serve the panel host) and manual_overlap (equal keys)", async () => {
      const simulator = new InMemoryDockerSimulatorAdapter({
        panel: { hostname: "panel.w.test", ipv4: "192.0.2.1", acmeEmail: null, acmeStaging: false, acmeCaServer: null, acmeCaCertFile: null, upstreamPort: 3000 },
      });
      const { client } = await serve(simulator);
      const wild = material(["*.w.test"]);
      await client.manualTls(put(wild));
      const captured = await client.manualTls(publish(0, [{ versionId: wild.versionId, assignedHosts: ["a.w.test"] }]));
      expect(captured).toMatchObject({ generation: 0, outcome: "captures_host" });
      expect(captured.violations[0]).toMatchObject({ kind: "captures_host", hostname: "panel.w.test" });

      const one = material(["x.test"]);
      const two = material(["x.test"]);
      await client.manualTls(put(one));
      await client.manualTls(put(two));
      const overlap = await client.manualTls(
        publish(0, [
          { versionId: one.versionId, assignedHosts: ["x.test"] },
          { versionId: two.versionId, assignedHosts: ["x.test"] },
        ]),
      );
      expect(overlap).toMatchObject({ generation: 0, outcome: "manual_overlap" });
      expect(overlap.violations.map((v) => v.kind)).toEqual(["manual_overlap", "manual_overlap"]);
    });

    it("a hostname the certificate does not serve ends not_served_reverted; the failure knob forces both failure outcomes", async () => {
      const simulator = new InMemoryDockerSimulatorAdapter();
      const { client } = await serve(simulator);
      const m = material(["shop.test"]);
      await client.manualTls(put(m));
      const entries = [{ versionId: m.versionId, assignedHosts: ["shop.test"] }];

      const wrong = await client.manualTls(publish(0, entries, [{ hostname: "shop.test", fingerprintSha256: "a".repeat(64) }]));
      expect(wrong).toMatchObject({ generation: 1, outcome: "not_served_reverted" });
      expect(wrong.served).toEqual([{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }]); // what was observed
      expect(await client.manualTls({ action: "inventory" })).toMatchObject({ generation: 1, verified: true, entries: [] });

      simulator.failManualTlsPublish();
      const forced = await client.manualTls(publish(1, entries, [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }]));
      expect(forced).toMatchObject({ generation: 2, outcome: "not_served_reverted" });
      expect((await client.manualTls({ action: "inventory" })).entries).toEqual([]);

      simulator.issueCertificate("shop.test", "2126-01-01T00:00:00.000Z");
      simulator.failManualTlsPublish("start_failed_restored");
      const restored = await client.manualTls(publish(2, entries, [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }], true));
      expect(restored).toMatchObject({ generation: 3, outcome: "start_failed_restored", evicted: [] });
      expect((await simulator.getCertificateStatus({ failuresSince: "2020-01-01T00:00:00.000Z" })).certificates).toHaveLength(1);

      const served = await client.manualTls(publish(3, entries, [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }], true));
      expect(served.outcome).toBe("served");
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The real adapter: temp ingress root, a local TLS server standing in for Traefik, a fake Docker socket.
// ---------------------------------------------------------------------------------------------------------------

interface Rig {
  root: string;
  ingress: string;
  adapter: DockerEngineSocketAdapter;
  docker: string[];
  serve(host: string, cert: { pem: string; keyPem: string } | null): void;
  acmePath: string;
  startStatuses: number[];
}

const isRoot = process.getuid?.() === 0;
const MANIFEST_NAME = "hp-manual-certificates.yml";

async function rig(options: { panelHostname?: string; proxyName?: string } = {}): Promise<Rig> {
  const proxy = options.proxyName ?? "hp_ingress_proxy";
  const root = await mkdtemp(path.join(os.tmpdir(), "manual-tls-ipc-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const ingress = path.join(root, "ingress");
  await mkdir(path.join(ingress, "dynamic", "manual-certs"), { recursive: true, mode: 0o700 });
  await chmod(path.join(ingress, "dynamic", "manual-certs"), 0o700);
  await mkdir(path.join(ingress, "acme"), { recursive: true });

  const docker: string[] = [];
  const startStatuses: number[] = [];
  const dockerServer = http.createServer((req, res) => {
    const route = (req.url ?? "").replace(/^\/v\d+\.\d+/, "");
    docker.push(`${req.method ?? ""} ${route}`);
    const send = (status: number, body = ""): void => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    };
    if (req.method === "GET" && route === `/containers/${proxy}/json`) {
      return send(200, JSON.stringify({ Id: "proxy1", State: { Running: true }, NetworkSettings: { Networks: { hp_ingress_net: { IPAddress: "127.0.0.1" } } } }));
    }
    if (req.method === "POST" && route.startsWith(`/containers/${proxy}/stop`)) return send(204);
    if (req.method === "POST" && route === `/containers/${proxy}/start`) return send(startStatuses.shift() ?? 204);
    return send(404, "{}");
  });
  const dockerSocketPath = path.join(root, "docker.sock");
  await new Promise<void>((r) => dockerServer.listen(dockerSocketPath, r));
  cleanup.push(() => new Promise((r) => dockerServer.close(() => r())));

  const contexts = new Map<string, SecureContext>();
  const defaultCert = issueCert({ dns: ["default.test"] });
  const tls: TlsServer = createTlsServer(
    { SNICallback: (name, cb) => cb(null, contexts.get(name) ?? createSecureContext({ cert: defaultCert.pem, key: defaultCert.keyPem })) },
    (socket) => {
      socket.on("error", () => undefined);
      socket.end();
    },
  );
  await new Promise<void>((r) => tls.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise((r) => tls.close(() => r())));
  const httpsPort = (tls.address() as AddressInfo).port;

  const adapter = new DockerEngineSocketAdapter({
    dockerSocketPath,
    ingressRootDir: ingress,
    ingressHttpsPort: httpsPort,
    pullMissingImages: false,
    ...(options.proxyName ? { ingressProxyContainerName: options.proxyName } : {}),
    manualTlsProbe: { deadlineMs: 1_200, intervalMs: 20 },
    ...(options.panelHostname
      ? { panel: { hostname: options.panelHostname, ipv4: "192.0.2.1", acmeEmail: null, acmeStaging: false, acmeCaServer: null, acmeCaCertFile: null, upstreamPort: 3000 } }
      : {}),
  });
  return {
    root,
    ingress,
    adapter,
    docker,
    startStatuses,
    acmePath: path.join(ingress, "acme", "acme.json"),
    serve: (host, cert) => {
      if (cert) contexts.set(host, createSecureContext({ cert: cert.pem, key: cert.keyPem }));
      else contexts.delete(host);
    },
  };
}

const acmeStore = (...leaves: { main: string; pem: string }[]): string =>
  JSON.stringify({
    le: { Account: { Email: "ops@example.test" }, Certificates: leaves.map((l) => ({ domain: { main: l.main }, certificate: Buffer.from(l.pem).toString("base64"), key: "KEY", Store: "default" })) },
  });

describe("manual TLS on the Docker adapter", () => {
  const entriesOf = (m: { versionId: string }, hosts: string[]) => [{ versionId: m.versionId, assignedHosts: hosts }];

  it("hot path: files, manifest with proxy-side refs, state, probe, verified; 0400 key files", async () => {
    const r = await rig();
    const m = material(["shop.test"]);
    r.serve("shop.test", { pem: m.fullchainPem, keyPem: m.keyPem });
    await r.adapter.manualTls(put(m));

    const result = await r.adapter.manualTls({
      action: "publish",
      baseGeneration: 0,
      entries: entriesOf(m, ["shop.test"]),
      expect: [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }],
    });
    expect(result).toMatchObject({ generation: 1, outcome: "served", evicted: [], violations: [] });
    expect(result.served).toEqual([{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }]);

    const manifest = await readFile(path.join(r.ingress, "dynamic", MANIFEST_NAME), "utf8");
    expect(manifest).toContain(`certFile: "/etc/traefik/dynamic/manual-certs/${m.versionId}/fullchain.pem"`);
    expect(manifest).toContain(`keyFile: "/etc/traefik/dynamic/manual-certs/${m.versionId}/privkey.pem"`);
    expect(manifest).not.toContain("BEGIN");
    expect((await stat(path.join(r.ingress, "dynamic", "manual-certs", m.versionId, "privkey.pem"))).mode & 0o777).toBe(0o400);
    const state = JSON.parse(await readFile(path.join(r.ingress, "manual-tls-state.json"), "utf8"));
    expect(state).toMatchObject({ generation: 1, verified: true });
    expect(r.docker.some((c) => c.includes("/stop"))).toBe(false); // hot: the proxy is never touched

    const inventory = await r.adapter.manualTls({ action: "inventory" });
    expect(inventory).toMatchObject({ generation: 1, verified: true, missing: [] });
    expect(JSON.stringify(inventory)).not.toContain("PRIVATE KEY");
  });

  it("a certificate that is not served is reverted: manifest removed, state verified with the last good set", async () => {
    const r = await rig();
    const m = material(["shop.test"]);
    await r.adapter.manualTls(put(m)); // the stand-in proxy keeps serving its default certificate
    const result = await r.adapter.manualTls({
      action: "publish",
      baseGeneration: 0,
      entries: entriesOf(m, ["shop.test"]),
      expect: [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }],
    });
    expect(result).toMatchObject({ generation: 1, outcome: "not_served_reverted" });
    expect(result.served[0]?.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.served[0]?.fingerprintSha256).not.toBe(m.fingerprintSha256);
    expect(await readdir(path.join(r.ingress, "dynamic"))).not.toContain(MANIFEST_NAME);
    expect(JSON.parse(await readFile(path.join(r.ingress, "manual-tls-state.json"), "utf8"))).toMatchObject({ generation: 1, verified: true, current: { entries: [] } });
  });

  it("refuses a stale base generation and unknown versions, with the reasons the API applier maps", async () => {
    const r = await rig();
    const m = material(["shop.test"]);
    await r.adapter.manualTls(put(m));
    const stale = await r.adapter.manualTls({ action: "publish", baseGeneration: 3, entries: entriesOf(m, ["shop.test"]), expect: [] }).catch((e: unknown) => e);
    expect(stale).toMatchObject({ code: "CERTIFICATE_IN_USE", reason: "TLS_MANIFEST_CONFLICT" });
    const ghost = versionId();
    const missing = await r.adapter.manualTls({ action: "publish", baseGeneration: 0, entries: [{ versionId: ghost, assignedHosts: ["a.test"] }], expect: [] }).catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: "CERTIFICATE_IN_USE", reason: "TLS_VERSION_MISSING", versionIds: [ghost] });
    await expect(r.adapter.manualTls({ action: "publish", baseGeneration: 0, entries: [], expect: [], extra: 1 } as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("an ACME certificate with the same names is a tie: refused without evictAcme, nothing written, proxy untouched", async () => {
    const r = await rig();
    const acme = issueCert({ dns: ["shop.test"] });
    await writeFile(r.acmePath, acmeStore({ main: "shop.test", pem: acme.pem }), { mode: 0o600 });
    const m = material(["shop.test"]);
    await r.adapter.manualTls(put(m));
    const result = await r.adapter.manualTls({ action: "publish", baseGeneration: 0, entries: entriesOf(m, ["shop.test"]), expect: [] });
    expect(result).toMatchObject({ generation: 0, outcome: "acme_eviction_required", evicted: [] });
    expect(result.violations[0]).toMatchObject({ kind: "acme_eviction_required", hostname: "shop.test" });
    expect(await readdir(path.join(r.ingress, "dynamic"))).not.toContain(MANIFEST_NAME);
    await expect(stat(path.join(r.ingress, "manual-tls-state.json"))).rejects.toThrow();
    expect(r.docker.some((c) => c.includes("/stop") || c.includes("/start"))).toBe(false);
    const inventory = await r.adapter.manualTls({ action: "inventory" });
    expect(inventory.acme.map((a) => a.names)).toEqual([["shop.test"]]);
  });

  it("a wildcard that would serve the panel host is captures_host", async () => {
    const r = await rig({ panelHostname: "panel.w.test" });
    const wild = material(["*.w.test"]);
    await r.adapter.manualTls(put(wild));
    const result = await r.adapter.manualTls({ action: "publish", baseGeneration: 0, entries: entriesOf(wild, ["a.w.test"]), expect: [] });
    expect(result).toMatchObject({ generation: 0, outcome: "captures_host" });
    expect(result.violations[0]).toMatchObject({ kind: "captures_host", hostname: "panel.w.test" });
  });

  it("cold path: stop, evict with a backup, publish, start, probe; other ACME entries stay", async () => {
    const r = await rig();
    const acme = issueCert({ dns: ["shop.test"] });
    const keep = issueCert({ dns: ["keep.test"] });
    const original = acmeStore({ main: "shop.test", pem: acme.pem }, { main: "keep.test", pem: keep.pem });
    await writeFile(r.acmePath, original, { mode: 0o600 });
    const m = material(["shop.test"]);
    r.serve("shop.test", { pem: m.fullchainPem, keyPem: m.keyPem });
    await r.adapter.manualTls(put(m));

    const result = await r.adapter.manualTls({
      action: "publish",
      baseGeneration: 0,
      entries: entriesOf(m, ["shop.test"]),
      expect: [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }],
      evictAcme: true,
    });
    expect(result).toMatchObject({ generation: 1, outcome: "served", evicted: [{ resolver: "le", main: "shop.test" }], collateralHosts: [] });
    const calls = r.docker.filter((c) => c.includes("/stop") || c.includes("/start"));
    expect(calls).toEqual(["POST /containers/hp_ingress_proxy/stop?t=5", "POST /containers/hp_ingress_proxy/start"]);

    const store = JSON.parse(await readFile(r.acmePath, "utf8")) as { le: { Certificates: { domain: { main: string } }[] } };
    expect(store.le.Certificates.map((c) => c.domain.main)).toEqual(["keep.test"]);
    const backups = (await readdir(path.join(r.ingress, "acme"))).filter((f) => f.includes(".hp-evict-"));
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(r.ingress, "acme", backups[0]!), "utf8")).toBe(original);
    expect((await stat(path.join(r.ingress, "acme", backups[0]!))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(r.ingress, "dynamic", MANIFEST_NAME), "utf8")).toContain(m.versionId);
  });

  it("cold path: a proxy that does not start gets its acme.json back and the manifest reverts (start_failed_restored)", async () => {
    const r = await rig();
    const acme = issueCert({ dns: ["shop.test"] });
    const original = acmeStore({ main: "shop.test", pem: acme.pem });
    await writeFile(r.acmePath, original, { mode: 0o600 });
    const m = material(["shop.test"]);
    await r.adapter.manualTls(put(m));
    r.startStatuses.push(500, 204); // first start fails, the second one (after the restore) works

    const result = await r.adapter.manualTls({
      action: "publish",
      baseGeneration: 0,
      entries: entriesOf(m, ["shop.test"]),
      expect: [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }],
      evictAcme: true,
    });
    expect(result).toMatchObject({ generation: 1, outcome: "start_failed_restored", evicted: [] });
    expect(await readFile(r.acmePath, "utf8")).toBe(original);
    expect(await readdir(path.join(r.ingress, "dynamic"))).not.toContain(MANIFEST_NAME);
    expect(r.docker.filter((c) => c.endsWith("/start"))).toHaveLength(2);
  });

  it("cold path: a probe that fails after the eviction restores acme.json and restarts the proxy once more", async () => {
    const r = await rig();
    const acme = issueCert({ dns: ["shop.test"] });
    const original = acmeStore({ main: "shop.test", pem: acme.pem });
    await writeFile(r.acmePath, original, { mode: 0o600 });
    const m = material(["shop.test"]);
    await r.adapter.manualTls(put(m)); // the stand-in proxy never serves the manual certificate
    const result = await r.adapter.manualTls({
      action: "publish",
      baseGeneration: 0,
      entries: entriesOf(m, ["shop.test"]),
      expect: [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }],
      evictAcme: true,
    });
    expect(result).toMatchObject({ generation: 1, outcome: "not_served_reverted", evicted: [], collateralHosts: [] }); // restored: nothing was evicted
    expect(await readFile(r.acmePath, "utf8")).toBe(original); // the ACME entry is back
    expect(await readdir(path.join(r.ingress, "dynamic"))).not.toContain(MANIFEST_NAME);
    expect(r.docker.filter((c) => c.includes("/stop") || c.endsWith("/start")).map((c) => c.split("/").pop()!.split("?")[0])).toEqual([
      "stop", "start", "stop", "start",
    ]);
  });

  const coldRequest = (m: ReturnType<typeof material>) => ({
    action: "publish" as const,
    baseGeneration: 0,
    entries: entriesOf(m, ["shop.test"]),
    expect: [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }],
    evictAcme: true,
  });
  const callsOf = (r: Rig): string[] => r.docker.filter((c) => c.includes("/stop") || c.endsWith("/start")).map((c) => c.split("/").pop()!.split("?")[0]!);

  it("cold path: a failed acme.json restore after a failed start still tries to start the proxy and reports both", async () => {
    const r = await rig();
    const acme = issueCert({ dns: ["shop.test"] });
    await writeFile(r.acmePath, acmeStore({ main: "shop.test", pem: acme.pem }), { mode: 0o600 });
    const m = material(["shop.test"]);
    await r.adapter.manualTls(put(m));
    vi.spyOn(r.adapter as unknown as { restoreAcmeBackup(): Promise<void> }, "restoreAcmeBackup").mockRejectedValue(new Error("EIO"));
    r.startStatuses.push(500, 500); // the start after the eviction fails, and so does the start after the failed restore
    await expect(r.adapter.manualTls(coldRequest(m))).rejects.toMatchObject({
      code: "CERTIFICATE_APPLY_FAILED",
      message: expect.stringContaining("did not start"),
    });
    expect(callsOf(r)).toEqual(["stop", "start", "start"]); // the second start was attempted despite the restore failure
  });

  it("cold path: a failed restore after a failed probe still starts the proxy again", async () => {
    const r = await rig();
    const acme = issueCert({ dns: ["shop.test"] });
    await writeFile(r.acmePath, acmeStore({ main: "shop.test", pem: acme.pem }), { mode: 0o600 });
    const m = material(["shop.test"]);
    await r.adapter.manualTls(put(m)); // never served => not_served_reverted
    vi.spyOn(r.adapter as unknown as { restoreAcmeBackup(): Promise<void> }, "restoreAcmeBackup").mockRejectedValue(new Error("EIO"));
    await expect(r.adapter.manualTls(coldRequest(m))).rejects.toMatchObject({ code: "CERTIFICATE_APPLY_FAILED" });
    expect(callsOf(r)).toEqual(["stop", "start", "stop", "start"]); // never left stopped
  });

  it("boot recovery never reverts the manifest of a publish that is mid-probe", async () => {
    const r = await rig();
    const m = material(["shop.test"]);
    await r.adapter.manualTls(put(m));
    const publish = r.adapter.manualTls({ action: "publish", baseGeneration: 0, entries: entriesOf(m, ["shop.test"]), expect: [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }] });
    const manifestPath = path.join(r.ingress, "dynamic", MANIFEST_NAME);
    for (let i = 0; i < 100 && !(await readdir(path.join(r.ingress, "dynamic"))).includes(MANIFEST_NAME); i += 1) await new Promise((res) => setTimeout(res, 10));
    await (r.adapter as unknown as { recoverManualTlsOnce(): Promise<void> }).recoverManualTlsOnce(); // the first ensure lands during the probe
    expect(await readFile(manifestPath, "utf8")).toContain(m.versionId); // not rewritten to the (empty) last verified set
    expect(JSON.parse(await readFile(path.join(r.ingress, "manual-tls-state.json"), "utf8"))).toMatchObject({ generation: 1, verified: false });
    r.serve("shop.test", { pem: m.fullchainPem, keyPem: m.keyPem });
    expect(await publish).toMatchObject({ generation: 1, outcome: "served" });
    await (r.adapter as unknown as { recoverManualTlsOnce(): Promise<void> }).recoverManualTlsOnce(); // idle: recovery runs normally
    expect(await readFile(manifestPath, "utf8")).toContain(m.versionId);
  });

  it.skipIf(isRoot)("cold path: a proxy that cannot be started after a failed apply is an error, not a swallowed one", async () => {
    const r = await rig();
    const acme = issueCert({ dns: ["shop.test"] });
    await writeFile(r.acmePath, acmeStore({ main: "shop.test", pem: acme.pem }), { mode: 0o600 });
    const m = material(["shop.test"]);
    await r.adapter.manualTls(put(m));
    await chmod(path.join(r.ingress, "acme"), 0o500); // the eviction backup cannot be written
    r.startStatuses.push(500);
    try {
      await expect(
        r.adapter.manualTls({ action: "publish", baseGeneration: 0, entries: entriesOf(m, ["shop.test"]), expect: [], evictAcme: true }),
      ).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    } finally {
      await chmod(path.join(r.ingress, "acme"), 0o700);
    }
  });

  it("the proxy container name is a test seam: the cold path talks to the renamed container only", async () => {
    const r = await rig({ proxyName: "hp_swarmtest_proxy" });
    const acme = issueCert({ dns: ["shop.test"] });
    await writeFile(r.acmePath, acmeStore({ main: "shop.test", pem: acme.pem }), { mode: 0o600 });
    const m = material(["shop.test"]);
    r.serve("shop.test", { pem: m.fullchainPem, keyPem: m.keyPem });
    await r.adapter.manualTls(put(m));
    const result = await r.adapter.manualTls({
      action: "publish",
      baseGeneration: 0,
      entries: entriesOf(m, ["shop.test"]),
      expect: [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }],
      evictAcme: true,
    });
    expect(result.outcome).toBe("served");
    expect(r.docker.filter((c) => c.includes("/stop") || c.endsWith("/start"))).toEqual([
      "POST /containers/hp_swarmtest_proxy/stop?t=5",
      "POST /containers/hp_swarmtest_proxy/start",
    ]);
    expect(r.docker.some((c) => c.includes("hp_ingress_proxy"))).toBe(false);
  });

  it("the empty acme.json that ensureStaticConfig creates is an empty store: the first publish is served", async () => {
    const r = await rig();
    await writeFile(r.acmePath, "", { mode: 0o600 });
    const m = material(["shop.test"]);
    r.serve("shop.test", { pem: m.fullchainPem, keyPem: m.keyPem });
    await r.adapter.manualTls(put(m));
    const result = await r.adapter.manualTls({
      action: "publish",
      baseGeneration: 0,
      entries: entriesOf(m, ["shop.test"]),
      expect: [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }],
    });
    expect(result).toMatchObject({ generation: 1, outcome: "served" });
  });

  it("an acme.json that is not JSON still stops the publish; a torn read that heals within the retries does not", async () => {
    const r = await rig();
    const m = material(["shop.test"]);
    r.serve("shop.test", { pem: m.fullchainPem, keyPem: m.keyPem });
    await r.adapter.manualTls(put(m));
    const request = {
      action: "publish" as const,
      baseGeneration: 0,
      entries: entriesOf(m, ["shop.test"]),
      expect: [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }],
    };
    await writeFile(r.acmePath, "{\"le\":{\"Certi", { mode: 0o600 });
    await expect(r.adapter.manualTls(request)).rejects.toMatchObject({ code: "CERTIFICATE_APPLY_FAILED" });

    setTimeout(() => void writeFile(r.acmePath, acmeStore(), { mode: 0o600 }), 70); // Traefik finishes its rewrite
    expect(await r.adapter.manualTls(request)).toMatchObject({ generation: 1, outcome: "served" });
  });

  it("evictAcme with nothing to evict stays on the hot path (the proxy is not stopped)", async () => {
    const r = await rig();
    const m = material(["shop.test"]);
    r.serve("shop.test", { pem: m.fullchainPem, keyPem: m.keyPem });
    await r.adapter.manualTls(put(m));
    const result = await r.adapter.manualTls({
      action: "publish",
      baseGeneration: 0,
      entries: entriesOf(m, ["shop.test"]),
      expect: [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }],
      evictAcme: true,
    });
    expect(result.outcome).toBe("served");
    expect(r.docker.some((c) => c.includes("/stop"))).toBe(false);
  });

  it("a replay of the same publish after a crash is idempotent and re-probes", async () => {
    const r = await rig();
    const m = material(["shop.test"]);
    r.serve("shop.test", { pem: m.fullchainPem, keyPem: m.keyPem });
    await r.adapter.manualTls(put(m));
    const request = {
      action: "publish" as const,
      baseGeneration: 0,
      entries: entriesOf(m, ["shop.test"]),
      expect: [{ hostname: "shop.test", fingerprintSha256: m.fingerprintSha256 }],
    };
    expect((await r.adapter.manualTls(request)).generation).toBe(1);
    expect(await r.adapter.manualTls(request)).toMatchObject({ generation: 1, outcome: "served" });
  });

  it("startup recovery re-renders the manifest from the persisted state before the proxy is ensured", async () => {
    const r = await rig();
    const m = material(["shop.test"]);
    // A crash between the state write and the manifest write: state says published, the manifest never landed.
    const crashed = new ManualTlsStore({
      dir: path.join(r.ingress, "dynamic", "manual-certs"),
      statePath: path.join(r.ingress, "manual-tls-state.json"),
      writeManifest: async () => undefined,
    });
    await crashed.putVersion({ versionId: m.versionId, fullchainPem: m.fullchainPem, keyPem: m.keyPem, fingerprintSha256: m.fingerprintSha256 });
    await crashed.publishFiles(0, [{ versionId: m.versionId, assignedHosts: ["shop.test"] }]);
    await crashed.markVerified(1); // a verified set is rendered at start; an unverified current never is
    expect(await readdir(path.join(r.ingress, "dynamic"))).not.toContain(MANIFEST_NAME);

    // ensureIngressProxy runs recovery right after ensureStaticConfig; the fake Docker then fails the network call.
    await r.adapter.ensureIngressProxy().catch(() => undefined);
    expect(await readFile(path.join(r.ingress, "dynamic", MANIFEST_NAME), "utf8")).toContain(m.versionId);
  });
});
