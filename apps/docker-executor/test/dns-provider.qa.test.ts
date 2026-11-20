import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SiteHostRoute } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { parseAcmeFailures } from "../src/acme-status.js";
import {
  DockerEngineSocketAdapter,
  INGRESS_PROXY_CONTAINER_NAME,
  TraefikIngressFileManager,
  buildIngressProxyContainerPayload,
  buildSiteDynamicTraefikYaml,
  buildTraefikStaticYaml,
  type DnsProviderState,
  type PanelIngressConfig,
  type SiteIngressRouteEntry,
} from "../src/index.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

const PANEL: PanelIngressConfig = {
  hostname: "srv12.example.it",
  ipv4: "203.0.113.10",
  acmeEmail: "ops@example.it",
  acmeStaging: false,
  acmeCaServer: null,
  acmeCaCertFile: null,
  upstreamPort: 3000,
};
const DNS: DnsProviderState = { provider: "httpreq", fields: ["HTTPREQ_ENDPOINT", "HTTPREQ_PASSWORD"] };
const SECRET = `Canary-qa-${"s".repeat(12)}`;
const req = {
  provider: "httpreq" as const,
  credentials: {
    HTTPREQ_ENDPOINT: "https://dns.example.it/acme",
    HTTPREQ_USERNAME: "acme-user",
    HTTPREQ_PASSWORD: SECRET,
  },
};

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hp-dns-qa-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const host = (hostname: string, over: Partial<SiteHostRoute> = {}): SiteHostRoute => ({
  hostname,
  tls: true,
  httpsRedirect: false,
  redirectTo: null,
  ...over,
});
const route = (hosts: readonly SiteHostRoute[]): SiteIngressRouteEntry => ({
  serviceInstanceId: "svc1",
  containerName: "hp-site-1-web",
  internalPort: 80,
  hosts,
});

