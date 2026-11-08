import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { VOLUME_SUFFIX_PATTERN, type ErrorCode } from "@hosting-panel/contracts";

export const INGRESS_PROXY_CONTAINER_NAME = "hp_ingress_proxy" as const;
export const INGRESS_BRIDGE_NETWORK_NAME = "hp_ingress_net" as const;
export const DEFAULT_TRAEFIK_IMAGE = "traefik:v3.3" as const;
export const DEFAULT_INGRESS_ROOT_DIR = "/var/lib/hosting-panel/ingress" as const;
export const DEFAULT_INGRESS_HTTP_PORT = 80 as const;

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

export function buildTraefikStaticYaml(): string {
  return [
    "# Managed by hp-docker-executor — Zero-Sock Static Configuration (HCP-SPEC-003 §4.2)",
    "api:",
    "  dashboard: false",
    "  insecure: false",
    "",
    "entryPoints:",
    "  web:",
    '    address: ":80"',
    "",
    "providers:",
    "  file:",
    '    directory: "/etc/traefik/dynamic"',
    "    watch: true",
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
  readonly staticConfigHostPath: string;
  readonly dynamicDirHostPath: string;
}

export interface DockerIngressProxyCreatePayload {
  readonly Image: string;
  readonly Cmd: readonly string[];
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
  };
}

export function buildIngressProxyContainerPayload(
  input: IngressProxyContainerConfigInput,
): DockerIngressProxyCreatePayload {
  const image = input.traefikImage ?? DEFAULT_TRAEFIK_IMAGE;
  const httpPort = input.httpHostPort ?? DEFAULT_INGRESS_HTTP_PORT;
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
    throw new ExecutorCodedError(
      "Ingress HTTP host port must be an integer between 1 and 65535",
      "VALIDATION_ERROR",
    );
  }

  if (
    input.staticConfigHostPath.includes("/var/run/docker.sock") ||
    input.dynamicDirHostPath.includes("/var/run/docker.sock")
  ) {
    throw new ExecutorCodedError(
      "Mounting docker.sock into ingress proxy is strictly forbidden (TH-02)",
      "HOST_POLICY_DENIED",
    );
  }

  return {
    Image: image,
    Cmd: ["--configFile=/etc/traefik/traefik.yml"],
    Labels: {
      "io.hostingpanel.managed": "true",
      "io.hostingpanel.role": "ingress_proxy",
    },
    ExposedPorts: {
      "80/tcp": {},
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
      },
      Binds: [
        `${input.staticConfigHostPath}:/etc/traefik/traefik.yml:ro`,
        `${input.dynamicDirHostPath}:/etc/traefik/dynamic:ro`,
      ],
    },
  };
}

export class TraefikIngressFileManager {
  public readonly ingressRootDir: string;
  public readonly staticConfigPath: string;
  public readonly dynamicDirPath: string;
  private readonly siteRoutes = new Map<string, Map<string, SiteIngressRouteEntry>>();
  private readonly serviceToSite = new Map<string, string>();

  public constructor(ingressRootDir: string = DEFAULT_INGRESS_ROOT_DIR) {
    this.ingressRootDir = path.resolve(ingressRootDir);
    this.staticConfigPath = path.join(this.ingressRootDir, "static", "traefik.yml");
    this.dynamicDirPath = path.join(this.ingressRootDir, "dynamic");
  }

  public getSiteDynamicFilePath(siteId: string): string {
    assertSafeIdentifier(siteId, "siteId");
    const candidate = path.join(this.dynamicDirPath, `site_${siteId}.yml`);
    return assertContainedPath(this.dynamicDirPath, candidate);
  }

  public async ensureStaticConfig(): Promise<{
    readonly staticConfigPath: string;
    readonly dynamicDirPath: string;
  }> {
    await mkdir(path.dirname(this.staticConfigPath), { recursive: true, mode: 0o755 });
    await mkdir(this.dynamicDirPath, { recursive: true, mode: 0o755 });
    const staticYaml = buildTraefikStaticYaml();

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
