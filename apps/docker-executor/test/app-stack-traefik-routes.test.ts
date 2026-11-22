import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SiteHostRoute } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { DnsProviderState } from "../src/dns-provider.js";
import {
  TraefikIngressFileManager,
  buildAppStackDynamicTraefikYaml,
  parsePersistedAppStackRoutesFromYaml,
  type AppStackRouteEntry,
  type PanelIngressConfig,
} from "../src/traefik-config.js";

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

const h = (hostname: string): string => createHash("sha256").update(hostname).digest("hex").slice(0, 8);

const host = (hostname: string, over: Partial<SiteHostRoute> = {}): SiteHostRoute => ({
  hostname,
  tls: false,
  httpsRedirect: false,
  redirectTo: null,
  ...over,
});

const route = (hosts: readonly SiteHostRoute[], componentKey = "web", internalPort = 8080): AppStackRouteEntry => ({
  componentKey,
  internalPort,
  hosts,
});

const SHOP = [route([host("shop.example.org", { tls: true, httpsRedirect: true })])];

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

const tlsRouter = (resolver: string[]): string[] => [
  `    app_st1_web_8080_${h("shop.example.org")}_tls:`,
  "      entryPoints:",
  '        - "websecure"',
  '      rule: "Host(`shop.example.org`)"',
  '      service: "app_st1_web_8080"',
  ...resolver,
];
const webRouter = (middleware: boolean): string[] => [
  `    app_st1_web_8080_${h("shop.example.org")}:`,
  "      entryPoints:",
  '        - "web"',
  '      rule: "Host(`shop.example.org`)"',
  '      service: "app_st1_web_8080"',
  ...(middleware ? ["      middlewares:", '        - "app_st1_web_8080_https"'] : []),
];
const SERVICE = [
  "  services:",
  "    app_st1_web_8080:",
  "      loadBalancer:",
  "        passHostHeader: true",
  "        servers:",
  '          - url: "http://hp_app_st1_web:8080"',
  "",
];
const HEADER = "# Managed by hp-docker-executor for application stack st1 — DO NOT EDIT";

