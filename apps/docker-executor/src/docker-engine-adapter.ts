import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, rm, stat, unlink } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {
  DEFAULT_PHP_VERSION,
  SECRET_KEY_PATTERN,
  SHARED_MARIADB_IMAGE,
  findPlaintextSecretKeys,
  resolveWordpressCliImage,
  resolveWordpressImage,
  type PhpVersion,
  findUnsafeDockerInputFields,
  validateServiceVolumeMount,
  type ObservedServiceStateWire,
} from "@hosting-panel/contracts";
import {
  createApprovedServiceSpec,
  type ApprovedServiceSpec,
  type DockerExecutionResult,
  type DockerExecutorPort,
  type CertificateStatusReport,
  type SiteHostRoute,
  type SiteJobRequest,
  type SiteJobResult,
  type SiteRoutesRequest,
} from "@hosting-panel/executor-contracts";
import { parseAcmeFailures, readAcmeCertificates } from "./acme-status.js";
import { demuxDockerLogStream } from "./docker-logs.js";
import type { ObservedServiceState } from "@hosting-panel/hosting-domain";
import {
  DEFAULT_INGRESS_HTTP_PORT,
  DEFAULT_INGRESS_ROOT_DIR,
  DEFAULT_TRAEFIK_IMAGE,
  ExecutorCodedError,
  INGRESS_BRIDGE_NETWORK_NAME,
  INGRESS_PROXY_CONTAINER_NAME,
  STATIC_SHA256_LABEL,
  acmeStorageFileName,
  TraefikIngressFileManager,
  type PanelIngressConfig,
  assertContainedPath,
  assertSafeDomain,
  assertSafeIdentifier,
  assertSiteHostRoutes,
  siteRouteOptions,
  buildIngressProxyContainerPayload,
  getManagedVolumeName,
  getSiteEdgeNetworkName,
  getSiteInternalNetworkName,
  writeFileAtomically,
} from "./traefik-config.js";
import {
  DEFAULT_SHARED_DB_ADMIN_SUBNET,
  DEFAULT_SHARED_DB_DATA_DIR,
  DEFAULT_SHARED_DB_ROOT_KEY_FILE,
  SHARED_DB_ALIAS,
  SHARED_DB_CONFIG_SHA256_LABEL,
  SHARED_DB_CONTAINER_NAME,
  SHARED_DB_NETWORK_NAME,
  buildSharedDatabaseContainerPayload,
} from "./shared-database.js";
import {
  DEFAULT_SITE_JOB_TIMEOUT_MS,
  SITE_JOB_ROLE,
  assertValidSiteJobRequest,
  buildSiteJobContainerPayload,
  formatSiteJobOutputTail,
} from "./site-jobs.js";

export function plainHostRoute(hostname: string): SiteHostRoute {
  return { hostname, tls: false, httpsRedirect: false, redirectTo: null };
}

export const DEFAULT_DOCKER_SOCKET_PATH = "/var/run/docker.sock" as const;
export const DEFAULT_DOCKER_API_PREFIX = "/v1.45" as const;
/** GwPriority (Docker Engine 28+); the installer refuses older engines. */
export const INGRESS_PROXY_DOCKER_API_PREFIX = "/v1.48" as const;
export const DEFAULT_SECRETS_ROOT_DIR = "/run/hosting-panel/secrets" as const;
export const DEFAULT_PIDS_LIMIT = 256 as const;
export const DEFAULT_CPU_MILLI = 250 as const;
export const DEFAULT_MEMORY_BYTES = "268435456" as const;

export const CERTIFIED_SAFE_CAPABILITIES = [
  "CHOWN",
  "SETUID",
  "SETGID",
  "NET_BIND_SERVICE",
] as const;
export type CertifiedSafeCapability = (typeof CERTIFIED_SAFE_CAPABILITIES)[number];

const CERTIFIED_SAFE_CAPABILITIES_SET: ReadonlySet<string> = new Set(CERTIFIED_SAFE_CAPABILITIES);

export const FORBIDDEN_CAPABILITIES = [
  "SYS_ADMIN",
  "NET_ADMIN",
  "SYS_MODULE",
  "SYS_PTRACE",
  "DAC_READ_SEARCH",
] as const;

export const MANAGED_DOCKER_LABELS = Object.freeze({
  managed: "io.hostingpanel.managed",
  organizationId: "io.hostingpanel.organization_id",
  siteId: "io.hostingpanel.site_id",
  serviceInstanceId: "io.hostingpanel.service_instance_id",
  revisionNumber: "io.hostingpanel.revision_number",
  specHash: "io.hostingpanel.spec_hash",
} as const);

const STANDARD_MULTIUSER_IMAGE_PATTERN =
  /(?:^|\/)(?:nginx|httpd|apache2?|wordpress|php|postgres|postgresql|mariadb|mysql|redis|memcached)(?::|@|$)/i;

export interface DockerContainerInspectPayload {
  readonly Id: string;
  readonly Name?: string;
  readonly RestartCount?: number;
  readonly State?: {
    readonly Status?: string;
    readonly Running?: boolean;
    readonly Restarting?: boolean;
    readonly OOMKilled?: boolean;
    readonly Dead?: boolean;
    readonly ExitCode?: number;
    readonly Error?: string;
  };
  readonly Config?: {
    readonly Image?: string;
    readonly Cmd?: readonly string[] | null;
    readonly User?: string;
    readonly Env?: readonly string[];
    readonly Labels?: Readonly<Record<string, string>>;
  };
  readonly HostConfig?: {
    readonly Privileged?: boolean;
    readonly CapDrop?: readonly string[] | null;
    readonly CapAdd?: readonly string[] | null;
    readonly SecurityOpt?: readonly string[] | null;
    readonly PidsLimit?: number | null;
    readonly NanoCpus?: number;
    readonly Memory?: number;
    readonly MemorySwap?: number;
    readonly RestartPolicy?: { readonly Name?: string };
    readonly NetworkMode?: string;
    readonly Binds?: readonly string[] | null;
    readonly ExtraHosts?: readonly string[] | null;
    readonly LogConfig?: {
      readonly Type?: string;
      readonly Config?: Readonly<Record<string, string>> | null;
    } | null;
    readonly PortBindings?: Readonly<
      Record<string, readonly { readonly HostIp?: string; readonly HostPort?: string }[] | null>
    > | null;
  };
  readonly NetworkSettings?: {
    readonly Networks?: Readonly<Record<string, unknown>>;
  };
}

export interface HardenedContainerCreatePayload {
  readonly Image: string;
  readonly Env: readonly string[];
  readonly Labels: Readonly<Record<string, string>>;
  readonly ExposedPorts: Readonly<Record<string, Record<string, never>>>;
  readonly HostConfig: {
    readonly Privileged: false;
    readonly CapDrop: readonly ["ALL"];
    readonly CapAdd?: readonly CertifiedSafeCapability[];
    readonly SecurityOpt: readonly ["no-new-privileges:true"];
    readonly PidsLimit: number;
    readonly NanoCpus: number;
    readonly Memory: number;
    readonly MemorySwap: number;
    readonly RestartPolicy: { readonly Name: "unless-stopped" };
    readonly NetworkMode: string;
    readonly Binds: readonly string[];
    readonly PortBindings?: Readonly<
      Record<string, readonly { readonly HostIp: string; readonly HostPort: string }[]>
    >;
  };
  readonly NetworkingConfig: {
    readonly EndpointsConfig: Readonly<
      Record<string, { readonly Aliases: readonly string[] }>
    >;
  };
}

export interface ExecutorObservedServiceState extends ObservedServiceState {
  readonly serviceInstanceId: string;
  readonly observedStatus: string;
  readonly observedRevisionHash: string | null;
  readonly outOfBandModified: boolean;
  readonly observedAt: string;
  readonly restartCount: number;
  readonly internalDockerRef?: string;
}

export function validateCertifiedCapabilities(
  capabilities: readonly string[],
): readonly CertifiedSafeCapability[] {
  const deduplicated: CertifiedSafeCapability[] = [];
  const seen = new Set<string>();
  for (const rawCap of capabilities) {
    const normalized = rawCap.trim().toUpperCase().replace(/^CAP_/, "");
    if (!CERTIFIED_SAFE_CAPABILITIES_SET.has(normalized)) {
      throw new ExecutorCodedError(
        `Capability '${rawCap.slice(0, 32)}' is forbidden by container hardening policy (AC-F2-03)`,
        "HOST_POLICY_DENIED",
      );
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      deduplicated.push(normalized as CertifiedSafeCapability);
    }
  }
  return Object.freeze(deduplicated);
}

export function resolveDefaultSafeCapabilities(
  spec: ApprovedServiceSpec,
): readonly CertifiedSafeCapability[] {
  if (STANDARD_MULTIUSER_IMAGE_PATTERN.test(spec.image)) {
    return CERTIFIED_SAFE_CAPABILITIES;
  }

  const bindsPrivilegedPort =
    (spec.internalPort !== undefined && spec.internalPort <= 1024) ||
    spec.portBindings.some((pb) => pb.containerPort <= 1024);

  if (bindsPrivilegedPort) {
    return Object.freeze(["NET_BIND_SERVICE"] as const);
  }

  return Object.freeze([]);
}

export function isServiceHttpExposed(spec: ApprovedServiceSpec): boolean {
  return (
    Boolean(spec.exposeHttp) ||
    (spec.domains !== undefined && spec.domains.length > 0) ||
    (spec.hostRoutes !== undefined && spec.hostRoutes.length > 0)
  );
}

