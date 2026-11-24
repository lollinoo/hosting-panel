/**
 * Allowed keys and refused keys at every level of an `HCP-STACK/v1` source, and the same table for `HCP-STACK/v2`
 * (ADR-0036). A key in neither list is KEY_UNKNOWN, so a Compose feature that could reach the host can never slip in by
 * being forgotten. The A4 security test iterates both tables.
 * Pure, synchronous and never throws; a message never echoes a value.
 */
import type { AppTemplateSpecVersion } from "@hosting-panel/contracts";

export type AppTemplateRefusalCode = "KEY_FORBIDDEN_SECURITY" | "KEY_FORBIDDEN_NETWORK" | "KEY_FORBIDDEN_HOST_ACCESS" | "KEY_UNSUPPORTED";

export interface AppTemplateKeyLevel {
  readonly allowed: readonly string[];
  readonly refusals: Readonly<Partial<Record<AppTemplateRefusalCode, readonly string[]>>>;
}

const level = (allowed: string[], refusals: Partial<Record<AppTemplateRefusalCode, string[]>> = {}): AppTemplateKeyLevel => {
  for (const keys of Object.values(refusals)) Object.freeze(keys);
  return Object.freeze({ allowed: Object.freeze(allowed), refusals: Object.freeze(refusals) });
};

export const APP_TEMPLATE_KEY_LEVELS: Readonly<Record<
  "root" | "header" | "parameter" | "service" | "environmentEntry" | "healthcheck" | "deploy" | "resources" | "limits" | "ingress" | "task",
  AppTemplateKeyLevel>> = Object.freeze({
  root: level(["x-hp-stack", "x-hp-parameters", "services", "volumes", "x-hp-ingress", "x-hp-tasks"], {
    KEY_FORBIDDEN_NETWORK: ["networks"],
    KEY_FORBIDDEN_HOST_ACCESS: ["secrets", "configs", "include", "extends"],
    KEY_UNSUPPORTED: ["x-hp-ports", "name", "version", "models"],
  }),
  header: level(["schemaVersion", "name", "category", "description"]),
  parameter: level(["key", "label", "type", "default", "customer", "options", "min", "max", "required"]),
  service: level(["image", "command", "environment", "volumes", "expose", "depends_on", "healthcheck", "deploy"], {
    KEY_FORBIDDEN_SECURITY: [
      "privileged", "cap_add", "cap_drop", "devices", "device_cgroup_rules", "security_opt", "sysctls", "userns_mode", "pid",
      "ipc", "uts", "cgroup", "cgroup_parent", "runtime", "isolation", "group_add", "user", "oom_kill_disable",
      "oom_score_adj", "gpus", "credential_spec", "use_api_socket",
    ],
    KEY_FORBIDDEN_NETWORK: [
      "ports", "network_mode", "networks", "extra_hosts", "dns", "dns_search", "dns_opt", "mac_address", "links",
      "external_links", "hostname", "domainname",
    ],
    KEY_FORBIDDEN_HOST_ACCESS: [
      "build", "container_name", "env_file", "secrets", "configs", "labels", "label_file", "volumes_from", "tmpfs", "extends",
      "develop", "annotations", "storage_opt", "post_start", "pre_stop",
    ],
    KEY_UNSUPPORTED: [
      "entrypoint", "restart", "logging", "working_dir", "read_only", "stop_signal", "stop_grace_period", "init", "tty",
      "stdin_open", "attach", "profiles", "pull_policy", "platform", "scale", "ulimits", "mem_limit", "memswap_limit",
      "mem_reservation", "mem_swappiness", "cpus", "cpuset", "cpu_shares", "cpu_quota", "cpu_period", "cpu_count",
      "cpu_percent", "cpu_rt_runtime", "cpu_rt_period", "blkio_config", "pids_limit", "shm_size", "provider", "models",
    ],
  }),
  environmentEntry: level(["name", "value", "secret"]),
  healthcheck: level(["kind", "port", "path", "intervalSeconds", "timeoutSeconds"], {
    KEY_UNSUPPORTED: ["test", "interval", "timeout", "retries", "start_period", "start_interval", "disable"],
  }),
  deploy: level(["resources"], {
    KEY_UNSUPPORTED: ["mode", "replicas", "endpoint_mode", "labels", "update_config", "rollback_config", "restart_policy", "placement"],
  }),
  resources: level(["limits"], { KEY_UNSUPPORTED: ["reservations"] }),
  limits: level(["cpus", "memory"], { KEY_UNSUPPORTED: ["pids", "devices"] }),
  ingress: level(["service", "port", "protocol"], {
    KEY_FORBIDDEN_NETWORK: ["hostname", "host", "domain", "domains", "tls", "path", "published", "host_port"],
  }),
  // A task runs as its component runs: it names no user, directory, variable or time of its own (ADR-0042).
  task: level(["key", "label", "description", "service", "command", "timeoutSeconds"], {
    KEY_FORBIDDEN_SECURITY: ["user", "privileged", "cap_add", "group_add"],
    KEY_UNSUPPORTED: ["schedule", "cron", "environment", "working_dir", "entrypoint", "shell", "tty", "stdin_open"],
  }),
});

const copyOf = (row: AppTemplateKeyLevel, added: readonly string[]): AppTemplateKeyLevel =>
  level(
    [...row.allowed, ...added],
    Object.fromEntries(Object.entries(row.refusals).map(([code, keys]) => [code, [...keys]])),
  );

/**
 * `HCP-STACK/v2`: every v1 row, plus `generate` on a parameter (and its own level), and the closed run profile on a
 * service. Every key v1 refuses is still refused: a v2 source names no capability, device, host path, port or user.
 */
export const APP_TEMPLATE_KEY_LEVELS_V2: Readonly<Record<keyof typeof APP_TEMPLATE_KEY_LEVELS | "generate", AppTemplateKeyLevel>> =
  Object.freeze({
    ...APP_TEMPLATE_KEY_LEVELS,
    parameter: copyOf(APP_TEMPLATE_KEY_LEVELS.parameter, ["generate"]),
    generate: level(["kind", "length"]),
    service: copyOf(APP_TEMPLATE_KEY_LEVELS.service, ["x-hp-profile"]),
  });

export type AppTemplateKeyLevelName = keyof typeof APP_TEMPLATE_KEY_LEVELS_V2;

/** allowed → null; listed → its refusal code; anything else → "KEY_UNKNOWN". `version` picks the table (default v1). */
export function appTemplateKeyVerdict(
  level: AppTemplateKeyLevelName,
  key: string,
  version: AppTemplateSpecVersion = 1,
): AppTemplateRefusalCode | "KEY_UNKNOWN" | null {
  const table: Readonly<Partial<Record<AppTemplateKeyLevelName, AppTemplateKeyLevel>>> =
    version === 2 ? APP_TEMPLATE_KEY_LEVELS_V2 : APP_TEMPLATE_KEY_LEVELS;
  const row = table[level];
  if (row === undefined) return "KEY_UNKNOWN";
  if (row.allowed.includes(key)) return null;
  for (const [code, keys] of Object.entries(row.refusals)) if (keys.includes(key)) return code as AppTemplateRefusalCode;
  return "KEY_UNKNOWN";
}
