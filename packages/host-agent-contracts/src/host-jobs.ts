import { IPC_HOST_JOBS, IPC_HOST_JOURNAL_UNITS } from "@hosting-panel/contracts";

export const HOST_JOBS = IPC_HOST_JOBS;
export type HostJob = (typeof HOST_JOBS)[number];
export const HOST_SERVICE_UNITS = ["hp-api", "hp-web", "hp-docker-executor", "hp-host-agent"] as const;
export type HostServiceUnit = (typeof HOST_SERVICE_UNITS)[number];
export const HOST_JOURNAL_UNITS = IPC_HOST_JOURNAL_UNITS;
export type HostJournalUnit = (typeof HOST_JOURNAL_UNITS)[number];
export const HOST_JOURNAL_MAX_LINES = 500;
export const HOST_JOB_TRIGGER_DIR = "/run/hosting-panel/host-jobs";
/** systemd unit name (no .path/.service suffix) of each job; also the trigger file name. */
export const HOST_JOB_UNITS: Readonly<Record<HostJob, string>> = {
  restart_hp_api: "hp-unit-restart@hp-api",
  restart_hp_web: "hp-unit-restart@hp-web",
  restart_hp_docker_executor: "hp-unit-restart@hp-docker-executor",
  restart_hp_host_agent: "hp-unit-restart@hp-host-agent",
  panel_update: "hp-panel-update",
  os_refresh: "hp-os-refresh",
  os_upgrade: "hp-os-upgrade",
};
export const HOST_FIREWALL_BASE_STATES = ["absent", "outdated", "current", "unmanaged"] as const;
export type HostFirewallBaseState = (typeof HOST_FIREWALL_BASE_STATES)[number];
export const HOST_JOB_STATES = ["never_run", "running", "succeeded", "failed"] as const;
export type HostJobStatus = (typeof HOST_JOB_STATES)[number];
export const HOST_OS_PACKAGE_ORIGINS = ["security", "distribution", "other"] as const;
export type HostOsPackageOrigin = (typeof HOST_OS_PACKAGE_ORIGINS)[number];

export interface HostFirewallSets { readonly openedPorts: readonly number[]; readonly blockedV4: readonly string[]; readonly blockedV6: readonly string[] }
export interface HostFirewallState extends HostFirewallSets { readonly baseRules: HostFirewallBaseState; readonly readAt: string }
export interface HostServiceState { readonly unit: HostServiceUnit; readonly active: boolean; readonly activeState: string; readonly since: string | null; readonly restarts: number }
export interface HostJournalLine { readonly at: string; readonly message: string }
export interface HostOsPackage { readonly name: string; readonly installedVersion: string; readonly newVersion: string; readonly origin: HostOsPackageOrigin }
export interface HostOsPackages { readonly packages: readonly HostOsPackage[]; readonly rebootRequired: boolean; readonly canUpgrade: boolean; readonly listsReadAt: string | null }
export interface HostJobState { readonly job: HostJob; readonly state: HostJobStatus; readonly exitStatus: number | null; readonly startedAt: string | null; readonly endedAt: string | null }

/** Error with a shared code; the agent server maps the code to its HTTP status. */
export function hostAgentError(code: "NOT_SUPPORTED" | "RESOURCE_LOCKED" | "HOST_AGENT_UNAVAILABLE", message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
