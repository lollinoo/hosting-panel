// ADR-0037: redirect, password protection, compression and path rules of an application address, byte by byte.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppStackHostRoute } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  TraefikIngressFileManager,
  buildAppStackDynamicTraefikYaml,
  parsePersistedAppStackRoutesFromYaml,
  type AppStackRouteEntry,
} from "../src/traefik-config.js";

const RESERVED = ["srv12.example.it", "203.0.113.10"];
const OPTS = { acmeEnabled: true, dnsChallenge: false, reservedHosts: RESERVED };
const NO_ACME = { ...OPTS, acmeEnabled: false };
const VERIFIER = "$apr1$r31.....$HqJZimcKQFAMYayBlzkrA/";
const PROTECTION = { username: "team", passwordHash: VERIFIER };
const HEADER = "# Managed by hp-docker-executor for application stack st1 — DO NOT EDIT";

const h = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 8);
const host = (hostname: string, over: Partial<AppStackHostRoute> = {}): AppStackHostRoute => ({
  hostname,
  tls: false,
  httpsRedirect: false,
  redirectTo: null,
  ...over,
});
const secure = (hostname: string, over: Partial<AppStackHostRoute> = {}): AppStackHostRoute =>
  host(hostname, { tls: true, httpsRedirect: true, ...over });
const route = (hosts: readonly AppStackHostRoute[], componentKey = "web", internalPort = 8080): AppStackRouteEntry => ({
  componentKey,
  internalPort,
  hosts,
});
const apiPath = (over: Partial<NonNullable<AppStackHostRoute["paths"]>[number]> = {}) => ({
  pathPrefix: "/api",
  componentKey: "api",
  internalPort: 3000,
  stripPrefix: true,
  ...over,
});

/** One router block as the file holds it. */
const router = (name: string, entryPoint: "web" | "websecure", rule: string, service: string, use: string[] = []): string[] => [
  `    ${name}:`,
  "      entryPoints:",
  `        - "${entryPoint}"`,
  `      rule: "${rule}"`,
  `      service: "${service}"`,
  ...(use.length > 0 ? ["      middlewares:", ...use.map((m) => `        - "${m}"`)] : []),
  ...(entryPoint === "websecure" ? ["      tls:", "        certResolver: le"] : []),
];
const service = (componentKey: string, port: number): string[] => [
  `    app_st1_${componentKey}_${String(port)}:`,
  "      loadBalancer:",
  "        passHostHeader: true",
  "        servers:",
  `          - url: "http://hp_app_st1_${componentKey}:${String(port)}"`,
];
const HTTPS = ["    app_st1_web_8080_https:", "      redirectScheme:", "        scheme: https", "        permanent: true"];
const auth = (name: string): string[] => [
  `    ${name}:`,
  "      basicAuth:",
  "        users:",
  `          - "team:${VERIFIER}"`,
  '        realm: "Restricted"',
  "        removeHeader: true",
];
const COMPRESS = ["    app_st1_compress:", "      compress: {}"];
const file = (routeLines: string[], routers: string[], middlewares: string[], services: string[]): string =>
  [HEADER, ...routeLines, "http:", "  routers:", ...routers, ...(middlewares.length > 0 ? ["  middlewares:", ...middlewares] : []), "  services:", ...services, ""].join("\n");

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

const SHOP = "shop.example.org";
const WWW = "www.example.org";
const K = "app_st1_web_8080";
const shopRule = `Host(\`${SHOP}\`)`;

