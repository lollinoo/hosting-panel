import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import path from "node:path";
import {
  APP_STACK_ID_PATTERN,
  APP_STACK_KEY_PATTERN,
  AppStackRoutePathSchema,
  AppStackRouteProtectionSchema,
  MAX_APP_ROUTE_PATHS,
  MAX_APP_STACK_DOMAINS,
  VOLUME_SUFFIX_PATTERN,
  isSiteOrigin,
  normalizeSiteDomain,
  type AppStackHostRoute,
  type AppStackRoutePath,
  type AppStackRouteProtection,
  type ErrorCode,
  type SiteHostRoute,
} from "@hosting-panel/contracts";
import { readAcmeCertificates } from "./acme-status.js";
import {
  ACME_DNS_SECRET_MOUNT,
  DNS_PROVIDER_STATE_FILE,
  DNS_RESOLVER_NAME,
  parseDnsProviderState,
  type DnsProviderState,
} from "./dns-provider.js";

export const INGRESS_PROXY_CONTAINER_NAME = "hp_ingress_proxy" as const;
export const SITE_JOB_ROLE = "site_job" as const;
export const INGRESS_BRIDGE_NETWORK_NAME = "hp_ingress_net" as const;
export const DEFAULT_TRAEFIK_IMAGE = "traefik:v3.7" as const;
export const DEFAULT_INGRESS_ROOT_DIR = "/var/lib/hosting-panel/ingress" as const;
export const DEFAULT_INGRESS_HTTP_PORT = 80 as const;
export const DEFAULT_INGRESS_HTTPS_PORT = 443 as const;
export const PANEL_DYNAMIC_FILE_NAME = "hp-panel.yml" as const;
export const MANUAL_CERTS_DIR_NAME = "manual-certs" as const;
export const MANUAL_CERTIFICATES_FILE_NAME = "hp-manual-certificates.yml" as const;
export const MANUAL_TLS_STATE_FILE = "manual-tls-state.json" as const;
/** Where the proxy sees dynamic/manual-certs through the existing read-only dynamic bind. */
export const DEFAULT_MANUAL_CERT_MOUNT_DIR = "/etc/traefik/dynamic/manual-certs" as const;
export const STATIC_SHA256_LABEL = "io.hostingpanel.static_sha256" as const;
const ACME_EMAIL_PATTERN = /^[^\s@"'`\\]+@[^\s@"'`\\]+$/;
const ACME_CA_SERVER_PATTERN = /^https:\/\/[^\s"'`\\]+$/;
const ACME_STAGING_URL = "https://acme-staging-v02.api.letsencrypt.org/directory";
const CUSTOM_CA_FILE_NAME = "custom-ca.pem";
const MAX_SITE_ROUTE_HOSTS = 20;

const SAFE_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SAFE_DOMAIN_PATTERN =
  /^(?:\*\.)?[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export class ExecutorCodedError extends Error {
  public readonly code: ErrorCode;

  public constructor(message: string, code: ErrorCode) {
    super(message);
    this.name = "ExecutorCodedError";
    this.code = code;
  }
}

export function assertSafeIdentifier(value: string, fieldName: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("..") ||
    !SAFE_IDENTIFIER_PATTERN.test(value)
  ) {
    throw new ExecutorCodedError(
      `Unsafe or malformed identifier for ${fieldName}`,
      "HOST_POLICY_DENIED",
    );
  }
  return value;
}

export function assertSafeDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 253 ||
    !SAFE_DOMAIN_PATTERN.test(normalized)
  ) {
    throw new ExecutorCodedError(
      `Unsafe or invalid ingress domain '${domain.slice(0, 64)}'`,
      "HOST_POLICY_DENIED",
    );
  }
  return normalized;
}

export function sanitizeTraefikKey(identifier: string): string {
  assertSafeIdentifier(identifier, "serviceInstanceId");
  return identifier.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function getSiteInternalNetworkName(siteId: string): string {
  assertSafeIdentifier(siteId, "siteId");
  return `hp_site_${siteId}_net`;
}

export function getSiteEdgeNetworkName(siteId: string): string {
  assertSafeIdentifier(siteId, "siteId");
  return `hp_edge_${siteId}_net`;
}

export function getManagedVolumeName(serviceInstanceId: string, volumeSuffix: string): string {
  assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
  if (!VOLUME_SUFFIX_PATTERN.test(volumeSuffix)) {
    throw new ExecutorCodedError(
      `Invalid managed volume suffix '${volumeSuffix.slice(0, 48)}'`,
      "HOST_POLICY_DENIED",
    );
  }
  return `hp_vol_${serviceInstanceId}_${volumeSuffix}`;
}

export function assertContainedPath(rootDir: string, candidatePath: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidatePath);
  if (
    resolvedCandidate !== resolvedRoot &&
    !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new ExecutorCodedError(
      "Resolved path escapes configured managed root directory",
      "HOST_POLICY_DENIED",
    );
  }
  return resolvedCandidate;
}