describe("no provider: the proxy config is what an install without DNS-01 produced", () => {
  // Copied from the static config before the feature (git HEAD).
  const HEAD_HEADER = [
    "# Managed by hp-docker-executor — Zero-Sock Static Configuration (HCP-SPEC-003 §4.2)",
    "api:",
    "  dashboard: false",
    "  insecure: false",
    "",
    "entryPoints:",
    "  web:",
    '    address: ":80"',
    "  websecure:",
    '    address: ":443"',
    "",
    "providers:",
    "  file:",
    '    directory: "/etc/traefik/dynamic"',
    "    watch: true",
    "",
    "log:",
    "  format: json",
    "",
  ];
  const headResolver = (extra: string[]) =>
    [
      ...HEAD_HEADER,
      "certificatesResolvers:",
      "  le:",
      "    acme:",
      '      email: "ops@example.it"',
      ...extra,
      "      httpChallenge:",
      "        entryPoint: web",
      "",
    ].join("\n");

  it("static traefik.yml is byte-identical for production, staging and no ACME", () => {
    expect(buildTraefikStaticYaml(PANEL)).toBe(
      headResolver(["      storage: /etc/traefik/acme/acme.json"]),
    );
    expect(buildTraefikStaticYaml({ ...PANEL, acmeStaging: true })).toBe(
      headResolver([
        "      storage: /etc/traefik/acme/acme-staging.json",
        "      caServer: https://acme-staging-v02.api.letsencrypt.org/directory",
      ]),
    );
    expect(buildTraefikStaticYaml({ ...PANEL, acmeEmail: null })).toBe(HEAD_HEADER.join("\n"));
    expect(buildTraefikStaticYaml(null)).toBe(HEAD_HEADER.join("\n"));
  });

  it("proxy payload has no Env key and no extra bind", () => {
    const payload = buildIngressProxyContainerPayload({
      staticConfigHostPath: "/s/traefik.yml",
      dynamicDirHostPath: "/s/dynamic",
      acmeDirHostPath: "/s/acme",
      staticSha256: "abc",
      user: "1000:1000",
    });
    expect(Object.keys(payload).sort()).toEqual([
      "Cmd",
      "ExposedPorts",
      "HostConfig",
      "Image",
      "Labels",
      "NetworkingConfig",
      "User",
    ]);
    expect(payload.HostConfig.Binds).toEqual([
      "/s/traefik.yml:/etc/traefik/traefik.yml:ro",
      "/s/dynamic:/etc/traefik/dynamic:ro",
      "/s/acme:/etc/traefik/acme",
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/hp-acme-dns|_FILE|"Env"/);
  });
});

describe("routes", () => {
  it("a hydrated http-01 line is rewritten without a challenge field", async () => {
    const root = await tmp();
    const seed = new TraefikIngressFileManager(root, PANEL);
    await seed.upsertServiceRoute("site_1", route([host("hotel.it")]));
    const file = seed.getSiteDynamicFilePath("site_1");
    const plain = await readFile(file, "utf8");
    // A hand-edited line that names http-01 explicitly.
    await writeFile(file, plain.replace('"redirectTo":null}', '"redirectTo":null,"challenge":"http-01"}'));
    expect(await readFile(file, "utf8")).toContain('"challenge":"http-01"');

    const manager = new TraefikIngressFileManager(root, PANEL);
    await manager.upsertServiceRoute("site_1", { ...route([host("b.it")]), serviceInstanceId: "svc2" });
    const yaml = await readFile(file, "utf8");
    expect(yaml).not.toContain("challenge");
    expect(yaml).toContain("# @hp-route");
  });

  it("a dns-01 host needs a TLS host and ACME: otherwise no resolver, no tls and no failure", () => {
    const noTls = buildSiteDynamicTraefikYaml(
      "site_1",
      [route([host("hotel.it", { tls: false, challenge: "dns-01" })])],
      { acmeEnabled: true, dnsChallenge: true, reservedHosts: [] },
    );
    const live = (yaml: string) => yaml.split("\n").filter((l) => !l.startsWith("#")).join("\n");
    expect(live(noTls)).not.toMatch(/websecure|tls|certResolver/);
    const noAcme = buildSiteDynamicTraefikYaml(
      "site_1",
      [route([host("hotel.it", { challenge: "dns-01" })])],
      { acmeEnabled: false, dnsChallenge: true, reservedHosts: [] },
    );
    expect(live(noAcme)).not.toMatch(/websecure|tls|certResolver/);
    // The intent survives in the persisted line.
    expect(noAcme).toContain('"challenge":"dns-01"');
  });

  it("a dns-01 host before the provider exists serves tls {}; the next upsert after the provider uses le-dns", async () => {
    const root = await tmp();
    const manager = new TraefikIngressFileManager(root, PANEL);
    const r = route([host("hotel.it", { challenge: "dns-01" })]);
    await expect(manager.upsertServiceRoute("site_1", r)).resolves.toMatchObject({ configured: true });
    const file = manager.getSiteDynamicFilePath("site_1");
    expect(await readFile(file, "utf8")).toContain("      tls: {}");
    expect(await readFile(file, "utf8")).not.toContain("certResolver");

    await manager.setDnsProviderState(DNS);
    await manager.upsertServiceRoute("site_1", r);
    const yaml = await readFile(file, "utf8");
    expect(yaml).toContain("        certResolver: le-dns");
    expect(yaml).not.toContain("tls: {}");

    // Removing the provider again (no email also counts) drops back to tls {} on the next write.
    await manager.setDnsProviderState(null);
    await manager.upsertServiceRoute("site_1", r);
    expect(await readFile(file, "utf8")).not.toContain("certResolver");
  });

  it("the panel router keeps certResolver le with a provider, in the file and after the gate", async () => {
    const root = await tmp();
    const manager = new TraefikIngressFileManager(root, PANEL);
    await manager.setDnsProviderState(DNS);
    await manager.ensureStaticConfig(PANEL);
    const panelFile = path.join(root, "dynamic", "hp-panel.yml");
    const resolvers = async () =>
      (await readFile(panelFile, "utf8")).match(/certResolver: \S+/g);
    expect(await resolvers()).toEqual(["certResolver: le"]);

    const good = async () => ({ a: [PANEL.ipv4], aaaa: [] });
    expect(await manager.gatePanelCertificate(PANEL, good)).toBe(true);
    expect(await resolvers()).toEqual(["certResolver: le"]);
    expect(await readFile(path.join(root, "static", "traefik.yml"), "utf8")).toContain("  le-dns:");
  });
});

describe("persisted state", () => {
  const BAD_STATES: Array<[string, string]> = [
    ["bad json", "{not json"],
    ["empty file", ""],
    ["array", "[]"],
    ["string", '"httpreq"'],
    ["unknown provider", '{"provider":"route53","fields":["AWS_ACCESS_KEY_ID"]}'],
    ["unknown field name", '{"provider":"httpreq","fields":["HTTPREQ_ENDPOINT","LD_PRELOAD"]}'],
    ["non-string field", '{"provider":"httpreq","fields":["HTTPREQ_ENDPOINT",5]}'],
    ["missing required field", '{"provider":"ovh","fields":["OVH_ENDPOINT"]}'],
    ["fields not an array", '{"provider":"httpreq","fields":"HTTPREQ_ENDPOINT"}'],
    ["no fields", '{"provider":"httpreq"}'],
  ];

  it.each(BAD_STATES)("%s: no crash, le-dns stays off, no Env", async (_name, content) => {
    const root = await tmp();
    await writeFile(path.join(root, "dns-provider.json"), content);
    const manager = new TraefikIngressFileManager(root, PANEL);
    expect(await manager.loadDnsProviderState()).toBeNull();
    const ensured = await manager.ensureStaticConfig(PANEL);
    expect(ensured.acmeDns).toBeNull();
    const yaml = await readFile(path.join(root, "static", "traefik.yml"), "utf8");
    expect(yaml).toBe(buildTraefikStaticYaml(PANEL));
    expect(ensured.staticSha256).toBe(createHash("sha256").update(buildTraefikStaticYaml(PANEL)).digest("hex"));
  });

  it("a directory in place of the state file reads as no provider", async () => {
    const root = await tmp();
    await mkdir(path.join(root, "dns-provider.json"));
    const manager = new TraefikIngressFileManager(root, PANEL);
    expect(await manager.loadDnsProviderState()).toBeNull();
    expect((await manager.ensureStaticConfig(PANEL)).acmeDns).toBeNull();
  });

  it("a duplicated field in a hand-edited file is collapsed and sorted", async () => {
    const root = await tmp();
    await writeFile(
      path.join(root, "dns-provider.json"),
      '{"provider":"httpreq","fields":["HTTPREQ_PASSWORD","HTTPREQ_ENDPOINT","HTTPREQ_PASSWORD"]}',
    );
    expect(await new TraefikIngressFileManager(root, PANEL).loadDnsProviderState()).toEqual(DNS);
  });

  it("a real apply replaces a corrupted loose-mode state file with a 0600 names-only one", async () => {
    const secretDir = path.join(await tmp(), "acme-dns");
    await mkdir(secretDir, { mode: 0o700 });
    const mockDaemon = await startMockDockerDaemon();
    cleanup.push(() => mockDaemon.close());
    const ingressRootDir = await tmp();
    const statePath = path.join(ingressRootDir, "dns-provider.json");
    await writeFile(statePath, '{"provider":"route53"');
    await chmod(statePath, 0o644);
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir: path.join(ingressRootDir, "secrets"),
      ingressRootDir,
      pullMissingImages: false,
      panel: PANEL,
      acmeDnsSecretDir: secretDir,
    });
    // The corrupted file does not break the proxy or the status.
    await adapter.ensureIngressProxy();
    const proxy = () => [...mockDaemon.containers.values()].find((c) => c.name === INGRESS_PROXY_CONTAINER_NAME);
    expect(proxy()?.env).toEqual([]);
    expect((await adapter.getCertificateStatus({ failuresSince: "2026-11-09T00:00:00Z" })).dnsChallenge).toBe(false);

    await adapter.applyDnsProvider(req);
    const text = await readFile(statePath, "utf8");
    expect(JSON.parse(text)).toEqual({
      provider: "httpreq",
      fields: ["HTTPREQ_ENDPOINT", "HTTPREQ_PASSWORD", "HTTPREQ_USERNAME"],
    });
    for (const value of Object.values(req.credentials)) expect(text).not.toContain(value);
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  });
});

