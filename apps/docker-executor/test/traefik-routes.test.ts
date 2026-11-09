import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SiteHostRoute } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  TraefikIngressFileManager,
  acmeStorageFileName,
  buildIngressProxyContainerPayload,
  buildSiteDynamicTraefikYaml,
  buildTraefikStaticYaml,
  parsePanelIngressConfigFromEnv,
  type PanelIngressConfig,
  type SiteIngressRouteEntry,
} from "../src/index.js";

const PANEL: PanelIngressConfig = {
  hostname: "srv12.example.it",
  ipv4: "203.0.113.10",
  acmeEmail: "ops@example.it",
  acmeStaging: false,
  acmeCaServer: null,
  acmeCaCertFile: null,
  upstreamPort: 3000,
};
const OPTS = { acmeEnabled: true, reservedHosts: [PANEL.hostname, PANEL.ipv4] };

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
