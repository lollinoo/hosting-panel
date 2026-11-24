/**
 * Keys of a Compose file as the importer sees them. Every level has three explicit lists: the keys it reads, the keys
 * it drops because they change nothing a template can express, and the keys it refuses because they grant a privilege
 * or reach the host. A key on none of them is refused: the importer never guesses what an unknown key grants.
 */
import type { TemplatePath } from "@hosting-panel/contracts";
import type { Mapping } from "./compose-import-document.js";
import type { ImportReport } from "./compose-import-report.js";

interface KeyLevel {
  readonly read: readonly string[];
  readonly dropped: readonly string[];
  readonly refused: readonly string[];
}

export const COMPOSE_IMPORT_KEY_LEVELS = Object.freeze({
  root: {
    read: ["services", "volumes"],
    // The platform gives every stack its own private network, and names it itself.
    dropped: ["version", "name", "networks"],
    refused: ["secrets", "configs", "include", "extends", "models"],
  },
  service: {
    read: ["image", "command", "environment", "volumes", "ports", "expose", "depends_on", "healthcheck", "deploy", "mem_limit", "cpus"],
    dropped: [
      "restart", "container_name", "labels", "annotations", "networks", "hostname", "domainname", "logging", "working_dir", "read_only",
      "stop_signal", "stop_grace_period", "init", "tty", "stdin_open", "attach", "profiles", "pull_policy", "platform", "scale", "ulimits",
      "memswap_limit", "mem_reservation", "mem_swappiness", "cpuset", "cpu_shares", "cpu_quota", "cpu_period", "cpu_count", "cpu_percent",
      "cpu_rt_runtime", "cpu_rt_period", "blkio_config", "pids_limit", "shm_size",
      // Dropping capabilities only takes rights away, and the platform drops them all anyway.
      "cap_drop",
    ],
    refused: [
      // Privileges and isolation
      "privileged", "cap_add", "devices", "device_cgroup_rules", "security_opt", "sysctls", "userns_mode", "pid", "ipc", "uts", "cgroup",
      "cgroup_parent", "runtime", "isolation", "group_add", "user", "oom_kill_disable", "oom_score_adj", "gpus", "credential_spec",
      "use_api_socket",
      // Network of the host or of another container
      "network_mode", "extra_hosts", "dns", "dns_search", "dns_opt", "mac_address", "links", "external_links",
      // Files and code from outside the image
      "build", "env_file", "secrets", "configs", "label_file", "volumes_from", "tmpfs", "extends", "develop", "storage_opt", "post_start",
      "pre_stop", "entrypoint", "provider", "models",
    ],
  },
  deploy: {
    read: ["resources"],
    dropped: ["mode", "replicas", "endpoint_mode", "labels", "update_config", "rollback_config", "restart_policy", "placement"],
    refused: [],
  },
  resources: { read: ["limits"], dropped: ["reservations"], refused: [] },
  limits: { read: ["cpus", "memory"], dropped: ["pids", "devices"], refused: [] },
  // What a health check loses is said once, by the note of its conversion.
  healthcheck: { read: ["test", "interval", "timeout", "retries", "start_period", "start_interval", "disable"], dropped: [], refused: [] },
  // One long-form entry of 'ports'. The note about published ports covers the keys of the host side.
  port: { read: ["target", "published", "host_ip", "protocol", "mode", "app_protocol", "name"], dropped: [], refused: [] },
  // The condition of one 'depends_on' entry. What it loses is said by the notes about conditions.
  dependency: { read: ["condition", "restart", "required"], dropped: [], refused: [] },
} as const satisfies Record<string, KeyLevel>);

export type ComposeImportKeyLevel = keyof typeof COMPOSE_IMPORT_KEY_LEVELS;

/** Writes one note per key that is not read. A key on a list is fixed text, so the note can name it; any other key is only in the path. */
export function checkComposeKeys(report: ImportReport, mapping: Mapping, path: TemplatePath, level: ComposeImportKeyLevel): void {
  const lists: KeyLevel = COMPOSE_IMPORT_KEY_LEVELS[level];
  for (const key of Object.keys(mapping)) {
    const at = [...path, key];
    if (lists.read.includes(key)) continue;
    if (lists.dropped.includes(key)) report.dropped("KEY_DROPPED", at, `'${key}' has no equivalent in a template: it is dropped.`);
    else if (lists.refused.includes(key)) {
      report.refused("KEY_REFUSED", at, `'${key}' gives a container a privilege, a way to the host or code from outside its image: a template cannot carry it.`);
    } else if (key.startsWith("x-")) report.dropped("KEY_DROPPED", at, "An extension key ('x-...') means nothing to the platform: it is dropped.");
    else report.refused("KEY_UNKNOWN", at, "The importer does not know this key and refuses the file rather than guess what the key grants.");
  }
}