describe("credential files", () => {
  async function setup() {
    const root = await tmp();
    const mockDaemon = await startMockDockerDaemon();
    cleanup.push(() => mockDaemon.close());
    const secretDir = path.join(root, "acme-dns");
    await mkdir(secretDir, { mode: 0o700 });
    const ingressRootDir = path.join(root, "ingress");
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir: path.join(root, "secrets"),
      ingressRootDir,
      pullMissingImages: false,
      panel: PANEL,
      acmeDnsSecretDir: secretDir,
    });
    const proxy = () => [...mockDaemon.containers.values()].find((c) => c.name === INGRESS_PROXY_CONTAINER_NAME);
    const count = (from: number, re: RegExp) => mockDaemon.requestedPaths.slice(from).filter((p) => re.test(p)).length;
    const calls = (from: number) => ({
      create: count(from, /\/containers\/create\?name=hp_ingress_proxy/),
      restart: count(from, /\/containers\/hp_ingress_proxy\/restart\?t=5$/),
    });
    const files = async () => (await readdir(secretDir)).sort();
    return { adapter, mockDaemon, secretDir, ingressRootDir, proxy, calls, files };
  }

  it("switching provider deletes the old provider's files and recreates the proxy for the new one", async () => {
    const { adapter, mockDaemon, secretDir, ingressRootDir, proxy, calls, files } = await setup();
    await adapter.applyDnsProvider(req);
    const id = proxy()?.id;
    const from = mockDaemon.requestedPaths.length;
    await adapter.applyDnsProvider({ provider: "cloudflare", credentials: { CLOUDFLARE_DNS_API_TOKEN: "cf-token-0123" } });

    expect(await files()).toEqual(["CLOUDFLARE_DNS_API_TOKEN"]);
    expect(await readFile(path.join(secretDir, "CLOUDFLARE_DNS_API_TOKEN"), "utf8")).toBe("cf-token-0123");
    expect(calls(from)).toEqual({ create: 1, restart: 0 });
    expect(proxy()?.id).not.toBe(id);
    expect(proxy()?.env).toEqual([
      "CLOUDFLARE_DNS_API_TOKEN_FILE=/run/secrets/hp-acme-dns/CLOUDFLARE_DNS_API_TOKEN",
    ]);
    expect(await readFile(path.join(ingressRootDir, "static", "traefik.yml"), "utf8")).toContain(
      "        provider: cloudflare\n",
    );
    expect(JSON.parse(await readFile(path.join(ingressRootDir, "dns-provider.json"), "utf8"))).toEqual({
      provider: "cloudflare",
      fields: ["CLOUDFLARE_DNS_API_TOKEN"],
    });
  });

  it("dropping the optional pair removes its files and recreates the proxy with the shorter Env", async () => {
    const { adapter, mockDaemon, proxy, calls, files } = await setup();
    await adapter.applyDnsProvider(req);
    const from = mockDaemon.requestedPaths.length;
    await adapter.applyDnsProvider({
      provider: "httpreq",
      credentials: { HTTPREQ_ENDPOINT: req.credentials.HTTPREQ_ENDPOINT },
    });
    expect(await files()).toEqual(["HTTPREQ_ENDPOINT"]);
    expect(calls(from)).toEqual({ create: 1, restart: 0 });
    expect(proxy()?.env).toEqual(["HTTPREQ_ENDPOINT_FILE=/run/secrets/hp-acme-dns/HTTPREQ_ENDPOINT"]);
  });

  it("a stray file in the secret dir is removed on the next apply, and the proxy restarts", async () => {
    const { adapter, mockDaemon, secretDir, proxy, calls, files } = await setup();
    await adapter.applyDnsProvider(req);
    const id = proxy()?.id;
    await writeFile(path.join(secretDir, "stray"), "leftover");
    const from = mockDaemon.requestedPaths.length;
    await adapter.applyDnsProvider(req);
    expect(await files()).toEqual(["HTTPREQ_ENDPOINT", "HTTPREQ_PASSWORD", "HTTPREQ_USERNAME"]);
    expect(calls(from)).toEqual({ create: 0, restart: 1 });
    expect(proxy()?.id).toBe(id);
  });

  it("clearing the provider also removes stray files", async () => {
    const { adapter, secretDir, files } = await setup();
    await adapter.applyDnsProvider(req);
    await writeFile(path.join(secretDir, "stray"), "leftover");
    await adapter.applyDnsProvider(null);
    expect(await files()).toEqual([]);
  });

  it("a hand-edited credential file is rewritten to the applied value", async () => {
    const { adapter, secretDir } = await setup();
    await adapter.applyDnsProvider(req);
    const file = path.join(secretDir, "HTTPREQ_PASSWORD");
    await chmod(file, 0o600);
    await writeFile(file, "tampered");
    await adapter.applyDnsProvider(req);
    expect(await readFile(file, "utf8")).toBe(SECRET);
    expect((await stat(file)).mode & 0o777).toBe(0o400);
  });
});