describe("application route options", () => {
  it("an address redirects to another one from both entry points, path kept, without the HTTPS hop", () => {
    const yaml = buildAppStackDynamicTraefikYaml("st1", [route([secure(WWW, { redirectTo: `https://${SHOP}` }), secure(SHOP)])], OPTS);
    const to = `${K}_${h(WWW)}_to`;
    expect(yaml).toBe(
      file(
        [
          `# @hp-app-route {"componentKey":"web","internalPort":8080,"hosts":[{"hostname":"${SHOP}","tls":true,"httpsRedirect":true,"redirectTo":null},{"hostname":"${WWW}","tls":true,"httpsRedirect":true,"redirectTo":"https://${SHOP}"}]}`,
        ],
        [
          ...router(`${K}_${h(SHOP)}`, "web", shopRule, K, [`${K}_https`]),
          ...router(`${K}_${h(SHOP)}_tls`, "websecure", shopRule, K),
          ...router(`${K}_${h(WWW)}`, "web", `Host(\`${WWW}\`)`, K, [to]),
          ...router(`${K}_${h(WWW)}_tls`, "websecure", `Host(\`${WWW}\`)`, K, [to]),
        ],
        [
          `    ${to}:`,
          "      redirectRegex:",
          '        regex: "^https?://[^/]+(.*)$"',
          `        replacement: "https://${SHOP}\${1}"`,
          "        permanent: true",
          ...HTTPS,
        ],
        service("web", 8080),
      ),
    );
  });

  it("a redirect may land on an address of another service of the same application, and needs no certificate of its own", () => {
    const yaml = buildAppStackDynamicTraefikYaml(
      "st1",
      [route([host("old.example.org", { redirectTo: "http://api.example.org" })]), route([host("api.example.org")], "api", 3000)],
      OPTS,
    );
    expect(yaml).toContain(`    ${K}_${h("old.example.org")}:`);
    expect(yaml).not.toContain(`${K}_${h("old.example.org")}_tls`);
    expect(yaml).toContain('        replacement: "http://api.example.org${1}"');
    expect(yaml).not.toContain("_https");
  });

  it("a protected, compressed address asks for the password where it serves content and never on the plain redirect", () => {
    const yaml = buildAppStackDynamicTraefikYaml("st1", [route([secure(SHOP, { protection: PROTECTION, compress: true })])], OPTS);
    const name = `${K}_${h(SHOP)}_auth`;
    expect(yaml).toBe(
      file(
        [
          `# @hp-app-route {"componentKey":"web","internalPort":8080,"hosts":[{"hostname":"${SHOP}","tls":true,"httpsRedirect":true,"redirectTo":null,"compress":true,"protection":{"username":"team","passwordHash":"${VERIFIER}"}}]}`,
        ],
        [
          ...router(`${K}_${h(SHOP)}`, "web", shopRule, K, [`${K}_https`]),
          ...router(`${K}_${h(SHOP)}_tls`, "websecure", shopRule, K, [name, "app_st1_compress"]),
        ],
        [...auth(name), ...HTTPS, ...COMPRESS],
        service("web", 8080),
      ),
    );
  });

  it("without a usable certificate the plain router serves the content, so it carries the protection", () => {
    const pending = buildAppStackDynamicTraefikYaml("st1", [route([host(SHOP, { tls: true, protection: PROTECTION })])], OPTS);
    const name = `${K}_${h(SHOP)}_auth`;
    expect(pending).toBe(
      file(
        [
          `# @hp-app-route {"componentKey":"web","internalPort":8080,"hosts":[{"hostname":"${SHOP}","tls":true,"httpsRedirect":false,"redirectTo":null,"protection":{"username":"team","passwordHash":"${VERIFIER}"}}]}`,
        ],
        [...router(`${K}_${h(SHOP)}`, "web", shopRule, K, [name]), ...router(`${K}_${h(SHOP)}_tls`, "websecure", shopRule, K, [name])],
        auth(name),
        service("web", 8080),
      ),
    );
    // Certificates off for the whole server: one router, protected and compressed.
    const plain = buildAppStackDynamicTraefikYaml("st1", [route([secure(SHOP, { protection: PROTECTION, compress: true })])], NO_ACME);
    expect(plain.split("\n").slice(2)).toEqual(
      ["http:", "  routers:", ...router(`${K}_${h(SHOP)}`, "web", shopRule, K, [name, "app_st1_compress"]), "  middlewares:", ...auth(name), ...COMPRESS, "  services:", ...service("web", 8080), ""],
    );
  });

  it("path rules send a sub-path to another service, inherit protection and compression, and strip only when asked", () => {
    const paths = [apiPath(), { pathPrefix: "/media", componentKey: "web", internalPort: 8080, stripPrefix: false }];
    const yaml = buildAppStackDynamicTraefikYaml("st1", [route([secure(SHOP, { protection: PROTECTION, compress: true, paths })])], OPTS);
    const name = `${K}_${h(SHOP)}_auth`;
    const api = `app_st1_api_3000_${h(`${SHOP}/api`)}`;
    const media = `${K}_${h(`${SHOP}/media`)}`;
    expect(yaml).toBe(
      file(
        [
          `# @hp-app-route {"componentKey":"web","internalPort":8080,"hosts":[{"hostname":"${SHOP}","tls":true,"httpsRedirect":true,"redirectTo":null,"compress":true,"protection":{"username":"team","passwordHash":"${VERIFIER}"},"paths":[{"pathPrefix":"/api","componentKey":"api","internalPort":3000,"stripPrefix":true},{"pathPrefix":"/media","componentKey":"web","internalPort":8080,"stripPrefix":false}]}]}`,
        ],
        [
          ...router(`${K}_${h(SHOP)}`, "web", shopRule, K, [`${K}_https`]),
          ...router(`${K}_${h(SHOP)}_tls`, "websecure", shopRule, K, [name, "app_st1_compress"]),
          ...router(`${api}_tls`, "websecure", `${shopRule} && (Path(\`/api\`) || PathPrefix(\`/api/\`))`, "app_st1_api_3000", [name, "app_st1_compress", `${api}_strip`]),
          ...router(`${media}_tls`, "websecure", `${shopRule} && (Path(\`/media\`) || PathPrefix(\`/media/\`))`, K, [name, "app_st1_compress"]),
        ],
        [...auth(name), `    ${api}_strip:`, "      stripPrefix:", "        prefixes:", '          - "/api"', ...HTTPS, ...COMPRESS],
        [...service("api", 3000), ...service("web", 8080)],
      ),
    );
  });

  it("a path rule is served on plain HTTP only while the address has no HTTPS redirect", () => {
    const yaml = buildAppStackDynamicTraefikYaml("st1", [route([host(SHOP, { paths: [apiPath({ stripPrefix: false })] })])], NO_ACME);
    const api = `app_st1_api_3000_${h(`${SHOP}/api`)}`;
    expect(yaml).toBe(
      file(
        [
          `# @hp-app-route {"componentKey":"web","internalPort":8080,"hosts":[{"hostname":"${SHOP}","tls":false,"httpsRedirect":false,"redirectTo":null,"paths":[{"pathPrefix":"/api","componentKey":"api","internalPort":3000,"stripPrefix":false}]}]}`,
        ],
        [...router(`${K}_${h(SHOP)}`, "web", shopRule, K), ...router(api, "web", `${shopRule} && (Path(\`/api\`) || PathPrefix(\`/api/\`))`, "app_st1_api_3000")],
        [],
        [...service("api", 3000), ...service("web", 8080)],
      ),
    );
  });

  it("a deeper path makes a longer rule than its parent, which is longer than the address rule", () => {
    const paths = [apiPath(), apiPath({ pathPrefix: "/api/v2", componentKey: "web", internalPort: 8080 })];
    const yaml = buildAppStackDynamicTraefikYaml("st1", [route([host(SHOP, { paths })])], NO_ACME);
    const rules = yaml.split("\n").filter((line) => line.startsWith("      rule: ")).map((line) => line.length);
    expect(rules).toHaveLength(3);
    expect(rules[0]!).toBeLessThan(rules[1]!);
    expect(rules[1]!).toBeLessThan(rules[2]!);
  });

  it("options come out in one order, whatever order they came in", () => {
    const paths = [apiPath({ pathPrefix: "/b" }), apiPath({ pathPrefix: "/a" })];
    const a = route([secure(SHOP, { compress: true, protection: PROTECTION, paths }), secure(WWW, { redirectTo: `https://${SHOP}` })]);
    const shuffled: AppStackHostRoute = {
      paths: [...paths].reverse().map(({ stripPrefix, internalPort, componentKey, pathPrefix }) => ({ stripPrefix, internalPort, componentKey, pathPrefix })),
      protection: { passwordHash: VERIFIER, username: "team" },
      compress: true,
      redirectTo: null,
      httpsRedirect: true,
      tls: true,
      hostname: SHOP,
    };
    const b = route([secure(WWW, { redirectTo: `https://${SHOP}` }), shuffled]);
    expect(buildAppStackDynamicTraefikYaml("st1", [b], OPTS)).toBe(buildAppStackDynamicTraefikYaml("st1", [a], OPTS));
  });

  it.each<[string, string, () => AppStackRouteEntry[]]>([
    ["a redirect to an address outside the application", "HOST_POLICY_DENIED", () => [route([host(WWW, { redirectTo: "https://other.example.org" }), host(SHOP)])]],
    ["a redirect to itself", "HOST_POLICY_DENIED", () => [route([host(WWW, { redirectTo: `https://${WWW}` })])]],
    ["a redirect to an address that redirects", "HOST_POLICY_DENIED", () => [
      route([host("a.example.org", { redirectTo: "https://b.example.org" }), host("b.example.org", { redirectTo: `https://${SHOP}` }), host(SHOP)]),
    ]],
    ["a redirect to the panel", "HOST_POLICY_DENIED", () => [route([host(WWW, { redirectTo: `https://${RESERVED[0]!}` })])]],
    ["a redirect with a path", "HOST_POLICY_DENIED", () => [route([host(WWW, { redirectTo: `https://${SHOP}/x` }), host(SHOP)])]],
    ["a redirect with protection", "VALIDATION_ERROR", () => [route([host(WWW, { redirectTo: `https://${SHOP}`, protection: PROTECTION }), host(SHOP)])]],
    ["a redirect with compression", "VALIDATION_ERROR", () => [route([host(WWW, { redirectTo: `https://${SHOP}`, compress: true }), host(SHOP)])]],
    ["a redirect with a path rule", "VALIDATION_ERROR", () => [route([host(WWW, { redirectTo: `https://${SHOP}`, paths: [apiPath()] }), host(SHOP)])]],
    ["a manual certificate", "HOST_POLICY_DENIED", () => [route([host(SHOP, { tls: true, source: "manual" })])]],
    ["compress: false", "VALIDATION_ERROR", () => [route([host(SHOP, { compress: false as unknown as true })])]],
    ["a user name with a colon", "VALIDATION_ERROR", () => [route([host(SHOP, { protection: { username: "a:b", passwordHash: VERIFIER } })])]],
    ["a user name with a quote", "VALIDATION_ERROR", () => [route([host(SHOP, { protection: { username: 'a"b', passwordHash: VERIFIER } })])]],
    ["a plain password as verifier", "VALIDATION_ERROR", () => [route([host(SHOP, { protection: { username: "team", passwordHash: "correct horse 12" } })])]],
    ["a verifier followed by a line", "VALIDATION_ERROR", () => [route([host(SHOP, { protection: { username: "team", passwordHash: `${VERIFIER}\n    x:` } })])]],
    ["a verifier with a quote", "VALIDATION_ERROR", () => [route([host(SHOP, { protection: { username: "team", passwordHash: '$apr1$r31.....$HqJZimcKQFAMYayBlzkr"/' } })])]],
    ["protection with an extra key", "VALIDATION_ERROR", () => [route([host(SHOP, { protection: { ...PROTECTION, realm: "x" } as never })])]],
    ["no path in the list", "VALIDATION_ERROR", () => [route([host(SHOP, { paths: [] })])]],
    ["five paths", "VALIDATION_ERROR", () => [route([host(SHOP, { paths: [1, 2, 3, 4, 5].map((n) => apiPath({ pathPrefix: `/p${String(n)}` })) })])]],
    ["the same path twice", "VALIDATION_ERROR", () => [route([host(SHOP, { paths: [apiPath(), apiPath({ internalPort: 3001 })] })])]],
    ["the certificate challenge path", "VALIDATION_ERROR", () => [route([host(SHOP, { paths: [apiPath({ pathPrefix: "/.well-known" })] })])]],
    ["a path with a backtick", "VALIDATION_ERROR", () => [route([host(SHOP, { paths: [apiPath({ pathPrefix: "/a`) || Host(`x" })] })])]],
    ["a path with a quote", "VALIDATION_ERROR", () => [route([host(SHOP, { paths: [apiPath({ pathPrefix: '/a"b' })] })])]],
    ["a path ending with a slash", "VALIDATION_ERROR", () => [route([host(SHOP, { paths: [apiPath({ pathPrefix: "/api/" })] })])]],
    ["a path with a dot segment", "VALIDATION_ERROR", () => [route([host(SHOP, { paths: [apiPath({ pathPrefix: "/a/../b" })] })])]],
    ["a path of 65 characters", "VALIDATION_ERROR", () => [route([host(SHOP, { paths: [apiPath({ pathPrefix: `/${"a".repeat(32)}/${"b".repeat(31)}` })] })])]],
    ["a path target with a bad key", "VALIDATION_ERROR", () => [route([host(SHOP, { paths: [apiPath({ componentKey: "my_api" })] })])]],
    ["a path target with port 0", "VALIDATION_ERROR", () => [route([host(SHOP, { paths: [apiPath({ internalPort: 0 })] })])]],
    ["a path with an extra key", "VALIDATION_ERROR", () => [route([host(SHOP, { paths: [{ ...apiPath(), priority: 9000 } as never] })])]],
  ])("refuses %s", (_name, code, routes) => {
    expect(codeOf(() => buildAppStackDynamicTraefikYaml("st1", routes(), OPTS))).toBe(code);
  });

  it("the persisted lines carry every option and give back the same file", () => {
    const input = [
      route([secure(SHOP, { compress: true, protection: PROTECTION, paths: [apiPath()] }), secure(WWW, { redirectTo: `https://${SHOP}` })]),
      route([host("api.example.org")], "api", 3000),
    ];
    const yaml = buildAppStackDynamicTraefikYaml("st1", input, OPTS);
    const parsed = parsePersistedAppStackRoutesFromYaml(yaml);
    expect(parsed).toEqual([input[1], input[0]]);
    expect(buildAppStackDynamicTraefikYaml("st1", parsed, OPTS)).toBe(yaml);
  });

  it("a persisted line with a malformed option is skipped, and one with a bad value is refused by the builder", () => {
    const base = '{"componentKey":"web","internalPort":8080,"hosts":[{"hostname":"shop.example.org","tls":false,"httpsRedirect":false,"redirectTo":null';
    const lines = [
      `# @hp-app-route ${base},"compress":"yes"}]}`,
      `# @hp-app-route ${base},"protection":"team:x"}]}`,
      `# @hp-app-route ${base},"protection":null}]}`,
      `# @hp-app-route ${base},"protection":{"username":"team"}}]}`,
      `# @hp-app-route ${base},"paths":{"pathPrefix":"/a"}}]}`,
      `# @hp-app-route ${base},"paths":[null]}]}`,
      `# @hp-app-route ${base},"paths":[{"pathPrefix":"/a","componentKey":"api","internalPort":"3000","stripPrefix":true}]}]}`,
    ];
    expect(parsePersistedAppStackRoutesFromYaml(lines.join("\n"))).toEqual([]);
    const tampered = parsePersistedAppStackRoutesFromYaml(`# @hp-app-route ${base},"protection":{"username":"team","passwordHash":"x\\"\\n"}}]}`);
    expect(tampered).toHaveLength(1);
    expect(codeOf(() => buildAppStackDynamicTraefikYaml("st1", tampered, OPTS))).toBe("VALIDATION_ERROR");
  });
});

