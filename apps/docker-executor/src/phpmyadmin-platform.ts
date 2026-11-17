import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  PHPMYADMIN_IMAGE,
  PHPMYADMIN_UPLOAD_LIMIT_MB,
} from "@hosting-panel/contracts";
import { SHARED_DB_ALIAS, SHARED_DB_CONFIG_SHA256_LABEL } from "./shared-database.js";
import {
  ExecutorCodedError,
  assertSafeIdentifier,
  writeFileAtomically,
} from "./traefik-config.js";

export const PHPMYADMIN_CONTAINER_NAME = "hp_phpmyadmin";
export const PHPMYADMIN_NETWORK_NAME = "hp_pma_net";
export const DEFAULT_PHPMYADMIN_CONFIG_DIR = "/var/lib/hosting-panel/phpmyadmin";
export const PHPMYADMIN_CONFIG_SHA256_LABEL = SHARED_DB_CONFIG_SHA256_LABEL;

const PHPMYADMIN_MEMORY_BYTES = 512 * 1024 * 1024;
const PHPMYADMIN_PIDS_LIMIT = 100;
const PHPMYADMIN_NANO_CPUS = 500_000_000;
const PHPMYADMIN_CONFIG_FILE_NAME = "config.inc.php";
const PHPMYADMIN_CONFIG_CONTAINER_PATH = "/etc/phpmyadmin/config.inc.php";
const PHPMYADMIN_MPM_FILE_NAME = "hp-mpm.conf";
const PHPMYADMIN_MPM_CONTAINER_PATH = "/etc/apache2/conf-enabled/hp-mpm.conf";
const PHPMYADMIN_MAX_WORKERS = 4;
const PHPMYADMIN_DIR_MODE = 0o755;
const PHPMYADMIN_FILE_MODE = 0o644;

const STRICT_HOSTNAME_PATTERN =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function isValidHostname(host: string): boolean {
  return (
    typeof host === "string" &&
    host.length >= 1 &&
    host.length <= 253 &&
    STRICT_HOSTNAME_PATTERN.test(host)
  );
}

function assertValidPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ExecutorCodedError("Invalid phpMyAdmin port", "VALIDATION_ERROR");
  }
  return port;
}

function assertSafeHostBindPath(hostPath: string, label: string): string {
  if (
    typeof hostPath !== "string" ||
    hostPath.length === 0 ||
    hostPath.includes("\0") ||
    hostPath.includes("\r") ||
    hostPath.includes("\n") ||
    hostPath.includes(":") ||
    !path.isAbsolute(hostPath)
  ) {
    throw new ExecutorCodedError(`Invalid ${label}`, "HOST_POLICY_DENIED");
  }

  const segments = hostPath.split("/");
  if (segments.includes("..")) {
    throw new ExecutorCodedError(`Invalid ${label}`, "HOST_POLICY_DENIED");
  }

  const normalized = path.posix.normalize(hostPath);
  if (
    normalized === "/var/run/docker.sock" ||
    normalized === "/run/docker.sock" ||
    path.posix.basename(normalized) === "docker.sock"
  ) {
    throw new ExecutorCodedError(`Forbidden ${label}`, "HOST_POLICY_DENIED");
  }

  return hostPath;
}

