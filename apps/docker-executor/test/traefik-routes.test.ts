import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SiteHostRoute } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MANUAL_CERTIFICATES_FILE_NAME,
  MANUAL_CERTS_DIR_NAME,
  MANUAL_TLS_STATE_FILE,
} from "../src/traefik-config.js";
import {
  ACME_DNS_SECRET_MOUNT,
  TraefikIngressFileManager,
  acmeStorageFileName,
  buildIngressProxyContainerPayload,
  buildSiteDynamicTraefikYaml,
  buildTraefikStaticYaml,
  dnsProviderFileEnv,
  parseDnsProviderState,
  parsePanelIngressConfigFromEnv,
  type DnsProviderState,
  type PanelIngressConfig,
  type SiteIngressRouteEntry,
} from "../src/index.js";

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

/** Holds the next rename onto `target` until release(); `entered` resolves when it is held. */
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

const h = (hostname: string): string =>
  createHash("sha256").update(hostname).digest("hex").slice(0, 8);

const host = (hostname: string, over: Partial<SiteHostRoute> = {}): SiteHostRoute => ({
  hostname,
  tls: false,
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

/** The YAML block of one router or middleware, up to the next sibling at the same indent. */
function block(yaml: string, name: string): string {
  const lines = yaml.split("\n");
  const start = lines.indexOf(`    ${name}:`);
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && /^ {0,4}\S/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

const PAIR = [
  host("hotel.it", { tls: true, httpsRedirect: true }),
  host("www.hotel.it", { tls: true, redirectTo: "https://hotel.it" }),
];

describe("site routes per host", () => {
  it("pair with https: primary redirects to https, partner redirects to the canonical origin", () => {
    const yaml = buildSiteDynamicTraefikYaml("site_1", [route(PAIR)], OPTS);
    const A = h("hotel.it");
    const B = h("www.hotel.it");
    expect(block(yaml, `router_svc1_${A}_tls`)).toContain("certResolver: le");
    expect(block(yaml, `router_svc1_${A}_tls`)).toContain('- "websecure"');
    expect(block(yaml, `router_svc1_${A}`)).toContain('- "https_svc1"');
    expect(block(yaml, "https_svc1")).toContain("redirectScheme:");
    expect(block(yaml, `canon_svc1_${B}`)).toContain('replacement: "https://hotel.it${1}"');
    expect(block(yaml, `canon_svc1_${B}`)).toContain('regex: "^https?://[^/]+(.*)$"');
    expect(block(yaml, `router_svc1_${B}`)).toContain(`- "canon_svc1_${B}"`);
    expect(block(yaml, `router_svc1_${B}`)).not.toContain("https_svc1");
    expect(block(yaml, `router_svc1_${B}_tls`)).toContain(`- "canon_svc1_${B}"`);
    expect(yaml.match(/^ {4}https_svc1:$/gm)).toHaveLength(1);
  });

  it("router names do not change when a name is added", () => {
    const names = (yaml: string) =>
      yaml.split("\n").filter((l) => /^ {4}router_svc1_[0-9a-f]{8}(_tls)?:$/.test(l));
    const before = names(buildSiteDynamicTraefikYaml("site_1", [route(PAIR)], OPTS));
    const after = names(
      buildSiteDynamicTraefikYaml("site_1", [route([...PAIR, host("blog.hotel.it")])], OPTS),
    );
    expect(before).toHaveLength(4);
    for (const n of before) expect(after).toContain(n);
  });

  it("a host without tls has no websecure router", () => {
    const yaml = buildSiteDynamicTraefikYaml("site_1", [route([host("hotel.it")])], OPTS);
    expect(yaml).not.toContain("websecure");
    expect(yaml).not.toContain("certResolver");
    expect(block(yaml, `router_svc1_${h("hotel.it")}`)).not.toContain("middlewares");
  });

  it("tls without https redirect still emits the resolver router", () => {
    const yaml = buildSiteDynamicTraefikYaml(
      "site_1",
      [route([host("hotel.it", { tls: true })])],
      OPTS,
    );
    expect(block(yaml, `router_svc1_${h("hotel.it")}_tls`)).toContain("certResolver: le");
    expect(yaml).not.toContain("redirectScheme");
  });

  it("acme disabled strips resolver and https redirect", () => {
    const yaml = buildSiteDynamicTraefikYaml("site_1", [route(PAIR)], {
      ...OPTS,
      acmeEnabled: false,
    });
    expect(yaml).not.toContain("certResolver");
    expect(yaml).not.toContain("websecure");
    expect(yaml).not.toContain("redirectScheme");
    expect(yaml).toContain(`canon_svc1_${h("www.hotel.it")}`);
  });

  it("no HSTS header is configured", () => {
    const yaml = buildSiteDynamicTraefikYaml("site_1", [route(PAIR)], OPTS);
    expect(yaml).not.toContain("stsSeconds");
    expect(yaml).not.toContain("headers:");
  });

  it("rejects a redirectTo with a path or a quote", async () => {
    const root = await tmp();
    const manager = new TraefikIngressFileManager(root, PANEL);
    for (const bad of ["https://hotel.it/x", 'https://hotel.it"\n  evil:']) {
      const hosts = [host("www.hotel.it", { redirectTo: bad })];
      expect(() => buildSiteDynamicTraefikYaml("site_1", [route(hosts)], OPTS)).toThrow(
        expect.objectContaining({ code: "HOST_POLICY_DENIED" }),
      );
      await expect(manager.upsertServiceRoute("site_1", route(hosts))).rejects.toMatchObject({
        code: "HOST_POLICY_DENIED",
      });
    }
    expect(await readdir(path.join(root, "dynamic")).catch(() => [])).toEqual([]);
  });

  it("rejects wildcard, IP and panel hostnames", () => {
    for (const hosts of [
      [host("*.hotel.it")],
      [host("1.2.3.4")],
      [host("Hotel.it")],
      [host("hotel.it.")],
      [host(PANEL.hostname)],
      [host("hotel.it", { redirectTo: `https://${PANEL.hostname}` })],
      [host("hotel.it", { redirectTo: `http://${PANEL.ipv4}` })],
    ]) {
      expect(() => buildSiteDynamicTraefikYaml("site_1", [route(hosts)], OPTS)).toThrow(
        expect.objectContaining({ code: "HOST_POLICY_DENIED" }),
      );
    }
  });

  it("rejects duplicate hostnames and more than 20 hosts", () => {
    expect(() =>
      buildSiteDynamicTraefikYaml("site_1", [route([host("a.it"), host("a.it")])], OPTS),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    const many = Array.from({ length: 21 }, (_, i) => host(`h${String(i)}.it`));
    expect(() => buildSiteDynamicTraefikYaml("site_1", [route(many)], OPTS)).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
    expect(() =>
      buildSiteDynamicTraefikYaml("site_1", [route(many.slice(0, 20))], OPTS),
    ).not.toThrow();
  });
});

const cleanup: string[] = [];
afterEach(async () => {
  renameHook.hold = null;
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hp-routes-"));
  cleanup.push(dir);
  return path.join(dir, "ingress");
}

describe("route files on disk", () => {
  it("reads a 2a route comment with domains as plain hosts", async () => {
    const root = await tmp();
    const seed = new TraefikIngressFileManager(root, PANEL);
    await seed.upsertServiceRoute("site_1", route([host("seed.it")]));
    const file = seed.getSiteDynamicFilePath("site_1");
    const legacy = {
      serviceInstanceId: "svc_old",
      containerName: "hp-site-1-old",
      internalPort: 8080,
      domains: ["old.hotel.it", "www.old.hotel.it"],
    };
    await writeFile(file, `# Managed\n# @hp-route ${JSON.stringify(legacy)}\nhttp:\n`);

    const manager = new TraefikIngressFileManager(root, PANEL);
    await manager.upsertServiceRoute("site_1", route([host("hotel.it")]));
    const yaml = await readFile(file, "utf8");
    expect(yaml).toContain(`router_svc_old_${h("old.hotel.it")}:`);
    expect(yaml).toContain(`router_svc_old_${h("www.old.hotel.it")}:`);
    expect(yaml).toContain('url: "http://hp-site-1-old:8080"');
    expect(yaml).toContain(
      `# @hp-route ${JSON.stringify({
        ...legacy,
        domains: undefined,
        hosts: legacy.domains.map((d) => host(d)),
      })}`,
    );
    expect(yaml).not.toContain("certResolver");
  });

  it("does not rewrite an unchanged site file or panel file", async () => {
    const root = await tmp();
    const manager = new TraefikIngressFileManager(root, PANEL);
    await manager.ensureStaticConfig(PANEL);
    await manager.upsertServiceRoute("site_1", route(PAIR));
    const siteFile = manager.getSiteDynamicFilePath("site_1");
    const panelFile = path.join(root, "dynamic", "hp-panel.yml");
    const before = [(await stat(siteFile)).mtimeMs, (await stat(panelFile)).mtimeMs];
    const inodes = [(await stat(siteFile)).ino, (await stat(panelFile)).ino];
    await new Promise((r) => setTimeout(r, 20));
    await manager.upsertServiceRoute("site_1", route(PAIR));
    await manager.ensureStaticConfig(PANEL);
    expect([(await stat(siteFile)).mtimeMs, (await stat(panelFile)).mtimeMs]).toEqual(before);
    expect([(await stat(siteFile)).ino, (await stat(panelFile)).ino]).toEqual(inodes);
  });

  it("copies the custom CA certificate with mode 0644 and creates the active store", async () => {
    const root = await tmp();
    const src = path.join(path.dirname(root), "ca.pem");
    await writeFile(src, "-----BEGIN CERTIFICATE-----\nX\n", { mode: 0o600 });
    const panel = { ...PANEL, acmeCaServer: "https://pebble:14000/dir", acmeCaCertFile: src };
    await new TraefikIngressFileManager(root, panel).ensureStaticConfig(panel);
    const ca = path.join(root, "acme", "custom-ca.pem");
    expect(await readFile(ca, "utf8")).toBe("-----BEGIN CERTIFICATE-----\nX\n");
    expect((await stat(ca)).mode & 0o777).toBe(0o644);
    expect((await stat(path.join(root, "acme", "acme-custom.json"))).mode & 0o777).toBe(0o600);
  });
});

describe("proxy and static config", () => {
  it("proxy log is rotated", () => {
    const payload = buildIngressProxyContainerPayload({
      staticConfigHostPath: "/s/traefik.yml",
      dynamicDirHostPath: "/s/dynamic",
      acmeDirHostPath: "/s/acme",
    });
    expect(payload.HostConfig.LogConfig.Type).toBe("json-file");
    expect(payload.HostConfig.LogConfig.Config["max-size"]).toBe("10m");
    expect(payload.HostConfig.LogConfig.Config["max-file"]).toBe("3");
  });

  it("static config logs json and stores staging certificates apart", () => {
    const staging = buildTraefikStaticYaml({ ...PANEL, acmeStaging: true });
    expect(staging).toContain("log:\n  format: json");
    expect(staging).toContain("storage: /etc/traefik/acme/acme-staging.json");
    expect(staging).toContain("caServer: https://acme-staging-v02.api.letsencrypt.org/directory");

    const prod = buildTraefikStaticYaml(PANEL);
    expect(prod).toContain("log:\n  format: json");
    expect(prod).toContain("storage: /etc/traefik/acme/acme.json");
    expect(prod).not.toContain("caServer");
    expect(buildTraefikStaticYaml(null)).toContain("log:\n  format: json");

    expect(acmeStorageFileName(PANEL)).toBe("acme.json");
    expect(acmeStorageFileName({ ...PANEL, acmeStaging: true })).toBe("acme-staging.json");
    expect(
      acmeStorageFileName({ ...PANEL, acmeStaging: true, acmeCaServer: "https://ca.test/dir" }),
    ).toBe("acme-custom.json");
  });

  it("custom CA adds caCertificates and is refused unless https", () => {
    const yaml = buildTraefikStaticYaml({
      ...PANEL,
      acmeStaging: true,
      acmeCaServer: "https://pebble:14000/dir",
      acmeCaCertFile: "/etc/hosting-panel/pebble.pem",
    });
    expect(yaml).toContain('caServer: "https://pebble:14000/dir"');
    expect(yaml).toContain("caCertificates:\n        - /etc/traefik/acme/custom-ca.pem");
    expect(yaml).toContain("storage: /etc/traefik/acme/acme-custom.json");
    expect(yaml).not.toContain("acme-staging-v02");

    expect(() =>
      buildTraefikStaticYaml({ ...PANEL, acmeCaServer: "http://pebble:14000/dir" }),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    const env = {
      HP_PANEL_HOSTNAME: PANEL.hostname,
      HP_PANEL_IPV4: PANEL.ipv4,
      HP_ACME_EMAIL: "ops@example.it",
    };
    expect(
      parsePanelIngressConfigFromEnv({ ...env, HP_ACME_CA_SERVER: "http://pebble/dir" }),
    ).toBeNull();
    expect(
      parsePanelIngressConfigFromEnv({
        ...env,
        HP_ACME_CA_SERVER: "https://pebble/dir",
        HP_ACME_CA_CERT_FILE: "/etc/ca.pem",
      }),
    ).toMatchObject({ acmeCaServer: "https://pebble/dir", acmeCaCertFile: "/etc/ca.pem" });
  });
});

describe("panel certificate gate (owner decision: wait for DNS like the sites)", () => {
  const here = async () => ({ a: [PANEL.ipv4], aaaa: [] });
  const panelYaml = (root: string) => readFile(path.join(root, "dynamic", "hp-panel.yml"), "utf8");

  it("asks Let's Encrypt only once the A record points here and there is no AAAA", async () => {
    const root = await tmp();
    const manager = new TraefikIngressFileManager(root, PANEL);
    expect(await manager.gatePanelCertificate(PANEL, async () => ({ a: ["198.51.100.7"], aaaa: [] }))).toBe(false);
    await manager.ensureStaticConfig(PANEL);
    expect(await panelYaml(root)).not.toContain("certResolver");
    expect(await manager.gatePanelCertificate(PANEL, async () => ({ a: [PANEL.ipv4], aaaa: ["2001:db8::1"] }))).toBe(false);
    expect(await manager.gatePanelCertificate(PANEL, here)).toBe(true);
    expect(await panelYaml(root)).toContain("certResolver: le");
  });

  it("keeps the resolver while a valid certificate is stored, whatever DNS says", async () => {
    const root = await tmp();
    const panel = { ...PANEL, hostname: "hotel.it" };
    const manager = new TraefikIngressFileManager(root, panel);
    await manager.ensureStaticConfig(panel);
    await writeFile(
      path.join(root, "acme", "acme.json"),
      await readFile(path.join(import.meta.dirname, "fixtures", "acme.json")),
    );
    expect(await manager.gatePanelCertificate(panel, async () => ({ a: [], aaaa: [] }))).toBe(true);
    expect(await panelYaml(root)).toContain("certResolver: le");
  });

  it("a failed lookup keeps the previous decision, and fails closed before any decision", async () => {
    const fail = async (): Promise<never> => {
      throw new Error("SERVFAIL");
    };
    const fresh = new TraefikIngressFileManager(await tmp(), PANEL);
    expect(await fresh.gatePanelCertificate(PANEL, fail)).toBe(false);
    const manager = new TraefikIngressFileManager(await tmp(), PANEL);
    await manager.gatePanelCertificate(PANEL, here);
    expect(await manager.gatePanelCertificate(PANEL, fail)).toBe(true);
  });

  it("after a restart, an unreadable store and a failed or wrong lookup keep the resolver on disk", async () => {
    const root = await tmp();
    const first = new TraefikIngressFileManager(root, PANEL);
    await first.gatePanelCertificate(PANEL, here);
    await first.ensureStaticConfig(PANEL);
    await writeFile(path.join(root, "acme", "acme.json"), ""); // Traefik rewriting in place
    const restarted = new TraefikIngressFileManager(root, PANEL);
    const fail = async (): Promise<never> => {
      throw new Error("SERVFAIL");
    };
    expect(await restarted.gatePanelCertificate(PANEL, fail)).toBe(true);
    expect(await restarted.gatePanelCertificate(PANEL, async () => ({ a: [], aaaa: [] }))).toBe(true);
    expect(await panelYaml(root)).toContain("certResolver: le");
  });

  it("no ACME email: never a resolver, no lookup", async () => {
    const root = await tmp();
    const panel = { ...PANEL, acmeEmail: null };
    const manager = new TraefikIngressFileManager(root, panel);
    const never = async (): Promise<never> => {
      throw new Error("must not look up");
    };
    expect(await manager.gatePanelCertificate(panel, never)).toBe(false);
  });
});

describe("DNS-01 challenge", () => {
  const pebble = {
    ...PANEL,
    acmeStaging: true,
    acmeCaServer: "https://pebble:14000/dir",
    acmeCaCertFile: "/etc/hosting-panel/pebble.pem",
  };
  const proxyInput = {
    staticConfigHostPath: "/s/traefik.yml",
    dynamicDirHostPath: "/s/dynamic",
    acmeDirHostPath: "/s/acme",
  };

  it("static config adds le-dns with the same store and CA as le", () => {
    const yaml = buildTraefikStaticYaml(pebble, DNS);
    const le = yaml.slice(yaml.indexOf("  le:\n"), yaml.indexOf("      httpChallenge:"));
    const leDns = yaml.slice(yaml.indexOf("  le-dns:\n"), yaml.indexOf("      dnsChallenge:"));
    expect(leDns.replace("  le-dns:", "  le:")).toBe(le);
    expect(yaml).toContain('      storage: /etc/traefik/acme/acme-custom.json');
    expect(yaml.endsWith("      dnsChallenge:\n        provider: httpreq\n")).toBe(true);
    expect(yaml.indexOf("        entryPoint: web\n  le-dns:")).toBeGreaterThan(0);
  });

  it("no le-dns without an ACME email", () => {
    expect(buildTraefikStaticYaml({ ...PANEL, acmeEmail: null }, DNS)).not.toContain("le-dns");
    expect(buildTraefikStaticYaml(null, DNS)).not.toContain("certificatesResolvers");
  });

  it("static config without a DNS provider is unchanged", () => {
    for (const panel of [PANEL, pebble, null]) {
      expect(buildTraefikStaticYaml(panel, null)).toBe(buildTraefikStaticYaml(panel));
      expect(buildTraefikStaticYaml(panel)).not.toContain("le-dns");
    }
    expect(buildTraefikStaticYaml(PANEL).endsWith("        entryPoint: web\n")).toBe(true);
  });

  it("a dns-01 host uses le-dns", () => {
    const yaml = buildSiteDynamicTraefikYaml(
      "site_1",
      [route([host("hotel.it", { tls: true, challenge: "dns-01" }), host("b.it", { tls: true })])],
      { ...OPTS, dnsChallenge: true },
    );
    expect(block(yaml, `router_svc1_${h("hotel.it")}_tls`)).toMatch(/^\s*certResolver: le-dns$/m);
    expect(block(yaml, `router_svc1_${h("b.it")}_tls`)).toMatch(/^\s*certResolver: le$/m);
  });

  it("a dns-01 host without the DNS resolver gets tls {} and no resolver", () => {
    const yaml = buildSiteDynamicTraefikYaml(
      "site_1",
      [route([host("hotel.it", { tls: true, challenge: "dns-01" })])],
      OPTS,
    );
    const tls = block(yaml, `router_svc1_${h("hotel.it")}_tls`);
    expect(tls).toContain("      tls: {}");
    expect(yaml).not.toContain("certResolver");
  });

  it("http-01 route files and @hp-route lines carry no challenge", () => {
    const plain = buildSiteDynamicTraefikYaml("site_1", [route(PAIR)], OPTS);
    const explicit = buildSiteDynamicTraefikYaml(
      "site_1",
      [route(PAIR.map((x) => ({ ...x, challenge: "http-01" as const })))],
      { ...OPTS, dnsChallenge: true },
    );
    expect(explicit).toBe(plain);
    expect(plain).not.toContain("challenge");
  });

  it("an old @hp-route line without challenge hydrates as http-01 and dns-01 survives hydration", async () => {
    const root = await tmp();
    const seed = new TraefikIngressFileManager(root, PANEL);
    await seed.setDnsProviderState(DNS);
    await seed.upsertServiceRoute("site_1", route([host("hotel.it", { tls: true, challenge: "dns-01" })]));
    const file = seed.getSiteDynamicFilePath("site_1");
    const old = { ...route([host("old.it", { tls: true })]), serviceInstanceId: "svc_old" };
    await writeFile(file, `${await readFile(file, "utf8")}# @hp-route ${JSON.stringify(old)}\n`);

    const manager = new TraefikIngressFileManager(root, PANEL);
    await manager.upsertServiceRoute("site_2", { ...route([host("x.it")]), serviceInstanceId: "svc2" });
    await manager.removeServiceRoute("svc_none", "site_1");
    const yaml = await readFile(file, "utf8");
    expect(block(yaml, `router_svc1_${h("hotel.it")}_tls`)).toMatch(/^\s*certResolver: le-dns$/m);
    expect(block(yaml, `router_svc_old_${h("old.it")}_tls`)).toMatch(/^\s*certResolver: le$/m);
    expect(yaml).toContain('"challenge":"dns-01"');
    expect(yaml.match(/challenge/g)).toHaveLength(1);
  });

  it("a DNS state change rewrites dns-01 site files from disk and leaves http-01 files untouched", async () => {
    const root = await tmp();
    const seed = new TraefikIngressFileManager(root, PANEL);
    await seed.upsertServiceRoute("site_1", route([host("hotel.it", { tls: true, challenge: "dns-01" })]));
    await seed.upsertServiceRoute("site_2", { ...route([host("b.it", { tls: true })]), serviceInstanceId: "svc2" });
    const dnsFile = seed.getSiteDynamicFilePath("site_1");
    const httpFile = seed.getSiteDynamicFilePath("site_2");
    const tlsBlock = async () => block(await readFile(dnsFile, "utf8"), `router_svc1_${h("hotel.it")}_tls`);
    expect(await tlsBlock()).toContain("      tls: {}");
    const httpBefore = [await readFile(httpFile, "utf8"), (await stat(httpFile)).mtimeMs];

    // A new manager: the routes are known only from the files on disk (executor restart).
    const manager = new TraefikIngressFileManager(root, PANEL);
    expect(await manager.setDnsProviderState(DNS)).toBe(true);
    expect(await tlsBlock()).toMatch(/^\s*certResolver: le-dns$/m);

    expect(await manager.setDnsProviderState(null)).toBe(true);
    expect(await tlsBlock()).toContain("      tls: {}");
    expect(await readFile(dnsFile, "utf8")).not.toContain("certResolver");
    expect(await readFile(dnsFile, "utf8")).toContain('"challenge":"dns-01"');
    expect([await readFile(httpFile, "utf8"), (await stat(httpFile)).mtimeMs]).toEqual(httpBefore);
  });

  it("a site removed while the DNS re-render is held leaves no file", async () => {
    const root = await tmp();
    const manager = new TraefikIngressFileManager(root, PANEL);
    await manager.upsertServiceRoute("site_1", route([host("hotel.it", { tls: true, challenge: "dns-01" })]));
    const file = manager.getSiteDynamicFilePath("site_1");
    const held = holdNextRename(file);
    const rerender = manager.setDnsProviderState(DNS);
    await held.entered;
    const removal = manager.removeSiteRoutes("site_1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    held.release();
    await Promise.all([rerender, removal]);
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a route upserted while the DNS re-render is held is not lost and gets le-dns", async () => {
    const root = await tmp();
    const manager = new TraefikIngressFileManager(root, PANEL);
    await manager.upsertServiceRoute("site_1", route([host("hotel.it", { tls: true, challenge: "dns-01" })]));
    const file = manager.getSiteDynamicFilePath("site_1");
    const held = holdNextRename(file);
    const rerender = manager.setDnsProviderState(DNS);
    await held.entered;
    const upsert = manager.upsertServiceRoute("site_1", {
      ...route([host("b.it", { tls: true, challenge: "dns-01" })]),
      serviceInstanceId: "svc2",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    held.release();
    await Promise.all([rerender, upsert]);
    const yaml = await readFile(file, "utf8");
    expect(block(yaml, `router_svc1_${h("hotel.it")}_tls`)).toMatch(/^\s*certResolver: le-dns$/m);
    expect(block(yaml, `router_svc2_${h("b.it")}_tls`)).toMatch(/^\s*certResolver: le-dns$/m);
  });

  it("the DNS state persists: a new manager on the same root writes the same traefik.yml (same sha)", async () => {
    const root = await tmp();
    const first = new TraefikIngressFileManager(root, PANEL);
    expect(await first.setDnsProviderState(DNS)).toBe(true);
    expect(await first.setDnsProviderState(DNS)).toBe(false);
    const a = await first.ensureStaticConfig(PANEL);
    expect(a.acmeDns).toEqual(DNS);
    const state = path.join(root, "dns-provider.json");
    expect((await stat(state)).mode & 0o777).toBe(0o600);
    expect(await readFile(state, "utf8")).not.toMatch(/https?:/);

    const b = await new TraefikIngressFileManager(root, PANEL).ensureStaticConfig(PANEL);
    expect(b.staticSha256).toBe(a.staticSha256);
    expect(await readFile(path.join(root, "static", "traefik.yml"), "utf8")).toContain("  le-dns:");
    expect((await new TraefikIngressFileManager(root, PANEL).ensureStaticConfig({ ...PANEL, acmeEmail: null })).acmeDns).toBeNull();

    expect(await first.setDnsProviderState(null)).toBe(true);
    await expect(stat(state)).rejects.toMatchObject({ code: "ENOENT" });
    const c = await new TraefikIngressFileManager(root, PANEL).ensureStaticConfig(PANEL);
    expect(c.acmeDns).toBeNull();
    expect(c.staticSha256).toBe(createHash("sha256").update(buildTraefikStaticYaml(PANEL)).digest("hex"));
  });

  it("parseDnsProviderState refuses unknown providers, unknown fields and missing required fields", () => {
    expect(parseDnsProviderState(JSON.stringify(DNS))).toEqual(DNS);
    expect(parseDnsProviderState(JSON.stringify({ provider: "route53", fields: [] }))).toBeNull();
    expect(
      parseDnsProviderState(JSON.stringify({ provider: "httpreq", fields: ["HTTPREQ_ENDPOINT", "PATH"] })),
    ).toBeNull();
    expect(
      parseDnsProviderState(JSON.stringify({ provider: "ovh", fields: ["OVH_ENDPOINT", "OVH_APPLICATION_KEY"] })),
    ).toBeNull();
    expect(parseDnsProviderState("not json")).toBeNull();
    expect(parseDnsProviderState("null")).toBeNull();
  });

  it("proxy payload without a provider has no Env and no DNS bind", () => {
    const payload = buildIngressProxyContainerPayload(proxyInput);
    expect("Env" in payload).toBe(false);
    expect(payload.HostConfig.Binds).toHaveLength(3);
    expect(payload.HostConfig.Binds.join()).not.toContain(ACME_DNS_SECRET_MOUNT);
  });

  it("proxy payload with a provider binds the secret dir read-only and Env holds only _FILE paths", () => {
    const env = dnsProviderFileEnv(DNS);
    expect(env).toEqual([
      `HTTPREQ_ENDPOINT_FILE=${ACME_DNS_SECRET_MOUNT}/HTTPREQ_ENDPOINT`,
      `HTTPREQ_PASSWORD_FILE=${ACME_DNS_SECRET_MOUNT}/HTTPREQ_PASSWORD`,
    ]);
    const payload = buildIngressProxyContainerPayload({
      ...proxyInput,
      acmeDns: { secretDirHostPath: "/run/hosting-panel/acme-dns", env },
    });
    expect(payload.Env).toEqual(env);
    expect(payload.HostConfig.Binds).toContain(`/run/hosting-panel/acme-dns:${ACME_DNS_SECRET_MOUNT}:ro`);
    expect(() =>
      buildIngressProxyContainerPayload({
        ...proxyInput,
        acmeDns: { secretDirHostPath: "/var/run/docker.sock", env },
      }),
    ).toThrow(expect.objectContaining({ code: "HOST_POLICY_DENIED" }));
  });

  it("the panel gate does not read certResolver: le-dns as le", async () => {
    const root = await tmp();
    const manager = new TraefikIngressFileManager(root, PANEL);
    await manager.ensureStaticConfig(PANEL);
    const panelFile = path.join(root, "dynamic", "hp-panel.yml");
    await writeFile(panelFile, "      tls:\n        certResolver: le-dns\n");
    const fail = async (): Promise<never> => {
      throw new Error("SERVFAIL");
    };
    expect(await manager.gatePanelCertificate(PANEL, fail)).toBe(false);
  });
});

describe("manual certificate hosts", () => {
  const manual = (hostname: string, over: Partial<SiteHostRoute> = {}): SiteHostRoute =>
    host(hostname, { tls: true, source: "manual", ...over });

  it("renders tls {} without a resolver, with ACME enabled or not", () => {
    for (const acmeEnabled of [true, false]) {
      const yaml = buildSiteDynamicTraefikYaml("site_1", [route([manual("shop.it")])], {
        ...OPTS,
        acmeEnabled,
      });
      const tls = block(yaml, `router_svc1_${h("shop.it")}_tls`);
      expect(tls).toContain("      tls: {}");
      expect(yaml).not.toContain("certResolver");
    }
  });

  it("keeps the https redirect of a manual host when ACME is disabled", () => {
    const yaml = buildSiteDynamicTraefikYaml(
      "site_1",
      [route([manual("shop.it", { httpsRedirect: true })])],
      { ...OPTS, acmeEnabled: false },
    );
    expect(block(yaml, `router_svc1_${h("shop.it")}`)).toContain('- "https_svc1"');
    expect(yaml).toContain("    https_svc1:");
    // An ACME host without ACME still renders no TLS router and no redirect.
    const acme = buildSiteDynamicTraefikYaml(
      "site_1",
      [route([host("a.it", { tls: true, httpsRedirect: true })])],
      { ...OPTS, acmeEnabled: false },
    );
    expect(acme).not.toContain("https_svc1");
    expect(acme).not.toContain("_tls");
  });

  it("a manual canon redirect host gets tls {} on its TLS router", () => {
    const yaml = buildSiteDynamicTraefikYaml(
      "site_1",
      [
        route([
          manual("shop.it", { httpsRedirect: true }),
          manual("www.shop.it", { redirectTo: "https://shop.it" }),
        ]),
      ],
      { ...OPTS, acmeEnabled: false },
    );
    const tls = block(yaml, `router_svc1_${h("www.shop.it")}_tls`);
    expect(tls).toContain(`- "canon_svc1_${h("www.shop.it")}"`);
    expect(tls).toContain("      tls: {}");
    expect(yaml).not.toContain("certResolver");
  });

  it("an ACME host next to a manual one keeps its resolver", () => {
    const yaml = buildSiteDynamicTraefikYaml("site_1", [route([manual("shop.it"), host("b.it", { tls: true })])], OPTS);
    expect(block(yaml, `router_svc1_${h("b.it")}_tls`)).toMatch(/^\s*certResolver: le$/m);
    expect(block(yaml, `router_svc1_${h("shop.it")}_tls`)).not.toContain("certResolver");
  });

  it("source is part of the @hp-route line only when set, and manual with a challenge is rejected", () => {
    const withSource = buildSiteDynamicTraefikYaml("site_1", [route([manual("shop.it")])], OPTS);
    expect(withSource).toContain('"source":"manual"');
    expect(buildSiteDynamicTraefikYaml("site_1", [route(PAIR)], OPTS)).not.toContain("source");
    expect(() =>
      buildSiteDynamicTraefikYaml("site_1", [route([manual("shop.it", { challenge: "dns-01" })])], OPTS),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() =>
      buildSiteDynamicTraefikYaml("site_1", [route([manual("shop.it", { challenge: "http-01" })])], OPTS),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("source survives hydration and the DNS re-render", async () => {
    const root = await tmp();
    const seed = new TraefikIngressFileManager(root, PANEL);
    await seed.upsertServiceRoute("site_1", route([manual("shop.it"), host("hotel.it", { tls: true, challenge: "dns-01" })]));
    const file = seed.getSiteDynamicFilePath("site_1");

    const manager = new TraefikIngressFileManager(root, PANEL);
    await manager.setDnsProviderState(DNS);
    const yaml = await readFile(file, "utf8");
    expect(yaml).toContain('"source":"manual"');
    expect(block(yaml, `router_svc1_${h("shop.it")}_tls`)).toContain("tls: {}");
    expect(block(yaml, `router_svc1_${h("hotel.it")}_tls`)).toMatch(/^\s*certResolver: le-dns$/m);
  });

  it("ensureStaticConfig creates manual-certs 0700 and re-chmods a 0755 one", async () => {
    const root = await tmp();
    const manager = new TraefikIngressFileManager(root, PANEL);
    await manager.ensureStaticConfig(PANEL);
    const dir = path.join(root, "dynamic", MANUAL_CERTS_DIR_NAME);
    expect(manager.manualCertsDirPath).toBe(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    await chmod(dir, 0o755);
    await manager.ensureStaticConfig(PANEL);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("ensureStaticConfig refuses a symlinked manual-certs", async () => {
    const root = await tmp();
    const manager = new TraefikIngressFileManager(root, PANEL);
    await mkdir(path.join(root, "dynamic"), { recursive: true });
    await mkdir(path.join(root, "elsewhere"));
    await symlink(path.join(root, "elsewhere"), manager.manualCertsDirPath);
    await expect(manager.ensureStaticConfig(PANEL)).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });
  });

  it("exposes the state path, mount dir and keeps the proxy binds unchanged", async () => {
    const root = await tmp();
    const manager = new TraefikIngressFileManager(root, PANEL);
    expect(manager.manualTlsStatePath).toBe(path.join(root, MANUAL_TLS_STATE_FILE));
    expect(manager.manualCertMountDir).toBe("/etc/traefik/dynamic/manual-certs");
    expect(new TraefikIngressFileManager(root, PANEL, { manualCertMountDir: "/m" }).manualCertMountDir).toBe("/m");
    expect(
      buildIngressProxyContainerPayload({
        staticConfigHostPath: "/s/traefik.yml",
        dynamicDirHostPath: "/s/dynamic",
        acmeDirHostPath: "/s/acme",
      }).HostConfig.Binds,
    ).toHaveLength(3);
  });

  it("writes the manifest through the site file line and removes it on null", async () => {
    const root = await tmp();
    const manager = new TraefikIngressFileManager(root, PANEL);
    const file = path.join(root, "dynamic", MANUAL_CERTIFICATES_FILE_NAME);
    await manager.writeManualCertificateManifest("tls:\n  certificates: []\n");
    expect(await readFile(file, "utf8")).toBe("tls:\n  certificates: []\n");
    expect((await stat(file)).mode & 0o777).toBe(0o644);
    const inode = (await stat(file)).ino;
    await manager.writeManualCertificateManifest("tls:\n  certificates: []\n");
    expect((await stat(file)).ino).toBe(inode);
    await manager.writeManualCertificateManifest(null);
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await manager.writeManualCertificateManifest(null);
  });

  it("serializes the manifest write with a held site file rename", async () => {
    const root = await tmp();
    const manager = new TraefikIngressFileManager(root, PANEL);
    const siteFile = manager.getSiteDynamicFilePath("site_1");
    const held = holdNextRename(siteFile);
    const upsert = manager.upsertServiceRoute("site_1", route(PAIR));
    await held.entered;
    let done = false;
    const write = manager.writeManualCertificateManifest("x: 1\n").then(() => (done = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    held.release();
    await Promise.all([upsert, write]);
    expect(done).toBe(true);
  });

  it("listRoutedHostnames returns the panel host and every routed host, deduplicated and sorted", async () => {
    const root = await tmp();
    const manager = new TraefikIngressFileManager(root, PANEL);
    expect(await manager.listRoutedHostnames()).toEqual([PANEL.hostname]);
    expect(await new TraefikIngressFileManager(root, null).listRoutedHostnames()).toEqual([]);
    await manager.ensureStaticConfig(PANEL);
    await manager.upsertServiceRoute("site_1", route([manual("shop.it"), host("a.it")]));
    await manager.upsertServiceRoute("site_2", { ...route([host("b.it", { tls: true })]), serviceInstanceId: "svc2" });
    // A fresh manager reads from disk, not from memory.
    expect(await new TraefikIngressFileManager(root, PANEL).listRoutedHostnames()).toEqual([
      "a.it",
      "b.it",
      "shop.it",
      PANEL.hostname,
    ]);
    // A file without @hp-route lines contributes nothing.
    await writeFile(path.join(root, "dynamic", "site_9.yml"), "# hand made\n");
    expect(await manager.listRoutedHostnames()).toHaveLength(4);
  });
});