export function validateExecutorServiceSpec(
  input: ApprovedServiceSpec,
  reservedHosts: readonly string[] = [],
): ApprovedServiceSpec {
  if (!input || typeof input !== "object") {
    throw new ExecutorCodedError("Service specification must be an object", "VALIDATION_ERROR");
  }

  const rawRecord = input as unknown as Record<string, unknown>;
  const { resolvedSecrets: rawResolvedSecrets, __brand: _brand, ...declarativeFields } = rawRecord;

  const unsafeViolations = findUnsafeDockerInputFields(declarativeFields);
  if (unsafeViolations.length > 0) {
    throw new ExecutorCodedError(
      `Unsafe Docker attributes rejected by executor policy: ${unsafeViolations.join(", ")}`,
      "HOST_POLICY_DENIED",
    );
  }

  const plaintextSecretViolations = findPlaintextSecretKeys(declarativeFields);
  if (plaintextSecretViolations.length > 0) {
    throw new ExecutorCodedError(
      `Plaintext secret keys rejected by executor policy: ${plaintextSecretViolations.join(", ")}`,
      "HOST_POLICY_DENIED",
    );
  }

  assertSafeIdentifier(input.serviceInstanceId, "serviceInstanceId");
  assertSafeIdentifier(input.siteId, "siteId");
  assertSafeIdentifier(input.organizationId, "organizationId");
  assertSafeIdentifier(input.containerName, "containerName");

  if (
    input.containerName === INGRESS_PROXY_CONTAINER_NAME ||
    input.containerName.startsWith("hp_ingress_")
  ) {
    throw new ExecutorCodedError(
      "Container name collides with reserved platform ingress namespace",
      "HOST_POLICY_DENIED",
    );
  }

  if (input.volumeMounts !== undefined) {
    const seenTargets = new Set<string>();
    for (const mount of input.volumeMounts) {
      const check = validateServiceVolumeMount(mount);
      if (!check.valid) {
        throw new ExecutorCodedError(check.reason, "HOST_POLICY_DENIED");
      }
      const normalizedTarget = mount.containerPath.replace(/\/+/g, "/").replace(/\/+$/, "");
      if (seenTargets.has(normalizedTarget)) {
        throw new ExecutorCodedError(
          `Duplicate volume mount target '${normalizedTarget}'`,
          "HOST_POLICY_DENIED",
        );
      }
      seenTargets.add(normalizedTarget);
    }
  }

  if (input.domains !== undefined) {
    for (const domain of input.domains) {
      assertSafeDomain(domain);
    }
  }

  // Refused here, before any Docker call, so a bad plan never leaves a started site without a route.
  if (input.hostRoutes !== undefined) {
    assertSiteHostRoutes(input.hostRoutes, new Set(reservedHosts));
  }

  let validatedResolvedSecrets: Record<string, string> | undefined;
  if (rawResolvedSecrets !== undefined) {
    if (rawResolvedSecrets === null || typeof rawResolvedSecrets !== "object" || Array.isArray(rawResolvedSecrets)) {
      throw new ExecutorCodedError("Invalid resolvedSecrets structure", "HOST_POLICY_DENIED");
    }
    validatedResolvedSecrets = {};
    for (const [envName, secretVal] of Object.entries(rawResolvedSecrets as Record<string, unknown>)) {
      if (!SECRET_KEY_PATTERN.test(envName) || envName.endsWith("_FILE")) {
        throw new ExecutorCodedError(
          `Invalid secret environment variable identifier '${envName.slice(0, 48)}'`,
          "HOST_POLICY_DENIED",
        );
      }
      if (typeof secretVal !== "string" || secretVal.length === 0 || secretVal.length > 16384) {
        throw new ExecutorCodedError(
          `Invalid resolved secret value length for '${envName}'`,
          "HOST_POLICY_DENIED",
        );
      }
      validatedResolvedSecrets[envName] = secretVal;
    }
  }

  try {
    return createApprovedServiceSpec({
      serviceInstanceId: input.serviceInstanceId,
      siteId: input.siteId,
      organizationId: input.organizationId,
      image: input.image,
      containerName: input.containerName,
      env: { ...input.env },
      portBindings: input.portBindings.map((pb) => ({ ...pb })),
      resourceLimits: input.resourceLimits ? { ...input.resourceLimits } : null,
      revisionNumber: input.revisionNumber,
      specHash: input.specHash,
      domains: input.domains ? [...input.domains] : undefined,
      hostRoutes: input.hostRoutes ? [...input.hostRoutes] : undefined,
      exposeHttp: input.exposeHttp,
      internalPort: input.internalPort,
      pidsLimit: input.pidsLimit,
      volumeMounts: input.volumeMounts ? [...input.volumeMounts] : undefined,
      resolvedSecrets: validatedResolvedSecrets,
      rawConfig: declarativeFields,
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "HOST_POLICY_DENIED") {
      throw new ExecutorCodedError((err as Error).message, "HOST_POLICY_DENIED");
    }
    if (code === "VALIDATION_ERROR") {
      throw new ExecutorCodedError((err as Error).message, "VALIDATION_ERROR");
    }
    throw err;
  }
}

export async function overwriteAndUnlinkSecretFile(filePath: string): Promise<void> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return;
    }
    await chmod(filePath, 0o600);
    const zeroBuf = Buffer.alloc(Math.max(fileStat.size, 64), 0);
    const handle = await open(filePath, "r+");
    try {
      await handle.write(zeroBuf, 0, zeroBuf.length, 0);
      await handle.datasync().catch(() => undefined);
    } finally {
      await handle.close();
    }
    await unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      await unlink(filePath).catch(() => undefined);
    }
  }
}