function assertValidImageRef(image: string | undefined): string {
  const resolved = image ?? PHPMYADMIN_IMAGE;
  if (typeof resolved !== "string" || resolved.length === 0 || /[\s\0]/.test(resolved)) {
    throw new ExecutorCodedError("Invalid phpMyAdmin image reference", "VALIDATION_ERROR");
  }
  return resolved;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** Renders the locked-down config.inc.php pointing only at the validated internal database host. */
export function renderPhpMyAdminConfig(dbHost: string): string {
  if (!isValidHostname(dbHost)) {
    throw new ExecutorCodedError("Invalid phpMyAdmin database host", "VALIDATION_ERROR");
  }

  return [
    "<?php",
    "// Managed by hp-docker-executor. No secrets.",
    "$cfg['blowfish_secret'] = '';",
    `$cfg['Servers'][1]['host'] = '${dbHost}';`,
    "$cfg['Servers'][1]['port'] = 3306;",
    "$cfg['Servers'][1]['auth_type'] = 'http';",
    "$cfg['Servers'][1]['AllowRoot'] = false;",
    "$cfg['Servers'][1]['AllowNoPassword'] = false;",
    "$cfg['Servers'][1]['hide_db'] = '^(information_schema|mysql|performance_schema|sys)$';",
    "$cfg['AllowArbitraryServer'] = false;",
    "$cfg['VersionCheck'] = false;",
    "$cfg['SendErrorReports'] = 'never';",
    "$cfg['PmaNoRelation_DisableWarning'] = true;",
    "$cfg['ShowChgPassword'] = false;",
    "$cfg['ShowServerInfo'] = false;",
    "$cfg['UploadDir'] = '';",
    "$cfg['SaveDir'] = '';",
    "$cfg['TempDir'] = '/var/www/html/tmp';",
    "$cfg['MemoryLimit'] = '0';",
    "$p = $_SERVER['HTTP_X_FORWARDED_PREFIX'] ?? '';",
    "if (preg_match('#^/phpmyadmin/[A-Za-z0-9_-]{1,128}/$#', $p) === 1) {",
    "    $cfg['PmaAbsoluteUri'] = $p;",
    "}",
    "",
  ].join("\n");
}

/** Renders the Apache prefork cap so concurrent PHP workers fit within the container memory budget. */
function renderPhpMyAdminApacheMpmConfig(): string {
  return [
    "<IfModule mpm_prefork_module>",
    "StartServers 2",
    "MinSpareServers 1",
    "MaxSpareServers 2",
    `MaxRequestWorkers ${String(PHPMYADMIN_MAX_WORKERS)}`,
    "MaxConnectionsPerChild 50",
    "</IfModule>",
    "",
  ].join("\n");
}

/** Builds the hardened Docker create payload and deterministic config+payload SHA-256 hash. */
export function buildPhpMyAdminContainerPayload(input: {
  image?: string;
  containerName: string;
  network: string;
  configFile: string;
  port: number;
  dbHost?: string;
}): { payload: Record<string, unknown>; configSha256: string } {
  const image = assertValidImageRef(input.image);
  assertSafeIdentifier(input.containerName, "phpMyAdmin container name");
  const network = assertSafeIdentifier(input.network, "phpMyAdmin network name");
  const configFile = assertSafeHostBindPath(input.configFile, "phpMyAdmin configuration path");
  const mpmFile = assertSafeHostBindPath(
    path.posix.join(path.posix.dirname(configFile), PHPMYADMIN_MPM_FILE_NAME),
    "phpMyAdmin worker configuration path",
  );
  const port = assertValidPort(input.port);

  const configText = renderPhpMyAdminConfig(input.dbHost ?? SHARED_DB_ALIAS);
  const mpmText = renderPhpMyAdminApacheMpmConfig();

  const basePayload = {
    Image: image,
    User: "33:33",
    ExposedPorts: {
      "80/tcp": {},
    },
    Env: [
      `UPLOAD_LIMIT=${String(PHPMYADMIN_UPLOAD_LIMIT_MB)}M`,
      "MEMORY_LIMIT=64M",
      "MAX_EXECUTION_TIME=300",
    ],
    Labels: {
      "io.hostingpanel.managed": "true",
      "io.hostingpanel.role": "phpmyadmin",
    },
    HostConfig: {
      Privileged: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      ReadonlyRootfs: true,
      Memory: PHPMYADMIN_MEMORY_BYTES,
      MemorySwap: PHPMYADMIN_MEMORY_BYTES,
      PidsLimit: PHPMYADMIN_PIDS_LIMIT,
      NanoCpus: PHPMYADMIN_NANO_CPUS,
      RestartPolicy: { Name: "unless-stopped" },
      LogConfig: {
        Type: "json-file",
        Config: { "max-size": "10m", "max-file": "3" },
      },
      Tmpfs: {
        "/var/run/apache2": "rw,nosuid,nodev,noexec,uid=33,gid=33,mode=0755,size=1m",
        "/sessions": "rw,nosuid,nodev,noexec,uid=33,gid=33,mode=0700,size=8m",
        "/var/www/html/tmp": "rw,nosuid,nodev,noexec,uid=33,gid=33,mode=0700,size=16m",
        "/tmp": "rw,nosuid,nodev,noexec,uid=33,gid=33,mode=1777,size=48m",
      },
      NetworkMode: network,
      PortBindings: {
        "80/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }],
      },
      Binds: [
        `${configFile}:${PHPMYADMIN_CONFIG_CONTAINER_PATH}:ro`,
        `${mpmFile}:${PHPMYADMIN_MPM_CONTAINER_PATH}:ro`,
      ],
    },
  };

  const configSha256 = createHash("sha256")
    .update(JSON.stringify({ payload: basePayload, configText, mpmText }))
    .digest("hex");

  return {
    configSha256,
    payload: {
      ...basePayload,
      Labels: {
        ...basePayload.Labels,
        [PHPMYADMIN_CONFIG_SHA256_LABEL]: configSha256,
      },
    },
  };
}

export interface PhpMyAdminDeps {
  containerName: string;
  networkName: string;
  configDir: string;
  port: number;
  sharedDbContainerName: string;
  dbHost?: string;
  ensureImageAvailable(image: string): Promise<void>;
  ensureNetwork(name: string, o: { internal: boolean; labels: Record<string, string> }): Promise<void>;
  connectContainerToNetwork(net: string, ref: string, aliases?: string[]): Promise<boolean>;
  inspectContainerByNameOrId(
    ref: string,
  ): Promise<{ Id: string; State: { Running: boolean }; Config: { Labels?: Record<string, string> } } | null>;
  stopAndRemoveContainer(id: string): Promise<void>;
  request(method: string, path: string, body?: unknown, o?: { timeoutMs?: number }): Promise<unknown>;
}

async function ensureConfigFileOnHost(
  configDir: string,
  configFile: string,
  configText: string,
): Promise<void> {
  try {
    try {
      const dirStat = await lstat(configDir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        throw new ExecutorCodedError("Invalid phpMyAdmin configuration directory", "HOST_POLICY_DENIED");
      }
    } catch (error) {
      if (error instanceof ExecutorCodedError) {
        throw error;
      }
      if (!isEnoent(error)) {
        throw new ExecutorCodedError("Failed to inspect phpMyAdmin configuration directory", "DOCKER_ENGINE_UNAVAILABLE");
      }
      await mkdir(configDir, { recursive: true, mode: PHPMYADMIN_DIR_MODE });
      await chmod(configDir, PHPMYADMIN_DIR_MODE);
    }

    try {
      const fileStat = await lstat(configFile);
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        throw new ExecutorCodedError("Invalid phpMyAdmin configuration file", "HOST_POLICY_DENIED");
      }
      const current = await readFile(configFile, "utf8");
      if (current === configText) {
        // Fix permissions in place when content already matches so inode stays unchanged.
        if ((fileStat.mode & 0o777) !== PHPMYADMIN_FILE_MODE) {
          await chmod(configFile, PHPMYADMIN_FILE_MODE);
        }
        return;
      }
    } catch (error) {
      if (error instanceof ExecutorCodedError) {
        throw error;
      }
      if (!isEnoent(error)) {
        throw new ExecutorCodedError("Failed to inspect phpMyAdmin configuration file", "DOCKER_ENGINE_UNAVAILABLE");
      }
    }

    await writeFileAtomically(configFile, configText, PHPMYADMIN_FILE_MODE, PHPMYADMIN_DIR_MODE);
    await chmod(configFile, PHPMYADMIN_FILE_MODE);
  } catch (error) {
    if (error instanceof ExecutorCodedError) {
      throw error;
    }
    throw new ExecutorCodedError("Failed to write phpMyAdmin configuration", "DOCKER_ENGINE_UNAVAILABLE");
  }
}

