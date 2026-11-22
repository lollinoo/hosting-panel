import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SiteHostRoute } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  TraefikIngressFileManager,
  buildSiteDynamicTraefikYaml,
  type AppStackRouteEntry,
  type PanelIngressConfig,
  type SiteIngressRouteEntry,
} from "../src/traefik-config.js";

/**
 * Compatibility sentinel (arch-assurance §5.3, acceptance A20 / B3, executor half): the Traefik directory a WordPress
 * site produces is the same set of bytes whether or not application stacks publish, change and remove routes next to it.
 * The WordPress route shapes are the ones the API pins record (route-hash.json, domains-jobs.json).
 */

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
const MANIFEST = "tls:\n  certificates: []\n";

const SITE = "site_0002";
const SVC = "svc_0001";
const OTHER_SITE = "site_0003";
const STACK_A = "stk_a1b2c3d4e5f6a1b2c3d4e5f6";
const STACK_B = "stk_0f1e2d3c4b5a69788796a5b4";

const host = (hostname: string, over: Partial<SiteHostRoute> = {}): SiteHostRoute => ({
  hostname,
  tls: false,
  httpsRedirect: false,
  redirectTo: null,
  ...over,
});
const wp = (hosts: readonly SiteHostRoute[], serviceInstanceId = SVC): SiteIngressRouteEntry => ({
  serviceInstanceId,
  containerName: `hp_svc_${serviceInstanceId}`,
  internalPort: 80,
  hosts,
});
const stack = (hosts: readonly SiteHostRoute[], componentKey = "web", internalPort = 8080): AppStackRouteEntry => ({
  componentKey,
  internalPort,
  hosts,
});

/** The three WordPress route shapes of the pins: afterCreate, the domains call, afterPrimaryChange. */
const WORDPRESS: ReadonlyArray<readonly [name: string, route: SiteIngressRouteEntry]> = [
  [
    "afterCreate",
    wp([host("wp-a.example.test"), host("www.wp-a.example.test", { redirectTo: "http://wp-a.example.test" })]),
  ],
  ["domains", wp([host("wp-a.example.test", { tls: true }), host("www.wp-a.example.test", { tls: true })])],
  [
    "afterPrimaryChange",
    wp([
      host("wp-a.example.test", { tls: true, httpsRedirect: true, redirectTo: "https://www.wp-a.example.test" }),
      host("www.wp-a.example.test", { tls: true, httpsRedirect: true }),
    ]),
  ],
];

