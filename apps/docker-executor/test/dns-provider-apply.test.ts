import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerEngineSocketAdapter,
  INGRESS_PROXY_CONTAINER_NAME,
  type PanelIngressConfig,
  type TraefikIngressFileManager,
} from "../src/index.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";

const cleanupTasks: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const task of cleanupTasks.splice(0).reverse()) {
    await task();
  }
});

const SECRET = `Canary-dns-${"s".repeat(12)}`;
const req = {
  provider: "httpreq" as const,
  credentials: {
    HTTPREQ_ENDPOINT: "https://dns.example.it/acme",
    HTTPREQ_USERNAME: "acme-user",
    HTTPREQ_PASSWORD: SECRET,
  },
};
const rotated = { ...req, credentials: { ...req.credentials, HTTPREQ_PASSWORD: `${SECRET}-2` } };
const FILE_ENV = [
  "HTTPREQ_ENDPOINT_FILE=/run/secrets/hp-acme-dns/HTTPREQ_ENDPOINT",
  "HTTPREQ_PASSWORD_FILE=/run/secrets/hp-acme-dns/HTTPREQ_PASSWORD",
  "HTTPREQ_USERNAME_FILE=/run/secrets/hp-acme-dns/HTTPREQ_USERNAME",
];
const panel: PanelIngressConfig = {
  hostname: "srv12.example.it",
  ipv4: "203.0.113.10",
  acmeEmail: "ops@example.it",
  acmeStaging: false,
  acmeCaServer: null,
  acmeCaCertFile: null,
  upstreamPort: 3000,
};

function logFrame(line: string): Buffer {
  const text = Buffer.from(`${line}\n`);
  const frame = Buffer.alloc(8);
  frame[0] = 1;
  frame.writeUInt32BE(text.length, 4);
  return Buffer.concat([frame, text]);
}

async function setup(options?: {
  readonly createDir?: boolean;
  readonly executorUid?: number;
  readonly logsBody?: Buffer;
  readonly panel?: PanelIngressConfig | null;
}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-acme-dns-"));
  cleanupTasks.push(() => rm(tmp, { recursive: true, force: true }));
  const mockDaemon = await startMockDockerDaemon(
    options?.logsBody ? { logsBody: options.logsBody } : undefined,
  );
  cleanupTasks.push(() => mockDaemon.close());
  const secretDir = path.join(tmp, "acme-dns");
  if (options?.createDir !== false) await mkdir(secretDir, { mode: 0o700 });
  const ingressRootDir = path.join(tmp, "ingress");
  const make = () =>
    new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir: path.join(tmp, "secrets"),
      ingressRootDir,
      pullMissingImages: false,
      panel: options?.panel !== undefined ? options.panel : panel,
      acmeDnsSecretDir: secretDir,
      ...(options?.executorUid !== undefined ? { executorUid: options.executorUid } : {}),
    });
  const adapter = make();
  const proxy = () =>
    [...mockDaemon.containers.values()].find((c) => c.name === INGRESS_PROXY_CONTAINER_NAME);
  const count = (from: number, re: RegExp) =>
    mockDaemon.requestedPaths.slice(from).filter((p) => re.test(p)).length;
  const calls = (from: number) => ({
    create: count(from, /\/containers\/create\?name=hp_ingress_proxy/),
    restart: count(from, /\/containers\/hp_ingress_proxy\/restart\?t=5$/),
  });
  const files = async () => (await readdir(secretDir).catch(() => [])).sort();
  const staticYaml = () => readFile(path.join(ingressRootDir, "static", "traefik.yml"), "utf8");
  const statePath = path.join(ingressRootDir, "dns-provider.json");
  return { adapter, make, mockDaemon, secretDir, proxy, calls, files, staticYaml, statePath };
}