async function runEngineStep<T>(message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ExecutorCodedError && error.code === "NOT_SUPPORTED") {
      throw error;
    }
    throw new ExecutorCodedError(message, "DOCKER_ENGINE_UNAVAILABLE");
  }
}

function parseDockerResponse(raw: unknown): { statusCode: number; body: Buffer } {
  if (typeof raw !== "object" || raw === null) {
    throw new ExecutorCodedError("Unexpected response from Docker Engine", "DOCKER_ENGINE_UNAVAILABLE");
  }
  const candidate = raw as { statusCode?: unknown; body?: unknown };
  if (typeof candidate.statusCode !== "number") {
    throw new ExecutorCodedError("Unexpected response from Docker Engine", "DOCKER_ENGINE_UNAVAILABLE");
  }
  const body = Buffer.isBuffer(candidate.body)
    ? candidate.body
    : typeof candidate.body === "string"
      ? Buffer.from(candidate.body, "utf8")
      : Buffer.alloc(0);
  return { statusCode: candidate.statusCode, body };
}

function extractCreatedContainerId(body: Buffer): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ExecutorCodedError("Invalid create response for phpMyAdmin container", "DOCKER_ENGINE_UNAVAILABLE");
  }
  const id =
    typeof parsed === "object" && parsed !== null ? (parsed as { Id?: unknown }).Id : undefined;
  if (typeof id !== "string" || id.length === 0) {
    throw new ExecutorCodedError("Invalid create response for phpMyAdmin container", "DOCKER_ENGINE_UNAVAILABLE");
  }
  return id;
}

