import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {
  DEFAULT_PHPMYADMIN_PORT,
  DEFAULT_PHP_VERSION,
  DEFAULT_SFTP_PORT,
  PHPMYADMIN_IMAGE,
  RESTIC_IMAGE,
  SECRET_KEY_PATTERN,
  SFTP_IMAGE,
  SHARED_MARIADB_IMAGE,
  ManualTlsIpcRequestSchema,
  SftpAccessApplyIpcRequestSchema,
  findPlaintextSecretKeys,
  planManualCertificates,
  traefikNameMatches,
  type SniViolation,
  resolveWordpressCliImage,
  resolveWordpressImage,
  MAIL_RELAY_ALIAS,
  MAIL_RELAY_CONTAINER_NAME,
  MAIL_RELAY_IMAGE,
  PANEL_CONTAINER_STATES,
  PANEL_CONTAINERS,
  PINNED_PANEL_CONTAINERS,
  PanelContainerLogsIpcRequestSchema,
  PanelContainerRestartIpcRequestSchema,
  type PanelContainerState,
  type BackupsIpcRequest,
  type BackupsResultByAction,
  type BackupTarget,
  type ManualTlsIpcRequest,
  type ManualTlsIpcRequestParsed,
  type ManualTlsResultByAction,
  type MailFailureDto,
  type DnsProviderApplyRequest,
  type MailRelayApplyRequest,
  type MailTestResult,
  type PanelContainer,
  type PanelMailRequest,
  type PanelMailResult,
  type PhpVersion,
  type SftpAccessUser,
  type SiteTypeKey,
  LEGACY_SITE_TYPE,
  SITE_TYPE_KEYS,
  findUnsafeDockerInputFields,
  validateServiceVolumeMount,
  type ObservedServiceStateWire,
  type AppImageAllowlistEntry,
  type AppStackComponentActionIpcResult,
  type AppStackComponentIpcRequest,
  type AppStackComponentsRemoveIpcRequest,
  type AppStackComponentsRemoveIpcResult,
  type AppStackCreateIpcRequest,
  type AppStackCreateIpcResult,
  type AppStackImageResolveIpcRequest,
  type AppStackImageResolveIpcResult,
  type AppStackLogsIpcRequest,
  type AppStackPlanIpcRequest,
  type AppStackTerminalOpenIpcRequest,
  type AppStackPrepareIpcResult,
  type AppStackPullIpcRequest,
  type AppStackPullIpcResult,
  type AppStackRefIpcRequest,
  type AppStackRemoveIpcRequest,
  type AppStackRemoveIpcResult,
  type AppStackRoutesIpcRequest,
  type AppStackRoutesIpcResult,
  type AppStackStatusIpcResult,
  type AppStackStopIpcResult,
} from "@hosting-panel/contracts";
import {
  createApprovedServiceSpec,
  type ApprovedServiceSpec,
  type DockerExecutionResult,
  type DockerExecutorPort,
  type CertificateStatusReport,
  type PanelContainerStatus,
  type PinnedPanelContainer,
  type ServiceLogLine,
  type SftpAccessApplyRequest,
  type SftpApplyResult,
  type SftpStatusReport,
  type SiteDatabasesRequest,
  type SiteDatabasesResult,
  type SiteHostRoute,
  type SiteFilesRequest,
  type SiteFilesResult,
  type SiteJobRequest,
  type SiteJobResult,
  type SiteRoutesRequest,
  type AppStackTerminalPort,
  type StackExecutorPort,
  type TerminalEnded,
  type TerminalOpenRequest,
  type TerminalOpenResult,
  type TerminalReadResult,
  type TerminalSessionRecord,
} from "@hosting-panel/executor-contracts";
import { AppStackEngine } from "./app-stacks/engine.js";
import {
  DEFAULT_PHPMYADMIN_CONFIG_DIR,
  PHPMYADMIN_CONTAINER_NAME,
  PHPMYADMIN_NETWORK_NAME,
  ensurePhpMyAdminContainer,
  type PhpMyAdminDeps,
} from "./phpmyadmin-platform.js";
import type { DockerExecTarget } from "./docker-exec.js";
import { PANEL_RESTART_STOP_SECONDS, restartContainerByName } from "./panel-restart.js";
import { reapAppStackTerminalShells, reapTerminalShells, startAppStackTerminal, startDockerTerminal } from "./terminal-docker.js";
import { type TerminalLimits, TerminalSessions } from "./terminal-sessions.js";
import { SiteDatabasesRunner, mariadbRootExec } from "./site-databases.js";
import { SITE_FILES_ROLE, SiteFilesHelpers } from "./site-files-helper.js";
import { resolveExecutorSiteType, type ExecutorSiteType } from "./site-types/index.js";
import {
  BackupRunner,
  DEFAULT_BACKUP_KEY_FILE,
  DEFAULT_BACKUP_NETWORK_NAME,
  DEFAULT_BACKUP_WORK_DIR,
  DEFAULT_PANEL_DUMP_DIR,
  type LocalPanelRepoSource,
  type PanelFetchResult,
} from "./backup-runner.js";
import { DEFAULT_SITE_FILES_DIR } from "./site-files-program.js";
import { DEFAULT_SITE_MAIL_DIR, ensureSiteMailFiles, siteMailBinds } from "./site-mail.js";
import { DEFAULT_SITE_PHP_DIR, removeSitePhpIni, sitePhpBinds, writeSitePhpIni } from "./site-php.js";
import {
  DEFAULT_MAIL_RELAY_SECRET_DIR,
  MAIL_RELAY_NETWORK_NAME,
  MAIL_RELAY_SASL_FILE,
  MAIL_RELAY_SPOOL_VOLUME,
  buildMailRelayContainerPayload,
  buildMailRelaySaslLine,
} from "./mail-relay.js";
import { AcmeStoreError, evictAcmeEntries, parseAcmeFailures, readAcmeCertificates, readAcmeStoreEntries } from "./acme-status.js";
import { probeServedFingerprint, waitForServed, type ServedExpectation } from "./manual-tls-probe.js";
import { ManualTlsStore, ManualTlsStoreError, normaliseEntries, type ManualTlsEntry } from "./manual-tls-store.js";
import {
  DEFAULT_ACME_DNS_SECRET_DIR,
  assertDnsProviderApplyRequest,
  dnsProviderFileEnv,
  dnsProviderState,
} from "./dns-provider.js";
import {
  LOG_READ_MAX_BYTES,
  demuxDockerLogStream,
  maskPhpMyAdminQuery,
  readCappedBody,
  readJobStdout,
} from "./docker-logs.js";
import {
  parsePostfixDeliveries,
  summarizeMailDeliveries,
  type MailDelivery,
} from "./mail-relay-status.js";
import { submitLocalMail } from "./smtp-submit.js";
import { deliverPanelMail } from "./panel-mail.js";
import type { ObservedServiceState } from "@hosting-panel/hosting-domain";
import {
  DEFAULT_INGRESS_HTTP_PORT,
  DEFAULT_INGRESS_HTTPS_PORT,
  DEFAULT_INGRESS_ROOT_DIR,
  DEFAULT_TRAEFIK_IMAGE,
  ExecutorCodedError,
  INGRESS_BRIDGE_NETWORK_NAME,
  INGRESS_PROXY_CONTAINER_NAME,
  MANUAL_CERTIFICATES_FILE_NAME,
  STATIC_SHA256_LABEL,
  acmeStorageFileName,
  TraefikIngressFileManager,
  type PanelDnsLookup,
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
  SITE_JOB_ROLE,
  SITE_JOB_SPECS,
  WORDPRESS_RESULT_MAX_BYTES,
  assertValidSiteJobRequest,
  buildSiteJobContainerPayload,
  formatSiteJobOutputTail,
  parseWordpressJobResult,
  siteJobTimeoutMs,
} from "./site-jobs.js";
import {
  DEFAULT_SFTP_STATE_DIR,
  SFTP_CONFIG_SHA256_LABEL,
  SFTP_CONTAINER_NAME,
  SFTP_NETWORK_NAME,
  SFTP_VOLUME_PREFIX,
  assertSftpStateDir,
  buildSftpContainerPayload,
  commitSftpStatePlan,
  hasSftpHostKey,
  prepareSftpStatePlan,
  readSftpHostKeyFingerprint,
  readSftpState,
  writeSftpState,
  type SftpContainerCreatePayload,
  type SftpContainerSiteMount,
  type SftpStatePlan,
} from "./sftp-platform.js";

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
    readonly StartedAt?: string;
    readonly ExitCode?: number;
    readonly Error?: string;
  };
  readonly ExecIDs?: readonly string[] | null;
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

/** json-file rotation of every long-lived panel container (R184 2.1). Not part of any config hash. */
const ROTATED_LOG_CONFIG = { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } } as const;

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
    readonly LogConfig: typeof ROTATED_LOG_CONFIG;
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

/** Largest limits a service may ask for, whatever the API sent (R207 exec.1). */
export const MAX_SERVICE_MEMORY_BYTES = 64 * 1024 ** 3;
export const MAX_SERVICE_CPU_MILLI = 64_000;

