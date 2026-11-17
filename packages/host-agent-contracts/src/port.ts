import type { HostDiskPath } from "@hosting-panel/contracts";
import type { ApprovedHostMaintenanceCommand } from "./maintenance.js";
import type { ApprovedHostSecurityCommand } from "./security.js";
import type {
  HostFirewallSets,
  HostFirewallState,
  HostJob,
  HostJobState,
  HostJournalLine,
  HostJournalUnit,
  HostOsPackages,
  HostServiceState,
} from "./host-jobs.js";

export interface HostMaintenanceResult {
  readonly operationId: string;
  readonly hostId: string;
  readonly action: string;
  readonly status: "succeeded" | "failed";
  readonly output?: string;
}

export interface HostSecurityResult {
  readonly operationId: string;
  readonly hostId: string;
  readonly policyRef: string;
  readonly status: "succeeded" | "failed";
  readonly output?: string;
}

export interface HostTelemetry {
  readonly hostId: string;
  readonly cpuUsagePercent: number;
  readonly memoryUsedBytes: string;
  readonly memoryTotalBytes?: string;
  readonly storageUsedBytes: string;
  readonly storageTotalBytes?: string;
  readonly uptimeSeconds?: number;
  readonly kernelVersion?: string;
  readonly dockerEngineReachable?: boolean;
  readonly collectedAt: string;
  readonly disks?: readonly HostDisk[];
}

export interface HostDisk {
  readonly paths: readonly HostDiskPath[];
  readonly usedBytes: string;
  readonly totalBytes: string;
}

export interface HostAgentPort {
  readonly isRuntimeAvailable: boolean;
  executeMaintenance(
    command: ApprovedHostMaintenanceCommand,
  ): Promise<HostMaintenanceResult>;
  executeSecurityPolicy(
    command: ApprovedHostSecurityCommand,
  ): Promise<HostSecurityResult>;
  getHostTelemetry(hostId: string): Promise<HostTelemetry | null>;
  readFirewall(): Promise<HostFirewallState>;
  replaceFirewallSets(sets: HostFirewallSets): Promise<HostFirewallState>;
  readHostServices(): Promise<readonly HostServiceState[]>;
  readHostJournal(unit: HostJournalUnit, lines: number): Promise<readonly HostJournalLine[]>;
  readOsPackages(): Promise<HostOsPackages>;
  requestHostJob(job: HostJob): Promise<HostJobState>;
  readHostJob(job: HostJob): Promise<HostJobState>;
}