async function startContainer(deps: PhpMyAdminDeps, containerId: string): Promise<void> {
  const startRes = parseDockerResponse(
    await runEngineStep("Failed to start phpMyAdmin container", () =>
      deps.request("POST", `/containers/${encodeURIComponent(containerId)}/start`, undefined),
    ),
  );
  if (startRes.statusCode !== 204 && startRes.statusCode !== 304) {
    throw new ExecutorCodedError("Failed to start phpMyAdmin container", "DOCKER_ENGINE_UNAVAILABLE");
  }
}

/**
 * Ensures the singleton locked-down phpMyAdmin container and network exist and
 * attaches the shared MariaDB container to that network (never restarting MariaDB).
 */
export async function ensurePhpMyAdminContainer(
  deps: PhpMyAdminDeps,
  opts?: { ifPresent?: boolean },
): Promise<void> {
  const containerName = assertSafeIdentifier(deps.containerName, "phpMyAdmin container name");
  const networkName = assertSafeIdentifier(deps.networkName, "phpMyAdmin network name");
  const sharedDbContainerName = assertSafeIdentifier(
    deps.sharedDbContainerName,
    "shared database container name",
  );
  const configDir = assertSafeHostBindPath(deps.configDir, "phpMyAdmin configuration directory");
  const configFile = assertSafeHostBindPath(
    path.posix.join(configDir, PHPMYADMIN_CONFIG_FILE_NAME),
    "phpMyAdmin configuration path",
  );
  const mpmFile = assertSafeHostBindPath(
    path.posix.join(configDir, PHPMYADMIN_MPM_FILE_NAME),
    "phpMyAdmin worker configuration path",
  );
  const port = assertValidPort(deps.port);

  const existing = await runEngineStep("Failed to inspect phpMyAdmin container", () =>
    deps.inspectContainerByNameOrId(containerName),
  );
  if (opts?.ifPresent && !existing) {
    return;
  }

  const dbHost = deps.dbHost ?? SHARED_DB_ALIAS;
  const configText = renderPhpMyAdminConfig(dbHost);
  const mpmText = renderPhpMyAdminApacheMpmConfig();
  const { payload, configSha256 } = buildPhpMyAdminContainerPayload({
    containerName,
    network: networkName,
    configFile,
    port,
    dbHost,
  });

  await ensureConfigFileOnHost(configDir, configFile, configText);
  await ensureConfigFileOnHost(configDir, mpmFile, mpmText);

  await runEngineStep("Failed to ensure phpMyAdmin network", () =>
    deps.ensureNetwork(networkName, {
      internal: false,
      labels: {
        "io.hostingpanel.managed": "true",
        "io.hostingpanel.network_role": "phpmyadmin",
      },
    }),
  );

  const dbConnected = await runEngineStep(
    "Failed to connect shared database container to phpMyAdmin network",
    () => deps.connectContainerToNetwork(networkName, sharedDbContainerName, [dbHost]),
  );
  if (!dbConnected) {
    throw new ExecutorCodedError(
      "Failed to connect shared database container to phpMyAdmin network",
      "DOCKER_ENGINE_UNAVAILABLE",
    );
  }

  const currentHash = existing?.Config?.Labels?.[PHPMYADMIN_CONFIG_SHA256_LABEL];
  const needsRecreate = !existing || currentHash !== configSha256;

  if (needsRecreate) {
    await runEngineStep("Failed to ensure phpMyAdmin image", () =>
      deps.ensureImageAvailable(PHPMYADMIN_IMAGE),
    );
    if (existing) {
      await runEngineStep("Failed to replace outdated phpMyAdmin container", () =>
        deps.stopAndRemoveContainer(existing.Id),
      );
    }

    const createRes = parseDockerResponse(
      await runEngineStep("Failed to create phpMyAdmin container", () =>
        deps.request(
          "POST",
          `/containers/create?name=${encodeURIComponent(containerName)}`,
          payload,
        ),
      ),
    );
    if (createRes.statusCode !== 201) {
      throw new ExecutorCodedError("Failed to create phpMyAdmin container", "DOCKER_ENGINE_UNAVAILABLE");
    }
    const createdId = extractCreatedContainerId(createRes.body);
    await startContainer(deps, createdId);
    return;
  }

  if (!existing.State.Running) {
    await startContainer(deps, existing.Id);
  }
}