export async function purgeServiceSecrets(
  secretsRootDir: string,
  serviceInstanceId: string,
): Promise<void> {
  assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
  const serviceDir = assertContainedPath(
    secretsRootDir,
    path.join(secretsRootDir, serviceInstanceId),
  );

  let entries;
  try {
    entries = await readdir(serviceDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }

  for (const entry of entries) {
    if (entry.isFile()) {
      const secretPath = assertContainedPath(serviceDir, path.join(serviceDir, entry.name));
      await overwriteAndUnlinkSecretFile(secretPath);
    }
  }

  await rm(serviceDir, { recursive: true, force: true });
}

export async function writeServiceSecrets(
  secretsRootDir: string,
  serviceInstanceId: string,
  resolvedSecrets: Readonly<Record<string, string>> | undefined,
): Promise<{
  readonly secretBinds: readonly string[];
  readonly secretFileEnv: readonly string[];
}> {
  assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
  const secretEntries = resolvedSecrets ? Object.entries(resolvedSecrets) : [];

  if (secretEntries.length === 0) {
    await purgeServiceSecrets(secretsRootDir, serviceInstanceId);
    return { secretBinds: [], secretFileEnv: [] };
  }

  await mkdir(secretsRootDir, { recursive: true, mode: 0o700 });
  await chmod(secretsRootDir, 0o700);
  const serviceDir = assertContainedPath(
    secretsRootDir,
    path.join(secretsRootDir, serviceInstanceId),
  );
  await mkdir(serviceDir, { recursive: true, mode: 0o700 });
  await chmod(serviceDir, 0o700);

  const desiredKeys = new Set(secretEntries.map(([envName]) => envName));
  const existingEntries = await readdir(serviceDir, { withFileTypes: true }).catch(() => []);
  for (const existing of existingEntries) {
    if (existing.isFile() && !desiredKeys.has(existing.name)) {
      const stalePath = assertContainedPath(serviceDir, path.join(serviceDir, existing.name));
      await overwriteAndUnlinkSecretFile(stalePath);
    }
  }

  const sortedEntries = [...secretEntries].sort(([a], [b]) => a.localeCompare(b));
  const secretBinds: string[] = [];
  const secretFileEnv: string[] = [];

  for (const [envName, secretValue] of sortedEntries) {
    if (!SECRET_KEY_PATTERN.test(envName) || envName.endsWith("_FILE")) {
      throw new ExecutorCodedError(
        `Invalid secret environment variable identifier '${envName.slice(0, 48)}'`,
        "HOST_POLICY_DENIED",
      );
    }

    const secretHostFilePath = assertContainedPath(serviceDir, path.join(serviceDir, envName));
    // Host traversal is strictly blocked by 0700 parent directories (secretsRootDir & serviceDir).
    // Leaf file uses 0444 so CapDrop=["ALL"] containers (no CAP_DAC_READ_SEARCH) running as
    // dedicated service UIDs (mysql/www-data/postgres/root) can read the :ro bind mount.
    await writeFileAtomically(
      secretHostFilePath,
      Buffer.from(secretValue, "utf8"),
      0o444,
      0o700,
    );

    const containerSecretPath = `/run/secrets/${envName}`;
    secretBinds.push(`${secretHostFilePath}:${containerSecretPath}:ro`);
    secretFileEnv.push(`${envName}_FILE=${containerSecretPath}`);
  }

  return {
    secretBinds: Object.freeze(secretBinds),
    secretFileEnv: Object.freeze(secretFileEnv),
  };
}

export interface BuildHardenedContainerOptions {
  readonly secretBinds?: readonly string[];
  readonly secretFileEnv?: readonly string[];
  readonly certifiedCapabilities?: readonly string[];
}

export function buildHardenedContainerCreatePayload(
  rawSpec: ApprovedServiceSpec,
  options?: BuildHardenedContainerOptions,
): HardenedContainerCreatePayload {
  const spec = validateExecutorServiceSpec(rawSpec);
  const siteNetworkName = getSiteInternalNetworkName(spec.siteId);

  const capAdd =
    options?.certifiedCapabilities !== undefined
      ? validateCertifiedCapabilities(options.certifiedCapabilities)
      : resolveDefaultSafeCapabilities(spec);

  const secretKeyNames = new Set(Object.keys(spec.resolvedSecrets ?? {}));
  const secretFileEnvKeys = new Set(Array.from(secretKeyNames, (key) => `${key}_FILE`));

  const envLines: string[] = [];
  const sortedEnvEntries = Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b));
  for (const [envKey, envValue] of sortedEnvEntries) {
    if (secretKeyNames.has(envKey) || secretFileEnvKeys.has(envKey)) {
      throw new ExecutorCodedError(
        `Environment variable '${envKey}' conflicts with managed tmpfs secret reference`,
        "HOST_POLICY_DENIED",
      );
    }
    envLines.push(`${envKey}=${envValue}`);
  }

  if (options?.secretFileEnv) {
    for (const fileEnvEntry of options.secretFileEnv) {
      envLines.push(fileEnvEntry);
    }
  } else if (spec.resolvedSecrets) {
    for (const envName of Object.keys(spec.resolvedSecrets).sort((a, b) => a.localeCompare(b))) {
      envLines.push(`${envName}_FILE=/run/secrets/${envName}`);
    }
  }

  const binds: string[] = [];
  if (spec.volumeMounts) {
    for (const mount of spec.volumeMounts) {
      const check = validateServiceVolumeMount(mount);
      if (!check.valid) {
        throw new ExecutorCodedError(check.reason, "HOST_POLICY_DENIED");
      }
      const volumeName = getManagedVolumeName(spec.serviceInstanceId, mount.volumeSuffix);
      const suffix = mount.readOnly ? ":ro" : "";
      binds.push(`${volumeName}:${mount.containerPath}${suffix}`);
    }
  }

  if (options?.secretBinds) {
    for (const secretBind of options.secretBinds) {
      if (!secretBind.endsWith(":ro") || secretBind.includes("/var/run/docker.sock")) {
        throw new ExecutorCodedError(
          "Secret bind mounts must be read-only and confined to tmpfs secrets directory",
          "HOST_POLICY_DENIED",
        );
      }
      binds.push(secretBind);
    }
  }

  const exposedPorts: Record<string, Record<string, never>> = {};
  if (spec.internalPort !== undefined) {
    exposedPorts[`${String(spec.internalPort)}/tcp`] = {};
  } else if (isServiceHttpExposed(spec) && spec.portBindings.length === 0) {
    exposedPorts["80/tcp"] = {};
  }
  const portBindingsMap: Record<string, { HostIp: string; HostPort: string }[]> = {};
  for (const pb of spec.portBindings) {
    const portKey = `${String(pb.containerPort)}/tcp`;
    exposedPorts[portKey] = {};
    if (pb.hostPort !== undefined) {
      const list = portBindingsMap[portKey] ?? [];
      list.push({ HostIp: "127.0.0.1", HostPort: String(pb.hostPort) });
      portBindingsMap[portKey] = list;
    }
  }

  const cpuMilli = spec.resourceLimits?.cpuMilli ?? DEFAULT_CPU_MILLI;
  const memoryBytesNum = Number(spec.resourceLimits?.memoryBytes ?? DEFAULT_MEMORY_BYTES);
  if (!Number.isFinite(memoryBytesNum) || memoryBytesNum <= 0) {
    throw new ExecutorCodedError("Invalid memoryBytes limit", "VALIDATION_ERROR");
  }

  const pidsLimit = spec.pidsLimit ?? DEFAULT_PIDS_LIMIT;

  return {
    Image: spec.image,
    Env: envLines,
    Labels: {
      [MANAGED_DOCKER_LABELS.managed]: "true",
      [MANAGED_DOCKER_LABELS.organizationId]: spec.organizationId,
      [MANAGED_DOCKER_LABELS.siteId]: spec.siteId,
      [MANAGED_DOCKER_LABELS.serviceInstanceId]: spec.serviceInstanceId,
      [MANAGED_DOCKER_LABELS.revisionNumber]: String(spec.revisionNumber ?? 1),
      [MANAGED_DOCKER_LABELS.specHash]: spec.specHash ?? "",
    },
    ExposedPorts: exposedPorts,
    HostConfig: {
      Privileged: false,
      CapDrop: ["ALL"],
      ...(capAdd.length > 0 ? { CapAdd: capAdd } : {}),
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: pidsLimit,
      NanoCpus: cpuMilli * 1_000_000,
      Memory: memoryBytesNum,
      MemorySwap: memoryBytesNum,
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: siteNetworkName,
      Binds: binds,
      ...(Object.keys(portBindingsMap).length > 0 ? { PortBindings: portBindingsMap } : {}),
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [siteNetworkName]: {
          Aliases: [spec.containerName],
        },
      },
    },
  };
}

export interface ExpectedManagedServiceMetadata {
  readonly serviceInstanceId: string;
  readonly siteId: string;
  readonly organizationId: string;
  readonly image: string;
  readonly containerName: string;
  readonly specHash: string;
  readonly revisionNumber: number;
  readonly expectedEnv: readonly string[];
}

export function detectOutOfBandContainerModification(
  inspect: DockerContainerInspectPayload,
  serviceInstanceId: string,
  secretsRootDir: string,
  expected?: ExpectedManagedServiceMetadata,
): boolean {
  const labels = inspect.Config?.Labels ?? {};
  const managedFlag = labels[MANAGED_DOCKER_LABELS.managed];
  const labeledServiceId = labels[MANAGED_DOCKER_LABELS.serviceInstanceId];
  const orgId = labels[MANAGED_DOCKER_LABELS.organizationId];
  const siteId = labels[MANAGED_DOCKER_LABELS.siteId];

  if (
    managedFlag !== "true" ||
    labeledServiceId !== serviceInstanceId ||
    !orgId ||
    !siteId
  ) {
    return true;
  }

  let expectedNetwork: string;
  try {
    expectedNetwork = getSiteInternalNetworkName(siteId);
  } catch {
    return true;
  }

  const hostConfig = inspect.HostConfig;
  if (!hostConfig) {
    return true;
  }

  if (hostConfig.Privileged !== false) {
    return true;
  }

  const capDrop = hostConfig.CapDrop ?? [];
  if (!capDrop.some((c) => c === "ALL" || c === "CAP_ALL")) {
    return true;
  }

  const capAdd = hostConfig.CapAdd ?? [];
  for (const cap of capAdd) {
    const normalized = cap.toUpperCase().replace(/^CAP_/, "");
    if (!CERTIFIED_SAFE_CAPABILITIES_SET.has(normalized)) {
      return true;
    }
  }

  const securityOpt = hostConfig.SecurityOpt ?? [];
  if (!securityOpt.includes("no-new-privileges:true")) {
    return true;
  }

  if (
    typeof hostConfig.PidsLimit !== "number" ||
    hostConfig.PidsLimit < 16 ||
    hostConfig.PidsLimit > 4096
  ) {
    return true;
  }

  if (hostConfig.RestartPolicy?.Name !== "unless-stopped") {
    return true;
  }

  if (hostConfig.NetworkMode !== expectedNetwork) {
    return true;
  }

  const allowedVolumePrefix = `hp_vol_${serviceInstanceId}_`;
  const allowedSecretDirPrefix = `${path.resolve(secretsRootDir, serviceInstanceId)}${path.sep}`;
  for (const bind of hostConfig.Binds ?? []) {
    if (bind.includes("/var/run/docker.sock")) {
      return true;
    }
    if (bind.startsWith(allowedVolumePrefix)) {
      continue;
    }
    if (
      bind.startsWith(allowedSecretDirPrefix) &&
      bind.includes(":/run/secrets/") &&
      bind.endsWith(":ro")
    ) {
      continue;
    }
    return true;
  }

  const envMap: Record<string, string> = {};
  for (const entry of inspect.Config?.Env ?? []) {
    const eqIndex = entry.indexOf("=");
    if (eqIndex > 0) {
      envMap[entry.slice(0, eqIndex)] = entry.slice(eqIndex + 1);
    }
  }
  if (findPlaintextSecretKeys({ env: envMap }).length > 0) {
    return true;
  }

  if (expected) {
    if (inspect.Config?.Image !== expected.image) {
      return true;
    }
    if ((labels[MANAGED_DOCKER_LABELS.specHash] ?? "") !== expected.specHash) {
      return true;
    }
    if (
      (labels[MANAGED_DOCKER_LABELS.revisionNumber] ?? "") !== String(expected.revisionNumber)
    ) {
      return true;
    }
  }

  return false;
}

export function mapContainerStateToObservedStatus(
  state: DockerContainerInspectPayload["State"],
): string {
  if (!state) {
    return "unknown";
  }
  if (state.Dead || state.Restarting || state.OOMKilled) {
    return "degraded";
  }
  if (state.Running === true) {
    return "running";
  }
  if (
    state.Status === "exited" ||
    state.Status === "stopped" ||
    state.Status === "created" ||
    state.Running === false
  ) {
    return "stopped";
  }
  return state.Status ?? "unknown";
}

