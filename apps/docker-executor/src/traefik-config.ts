import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import path from "node:path";
import { VOLUME_SUFFIX_PATTERN, type ErrorCode } from "@hosting-panel/contracts";

export const INGRESS_PROXY_CONTAINER_NAME = "hp_ingress_proxy" as const;
export const INGRESS_BRIDGE_NETWORK_NAME = "hp_ingress_net" as const;
export const DEFAULT_TRAEFIK_IMAGE = "traefik:v3.7" as const;
export const DEFAULT_INGRESS_ROOT_DIR = "/var/lib/hosting-panel/ingress" as const;
export const DEFAULT_INGRESS_HTTP_PORT = 80 as const;
export const DEFAULT_INGRESS_HTTPS_PORT = 443 as const;
export const PANEL_DYNAMIC_FILE_NAME = "hp-panel.yml" as const;
export const STATIC_SHA256_LABEL = "io.hostingpanel.static_sha256" as const;
const ACME_EMAIL_PATTERN = /^[^\s@"'`\\]+@[^\s@"'`\\]+$/;

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

export interface SiteIngressRouteEntry {
  readonly serviceInstanceId: string;
  readonly containerName: string;
  readonly internalPort: number;
  readonly domains: readonly string[];
}

export interface PanelIngressConfig {
  readonly hostname: string;
  readonly ipv4: string;
  readonly acmeEmail: string | null;
  readonly acmeStaging: boolean;
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

export function buildTraefikStaticYaml(panel: PanelIngressConfig | null): string {
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
  ];
  if (panel?.acmeEmail) {
    lines.push(
      "certificatesResolvers:",
      "  le:",
      "    acme:",
      `      email: ${JSON.stringify(assertAcmeEmail(panel.acmeEmail))}`,
      "      storage: /etc/traefik/acme/acme.json",
      ...(panel.acmeStaging
        ? ["      caServer: https://acme-staging-v02.api.letsencrypt.org/directory"]
        : []),
      "      httpChallenge:",
      "        entryPoint: web",
      "",
    );
  }
  return lines.join("\n");
}

export function buildPanelDynamicYaml(panel: PanelIngressConfig): string {
  const hostname = assertSafeDomain(panel.hostname);
  const ipv4 = assertSafeDomain(panel.ipv4);
  if (!isIPv4(ipv4)) {
    throw new ExecutorCodedError("Panel IPv4 address is invalid", "VALIDATION_ERROR");
  }
  assertValidPort(panel.upstreamPort, "Panel upstream port");
  const tls = panel.acmeEmail
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

export function buildSiteDynamicTraefikYaml(
  siteId: string,
  routes: readonly SiteIngressRouteEntry[],
): string {
  assertSafeIdentifier(siteId, "siteId");

  const activeRoutes = routes
    .filter((route) => route.domains.length > 0)
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
      const normalizedDomains = route.domains.map((d) => assertSafeDomain(d));
      return {
        serviceInstanceId: route.serviceInstanceId,
        containerName: route.containerName,
        internalPort: route.internalPort,
        domains: normalizedDomains,
      };
    })
    .sort((a, b) => a.serviceInstanceId.localeCompare(b.serviceInstanceId));

  if (activeRoutes.length === 0) {
    return "";
  }

  const lines: string[] = [
    `# Managed by hp-docker-executor for site ${siteId} — DO NOT EDIT`,
  ];

  for (const route of activeRoutes) {
    lines.push(`# @hp-route ${JSON.stringify(route)}`);
  }

  lines.push("http:");
  lines.push("  routers:");
  for (const route of activeRoutes) {
    const key = sanitizeTraefikKey(route.serviceInstanceId);
    const hostRule = route.domains.map((domain) => `Host(\`${domain}\`)`).join(" || ");
    lines.push(`    router_${key}:`);
    lines.push("      entryPoints:");
    lines.push('        - "web"');
    lines.push(`      rule: "${hostRule}"`);
    lines.push(`      service: "svc_${key}"`);
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

function parsePersistedRoutesFromYaml(yamlContent: string): SiteIngressRouteEntry[] {
  const routes: SiteIngressRouteEntry[] = [];
  for (const line of yamlContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("# @hp-route ")) {
      continue;
    }
    const jsonPart = trimmed.slice("# @hp-route ".length);
    try {
      const parsed = JSON.parse(jsonPart) as Partial<SiteIngressRouteEntry>;
      if (
        typeof parsed.serviceInstanceId === "string" &&
        typeof parsed.containerName === "string" &&
        typeof parsed.internalPort === "number" &&
        Array.isArray(parsed.domains) &&
        parsed.domains.every((d): d is string => typeof d === "string")
      ) {
        routes.push({
          serviceInstanceId: parsed.serviceInstanceId,
          containerName: parsed.containerName,
          internalPort: parsed.internalPort,
          domains: parsed.domains,
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
}

export interface DockerIngressProxyCreatePayload {
  readonly Image: string;
  readonly Cmd: readonly string[];
  readonly User?: string;
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
    [input.staticConfigHostPath, input.dynamicDirHostPath, input.acmeDirHostPath].some((p) =>
      p.includes("docker.sock"),
    )
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
      ],
      ExtraHosts: ["host.docker.internal:host-gateway"],
    },
  };
}

export class TraefikIngressFileManager {
  public readonly ingressRootDir: string;
  public readonly staticConfigPath: string;
  public readonly dynamicDirPath: string;
  public readonly acmeDirPath: string;
  private readonly siteRoutes = new Map<string, Map<string, SiteIngressRouteEntry>>();
  private readonly serviceToSite = new Map<string, string>();

  public constructor(ingressRootDir: string = DEFAULT_INGRESS_ROOT_DIR) {
    this.ingressRootDir = path.resolve(ingressRootDir);
    this.staticConfigPath = path.join(this.ingressRootDir, "static", "traefik.yml");
    this.dynamicDirPath = path.join(this.ingressRootDir, "dynamic");
    this.acmeDirPath = path.join(this.ingressRootDir, "acme");
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
  }> {
    await mkdir(path.dirname(this.staticConfigPath), { recursive: true, mode: 0o755 });
    await mkdir(this.dynamicDirPath, { recursive: true, mode: 0o755 });
    await mkdir(this.acmeDirPath, { recursive: true, mode: 0o700 });
    await chmod(this.acmeDirPath, 0o700);
    // Traefik refuses an acme.json looser than 0600; "a" never truncates existing certificates.
    const acmeJsonPath = path.join(this.acmeDirPath, "acme.json");
    await (await open(acmeJsonPath, "a", 0o600)).close();
    await chmod(acmeJsonPath, 0o600);

    const panelFilePath = path.join(this.dynamicDirPath, PANEL_DYNAMIC_FILE_NAME);
    if (panel) {
      await writeFileAtomically(panelFilePath, buildPanelDynamicYaml(panel), 0o644, 0o755);
    } else {
      await rm(panelFilePath, { force: true });
    }

    const staticYaml = buildTraefikStaticYaml(panel);

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
    };
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

  public async upsertServiceRoute(
    siteId: string,
    route: SiteIngressRouteEntry,
  ): Promise<{ readonly configured: boolean; readonly remainingSiteRoutes: number }> {
    assertSafeIdentifier(siteId, "siteId");
    assertSafeIdentifier(route.serviceInstanceId, "serviceInstanceId");

    const previousSiteId = this.serviceToSite.get(route.serviceInstanceId);
    if (previousSiteId && previousSiteId !== siteId) {
      await this.removeServiceRoute(route.serviceInstanceId, previousSiteId);
    }

    const siteMap = await this.getOrHydrateSiteMap(siteId);
    if (route.domains.length === 0) {
      siteMap.delete(route.serviceInstanceId);
      this.serviceToSite.delete(route.serviceInstanceId);
      await this.flushSiteDynamicFile(siteId, siteMap);
      return { configured: false, remainingSiteRoutes: siteMap.size };
    }

    const normalizedDomains = route.domains.map((d) => assertSafeDomain(d));
    siteMap.set(route.serviceInstanceId, {
      serviceInstanceId: route.serviceInstanceId,
      containerName: assertSafeIdentifier(route.containerName, "containerName"),
      internalPort: route.internalPort,
      domains: normalizedDomains,
    });
    this.serviceToSite.set(route.serviceInstanceId, siteId);

    await this.flushSiteDynamicFile(siteId, siteMap);
    return { configured: true, remainingSiteRoutes: siteMap.size };
  }

  public async removeServiceRoute(
    serviceInstanceId: string,
    knownSiteId?: string,
  ): Promise<{ readonly siteId: string | null; readonly remainingSiteRoutes: number }> {
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    const siteId = knownSiteId ?? this.serviceToSite.get(serviceInstanceId) ?? null;
    if (!siteId) {
      return { siteId: null, remainingSiteRoutes: 0 };
    }

    const siteMap = await this.getOrHydrateSiteMap(siteId);
    siteMap.delete(serviceInstanceId);
    this.serviceToSite.delete(serviceInstanceId);
    await this.flushSiteDynamicFile(siteId, siteMap);
    return { siteId, remainingSiteRoutes: siteMap.size };
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
    const yaml = buildSiteDynamicTraefikYaml(siteId, [...siteMap.values()]);
    await writeFileAtomically(filePath, yaml, 0o644, 0o755);
  }
}