const STACK_ROUTES = {
  two: [stack([host("shop.example.org", { tls: true, httpsRedirect: true }), host("www.shop.example.org", { tls: true })])],
  changed: [
    stack([host("shop.example.org", { tls: true, httpsRedirect: true }), host("store.example.org", { tls: true })]),
    stack([host("api.example.org")], "api", 9000),
  ],
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const newRoot = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hp-route-sentinel-"));
  roots.push(dir);
  return path.join(dir, "ingress");
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Entry {
  readonly sha: string;
  readonly mtimeMs: number;
  readonly ino: number;
}
type Snapshot = ReadonlyMap<string, Entry>;

/** {name → sha256, mtime, inode} of every entry of the dynamic directory (sub-directories by name only). */
async function snapshot(manager: TraefikIngressFileManager): Promise<Snapshot> {
  const out = new Map<string, Entry>();
  for (const name of (await readdir(manager.dynamicDirPath)).sort()) {
    const file = path.join(manager.dynamicDirPath, name);
    const info = await lstat(file);
    out.set(
      info.isDirectory() ? `${name}/` : name,
      info.isDirectory()
        ? { sha: "dir", mtimeMs: 0, ino: 0 }
        : { sha: createHash("sha256").update(await readFile(file)).digest("hex"), mtimeMs: info.mtimeMs, ino: info.ino },
    );
  }
  return out;
}
const isApp = (name: string): boolean => name.startsWith("app_");
const names = (snap: Snapshot): string[] => [...snap.keys()];
const withoutApps = (snap: Snapshot): Snapshot => new Map([...snap].filter(([name]) => !isApp(name)));

/** Fresh root with the panel file, the manual manifest and two sites already in place (spec step 1). */
async function seeded(): Promise<{ manager: TraefikIngressFileManager; root: string }> {
  const root = await newRoot();
  const manager = new TraefikIngressFileManager(root, PANEL);
  await manager.ensureStaticConfig(PANEL);
  await manager.writeManualCertificateManifest(MANIFEST);
  await manager.upsertServiceRoute(SITE, WORDPRESS[0]![1]);
  await manager.upsertServiceRoute(OTHER_SITE, wp([host("blog.example.test", { tls: true })], "svc_0009"));
  return { manager, root };
}

describe("the Traefik directory of a WordPress site does not change when application stacks come and go", () => {
  it("every non-application file keeps its sha256, mtime and inode through publish, change, identical publish and removal", async () => {
    const { manager } = await seeded();
    const base = await snapshot(manager);
    expect(names(base)).toEqual(
      expect.arrayContaining(["hp-manual-certificates.yml", "hp-panel.yml", path.basename(manager.getSiteDynamicFilePath(SITE))]),
    );
    expect(names(base).filter(isApp)).toEqual([]);
    const stackFile = `app_${STACK_A}.yml`;
    await sleep(20); // a rewrite of any file must show in its mtime

    const steps: ReadonlyArray<readonly [string, () => Promise<unknown>, boolean]> = [
      ["publish two hostnames", () => manager.writeAppStackRoutes(STACK_A, STACK_ROUTES.two), true],
      ["change them", () => manager.writeAppStackRoutes(STACK_A, STACK_ROUTES.changed), true],
      ["publish an identical set again", () => manager.writeAppStackRoutes(STACK_A, STACK_ROUTES.changed), true],
      ["remove", () => manager.removeAppStackRoutes(STACK_A), false],
    ];
    let previous: Snapshot | null = null;
    for (const [label, run, present] of steps) {
      await run();
      const now = await snapshot(manager);
      expect(withoutApps(now), label).toEqual(base);
      expect(names(now).filter(isApp), label).toEqual(present ? [stackFile] : []);
      expect(names(now), label).toEqual(present ? [...names(base), stackFile].sort() : names(base));
      if (label === "publish an identical set again") {
        // writeFileIfChanged discipline: an identical publish is not a rename (a rename reloads Traefik).
        expect(now.get(stackFile), label).toEqual(previous?.get(stackFile));
      }
      previous = now;
    }
    expect(names(await snapshot(manager))).toEqual(names(base));
  });

  it("an identical publish after a change leaves the stack file untouched and a real change rewrites only that file", async () => {
    const { manager } = await seeded();
    await manager.writeAppStackRoutes(STACK_A, STACK_ROUTES.two);
    await manager.writeAppStackRoutes(STACK_B, STACK_ROUTES.changed);
    const before = await snapshot(manager);
    await sleep(20);

    expect((await manager.writeAppStackRoutes(STACK_A, STACK_ROUTES.two)).changed).toBe(false);
    expect(await snapshot(manager)).toEqual(before);

    expect((await manager.writeAppStackRoutes(STACK_A, STACK_ROUTES.changed)).changed).toBe(true);
    const after = await snapshot(manager);
    const moved = names(after).filter((name) => JSON.stringify(after.get(name)) !== JSON.stringify(before.get(name)));
    expect(moved).toEqual([`app_${STACK_A}.yml`]);
  });

  it.each(WORDPRESS)(
    "the site file for the pinned %s route is the builder's bytes with stack files present, and equals the run without them",
    async (_name, route) => {
      const plain = await seeded();
      await plain.manager.upsertServiceRoute(SITE, route);
      const withStacks = await seeded();
      await withStacks.manager.writeAppStackRoutes(STACK_A, STACK_ROUTES.two);
      await withStacks.manager.writeAppStackRoutes(STACK_B, STACK_ROUTES.changed);
      await withStacks.manager.upsertServiceRoute(SITE, route);

      const siteFile = (m: TraefikIngressFileManager): Promise<string> => readFile(m.getSiteDynamicFilePath(SITE), "utf8");
      expect(await siteFile(withStacks.manager)).toBe(buildSiteDynamicTraefikYaml(SITE, [route], OPTS));
      expect(await siteFile(withStacks.manager)).toBe(await siteFile(plain.manager));
      // The whole non-application directory, not only the site file.
      expect([...withoutApps(await snapshot(withStacks.manager))].map(([n, e]) => [n, e.sha])).toEqual(
        [...(await snapshot(plain.manager))].map(([n, e]) => [n, e.sha]),
      );
    },
  );

  it("the same sequence of WordPress, DNS and manual-manifest operations ends in the same bytes with and without a stack interleaved", async () => {
    const run = async (interleave: boolean): Promise<Array<[string, string]>> => {
      const root = await newRoot();
      const manager = new TraefikIngressFileManager(root, PANEL);
      await manager.ensureStaticConfig(PANEL);
      if (interleave) await manager.writeAppStackRoutes(STACK_A, STACK_ROUTES.two);
      for (const [index, [, route]] of WORDPRESS.entries()) {
        await manager.upsertServiceRoute(SITE, route);
        if (interleave) await manager.writeAppStackRoutes(index % 2 === 0 ? STACK_B : STACK_A, STACK_ROUTES.changed);
      }
      await manager.upsertServiceRoute(OTHER_SITE, wp([host("blog.example.test", { tls: true, challenge: "dns-01" })], "svc_0009"));
      await manager.setDnsProviderState({ provider: "httpreq", fields: ["HTTPREQ_ENDPOINT", "HTTPREQ_PASSWORD"] });
      await manager.writeManualCertificateManifest(MANIFEST);
      await manager.ensureStaticConfig(PANEL);
      await manager.setDnsProviderState(null);
      if (interleave) {
        await manager.removeAppStackRoutes(STACK_A);
        await manager.removeAppStackRoutes(STACK_B);
      }
      return [...(await snapshot(manager))].map(([name, entry]) => [name, entry.sha]);
    };
    const without = await run(false);
    const withStacks = await run(true);
    expect(withStacks).toEqual(without);
    expect(without.map(([name]) => name)).toEqual(
      expect.arrayContaining(["hp-manual-certificates.yml", "hp-panel.yml", `site_${SITE}.yml`, `site_${OTHER_SITE}.yml`]),
    );
    expect(withStacks.map(([name]) => name).filter(isApp)).toEqual([]);
  });

  it("removing a stack that never existed or twice changes nothing", async () => {
    const { manager } = await seeded();
    const base = await snapshot(manager);
    await sleep(20);
    expect(await manager.removeAppStackRoutes(STACK_A)).toBe(false);
    await manager.writeAppStackRoutes(STACK_A, STACK_ROUTES.two);
    expect(await manager.removeAppStackRoutes(STACK_A)).toBe(true);
    expect(await manager.removeAppStackRoutes(STACK_A)).toBe(false);
    expect(await manager.writeAppStackRoutes(STACK_A, [])).toEqual({ changed: false, hostnames: [] });
    expect(await snapshot(manager)).toEqual(base);
  });
});

describe("the application file stays in its own namespace", () => {
  /** The router, middleware and service names of a dynamic file: keys at four-space indent under http. */
  const traefikNames = (yaml: string): string[] =>
    yaml
      .split("\n")
      .map((line) => /^ {4}([A-Za-z0-9_-]+):$/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);

  it("no router, middleware or service name of a stack file starts like a site or panel name or occurs in any other file", async () => {
    const { manager } = await seeded();
    await manager.writeAppStackRoutes(STACK_A, STACK_ROUTES.two);
    await manager.writeAppStackRoutes(STACK_B, STACK_ROUTES.changed);

    const appNames = new Set<string>();
    for (const id of [STACK_A, STACK_B]) {
      const yaml = await readFile(manager.getAppStackDynamicFilePath(id), "utf8");
      const own = traefikNames(yaml);
      expect(own.length).toBeGreaterThan(0);
      for (const name of own) {
        expect(name.startsWith(`app_${id}_`), name).toBe(true);
        expect(name).not.toMatch(/^(router_|svc_|site_|canon_|https_|hp-panel)/);
        expect(appNames.has(name), `duplicate ${name}`).toBe(false);
        appNames.add(name);
      }
      expect(yaml).not.toMatch(/^\s*(docker|providers|swarm|file):/m);
      expect(yaml).not.toContain("unix:///");
      expect(yaml).not.toContain("docker.sock");
    }

    const others = (await readdir(manager.dynamicDirPath)).filter((n) => n.endsWith(".yml") && !isApp(n));
    expect(others.length).toBeGreaterThanOrEqual(3);
    for (const file of others) {
      const yaml = await readFile(path.join(manager.dynamicDirPath, file), "utf8");
      for (const name of traefikNames(yaml)) expect(appNames.has(name), `${file}: ${name}`).toBe(false);
    }
  });

  it.each(["site_0002", "hp_panel", "manual_certs", "hp", "a"])(
    "a stack id %j can only ever map to app_<id>.yml, never to a file of a site, the panel or the manifest",
    async (id) => {
      const { manager } = await seeded();
      const base = await snapshot(manager);
      expect(path.basename(manager.getAppStackDynamicFilePath(id))).toBe(`app_${id}.yml`);
      await manager.writeAppStackRoutes(id, STACK_ROUTES.two);
      expect(names(await snapshot(manager)).filter((n) => !base.has(n))).toEqual([`app_${id}.yml`]);
      expect(withoutApps(await snapshot(manager))).toEqual(base);
      await manager.removeAppStackRoutes(id);
      expect(await snapshot(manager)).toEqual(base);
    },
  );
});