describe("TraefikIngressFileManager with route options", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("writes, reads back and re-renders a file with options, and reports one hostname per address", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hp-app-route-options-"));
    dirs.push(root);
    const manager = new TraefikIngressFileManager(root);
    const routes = [route([host(SHOP, { compress: true, protection: PROTECTION, paths: [apiPath()] }), host(WWW, { redirectTo: `http://${SHOP}` })])];
    const written = await manager.writeAppStackRoutes("st1", routes);
    expect(written).toEqual({ changed: true, hostnames: [SHOP, WWW] });
    expect(await manager.writeAppStackRoutes("st1", routes)).toEqual({ changed: false, hostnames: [SHOP, WWW] });
    expect(await manager.readAppStackRoutes("st1")).toEqual(routes);
    expect(await manager.listRoutedHostnames()).toEqual(expect.arrayContaining([SHOP, WWW]));
    const before = await readFile(manager.getAppStackDynamicFilePath("st1"), "utf8");
    expect(before).toContain(`          - "team:${VERIFIER}"`);
    // Dropping the options writes the file an address without options always had.
    const plain = [route([host(SHOP), host(WWW)])];
    expect(await manager.writeAppStackRoutes("st1", plain)).toEqual({ changed: true, hostnames: [SHOP, WWW] });
    const after = await readFile(manager.getAppStackDynamicFilePath("st1"), "utf8");
    expect(after).toBe(buildAppStackDynamicTraefikYaml("st1", plain, { acmeEnabled: false, dnsChallenge: false, reservedHosts: [] }));
    expect(after).not.toMatch(/apr1|middlewares|compress|stripPrefix/);
  });
});