describe("acme failure detail", () => {
  const line = (error: string, providerName = "le-dns.acme", message = "Unable to obtain ACME certificate for domains") =>
    JSON.stringify({
      level: "error",
      providerName,
      domains: ["hotel.it"],
      error,
      message,
      time: "2026-11-09T10:00:00Z",
    });

  it("a credential that appears twice, or inside a URL, is removed everywhere", () => {
    const token = "cf-T0ken-9f8e7d6c5b4a";
    const error = `bad ${token}; retry ${token} at https://api.example.it/zones?auth=${token}&x=1`;
    const [got] = parseAcmeFailures([line(error)], 0, [token]);
    expect(got?.problem).toBe("dns_provider");
    expect(got?.detail).not.toContain(token);
    expect(got?.detail.match(/\[REDACTED\]/g)).toHaveLength(3);
    expect(got?.detail).toContain("https://api.example.it/zones?auth=");
  });

  it("a credential that contains another credential is removed whatever the order", () => {
    const user = "admin-user";
    const password = "admin-user-Xk93-tail";
    for (const secrets of [
      [user, password],
      [password, user],
    ]) {
      const [got] = parseAcmeFailures([line(`401 for ${password} / ${user}`)], 0, secrets);
      expect(got?.detail).not.toContain("Xk93");
      expect(got?.detail).not.toContain("tail");
    }
  });

  it("a renew failure of le-dns is dns_provider too", () => {
    const renew = line("cloudflare: 403", "le-dns.acme", "Error renewing ACME certificate for {hotel.it [www.hotel.it]}");
    expect(parseAcmeFailures([renew], 0)).toMatchObject([{ hostname: "hotel.it", kind: "renew", problem: "dns_provider" }]);
  });

  it("the report scrubs a credential repeated in the log and set inside a URL", async () => {
    const root = await tmp();
    const secretDir = path.join(root, "acme-dns");
    await mkdir(secretDir, { mode: 0o700 });
    const text = Buffer.from(
      `${line(`user ${SECRET} / ${SECRET} via https://dns.example.it/acme?pw=${SECRET}`)}\n`,
    );
    const frame = Buffer.alloc(8);
    frame[0] = 1;
    frame.writeUInt32BE(text.length, 4);
    const mockDaemon = await startMockDockerDaemon({ logsBody: Buffer.concat([frame, text]) });
    cleanup.push(() => mockDaemon.close());
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir: path.join(root, "secrets"),
      ingressRootDir: path.join(root, "ingress"),
      pullMissingImages: false,
      panel: PANEL,
      acmeDnsSecretDir: secretDir,
    });
    await adapter.applyDnsProvider(req);
    const report = await adapter.getCertificateStatus({ failuresSince: "2026-11-09T09:00:00Z" });
    expect(report.failures).toMatchObject([{ problem: "dns_provider" }]);
    expect(JSON.stringify(report)).not.toContain("Canary");
  });
});
