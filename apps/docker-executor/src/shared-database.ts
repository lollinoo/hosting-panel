import { createHash } from "node:crypto";
import { SHARED_MARIADB_IMAGE } from "@hosting-panel/contracts";
import { ExecutorCodedError } from "./traefik-config.js";

export const SHARED_DB_CONTAINER_NAME = "hp_mariadb" as const;
export const SHARED_DB_NETWORK_NAME = "hp_mariadb_net" as const;
export const SHARED_DB_CONFIG_SHA256_LABEL = "io.hostingpanel.config_sha256" as const;
export const SHARED_DB_ALIAS = "hp-mariadb" as const;
export const DEFAULT_SHARED_DB_ADMIN_SUBNET = "172.30.250.0/24" as const;
export const DEFAULT_SHARED_DB_DATA_DIR = "/var/lib/hosting-panel/mariadb/data" as const;
export const DEFAULT_SHARED_DB_ROOT_KEY_FILE = "/etc/hosting-panel/mariadb-root.key" as const;

const SHARED_DB_MEMORY_BYTES = 1073741824;

export interface SharedDatabaseContainerInput {
  readonly image?: string;
  readonly user: string;
  readonly dataDirHostPath: string;
  readonly rootKeyHostPath: string;
  readonly adminSubnet: string;
}

export interface SharedDatabaseCreatePayload {
  readonly Image: string;
  readonly Cmd: readonly string[];
  readonly User: string;
  readonly Env: readonly string[];
  readonly Labels: Readonly<Record<string, string>>;
  readonly HostConfig: {
    readonly Privileged: false;
    readonly CapDrop: readonly ["ALL"];
    readonly SecurityOpt: readonly ["no-new-privileges:true"];
    readonly PidsLimit: number;
    readonly NanoCpus: number;
    readonly Memory: number;
    readonly MemorySwap: number;
    readonly RestartPolicy: { readonly Name: "unless-stopped" };
    readonly NetworkMode: string;
    readonly Binds: readonly string[];
  };
  readonly NetworkingConfig: {
    readonly EndpointsConfig: Readonly<Record<string, { readonly Aliases: readonly string[] }>>;
  };
}

/** "172.30.250.0/24" -> "172.30.250.%" (MariaDB host pattern). Only /8, /16 and /24 map to one. */
export function subnetToMariadbHostPattern(subnet: string): string {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(8|16|24)$/.exec(subnet.trim());
  const octets = match?.slice(1, 5).map(Number) ?? [];
  if (!match || octets.some((o) => o > 255)) {
    throw new ExecutorCodedError(
      "HP_MARIADB_ADMIN_SUBNET must be an IPv4 /8, /16 or /24 subnet",
      "VALIDATION_ERROR",
    );
  }
  const kept = Number(match[5]) / 8;
  return [...octets.slice(0, kept), "%"].join(".");
}

export function buildSharedDatabaseContainerPayload(
  input: SharedDatabaseContainerInput,
): SharedDatabaseCreatePayload {
  if ([input.dataDirHostPath, input.rootKeyHostPath].some((p) => p.includes("docker.sock"))) {
    throw new ExecutorCodedError(
      "Mounting docker.sock into the shared database is strictly forbidden (TH-02)",
      "HOST_POLICY_DENIED",
    );
  }
  const Image = input.image ?? SHARED_MARIADB_IMAGE;
  const Cmd = ["--innodb-buffer-pool-size=256M", "--max-connections=150", "--skip-name-resolve"];
  const Env = [
    "MARIADB_ROOT_PASSWORD_FILE=/run/secrets/mariadb-root",
    "MARIADB_AUTO_UPGRADE=1",
    // Applies at first initialisation only: root logs in from setup jobs on hp_mariadb_net, never from a site.
    `MARIADB_ROOT_HOST=${subnetToMariadbHostPattern(input.adminSubnet)}`,
  ];
  const Binds = [
    `${input.dataDirHostPath}:/var/lib/mysql`,
    `${input.rootKeyHostPath}:/run/secrets/mariadb-root:ro`,
  ];
  // Hash of what we set, not of what Docker reports: Config.Env also holds the image's own ENV.
  const configSha256 = createHash("sha256")
    .update(JSON.stringify({ Image, Cmd, User: input.user, Env, Binds: [...Binds].sort() }))
    .digest("hex");

  return {
    Image,
    Cmd,
    User: input.user,
    Env,
    Labels: {
      "io.hostingpanel.managed": "true",
      "io.hostingpanel.role": "shared_database",
      [SHARED_DB_CONFIG_SHA256_LABEL]: configSha256,
    },
    HostConfig: {
      Privileged: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 512,
      NanoCpus: 1_000_000_000,
      Memory: SHARED_DB_MEMORY_BYTES,
      MemorySwap: SHARED_DB_MEMORY_BYTES,
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: SHARED_DB_NETWORK_NAME,
      Binds,
    },
    NetworkingConfig: {
      EndpointsConfig: { [SHARED_DB_NETWORK_NAME]: { Aliases: [SHARED_DB_ALIAS] } },
    },
  };
}
