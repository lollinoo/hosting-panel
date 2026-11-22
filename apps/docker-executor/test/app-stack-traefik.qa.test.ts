import { X509Certificate } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { SiteHostRoute } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueCert } from "../../api/test/fixtures/tls-certgen.js";
import { DockerEngineSocketAdapter, INGRESS_PROXY_CONTAINER_NAME } from "../src/index.js";
import {
  TraefikIngressFileManager,
  buildAppStackDynamicTraefikYaml,
  buildSiteDynamicTraefikYaml,
  type AppStackRouteEntry,
  type PanelIngressConfig,
  type SiteIngressRouteEntry,
} from "../src/traefik-config.js";
import type { DnsProviderState } from "../src/dns-provider.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";
import { TEST_ALLOWLIST, appStackTestPlan } from "./support/app-stack-plans.js";

/**
 * Q6 (arch-executor §14, spec §20 sentinel + B3, executor half): application route files live next to the site, panel
 * and manual-certificate files without touching them, never recreate the proxy, are serialised with the other writers
 * and ignore everything in the directory that is not theirs.
 */

/** Lets a test hold one rename (a slow disk) to open the window of a race. */
const renameHook = vi.hoisted(() => ({ hold: null as null | ((to: string) => Promise<void> | undefined) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      await renameHook.hold?.(to);
      return actual.rename(from, to);
    },
  };
});

function holdNextRename(target: string): { entered: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  let enter = (): void => undefined;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  renameHook.hold = (to) => {
    if (to !== target) return undefined;
    renameHook.hold = null;
    enter();
    return gate;
  };
  return { entered, release: () => release() };
}

const PANEL: PanelIngressConfig = {
  hostname: "srv12.example.it",
  ipv4: "203.0.113.10",
  acmeEmail: "ops@example.it",
  acmeStaging: false,
  acmeCaServer: null,
  acmeCaCertFile: null,
  upstreamPort: 3000,
};
const OPTS = { acmeEnabled: true, dnsChallenge: false, reservedHosts: [PANEL.hostname, PANEL.ipv4] };
const DNS: DnsProviderState = { provider: "httpreq", fields: ["HTTPREQ_ENDPOINT", "HTTPREQ_PASSWORD"] };
const MANIFEST = "tls:\n  certificates: []\n";
const STACK_A = "stk_a1b2c3d4e5f6a1b2c3d4e5f6";
const STACK_B = "stk_0f1e2d3c4b5a69788796a5b4";
const STACK_C = "stk_00112233445566778899aabb";

const host = (hostname: string, over: Partial<SiteHostRoute> = {}): SiteHostRoute => ({
  hostname,
  tls: false,
  httpsRedirect: false,
  redirectTo: null,
  ...over,
});
const wp = (hosts: readonly SiteHostRoute[], serviceInstanceId = "svc1"): SiteIngressRouteEntry => ({
  serviceInstanceId,
  containerName: `hp_svc_${serviceInstanceId}`,
  internalPort: 80,
  hosts,
});
const web = (hosts: readonly SiteHostRoute[], componentKey = "web", internalPort = 8080): AppStackRouteEntry => ({
  componentKey,
  internalPort,
  hosts,
});

const SHOP = [web([host("shop.example.org", { tls: true, httpsRedirect: true })])];
const SHOP_WWW = [web([host("shop.example.org", { tls: true, httpsRedirect: true }), host("www.shop.example.org", { tls: true })])];
const API = [web([host("api.example.org")], "api", 9000)];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  renameHook.hold = null;
  while (cleanups.length > 0) await cleanups.pop()?.();
});
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const newRoot = async (): Promise<string> => path.join(await tempDir("hp-app-traefik-qa-"), "ingress");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const text = (file: string): Promise<string> => readFile(file, "utf8");
const exists = (file: string): Promise<boolean> => lstat(file).then(() => true, () => false);
const dynamicNames = async (manager: TraefikIngressFileManager): Promise<string[]> => (await readdir(manager.dynamicDirPath)).sort();