describe("buildAppStackDynamicTraefikYaml", () => {
  it("one ACME host with https redirect", () => {
    expect(buildAppStackDynamicTraefikYaml("st1", SHOP, OPTS)).toBe(
      [
        HEADER,
        '# @hp-app-route {"componentKey":"web","internalPort":8080,"hosts":[{"hostname":"shop.example.org","tls":true,"httpsRedirect":true,"redirectTo":null}]}',
        "http:",
        "  routers:",
        ...webRouter(true),
        ...tlsRouter(["      tls:", "        certResolver: le"]),
        "  middlewares:",
        "    app_st1_web_8080_https:",
        "      redirectScheme:",
        "        scheme: https",
        "        permanent: true",
        ...SERVICE,
      ].join("\n"),
    );
  });

  it("ACME off: no TLS router and no middleware", () => {
    expect(buildAppStackDynamicTraefikYaml("st1", SHOP, { ...OPTS, acmeEnabled: false })).toBe(
      [
        HEADER,
        '# @hp-app-route {"componentKey":"web","internalPort":8080,"hosts":[{"hostname":"shop.example.org","tls":true,"httpsRedirect":true,"redirectTo":null}]}',
        "http:",
        "  routers:",
        ...webRouter(false),
        ...SERVICE,
      ].join("\n"),
    );
  });

  it("dns-01 uses le-dns when the static config has it, the default certificate otherwise", () => {
    const routes = [route([host("shop.example.org", { tls: true, challenge: "dns-01" })])];
    const lines = (resolver: string[]): string =>
      [
        HEADER,
        '# @hp-app-route {"componentKey":"web","internalPort":8080,"hosts":[{"hostname":"shop.example.org","tls":true,"httpsRedirect":false,"redirectTo":null,"challenge":"dns-01"}]}',
        "http:",
        "  routers:",
        ...webRouter(false),
        ...tlsRouter(resolver),
        ...SERVICE,
      ].join("\n");
    expect(buildAppStackDynamicTraefikYaml("st1", routes, { ...OPTS, dnsChallenge: true })).toBe(
      lines(["      tls:", "        certResolver: le-dns"]),
    );
    expect(buildAppStackDynamicTraefikYaml("st1", routes, OPTS)).toBe(lines(["      tls: {}"]));
  });

  it("two routes are sorted by component then port, hosts by name", () => {
    const yaml = buildAppStackDynamicTraefikYaml(
      "st1",
      [route([host("b.example.org"), host("a.example.org")]), route([host("api.example.org")], "api", 9000)],
      OPTS,
    );
    const r = (name: string, hostname: string, service: string): string[] => [
      `    ${name}_${h(hostname)}:`,
      "      entryPoints:",
      '        - "web"',
      `      rule: "Host(\`${hostname}\`)"`,
      `      service: "${service}"`,
    ];
    expect(yaml).toBe(
      [
        HEADER,
        '# @hp-app-route {"componentKey":"api","internalPort":9000,"hosts":[{"hostname":"api.example.org","tls":false,"httpsRedirect":false,"redirectTo":null}]}',
        '# @hp-app-route {"componentKey":"web","internalPort":8080,"hosts":[{"hostname":"a.example.org","tls":false,"httpsRedirect":false,"redirectTo":null},{"hostname":"b.example.org","tls":false,"httpsRedirect":false,"redirectTo":null}]}',
        "http:",
        "  routers:",
        ...r("app_st1_api_9000", "api.example.org", "app_st1_api_9000"),
        ...r("app_st1_web_8080", "a.example.org", "app_st1_web_8080"),
        ...r("app_st1_web_8080", "b.example.org", "app_st1_web_8080"),
        "  services:",
        "    app_st1_api_9000:",
        "      loadBalancer:",
        "        passHostHeader: true",
        "        servers:",
        '          - url: "http://hp_app_st1_api:9000"',
        "    app_st1_web_8080:",
        "      loadBalancer:",
        "        passHostHeader: true",
        "        servers:",
        '          - url: "http://hp_app_st1_web:8080"',
        "",
      ].join("\n"),
    );
  });

  it("permuted input gives the same bytes", () => {
    const a = route([host("a.example.org", { tls: true }), host("b.example.org")], "web", 8080);
    const b = route([host("c.example.org", { tls: true, httpsRedirect: true })], "web", 80);
    const c = route([host("d.example.org")], "admin", 9000);
    const first = buildAppStackDynamicTraefikYaml("st1", [a, b, c], OPTS);
    const permuted = buildAppStackDynamicTraefikYaml(
      "st1",
      [c, { ...a, hosts: [...a.hosts].reverse() }, b],
      OPTS,
    );
    expect(permuted).toBe(first);
    expect(first.indexOf("app_st1_web_80:")).toBeLessThan(first.indexOf("app_st1_web_8080:"));
  });

  it("no routes renders nothing", () => {
    expect(buildAppStackDynamicTraefikYaml("st1", [], OPTS)).toBe("");
  });

  it.each<[string, string, () => unknown]>([
    ["manual source", "HOST_POLICY_DENIED", () => [route([host("shop.example.org", { tls: true, source: "manual" })])]],
    ["redirect", "HOST_POLICY_DENIED", () => [route([host("www.example.org", { redirectTo: "https://shop.example.org" }), host("shop.example.org")])]],
    ["panel hostname", "HOST_POLICY_DENIED", () => [route([host(PANEL.hostname)])]],
    ["panel IP", "HOST_POLICY_DENIED", () => [route([host(PANEL.ipv4)])]],
    ["9 hosts", "VALIDATION_ERROR", () => [
      route([1, 2, 3, 4, 5].map((n) => host(`h${String(n)}.example.org`))),
      route([6, 7, 8, 9].map((n) => host(`h${String(n)}.example.org`)), "api"),
    ]],
    ["duplicate host", "VALIDATION_ERROR", () => [route([host("a.example.org")]), route([host("a.example.org")], "api")]],
    ["duplicate component and port", "VALIDATION_ERROR", () => [route([host("a.example.org")]), route([host("b.example.org")])]],
    ["key with _", "VALIDATION_ERROR", () => [route([host("a.example.org")], "my_web")]],
    ["port 0", "VALIDATION_ERROR", () => [route([host("a.example.org")], "web", 0)]],
    ["port 65536", "VALIDATION_ERROR", () => [route([host("a.example.org")], "web", 65536)]],
  ])("refuses %s", (_name, code, routes) => {
    expect(codeOf(() => buildAppStackDynamicTraefikYaml("st1", routes() as AppStackRouteEntry[], OPTS))).toBe(code);
  });

  it.each(["St1", "1st", "a-b", "", "a".repeat(65), "x/../hp-panel"])("refuses stack id %j", (stackId) => {
    expect(codeOf(() => buildAppStackDynamicTraefikYaml(stackId, SHOP, OPTS))).toBe("VALIDATION_ERROR");
  });
});

describe("parsePersistedAppStackRoutesFromYaml", () => {
  it("round trips the normalised routes and skips malformed lines", () => {
    const input = [
      route([host("b.example.org", { tls: true, challenge: "dns-01" }), host("a.example.org")]),
      route([host("api.example.org", { tls: true, httpsRedirect: true })], "api", 9000),
    ];
    const yaml = buildAppStackDynamicTraefikYaml("st1", input, OPTS);
    const expected = [input[1], { ...input[0]!, hosts: [input[0]!.hosts[1], input[0]!.hosts[0]] }];
    expect(parsePersistedAppStackRoutesFromYaml(yaml)).toEqual(expected);
    const noisy = [
      "# @hp-app-route {bad json",
      '# @hp-app-route {"componentKey":1,"internalPort":80,"hosts":[]}',
      '# @hp-route {"serviceInstanceId":"s","containerName":"c","internalPort":80,"hosts":[]}',
      yaml,
    ].join("\n");
    expect(parsePersistedAppStackRoutesFromYaml(noisy)).toEqual(expected);
  });
});