interface DockerHttpResponse {
  readonly statusCode: number;
  readonly body: Buffer;
}

const PULL_TIMEOUT_MS = 240_000;

class DockerSocketHttpClient {
  private readonly socketPath: string;
  private readonly apiPrefix: string;
  private readonly timeoutMs: number;
  private useUnversionedFallback = false;

  public constructor(options: {
    readonly socketPath: string;
    readonly apiPrefix?: string;
    readonly timeoutMs?: number;
  }) {
    this.socketPath = options.socketPath;
    this.apiPrefix = options.apiPrefix ?? DEFAULT_DOCKER_API_PREFIX;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  public async request(
    method: string,
    endpointPath: string,
    jsonBody?: unknown,
    options?: { readonly timeoutMs?: number; readonly apiPrefix?: string },
  ): Promise<DockerHttpResponse> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    if (options?.apiPrefix !== undefined) {
      // A pinned version must fail on an older engine, never fall back and drop the new fields.
      return this.rawRequest(method, `${options.apiPrefix}${endpointPath}`, jsonBody, timeoutMs);
    }
    const primaryPrefix = this.useUnversionedFallback ? "" : this.apiPrefix;
    const response = await this.rawRequest(
      method,
      `${primaryPrefix}${endpointPath}`,
      jsonBody,
      timeoutMs,
    );

    if (
      !this.useUnversionedFallback &&
      primaryPrefix.length > 0 &&
      (response.statusCode === 400 || (endpointPath === "/_ping" && response.statusCode === 404))
    ) {
      const text = response.body.toString("utf8").toLowerCase();
      if (
        endpointPath === "/_ping" ||
        text.includes("client version") ||
        text.includes("api version") ||
        text.includes("too new") ||
        text.includes("too old")
      ) {
        const fallbackResponse = await this.rawRequest(method, endpointPath, jsonBody, timeoutMs);
        if (fallbackResponse.statusCode < 500 && fallbackResponse.statusCode !== 404) {
          this.useUnversionedFallback = true;
          return fallbackResponse;
        }
      }
    }

    return response;
  }

  private rawRequest(
    method: string,
    fullPath: string,
    jsonBody: unknown,
    timeoutMs: number,
  ): Promise<DockerHttpResponse> {
    const serializedBody =
      jsonBody !== undefined ? Buffer.from(JSON.stringify(jsonBody), "utf8") : undefined;

    const headers: Record<string, string | number> = {
      Accept: "application/json",
      Host: "docker",
    };
    if (serializedBody !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = serializedBody.length;
    }

    return new Promise<DockerHttpResponse>((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          path: fullPath,
          method,
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer | string) => {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          });
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode ?? 500,
              body: Buffer.concat(chunks),
            });
          });
          res.on("error", () => {
            reject(
              new ExecutorCodedError(
                "Failed while reading response from Docker Engine",
                "DOCKER_ENGINE_UNAVAILABLE",
              ),
            );
          });
        },
      );

      req.on("timeout", () => {
        req.destroy();
        reject(
          new ExecutorCodedError(
            "Docker Engine socket request timed out",
            "DOCKER_ENGINE_UNAVAILABLE",
          ),
        );
      });

      req.on("error", () => {
        reject(
          new ExecutorCodedError(
            "Docker Engine daemon is unreachable",
            "DOCKER_ENGINE_UNAVAILABLE",
          ),
        );
      });

      if (serializedBody !== undefined) {
        req.write(serializedBody);
      }
      req.end();
    });
  }
}

export interface DockerEngineSocketAdapterOptions {
  readonly dockerSocketPath?: string;
  readonly dockerApiPrefix?: string;
  readonly secretsRootDir?: string;
  readonly ingressRootDir?: string;
  readonly traefikImage?: string;
  readonly ingressHttpPort?: number;
  readonly ingressHttpsPort?: number;
  /** null/undefined ⇒ panel ingress disabled. */
  readonly panel?: PanelIngressConfig | null;
  readonly requestTimeoutMs?: number;
  readonly pullMissingImages?: boolean;
  readonly sharedDbDataDir?: string;
  readonly sharedDbRootKeyFile?: string;
  readonly sharedDbAdminSubnet?: string;
  /** The uid the data dir must NOT be owned by; defaults to process.getuid(). */
  readonly executorUid?: number;
  /** Site job wait budget; on expiry the job is killed and reports exit 124. */
  readonly jobTimeoutMs?: number;
}

type SharedDatabaseEnsureResult = {
  readonly component: "shared_database";
  readonly status: "running";
};

type IngressEnsureResult = {
  readonly component: "ingress_proxy";
  readonly status: "running";
  readonly ensuredAt: string;
};

interface DockerContainerListSummary {
  readonly Id: string;
  readonly Names?: readonly string[];
  readonly Labels?: Readonly<Record<string, string>>;
}

export class DockerEngineSocketAdapter implements DockerExecutorPort {
  public readonly isRuntimeAvailable = true;
  private readonly dockerClient: DockerSocketHttpClient;
  private readonly secretsRootDir: string;
  private readonly ingressManager: TraefikIngressFileManager;
  private readonly traefikImage: string;
  private readonly ingressHttpPort: number;
  private readonly ingressHttpsPort: number | undefined;
  private readonly panel: PanelIngressConfig | null;
  private readonly pullMissingImages: boolean;
  private readonly expectedMetadata = new Map<string, ExpectedManagedServiceMetadata>();
  private ingressEnsureInFlight: Promise<IngressEnsureResult> | null = null;
  private readonly sharedDbDataDir: string;
  private readonly sharedDbRootKeyFile: string;
  private readonly sharedDbAdminSubnet: string;
  private readonly executorUid: number | undefined;
  private sharedDbEnsureInFlight: Promise<SharedDatabaseEnsureResult> | null = null;
  private readonly jobTimeoutMs: number;
  /** `siteId:kind` of the site jobs running now. */
  private readonly runningSiteJobs = new Set<string>();

  public constructor(options?: DockerEngineSocketAdapterOptions) {
    this.dockerClient = new DockerSocketHttpClient({
      socketPath: options?.dockerSocketPath ?? DEFAULT_DOCKER_SOCKET_PATH,
      apiPrefix: options?.dockerApiPrefix ?? DEFAULT_DOCKER_API_PREFIX,
      timeoutMs: options?.requestTimeoutMs ?? 30_000,
    });
    this.secretsRootDir = path.resolve(options?.secretsRootDir ?? DEFAULT_SECRETS_ROOT_DIR);
    this.ingressManager = new TraefikIngressFileManager(
      options?.ingressRootDir ?? DEFAULT_INGRESS_ROOT_DIR,
      options?.panel ?? null,
    );
    this.traefikImage = options?.traefikImage ?? DEFAULT_TRAEFIK_IMAGE;
    this.ingressHttpPort = options?.ingressHttpPort ?? DEFAULT_INGRESS_HTTP_PORT;
    this.ingressHttpsPort = options?.ingressHttpsPort;
    this.panel = options?.panel ?? null;
    this.pullMissingImages = options?.pullMissingImages ?? true;
    this.sharedDbDataDir = path.resolve(options?.sharedDbDataDir ?? DEFAULT_SHARED_DB_DATA_DIR);
    this.sharedDbRootKeyFile = path.resolve(
      options?.sharedDbRootKeyFile ?? DEFAULT_SHARED_DB_ROOT_KEY_FILE,
    );
    this.sharedDbAdminSubnet = options?.sharedDbAdminSubnet ?? DEFAULT_SHARED_DB_ADMIN_SUBNET;
    this.executorUid = options?.executorUid ?? process.getuid?.();
    this.jobTimeoutMs = options?.jobTimeoutMs ?? DEFAULT_SITE_JOB_TIMEOUT_MS;
  }

  public async pingEngine(): Promise<boolean> {
    try {
      const res = await this.dockerClient.request("GET", "/_ping");
      return res.statusCode === 200;
    } catch {
      return false;
    }
  }

  /** Serialised: concurrent callers (startup, IPC, deployService) share one run, so drift never triggers two recreates. */
  public ensureIngressProxy(): Promise<IngressEnsureResult> {
    this.ingressEnsureInFlight ??= this.ensureIngressProxyOnce().finally(() => {
      this.ingressEnsureInFlight = null;
    });
    return this.ingressEnsureInFlight;
  }