describe("DockerEngineSocketAdapter.applyDnsProvider", () => {
  it("apply writes each field 0400 in the 0700 dir, persists the state and recreates the proxy with le-dns, _FILE env and the dir bind", async () => {
    const { adapter, mockDaemon, secretDir, proxy, calls, files, staticYaml, statePath } = await setup();
    await adapter.ensureIngressProxy();
    const firstId = proxy()?.id;
    expect(await staticYaml()).not.toContain("le-dns");

    const from = mockDaemon.requestedPaths.length;
    await adapter.applyDnsProvider(req);

    expect(await files()).toEqual(["HTTPREQ_ENDPOINT", "HTTPREQ_PASSWORD", "HTTPREQ_USERNAME"]);
    for (const [name, value] of Object.entries(req.credentials)) {
      const file = path.join(secretDir, name);
      expect(await readFile(file, "utf8")).toBe(value);
      expect((await stat(file)).mode & 0o777).toBe(0o400);
    }
    expect((await stat(secretDir)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
      provider: "httpreq",
      fields: ["HTTPREQ_ENDPOINT", "HTTPREQ_PASSWORD", "HTTPREQ_USERNAME"],
    });
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect(await staticYaml()).toContain("  le-dns:");
    expect(await staticYaml()).toContain("        provider: httpreq");
    expect(calls(from)).toEqual({ create: 1, restart: 0 });
    expect(proxy()?.id).not.toBe(firstId);
    expect(proxy()?.running).toBe(true);
    expect(proxy()?.env).toEqual(FILE_ENV);
    expect(proxy()?.hostConfig.Binds).toContain(`${secretDir}:/run/secrets/hp-acme-dns:ro`);
  });

  it("an identical apply neither restarts nor recreates the proxy", async () => {
    const { adapter, mockDaemon, proxy, calls } = await setup();
    await adapter.applyDnsProvider(req);
    const id = proxy()?.id;
    const from = mockDaemon.requestedPaths.length;
    await adapter.applyDnsProvider(req);
    expect(calls(from)).toEqual({ create: 0, restart: 0 });
    expect(proxy()?.id).toBe(id);
  });

  it("a rotated credential restarts the proxy without recreating it", async () => {
    const { adapter, mockDaemon, secretDir, proxy, calls } = await setup();
    await adapter.applyDnsProvider(req);
    const id = proxy()?.id;
    const from = mockDaemon.requestedPaths.length;
    await adapter.applyDnsProvider(rotated);
    expect(calls(from)).toEqual({ create: 0, restart: 1 });
    expect(proxy()?.id).toBe(id);
    expect(await readFile(path.join(secretDir, "HTTPREQ_PASSWORD"), "utf8")).toBe(`${SECRET}-2`);
  });

  it("apply after the files vanished (reboot) rewrites them and restarts once", async () => {
    const { adapter, mockDaemon, secretDir, calls, files } = await setup();
    await adapter.applyDnsProvider(req);
    for (const name of await files()) await rm(path.join(secretDir, name));

    const from = mockDaemon.requestedPaths.length;
    await adapter.applyDnsProvider(req);
    expect(calls(from)).toEqual({ create: 0, restart: 1 });
    expect(await readFile(path.join(secretDir, "HTTPREQ_PASSWORD"), "utf8")).toBe(SECRET);
  });

  it("apply null wipes the files, removes the state and recreates the proxy without le-dns; a second null touches nothing", async () => {
    const { adapter, mockDaemon, secretDir, proxy, calls, files, staticYaml, statePath } = await setup();
    await adapter.applyDnsProvider(req);
    const id = proxy()?.id;

    let from = mockDaemon.requestedPaths.length;
    await adapter.applyDnsProvider(null);
    expect(await files()).toEqual([]);
    await expect(stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await staticYaml()).not.toContain("le-dns");
    expect(calls(from)).toEqual({ create: 1, restart: 0 });
    expect(proxy()?.id).not.toBe(id);
    expect(proxy()?.env).toEqual([]);
    expect(proxy()?.hostConfig.Binds?.join("\n")).not.toContain(secretDir);

    const clearedId = proxy()?.id;
    from = mockDaemon.requestedPaths.length;
    await adapter.applyDnsProvider(null);
    expect(calls(from)).toEqual({ create: 0, restart: 0 });
    expect(proxy()?.id).toBe(clearedId);
  });

  it("a null apply retried after a failed ensure recreates the removed proxy", async () => {
    const { adapter, mockDaemon, proxy } = await setup();
    await adapter.applyDnsProvider(req);
    mockDaemon.failCreates.remaining = 1;
    await expect(adapter.applyDnsProvider(null)).rejects.toBeDefined();
    expect(proxy()).toBeUndefined();

    await adapter.applyDnsProvider(null);
    expect(proxy()?.running).toBe(true);
    expect(proxy()?.env).toEqual([]);
  });

  it("without a panel hostname a null apply on a fresh install creates no proxy", async () => {
    const { adapter, mockDaemon, proxy, calls } = await setup({ panel: null });
    await adapter.applyDnsProvider(null);
    expect(calls(0).create).toBe(0);
    expect(proxy()).toBeUndefined();
    expect(mockDaemon.containers.size).toBe(0);
  });

  it("without a panel hostname an apply writes the 0400 files and the state but creates no proxy", async () => {
    const { adapter, mockDaemon, secretDir, proxy, files, statePath } = await setup({ panel: null });
    await adapter.applyDnsProvider(req);
    expect(await files()).toEqual(["HTTPREQ_ENDPOINT", "HTTPREQ_PASSWORD", "HTTPREQ_USERNAME"]);
    expect((await stat(path.join(secretDir, "HTTPREQ_PASSWORD"))).mode & 0o777).toBe(0o400);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ provider: "httpreq" });
    expect(proxy()).toBeUndefined();
    expect(mockDaemon.containers.size).toBe(0);
  });

  it("an apply does not settle on an ensure in flight that read the old state", async () => {
    const { adapter, proxy, staticYaml, statePath } = await setup();
    await adapter.ensureIngressProxy();
    const manager = (adapter as unknown as { ingressManager: TraefikIngressFileManager }).ingressManager;
    const original = manager.ensureStaticConfig.bind(manager);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(manager, "ensureStaticConfig").mockImplementationOnce(async (p) => {
      const out = await original(p);
      await gate;
      return out;
    });
    const stale = adapter.ensureIngressProxy();
    const applied = adapter.applyDnsProvider(req);
    await vi.waitFor(() => stat(statePath));
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await Promise.all([stale, applied]);

    expect(await staticYaml()).toContain("  le-dns:");
    expect(proxy()?.env).toEqual(FILE_ENV);
  });

  it("without HP_ACME_EMAIL a rotated credential does not restart the proxy", async () => {
    const { adapter, mockDaemon, calls } = await setup({ panel: { ...panel, acmeEmail: null } });
    await adapter.applyDnsProvider(req);
    const from = mockDaemon.requestedPaths.length;
    await adapter.applyDnsProvider(rotated);
    expect(calls(from)).toEqual({ create: 0, restart: 0 });
  });

  it("apply refuses when the secret directory is missing or not the executor's", async () => {
    const missing = await setup({ createDir: false });
    await expect(missing.adapter.applyDnsProvider(req)).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
      message: expect.stringContaining("Run bootstrap first"),
    });
    await expect(stat(missing.statePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(missing.proxy()).toBeUndefined();

    const foreign = await setup({ executorUid: (process.getuid?.() ?? 1000) + 1 });
    await expect(foreign.adapter.applyDnsProvider(req)).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
    });
    expect(await foreign.files()).toEqual([]);
    await expect(stat(foreign.statePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(foreign.proxy()).toBeUndefined();
  });

  it("a failed ensure wipes changed files so the next identical apply retries", async () => {
    const { adapter, mockDaemon, proxy, calls, files } = await setup();
    await adapter.ensureIngressProxy();
    mockDaemon.failCreates.remaining = 1;
    await expect(adapter.applyDnsProvider(req)).rejects.toBeDefined();
    expect(await files()).toEqual([]);

    let from = mockDaemon.requestedPaths.length;
    await adapter.applyDnsProvider(req);
    expect(calls(from).create).toBe(1);
    expect(proxy()?.env).toEqual(FILE_ENV);
    expect(await files()).toHaveLength(3);

    mockDaemon.failRestarts.remaining = 1;
    await expect(adapter.applyDnsProvider(rotated)).rejects.toBeDefined();
    expect(await files()).toEqual([]);
    from = mockDaemon.requestedPaths.length;
    await adapter.applyDnsProvider(rotated);
    expect(calls(from)).toEqual({ create: 0, restart: 1 });
  });

  it("a proxy with other hp-acme-dns _FILE env is recreated, image env is ignored", async () => {
    const { adapter, mockDaemon, proxy, calls } = await setup();
    await adapter.ensureIngressProxy();
    proxy()!.env.push("PATH=/usr/local/sbin:/usr/bin");
    let from = mockDaemon.requestedPaths.length;
    await adapter.ensureIngressProxy();
    expect(calls(from)).toEqual({ create: 0, restart: 0 });

    await adapter.applyDnsProvider(req);
    proxy()!.env.push("PATH=/usr/local/sbin:/usr/bin");
    from = mockDaemon.requestedPaths.length;
    await adapter.ensureIngressProxy();
    expect(calls(from)).toEqual({ create: 0, restart: 0 });

    proxy()!.env.push("CLOUDFLARE_DNS_API_TOKEN_FILE=/run/secrets/hp-acme-dns/CLOUDFLARE_DNS_API_TOKEN");
    from = mockDaemon.requestedPaths.length;
    await adapter.ensureIngressProxy();
    expect(calls(from).create).toBe(1);
    expect(proxy()?.env).toEqual(FILE_ENV);
  });

  it("the credential never appears in payloads, request paths or console output", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const { adapter, mockDaemon } = await setup();
    await adapter.applyDnsProvider(req);
    await adapter.applyDnsProvider(rotated);
    const bad = { ...req, credentials: { ...req.credentials, HTTPREQ_PASSWORD: `${SECRET}\n` } };
    const thrown = await adapter.applyDnsProvider(bad).catch((e: unknown) => e);
    expect(thrown).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(String((thrown as Error).message)).not.toContain("Canary");
    await adapter.applyDnsProvider(null);

    expect(JSON.stringify([...mockDaemon.containers.values()])).not.toContain("Canary");
    expect(mockDaemon.requestedPaths.join("\n")).not.toContain("Canary");
    expect(JSON.stringify(spies.flatMap((s) => s.mock.calls))).not.toContain("Canary");
  });

  it("certificate status reports dnsChallenge and scrubs the credential from failure detail", async () => {
    const line = JSON.stringify({
      level: "error",
      providerName: "le-dns.acme",
      domains: ["hotel.it"],
      error: `httpreq: unexpected status 401 for user ${SECRET} at https://dns.example.it/acme`,
      message: "Unable to obtain ACME certificate for domains",
      time: "2026-11-09T10:00:00Z",
    });
    const { adapter } = await setup({ logsBody: logFrame(line) });
    const since = { failuresSince: "2026-11-09T09:00:00Z" };
    expect((await adapter.getCertificateStatus(since)).dnsChallenge).toBe(false);

    await adapter.applyDnsProvider(req);
    const report = await adapter.getCertificateStatus(since);
    expect(report.dnsChallenge).toBe(true);
    expect(report.failures).toMatchObject([{ hostname: "hotel.it", kind: "obtain", problem: "dns_provider" }]);
    expect(report.failures[0]?.detail).toContain("[REDACTED]");
    expect(JSON.stringify(report)).not.toContain("Canary");
    expect(JSON.stringify(report)).not.toContain("dns.example.it");
  });

  it("a restarted executor with the persisted state does not recreate the proxy", async () => {
    const { adapter, make, mockDaemon, proxy, calls } = await setup();
    await adapter.applyDnsProvider(req);
    const id = proxy()?.id;

    const restarted = make();
    const from = mockDaemon.requestedPaths.length;
    await restarted.ensureIngressProxy();
    expect(calls(from)).toEqual({ create: 0, restart: 0 });
    expect(proxy()?.id).toBe(id);
    expect((await restarted.getCertificateStatus({ failuresSince: "2026-11-09T00:00:00Z" })).dnsChallenge).toBe(true);
  });
});