export async function writeFileAtomically(
  targetPath: string,
  content: string | Buffer,
  fileMode: number,
  dirMode: number = 0o755,
): Promise<void> {
  const parentDir = path.dirname(targetPath);
  await mkdir(parentDir, { recursive: true, mode: dirMode });
  const baseName = path.basename(targetPath);
  const tmpName = `.${baseName}.${randomBytes(6).toString("hex")}.tmp`;
  const tmpPath = path.join(parentDir, tmpName);

  try {
    await writeFile(tmpPath, content, { mode: fileMode });
    await chmod(tmpPath, fileMode);
    await rename(tmpPath, targetPath);
    await chmod(targetPath, fileMode);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Skips identical content: every rename makes Traefik reload, and each reload retries pending ACME hosts. */
export async function writeFileIfChanged(
  targetPath: string,
  content: string | Buffer,
  fileMode: number,
): Promise<void> {
  const current = await readFile(targetPath).catch(() => null);
  if (current?.equals(Buffer.from(content))) {
    return;
  }
  await writeFileAtomically(targetPath, content, fileMode);
}

export interface SiteIngressRouteEntry {
  readonly serviceInstanceId: string;
  readonly containerName: string;
  readonly internalPort: number;
  readonly hosts: readonly SiteHostRoute[];
}

export interface SiteRouteOptions {
  readonly acmeEnabled: boolean;
  /** The static config has the le-dns resolver. */
  readonly dnsChallenge: boolean;
  /** Panel hostname and IPv4: never routable to a site. */
  readonly reservedHosts: readonly string[];
}

export function siteRouteOptions(
  panel: PanelIngressConfig | null,
  dns: DnsProviderState | null = null,
): SiteRouteOptions {
  return {
    acmeEnabled: Boolean(panel?.acmeEmail),
    dnsChallenge: Boolean(panel?.acmeEmail && dns),
    reservedHosts: panel ? [panel.hostname.trim().toLowerCase(), panel.ipv4.trim()] : [],
  };
}

export interface PanelIngressConfig {
  readonly hostname: string;
  readonly ipv4: string;
  readonly acmeEmail: string | null;
  readonly acmeStaging: boolean;
  /** Local test CA only; the installer never sets it. */
  readonly acmeCaServer: string | null;
  readonly acmeCaCertFile: string | null;
  readonly upstreamPort: number;
}

function assertValidPort(port: number, what: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ExecutorCodedError(
      `${what} must be an integer between 1 and 65535`,
      "VALIDATION_ERROR",
    );
  }
}

function assertAcmeEmail(email: string): string {
  if (email.length > 254 || !ACME_EMAIL_PATTERN.test(email)) {
    throw new ExecutorCodedError("Invalid ACME account email", "VALIDATION_ERROR");
  }
  return email;
}

/** One store per CA, so switching staging/production never mixes accounts or certificates. */
export function acmeStorageFileName(
  panel: PanelIngressConfig | null,
): "acme.json" | "acme-staging.json" | "acme-custom.json" {
  if (panel?.acmeCaServer) return "acme-custom.json";
  return panel?.acmeStaging ? "acme-staging.json" : "acme.json";
}

function assertAcmeCaServer(url: string): string {
  if (url.length > 2048 || !ACME_CA_SERVER_PATTERN.test(url)) {
    throw new ExecutorCodedError("ACME CA server must be an https:// URL", "VALIDATION_ERROR");
  }
  return url;
}

export function buildTraefikStaticYaml(
  panel: PanelIngressConfig | null,
  dns: DnsProviderState | null = null,
): string {
  const lines = [
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
  const caServer = panel?.acmeCaServer
    ? JSON.stringify(assertAcmeCaServer(panel.acmeCaServer))
    : panel?.acmeStaging
      ? ACME_STAGING_URL
      : null;
  if (panel?.acmeEmail) {
    // Both resolvers share one store and one CA, so a host switching challenge keeps its certificate.
    const acme = [
      "    acme:",
      `      email: ${JSON.stringify(assertAcmeEmail(panel.acmeEmail))}`,
      `      storage: /etc/traefik/acme/${acmeStorageFileName(panel)}`,
      ...(caServer ? [`      caServer: ${caServer}`] : []),
      ...(panel.acmeCaServer && panel.acmeCaCertFile
        ? ["      caCertificates:", `        - /etc/traefik/acme/${CUSTOM_CA_FILE_NAME}`]
        : []),
    ];
    lines.push(
      "certificatesResolvers:",
      "  le:",
      ...acme,
      "      httpChallenge:",
      "        entryPoint: web",
      ...(dns
        ? [`  ${DNS_RESOLVER_NAME}:`, ...acme, "      dnsChallenge:", `        provider: ${dns.provider}`]
        : []),
      "",
    );
  }
  return lines.join("\n");
}

export type PanelDnsLookup = (hostname: string) => Promise<{ a: string[]; aaaa: string[] }>;

export function buildPanelDynamicYaml(panel: PanelIngressConfig, requestCertificate = true): string {
  const hostname = assertSafeDomain(panel.hostname);
  if (hostname.startsWith("*.")) {
    throw new ExecutorCodedError("Panel hostname cannot be a wildcard", "VALIDATION_ERROR");
  }
  const ipv4 = assertSafeDomain(panel.ipv4);
  if (!isIPv4(ipv4)) {
    throw new ExecutorCodedError("Panel IPv4 address is invalid", "VALIDATION_ERROR");
  }
  assertValidPort(panel.upstreamPort, "Panel upstream port");
  const tls = panel.acmeEmail && requestCertificate
    ? ["      tls:", "        certResolver: le"]
    : ["      tls: {}"];
  return [
    "# Managed by hp-docker-executor — panel ingress — DO NOT EDIT",
    "http:",
    "  routers:",
    "    hp-panel:",
    "      entryPoints:",
    '        - "websecure"',
    `      rule: "Host(\`${hostname}\`)"`,
    '      service: "hp-panel"',
    ...tls,
    "    hp-panel-ip:",
    "      entryPoints:",
    '        - "websecure"',
    `      rule: "Host(\`${ipv4}\`)"`,
    '      service: "hp-panel"',
    "      tls: {}",
    "    hp-panel-http:",
    "      entryPoints:",
    '        - "web"',
    `      rule: "Host(\`${hostname}\`) || Host(\`${ipv4}\`)"`,
    '      service: "hp-panel"',
    "      middlewares:",
    '        - "hp-panel-https-redirect"',
    "  middlewares:",
    "    hp-panel-https-redirect:",
    "      redirectScheme:",
    "        scheme: https",
    "        permanent: true",
    "  services:",
    "    hp-panel:",
    "      loadBalancer:",
    "        passHostHeader: true",
    "        servers:",
    `          - url: "http://host.docker.internal:${String(panel.upstreamPort)}"`,
    "",
  ].join("\n");
}

function hostPolicyDenied(what: string): never {
  throw new ExecutorCodedError(`Unsafe or reserved ingress ${what}`, "HOST_POLICY_DENIED");
}

function assertSiteHostRoute(host: SiteHostRoute, reserved: ReadonlySet<string>): SiteHostRoute {
  if (normalizeSiteDomain(host.hostname) !== host.hostname || reserved.has(host.hostname)) {
    hostPolicyDenied("hostname");
  }
  if (host.redirectTo !== null) {
    if (!isSiteOrigin(host.redirectTo)) hostPolicyDenied("redirect origin");
    if (reserved.has(host.redirectTo.replace(/^https?:\/\//, ""))) hostPolicyDenied("redirect origin");
  }
  if (host.source !== undefined && host.source !== "manual") hostPolicyDenied("certificate source");
  // A manual certificate is not ordered, so no challenge applies to it.
  if (host.source === "manual" && host.challenge !== undefined) {
    throw new ExecutorCodedError("A manual certificate host cannot carry an ACME challenge", "VALIDATION_ERROR");
  }
  const base = {
    hostname: host.hostname,
    tls: host.tls === true,
    httpsRedirect: host.httpsRedirect === true,
    redirectTo: host.redirectTo,
  };
  // http-01 and ACME stay implicit, so their route files and @hp-route lines stay byte-identical.
  if (host.source === "manual") return { ...base, source: "manual" };
  return host.challenge === "dns-01" ? { ...base, challenge: "dns-01" } : base;
}

/** Every host and redirect passes policy; a redirect lands on another non-redirecting host of the set. */
export function assertSiteHostRoutes(
  routes: readonly SiteHostRoute[],
  reserved: ReadonlySet<string>,
): SiteHostRoute[] {
  const hosts = routes.map((host) => assertSiteHostRoute(host, reserved));
  const byName = new Map(hosts.map((h) => [h.hostname, h]));
  for (const h of hosts) {
    if (h.redirectTo === null) continue;
    const target = byName.get(h.redirectTo.replace(/^https?:\/\//, ""));
    if (!target || target === h || target.redirectTo !== null) hostPolicyDenied("redirect target");
  }
  return hosts;
}

/** Stable per hostname, so adding a name never renames the routers of the others. */
function hostSuffix(hostname: string): string {
  return createHash("sha256").update(hostname).digest("hex").slice(0, 8);
}

export function buildSiteDynamicTraefikYaml(
  siteId: string,
  routes: readonly SiteIngressRouteEntry[],
  opts: SiteRouteOptions,
): string {
  assertSafeIdentifier(siteId, "siteId");
  const reserved = new Set(opts.reservedHosts);

  const activeRoutes = routes
    .filter((route) => route.hosts.length > 0)
    .map((route) => {
      assertSafeIdentifier(route.serviceInstanceId, "serviceInstanceId");
      assertSafeIdentifier(route.containerName, "containerName");
      if (
        !Number.isInteger(route.internalPort) ||
        route.internalPort < 1 ||
        route.internalPort > 65535
      ) {
        throw new ExecutorCodedError(
          "Ingress route internalPort must be between 1 and 65535",
          "VALIDATION_ERROR",
        );
      }
      const hosts = assertSiteHostRoutes(route.hosts, reserved);
      return {
        serviceInstanceId: route.serviceInstanceId,
        containerName: route.containerName,
        internalPort: route.internalPort,
        hosts: hosts.sort((a, b) => a.hostname.localeCompare(b.hostname)),
      };
    })
    .sort((a, b) => a.serviceInstanceId.localeCompare(b.serviceInstanceId));

  const allHostnames = activeRoutes.flatMap((route) => route.hosts.map((h) => h.hostname));
  if (allHostnames.length > MAX_SITE_ROUTE_HOSTS) {
    throw new ExecutorCodedError("Too many hostnames for one site", "VALIDATION_ERROR");
  }
  if (new Set(allHostnames).size !== allHostnames.length) {
    throw new ExecutorCodedError("Duplicate hostname in site routes", "VALIDATION_ERROR");
  }

  if (activeRoutes.length === 0) {
    return "";
  }

  const lines: string[] = [
    `# Managed by hp-docker-executor for site ${siteId} — DO NOT EDIT`,
  ];
  for (const route of activeRoutes) {
    lines.push(`# @hp-route ${JSON.stringify(route)}`);
  }

  const routers: string[] = [];
  const middlewares: string[] = [];
  for (const route of activeRoutes) {
    const key = sanitizeTraefikKey(route.serviceInstanceId);
    let needsHttpsRedirect = false;
    for (const host of route.hosts) {
      const i = hostSuffix(host.hostname);
      const canon = host.redirectTo !== null ? `canon_${key}_${i}` : null;
      const manual = host.source === "manual";
      const httpsRedirect = (opts.acmeEnabled || manual) && host.httpsRedirect && canon === null;
      needsHttpsRedirect ||= httpsRedirect;
      const httpMiddleware = canon ?? (httpsRedirect ? `https_${key}` : null);
      const router = (name: string, entryPoint: string, middleware: string | null) => [
        `    ${name}:`,
        "      entryPoints:",
        `        - "${entryPoint}"`,
        `      rule: "Host(\`${host.hostname}\`)"`,
        `      service: "svc_${key}"`,
        ...(middleware ? ["      middlewares:", `        - "${middleware}"`] : []),
      ];
      routers.push(...router(`router_${key}_${i}`, "web", httpMiddleware));
      if (host.tls && (opts.acmeEnabled || manual)) {
        const dns01 = host.challenge === "dns-01";
        routers.push(
          ...router(`router_${key}_${i}_tls`, "websecure", canon),
          // A manual host is served from the loaded certificate list. Without le-dns a dns-01 host
          // serves the default certificate instead of failing.
          ...(manual || (dns01 && !opts.dnsChallenge)
            ? ["      tls: {}"]
            : ["      tls:", `        certResolver: ${dns01 ? DNS_RESOLVER_NAME : "le"}`]),
        );
      }
      if (canon !== null) {
        middlewares.push(
          `    ${canon}:`,
          "      redirectRegex:",
          '        regex: "^https?://[^/]+(.*)$"',
          `        replacement: "${host.redirectTo}\${1}"`,
          "        permanent: true",
        );
      }
    }
    if (needsHttpsRedirect) {
      middlewares.push(
        `    https_${key}:`,
        "      redirectScheme:",
        "        scheme: https",
        "        permanent: true",
      );
    }
  }

  lines.push("http:", "  routers:", ...routers);
  if (middlewares.length > 0) {
    lines.push("  middlewares:", ...middlewares);
  }

  lines.push("  services:");
  for (const route of activeRoutes) {
    const key = sanitizeTraefikKey(route.serviceInstanceId);
    lines.push(`    svc_${key}:`);
    lines.push("      loadBalancer:");
    lines.push("        passHostHeader: true");
    lines.push("        servers:");
    lines.push(`          - url: "http://${route.containerName}:${String(route.internalPort)}"`);
  }

  lines.push("");
  return lines.join("\n");
}

export interface AppStackRouteEntry {
  readonly componentKey: string;
  readonly internalPort: number;
  readonly hosts: readonly AppStackHostRoute[];
}

const APP_STACK_FILE_PATTERN = /^app_([a-z][a-z0-9_]{0,63})\.yml$/;
/** What a browser may show when it asks for the password of a protected address: never the name of the proxy. */
const APP_PROTECTION_REALM = "Restricted";

function invalidAppRoute(): never {
  throw new ExecutorCodedError("Invalid application route", "VALIDATION_ERROR");
}

function assertAppStackId(stackId: string): void {
  if (!APP_STACK_ID_PATTERN.test(stackId)) invalidAppRoute();
  assertSafeIdentifier(stackId, "stackId");
}

/**
 * One host of an application, re-checked value by value (ADR-0037 R7): no manual certificate, and each option either
 * matches its contract pattern or refuses the whole file. Options are appended in a fixed order and only when set, so
 * a host without options is the object the site check returns.
 */
function assertAppHostRoute(host: AppStackHostRoute, reserved: ReadonlySet<string>): AppStackHostRoute {
  if (host.source !== undefined) hostPolicyDenied("certificate source");
  const base = assertSiteHostRoute(host, reserved);
  const options: { compress?: true; protection?: AppStackRouteProtection; paths?: AppStackRoutePath[] } = {};
  if (host.compress !== undefined) {
    if (host.compress !== true) invalidAppRoute();
    options.compress = true;
  }
  if (host.protection !== undefined) {
    const parsed = AppStackRouteProtectionSchema.safeParse(host.protection);
    if (!parsed.success) invalidAppRoute();
    options.protection = { username: parsed.data.username, passwordHash: parsed.data.passwordHash };
  }
  if (host.paths !== undefined) {
    if (!Array.isArray(host.paths) || host.paths.length < 1 || host.paths.length > MAX_APP_ROUTE_PATHS) invalidAppRoute();
    const paths = host.paths.map((path): AppStackRoutePath => {
      const parsed = AppStackRoutePathSchema.safeParse(path);
      if (!parsed.success) invalidAppRoute();
      const { pathPrefix, componentKey, internalPort, stripPrefix } = parsed.data;
      return { pathPrefix, componentKey, internalPort, stripPrefix };
    });
    if (new Set(paths.map((path) => path.pathPrefix)).size !== paths.length) invalidAppRoute();
    options.paths = paths.sort((a, b) => (a.pathPrefix < b.pathPrefix ? -1 : 1));
  }
  // A redirecting host answers with the redirect alone: nothing to protect, compress or split by path.
  if (base.redirectTo !== null && Object.keys(options).length > 0) invalidAppRoute();
  return { ...base, ...options };
}

/**
 * HTTP host routing of one application, nothing from the template. Per host: an optional redirect to another host of
 * the same file, or the content with optional password protection, compression and path rules (ADR-0037).
 */
export function buildAppStackDynamicTraefikYaml(
  stackId: string,
  routes: readonly AppStackRouteEntry[],
  opts: SiteRouteOptions,
): string {
  assertAppStackId(stackId);
  const reserved = new Set(opts.reservedHosts);
  const activeRoutes = routes
    .filter((route) => route.hosts.length > 0)
    .map((route) => {
      if (
        !APP_STACK_KEY_PATTERN.test(route.componentKey) ||
        !Number.isInteger(route.internalPort) ||
        route.internalPort < 1 ||
        route.internalPort > 65535
      ) {
        invalidAppRoute();
      }
      return {
        componentKey: route.componentKey,
        internalPort: route.internalPort,
        hosts: route.hosts
          .map((host) => assertAppHostRoute(host, reserved))
          .sort((a, b) => a.hostname.localeCompare(b.hostname)),
      };
    })
    .sort((a, b) => a.componentKey.localeCompare(b.componentKey) || a.internalPort - b.internalPort);

  const pairs = new Set(activeRoutes.map((route) => `${route.componentKey}:${String(route.internalPort)}`));
  const allHosts = activeRoutes.flatMap((route) => route.hosts);
  const byHostname = new Map(allHosts.map((host) => [host.hostname, host]));
  if (pairs.size !== activeRoutes.length || allHosts.length > MAX_APP_STACK_DOMAINS || byHostname.size !== allHosts.length) {
    invalidAppRoute();
  }
  // A redirect lands on another host of this application that serves content, whichever route entry holds it.
  for (const host of allHosts) {
    if (host.redirectTo === null) continue;
    const target = byHostname.get(host.redirectTo.replace(/^https?:\/\//, ""));
    if (target === undefined || target.redirectTo !== null) hostPolicyDenied("redirect target");
  }
  if (activeRoutes.length === 0) {
    return "";
  }

  const lines = [`# Managed by hp-docker-executor for application stack ${stackId} — DO NOT EDIT`];
  for (const route of activeRoutes) {
    lines.push(`# @hp-app-route ${JSON.stringify(route)}`);
  }
  const names = new Set<string>();
  /** Router and middleware names are built from hashes of what the customer typed: two equal names refuse the file. */
  const named = (name: string): string => {
    if (names.has(name)) invalidAppRoute();
    names.add(name);
    return name;
  };
  const targets = new Map<string, { componentKey: string; internalPort: number }>();
  const serviceKey = (componentKey: string, internalPort: number): string => {
    const key = `app_${stackId}_${componentKey}_${String(internalPort)}`;
    targets.set(key, { componentKey, internalPort });
    return key;
  };
  const compress = `app_${stackId}_compress`;
  let compressUsed = false;
  const routers: string[] = [];
  const middlewares: string[] = [];
  for (const route of activeRoutes) {
    const key = serviceKey(route.componentKey, route.internalPort);
    let needsHttpsRedirect = false;
    for (const host of route.hosts) {
      const i = hostSuffix(host.hostname);
      const tls = host.tls && opts.acmeEnabled;
      const dns01 = host.challenge === "dns-01";
      const hostRule = `Host(\`${host.hostname}\`)`;
      const router = (name: string, entryPoint: "web" | "websecure", rule: string, service: string, use: readonly string[]) => {
        routers.push(
          `    ${named(name)}:`,
          "      entryPoints:",
          `        - "${entryPoint}"`,
          `      rule: "${rule}"`,
          `      service: "${service}"`,
        );
        if (use.length > 0) routers.push("      middlewares:", ...use.map((middleware) => `        - "${middleware}"`));
        if (entryPoint === "websecure") {
          routers.push(
            ...(dns01 && !opts.dnsChallenge
              ? ["      tls: {}"]
              : ["      tls:", `        certResolver: ${dns01 ? DNS_RESOLVER_NAME : "le"}`]),
          );
        }
      };
      if (host.redirectTo !== null) {
        // Straight to the other address from both entry points, as the canonical redirect of a site does.
        const to = `${key}_${i}_to`;
        router(`${key}_${i}`, "web", hostRule, key, [to]);
        if (tls) router(`${key}_${i}_tls`, "websecure", hostRule, key, [to]);
        middlewares.push(
          `    ${named(to)}:`,
          "      redirectRegex:",
          '        regex: "^https?://[^/]+(.*)$"',
          `        replacement: "${host.redirectTo}\${1}"`,
          "        permanent: true",
        );
        continue;
      }
      const httpsRedirect = opts.acmeEnabled && host.httpsRedirect;
      needsHttpsRedirect ||= httpsRedirect;
      // What every router serving the content of this host goes through, in this order.
      const content: string[] = [];
      if (host.protection !== undefined) {
        const auth = `${key}_${i}_auth`;
        content.push(auth);
        middlewares.push(
          `    ${named(auth)}:`,
          "      basicAuth:",
          "        users:",
          `          - "${host.protection.username}:${host.protection.passwordHash}"`,
          `        realm: "${APP_PROTECTION_REALM}"`,
          "        removeHeader: true",
        );
      }
      if (host.compress === true) {
        compressUsed = true;
        content.push(compress);
      }
      // With the HTTPS redirect the plain router serves no content: it only sends the browser to HTTPS, password unasked.
      router(`${key}_${i}`, "web", hostRule, key, httpsRedirect ? [`${key}_https`] : content);
      if (tls) router(`${key}_${i}_tls`, "websecure", hostRule, key, content);
      for (const path of host.paths ?? []) {
        if (httpsRedirect && !tls) continue;
        const pathKey = serviceKey(path.componentKey, path.internalPort);
        const j = hostSuffix(`${host.hostname}${path.pathPrefix}`);
        // Longer than the host rule, and longer the deeper the path: the proxy tries the most specific rule first.
        const rule = `${hostRule} && (Path(\`${path.pathPrefix}\`) || PathPrefix(\`${path.pathPrefix}/\`))`;
        const use = [...content];
        if (path.stripPrefix) {
          const strip = `${pathKey}_${j}_strip`;
          use.push(strip);
          middlewares.push(`    ${named(strip)}:`, "      stripPrefix:", "        prefixes:", `          - "${path.pathPrefix}"`);
        }
        if (!httpsRedirect) router(`${pathKey}_${j}`, "web", rule, pathKey, use);
        if (tls) router(`${pathKey}_${j}_tls`, "websecure", rule, pathKey, use);
      }
    }
    if (needsHttpsRedirect) {
      middlewares.push(`    ${named(`${key}_https`)}:`, "      redirectScheme:", "        scheme: https", "        permanent: true");
    }
  }
  if (compressUsed) middlewares.push(`    ${named(compress)}:`, "      compress: {}");
  const services = [...targets.entries()]
    .sort(([, a], [, b]) => a.componentKey.localeCompare(b.componentKey) || a.internalPort - b.internalPort)
    .flatMap(([key, target]) => [
      `    ${key}:`,
      "      loadBalancer:",
      "        passHostHeader: true",
      "        servers:",
      `          - url: "http://hp_app_${stackId}_${target.componentKey}:${String(target.internalPort)}"`,
    ]);

  lines.push("http:", "  routers:", ...routers);
  if (middlewares.length > 0) {
    lines.push("  middlewares:", ...middlewares);
  }
  lines.push("  services:", ...services, "");
  return lines.join("\n");
}

/** Lines "# @hp-app-route {json}" only; malformed lines are skipped. The builder re-checks every value it reads here. */
export function parsePersistedAppStackRoutesFromYaml(yamlContent: string): AppStackRouteEntry[] {
  const routes: AppStackRouteEntry[] = [];
  for (const line of yamlContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("# @hp-app-route ")) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed.slice("# @hp-app-route ".length)) as Partial<AppStackRouteEntry>;
      if (
        typeof parsed.componentKey === "string" &&
        typeof parsed.internalPort === "number" &&
        Array.isArray(parsed.hosts) &&
        parsed.hosts.every(isAppHostRouteShape)
      ) {
        routes.push({ componentKey: parsed.componentKey, internalPort: parsed.internalPort, hosts: parsed.hosts });
      }
    } catch {
      // Ignore malformed comment lines
    }
  }
  return routes;
}

function isAppHostRouteShape(value: unknown): value is AppStackHostRoute {
  if (!isSiteHostRouteShape(value)) return false;
  const h = value as { compress?: unknown; protection?: unknown; paths?: unknown };
  const protection = h.protection as { username?: unknown; passwordHash?: unknown } | null | undefined;
  return (
    (h.compress === undefined || h.compress === true) &&
    (protection === undefined ||
      (protection !== null && typeof protection.username === "string" && typeof protection.passwordHash === "string")) &&
    (h.paths === undefined ||
      (Array.isArray(h.paths) &&
        h.paths.every((path: { pathPrefix?: unknown; componentKey?: unknown; internalPort?: unknown; stripPrefix?: unknown } | null) =>
          typeof path?.pathPrefix === "string" &&
          typeof path.componentKey === "string" &&
          typeof path.internalPort === "number" &&
          typeof path.stripPrefix === "boolean",
        )))
  );
}

function isSiteHostRouteShape(value: unknown): value is SiteHostRoute {
  const h = value as Partial<SiteHostRoute> | null;
  return (
    typeof h?.hostname === "string" &&
    typeof h.tls === "boolean" &&
    typeof h.httpsRedirect === "boolean" &&
    (h.redirectTo === null || typeof h.redirectTo === "string") &&
    (h.challenge === undefined || h.challenge === "http-01" || h.challenge === "dns-01") &&
    (h.source === undefined || h.source === "manual")
  );
}

function parsePersistedRoutesFromYaml(yamlContent: string): SiteIngressRouteEntry[] {
  const routes: SiteIngressRouteEntry[] = [];
  for (const line of yamlContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("# @hp-route ")) {
      continue;
    }
    const jsonPart = trimmed.slice("# @hp-route ".length);
    try {
      const parsed = JSON.parse(jsonPart) as Partial<SiteIngressRouteEntry> & {
        readonly domains?: unknown;
      };
      // A 2a file stores plain `domains`: they become hosts without TLS.
      const hosts: unknown = Array.isArray(parsed.domains)
        ? parsed.domains.map((d: unknown) =>
            typeof d === "string"
              ? { hostname: d, tls: false, httpsRedirect: false, redirectTo: null }
              : null,
          )
        : parsed.hosts;
      if (
        typeof parsed.serviceInstanceId === "string" &&
        typeof parsed.containerName === "string" &&
        typeof parsed.internalPort === "number" &&
        Array.isArray(hosts) &&
        hosts.every(isSiteHostRouteShape)
      ) {
        routes.push({
          serviceInstanceId: parsed.serviceInstanceId,
          containerName: parsed.containerName,
          internalPort: parsed.internalPort,
          hosts,
        });
      }
    } catch {
      // Ignore malformed comment lines
    }
  }
  return routes;
}

export interface IngressProxyContainerConfigInput {
  readonly traefikImage?: string;
  readonly httpHostPort?: number;
  readonly httpsHostPort?: number;
  readonly staticConfigHostPath: string;
  readonly dynamicDirHostPath: string;
  readonly acmeDirHostPath: string;
  readonly staticSha256?: string;
  /** "uid:gid" the proxy runs as; with CapDrop ALL, container root cannot read hp-executor-owned dirs. */
  readonly user?: string;
  /** DNS-01 provider credentials: a read-only dir of files, and only `<NAME>_FILE` paths in Env. */
  readonly acmeDns?: { readonly secretDirHostPath: string; readonly env: readonly string[] };
}

export interface DockerIngressProxyCreatePayload {
  readonly Image: string;
  readonly Cmd: readonly string[];
  readonly User?: string;
  readonly Env?: readonly string[];
  readonly Labels: Readonly<Record<string, string>>;
  readonly ExposedPorts: Readonly<Record<string, Record<string, never>>>;
  readonly HostConfig: {
    readonly Privileged: false;
    readonly CapDrop: readonly ["ALL"];
    readonly CapAdd: readonly ["NET_BIND_SERVICE"];
    readonly SecurityOpt: readonly ["no-new-privileges:true"];
    readonly PidsLimit: number;
    readonly RestartPolicy: { readonly Name: "unless-stopped" };
    readonly NetworkMode: string;
    readonly PortBindings: Readonly<
      Record<string, readonly { readonly HostIp: string; readonly HostPort: string }[]>
    >;
    readonly Binds: readonly string[];
    readonly ExtraHosts: readonly string[];
    readonly LogConfig: {
      readonly Type: "json-file";
      readonly Config: { readonly "max-size": "10m"; readonly "max-file": "3" };
    };
  };
  readonly NetworkingConfig: {
    readonly EndpointsConfig: { readonly [INGRESS_BRIDGE_NETWORK_NAME]: { readonly GwPriority: 1 } };
  };
}

export function buildIngressProxyContainerPayload(
  input: IngressProxyContainerConfigInput,
): DockerIngressProxyCreatePayload {
  const image = input.traefikImage ?? DEFAULT_TRAEFIK_IMAGE;
  const httpPort = input.httpHostPort ?? DEFAULT_INGRESS_HTTP_PORT;
  const httpsPort = input.httpsHostPort ?? DEFAULT_INGRESS_HTTPS_PORT;
  assertValidPort(httpPort, "Ingress HTTP host port");
  assertValidPort(httpsPort, "Ingress HTTPS host port");

  if (
    [
      input.staticConfigHostPath,
      input.dynamicDirHostPath,
      input.acmeDirHostPath,
      ...(input.acmeDns ? [input.acmeDns.secretDirHostPath] : []),
    ].some((p) => p.includes("docker.sock"))
  ) {
    throw new ExecutorCodedError(
      "Mounting docker.sock into ingress proxy is strictly forbidden (TH-02)",
      "HOST_POLICY_DENIED",
    );
  }

  return {
    Image: image,
    Cmd: ["--configFile=/etc/traefik/traefik.yml"],
    ...(input.user ? { User: input.user } : {}),
    ...(input.acmeDns ? { Env: [...input.acmeDns.env] } : {}),
    Labels: {
      "io.hostingpanel.managed": "true",
      "io.hostingpanel.role": "ingress_proxy",
      ...(input.staticSha256 ? { [STATIC_SHA256_LABEL]: input.staticSha256 } : {}),
    },
    ExposedPorts: {
      "80/tcp": {},
      "443/tcp": {},
    },
    HostConfig: {
      Privileged: false,
      CapDrop: ["ALL"],
      CapAdd: ["NET_BIND_SERVICE"],
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 256,
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: INGRESS_BRIDGE_NETWORK_NAME,
      PortBindings: {
        "80/tcp": [{ HostIp: "0.0.0.0", HostPort: String(httpPort) }],
        "443/tcp": [{ HostIp: "0.0.0.0", HostPort: String(httpsPort) }],
      },
      Binds: [
        `${input.staticConfigHostPath}:/etc/traefik/traefik.yml:ro`,
        `${input.dynamicDirHostPath}:/etc/traefik/dynamic:ro`,
        // The only read-write mount: Traefik persists ACME account + certificates here.
        `${input.acmeDirHostPath}:/etc/traefik/acme`,
        ...(input.acmeDns ? [`${input.acmeDns.secretDirHostPath}:${ACME_DNS_SECRET_MOUNT}:ro`] : []),
      ],
      ExtraHosts: ["host.docker.internal:host-gateway"],
      // The executor reads ACME failures from this log, so it must stay bounded.
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
    },
    // The panel upstream (host-gateway, docker0) is reached through the default route. Without a
    // priority Docker gives the gateway to the first network by name, so a new hp_edge_* network
    // would take it and stall the panel connections in flight (O2). Needs Engine API >= 1.48.
    NetworkingConfig: { EndpointsConfig: { [INGRESS_BRIDGE_NETWORK_NAME]: { GwPriority: 1 } } },
  };
}

export class TraefikIngressFileManager {
  public readonly ingressRootDir: string;
  public readonly staticConfigPath: string;
  public readonly dynamicDirPath: string;
  public readonly acmeDirPath: string;
  public readonly dnsProviderStatePath: string;
  /** dynamic/manual-certs: version dirs are written by the manual TLS store. */
  public readonly manualCertsDirPath: string;
  /** The names-only state of the manual TLS store, next to the DNS provider state. */
  public readonly manualTlsStatePath: string;
  /** The same directory as the proxy sees it. */
  public readonly manualCertMountDir: string;
  private readonly siteRoutes = new Map<string, Map<string, SiteIngressRouteEntry>>();
  private readonly serviceToSite = new Map<string, string>();
  private readonly panel: PanelIngressConfig | null;
  private routeOptions: SiteRouteOptions;
  /** undefined until loaded from disk. */
  private dnsState: DnsProviderState | null | undefined;
  // Until gatePanelCertificate runs (the executor runs it before the first ensure), keep the resolver.
  private panelRequestCertificate = true;
  private panelGateDecided = false;
  /** One writer of dynamic/site_*.yml at a time: the DNS re-render rewrites every site file. */
  private siteFileLine: Promise<unknown> = Promise.resolve();

  public constructor(
    ingressRootDir: string = DEFAULT_INGRESS_ROOT_DIR,
    panel: PanelIngressConfig | null = null,
    options: { readonly manualCertMountDir?: string } = {},
  ) {
    this.panel = panel;
    this.routeOptions = siteRouteOptions(panel);
    this.ingressRootDir = path.resolve(ingressRootDir);
    this.staticConfigPath = path.join(this.ingressRootDir, "static", "traefik.yml");
    this.dynamicDirPath = path.join(this.ingressRootDir, "dynamic");
    this.acmeDirPath = path.join(this.ingressRootDir, "acme");
    this.dnsProviderStatePath = path.join(this.ingressRootDir, DNS_PROVIDER_STATE_FILE);
    this.manualCertsDirPath = path.join(this.dynamicDirPath, MANUAL_CERTS_DIR_NAME);
    this.manualTlsStatePath = path.join(this.ingressRootDir, MANUAL_TLS_STATE_FILE);
    this.manualCertMountDir = options.manualCertMountDir ?? DEFAULT_MANUAL_CERT_MOUNT_DIR;
  }

  private inSiteFileLine<T>(work: () => Promise<T>): Promise<T> {
    const run = this.siteFileLine.then(work);
    this.siteFileLine = run.catch(() => undefined);
    return run;
  }

  private rememberDnsState(state: DnsProviderState | null): DnsProviderState | null {
    this.dnsState = state;
    this.routeOptions = siteRouteOptions(this.panel, state);
    return state;
  }

  /** The provider survives restarts in a names-only file; missing or invalid means none. */
  public async loadDnsProviderState(): Promise<DnsProviderState | null> {
    if (this.dnsState !== undefined) return this.dnsState;
    const text = await readFile(this.dnsProviderStatePath, "utf8").catch(() => null);
    return this.rememberDnsState(text === null ? null : parseDnsProviderState(text));
  }

  /** Returns whether the persisted state changed. */
  public setDnsProviderState(state: DnsProviderState | null): Promise<boolean> {
    return this.inSiteFileLine(() => this.applyDnsProviderState(state));
  }

  private async applyDnsProviderState(state: DnsProviderState | null): Promise<boolean> {
    const previous = await this.loadDnsProviderState();
    const changed = JSON.stringify(previous) !== JSON.stringify(state);
    if (state) {
      await mkdir(this.ingressRootDir, { recursive: true, mode: 0o755 });
      await writeFileIfChanged(this.dnsProviderStatePath, JSON.stringify(state), 0o600);
    } else {
      await rm(this.dnsProviderStatePath, { force: true });
    }
    this.rememberDnsState(state);
    if (changed) await this.rerenderSiteFiles();
    return changed;
  }

  /** Writes the manual certificate list the proxy watches; null removes it. */
  public writeManualCertificateManifest(content: string | null): Promise<void> {
    return this.inSiteFileLine(async () => {
      const file = path.join(this.dynamicDirPath, MANUAL_CERTIFICATES_FILE_NAME);
      if (content === null) {
        await rm(file, { force: true });
        return;
      }
      await mkdir(this.dynamicDirPath, { recursive: true, mode: 0o755 });
      await writeFileIfChanged(file, content, 0o644);
    });
  }

  /** The panel host and every host of the persisted site routes, read under the file line. */
  public listRoutedHostnames(): Promise<string[]> {
    return this.inSiteFileLine(async () => {
      const hostnames = new Set<string>();
      if (this.panel) hostnames.add(this.panel.hostname.trim().toLowerCase());
      const names = await readdir(this.dynamicDirPath).catch(() => [] as string[]);
      for (const name of names) {
        const siteId = /^site_(.+)\.yml$/.exec(name)?.[1];
        if (!siteId || siteId.includes("..") || !SAFE_IDENTIFIER_PATTERN.test(siteId)) continue;
        const siteMap = await this.getOrHydrateSiteMap(siteId);
        for (const entry of siteMap.values()) {
          for (const routeHost of entry.hosts) hostnames.add(routeHost.hostname);
        }
      }
      for (const name of names) {
        const stackId = APP_STACK_FILE_PATTERN.exec(name)?.[1];
        if (!stackId) continue;
        for (const entry of await this.readAppStackRoutesNow(stackId)) {
          for (const routeHost of entry.hosts) hostnames.add(routeHost.hostname);
        }
      }
      return [...hostnames].sort();
    });
  }

  /** dns-01 hosts follow the resolver choice; files that would not change are not rewritten. */
  private async rerenderSiteFiles(): Promise<void> {
    const names = await readdir(this.dynamicDirPath).catch(() => [] as string[]);
    for (const name of names) {
      const siteId = /^site_(.+)\.yml$/.exec(name)?.[1];
      if (!siteId || siteId.includes("..") || !SAFE_IDENTIFIER_PATTERN.test(siteId)) continue;
      const siteMap = await this.getOrHydrateSiteMap(siteId);
      // A file without @hp-route lines is not ours to rewrite or delete.
      if (siteMap.size === 0) continue;
      // One bad file must not stop the others: the state is already saved, so no retry would reach them.
      await this.flushSiteDynamicFile(siteId, siteMap).catch(() => undefined);
    }
    for (const name of names) {
      const stackId = APP_STACK_FILE_PATTERN.exec(name)?.[1];
      if (!stackId) continue;
      const routes = await this.readAppStackRoutesNow(stackId);
      if (routes.length === 0) continue;
      await this.writeAppStackRoutesNow(stackId, routes).catch(() => undefined);
    }
  }

  /**
   * Owner decision (2b): like the sites, the panel asks Let's Encrypt only when its A record points
   * here with no AAAA, so a wrong record never spends orders (Traefik re-orders on every reload).
   * A valid stored certificate keeps the resolver (renewal).
   * Rewrites the panel route file when it exists. Returns whether the certificate is requested.
   */
  public async gatePanelCertificate(
    panel: PanelIngressConfig,
    lookup: PanelDnsLookup,
    now: number = Date.now(),
  ): Promise<boolean> {
    const hostname = panel.hostname.trim().toLowerCase();
    const panelFile = path.join(this.dynamicDirPath, PANEL_DYNAMIC_FILE_NAME);
    let wanted = false;
    if (panel.acmeEmail) {
      const store = await readAcmeCertificates(path.join(this.acmeDirPath, acmeStorageFileName(panel)));
      // The last decision: in memory, or after a restart the file already on disk (fresh install: no).
      const previous = this.panelGateDecided
        ? this.panelRequestCertificate
        : /^\s*certResolver: le$/m.test(await readFile(panelFile, "utf8").catch(() => ""));
      wanted = store.certificates.some((c) => c.hostname === hostname && Date.parse(c.notAfter) > now);
      if (!wanted) {
        try {
          const { a, aaaa } = await lookup(hostname);
          wanted = a.length > 0 && a.every((ip) => ip === panel.ipv4.trim()) && aaaa.length === 0;
          // An unreadable store may hide a valid certificate: never drop the resolver on its word.
          if (!wanted && !store.readable) wanted = previous;
        } catch {
          wanted = previous;
        }
      }
    }
    this.panelRequestCertificate = wanted;
    this.panelGateDecided = true;
    if (await stat(panelFile).catch(() => null)) {
      await writeFileIfChanged(panelFile, buildPanelDynamicYaml(panel, wanted), 0o644);
    }
    return wanted;
  }

  public getSiteDynamicFilePath(siteId: string): string {
    assertSafeIdentifier(siteId, "siteId");
    const candidate = path.join(this.dynamicDirPath, `site_${siteId}.yml`);
    return assertContainedPath(this.dynamicDirPath, candidate);
  }

  public async ensureStaticConfig(panel: PanelIngressConfig | null = null): Promise<{
    readonly staticConfigPath: string;
    readonly dynamicDirPath: string;
    readonly acmeDirPath: string;
    readonly staticSha256: string;
    /** The provider the proxy container must mount; null without le-dns. */
    readonly acmeDns: DnsProviderState | null;
  }> {
    await mkdir(path.dirname(this.staticConfigPath), { recursive: true, mode: 0o755 });
    await mkdir(this.dynamicDirPath, { recursive: true, mode: 0o755 });
    await mkdir(this.acmeDirPath, { recursive: true, mode: 0o700 });
    await chmod(this.acmeDirPath, 0o700);
    await this.ensureManualCertsDir();
    // Traefik refuses an acme.json looser than 0600; "a" never truncates existing certificates.
    const acmeJsonPath = path.join(this.acmeDirPath, acmeStorageFileName(panel));
    await (await open(acmeJsonPath, "a", 0o600)).close();
    await chmod(acmeJsonPath, 0o600);
    if (panel?.acmeCaCertFile) {
      const caPem = await readFile(panel.acmeCaCertFile).catch(() => {
        throw new ExecutorCodedError(
          "The custom CA certificate file (HP_ACME_CA_CERT_FILE) cannot be read",
          "VALIDATION_ERROR",
        );
      });
      await writeFileIfChanged(path.join(this.acmeDirPath, CUSTOM_CA_FILE_NAME), caPem, 0o644);
    }

    const panelFilePath = path.join(this.dynamicDirPath, PANEL_DYNAMIC_FILE_NAME);
    if (panel) {
      await writeFileIfChanged(panelFilePath, buildPanelDynamicYaml(panel, this.panelRequestCertificate), 0o644);
    } else {
      await rm(panelFilePath, { force: true });
    }

    const dnsState = await this.loadDnsProviderState();
    const staticYaml = buildTraefikStaticYaml(panel, dnsState);

    let needsWrite = true;
    try {
      const existingStat = await stat(this.staticConfigPath);
      if (existingStat.isDirectory()) {
        // Heal auto-created directory left behind if Docker tried to restart a stale bind mount
        await rm(this.staticConfigPath, { recursive: true, force: true });
      } else if (existingStat.isFile()) {
        const currentContent = await readFile(this.staticConfigPath, "utf8");
        if (currentContent === staticYaml) {
          await chmod(this.staticConfigPath, 0o644);
          needsWrite = false;
        }
      }
    } catch {
      // File does not exist yet
    }

    if (needsWrite) {
      await writeFileAtomically(this.staticConfigPath, staticYaml, 0o644, 0o755);
    }

    return {
      staticConfigPath: this.staticConfigPath,
      dynamicDirPath: this.dynamicDirPath,
      acmeDirPath: this.acmeDirPath,
      staticSha256: createHash("sha256").update(staticYaml).digest("hex"),
      acmeDns: panel?.acmeEmail ? dnsState : null,
    };
  }

  /** One unreadable subdirectory breaks the cold start of every route, so it is checked on every ensure. */
  private async ensureManualCertsDir(): Promise<void> {
    const existing = await lstat(this.manualCertsDirPath).catch(() => null);
    if (existing !== null && !existing.isDirectory()) {
      hostPolicyDenied("manual certificate directory");
    }
    await mkdir(this.manualCertsDirPath, { recursive: true, mode: 0o700 });
    await chmod(this.manualCertsDirPath, 0o700);
    const checked = await lstat(this.manualCertsDirPath);
    if (!checked.isDirectory() || (process.getuid && checked.uid !== process.getuid())) {
      hostPolicyDenied("manual certificate directory");
    }
  }

  private async getOrHydrateSiteMap(siteId: string): Promise<Map<string, SiteIngressRouteEntry>> {
    let existing = this.siteRoutes.get(siteId);
    if (existing) {
      return existing;
    }

    existing = new Map<string, SiteIngressRouteEntry>();
    const filePath = this.getSiteDynamicFilePath(siteId);
    try {
      const diskYaml = await readFile(filePath, "utf8");
      for (const route of parsePersistedRoutesFromYaml(diskYaml)) {
        existing.set(route.serviceInstanceId, route);
        this.serviceToSite.set(route.serviceInstanceId, siteId);
      }
    } catch {
      // No pre-existing dynamic site file
    }

    this.siteRoutes.set(siteId, existing);
    return existing;
  }

  public upsertServiceRoute(
    siteId: string,
    route: SiteIngressRouteEntry,
  ): Promise<{ readonly configured: boolean; readonly remainingSiteRoutes: number }> {
    return this.inSiteFileLine(() => this.upsertServiceRouteNow(siteId, route));
  }

  private async upsertServiceRouteNow(
    siteId: string,
    route: SiteIngressRouteEntry,
  ): Promise<{ readonly configured: boolean; readonly remainingSiteRoutes: number }> {
    assertSafeIdentifier(siteId, "siteId");
    assertSafeIdentifier(route.serviceInstanceId, "serviceInstanceId");
    await this.loadDnsProviderState();

    const previousSiteId = this.serviceToSite.get(route.serviceInstanceId);
    if (previousSiteId && previousSiteId !== siteId) {
      await this.removeServiceRouteNow(route.serviceInstanceId, previousSiteId);
    }

    const siteMap = await this.getOrHydrateSiteMap(siteId);
    if (route.hosts.length === 0) {
      siteMap.delete(route.serviceInstanceId);
      this.serviceToSite.delete(route.serviceInstanceId);
      await this.flushSiteDynamicFile(siteId, siteMap);
      return { configured: false, remainingSiteRoutes: siteMap.size };
    }

    const next = new Map(siteMap).set(route.serviceInstanceId, {
      serviceInstanceId: route.serviceInstanceId,
      containerName: assertSafeIdentifier(route.containerName, "containerName"),
      internalPort: route.internalPort,
      hosts: route.hosts,
    });
    // Validates every host before the cached routes change or any file is written.
    buildSiteDynamicTraefikYaml(siteId, [...next.values()], this.routeOptions);
    this.siteRoutes.set(siteId, next);
    this.serviceToSite.set(route.serviceInstanceId, siteId);

    await this.flushSiteDynamicFile(siteId, next);
    return { configured: true, remainingSiteRoutes: next.size };
  }

  public removeServiceRoute(
    serviceInstanceId: string,
    knownSiteId?: string,
  ): Promise<{ readonly siteId: string | null; readonly remainingSiteRoutes: number }> {
    return this.inSiteFileLine(() => this.removeServiceRouteNow(serviceInstanceId, knownSiteId));
  }

  private async removeServiceRouteNow(
    serviceInstanceId: string,
    knownSiteId?: string,
  ): Promise<{ readonly siteId: string | null; readonly remainingSiteRoutes: number }> {
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    const siteId = knownSiteId ?? this.serviceToSite.get(serviceInstanceId) ?? null;
    if (!siteId) {
      return { siteId: null, remainingSiteRoutes: 0 };
    }
    await this.loadDnsProviderState();

    const siteMap = await this.getOrHydrateSiteMap(siteId);
    siteMap.delete(serviceInstanceId);
    this.serviceToSite.delete(serviceInstanceId);
    await this.flushSiteDynamicFile(siteId, siteMap);
    return { siteId, remainingSiteRoutes: siteMap.size };
  }

  public removeSiteRoutes(siteId: string): Promise<void> {
    return this.inSiteFileLine(() => this.removeSiteRoutesNow(siteId));
  }

  private async removeSiteRoutesNow(siteId: string): Promise<void> {
    const filePath = this.getSiteDynamicFilePath(siteId);
    await this.loadDnsProviderState();
    for (const serviceId of (await this.getOrHydrateSiteMap(siteId)).keys()) {
      this.serviceToSite.delete(serviceId);
    }
    this.siteRoutes.delete(siteId);
    await rm(filePath, { force: true });
  }

  private async flushSiteDynamicFile(
    siteId: string,
    siteMap: Map<string, SiteIngressRouteEntry>,
  ): Promise<void> {
    const filePath = this.getSiteDynamicFilePath(siteId);
    if (siteMap.size === 0) {
      this.siteRoutes.delete(siteId);
      await rm(filePath, { force: true });
      return;
    }

    await mkdir(this.dynamicDirPath, { recursive: true, mode: 0o755 });
    const yaml = buildSiteDynamicTraefikYaml(siteId, [...siteMap.values()], this.routeOptions);
    await writeFileIfChanged(filePath, yaml, 0o644);
  }

  public getAppStackDynamicFilePath(stackId: string): string {
    assertAppStackId(stackId);
    return assertContainedPath(this.dynamicDirPath, path.join(this.dynamicDirPath, `app_${stackId}.yml`));
  }

  /** Validates before touching the file; [] removes it. changed: the bytes differed or the file was removed. */
  public writeAppStackRoutes(
    stackId: string,
    routes: readonly AppStackRouteEntry[],
  ): Promise<{ readonly changed: boolean; readonly hostnames: string[] }> {
    return this.inSiteFileLine(() => this.writeAppStackRoutesNow(stackId, routes));
  }

  private async writeAppStackRoutesNow(
    stackId: string,
    routes: readonly AppStackRouteEntry[],
  ): Promise<{ readonly changed: boolean; readonly hostnames: string[] }> {
    const filePath = this.getAppStackDynamicFilePath(stackId);
    await this.loadDnsProviderState();
    const yaml = buildAppStackDynamicTraefikYaml(stackId, routes, this.routeOptions);
    if (yaml === "") {
      return { changed: await this.removeAppStackFile(filePath), hostnames: [] };
    }
    const hostnames = routes.flatMap((route) => route.hosts.map((h) => h.hostname)).sort();
    // An unchanged file is not renamed: every rename reloads Traefik.
    if ((await readFile(filePath).catch(() => null))?.equals(Buffer.from(yaml))) {
      return { changed: false, hostnames };
    }
    await writeFileAtomically(filePath, yaml, 0o644);
    return { changed: true, hostnames };
  }

  /** True when a file existed. */
  public removeAppStackRoutes(stackId: string): Promise<boolean> {
    return this.inSiteFileLine(() => this.removeAppStackFile(this.getAppStackDynamicFilePath(stackId)));
  }

  private async removeAppStackFile(filePath: string): Promise<boolean> {
    const existed = (await lstat(filePath).catch(() => null)) !== null;
    await rm(filePath, { force: true });
    return existed;
  }

  /** [] when the file is absent. */
  public readAppStackRoutes(stackId: string): Promise<AppStackRouteEntry[]> {
    return this.inSiteFileLine(() => this.readAppStackRoutesNow(stackId));
  }

  private async readAppStackRoutesNow(stackId: string): Promise<AppStackRouteEntry[]> {
    const filePath = this.getAppStackDynamicFilePath(stackId);
    return parsePersistedAppStackRoutesFromYaml(await readFile(filePath, "utf8").catch(() => ""));
  }
}