describe("TraefikIngressFileManager app stack files", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const tempRoot = async (): Promise<string> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hp-app-routes-"));
    dirs.push(dir);
    return dir;
  };

  it("writes 0644 once, skips an unchanged write, reads, removes", async () => {
    const manager = new TraefikIngressFileManager(await tempRoot(), PANEL);
    const file = manager.getAppStackDynamicFilePath("st1");
    expect(file).toBe(path.join(manager.dynamicDirPath, "app_st1.yml"));

    expect(await manager.writeAppStackRoutes("st1", SHOP)).toEqual({ changed: true, hostnames: ["shop.example.org"] });
    const before = await stat(file);
    expect(before.mode & 0o777).toBe(0o644);
    expect(await readFile(file, "utf8")).toBe(buildAppStackDynamicTraefikYaml("st1", SHOP, OPTS));

    expect(await manager.writeAppStackRoutes("st1", SHOP)).toEqual({ changed: false, hostnames: ["shop.example.org"] });
    const after = await stat(file);
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
    expect(await manager.readAppStackRoutes("st1")).toEqual(parsePersistedAppStackRoutesFromYaml(await readFile(file, "utf8")));

    await expect(manager.writeAppStackRoutes("st1", [route([host(PANEL.hostname)])])).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
    });
    expect((await stat(file)).ino).toBe(before.ino);

    expect(await manager.writeAppStackRoutes("st1", [])).toEqual({ changed: true, hostnames: [] });
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await manager.writeAppStackRoutes("st1", [])).toEqual({ changed: false, hostnames: [] });
    expect(await manager.readAppStackRoutes("st1")).toEqual([]);

    await manager.writeAppStackRoutes("st1", SHOP);
    expect(await manager.removeAppStackRoutes("st1")).toBe(true);
    expect(await manager.removeAppStackRoutes("st1")).toBe(false);
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => manager.getAppStackDynamicFilePath("x/../hp-panel")).toThrow();
  });

  it("listRoutedHostnames includes stack hosts and ignores malformed file names", async () => {
    const manager = new TraefikIngressFileManager(await tempRoot(), PANEL);
    await manager.upsertServiceRoute("site_1", {
      serviceInstanceId: "svc1",
      containerName: "hp-site-1-web",
      internalPort: 80,
      hosts: [host("hotel.it")],
    });
    await manager.writeAppStackRoutes("st1", SHOP);
    for (const name of ["app_X.yml", "app_a..b.yml", "app_.yml"]) {
      const yaml = buildAppStackDynamicTraefikYaml("st9", [route([host(`${name.length}.evil.example.org`)])], OPTS);
      await writeFile(path.join(manager.dynamicDirPath, name), yaml);
    }
    expect(await manager.listRoutedHostnames()).toEqual(["hotel.it", "shop.example.org", PANEL.hostname].sort());
  });

  it("a DNS provider change rewrites only the dns-01 stack file", async () => {
    const root = await tempRoot();
    const seed = new TraefikIngressFileManager(root, PANEL);
    await seed.writeAppStackRoutes("st1", [route([host("shop.example.org", { tls: true, challenge: "dns-01" })])]);
    await seed.writeAppStackRoutes("st2", [route([host("b.example.org", { tls: true })])]);
    const dnsFile = seed.getAppStackDynamicFilePath("st1");
    const httpFile = seed.getAppStackDynamicFilePath("st2");
    const foreign = path.join(seed.dynamicDirPath, "app_st3.yml");
    await mkdir(seed.dynamicDirPath, { recursive: true });
    await writeFile(foreign, "# hand written\n");
    const snapshot = async (file: string) => [await readFile(file, "utf8"), (await stat(file)).ino, (await stat(file)).mtimeMs];
    const httpBefore = await snapshot(httpFile);
    const foreignBefore = await snapshot(foreign);
    expect(await readFile(dnsFile, "utf8")).toContain("      tls: {}");

    const manager = new TraefikIngressFileManager(root, PANEL);
    expect(await manager.setDnsProviderState(DNS)).toBe(true);
    expect(await readFile(dnsFile, "utf8")).toBe(
      buildAppStackDynamicTraefikYaml("st1", await manager.readAppStackRoutes("st1"), { ...OPTS, dnsChallenge: true }),
    );
    expect(await readFile(dnsFile, "utf8")).toMatch(/^ {8}certResolver: le-dns$/m);

    expect(await manager.setDnsProviderState(null)).toBe(true);
    expect(await readFile(dnsFile, "utf8")).toContain("      tls: {}");
    expect(await snapshot(httpFile)).toEqual(httpBefore);
    expect(await snapshot(foreign)).toEqual(foreignBefore);
  });
});