// ---------------------------------------------------------------------------------------------------------------------
describe("site, panel and manual-certificate files are byte-identical with and without application route files", () => {
  /** Same operations either way; with `apps` three stacks publish before, between and after (one changes, one goes). */
  async function run(root: string, apps: boolean): Promise<Record<string, string>> {
    const manager = new TraefikIngressFileManager(root, PANEL);
    if (apps) {
      await manager.writeAppStackRoutes(STACK_A, SHOP_WWW);
      await manager.writeAppStackRoutes(STACK_B, API);
      await manager.writeAppStackRoutes(STACK_C, [web([host("dns.example.org", { tls: true, challenge: "dns-01" })])]);
    }
    await manager.ensureStaticConfig(PANEL);
    await manager.gatePanelCertificate(PANEL, async () => ({ a: [PANEL.ipv4], aaaa: [] }));
    await manager.upsertServiceRoute("site_1", wp([host("hotel.it", { tls: true, httpsRedirect: true }), host("www.hotel.it", { tls: true, redirectTo: "https://hotel.it" })]));
    await manager.upsertServiceRoute("site_1", wp([host("b.hotel.it", { tls: true, challenge: "dns-01" })], "svc2"));
    await manager.upsertServiceRoute("site_2", wp([host("plain.example.it")], "svc3"));
    await manager.writeManualCertificateManifest(MANIFEST);
    if (apps) await manager.writeAppStackRoutes(STACK_A, API);
    await manager.setDnsProviderState(DNS);
    // A restarted executor hydrates the sites from disk with the application files in the directory.
    const restarted = new TraefikIngressFileManager(root, PANEL);
    await restarted.upsertServiceRoute("site_2", wp([host("plain.example.it"), host("more.example.it", { tls: true })], "svc3"));
    await restarted.removeServiceRoute("svc2");
    await restarted.ensureStaticConfig(PANEL);
    if (apps) await restarted.removeAppStackRoutes(STACK_B);
    await restarted.setDnsProviderState(null);
    const files = (await dynamicNames(restarted)).filter((n) => /^(site_.*\.yml|hp-panel\.yml|hp-manual-certificates\.yml)$/.test(n));
    return Object.fromEntries(await Promise.all(files.map(async (n) => [n, await text(path.join(restarted.dynamicDirPath, n))] as const)));
  }

  it("holds for a long mixed sequence of site, panel, DNS and manual-manifest operations", async () => {
    const without = await run(await newRoot(), false);
    const withApps = await run(await newRoot(), true);
    expect(Object.keys(without).sort()).toEqual(["hp-manual-certificates.yml", "hp-panel.yml", "site_site_1.yml", "site_site_2.yml"]);
    expect(withApps).toEqual(without);
    expect(without["hp-panel.yml"]).toContain("certResolver: le");
    expect(without["site_site_2.yml"]).toContain("more.example.it");
  });

  it("the site file is the pure builder's output whatever else is in the directory", async () => {
    const root = await newRoot();
    const manager = new TraefikIngressFileManager(root, PANEL);
    await manager.writeAppStackRoutes(STACK_A, SHOP_WWW);
    const route = wp([host("hotel.it", { tls: true, httpsRedirect: true })]);
    await manager.upsertServiceRoute("site_1", route);
    expect(await text(manager.getSiteDynamicFilePath("site_1"))).toBe(buildSiteDynamicTraefikYaml("site_1", [route], OPTS));
  });

  it("a stack hostname equal to a site hostname does not leak into either file", async () => {
    const manager = new TraefikIngressFileManager(await newRoot(), PANEL);
    await manager.upsertServiceRoute("site_1", wp([host("shared.example.org")]));
    const site = await text(manager.getSiteDynamicFilePath("site_1"));
    await manager.writeAppStackRoutes(STACK_A, [web([host("shared.example.org")])]);
    expect(await text(manager.getSiteDynamicFilePath("site_1"))).toBe(site);
    expect(await text(manager.getAppStackDynamicFilePath(STACK_A))).not.toContain("hp_svc_");
    expect(site).not.toContain("hp_app_");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("through the Docker adapter: a route change rewrites one file and never recreates the proxy", () => {
  async function rig() {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    cleanups.push(async () => void vi.restoreAllMocks());
    const daemon = await startMockDockerDaemon();
    cleanups.push(() => daemon.close());
    const dir = await tempDir("hp-app-traefik-adapter-");
    const listener = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));
    const port = (listener.address() as AddressInfo).port;
    const base = appStackTestPlan();
    const [front, worker] = base.components;
    const plan = appStackTestPlan({
      components: [{ ...front!, expose: [8080, port], healthcheck: { kind: "tcp", port, intervalSeconds: 10, timeoutSeconds: 3 } }, worker!],
    });
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: daemon.socketPath,
      secretsRootDir: path.join(dir, "secrets"),
      ingressRootDir: path.join(dir, "ingress"),
      pullMissingImages: false,
      appImageAllowlist: TEST_ALLOWLIST,
      panel: PANEL,
    });
    const manager = (adapter as unknown as { ingressManager: TraefikIngressFileManager }).ingressManager;
    await adapter.prepareAppStack({ plan });
    await adapter.createAppStackComponents({ plan });
    await adapter.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] });
    const proxy = () => [...daemon.containers.values()].find((c) => c.name === INGRESS_PROXY_CONTAINER_NAME);
    const routesOf = (hosts: readonly SiteHostRoute[]) => [{ componentKey: "web", internalPort: 8080, hosts: [...hosts] }];
    return { adapter, daemon, manager, plan, proxy, routesOf };
  }

  const PLAIN = [host("shop.example.org", { tls: true, httpsRedirect: true })];
  const MORE = [...PLAIN, host("www.shop.example.org", { tls: true })];
  const MUTATING = /\/containers\/create|\/containers\/[^/?]+\/(?:stop|start|restart|kill|rename)|\/containers\/(?!json)[^/?]+\?|\/containers\/prune/;

  it("add a host, identical publish, drop a host, unpublish: only app_<stack>.yml moves, the proxy keeps its identity", async () => {
    const { adapter, daemon, manager, plan, proxy, routesOf } = await rig();
    await manager.upsertServiceRoute("site_1", wp([host("hotel.it", { tls: true })]));
    await manager.writeManualCertificateManifest(MANIFEST);
    const first = await adapter.publishAppStackRoutes({ plan, routes: routesOf(PLAIN) });
    expect(first).toEqual({ routeCount: 1, hostnames: ["shop.example.org"], changed: true });
    const proxyBefore = proxy();
    expect(proxyBefore?.running).toBe(true);
    const appFile = manager.getAppStackDynamicFilePath(plan.stackId);
    const others = (await dynamicNames(manager)).filter((n) => path.join(manager.dynamicDirPath, n) !== appFile && !n.endsWith("/"));
    const stateOf = async () =>
      Object.fromEntries(
        await Promise.all(
          others.map(async (n) => {
            const file = path.join(manager.dynamicDirPath, n);
            const info = await stat(file);
            return [n, info.isDirectory() ? "dir" : `${await text(file)}|${String(info.mtimeMs)}|${String(info.ino)}`] as const;
          }),
        ),
      );
    const siblings = await stateOf();
    await sleep(20);
    const mark = daemon.requestedPaths.length;
    const creates = () => daemon.requestedPaths.filter((p) => p.includes("/containers/create")).length;
    const createsBefore = creates();

    const added = await adapter.publishAppStackRoutes({ plan, routes: routesOf(MORE) });
    expect(added).toEqual({ routeCount: 1, hostnames: ["shop.example.org", "www.shop.example.org"], changed: true });
    expect(await text(appFile)).toBe(buildAppStackDynamicTraefikYaml(plan.stackId, routesOf(MORE) as AppStackRouteEntry[], OPTS));
    const inode = (await stat(appFile)).ino;
    expect(await adapter.publishAppStackRoutes({ plan, routes: routesOf(MORE) })).toMatchObject({ changed: false });
    expect((await stat(appFile)).ino).toBe(inode);
    expect(await adapter.publishAppStackRoutes({ plan, routes: routesOf(PLAIN) })).toMatchObject({ changed: true, hostnames: ["shop.example.org"] });
    expect(await stateOf()).toEqual(siblings);

    expect(await adapter.unpublishAppStackRoutes({ stackId: plan.stackId, organizationId: plan.organizationId })).toMatchObject({ changed: true });
    expect(await exists(appFile)).toBe(false);
    expect(await stateOf()).toEqual(siblings);

    expect(creates()).toBe(createsBefore);
    expect(daemon.requestedPaths.slice(mark).filter((p) => MUTATING.test(p))).toEqual([]);
    const proxyAfter = proxy();
    expect([proxyAfter?.id, proxyAfter?.running]).toEqual([proxyBefore?.id, true]);
    expect([...daemon.containers.values()].filter((c) => c.name === INGRESS_PROXY_CONTAINER_NAME)).toHaveLength(1);
  });

  it("a refused route (reserved panel host) writes nothing and touches no container", async () => {
    const { adapter, daemon, manager, plan, proxy, routesOf } = await rig();
    await adapter.publishAppStackRoutes({ plan, routes: routesOf(PLAIN) });
    const appFile = manager.getAppStackDynamicFilePath(plan.stackId);
    const before = await readFile(appFile);
    const proxyId = proxy()?.id;
    const mark = daemon.requestedPaths.length;
    await expect(adapter.publishAppStackRoutes({ plan, routes: routesOf([host(PANEL.hostname)]) })).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });
    expect(await readFile(appFile)).toEqual(before);
    expect(daemon.requestedPaths.slice(mark).filter((p) => MUTATING.test(p))).toEqual([]);
    expect(proxy()?.id).toBe(proxyId);
  });

  describe("manual TLS publish refuses a certificate that captures a stack host", () => {
    const fingerprintOf = (pem: string): string => new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase();
    let counter = 0;
    const version = (dns: readonly string[]) => {
      const cert = issueCert({ dns });
      counter += 1;
      return {
        versionId: `ctv_${counter.toString(16).padStart(32, "0")}`,
        fullchainPem: cert.pem,
        keyPem: cert.keyPem,
        fingerprintSha256: fingerprintOf(cert.pem),
      };
    };

    it.each([
      ["a wildcard over the stack host", ["*.example.org"]],
      ["the stack host's own certificate assigned to another host", ["shop.example.org"]],
    ])("%s: captures_host, naming the host, nothing written, nothing restarted", async (_name, names) => {
      const { adapter, daemon, manager, plan, proxy, routesOf } = await rig();
      await adapter.publishAppStackRoutes({ plan, routes: routesOf(PLAIN) });
      expect(await manager.listRoutedHostnames()).toEqual(["shop.example.org", PANEL.hostname].sort());
      const m = version(names);
      await adapter.manualTls({ action: "putVersion", ...m });
      const proxyId = proxy()?.id;
      const mark = daemon.requestedPaths.length;

      const result = await adapter.manualTls({
        action: "publish",
        baseGeneration: 0,
        entries: [{ versionId: m.versionId, assignedHosts: ["other.example.org"] }],
        expect: [],
      });
      expect(result).toMatchObject({ generation: 0, outcome: "captures_host", served: [], evicted: [] });
      expect(result.violations.map((v) => [v.kind, v.hostname])).toContainEqual(["captures_host", "shop.example.org"]);
      expect(await exists(path.join(manager.dynamicDirPath, "hp-manual-certificates.yml"))).toBe(false);
      expect(await exists(manager.manualTlsStatePath)).toBe(false);
      expect(daemon.requestedPaths.slice(mark).filter((p) => MUTATING.test(p))).toEqual([]);
      expect(proxy()?.id).toBe(proxyId);
    });

    it("once the stack's routes are unpublished its host is no longer guarded", async () => {
      const { adapter, manager, plan, routesOf } = await rig();
      await adapter.publishAppStackRoutes({ plan, routes: routesOf(PLAIN) });
      await adapter.unpublishAppStackRoutes({ stackId: plan.stackId, organizationId: plan.organizationId });
      expect(await manager.listRoutedHostnames()).toEqual([PANEL.hostname]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("stack and site route writes share one file line", () => {
  it("a stack write waits for a held site write, and a site write waits for a held stack write", async () => {
    const manager = new TraefikIngressFileManager(await newRoot(), PANEL);
    const siteFile = manager.getSiteDynamicFilePath("site_1");
    const appFile = manager.getAppStackDynamicFilePath(STACK_A);

    let held = holdNextRename(siteFile);
    const site = manager.upsertServiceRoute("site_1", wp([host("hotel.it")]));
    await held.entered;
    let stackDone = false;
    const stackWrite = manager.writeAppStackRoutes(STACK_A, SHOP).then((r) => ((stackDone = true), r));
    await sleep(40);
    expect(stackDone).toBe(false);
    expect(await exists(appFile)).toBe(false);
    held.release();
    await Promise.all([site, stackWrite]);
    expect([await exists(siteFile), await exists(appFile)]).toEqual([true, true]);

    await manager.removeAppStackRoutes(STACK_A);
    held = holdNextRename(appFile);
    const stackFirst = manager.writeAppStackRoutes(STACK_A, SHOP);
    await held.entered;
    let siteDone = false;
    const siteWrite = manager.upsertServiceRoute("site_1", wp([host("hotel.it"), host("b.hotel.it")])).then((r) => ((siteDone = true), r));
    await sleep(40);
    expect(siteDone).toBe(false);
    expect(await text(siteFile)).not.toContain("b.hotel.it");
    held.release();
    await Promise.all([stackFirst, siteWrite]);
    expect(await text(siteFile)).toContain("b.hotel.it");
  });

  it("a removal queued behind a held stack write wins; the file is gone and no temp file remains", async () => {
    const manager = new TraefikIngressFileManager(await newRoot(), PANEL);
    const appFile = manager.getAppStackDynamicFilePath(STACK_A);
    const held = holdNextRename(appFile);
    const write = manager.writeAppStackRoutes(STACK_A, SHOP);
    await held.entered;
    const removal = manager.removeAppStackRoutes(STACK_A);
    await sleep(30);
    held.release();
    await write;
    expect(await removal).toBe(true);
    expect(await exists(appFile)).toBe(false);
    expect((await dynamicNames(manager)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("a DNS provider re-render waits for a held stack write and then rewrites it with le-dns", async () => {
    const manager = new TraefikIngressFileManager(await newRoot(), PANEL);
    const dnsRoutes = [web([host("shop.example.org", { tls: true, challenge: "dns-01" })])];
    await manager.writeAppStackRoutes(STACK_A, dnsRoutes);
    const appFile = manager.getAppStackDynamicFilePath(STACK_A);
    const held = holdNextRename(appFile);
    const change = manager.writeAppStackRoutes(STACK_A, [web([host("shop.example.org", { tls: true, challenge: "dns-01" }), host("b.example.org")])]);
    await held.entered;
    const rerender = manager.setDnsProviderState(DNS);
    await sleep(30);
    held.release();
    await Promise.all([change, rerender]);
    const yaml = await text(appFile);
    expect(yaml).toContain("b.example.org");
    expect(yaml).toMatch(/^ {8}certResolver: le-dns$/m);
  });

  it("a burst of interleaved stack, site and manifest writes ends in the last issued state of each file", async () => {
    const manager = new TraefikIngressFileManager(await newRoot(), PANEL);
    const stackSets: AppStackRouteEntry[][] = [SHOP, SHOP_WWW, API, SHOP, SHOP_WWW].map((s) => [...s]);
    const siteRoutes = [1, 2, 3, 4, 5].map((n) => wp([host(`h${String(n)}.hotel.it`)]));
    const ops: Array<Promise<unknown>> = [];
    for (let i = 0; i < 5; i += 1) {
      ops.push(manager.writeAppStackRoutes(STACK_A, stackSets[i]!));
      ops.push(manager.upsertServiceRoute("site_1", siteRoutes[i]!));
      ops.push(manager.writeAppStackRoutes(STACK_B, i % 2 === 0 ? API : []));
      ops.push(manager.writeManualCertificateManifest(`# ${String(i)}\n`));
    }
    await Promise.all(ops);
    expect(await text(manager.getAppStackDynamicFilePath(STACK_A))).toBe(buildAppStackDynamicTraefikYaml(STACK_A, stackSets[4]!, OPTS));
    expect(await text(manager.getAppStackDynamicFilePath(STACK_B))).toBe(buildAppStackDynamicTraefikYaml(STACK_B, API, OPTS));
    expect(await text(manager.getSiteDynamicFilePath("site_1"))).toBe(buildSiteDynamicTraefikYaml("site_1", [siteRoutes[4]!], OPTS));
    expect(await text(path.join(manager.dynamicDirPath, "hp-manual-certificates.yml"))).toBe("# 4\n");
    expect(await dynamicNames(manager)).toEqual(
      [`app_${STACK_A}.yml`, `app_${STACK_B}.yml`, "hp-manual-certificates.yml", "site_site_1.yml"].sort(),
    );
  });

  it("a refused stack write does not poison the line: the next site and stack writes still go through", async () => {
    const manager = new TraefikIngressFileManager(await newRoot(), PANEL);
    const refused = manager.writeAppStackRoutes(STACK_A, [web([host(PANEL.hostname)])]);
    const site = manager.upsertServiceRoute("site_1", wp([host("hotel.it")]));
    const stack = manager.writeAppStackRoutes(STACK_A, SHOP);
    await expect(refused).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });
    await expect(site).resolves.toMatchObject({ configured: true });
    await expect(stack).resolves.toMatchObject({ changed: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("hostile entries in the dynamic directory are ignored", () => {
  const EVIL = buildAppStackDynamicTraefikYaml("stk_deadbeef", [web([host("evil.example.org")])], OPTS);
  const HOSTILE_NAMES = [
    "app_X.yml",
    "App_stk_a.yml",
    "app_a..b.yml",
    "app_.yml",
    "app_1x.yml",
    "app_-x.yml",
    "app_a-b.yml",
    "app_a b.yml",
    "app_stk_a.yml ",
    "app_stk_a.yml~",
    "app_stk_a.yml.bak",
    "app_stk_a.yaml",
    "xapp_stk_a.yml",
    ".app_stk_a.yml.abcdef012345.tmp",
    "app_stk_a.yml.tmp",
    `app_${"a".repeat(65)}.yml`,
    "app_é.yml",
    "app_a\nb.yml",
    "site_app_stk_a.yml",
    "hp-app_stk_a.yml",
  ];

  it("none of them contributes a hostname, is rewritten by a DNS change, or is removed by a stack removal", async () => {
    const manager = new TraefikIngressFileManager(await newRoot(), PANEL);
    await manager.writeAppStackRoutes(STACK_A, [web([host("shop.example.org", { tls: true, challenge: "dns-01" })])]);
    for (const name of HOSTILE_NAMES) await writeFile(path.join(manager.dynamicDirPath, name), EVIL);
    await mkdir(path.join(manager.dynamicDirPath, "app_dir.yml"));
    await writeFile(path.join(manager.dynamicDirPath, "app_dir.yml", "app_inner.yml"), EVIL);
    const old = new Date("2020-01-01T00:00:00Z");
    for (const name of HOSTILE_NAMES) await utimes(path.join(manager.dynamicDirPath, name), old, old);
    const before = Object.fromEntries(
      await Promise.all(HOSTILE_NAMES.map(async (n) => [n, [await text(path.join(manager.dynamicDirPath, n)), (await stat(path.join(manager.dynamicDirPath, n))).mtimeMs]] as const)),
    );

    expect(await manager.listRoutedHostnames()).toEqual(["shop.example.org", PANEL.hostname].sort());
    expect(await manager.setDnsProviderState(DNS)).toBe(true);
    expect(await text(manager.getAppStackDynamicFilePath(STACK_A))).toMatch(/^ {8}certResolver: le-dns$/m);
    await manager.writeAppStackRoutes(STACK_B, API);
    await manager.removeAppStackRoutes(STACK_B);
    await manager.removeAppStackRoutes(STACK_A);

    const after = Object.fromEntries(
      await Promise.all(HOSTILE_NAMES.map(async (n) => [n, [await text(path.join(manager.dynamicDirPath, n)), (await stat(path.join(manager.dynamicDirPath, n))).mtimeMs]] as const)),
    );
    expect(after).toEqual(before);
    expect(await manager.listRoutedHostnames()).toEqual([PANEL.hostname]);
    expect(await text(path.join(manager.dynamicDirPath, "app_dir.yml", "app_inner.yml"))).toBe(EVIL);
    expect(await dynamicNames(manager)).toEqual([...HOSTILE_NAMES, "app_dir.yml"].sort());
  });

  it("a symlink named like a stack file is never followed on write: the target outside the directory keeps its bytes", async () => {
    const manager = new TraefikIngressFileManager(await newRoot(), PANEL);
    await manager.ensureStaticConfig(PANEL);
    const outside = path.join(path.dirname(manager.ingressRootDir), "outside.yml");
    await writeFile(outside, "# not ours\n");
    await symlink(outside, manager.getAppStackDynamicFilePath(STACK_A));
    await manager.writeAppStackRoutes(STACK_A, SHOP);
    expect(await text(outside)).toBe("# not ours\n");
    expect((await lstat(manager.getAppStackDynamicFilePath(STACK_A))).isSymbolicLink()).toBe(false);
    expect(await text(manager.getAppStackDynamicFilePath(STACK_A))).toBe(buildAppStackDynamicTraefikYaml(STACK_A, SHOP, OPTS));
    await symlink(outside, manager.getAppStackDynamicFilePath(STACK_B));
    expect(await manager.removeAppStackRoutes(STACK_B)).toBe(true);
    expect(await text(outside)).toBe("# not ours\n");
  });

  it.each(["../x", "a/b", "x/../hp-panel", "..", "", "A", "stk-a", "stk a", "stk_a\n", "é", "a".repeat(65)])(
    "stack id %j never reaches the file system",
    async (id) => {
      const manager = new TraefikIngressFileManager(await newRoot(), PANEL);
      await manager.ensureStaticConfig(PANEL);
      const before = await dynamicNames(manager);
      expect(() => manager.getAppStackDynamicFilePath(id)).toThrow();
      await expect(manager.writeAppStackRoutes(id, SHOP)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(manager.removeAppStackRoutes(id)).rejects.toThrow();
      await expect(manager.readAppStackRoutes(id)).rejects.toThrow();
      expect(await dynamicNames(manager)).toEqual(before);
    },
  );
});