  private async ensureIngressProxyOnce(): Promise<IngressEnsureResult> {
    const { staticConfigPath, dynamicDirPath, acmeDirPath, staticSha256 } =
      await this.ingressManager.ensureStaticConfig(this.panel);

    await this.ensureNetwork(INGRESS_BRIDGE_NETWORK_NAME, {
      internal: false,
      labels: {
        [MANAGED_DOCKER_LABELS.managed]: "true",
        "io.hostingpanel.network_role": "ingress_public",
      },
    });

    await this.ensureImageAvailable(this.traefikImage);

    const existing = await this.inspectContainerByNameOrId(INGRESS_PROXY_CONTAINER_NAME);
    const payload = buildIngressProxyContainerPayload({
      traefikImage: this.traefikImage,
      httpHostPort: this.ingressHttpPort,
      ...(this.ingressHttpsPort !== undefined ? { httpsHostPort: this.ingressHttpsPort } : {}),
      staticConfigHostPath: staticConfigPath,
      dynamicDirHostPath: dynamicDirPath,
      acmeDirHostPath: acmeDirPath,
      staticSha256,
      // Same uid:gid as the executor, so the proxy can read hp-executor-owned dirs without DAC caps.
      ...(process.getuid && process.getgid
        ? { user: `${String(process.getuid())}:${String(process.getgid())}` }
        : {}),
    });

    const createIngressProxy = async (): Promise<string> => {
      const createRes = await this.dockerClient.request(
        "POST",
        `/containers/create?name=${encodeURIComponent(INGRESS_PROXY_CONTAINER_NAME)}`,
        payload,
        { apiPrefix: INGRESS_PROXY_DOCKER_API_PREFIX },
      );
      if (createRes.statusCode !== 201) {
        throw new ExecutorCodedError(
          `Failed to create managed ingress proxy container (HTTP ${String(createRes.statusCode)}; needs Docker Engine 28+)`,
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }
      const parsed = JSON.parse(createRes.body.toString("utf8")) as { Id: string };
      return parsed.Id;
    };

    const existingBinds = existing?.HostConfig?.Binds ?? [];
    // Order-insensitive so an unchanged proxy is never recreated (CP-01: keep sites serving).
    const sortedJson = (list: readonly string[] | null | undefined): string =>
      JSON.stringify([...(list ?? [])].sort());
    const portBindingsKey = (
      bindings: NonNullable<DockerContainerInspectPayload["HostConfig"]>["PortBindings"],
    ): string =>
      sortedJson(
        Object.entries(bindings ?? {}).flatMap(([port, list]) =>
          (list ?? []).map((b) => `${port}|${b.HostIp ?? ""}|${b.HostPort ?? ""}`),
        ),
      );
    const configDrift =
      existing !== null &&
      (existing.Config?.Image !== payload.Image ||
        JSON.stringify(existing.Config?.Cmd ?? []) !== JSON.stringify(payload.Cmd) ||
        (existing.Config?.User ?? "") !== (payload.User ?? "") ||
        existing.Config?.Labels?.[STATIC_SHA256_LABEL] !== staticSha256 ||
        sortedJson(existingBinds) !== sortedJson(payload.HostConfig.Binds) ||
        sortedJson(existing.HostConfig?.ExtraHosts) !== sortedJson(payload.HostConfig.ExtraHosts) ||
        existing.HostConfig?.LogConfig?.Type !== payload.HostConfig.LogConfig.Type ||
        sortedJson(Object.entries(existing.HostConfig?.LogConfig?.Config ?? {}).map(String)) !==
          sortedJson(Object.entries(payload.HostConfig.LogConfig.Config).map(String)) ||
        (
          existing.NetworkSettings?.Networks?.[INGRESS_BRIDGE_NETWORK_NAME] as
            | { readonly GwPriority?: number }
            | undefined
        )?.GwPriority !== 1 ||
        portBindingsKey(existing.HostConfig?.PortBindings) !==
          portBindingsKey(payload.HostConfig.PortBindings));

    const brokenMountState =
      existing?.State?.Dead === true ||
      existing?.State?.ExitCode === 127 ||
      (typeof existing?.State?.Error === "string" && existing.State.Error.trim().length > 0);

    const needsRecreate =
      existing !== null &&
      (existing.HostConfig?.Privileged !== false ||
        existingBinds.some((b) => b.includes("/var/run/docker.sock")) ||
        configDrift ||
        brokenMountState);

    if (existing && needsRecreate) {
      await this.stopAndRemoveContainer(existing.Id);
    }

    let proxyId = !existing || needsRecreate ? await createIngressProxy() : existing.Id;

    if (!existing || needsRecreate || existing.State?.Running !== true) {
      let startRes = await this.dockerClient.request("POST", `/containers/${proxyId}/start`);
      if (startRes.statusCode !== 204 && startRes.statusCode !== 304 && existing && !needsRecreate) {
        // Self-heal stale stopped ingress container whose mount inode was invalidated
        await this.stopAndRemoveContainer(proxyId);
        await this.ingressManager.ensureStaticConfig(this.panel);
        proxyId = await createIngressProxy();
        startRes = await this.dockerClient.request("POST", `/containers/${proxyId}/start`);
      }
      if (startRes.statusCode !== 204 && startRes.statusCode !== 304) {
        throw new ExecutorCodedError(
          `Failed to start managed ingress proxy container (HTTP ${String(startRes.statusCode)})`,
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }
    }

    // A new proxy starts on hp_ingress_net only, and a site edge network may have been detached
    // while the proxy kept running: reattach every one on each ensure (idempotent, CP-01).
    await this.reconnectProxyToSiteEdgeNetworks();

    return {
      component: "ingress_proxy",
      status: "running",
      ensuredAt: new Date().toISOString(),
    };
  }

  /** Serialised like ensureIngressProxy. Called at executor start, never by jobs (they must not pull). */
  public ensureSharedDatabase(): Promise<SharedDatabaseEnsureResult> {
    this.sharedDbEnsureInFlight ??= this.ensureSharedDatabaseOnce().finally(() => {
      this.sharedDbEnsureInFlight = null;
    });
    return this.sharedDbEnsureInFlight;
  }

  /** Cheap check for db.* jobs: fail fast instead of pulling or creating anything. */
  public async isSharedDatabaseRunning(): Promise<boolean> {
    const existing = await this.inspectContainerByNameOrId(SHARED_DB_CONTAINER_NAME);
    return existing?.State?.Running === true;
  }

  private async ensureSharedDatabaseOnce(): Promise<SharedDatabaseEnsureResult> {
    // Docker Binds would create a missing source as a root-owned directory: insist on bootstrap's.
    const keyStat = await stat(this.sharedDbRootKeyFile).catch(() => null);
    const dataStat = await stat(this.sharedDbDataDir).catch(() => null);
    if (
      !keyStat?.isFile() ||
      !dataStat?.isDirectory() ||
      dataStat.uid === 0 ||
      dataStat.uid === this.executorUid
    ) {
      throw new ExecutorCodedError(
        "Shared database key file or data directory is missing or unsafe. Run bootstrap first",
        "HOST_POLICY_DENIED",
      );
    }

    await this.ensureNetwork(SHARED_DB_NETWORK_NAME, {
      internal: true,
      subnet: this.sharedDbAdminSubnet,
      labels: {
        [MANAGED_DOCKER_LABELS.managed]: "true",
        "io.hostingpanel.network_role": "shared_database",
      },
    });

    const payload = buildSharedDatabaseContainerPayload({
      user: `${String(dataStat.uid)}:${String(dataStat.gid)}`,
      dataDirHostPath: this.sharedDbDataDir,
      rootKeyHostPath: this.sharedDbRootKeyFile,
      adminSubnet: this.sharedDbAdminSubnet,
    });
    await this.ensureImageAvailable(payload.Image);

    const existing = await this.inspectContainerByNameOrId(SHARED_DB_CONTAINER_NAME);
    // Only the label: Config.Env also holds the image's ENV, so comparing it would recreate on every start (CP-01).
    const needsRecreate =
      existing !== null &&
      existing.Config?.Labels?.[SHARED_DB_CONFIG_SHA256_LABEL] !==
        payload.Labels[SHARED_DB_CONFIG_SHA256_LABEL];
    if (existing && needsRecreate) {
      await this.stopAndRemoveContainer(existing.Id);
    }

    let containerId = existing?.Id ?? "";
    if (!existing || needsRecreate) {
      const createRes = await this.dockerClient.request(
        "POST",
        `/containers/create?name=${encodeURIComponent(SHARED_DB_CONTAINER_NAME)}`,
        payload,
      );
      if (createRes.statusCode !== 201) {
        throw new ExecutorCodedError(
          `Failed to create shared database container (HTTP ${String(createRes.statusCode)})`,
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }
      containerId = (JSON.parse(createRes.body.toString("utf8")) as { Id: string }).Id;
    }

    if (!existing || needsRecreate || existing.State?.Running !== true) {
      const startRes = await this.dockerClient.request("POST", `/containers/${containerId}/start`);
      if (startRes.statusCode !== 204 && startRes.statusCode !== 304) {
        throw new ExecutorCodedError(
          `Failed to start shared database container (HTTP ${String(startRes.statusCode)})`,
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }
    }

    // A new container starts on hp_mariadb_net only: reattach every site network (idempotent).
    await this.reconnectToRoleNetworks("site_internal", SHARED_DB_CONTAINER_NAME, [SHARED_DB_ALIAS]);

    return { component: "shared_database", status: "running" };
  }

  public async deployService(rawSpec: ApprovedServiceSpec): Promise<DockerExecutionResult> {
    const spec = validateExecutorServiceSpec(rawSpec, siteRouteOptions(this.panel).reservedHosts);
    const httpExposed = isServiceHttpExposed(spec);
    const hasHostPort = spec.portBindings.some((pb) => pb.hostPort !== undefined);

    await this.ensureImageAvailable(spec.image);

    const siteNetworkName = getSiteInternalNetworkName(spec.siteId);
    await this.ensureNetwork(siteNetworkName, {
      internal: !hasHostPort,
      labels: {
        [MANAGED_DOCKER_LABELS.managed]: "true",
        [MANAGED_DOCKER_LABELS.siteId]: spec.siteId,
        "io.hostingpanel.network_role": "site_internal",
      },
    });
    // 404 = hp_mariadb not created yet; ensureSharedDatabase attaches it later.
    await this.connectContainerToNetwork(
      siteNetworkName,
      SHARED_DB_CONTAINER_NAME,
      [SHARED_DB_ALIAS],
      { skipMissingNetwork: true },
    );

    if (spec.volumeMounts) {
      for (const mount of spec.volumeMounts) {
        const volumeName = getManagedVolumeName(spec.serviceInstanceId, mount.volumeSuffix);
        await this.ensureVolume(volumeName, spec.siteId, spec.serviceInstanceId);
      }
    }

    const { secretBinds, secretFileEnv } = await writeServiceSecrets(
      this.secretsRootDir,
      spec.serviceInstanceId,
      spec.resolvedSecrets,
    );

    const createPayload = buildHardenedContainerCreatePayload(spec, {
      secretBinds,
      secretFileEnv,
    });

    const existingByService = await this.findContainerSummaryByServiceId(spec.serviceInstanceId);
    if (existingByService) {
      await this.stopAndRemoveContainer(existingByService.Id);
    }

    const existingByName = await this.inspectContainerByNameOrId(spec.containerName);
    if (existingByName) {
      const ownerServiceId =
        existingByName.Config?.Labels?.[MANAGED_DOCKER_LABELS.serviceInstanceId];
      if (ownerServiceId && ownerServiceId !== spec.serviceInstanceId) {
        throw new ExecutorCodedError(
          "Target container name is already bound to another service instance",
          "RESOURCE_LOCKED",
        );
      }
      if (!ownerServiceId) {
        throw new ExecutorCodedError(
          "Target container name collides with an unmanaged container",
          "HOST_POLICY_DENIED",
        );
      }
      await this.stopAndRemoveContainer(existingByName.Id);
    }

    const createRes = await this.dockerClient.request(
      "POST",
      `/containers/create?name=${encodeURIComponent(spec.containerName)}`,
      createPayload,
    );
    if (createRes.statusCode !== 201) {
      throw new ExecutorCodedError(
        `Docker Engine failed to create service container (HTTP ${String(createRes.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }

    const created = JSON.parse(createRes.body.toString("utf8")) as { Id: string };

    if (httpExposed) {
      const edgeNetworkName = getSiteEdgeNetworkName(spec.siteId);
      await this.ensureNetwork(edgeNetworkName, {
        internal: false,
        labels: {
          [MANAGED_DOCKER_LABELS.managed]: "true",
          [MANAGED_DOCKER_LABELS.siteId]: spec.siteId,
          "io.hostingpanel.network_role": "site_edge",
        },
      });
      await this.connectContainerToNetwork(edgeNetworkName, created.Id, [spec.containerName]);
    }

    const startRes = await this.dockerClient.request("POST", `/containers/${created.Id}/start`);
    if (startRes.statusCode !== 204 && startRes.statusCode !== 304) {
      throw new ExecutorCodedError(
        `Docker Engine failed to start service container (HTTP ${String(startRes.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }

    let ingressConfigured = false;
    const hosts: readonly SiteHostRoute[] =
      spec.hostRoutes ?? (spec.domains ?? []).map(plainHostRoute);
    if (hosts.length > 0) {
      await this.ensureIngressProxy();
      const edgeNetworkName = getSiteEdgeNetworkName(spec.siteId);
      await this.connectContainerToNetwork(edgeNetworkName, INGRESS_PROXY_CONTAINER_NAME);

      const effectiveInternalPort =
        spec.internalPort ?? spec.portBindings[0]?.containerPort ?? 80;

      const routeResult = await this.ingressManager.upsertServiceRoute(spec.siteId, {
        serviceInstanceId: spec.serviceInstanceId,
        containerName: spec.containerName,
        internalPort: effectiveInternalPort,
        hosts,
      });
      ingressConfigured = routeResult.configured;
    } else {
      const routeRemoval = await this.ingressManager.removeServiceRoute(
        spec.serviceInstanceId,
        spec.siteId,
      );
      if (routeRemoval.siteId && routeRemoval.remainingSiteRoutes === 0) {
        const edgeNetworkName = getSiteEdgeNetworkName(routeRemoval.siteId);
        await this.disconnectContainerFromNetwork(
          edgeNetworkName,
          INGRESS_PROXY_CONTAINER_NAME,
        ).catch(() => undefined);
      }
    }

    this.expectedMetadata.set(spec.serviceInstanceId, {
      serviceInstanceId: spec.serviceInstanceId,
      siteId: spec.siteId,
      organizationId: spec.organizationId,
      image: spec.image,
      containerName: spec.containerName,
      specHash: spec.specHash ?? "",
      revisionNumber: spec.revisionNumber ?? 1,
      expectedEnv: createPayload.Env,
    });

    return {
      operationId: `exec_op_${randomUUID()}`,
      status: "succeeded",
      message: "Service container deployed with hardened isolation policy",
      internalDockerRef: created.Id,
      containerStatus: "running",
      ingressConfigured,
    };
  }

  /** Worst case: pull 240 s + wait 240 s + ~20 s of create, logs and remove, inside the client's 510 s. */
  public async runSiteJob(req: SiteJobRequest): Promise<SiteJobResult> {
    assertValidSiteJobRequest(req); // jobId, ids, params and secrets, before anything touches Docker
    const lockKey = `${req.siteId}:${req.kind}`;
    if (this.runningSiteJobs.has(lockKey)) {
      throw new ExecutorCodedError("This setup step is already running for the site", "RESOURCE_LOCKED");
    }
    this.runningSiteJobs.add(lockKey);
    let containerId: string | null = null;
    try {
      if (req.kind === "wordpress.install" || req.kind === "wordpress.set-url") {
        await this.ensureImageAvailable(resolveWordpressCliImage(req.params.phpVersion as PhpVersion));
        // set-url works on the existing html volume and must never create an empty one.
        if (req.kind === "wordpress.install") {
          await this.ensureVolume(
            getManagedVolumeName(req.serviceInstanceId!, "html"),
            req.siteId,
            req.serviceInstanceId!,
          );
        }
      } else if (!(await this.isSharedDatabaseRunning())) {
        // Never pull or create hp_mariadb from a job: ensureSharedDatabase owns that.
        throw new ExecutorCodedError(
          "The shared database is not running yet. Retry in a few minutes",
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }

      const { secretBinds, secretFileEnv } = await writeServiceSecrets(
        this.secretsRootDir,
        req.jobId,
        req.resolvedSecrets,
      );
      const payload = buildSiteJobContainerPayload(req, {
        executorUser: `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`,
        secretBinds,
        secretFileEnv,
        rootKeyHostPath: this.sharedDbRootKeyFile,
      });
      const createRes = await this.dockerClient.request(
        "POST",
        `/containers/create?name=${encodeURIComponent(req.jobId)}`,
        payload,
      );
      if (createRes.statusCode !== 201) {
        throw new ExecutorCodedError(
          `Failed to create site job container (HTTP ${String(createRes.statusCode)})`,
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }
      const id = (JSON.parse(createRes.body.toString("utf8")) as { Id: string }).Id;
      containerId = id;
      const startRes = await this.dockerClient.request("POST", `/containers/${id}/start`);
      if (startRes.statusCode !== 204 && startRes.statusCode !== 304) {
        throw new ExecutorCodedError(
          `Failed to start site job container (HTTP ${String(startRes.statusCode)})`,
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }

      const exitCode = await this.waitForSiteJob(id);
      const logsRes = await this.dockerClient.request(
        "GET",
        `/containers/${id}/logs?stdout=1&stderr=1&tail=50`,
      );
      const outputTail =
        logsRes.statusCode === 200 ? formatSiteJobOutputTail(logsRes.body, req.resolvedSecrets) : "";
      return { jobId: req.jobId, exitCode, outputTail };
    } finally {
      try {
        if (containerId) {
          // Best effort: cleanupOrphanJobs removes leftovers at the next start.
          await this.dockerClient
            .request("DELETE", `/containers/${containerId}?force=true&v=true`)
            .catch(() => undefined);
        }
        await purgeServiceSecrets(this.secretsRootDir, req.jobId);
      } finally {
        this.runningSiteJobs.delete(lockKey);
      }
    }
  }

  private async waitForSiteJob(containerId: string): Promise<number> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.jobTimeoutMs);
    });
    try {
      // Our own timer decides the timeout: a socket timeout would read as DOCKER_ENGINE_UNAVAILABLE.
      const res = await Promise.race([
        this.dockerClient.request("POST", `/containers/${containerId}/wait`, undefined, {
          timeoutMs: this.jobTimeoutMs + 15_000,
        }),
        expired,
      ]);
      if (res === null) {
        await this.dockerClient
          .request("POST", `/containers/${containerId}/kill`)
          .catch(() => undefined);
        return 124;
      }
      const body = res.statusCode === 200 ? (JSON.parse(res.body.toString("utf8")) as { StatusCode?: unknown }) : {};
      if (typeof body.StatusCode !== "number") {
        throw new ExecutorCodedError(
          `Failed to wait for site job container (HTTP ${String(res.statusCode)})`,
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }
      return body.StatusCode;
    } finally {
      clearTimeout(timer);
    }
  }

  /** At executor start: no job survives a restart, so every site_job container and job_* secret dir is stale. */
  public async cleanupOrphanJobs(): Promise<void> {
    const filters = JSON.stringify({ label: [`io.hostingpanel.role=${SITE_JOB_ROLE}`] });
    const res = await this.dockerClient.request(
      "GET",
      `/containers/json?all=true&filters=${encodeURIComponent(filters)}`,
    );
    if (res.statusCode !== 200) {
      throw new ExecutorCodedError(
        `Failed to list site job containers (HTTP ${String(res.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
    for (const job of JSON.parse(res.body.toString("utf8")) as DockerContainerListSummary[]) {
      await this.stopAndRemoveContainer(job.Id);
    }
    const entries = await readdir(this.secretsRootDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("job_")) {
        await purgeServiceSecrets(this.secretsRootDir, entry.name);
      }
    }
  }

  /** Idempotent. The API deletes the site's services first, so any non-job container left means "not yet". */
  public async purgeSite(siteId: string): Promise<void> {
    assertSafeIdentifier(siteId, "siteId");
    const listJson = async <T>(endpoint: string, label: string): Promise<T> => {
      const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
      const res = await this.dockerClient.request("GET", `${endpoint}filters=${filters}`);
      if (res.statusCode !== 200) {
        throw new ExecutorCodedError(
          `Failed to list site resources (HTTP ${String(res.statusCode)})`,
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }
      return JSON.parse(res.body.toString("utf8")) as T;
    };
    const siteLabel = `${MANAGED_DOCKER_LABELS.siteId}=${siteId}`;
    const all = await listJson<DockerContainerListSummary[]>(
      "/containers/json?all=true&",
      siteLabel,
    );
    const isJob = (c: DockerContainerListSummary): boolean =>
      c.Labels?.["io.hostingpanel.role"] === SITE_JOB_ROLE;
    if (all.some((c) => !isJob(c))) {
      throw new ExecutorCodedError("The site still has a running service", "RESOURCE_LOCKED");
    }
    for (const job of all) {
      await this.stopAndRemoveContainer(job.Id);
    }

    const internalNet = getSiteInternalNetworkName(siteId);
    const edgeNet = getSiteEdgeNetworkName(siteId);
    await this.disconnectContainerFromNetwork(edgeNet, INGRESS_PROXY_CONTAINER_NAME);
    await this.disconnectContainerFromNetwork(internalNet, SHARED_DB_CONTAINER_NAME);
    for (const net of [edgeNet, internalNet]) {
      await this.deleteIgnoringMissing(`/networks/${encodeURIComponent(net)}`);
    }

    const volumes = await listJson<{ Volumes: { Name: string }[] | null }>(
      "/volumes?",
      siteLabel,
    );
    for (const volume of volumes.Volumes ?? []) {
      await this.deleteIgnoringMissing(`/volumes/${encodeURIComponent(volume.Name)}`);
    }
    await this.ingressManager.removeSiteRoutes(siteId);
  }

  private async deleteIgnoringMissing(endpoint: string): Promise<void> {
    const res = await this.dockerClient.request("DELETE", endpoint);
    if (res.statusCode !== 204 && res.statusCode !== 404) {
      throw new ExecutorCodedError(
        `Failed to remove site resource (HTTP ${String(res.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
  }

  /** Fire-and-forget at start, so the first site is created in seconds rather than minutes. */
  public async prewarmSiteImages(): Promise<void> {
    const images = [
      resolveWordpressImage(DEFAULT_PHP_VERSION),
      resolveWordpressCliImage(DEFAULT_PHP_VERSION),
      SHARED_MARIADB_IMAGE,
    ];
    for (const image of images) {
      await this.ensureImageAvailable(image).catch((err: unknown) => {
        console.warn(
          JSON.stringify({
            component: "hp-docker-executor",
            event: "site_image_prewarm_failed",
            image,
            code: (err as { code?: string } | null)?.code ?? "INTERNAL_ERROR",
            timestamp: new Date().toISOString(),
          }),
        );
      });
    }
  }

  /** Rewrites only the route file: the service container is looked up, never touched. */
  public async applySiteRoutes(req: SiteRoutesRequest): Promise<void> {
    assertSafeIdentifier(req.siteId, "siteId");
    assertSafeIdentifier(req.serviceInstanceId, "serviceInstanceId");
    const summary = await this.findContainerSummaryByServiceId(req.serviceInstanceId);
    const name = summary?.Names?.[0]?.replace(/^\//, "");
    if (
      !summary ||
      summary.Labels?.[MANAGED_DOCKER_LABELS.siteId] !== req.siteId ||
      name !== req.containerName
    ) {
      throw new ExecutorCodedError("Managed service container not found", "NOT_FOUND");
    }
    if (req.hosts.length > 0) {
      await this.ensureIngressProxy();
      await this.connectContainerToNetwork(
        getSiteEdgeNetworkName(req.siteId),
        INGRESS_PROXY_CONTAINER_NAME,
      );
      await this.ingressManager.upsertServiceRoute(req.siteId, {
        serviceInstanceId: req.serviceInstanceId,
        containerName: req.containerName,
        internalPort: req.internalPort,
        hosts: req.hosts,
      });
      return;
    }
    const removal = await this.ingressManager.removeServiceRoute(req.serviceInstanceId, req.siteId);
    if (removal.siteId && removal.remainingSiteRoutes === 0) {
      await this.disconnectContainerFromNetwork(
        getSiteEdgeNetworkName(removal.siteId),
        INGRESS_PROXY_CONTAINER_NAME,
      ).catch(() => undefined);
    }
  }

  public async getCertificateStatus(req: { failuresSince: string }): Promise<CertificateStatusReport> {
    const store = await readAcmeCertificates(
      path.join(this.ingressManager.acmeDirPath, acmeStorageFileName(this.panel)),
    );
    const sinceMs = Date.parse(req.failuresSince);
    const res = await this.dockerClient.request(
      "GET",
      `/containers/${INGRESS_PROXY_CONTAINER_NAME}/logs?stdout=1&stderr=1&since=${String(Math.floor(sinceMs / 1000))}&tail=2000`,
    );
    if (res.statusCode !== 200 && res.statusCode !== 404) {
      throw new ExecutorCodedError(
        `Failed to read ingress proxy logs (HTTP ${String(res.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
    const lines = res.statusCode === 200 ? demuxDockerLogStream(res.body).map((l) => l.text) : [];
    return {
      acmeEnabled: Boolean(this.panel?.acmeEmail),
      trusted: !this.panel?.acmeStaging && !this.panel?.acmeCaServer,
      readable: store.readable,
      certificates: store.certificates,
      failures: parseAcmeFailures(lines, sinceMs),
    };
  }

  public async getServiceLogs(serviceInstanceId: string, tail: number): Promise<ReturnType<typeof demuxDockerLogStream>> {
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    const summary = await this.findContainerSummaryByServiceId(serviceInstanceId);
    if (!summary) {
      throw new ExecutorCodedError("Managed service container not found", "NOT_FOUND");
    }
    const n = Math.min(500, Math.max(1, Math.trunc(tail) || 1));
    const res = await this.dockerClient.request(
      "GET",
      `/containers/${summary.Id}/logs?stdout=1&stderr=1&timestamps=1&tail=${String(n)}`,
    );
    if (res.statusCode !== 200) {
      throw new ExecutorCodedError(
        `Failed to read service logs (HTTP ${String(res.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
    return demuxDockerLogStream(res.body);
  }

  public async restartService(serviceInstanceId: string): Promise<DockerExecutionResult> {
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    const summary = await this.findContainerSummaryByServiceId(serviceInstanceId);
    if (!summary) {
      throw new ExecutorCodedError("Managed service container not found", "NOT_FOUND");
    }

    const res = await this.dockerClient.request("POST", `/containers/${summary.Id}/restart?t=10`);
    if (res.statusCode !== 204) {
      throw new ExecutorCodedError(
        `Failed to restart service container (HTTP ${String(res.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }

    return {
      operationId: `exec_op_${randomUUID()}`,
      status: "succeeded",
      message: "Service container restarted",
      internalDockerRef: summary.Id,
      containerStatus: "running",
    };
  }

  public async stopService(serviceInstanceId: string): Promise<DockerExecutionResult> {
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    const summary = await this.findContainerSummaryByServiceId(serviceInstanceId);
    if (!summary) {
      await purgeServiceSecrets(this.secretsRootDir, serviceInstanceId);
      throw new ExecutorCodedError("Managed service container not found", "NOT_FOUND");
    }

    const res = await this.dockerClient.request("POST", `/containers/${summary.Id}/stop?t=10`);
    if (res.statusCode !== 204 && res.statusCode !== 304) {
      throw new ExecutorCodedError(
        `Failed to stop service container (HTTP ${String(res.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }

    await purgeServiceSecrets(this.secretsRootDir, serviceInstanceId);

    return {
      operationId: `exec_op_${randomUUID()}`,
      status: "succeeded",
      message: "Service container stopped and transient tmpfs secrets purged",
      internalDockerRef: summary.Id,
      containerStatus: "stopped",
    };
  }

  public async deleteService(serviceInstanceId: string): Promise<DockerExecutionResult> {
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    const summary = await this.findContainerSummaryByServiceId(serviceInstanceId);
    const knownSiteId =
      summary?.Labels?.[MANAGED_DOCKER_LABELS.siteId] ??
      this.expectedMetadata.get(serviceInstanceId)?.siteId;

    if (summary) {
      await this.stopAndRemoveContainer(summary.Id);
    }

    await purgeServiceSecrets(this.secretsRootDir, serviceInstanceId);
    const routeRemoval = await this.ingressManager.removeServiceRoute(
      serviceInstanceId,
      knownSiteId,
    );

    if (routeRemoval.siteId && routeRemoval.remainingSiteRoutes === 0) {
      const edgeNetworkName = getSiteEdgeNetworkName(routeRemoval.siteId);
      await this.disconnectContainerFromNetwork(
        edgeNetworkName,
        INGRESS_PROXY_CONTAINER_NAME,
      ).catch(() => undefined);
    }

    this.expectedMetadata.delete(serviceInstanceId);

    return {
      operationId: `exec_op_${randomUUID()}`,
      status: "succeeded",
      message: "Service container removed and transient tmpfs secrets purged",
      ...(summary ? { internalDockerRef: summary.Id } : {}),
      containerStatus: "stopped",
      ingressConfigured: false,
    };
  }

  public async getObservedState(
    serviceInstanceId: string,
  ): Promise<ExecutorObservedServiceState | null> {
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    const summary = await this.findContainerSummaryByServiceId(serviceInstanceId);
    if (!summary) {
      return null;
    }

    const inspect = await this.inspectContainerByNameOrId(summary.Id);
    if (!inspect) {
      return null;
    }

    const labels = inspect.Config?.Labels ?? {};
    const expected = this.expectedMetadata.get(serviceInstanceId);
    const outOfBandModified = detectOutOfBandContainerModification(
      inspect,
      serviceInstanceId,
      this.secretsRootDir,
      expected,
    );

    const observedRevisionHash = labels[MANAGED_DOCKER_LABELS.specHash] || null;
    const observedStatus = mapContainerStateToObservedStatus(inspect.State);
    const restartCount =
      typeof inspect.RestartCount === "number" && inspect.RestartCount >= 0
        ? inspect.RestartCount
        : 0;

    const wireCompatible: ObservedServiceStateWire = {
      serviceInstanceId,
      observedStatus,
      observedRevisionHash,
      outOfBandModified,
      observedAt: new Date().toISOString(),
      restartCount,
      internalDockerRef: inspect.Id,
    };

    return {
      serviceInstanceId: wireCompatible.serviceInstanceId ?? serviceInstanceId,
      observedStatus: wireCompatible.observedStatus,
      observedRevisionHash: wireCompatible.observedRevisionHash ?? null,
      outOfBandModified: wireCompatible.outOfBandModified ?? false,
      observedAt: wireCompatible.observedAt ?? new Date().toISOString(),
      restartCount: wireCompatible.restartCount ?? 0,
      internalDockerRef: wireCompatible.internalDockerRef,
    };
  }

  private async ensureImageAvailable(image: string): Promise<void> {
    const inspectRes = await this.dockerClient.request(
      "GET",
      `/images/${encodeURIComponent(image)}/json`,
    );
    if (inspectRes.statusCode === 200) {
      return;
    }
    if (!this.pullMissingImages) {
      return;
    }

    const pullRes = await this.dockerClient.request(
      "POST",
      `/images/create?fromImage=${encodeURIComponent(image)}`,
      undefined,
      { timeoutMs: PULL_TIMEOUT_MS },
    );
    if (pullRes.statusCode !== 200) {
      throw new ExecutorCodedError(
        `Failed to pull container image '${image.slice(0, 128)}' (HTTP ${String(pullRes.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
    // The Engine answers 200 even when the pull fails; the error is a JSON line in the stream.
    const failed = pullRes.body
      .toString("utf8")
      .split("\n")
      .some((l) => l.startsWith("{") && /"error"\s*:/.test(l));
    if (failed) {
      throw new ExecutorCodedError(
        "Could not download the site software",
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
  }

  private async ensureNetwork(
    networkName: string,
    options: {
      readonly internal: boolean;
      readonly labels: Readonly<Record<string, string>>;
      readonly subnet?: string;
    },
  ): Promise<void> {
    const inspectRes = await this.dockerClient.request(
      "GET",
      `/networks/${encodeURIComponent(networkName)}`,
    );
    if (inspectRes.statusCode === 200) {
      return;
    }

    const createRes = await this.dockerClient.request("POST", "/networks/create", {
      Name: networkName,
      Driver: "bridge",
      Internal: options.internal,
      CheckDuplicate: true,
      Labels: options.labels,
      ...(options.subnet ? { IPAM: { Config: [{ Subnet: options.subnet }] } } : {}),
    });

    if (createRes.statusCode !== 201 && createRes.statusCode !== 409) {
      throw new ExecutorCodedError(
        `Failed to create isolated Docker network (HTTP ${String(createRes.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
  }

  private async ensureVolume(
    volumeName: string,
    siteId: string,
    serviceInstanceId: string,
  ): Promise<void> {
    const createRes = await this.dockerClient.request("POST", "/volumes/create", {
      Name: volumeName,
      Labels: {
        [MANAGED_DOCKER_LABELS.managed]: "true",
        [MANAGED_DOCKER_LABELS.siteId]: siteId,
        [MANAGED_DOCKER_LABELS.serviceInstanceId]: serviceInstanceId,
      },
    });
    if (createRes.statusCode !== 201 && createRes.statusCode !== 200) {
      throw new ExecutorCodedError(
        `Failed to provision managed Docker volume (HTTP ${String(createRes.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
  }

  private reconnectProxyToSiteEdgeNetworks(): Promise<void> {
    return this.reconnectToRoleNetworks("site_edge", INGRESS_PROXY_CONTAINER_NAME);
  }

  private async reconnectToRoleNetworks(
    role: "site_edge" | "site_internal",
    containerRef: string,
    aliases?: readonly string[],
  ): Promise<void> {
    const filters = JSON.stringify({ label: [`io.hostingpanel.network_role=${role}`] });
    const res = await this.dockerClient.request(
      "GET",
      `/networks?filters=${encodeURIComponent(filters)}`,
    );
    if (res.statusCode !== 200) {
      throw new ExecutorCodedError(
        `Failed to list ${role} networks (HTTP ${String(res.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
    const networks = JSON.parse(res.body.toString("utf8")) as Array<{ readonly Name: string }>;
    for (const network of networks) {
      const connected = await this.connectContainerToNetwork(network.Name, containerRef, aliases, {
        skipMissingNetwork: true,
      });
      if (!connected) {
        // Removed between the list and the connect (site deleted): skip it, keep the rest.
        console.warn(
          JSON.stringify({
            component: "hp-docker-executor",
            event: `${role}_network_missing`,
            network: network.Name,
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }
  }

  private async connectContainerToNetwork(
    networkName: string,
    containerRef: string,
    aliases?: readonly string[],
    options?: { readonly skipMissingNetwork?: boolean },
  ): Promise<boolean> {
    const res = await this.dockerClient.request(
      "POST",
      `/networks/${encodeURIComponent(networkName)}/connect`,
      {
        Container: containerRef,
        ...(aliases && aliases.length > 0 ? { EndpointConfig: { Aliases: aliases } } : {}),
      },
    );

    if (res.statusCode === 200 || res.statusCode === 204) {
      return true;
    }

    if (res.statusCode === 403 || res.statusCode === 409) {
      const msg = res.body.toString("utf8").toLowerCase();
      if (msg.includes("already exists")) {
        return true;
      }
    }

    if (res.statusCode === 404 && options?.skipMissingNetwork) {
      return false;
    }

    throw new ExecutorCodedError(
      `Failed to attach container to isolated network (HTTP ${String(res.statusCode)})`,
      "DOCKER_ENGINE_UNAVAILABLE",
    );
  }

  private async disconnectContainerFromNetwork(
    networkName: string,
    containerRef: string,
  ): Promise<void> {
    await this.dockerClient.request(
      "POST",
      `/networks/${encodeURIComponent(networkName)}/disconnect`,
      {
        Container: containerRef,
        Force: true,
      },
    );
  }

  private async findContainerSummaryByServiceId(
    serviceInstanceId: string,
  ): Promise<DockerContainerListSummary | null> {
    const filters = JSON.stringify({
      label: [`${MANAGED_DOCKER_LABELS.serviceInstanceId}=${serviceInstanceId}`],
    });
    const res = await this.dockerClient.request(
      "GET",
      `/containers/json?all=true&filters=${encodeURIComponent(filters)}`,
    );
    if (res.statusCode !== 200) {
      throw new ExecutorCodedError(
        `Failed to query managed service containers (HTTP ${String(res.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }

    const list = JSON.parse(res.body.toString("utf8")) as DockerContainerListSummary[];
    return list[0] ?? null;
  }

  private async inspectContainerByNameOrId(
    nameOrId: string,
  ): Promise<DockerContainerInspectPayload | null> {
    const res = await this.dockerClient.request(
      "GET",
      `/containers/${encodeURIComponent(nameOrId)}/json`,
    );
    if (res.statusCode === 404) {
      return null;
    }
    if (res.statusCode !== 200) {
      throw new ExecutorCodedError(
        `Failed to inspect container state (HTTP ${String(res.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
    return JSON.parse(res.body.toString("utf8")) as DockerContainerInspectPayload;
  }

  private async stopAndRemoveContainer(containerId: string): Promise<void> {
    await this.dockerClient
      .request("POST", `/containers/${encodeURIComponent(containerId)}/stop?t=5`)
      .catch(() => undefined);

    const rmRes = await this.dockerClient.request(
      "DELETE",
      // v=true drops only anonymous volumes (an image VOLUME); named volumes are never removed.
      `/containers/${encodeURIComponent(containerId)}?force=true&v=true`,
    );
    if (rmRes.statusCode !== 204 && rmRes.statusCode !== 404) {
      throw new ExecutorCodedError(
        `Failed to remove previous container instance (HTTP ${String(rmRes.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
  }
}