/** Host ports the server itself uses: SSH, the proxy, SFTP, web, API, PostgreSQL, phpMyAdmin. */
const RESERVED_HOST_PORTS: ReadonlySet<number> = new Set([
  22,
  DEFAULT_INGRESS_HTTP_PORT,
  DEFAULT_INGRESS_HTTPS_PORT,
  DEFAULT_SFTP_PORT,
  3000,
  4000,
  5432,
  DEFAULT_PHPMYADMIN_PORT,
]);

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

  const limits = input.resourceLimits;
  if (limits && (Number(limits.memoryBytes) > MAX_SERVICE_MEMORY_BYTES || limits.cpuMilli > MAX_SERVICE_CPU_MILLI)) {
    throw new ExecutorCodedError("Resource limits exceed the server ceiling", "VALIDATION_ERROR");
  }
  if (input.portBindings.some((pb) => pb.hostPort !== undefined && RESERVED_HOST_PORTS.has(pb.hostPort))) {
    throw new ExecutorCodedError("Published host port is reserved by the server", "VALIDATION_ERROR");
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
      siteMail: input.siteMail,
      phpIni: input.phpIni,
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

/**
 * After a reboot Docker creates each missing bind source, and the service folder above it, as a root-owned 0755 folder (#7).
 * The executor has no capabilities: it cannot write into or empty that folder, only rename it inside its own 0700 root.
 * What is set aside holds no secret and is gone at the next reboot (tmpfs).
 */
async function setServiceSecretDirAside(secretsRootDir: string, serviceDir: string): Promise<void> {
  const aside = path.join(secretsRootDir, `.stale-${randomUUID()}`);
  await rename(serviceDir, aside);
  await rm(aside, { recursive: true, force: true }).catch(() => undefined);
}

/** Leaves serviceDir missing, or an executor-owned folder that holds regular files only. */
async function repairServiceSecretDir(secretsRootDir: string, serviceDir: string): Promise<void> {
  let st;
  try {
    st = await lstat(serviceDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
  if (!st.isDirectory() || st.uid !== process.getuid?.()) {
    return setServiceSecretDirAside(secretsRootDir, serviceDir);
  }
  for (const entry of await readdir(serviceDir, { withFileTypes: true })) {
    if (entry.isFile()) {
      continue;
    }
    try {
      await rm(path.join(serviceDir, entry.name), { recursive: true, force: true });
    } catch {
      return setServiceSecretDirAside(secretsRootDir, serviceDir);
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
    await setServiceSecretDirAside(secretsRootDir, serviceDir);
    return;
  }

  for (const entry of entries) {
    if (entry.isFile()) {
      const secretPath = assertContainedPath(serviceDir, path.join(serviceDir, entry.name));
      await overwriteAndUnlinkSecretFile(secretPath);
    }
  }

  await rm(serviceDir, { recursive: true, force: true }).catch(() =>
    setServiceSecretDirAside(secretsRootDir, serviceDir),
  );
}

/** With options.additive, files not named in resolvedSecrets stay: a restart must not remove a file the container still mounts. */
export async function writeServiceSecrets(
  secretsRootDir: string,
  serviceInstanceId: string,
  resolvedSecrets: Readonly<Record<string, string>> | undefined,
  options?: { readonly additive?: boolean },
): Promise<{
  readonly secretBinds: readonly string[];
  readonly secretFileEnv: readonly string[];
}> {
  assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
  const secretEntries = resolvedSecrets ? Object.entries(resolvedSecrets) : [];

  if (secretEntries.length === 0) {
    if (!options?.additive) {
      await purgeServiceSecrets(secretsRootDir, serviceInstanceId);
    }
    return { secretBinds: [], secretFileEnv: [] };
  }

  await mkdir(secretsRootDir, { recursive: true, mode: 0o700 });
  await chmod(secretsRootDir, 0o700);
  const serviceDir = assertContainedPath(
    secretsRootDir,
    path.join(secretsRootDir, serviceInstanceId),
  );
  await repairServiceSecretDir(secretsRootDir, serviceDir);
  await mkdir(serviceDir, { recursive: true, mode: 0o700 });
  await chmod(serviceDir, 0o700);

  const desiredKeys = new Set(secretEntries.map(([envName]) => envName));
  const existingEntries = options?.additive
    ? []
    : await readdir(serviceDir, { withFileTypes: true }).catch(() => []);
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
  /** Each must be one of siteMailBinds(dir); the caller picks the directory. */
  readonly siteMailBinds?: readonly string[];
  /** Each must be this service's own sitePhpBinds(dir, id) entry; the caller picks the directory. */
  readonly sitePhpBinds?: readonly string[];
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

  if (options?.siteMailBinds) {
    for (const mailBind of options.siteMailBinds) {
      const dir = path.posix.dirname(mailBind.split(":")[0] ?? "");
      if (!siteMailBinds(dir).includes(mailBind)) {
        throw new ExecutorCodedError("Unknown site mail bind mount", "HOST_POLICY_DENIED");
      }
      binds.push(mailBind);
    }
  }

  if (options?.sitePhpBinds) {
    for (const phpBind of options.sitePhpBinds) {
      const dir = path.posix.dirname(phpBind.split(":")[0] ?? "");
      if (sitePhpBinds(dir, spec.serviceInstanceId)[0] !== phpBind) {
        throw new ExecutorCodedError("Unknown site PHP bind mount", "HOST_POLICY_DENIED");
      }
      binds.push(phpBind);
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
      LogConfig: ROTATED_LOG_CONFIG,
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
  siteMailDir: string = DEFAULT_SITE_MAIL_DIR,
  sitePhpDir: string = DEFAULT_SITE_PHP_DIR,
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
  const allowedSiteFileBinds = new Set([
    ...siteMailBinds(siteMailDir),
    ...sitePhpBinds(sitePhpDir, serviceInstanceId),
  ]);
  const allowedSecretDirPrefix = `${path.resolve(secretsRootDir, serviceInstanceId)}${path.sep}`;
  for (const bind of hostConfig.Binds ?? []) {
    if (bind.includes("/var/run/docker.sock")) {
      return true;
    }
    if (bind.startsWith(allowedVolumePrefix) || allowedSiteFileBinds.has(bind)) {
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
/** Longest wait for a concurrent removal of the same container to finish. */
export const REMOVAL_IN_PROGRESS_WAIT_MS = 5_000;
/** Pause between checks while that removal finishes. */
export const REMOVAL_IN_PROGRESS_POLL_MS = 100;

class DockerSocketHttpClient {
  public readonly socketPath: string;
  private readonly apiPrefix: string;
  private readonly timeoutMs: number;
  private useUnversionedFallback = false;

  public get effectiveApiPrefix(): string {
    return this.useUnversionedFallback ? "" : this.apiPrefix;
  }

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
    options?: { readonly timeoutMs?: number; readonly apiPrefix?: string; readonly maxBodyBytes?: number },
  ): Promise<DockerHttpResponse> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const maxBodyBytes = options?.maxBodyBytes ?? Infinity;
    if (options?.apiPrefix !== undefined) {
      // A pinned version must fail on an older engine, never fall back and drop the new fields.
      return this.rawRequest(method, `${options.apiPrefix}${endpointPath}`, jsonBody, timeoutMs, maxBodyBytes);
    }
    const primaryPrefix = this.useUnversionedFallback ? "" : this.apiPrefix;
    const response = await this.rawRequest(
      method,
      `${primaryPrefix}${endpointPath}`,
      jsonBody,
      timeoutMs,
      maxBodyBytes,
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
        const fallbackResponse = await this.rawRequest(method, endpointPath, jsonBody, timeoutMs, maxBodyBytes);
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
    maxBodyBytes: number,
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
          readCappedBody(res, maxBodyBytes).then(
            (body) => resolve({ statusCode: res.statusCode ?? 500, body }),
            () =>
              reject(
                new ExecutorCodedError(
                  "Failed while reading response from Docker Engine",
                  "DOCKER_ENGINE_UNAVAILABLE",
                ),
              ),
          );
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
  readonly siteMailDir?: string;
  readonly sitePhpDir?: string;
  readonly ingressRootDir?: string;
  readonly traefikImage?: string;
  readonly ingressHttpPort?: number;
  readonly ingressHttpsPort?: number;
  /** Poll timing of the served-fingerprint probe after a manual TLS publish (tests shorten it). */
  readonly manualTlsProbe?: { readonly deadlineMs?: number; readonly intervalMs?: number };
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
  /** tmpfs dir holding sasl_passwd; must exist and be owned by the executor (bootstrap/tmpfiles). */
  readonly mailRelaySecretDir?: string;
  /** tmpfs dir holding the DNS provider credential files; must exist and be owned by the executor. */
  readonly acmeDnsSecretDir?: string;
  /** How long to keep retrying the post-apply queue flush (default 30 000). */
  readonly mailRelayFlushWaitMs?: number;
  /** Test email: delay between log polls, and how long to wait for the delivery line. */
  readonly mailTestPollMs?: number;
  readonly mailTestWaitMs?: number;
  /** The relay's submission port on its bridge address (tests only). */
  readonly mailSubmitPort?: number;
  readonly siteFilesDir?: string;
  readonly filesHelperIdleMs?: number;
  readonly sftpStateDir?: string;
  readonly sftpPort?: number;
  readonly sftpHostIp?: string;
  readonly sftpContainerName?: string;
  readonly sftpNetworkName?: string;
  readonly sftpVolumePrefix?: string;
  readonly sharedDbContainerName?: string;
  readonly phpMyAdminPort?: number;
  readonly phpMyAdminContainerName?: string;
  readonly phpMyAdminNetworkName?: string;
  readonly phpMyAdminConfigDir?: string;
  readonly backupKeyFile?: string;
  readonly backupWorkDir?: string;
  readonly panelDumpDir?: string;
  /** Validated HP_BACKUP_LOCAL_ROOT; null/absent = local targets answer local_target_unsafe. */
  readonly backupLocalRoot?: string | null;
  readonly backupNetworkName?: string;
  readonly sharedDbNetworkName?: string;
  /**
   * TEST SEAM: the ingress proxy container and its network are hp_ingress_proxy / hp_ingress_net. A test that runs
   * next to a live proxy sets other names; the default payloads are byte-identical. Never set in production.
   */
  readonly ingressProxyContainerName?: string;
  readonly ingressNetworkName?: string;
  /** TEST SEAM: images the stack engine accepts instead of APP_IMAGE_ALLOWLIST. Never set in production (main.ts does not pass it). */
  readonly appImageAllowlist?: readonly AppImageAllowlistEntry[];
  /** Shorter terminal limits (tests and the real-Docker script). */
  readonly terminalLimits?: Partial<TerminalLimits>;
  /** Turns a request's site-type key into its definition (default: the executor's registry). */
  readonly resolveSiteType?: (key: SiteTypeKey) => ExecutorSiteType;
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

type ManualTlsPublishRequest = Extract<ManualTlsIpcRequestParsed, { action: "publish" }>;
interface ManualColdInput {
  req: ManualTlsPublishRequest;
  wanted: ManualTlsEntry[];
  entries: { versionId: string; names: string[]; assignedHosts: readonly string[] }[];
  guardHosts: string[];
  evictionHosts: string[];
}

const ACME_PLAN_READ_RETRIES = 3;
const ACME_PLAN_READ_RETRY_MS = 50;

export class DockerEngineSocketAdapter implements DockerExecutorPort, StackExecutorPort, AppStackTerminalPort {
  public readonly isRuntimeAvailable = true;
  private readonly dockerClient: DockerSocketHttpClient;
  private readonly secretsRootDir: string;
  private readonly siteMailDir: string;
  private readonly sitePhpDir: string;
  private readonly ingressManager: TraefikIngressFileManager;
  private readonly traefikImage: string;
  private readonly ingressHttpPort: number;
  private readonly ingressHttpsPort: number | undefined;
  private readonly panel: PanelIngressConfig | null;
  private readonly pullMissingImages: boolean;
  private readonly expectedMetadata = new Map<string, ExpectedManagedServiceMetadata>();
  private ingressEnsureInFlight: Promise<IngressEnsureResult> | null = null;
  private readonly manualTlsStore: ManualTlsStore;
  /** Manual publishes run strictly one after the other (the cold path stops the proxy). */
  private manualTlsQueue: Promise<unknown> = Promise.resolve();
  private manualTlsRecovered = false;
  private manualPublishesInFlight = 0;
  private readonly manualTlsProbe: { readonly deadlineMs?: number; readonly intervalMs?: number };
  private readonly sharedDbDataDir: string;
  private readonly sharedDbRootKeyFile: string;
  private readonly sharedDbAdminSubnet: string;
  private readonly executorUid: number | undefined;
  private sharedDbEnsureInFlight: Promise<SharedDatabaseEnsureResult> | null = null;
  private readonly jobTimeoutMs: number | undefined;
  /** `siteId:kind` of the site jobs running now. */
  private readonly runningSiteJobs = new Set<string>();
  private readonly mailRelaySecretDir: string;
  private readonly acmeDnsSecretDir: string;
  private dnsProviderQueue: Promise<unknown> = Promise.resolve();
  private readonly mailRelayFlushWaitMs: number;
  private readonly mailTestPollMs: number;
  private readonly mailTestWaitMs: number;
  private readonly mailSubmitPort: number;
  private readonly siteFilesHelpers: SiteFilesHelpers;
  private readonly databases: SiteDatabasesRunner;
  private readonly sharedDbContainerName: string;
  private readonly phpMyAdminPort: number;
  private readonly phpMyAdminContainerName: string;
  private readonly phpMyAdminNetworkName: string;
  private readonly phpMyAdminConfigDir: string;
  private phpMyAdminEnsureInFlight: { ifPresent: boolean; promise: Promise<void> } | null = null;
  /** Applies run strictly one after the other; two different configs are never merged. */
  private mailRelayQueue: Promise<unknown> = Promise.resolve();
  private readonly sftpStateDir: string;
  private readonly sftpPort: number;
  private readonly sftpHostIp: string;
  private readonly sftpContainerName: string;
  private readonly sftpNetworkName: string;
  private readonly sftpVolumePrefix: string;
  private sftpQueue: Promise<unknown> = Promise.resolve();
  /** Applies queued or running on the two queues above; a restart of that container waits for none. */
  private readonly panelQueued = { mail_relay: 0, sftp: 0 };
  /** Running panel restarts (never rejecting); an ensure of that component waits for its restart. */
  private readonly panelRestarts = new Map<PanelContainer, Promise<void>>();
  private readonly backupKeyFile: string;
  private readonly backupNetworkName: string;
  private readonly sharedDbNetworkName: string;
  private readonly backupRunner: BackupRunner;
  private readonly execTarget: DockerExecTarget;
  private readonly terminals: TerminalSessions;
  private readonly resolveSiteType: (key: SiteTypeKey) => ExecutorSiteType;
  private readonly ingressProxyContainerName: string;
  private readonly ingressNetworkName: string;
  private readonly appStackEngine: AppStackEngine;

  public constructor(options?: DockerEngineSocketAdapterOptions) {
    this.ingressProxyContainerName = options?.ingressProxyContainerName ?? INGRESS_PROXY_CONTAINER_NAME;
    this.ingressNetworkName = options?.ingressNetworkName ?? INGRESS_BRIDGE_NETWORK_NAME;
    assertSafeIdentifier(this.ingressProxyContainerName, "ingressProxyContainerName");
    assertSafeIdentifier(this.ingressNetworkName, "ingressNetworkName");
    this.terminals = new TerminalSessions(options?.terminalLimits);
    this.resolveSiteType = options?.resolveSiteType ?? resolveExecutorSiteType;
    this.dockerClient = new DockerSocketHttpClient({
      socketPath: options?.dockerSocketPath ?? DEFAULT_DOCKER_SOCKET_PATH,
      apiPrefix: options?.dockerApiPrefix ?? DEFAULT_DOCKER_API_PREFIX,
      timeoutMs: options?.requestTimeoutMs ?? 30_000,
    });
    this.secretsRootDir = path.resolve(options?.secretsRootDir ?? DEFAULT_SECRETS_ROOT_DIR);
    this.siteMailDir = path.resolve(options?.siteMailDir ?? DEFAULT_SITE_MAIL_DIR);
    this.sitePhpDir = path.resolve(options?.sitePhpDir ?? DEFAULT_SITE_PHP_DIR);
    this.ingressManager = new TraefikIngressFileManager(
      options?.ingressRootDir ?? DEFAULT_INGRESS_ROOT_DIR,
      options?.panel ?? null,
    );
    this.manualTlsStore = new ManualTlsStore({
      dir: this.ingressManager.manualCertsDirPath,
      statePath: this.ingressManager.manualTlsStatePath,
      // The manager's value is the manual-certs directory as the proxy sees it; the store wants its parent (dynamic/).
      mountDir: path.posix.dirname(this.ingressManager.manualCertMountDir),
      writeManifest: (content) => this.ingressManager.writeManualCertificateManifest(content),
      readManifest: () =>
        readFile(path.join(this.ingressManager.dynamicDirPath, MANUAL_CERTIFICATES_FILE_NAME), "utf8").catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }),
      ...(options?.executorUid !== undefined ? { uid: options.executorUid } : {}),
    });
    this.traefikImage = options?.traefikImage ?? DEFAULT_TRAEFIK_IMAGE;
    this.ingressHttpPort = options?.ingressHttpPort ?? DEFAULT_INGRESS_HTTP_PORT;
    this.ingressHttpsPort = options?.ingressHttpsPort;
    this.manualTlsProbe = options?.manualTlsProbe ?? {};
    this.panel = options?.panel ?? null;
    this.pullMissingImages = options?.pullMissingImages ?? true;
    this.sharedDbContainerName = options?.sharedDbContainerName ?? SHARED_DB_CONTAINER_NAME;
    assertSafeIdentifier(this.sharedDbContainerName, "sharedDbContainerName");
    this.sharedDbDataDir = path.resolve(options?.sharedDbDataDir ?? DEFAULT_SHARED_DB_DATA_DIR);
    this.sharedDbRootKeyFile = path.resolve(
      options?.sharedDbRootKeyFile ?? DEFAULT_SHARED_DB_ROOT_KEY_FILE,
    );
    this.sharedDbAdminSubnet = options?.sharedDbAdminSubnet ?? DEFAULT_SHARED_DB_ADMIN_SUBNET;
    this.executorUid = options?.executorUid ?? process.getuid?.();
    this.jobTimeoutMs = options?.jobTimeoutMs;
    this.mailRelaySecretDir = path.resolve(
      options?.mailRelaySecretDir ?? DEFAULT_MAIL_RELAY_SECRET_DIR,
    );
    this.acmeDnsSecretDir = path.resolve(options?.acmeDnsSecretDir ?? DEFAULT_ACME_DNS_SECRET_DIR);
    this.mailRelayFlushWaitMs = options?.mailRelayFlushWaitMs ?? 30_000;
    this.mailTestPollMs = options?.mailTestPollMs ?? 1_000;
    this.mailTestWaitMs = options?.mailTestWaitMs ?? 20_000;
    this.mailSubmitPort = options?.mailSubmitPort ?? 587;
    this.phpMyAdminPort = options?.phpMyAdminPort ?? DEFAULT_PHPMYADMIN_PORT;
    if (!Number.isInteger(this.phpMyAdminPort) || this.phpMyAdminPort < 1 || this.phpMyAdminPort > 65535) {
      throw new ExecutorCodedError(
        "phpMyAdminPort must be an integer between 1 and 65535",
        "VALIDATION_ERROR",
      );
    }
    this.phpMyAdminContainerName = options?.phpMyAdminContainerName ?? PHPMYADMIN_CONTAINER_NAME;
    this.phpMyAdminNetworkName = options?.phpMyAdminNetworkName ?? PHPMYADMIN_NETWORK_NAME;
    this.phpMyAdminConfigDir = path.resolve(
      options?.phpMyAdminConfigDir ?? DEFAULT_PHPMYADMIN_CONFIG_DIR,
    );
    assertSafeIdentifier(this.phpMyAdminContainerName, "phpMyAdminContainerName");
    assertSafeIdentifier(this.phpMyAdminNetworkName, "phpMyAdminNetworkName");
    const dockerClient = this.dockerClient;
    const execTarget = (this.execTarget = {
      request: (m: string, p: string, b?: unknown, o?: { readonly timeoutMs?: number }) =>
        this.dockerClient.request(m, p, b, o),
      socketPath: this.dockerClient.socketPath,
      get apiPrefix() {
        return dockerClient.effectiveApiPrefix;
      },
    });
    this.siteFilesHelpers = new SiteFilesHelpers({
      target: execTarget,
      programDir: path.resolve(options?.siteFilesDir ?? DEFAULT_SITE_FILES_DIR),
      ...(options?.filesHelperIdleMs !== undefined ? { idleMs: options.filesHelperIdleMs } : {}),
      resolveSiteType: this.resolveSiteType,
    });
    this.databases = new SiteDatabasesRunner({
      runSql: mariadbRootExec(execTarget, this.sharedDbContainerName),
      ensurePhpMyAdmin: () => this.ensurePhpMyAdmin(),
    });
    this.sftpStateDir = path.resolve(options?.sftpStateDir ?? DEFAULT_SFTP_STATE_DIR);
    this.sftpPort = options?.sftpPort ?? DEFAULT_SFTP_PORT;
    if (!Number.isInteger(this.sftpPort) || this.sftpPort < 1 || this.sftpPort > 65535) {
      throw new ExecutorCodedError(
        "sftpPort must be an integer between 1 and 65535",
        "VALIDATION_ERROR",
      );
    }
    this.sftpHostIp = options?.sftpHostIp ?? "0.0.0.0";
    this.sftpContainerName = options?.sftpContainerName ?? SFTP_CONTAINER_NAME;
    this.sftpNetworkName = options?.sftpNetworkName ?? SFTP_NETWORK_NAME;
    this.sftpVolumePrefix = options?.sftpVolumePrefix ?? SFTP_VOLUME_PREFIX;
    assertSafeIdentifier(this.sftpContainerName, "sftpContainerName");
    assertSafeIdentifier(this.sftpNetworkName, "sftpNetworkName");
    assertSafeIdentifier(this.sftpVolumePrefix, "sftpVolumePrefix");
    this.backupKeyFile = path.resolve(options?.backupKeyFile ?? DEFAULT_BACKUP_KEY_FILE);
    this.backupNetworkName = options?.backupNetworkName ?? DEFAULT_BACKUP_NETWORK_NAME;
    this.sharedDbNetworkName = options?.sharedDbNetworkName ?? SHARED_DB_NETWORK_NAME;
    assertSafeIdentifier(this.backupNetworkName, "backupNetworkName");
    assertSafeIdentifier(this.sharedDbNetworkName, "sharedDbNetworkName");
    this.backupRunner = new BackupRunner({
      resolveSiteType: this.resolveSiteType,
      request: (method, endpointPath, body, opts) =>
        this.dockerClient.request(method, endpointPath, body, opts),
      ensureImage: (image) => this.ensureImageAvailable(image),
      ensureBackupNetwork: () =>
        this.ensureNetwork(this.backupNetworkName, {
          internal: false,
          labels: {
            [MANAGED_DOCKER_LABELS.managed]: "true",
            "io.hostingpanel.network_role": "backup",
          },
        }),
      listSiteDatabases: async (siteId) =>
        (await this.databases.run({ siteId, op: "list" })).databases,
      secretsRootDir: this.secretsRootDir,
      backupKeyFile: this.backupKeyFile,
      sharedDbRootKeyFile: this.sharedDbRootKeyFile,
      sharedDbDataDir: this.sharedDbDataDir,
      sharedDbNetworkName: this.sharedDbNetworkName,
      backupNetworkName: this.backupNetworkName,
      executorUser: `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`,
      backupWorkDir: path.resolve(options?.backupWorkDir ?? DEFAULT_BACKUP_WORK_DIR),
      panelDumpDir: path.resolve(options?.panelDumpDir ?? DEFAULT_PANEL_DUMP_DIR),
      localRepoRoot: options?.backupLocalRoot ?? null,
    });
    this.appStackEngine = new AppStackEngine({
      request: (method, endpointPath, body, o) => this.dockerClient.request(method, endpointPath, body, o),
      secretsRootDir: this.secretsRootDir,
      pullMissingImages: this.pullMissingImages,
      ...(options?.appImageAllowlist ? { allowlist: options.appImageAllowlist } : {}),
      routes: {
        write: (id, r) => this.ingressManager.writeAppStackRoutes(id, r),
        remove: (id) => this.ingressManager.removeAppStackRoutes(id),
        read: (id) => this.ingressManager.readAppStackRoutes(id),
      },
      proxy: {
        containerName: this.ingressProxyContainerName,
        ensure: async () => {
          await this.ensureIngressProxy();
        },
      },
      readLogs: (ref, tail) => this.readContainerLogs(ref, tail),
      backupLanes: this.backupRunner,
    });
  }

  public pullAppStackImage(req: AppStackPullIpcRequest): Promise<AppStackPullIpcResult> {
    return this.appStackEngine.pullAppStackImage(req);
  }

  public prepareAppStack(req: AppStackPlanIpcRequest): Promise<AppStackPrepareIpcResult> {
    return this.appStackEngine.prepareAppStack(req);
  }

  public createAppStackComponents(req: AppStackCreateIpcRequest): Promise<AppStackCreateIpcResult> {
    return this.appStackEngine.createAppStackComponents(req);
  }

  public resolveAppStackImage(req: AppStackImageResolveIpcRequest): Promise<AppStackImageResolveIpcResult> {
    return this.appStackEngine.resolveAppStackImage(req);
  }

  public startAppStackComponent(req: AppStackComponentIpcRequest): Promise<AppStackComponentActionIpcResult> {
    return this.appStackEngine.startAppStackComponent(req);
  }

  public restartAppStackComponent(req: AppStackComponentIpcRequest): Promise<AppStackComponentActionIpcResult> {
    return this.appStackEngine.restartAppStackComponent(req);
  }

  public stopAppStack(req: AppStackRefIpcRequest): Promise<AppStackStopIpcResult> {
    return this.appStackEngine.stopAppStack(req);
  }

  public publishAppStackRoutes(req: AppStackRoutesIpcRequest): Promise<AppStackRoutesIpcResult> {
    return this.appStackEngine.publishAppStackRoutes(req);
  }

  public unpublishAppStackRoutes(req: AppStackRefIpcRequest): Promise<AppStackRoutesIpcResult> {
    return this.appStackEngine.unpublishAppStackRoutes(req);
  }

  public removeAppStack(req: AppStackRemoveIpcRequest): Promise<AppStackRemoveIpcResult> {
    return this.appStackEngine.removeAppStack(req);
  }

  public removeAppStackComponents(req: AppStackComponentsRemoveIpcRequest): Promise<AppStackComponentsRemoveIpcResult> {
    return this.appStackEngine.removeAppStackComponents(req);
  }

  public getAppStackStatus(req: AppStackRefIpcRequest): Promise<AppStackStatusIpcResult> {
    return this.appStackEngine.getAppStackStatus(req);
  }

  public getAppStackComponentLogs(req: AppStackLogsIpcRequest): Promise<readonly ServiceLogLine[]> {
    return this.appStackEngine.getAppStackComponentLogs(req);
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
    await this.panelRestarts.get("ingress_proxy");
    const { staticConfigPath, dynamicDirPath, acmeDirPath, staticSha256, acmeDns } =
      await this.ingressManager.ensureStaticConfig(this.panel);
    await this.recoverManualTlsOnce();

    await this.ensureNetwork(this.ingressNetworkName, {
      internal: false,
      labels: {
        [MANAGED_DOCKER_LABELS.managed]: "true",
        "io.hostingpanel.network_role": "ingress_public",
      },
    });

    await this.ensureImageAvailable(this.traefikImage);

    const existing = await this.inspectContainerByNameOrId(this.ingressProxyContainerName);
    const built = buildIngressProxyContainerPayload({
      traefikImage: this.traefikImage,
      httpHostPort: this.ingressHttpPort,
      ...(this.ingressHttpsPort !== undefined ? { httpsHostPort: this.ingressHttpsPort } : {}),
      staticConfigHostPath: staticConfigPath,
      dynamicDirHostPath: dynamicDirPath,
      acmeDirHostPath: acmeDirPath,
      staticSha256,
      ...(acmeDns
        ? { acmeDns: { secretDirHostPath: this.acmeDnsSecretDir, env: dnsProviderFileEnv(acmeDns) } }
        : {}),
      // Same uid:gid as the executor, so the proxy can read hp-executor-owned dirs without DAC caps.
      ...(process.getuid && process.getgid
        ? { user: `${String(process.getuid())}:${String(process.getgid())}` }
        : {}),
    });
    // Only the test seam renames the network; the default payload is the builder's, untouched.
    const payload =
      this.ingressNetworkName === INGRESS_BRIDGE_NETWORK_NAME
        ? built
        : ({
            ...built,
            HostConfig: { ...built.HostConfig, NetworkMode: this.ingressNetworkName },
            NetworkingConfig: { EndpointsConfig: { [this.ingressNetworkName]: { GwPriority: 1 } } },
          } as unknown as typeof built);

    const createIngressProxy = async (): Promise<string> => {
      const createRes = await this.dockerClient.request(
        "POST",
        `/containers/create?name=${encodeURIComponent(this.ingressProxyContainerName)}`,
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
        // Only the managed _FILE entries: the image's own Env (PATH) is not ours.
        sortedJson(
          (existing.Config?.Env ?? []).filter((e) => /^[A-Z0-9_]+_FILE=\/run\/secrets\/hp-acme-dns\//.test(e)),
        ) !== sortedJson(payload.Env ?? []) ||
        existing.Config?.Labels?.[STATIC_SHA256_LABEL] !== staticSha256 ||
        sortedJson(existingBinds) !== sortedJson(payload.HostConfig.Binds) ||
        sortedJson(existing.HostConfig?.ExtraHosts) !== sortedJson(payload.HostConfig.ExtraHosts) ||
        existing.HostConfig?.LogConfig?.Type !== payload.HostConfig.LogConfig.Type ||
        sortedJson(Object.entries(existing.HostConfig?.LogConfig?.Config ?? {}).map(String)) !==
          sortedJson(Object.entries(payload.HostConfig.LogConfig.Config).map(String)) ||
        (
          existing.NetworkSettings?.Networks?.[this.ingressNetworkName] as
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
    // Application stacks (ADR-0035): best effort, a stack network must never fail the site ingress.
    await this.reconnectToRoleNetworks("app_edge", this.ingressProxyContainerName).catch((err: unknown) => {
      console.warn(
        JSON.stringify({
          component: "hp-docker-executor",
          event: "app_edge_reconnect_failed",
          code: (err as { code?: unknown } | null)?.code ?? "INTERNAL_ERROR",
          timestamp: new Date().toISOString(),
        }),
      );
    });

    return {
      component: "ingress_proxy",
      status: "running",
      ensuredAt: new Date().toISOString(),
    };
  }

  /** Applies run one after the other, like applyMailRelay. Never logs a credential value. */
  public applyDnsProvider(req: DnsProviderApplyRequest | null): Promise<void> {
    const run = this.dnsProviderQueue
      .then(() => this.panelRestarts.get("ingress_proxy"))
      .then(() => this.applyDnsProviderNow(req));
    this.dnsProviderQueue = run.catch(() => undefined);
    return run;
  }

  /** Overwrites and unlinks every regular file in the DNS secret dir; a missing dir is fine. */
  private async wipeDnsProviderFiles(): Promise<void> {
    const entries = await readdir(this.acmeDnsSecretDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile()) await overwriteAndUnlinkSecretFile(path.join(this.acmeDnsSecretDir, entry.name));
    }
  }

  /** An ensure already in flight may have read the old DNS state: wait for it, then ensure again. */
  private async ensureIngressProxyAfterStateChange(): Promise<void> {
    await this.ingressEnsureInFlight?.catch(() => undefined);
    await this.ensureIngressProxy();
  }

  private async applyDnsProviderNow(input: DnsProviderApplyRequest | null): Promise<void> {
    if (input === null) {
      // Wipe first: a failed removal must not leave the credentials on tmpfs.
      await this.wipeDnsProviderFiles();
      const changed = await this.ingressManager.setDnsProviderState(null);
      // With a panel always: a retry after a failed ensure must recreate a removed proxy (no-op without drift).
      // Without one, only on a change, so a fresh panel-less install gets no proxy on 80/443.
      if (changed || this.panel !== null) await this.ensureIngressProxyAfterStateChange();
      return;
    }
    const req = assertDnsProviderApplyRequest(input);
    const dir = this.acmeDnsSecretDir;
    const dirStat = await lstat(dir).catch(() => null);
    if (!dirStat?.isDirectory() || dirStat.uid !== this.executorUid) {
      throw new ExecutorCodedError(
        "DNS provider secret directory is missing or not owned by the executor. Run bootstrap first",
        "HOST_POLICY_DENIED",
      );
    }
    let credsChanged = false;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!Object.hasOwn(req.credentials, entry.name)) {
        credsChanged = true;
        await overwriteAndUnlinkSecretFile(path.join(dir, entry.name));
      }
    }
    for (const [name, value] of Object.entries(req.credentials)) {
      const file = path.join(dir, name);
      if ((await readFile(file, "utf8").catch(() => null)) === value) continue;
      credsChanged = true;
      // No trailing newline: lego strips it, but the exact value keeps the change check exact.
      await writeFileAtomically(file, value, 0o400, 0o700);
    }
    try {
      await this.ingressManager.setDnsProviderState(dnsProviderState(req));
      // Without a panel there is no le-dns: the state waits on disk for the proxy a site deploy creates.
      if (this.panel === null) return;
      const before = (await this.inspectContainerByNameOrId(this.ingressProxyContainerName))?.Id;
      await this.ensureIngressProxyAfterStateChange();
      const after = (await this.inspectContainerByNameOrId(this.ingressProxyContainerName))?.Id;
      // lego caches its client: a rotated credential needs a restart unless the proxy was recreated.
      // Without HP_ACME_EMAIL there is no le-dns and the proxy does not mount the files.
      if (credsChanged && this.panel?.acmeEmail && before && after === before) {
        await restartContainerByName(
          this.execTarget,
          this.ingressProxyContainerName,
          PANEL_RESTART_STOP_SECONDS.ingress_proxy,
        );
      }
    } catch (err) {
      // Otherwise the next identical apply sees "unchanged" and the proxy keeps the old credentials.
      if (credsChanged) await this.wipeDnsProviderFiles();
      throw err;
    }
  }

  /** Applies run one after the other (a queue, not de-dup: two configs are never merged). */
  public applyMailRelay(req: MailRelayApplyRequest | null): Promise<void> {
    this.panelQueued.mail_relay += 1;
    const run = this.mailRelayQueue
      .then(() => this.panelRestarts.get("mail_relay"))
      .then(() => this.applyMailRelayNow(req))
      .finally(() => (this.panelQueued.mail_relay -= 1));
    this.mailRelayQueue = run.catch(() => undefined);
    return run;
  }

  private async applyMailRelayNow(req: MailRelayApplyRequest | null): Promise<void> {
    const secretFile = path.join(this.mailRelaySecretDir, MAIL_RELAY_SASL_FILE);
    if (req === null) {
      // Wipe first: a failed removal must not leave the credentials on tmpfs.
      await overwriteAndUnlinkSecretFile(secretFile);
      const existing = await this.inspectContainerByNameOrId(MAIL_RELAY_CONTAINER_NAME);
      if (existing) {
        await this.stopAndRemoveContainer(existing.Id);
      }
      // The spool volume is kept: queued mail survives a disable/enable.
      return;
    }

    const dirStat = await lstat(this.mailRelaySecretDir).catch(() => null);
    if (!dirStat?.isDirectory() || dirStat.uid !== this.executorUid) {
      throw new ExecutorCodedError(
        "Mail relay secret directory is missing or not owned by the executor. Run bootstrap first",
        "HOST_POLICY_DENIED",
      );
    }
    const payload = buildMailRelayContainerPayload({
      req,
      myHostname: this.panel?.hostname ?? "hp-mail.localdomain",
      secretDirHostPath: this.mailRelaySecretDir,
    });
    const saslLine = buildMailRelaySaslLine(req);
    const secretChanged = (await readFile(secretFile, "utf8").catch(() => null)) !== saslLine;
    await writeFileAtomically(secretFile, saslLine, 0o444, 0o755);
    let mustStart: boolean;
    try {
      mustStart = await this.ensureMailRelayContainer(payload, secretChanged);
    } catch (err) {
      // Otherwise the next identical apply sees "unchanged" and the relay keeps the old credentials.
      if (secretChanged) {
        await overwriteAndUnlinkSecretFile(secretFile);
      }
      throw err;
    }
    if (mustStart || secretChanged) {
      await this.flushMailRelayQueue();
    }

    await this.reconnectToRoleNetworks("site_internal", MAIL_RELAY_CONTAINER_NAME, [
      MAIL_RELAY_ALIAS,
    ]);
  }

  private async readMailDeliveries(sinceSec: number, timeoutMs?: number): Promise<MailDelivery[]> {
    const res = await this.dockerClient.request(
      "GET",
      `/containers/${encodeURIComponent(MAIL_RELAY_CONTAINER_NAME)}/logs?stdout=1&stderr=1&timestamps=1&since=${String(sinceSec)}&tail=5000`,
      undefined,
      timeoutMs === undefined ? undefined : { timeoutMs },
    );
    if (res.statusCode !== 200) {
      throw new ExecutorCodedError(
        `Failed to read mail relay logs (HTTP ${String(res.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
    return parsePostfixDeliveries(demuxDockerLogStream(res.body));
  }

  public async getMailRelayStatus(req: { since: string }): Promise<{
    present: boolean;
    running: boolean;
    sentCount: number;
    failures: MailFailureDto[];
  }> {
    const existing = await this.inspectContainerByNameOrId(MAIL_RELAY_CONTAINER_NAME);
    if (!existing) {
      return { present: false, running: false, sentCount: 0, failures: [] };
    }
    const sinceMs = Date.parse(req.since);
    const deliveries = await this.readMailDeliveries(Math.floor(sinceMs / 1000));
    return {
      present: true,
      running: existing.State?.Running === true,
      ...summarizeMailDeliveries(deliveries, sinceMs),
    };
  }

  /** The relay's bridge address, or null when it is not running. */
  async #mailRelayIp(): Promise<string | null> {
    const relay = await this.inspectContainerByNameOrId(MAIL_RELAY_CONTAINER_NAME);
    const ip = (relay?.NetworkSettings?.Networks?.[MAIL_RELAY_NETWORK_NAME] as
      | { IPAddress?: string }
      | undefined)?.IPAddress;
    return relay?.State?.Running === true && ip ? ip : null;
  }

  public async sendPanelMail(req: PanelMailRequest): Promise<PanelMailResult> {
    return deliverPanelMail(
      await this.#mailRelayIp(),
      this.mailSubmitPort,
      this.panel?.hostname ?? "hp-mail.localdomain",
      req,
    );
  }

  public async sendTestMail(req: { to: string; from: string }): Promise<MailTestResult> {
    const ip = await this.#mailRelayIp();
    if (!ip) {
      throw new ExecutorCodedError("Mail relay is not running", "MAIL_RELAY_UNAVAILABLE");
    }
    const startedMs = Date.now();
    const { queueId } = await submitLocalMail({
      host: ip,
      port: this.mailSubmitPort,
      heloName: this.panel?.hostname ?? "hp-mail.localdomain",
      from: req.from,
      to: req.to,
      subject: "Email di prova dal pannello / Test email from the hosting panel",
      text:
        "Questa è un'email di prova inviata dal pannello di hosting.\n" +
        "This is a test email sent by the hosting panel.\n",
      timeoutMs: 5_000,
    });
    const deadline = Date.now() + this.mailTestWaitMs;
    for (;;) {
      // Bounded by the remaining budget so a slow daemon cannot stretch the call.
      const found = (
        await this.readMailDeliveries(
          Math.floor(startedMs / 1000) - 1,
          Math.max(1_000, Math.min(5_000, deadline - Date.now())),
        )
      )
        .filter((d) => d.queueId === queueId)
        .at(-1);
      if (found) {
        return {
          outcome: found.status,
          problem: found.problem,
          detail: found.status === "sent" ? null : found.detail,
        };
      }
      if (Date.now() >= deadline) {
        return { outcome: "pending", problem: null, detail: null };
      }
      await new Promise((resolve) => setTimeout(resolve, this.mailTestPollMs));
    }
  }

  /** Creates, starts or restarts the relay as needed; true when it was (re)created or started. */
  private async ensureMailRelayContainer(
    payload: ReturnType<typeof buildMailRelayContainerPayload>,
    secretChanged: boolean,
  ): Promise<boolean> {
    await this.ensureNetwork(MAIL_RELAY_NETWORK_NAME, {
      internal: false,
      labels: {
        [MANAGED_DOCKER_LABELS.managed]: "true",
        "io.hostingpanel.network_role": "mail_relay",
      },
    });
    await this.ensureVolume(MAIL_RELAY_SPOOL_VOLUME);
    await this.ensureImageAvailable(MAIL_RELAY_IMAGE);

    const existing = await this.inspectContainerByNameOrId(MAIL_RELAY_CONTAINER_NAME);
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
        `/containers/create?name=${encodeURIComponent(MAIL_RELAY_CONTAINER_NAME)}`,
        payload,
      );
      if (createRes.statusCode !== 201) {
        throw new ExecutorCodedError(
          `Failed to create mail relay container (HTTP ${String(createRes.statusCode)})`,
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }
      containerId = (JSON.parse(createRes.body.toString("utf8")) as { Id: string }).Id;
    }

    // A (re)start reads the new sasl_passwd anyway; only a running, kept container needs a restart.
    const mustStart = !existing || needsRecreate || existing.State?.Running !== true;
    if (mustStart) {
      const startRes = await this.dockerClient.request("POST", `/containers/${containerId}/start`);
      if (startRes.statusCode !== 204 && startRes.statusCode !== 304) {
        throw new ExecutorCodedError(
          `Failed to start mail relay container (HTTP ${String(startRes.statusCode)})`,
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }
    } else if (secretChanged) {
      const restartRes = await this.dockerClient.request(
        "POST",
        `/containers/${encodeURIComponent(MAIL_RELAY_CONTAINER_NAME)}/restart?t=10`,
      );
      if (restartRes.statusCode !== 204) {
        throw new ExecutorCodedError(
          `Failed to restart mail relay container (HTTP ${String(restartRes.statusCode)})`,
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }
    }
    return mustStart;
  }

  /** Best effort: Postfix may still be starting. The queue's own backoff delivers later anyway. */
  private async flushMailRelayQueue(): Promise<void> {
    const deadline = Date.now() + this.mailRelayFlushWaitMs;
    for (;;) {
      const exitCode = await this.execInContainer(
        MAIL_RELAY_CONTAINER_NAME,
        ["postqueue", "-f"],
        deadline,
      ).catch(() => -1);
      if (exitCode === 0) {
        return;
      }
      if (exitCode === null) {
        break; // still running at the deadline: never start a second one
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, remaining)));
    }
    console.warn(
      JSON.stringify({
        component: "hp-docker-executor",
        event: "mail_relay_flush_failed",
        timestamp: new Date().toISOString(),
      }),
    );
  }

  /** Runs a fixed command detached; its exit code, or null if it is still running at the deadline. */
  private async execInContainer(
    containerRef: string,
    cmd: readonly string[],
    deadline: number,
  ): Promise<number | null> {
    const budget = () => ({ timeoutMs: Math.max(1, deadline - Date.now()) });
    const createRes = await this.dockerClient.request(
      "POST",
      `/containers/${encodeURIComponent(containerRef)}/exec`,
      { Cmd: cmd, AttachStdout: false, AttachStderr: false },
      budget(),
    );
    if (createRes.statusCode !== 201) {
      throw new ExecutorCodedError(
        `Failed to create exec (HTTP ${String(createRes.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
    const execId = encodeURIComponent(
      (JSON.parse(createRes.body.toString("utf8")) as { Id: string }).Id,
    );
    const startRes = await this.dockerClient.request(
      "POST",
      `/exec/${execId}/start`,
      { Detach: true },
      budget(),
    );
    if (startRes.statusCode !== 200) {
      throw new ExecutorCodedError(
        `Failed to start exec (HTTP ${String(startRes.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
    for (;;) {
      const res = await this.dockerClient.request(
        "GET",
        `/exec/${execId}/json`,
        undefined,
        budget(),
      );
      if (res.statusCode !== 200) {
        throw new ExecutorCodedError(
          `Failed to inspect exec (HTTP ${String(res.statusCode)})`,
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }
      const state = JSON.parse(res.body.toString("utf8")) as {
        Running?: boolean;
        ExitCode?: number | null;
      };
      if (state.Running !== true) {
        return state.ExitCode ?? -1;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, remaining)));
    }
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
    await this.panelRestarts.get("shared_database");
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
        { ...payload, HostConfig: { ...payload.HostConfig, LogConfig: ROTATED_LOG_CONFIG } },
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
    // 404 = the relay is not created yet; the API applies the mail settings later.
    await this.connectContainerToNetwork(
      siteNetworkName,
      MAIL_RELAY_CONTAINER_NAME,
      [MAIL_RELAY_ALIAS],
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

    if (spec.siteMail === true) {
      await ensureSiteMailFiles(this.siteMailDir);
    }
    // Absent phpIni: nothing is read, written or removed. A stale file is not bound and goes with the service.
    const phpIni = spec.phpIni !== undefined && Object.keys(spec.phpIni).length > 0 ? spec.phpIni : undefined;
    if (phpIni) {
      await writeSitePhpIni(this.sitePhpDir, spec.serviceInstanceId, phpIni);
    }
    const createPayload = buildHardenedContainerCreatePayload(spec, {
      secretBinds,
      secretFileEnv,
      ...(spec.siteMail === true ? { siteMailBinds: siteMailBinds(this.siteMailDir) } : {}),
      ...(phpIni ? { sitePhpBinds: sitePhpBinds(this.sitePhpDir, spec.serviceInstanceId) } : {}),
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
      await this.connectContainerToNetwork(edgeNetworkName, this.ingressProxyContainerName);

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
          this.ingressProxyContainerName,
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

  /** Worst case: pull 240 s + the kind's wait (240 s, or its own limit) + ~20 s of create, logs and remove, inside the client's wait (510 s, or limit + 300 s). */
  public async runSiteJob(req: SiteJobRequest): Promise<SiteJobResult> {
    assertValidSiteJobRequest(req); // jobId, ids, params and secrets, before anything touches Docker
    const lockKey = `${req.siteId}:${req.kind}`;
    if (this.runningSiteJobs.has(lockKey)) {
      throw new ExecutorCodedError("This setup step is already running for the site", "RESOURCE_LOCKED");
    }
    this.runningSiteJobs.add(lockKey);
    let containerId: string | null = null;
    try {
      if (req.kind.startsWith("wordpress.")) {
        const image = resolveWordpressCliImage(req.params.phpVersion as PhpVersion);
        if (req.kind === "wordpress.reset-password") {
          // Never pull here: the reset must answer inside the client's 75 s.
          const imageRes = await this.dockerClient.request("GET", `/images/${encodeURIComponent(image)}/json`);
          if (imageRes.statusCode !== 200) {
            throw new ExecutorCodedError(
              "The site tools are not ready yet. Retry in a few minutes",
              "DOCKER_ENGINE_UNAVAILABLE",
            );
          }
        } else {
          await this.ensureImageAvailable(image);
        }
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
      const spec = SITE_JOB_SPECS[req.kind];
      if (spec.edgeNetwork) {
        // A missing edge network is not an error: the job runs offline and reports updates as unknown.
        // Look first: the engine accepts a connect of a created container to a missing network, then fails the start.
        const edge = getSiteEdgeNetworkName(req.siteId);
        const edgeRes = await this.dockerClient.request("GET", `/networks/${encodeURIComponent(edge)}`);
        const edgeFailed = new ExecutorCodedError(
          "Could not connect the site tools to the internet",
          "DOCKER_ENGINE_UNAVAILABLE",
        );
        if (edgeRes.statusCode === 200) {
          await this.connectContainerToNetwork(edge, id, undefined, { skipMissingNetwork: true }).catch(() => {
            throw edgeFailed;
          });
        } else if (edgeRes.statusCode !== 404) {
          throw edgeFailed;
        }
      }
      const startRes = await this.dockerClient.request("POST", `/containers/${id}/start`);
      if (startRes.statusCode !== 204 && startRes.statusCode !== 304) {
        throw new ExecutorCodedError(
          `Failed to start site job container (HTTP ${String(startRes.statusCode)})`,
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }

      const exitCode = await this.waitForSiteJob(id, Math.min(siteJobTimeoutMs(req.kind), this.jobTimeoutMs ?? Infinity));
      // A kind with a result keeps stdout for it alone; the tail then comes from stderr.
      const logsRes = await this.dockerClient.request(
        "GET",
        `/containers/${id}/logs?stdout=${spec.result ? "0" : "1"}&stderr=1&tail=50`,
      );
      const outputTail =
        logsRes.statusCode === 200 ? formatSiteJobOutputTail(logsRes.body, req.resolvedSecrets) : "";
      if (!spec.result) {
        return { jobId: req.jobId, exitCode, outputTail };
      }
      const outRes = await this.dockerClient.request("GET", `/containers/${id}/logs?stdout=1&stderr=0`);
      const stdout = outRes.statusCode === 200 ? readJobStdout(outRes.body, WORDPRESS_RESULT_MAX_BYTES) : null;
      const result = stdout === null ? undefined : parseWordpressJobResult(req.kind, stdout);
      return { jobId: req.jobId, exitCode, outputTail, ...(result ? { result } : {}) };
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

  private async waitForSiteJob(containerId: string, limitMs: number): Promise<number> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), limitMs);
    });
    try {
      // Our own timer decides the timeout: a socket timeout would read as DOCKER_ENGINE_UNAVAILABLE.
      const res = await Promise.race([
        this.dockerClient.request("POST", `/containers/${containerId}/wait`, undefined, {
          timeoutMs: limitMs + 15_000,
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

  public siteFiles<R extends SiteFilesRequest>(req: R): Promise<SiteFilesResult<R["op"]>> {
    return this.siteFilesHelpers.run(req);
  }

  public siteDatabases<R extends SiteDatabasesRequest>(
    req: R,
  ): Promise<SiteDatabasesResult<R["op"]>> {
    return this.databases.run(req);
  }

  /** One pass over old site database accounts (R207 data.2); main.ts calls it once the shared database is ready. */
  public upgradeDatabaseAccounts(): ReturnType<SiteDatabasesRunner["upgradeAccounts"]> {
    return this.databases.upgradeAccounts();
  }

  public backups<R extends BackupsIpcRequest>(
    req: R,
  ): Promise<BackupsResultByAction[R["action"]]> {
    return this.backupRunner.run(req);
  }

  // -- manual TLS (HCP-SPEC-004, arch-tls-ingress D7-D9) -------------------------------------------------------------

  /**
   * Once per process, before the proxy is ensured: re-render the manifest from the persisted state (a crash between
   * state and manifest), then a best-effort GC. A failure here never blocks the proxy (it would block every site).
   */
  private async recoverManualTlsOnce(): Promise<void> {
    if (this.manualTlsRecovered) return;
    // A publish of this process may be probing: reverting its manifest now would fail it spuriously. Retried later.
    if (this.manualPublishesInFlight > 0) return;
    try {
      const recovered = await this.manualTlsStore.recoverAtStart();
      this.manualTlsRecovered = true;
      await this.manualTlsStore.gc(recovered.generation).catch(() => undefined);
    } catch {
      // Retried at the next ensure; Traefik keeps whatever manifest is on disk.
    }
  }

  public async manualTls<R extends ManualTlsIpcRequest>(req: R): Promise<ManualTlsResultByAction[R["action"]]> {
    const parsed = ManualTlsIpcRequestSchema.safeParse(req);
    if (!parsed.success) throw new ExecutorCodedError("Invalid manual TLS payload", "VALIDATION_ERROR");
    const body = parsed.data;
    const store = this.manualTlsStore;
    let result: unknown;
    switch (body.action) {
      case "putVersion":
        result = await store.putVersion({
          versionId: body.versionId,
          fullchainPem: body.fullchainPem,
          keyPem: body.keyPem,
          fingerprintSha256: body.fingerprintSha256,
        });
        break;
      case "publish": {
        this.manualPublishesInFlight += 1;
        const run = this.manualTlsQueue.then(() => this.publishManualTls(body));
        this.manualTlsQueue = run.catch(() => undefined);
        try {
          result = await run;
        } finally {
          this.manualPublishesInFlight -= 1;
        }
        break;
      }
      case "probe":
        result = { served: await this.probeManualHosts(body.hostnames) };
        break;
      case "inventory": {
        const inventory = await store.inventory();
        const acme = await readAcmeStoreEntries(this.acmeStorePath());
        result = {
          generation: inventory.generation,
          verified: inventory.verified,
          versions: inventory.versions.map((v) => ({ ...v, names: [...v.names] })),
          entries: inventory.entries.map((e) => ({ versionId: e.versionId, assignedHosts: [...e.assignedHosts] })),
          missing: inventory.missing,
          acme: acme.entries.map((e) => ({ id: e.id, resolver: e.resolver, names: [...e.names], notAfter: e.notAfter })),
        };
        break;
      }
      case "gc":
        result = await store.gc(body.baseGeneration);
        break;
    }
    return result as ManualTlsResultByAction[R["action"]];
  }

  private acmeStorePath(): string {
    return path.join(this.ingressManager.acmeDirPath, acmeStorageFileName(this.panel));
  }

  /** 127.0.0.1:<https port> first; the proxy's hp_ingress_net address (container port 443) when that refuses. */
  private async manualTlsProbeEndpoint(): Promise<{
    host: string;
    port: number;
    fallback?: { host: string; port: number };
  }> {
    const proxy = await this.inspectContainerByNameOrId(this.ingressProxyContainerName).catch(() => null);
    const ip = (proxy?.NetworkSettings?.Networks?.[this.ingressNetworkName] as { IPAddress?: string } | undefined)
      ?.IPAddress;
    return {
      host: "127.0.0.1",
      port: this.ingressHttpsPort ?? DEFAULT_INGRESS_HTTPS_PORT,
      ...(ip ? { fallback: { host: ip, port: DEFAULT_INGRESS_HTTPS_PORT } } : {}),
    };
  }

  private async probeManualHosts(hostnames: readonly string[]): Promise<{ hostname: string; fingerprintSha256: string | null }[]> {
    const endpoint = await this.manualTlsProbeEndpoint();
    const one = async (hostname: string): Promise<string | null> => {
      try {
        return await probeServedFingerprint(endpoint.host, endpoint.port, hostname);
      } catch (error) {
        if (endpoint.fallback && (error as NodeJS.ErrnoException).code === "ECONNREFUSED") {
          return probeServedFingerprint(endpoint.fallback.host, endpoint.fallback.port, hostname).catch(() => null);
        }
        return null;
      }
    };
    const unique = [...new Set(hostnames)];
    return Promise.all(unique.map(async (hostname) => ({ hostname, fingerprintSha256: await one(hostname) })));
  }

  /** What the plan needs: the ACME store as SNI candidates (a store that exists but cannot be read stops everything). */
  private async readAcmeForPlan(needed: boolean): Promise<Awaited<ReturnType<typeof readAcmeStoreEntries>>> {
    const storePath = this.acmeStorePath();
    // Traefik rewrites the file in place: a parse failure is retried a few times before it stops the publish.
    for (let attempt = 0; ; attempt += 1) {
      const size = await stat(storePath).then((info) => info.size, () => null);
      if (size === 0) return { readable: true, entries: [] }; // ensureStaticConfig's empty file: no certificates yet
      const acme = await readAcmeStoreEntries(storePath);
      if (acme.readable || !needed || size === null) return acme;
      if (attempt >= ACME_PLAN_READ_RETRIES) {
        throw new ExecutorCodedError("The ACME certificate store cannot be read; refusing to decide which certificate is served", "CERTIFICATE_APPLY_FAILED");
      }
      await new Promise((resolve) => setTimeout(resolve, ACME_PLAN_READ_RETRY_MS));
    }
  }

  private async publishManualTls(
    req: ManualTlsPublishRequest,
  ): Promise<ManualTlsResultByAction["publish"]> {
    const store = this.manualTlsStore;
    const wanted = normaliseEntries(req.entries);
    const state = await store.readState();
    const generation = state?.generation ?? 0;
    const replay =
      state !== null && generation === req.baseGeneration + 1 && JSON.stringify(state.current.entries) === JSON.stringify(wanted);
    if (!replay && generation !== req.baseGeneration) {
      throw new ManualTlsStoreError("TLS_MANIFEST_CONFLICT", "The manual certificate set changed since it was read");
    }

    const inventory = await store.inventory();
    const names = new Map(inventory.versions.map((v) => [v.versionId, v.names] as const));
    const missing = wanted.map((e) => e.versionId).filter((id) => !names.has(id));
    if (missing.length > 0) {
      throw new ManualTlsStoreError("TLS_VERSION_MISSING", "Certificate versions are missing on the executor", missing);
    }
    const assigned = new Set(wanted.flatMap((e) => e.assignedHosts));
    const entries = wanted.map((e) => ({ versionId: e.versionId, names: names.get(e.versionId)!, assignedHosts: e.assignedHosts }));
    const routed = await this.ingressManager.listRoutedHostnames();
    const guardHosts = routed.filter((h) => !assigned.has(h));

    const acme = await this.readAcmeForPlan(wanted.length > 0);
    const sni = acme.entries.map((e) => ({ id: e.id, source: "acme" as const, names: e.names }));
    const plan = planManualCertificates({ entries, acme: sni, guardHosts });
    const refusal = (violations: readonly SniViolation[], outcome: ManualTlsResultByAction["publish"]["outcome"]) => ({
      generation,
      outcome,
      served: [],
      violations: violations.map((v) => ({ ...v, blockerIds: [...v.blockerIds] })),
      evicted: [],
      collateralHosts: [],
    });
    const hard = plan.violations.filter((v) => v.kind !== "acme_eviction_required");
    if (hard.length > 0) return refusal(plan.violations, hard.some((v) => v.kind === "manual_overlap") ? "manual_overlap" : "captures_host");
    const evictionHosts = plan.violations.map((v) => v.hostname);
    if (evictionHosts.length > 0 && !req.evictAcme) return refusal(plan.violations, "acme_eviction_required");

    const expectations: ServedExpectation[] = req.expect.flatMap((e) => [
      ...(e.fingerprintSha256 !== undefined ? [{ hostname: e.hostname, fingerprintSha256: e.fingerprintSha256 }] : []),
      ...(e.notFingerprintSha256 !== undefined ? [{ hostname: e.hostname, notFingerprintSha256: e.notFingerprintSha256 }] : []),
    ]);

    if (evictionHosts.length === 0) {
      const { generation: published } = await store.publishFiles(req.baseGeneration, wanted);
      return this.verifyManualPublish(published, req.expect.map((e) => e.hostname), expectations, [], []);
    }
    return this.publishManualColdPath({ req, wanted, entries, guardHosts, evictionHosts });
  }

  /** Probe, then verified (served) or reverted (not_served_reverted). The served list is what the probe observed. */
  private async verifyManualPublish(
    generation: number,
    hostnames: readonly string[],
    expectations: readonly ServedExpectation[],
    evicted: ManualTlsResultByAction["publish"]["evicted"],
    collateralHosts: readonly string[],
  ): Promise<ManualTlsResultByAction["publish"]> {
    const store = this.manualTlsStore;
    const endpoint = await this.manualTlsProbeEndpoint();
    const report = expectations.length === 0 ? { served: true, observed: {} as Record<string, string | null> } : await waitForServed(expectations, { ...endpoint, ...this.manualTlsProbe });
    const served = [...new Set(hostnames)].map((hostname) => ({ hostname, fingerprintSha256: report.observed[hostname] ?? null }));
    if (report.served) await store.markVerified(generation);
    else await store.revertToLastVerified();
    return {
      generation,
      outcome: report.served ? "served" : "not_served_reverted",
      served,
      violations: [],
      evicted: [...evicted],
      collateralHosts: [...collateralHosts],
    };
  }

  /**
   * Administrator-confirmed cold path (D8): stop hp_ingress_proxy (t=5), evict from acme.json with a backup, publish
   * the files, start; a failed start restores the backup. Serialised with ensureIngressProxy and panel restarts.
   */
  private async publishManualColdPath(input: ManualColdInput): Promise<ManualTlsResultByAction["publish"]> {
    while (this.ingressEnsureInFlight) await this.ingressEnsureInFlight.catch(() => undefined);
    if (this.panelRestarts.has("ingress_proxy")) {
      throw new ExecutorCodedError("The ingress proxy is busy; try again shortly", "RESOURCE_LOCKED");
    }
    const run = this.coldManualPublish(input);
    this.panelRestarts.set("ingress_proxy", run.then(() => undefined, () => undefined));
    try {
      return await run;
    } finally {
      this.panelRestarts.delete("ingress_proxy");
    }
  }

  private async setProxyRunning(running: boolean): Promise<void> {
    const res = await this.dockerClient.request(
      "POST",
      running
        ? `/containers/${this.ingressProxyContainerName}/start`
        : `/containers/${this.ingressProxyContainerName}/stop?t=${String(PANEL_RESTART_STOP_SECONDS.ingress_proxy)}`,
    );
    if (res.statusCode !== 204 && res.statusCode !== 304) {
      throw new ExecutorCodedError(
        `The Docker Engine did not ${running ? "start" : "stop"} the ingress proxy (HTTP ${String(res.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
  }

  private async coldManualPublish(input: ManualColdInput): Promise<ManualTlsResultByAction["publish"]> {
    const { req, wanted, entries } = input;
    const store = this.manualTlsStore;
    const storePath = this.acmeStorePath();
    if ((await this.inspectContainerByNameOrId(this.ingressProxyContainerName)) === null) {
      throw new ExecutorCodedError("The ingress proxy does not exist", "CERTIFICATE_APPLY_FAILED");
    }
    const expectations: ServedExpectation[] = req.expect.flatMap((e) => [
      ...(e.fingerprintSha256 !== undefined ? [{ hostname: e.hostname, fingerprintSha256: e.fingerprintSha256 }] : []),
      ...(e.notFingerprintSha256 !== undefined ? [{ hostname: e.hostname, notFingerprintSha256: e.notFingerprintSha256 }] : []),
    ]);
    const hostnames = req.expect.map((e) => e.hostname);

    let backupPath: string | null = null;
    let evicted: ManualTlsResultByAction["publish"]["evicted"];
    let collateral: string[];
    let generation: number;
    try {
      // Inside the try: a stop that errors after Docker stopped the container still ends with a start below.
      await this.setProxyRunning(false);
      // The store is stable now (Traefik rewrites it in place): plan again on exactly what will remain.
      const acme = await readAcmeStoreEntries(storePath);
      const hosts = input.evictionHosts.map((h) => h.toLowerCase());
      const dropped = acme.entries.filter((e) => e.names.some((name) => hosts.some((h) => traefikNameMatches(h, name))));
      const droppedIds = new Set(dropped.map((e) => e.id));
      const assigned = new Set(wanted.flatMap((e) => e.assignedHosts));
      collateral = [
        ...new Set(dropped.flatMap((e) => e.names).map((n) => n.toLowerCase()).filter((n) => !n.startsWith("*") && !assigned.has(n))),
      ].sort();
      const replan = planManualCertificates({
        entries,
        acme: acme.entries.filter((e) => !droppedIds.has(e.id)).map((e) => ({ id: e.id, source: "acme" as const, names: e.names })),
        guardHosts: [...new Set([...input.guardHosts, ...collateral])],
      });
      if (replan.violations.length > 0) {
        await this.setProxyRunning(true);
        return {
          generation: (await store.readState())?.generation ?? 0,
          outcome: replan.violations.some((v) => v.kind === "manual_overlap") ? "manual_overlap" : "captures_host",
          served: [],
          violations: replan.violations.map((v) => ({ ...v, blockerIds: [...v.blockerIds] })),
          evicted: [],
          collateralHosts: [],
        };
      }
      const eviction = await evictAcmeEntries(storePath, hosts, new Date());
      backupPath = eviction.backupPath;
      evicted = eviction.evicted.map((e) => ({ resolver: e.resolver, main: e.main }));
      generation = (await store.publishFiles(req.baseGeneration, wanted)).generation;
    } catch (error) {
      // Nothing was served from the changed store yet: put the backup back and bring the proxy up again.
      const restored = backupPath ? await this.restoreAcmeBackup(backupPath, storePath).then(() => true, () => false) : true;
      await this.setProxyRunning(true); // a proxy that stays down is an error, never swallowed
      if (!restored) {
        throw new ExecutorCodedError("The ACME certificate store could not be restored after a failed apply", "CERTIFICATE_APPLY_FAILED");
      }
      if (error instanceof AcmeStoreError) {
        throw new ExecutorCodedError("The ACME certificate store cannot be edited safely", "CERTIFICATE_APPLY_FAILED");
      }
      throw error;
    }

    try {
      await this.setProxyRunning(true);
    } catch {
      // The proxy did not come back with the new store: old store, old certificates, start again (D8).
      await store.revertToLastVerified().catch(() => undefined);
      if (backupPath) await this.restoreAcmeAndStart(backupPath, storePath);
      else await this.setProxyRunning(true);
      return { generation, outcome: "start_failed_restored", served: [], violations: [], evicted: [], collateralHosts: [] };
    }
    const result = await this.verifyManualPublish(generation, hostnames, expectations, evicted, collateral);
    if (result.outcome === "not_served_reverted" && backupPath) {
      // The manifest is back; the ACME entries must come back too, or those hosts are re-ordered from Let's Encrypt.
      try {
        await this.setProxyRunning(false);
      } finally {
        await this.restoreAcmeAndStart(backupPath, storePath);
      }
      // acme.json is back as it was: nothing was evicted, nobody lost a certificate.
      return { ...result, evicted: [], collateralHosts: [] };
    }
    return result;
  }

  /** Puts acme.json back, then always attempts the proxy start; a failure of either is reported (both when both). */
  private async restoreAcmeAndStart(backupPath: string, storePath: string): Promise<void> {
    let restoreFailed = false;
    let startError: unknown;
    try {
      await this.restoreAcmeBackup(backupPath, storePath);
    } catch {
      restoreFailed = true;
    }
    try {
      await this.setProxyRunning(true);
    } catch (error) {
      startError = error;
    }
    if (restoreFailed) {
      throw new ExecutorCodedError(
        `The ACME certificate store could not be restored after a failed apply${startError ? " and the ingress proxy did not start" : ""}`,
        "CERTIFICATE_APPLY_FAILED",
      );
    }
    if (startError) throw startError;
  }

  private async restoreAcmeBackup(backupPath: string, storePath: string): Promise<void> {
    await writeFileAtomically(storePath, await readFile(backupPath), 0o600);
  }

  /** Fetches the newest panel copy into `panelDumpDir` (used by the panel-fetch CLI). */
  public fetchPanelCopy(
    target: BackupTarget | LocalPanelRepoSource,
    panelDumpDir: string,
    signal?: AbortSignal,
  ): Promise<PanelFetchResult> {
    return this.backupRunner.fetchPanelCopy(target, panelDumpDir, signal);
  }

  /** Settles non-ended restore notes left behind by an interrupted executor before accepting IPC traffic. */
  public settleRestores(): Promise<void> {
    return this.backupRunner.settleRestores();
  }

  /** Clears leftover download archives from before a restart so stale bytes are never served. */
  public emptyArchives(): Promise<void> {
    return this.backupRunner.emptyArchives();
  }

  public ensurePhpMyAdmin(opts?: { ifPresent?: boolean }): Promise<void> {
    const ifPresent = opts?.ifPresent === true;
    const inFlight = this.phpMyAdminEnsureInFlight;
    if (inFlight && (ifPresent || !inFlight.ifPresent)) {
      return inFlight.promise;
    }

    const deps: PhpMyAdminDeps = {
      containerName: this.phpMyAdminContainerName,
      networkName: this.phpMyAdminNetworkName,
      configDir: this.phpMyAdminConfigDir,
      port: this.phpMyAdminPort,
      sharedDbContainerName: this.sharedDbContainerName,
      ensureImageAvailable: (image) => this.ensureImageAvailable(image),
      ensureNetwork: (name, o) => this.ensureNetwork(name, o),
      connectContainerToNetwork: (net, ref, aliases) =>
        this.connectContainerToNetwork(net, ref, aliases),
      inspectContainerByNameOrId: async (ref) => {
        const inspected = await this.inspectContainerByNameOrId(ref);
        if (!inspected) {
          return null;
        }
        return {
          Id: inspected.Id,
          State: { Running: inspected.State?.Running === true },
          Config: {
            ...(inspected.Config?.Labels ? { Labels: { ...inspected.Config.Labels } } : {}),
          },
        };
      },
      stopAndRemoveContainer: (id) => this.stopAndRemoveContainer(id),
      request: (method, endpointPath, body, o) =>
        this.dockerClient.request(method, endpointPath, body, o),
    };

    const run = async (): Promise<void> => {
      await this.panelRestarts.get("phpmyadmin");
      return ensurePhpMyAdminContainer(deps, opts);
    };
    // Serialize behind an in-flight ifPresent check instead of sharing its early return.
    const promise = (inFlight ? inFlight.promise.catch(() => undefined).then(run) : run()).finally(
      () => {
        if (this.phpMyAdminEnsureInFlight?.promise === promise) {
          this.phpMyAdminEnsureInFlight = null;
        }
      },
    );
    this.phpMyAdminEnsureInFlight = { ifPresent, promise };
    return promise;
  }

  public applySftpAccess(req: SftpAccessApplyRequest): Promise<SftpApplyResult> {
    this.panelQueued.sftp += 1;
    const run = this.sftpQueue
      .then(() => this.panelRestarts.get("sftp"))
      .then(() => this.applySftpAccessNow(req))
      .finally(() => (this.panelQueued.sftp -= 1));
    this.sftpQueue = run.catch(() => undefined);
    return run;
  }

  /** Reconciles the platform SFTP container from persisted `state.json` on startup without touching site containers. */
  public ensureSftpFromState(): Promise<SftpApplyResult | null> {
    this.panelQueued.sftp += 1;
    const run = this.sftpQueue
      .then(() => this.panelRestarts.get("sftp"))
      .then(() => this.ensureSftpFromStateNow())
      .finally(() => (this.panelQueued.sftp -= 1));
    this.sftpQueue = run.catch(() => undefined);
    return run;
  }

  public async getSftpStatus(): Promise<SftpStatusReport> {
    const existing = await this.inspectContainerByNameOrId(this.sftpContainerName);
    const hostKeyFingerprint = await readSftpHostKeyFingerprint(this.sftpStateDir);
    return {
      running: existing?.State?.Running === true,
      port: this.sftpPort,
      hostKeyFingerprint,
    };
  }

  private async ensureSftpFromStateNow(): Promise<SftpApplyResult | null> {
    const state = await readSftpState(this.sftpStateDir);
    if (state === null) {
      return null;
    }
    return this.applySftpAccessNow(state);
  }

  private async applySftpAccessNow(req: SftpAccessApplyRequest): Promise<SftpApplyResult> {
    const parsed = SftpAccessApplyIpcRequestSchema.safeParse(req);
    if (!parsed.success) {
      throw new ExecutorCodedError("Invalid SFTP access configuration", "VALIDATION_ERROR");
    }
    const validReq = parsed.data;
    // The edge: an absent key is the legacy type (an older API or a state file written before it).
    const typeOf = (user: SftpAccessUser): ExecutorSiteType => this.resolveSiteType(user.siteType ?? LEGACY_SITE_TYPE);
    await assertSftpStateDir(this.sftpStateDir, this.executorUid);

    const checkedSites = new Map<string, SftpContainerSiteMount | null>();
    for (const user of validReq.users) {
      if (checkedSites.has(user.siteId)) {
        continue;
      }
      const volumeName = `${this.sftpVolumePrefix}${user.serviceInstanceId}_${typeOf(user).def.files.volumeSuffix}`;
      assertSafeIdentifier(volumeName, "sftpVolume");
      const volumeRes = await this.dockerClient.request(
        "GET",
        `/volumes/${encodeURIComponent(volumeName)}`,
      );
      if (volumeRes.statusCode === 200) {
        checkedSites.set(user.siteId, { siteId: user.siteId, volume: volumeName });
      } else if (volumeRes.statusCode === 404) {
        checkedSites.set(user.siteId, null);
      } else {
        throw new ExecutorCodedError(
          `Failed to inspect SFTP site volume (HTTP ${String(volumeRes.statusCode)})`,
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }
    }

    const activeSites: SftpContainerSiteMount[] = [];
    for (const mount of checkedSites.values()) {
      if (mount !== null) {
        activeSites.push(mount);
      }
    }
    const renderedUsers: SftpAccessUser[] = validReq.users.filter(
      (user) => checkedSites.get(user.siteId) !== null,
    );

    if (renderedUsers.length === 0) {
      const emptyPlan = (await hasSftpHostKey(this.sftpStateDir))
        ? await prepareSftpStatePlan(this.sftpStateDir, this.executorUid, [], typeOf)
        : null;
      const existing = await this.inspectContainerByNameOrId(this.sftpContainerName);
      if (existing) {
        // Stop sshd before changing user files so open sessions of deleted or re-passworded users end and sshd never reads a half-written user/site line.
        await this.stopAndRemoveContainer(existing.Id);
      }
      if (emptyPlan) {
        await commitSftpStatePlan(emptyPlan, { writeState: false });
      }
      await writeSftpState(this.sftpStateDir, validReq.users);
      return { applied: 0 };
    }

    const plan = await prepareSftpStatePlan(this.sftpStateDir, this.executorUid, renderedUsers, typeOf);
    const { payload, configSha256 } = buildSftpContainerPayload({
      image: SFTP_IMAGE,
      stateDir: this.sftpStateDir,
      hostIp: this.sftpHostIp,
      port: this.sftpPort,
      network: this.sftpNetworkName,
      sites: activeSites,
    });
    await this.applySftpPlanAndContainer(plan, payload, configSha256);
    await writeSftpState(this.sftpStateDir, validReq.users);
    return { applied: renderedUsers.length };
  }

  private async stopSftpContainer(containerId: string): Promise<void> {
    const stopRes = await this.dockerClient.request(
      "POST",
      `/containers/${encodeURIComponent(containerId)}/stop?t=5`,
    );
    if (stopRes.statusCode !== 204 && stopRes.statusCode !== 304) {
      throw new ExecutorCodedError(
        `Failed to stop SFTP container (HTTP ${String(stopRes.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
  }

  private async applySftpPlanAndContainer(
    plan: SftpStatePlan,
    payload: SftpContainerCreatePayload,
    configSha256: string,
  ): Promise<void> {
    const existing = await this.inspectContainerByNameOrId(this.sftpContainerName);
    const needsRecreate =
      existing !== null && existing.Config?.Labels?.[SFTP_CONFIG_SHA256_LABEL] !== configSha256;
    const isRunningSameConfig =
      existing !== null && !needsRecreate && existing.State?.Running === true;

    if (isRunningSameConfig && plan.etcReady && plan.userChangeKind === "unchanged") {
      return;
    }

    if (isRunningSameConfig && plan.etcReady && plan.userChangeKind === "append") {
      await commitSftpStatePlan(plan);
      return;
    }

    if (existing && needsRecreate) {
      // Stop sshd before changing user files so open sessions of deleted or re-passworded users end and sshd never reads a half-written user/site line.
      await this.stopAndRemoveContainer(existing.Id);
    } else if (existing && existing.State?.Running === true) {
      // Stop sshd before changing user files so open sessions of deleted or re-passworded users end and sshd never reads a half-written user/site line.
      await this.stopSftpContainer(existing.Id);
    }

    await commitSftpStatePlan(plan);

    await this.ensureNetwork(this.sftpNetworkName, {
      internal: false,
      labels: {
        [MANAGED_DOCKER_LABELS.managed]: "true",
        "io.hostingpanel.network_role": "sftp",
      },
    });

    let containerId = existing?.Id ?? "";
    if (!existing || needsRecreate) {
      await this.ensureImageAvailable(payload.Image);
      const createRes = await this.dockerClient.request(
        "POST",
        `/containers/create?name=${encodeURIComponent(this.sftpContainerName)}`,
        payload,
      );
      if (createRes.statusCode !== 201) {
        throw new ExecutorCodedError(
          `Failed to create SFTP container (HTTP ${String(createRes.statusCode)})`,
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }
      containerId = (JSON.parse(createRes.body.toString("utf8")) as { Id: string }).Id;
    }

    const startRes = await this.dockerClient.request(
      "POST",
      `/containers/${encodeURIComponent(containerId)}/start`,
    );
    if (startRes.statusCode !== 204 && startRes.statusCode !== 304) {
      throw new ExecutorCodedError(
        `Failed to start SFTP container (HTTP ${String(startRes.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
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
    // One container that cannot be removed does not keep the others: the first failure is reported at the end.
    let failure: unknown = null;
    for (const job of JSON.parse(res.body.toString("utf8")) as DockerContainerListSummary[]) {
      await this.stopAndRemoveContainer(job.Id).catch((err: unknown) => {
        failure ??= err;
      });
    }
    const entries = await readdir(this.secretsRootDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("job_")) {
        await purgeServiceSecrets(this.secretsRootDir, entry.name);
      }
    }
    await this.siteFilesHelpers.removeAll();
    await this.backupRunner.removeOrphans();
    if (failure !== null) throw failure;
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
    const isJob = (c: DockerContainerListSummary): boolean => {
      const role = c.Labels?.["io.hostingpanel.role"];
      return role === SITE_JOB_ROLE || role === SITE_FILES_ROLE;
    };
    if (all.some((c) => !isJob(c))) {
      throw new ExecutorCodedError("The site still has a running service", "RESOURCE_LOCKED");
    }
    // Check restore settlement before deleting containers, volumes, or routes so purge never leaves orphaned state.
    await this.backupRunner.forgetSite(siteId);
    for (const job of all) {
      await this.stopAndRemoveContainer(job.Id);
    }

    const internalNet = getSiteInternalNetworkName(siteId);
    const edgeNet = getSiteEdgeNetworkName(siteId);
    await this.disconnectContainerFromNetwork(edgeNet, this.ingressProxyContainerName);
    await this.disconnectContainerFromNetwork(internalNet, SHARED_DB_CONTAINER_NAME);
    await this.disconnectContainerFromNetwork(internalNet, MAIL_RELAY_CONTAINER_NAME);
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
      MAIL_RELAY_IMAGE,
      SFTP_IMAGE,
      PHPMYADMIN_IMAGE,
      RESTIC_IMAGE,
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
        this.ingressProxyContainerName,
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
        this.ingressProxyContainerName,
      ).catch(() => undefined);
    }
  }

  /** See TraefikIngressFileManager.gatePanelCertificate. */
  public async gatePanelCertificate(lookup: PanelDnsLookup): Promise<boolean> {
    return this.panel ? this.ingressManager.gatePanelCertificate(this.panel, lookup) : false;
  }

  public async getCertificateStatus(req: { failuresSince: string }): Promise<CertificateStatusReport> {
    const store = await readAcmeCertificates(
      path.join(this.ingressManager.acmeDirPath, acmeStorageFileName(this.panel)),
    );
    const sinceMs = Date.parse(req.failuresSince);
    const res = await this.dockerClient.request(
      "GET",
      `/containers/${this.ingressProxyContainerName}/logs?stdout=1&stderr=1&since=${String(Math.floor(sinceMs / 1000))}&tail=2000`,
    );
    if (res.statusCode !== 200 && res.statusCode !== 404) {
      throw new ExecutorCodedError(
        `Failed to read ingress proxy logs (HTTP ${String(res.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
    const lines = res.statusCode === 200 ? demuxDockerLogStream(res.body).map((l) => l.text) : [];
    // Best effort: the credential values, so a provider error never echoes one in `detail`.
    const secrets: string[] = [];
    for (const entry of await readdir(this.acmeDnsSecretDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile()) continue;
      const value = await readFile(path.join(this.acmeDnsSecretDir, entry.name), "utf8").catch(() => null);
      if (value) secrets.push(value);
    }
    return {
      acmeEnabled: Boolean(this.panel?.acmeEmail),
      trusted: !this.panel?.acmeStaging && !this.panel?.acmeCaServer,
      readable: store.readable,
      certificates: store.certificates,
      dnsChallenge:
        Boolean(this.panel?.acmeEmail) && (await this.ingressManager.loadDnsProviderState()) !== null,
      failures: parseAcmeFailures(lines, sinceMs, secrets),
    };
  }

  public async getServiceLogs(serviceInstanceId: string, tail: number): Promise<ReturnType<typeof demuxDockerLogStream>> {
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    const summary = await this.findContainerSummaryByServiceId(serviceInstanceId);
    if (!summary) {
      throw new ExecutorCodedError("Managed service container not found", "NOT_FOUND");
    }
    return this.readContainerLogs(summary.Id, tail);
  }

  /** Last lines of one container by name or id (tail clamped to 1..500); NOT_FOUND on 404. */
  public async readContainerLogs(nameOrId: string, tail: number): Promise<ServiceLogLine[]> {
    const n = Math.min(500, Math.max(1, Math.trunc(tail) || 1));
    const res = await this.dockerClient.request(
      "GET",
      `/containers/${encodeURIComponent(nameOrId)}/logs?stdout=1&stderr=1&timestamps=1&tail=${String(n)}`,
      undefined,
      // shortcut: past the cap the newest lines of the tail are cut, read again with a smaller tail if customers ask.
      { maxBodyBytes: LOG_READ_MAX_BYTES },
    );
    if (res.statusCode === 404) {
      throw new ExecutorCodedError("Container not found", "NOT_FOUND");
    }
    if (res.statusCode !== 200) {
      throw new ExecutorCodedError(
        `Failed to read service logs (HTTP ${String(res.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
    return demuxDockerLogStream(res.body);
  }

  /** State of one container by name, in the closed panel words; a 404 is `missing`. */
  public async inspectPanelContainer(
    name: string,
    pin: string,
  ): Promise<{ state: PanelContainerState; startedAt: string | null; restartCount: number; imageCurrent: boolean | null }> {
    const inspect = await this.inspectContainerByNameOrId(name);
    if (!inspect) {
      return { state: "missing", startedAt: null, restartCount: 0, imageCurrent: null };
    }
    const mapped = mapContainerStateToObservedStatus(inspect.State);
    const state = PANEL_CONTAINER_STATES.find((s) => s === mapped && s !== "missing") ?? "unknown";
    // Docker writes 0001-01-01T00:00:00Z for a container that never started.
    const started = Date.parse(inspect.State?.StartedAt ?? "");
    return {
      state,
      startedAt: started > 0 ? new Date(started).toISOString() : null,
      restartCount: inspect.RestartCount ?? 0,
      imageCurrent: inspect.Config?.Image === pin,
    };
  }

  public async getPanelContainers(): Promise<readonly PanelContainerStatus[]> {
    const [seen, sftpState, relaySecret] = await Promise.all([
      Promise.all(PANEL_CONTAINERS.map((c) => this.inspectPanelContainer(this.panelContainerName(c), this.panelContainerPin(c)))),
      readSftpState(this.sftpStateDir).catch(() => "unreadable" as const),
      stat(path.join(this.mailRelaySecretDir, MAIL_RELAY_SASL_FILE)).then(() => true, () => false),
    ]);
    return PANEL_CONTAINERS.map((component, i) => {
      const status = seen[i]!;
      const exists = status.state !== "missing";
      const expected = {
        ingress_proxy: this.panel !== null || exists,
        shared_database: true,
        phpmyadmin: exists,
        sftp: sftpState === "unreadable" || (sftpState?.users.length ?? 0) > 0,
        mail_relay: relaySecret,
      }[component];
      return { component, ...status, expected };
    });
  }

  public async getPanelContainerLogs(req: {
    readonly component: PanelContainer;
    readonly tail: number;
  }): Promise<readonly ServiceLogLine[]> {
    const parsed = PanelContainerLogsIpcRequestSchema.safeParse(req);
    if (!parsed.success) {
      throw new ExecutorCodedError("Invalid panel logs request", "VALIDATION_ERROR");
    }
    const lines = await this.readContainerLogs(this.panelContainerName(parsed.data.component), parsed.data.tail);
    return parsed.data.component === "phpmyadmin"
      ? lines.map((line) => ({ ...line, text: maskPhpMyAdminQuery(line.text) }))
      : lines;
  }

  /** Restarts one existing panel container by its fixed name; refused while that component is busy. */
  public async restartPanelContainer(req: { readonly component: PanelContainer }): Promise<{ readonly startedAt: string | null }> {
    const parsed = PanelContainerRestartIpcRequestSchema.safeParse(req);
    if (!parsed.success) {
      throw new ExecutorCodedError("Invalid panel restart request", "VALIDATION_ERROR");
    }
    const c = parsed.data.component;
    const busy = {
      ingress_proxy: this.ingressEnsureInFlight !== null,
      shared_database: this.sharedDbEnsureInFlight !== null,
      phpmyadmin: this.phpMyAdminEnsureInFlight !== null,
      sftp: this.panelQueued.sftp > 0,
      mail_relay: this.panelQueued.mail_relay > 0,
    }[c];
    if (busy || this.panelRestarts.has(c)) {
      throw new ExecutorCodedError("This panel container is busy; try again shortly", "RESOURCE_LOCKED");
    }
    const run = restartContainerByName(this.execTarget, this.panelContainerName(c), PANEL_RESTART_STOP_SECONDS[c]);
    const done = run.then(() => undefined, () => undefined);
    this.panelRestarts.set(c, done);
    void done.then(() => this.panelRestarts.delete(c));
    return run;
  }

  /** Re-ensures one existing pinned panel container through its shipped ensure, which recreates it on an image change. */
  public async applyPanelContainerPin(component: PinnedPanelContainer): Promise<PanelContainerStatus> {
    if (!(PINNED_PANEL_CONTAINERS as readonly string[]).includes(component)) {
      throw new ExecutorCodedError("Invalid panel apply request", "VALIDATION_ERROR");
    }
    if (!(await this.inspectContainerByNameOrId(this.panelContainerName(component)))) {
      throw new ExecutorCodedError("Panel container not found", "NOT_FOUND");
    }
    await {
      ingress_proxy: () => this.ensureIngressProxy(),
      shared_database: () => this.ensureSharedDatabase(),
      phpmyadmin: () => this.ensurePhpMyAdmin({ ifPresent: true }),
      sftp: () => this.ensureSftpFromState(),
    }[component]();
    return (await this.getPanelContainers()).find((row) => row.component === component)!;
  }

  /** /bin/sh as the type's file owner in the site's own container; the site label is checked, not trusted. */
  public async openTerminal(req: TerminalOpenRequest): Promise<TerminalOpenResult> {
    assertSafeIdentifier(req.serviceInstanceId, "serviceInstanceId");
    const t = this.resolveSiteType(req.siteType ?? LEGACY_SITE_TYPE); // the edge: absent is the legacy type
    return this.terminals.open(req, async (sink) => {
      const summary = await this.findContainerSummaryByServiceId(req.serviceInstanceId);
      if (!summary || summary.Labels?.[MANAGED_DOCKER_LABELS.siteId] !== req.siteId) {
        throw new ExecutorCodedError("The site container is not running", "NOT_FOUND");
      }
      return startDockerTerminal(this.execTarget, summary.Id, req.sessionId, sink, t);
    });
  }

  public async writeTerminal(req: { readonly sessionId: string; readonly input: string }): Promise<void> {
    this.terminals.write(req);
  }

  public readTerminal(req: { readonly sessionId: string; readonly cursor: number }): Promise<TerminalReadResult> {
    return this.terminals.read(req);
  }

  public closeTerminal(req: { readonly sessionId: string }): Promise<TerminalEnded> {
    return this.terminals.close(req);
  }

  public async listTerminals(): Promise<readonly TerminalSessionRecord[]> {
    return this.terminals.list();
  }

  /** At start: ends the shells a previous executor left in site containers, as each type's file owner, and in components. */
  public async reapTerminalShells(): Promise<void> {
    let failure: unknown = null;
    try {
      // A site container does not carry its type, so each type's user ends the shells it owns.
      for (const key of SITE_TYPE_KEYS) await reapTerminalShells(this.execTarget, this.resolveSiteType(key));
    } catch (err) {
      failure = err; // the components are cleaned all the same
    }
    // A component's shells end as the user the component runs as (ADR-0041).
    await reapAppStackTerminalShells(this.execTarget);
    if (failure !== null) throw failure;
  }

  /**
   * /bin/sh in the container of one component of an application (ADR-0041). The request names no container: the name is
   * derived here, the labels are checked, and the exec sets no user and no folder. No Docker id is returned.
   */
  public async openAppStackTerminal(req: AppStackTerminalOpenIpcRequest): Promise<TerminalOpenResult> {
    return this.terminals.open(req, async (sink) => {
      const { id } = await this.appStackEngine.findAppStackComponentContainer(req);
      return startAppStackTerminal(this.execTarget, id, req.sessionId, sink);
    });
  }

  /** The image each panel container is pinned to. */
  private panelContainerPin(component: PanelContainer): string {
    return {
      ingress_proxy: this.traefikImage,
      shared_database: SHARED_MARIADB_IMAGE,
      phpmyadmin: PHPMYADMIN_IMAGE,
      sftp: SFTP_IMAGE,
      mail_relay: MAIL_RELAY_IMAGE,
    }[component];
  }

  /** The closed map from panel component to container name. */
  private panelContainerName(component: PanelContainer): string {
    return {
      ingress_proxy: this.ingressProxyContainerName,
      shared_database: SHARED_DB_CONTAINER_NAME,
      phpmyadmin: this.phpMyAdminContainerName,
      sftp: this.sftpContainerName,
      mail_relay: MAIL_RELAY_CONTAINER_NAME,
    }[component];
  }

  public async restartService(
    serviceInstanceId: string,
    resolvedSecrets?: Readonly<Record<string, string>>,
  ): Promise<DockerExecutionResult> {
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    const summary = await this.findContainerSummaryByServiceId(serviceInstanceId);
    if (!summary) {
      throw new ExecutorCodedError("Managed service container not found", "NOT_FOUND");
    }

    // #7: the tmpfs files are gone after a reboot or a stop.
    if (resolvedSecrets && Object.keys(resolvedSecrets).length > 0) {
      await writeServiceSecrets(this.secretsRootDir, serviceInstanceId, resolvedSecrets, {
        additive: true,
      });
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
    await removeSitePhpIni(this.sitePhpDir, serviceInstanceId);
    const routeRemoval = await this.ingressManager.removeServiceRoute(
      serviceInstanceId,
      knownSiteId,
    );

    if (routeRemoval.siteId && routeRemoval.remainingSiteRoutes === 0) {
      const edgeNetworkName = getSiteEdgeNetworkName(routeRemoval.siteId);
      await this.disconnectContainerFromNetwork(
        edgeNetworkName,
        this.ingressProxyContainerName,
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
      this.siteMailDir,
      this.sitePhpDir,
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

  /** Without a site the volume is a platform one: deleteSite (by site label) never removes it. */
  private async ensureVolume(
    volumeName: string,
    siteId?: string,
    serviceInstanceId?: string,
  ): Promise<void> {
    const createRes = await this.dockerClient.request("POST", "/volumes/create", {
      Name: volumeName,
      Labels: {
        [MANAGED_DOCKER_LABELS.managed]: "true",
        ...(siteId !== undefined ? { [MANAGED_DOCKER_LABELS.siteId]: siteId } : {}),
        ...(serviceInstanceId !== undefined
          ? { [MANAGED_DOCKER_LABELS.serviceInstanceId]: serviceInstanceId }
          : {}),
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
    return this.reconnectToRoleNetworks("site_edge", this.ingressProxyContainerName);
  }

  private async reconnectToRoleNetworks(
    role: "site_edge" | "site_internal" | "app_edge",
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
    let appEdgeError: unknown;
    for (const network of networks) {
      let connected: boolean;
      try {
        connected = await this.connectContainerToNetwork(network.Name, containerRef, aliases, {
          skipMissingNetwork: true,
        });
      } catch (err) {
        // A failing stack network never keeps the proxy off the others; the caller logs the first error.
        if (role !== "app_edge") throw err;
        appEdgeError ??= err;
        continue;
      }
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
    if (appEdgeError !== undefined) throw appEdgeError;
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
    if (rmRes.statusCode === 409) {
      // With force=true Docker answers 409 only while another removal of this container runs; wait for it.
      for (let waited = 0; ; waited += REMOVAL_IN_PROGRESS_POLL_MS) {
        if ((await this.inspectContainerByNameOrId(containerId)) === null) {
          return;
        }
        if (waited >= REMOVAL_IN_PROGRESS_WAIT_MS) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, REMOVAL_IN_PROGRESS_POLL_MS));
      }
    }
    if (rmRes.statusCode !== 204 && rmRes.statusCode !== 404) {
      throw new ExecutorCodedError(
        `Failed to remove previous container instance (HTTP ${String(rmRes.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
  }
}
