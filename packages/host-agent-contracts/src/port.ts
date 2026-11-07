import type { ApprovedHostMaintenanceCommand } from "./maintenance.js";

export interface HostMaintenanceResult {
  readonly operationId: string;
  readonly hostId: string;
  readonly action: string;
  readonly status: "succeeded" | "failed";
  readonly output?: string;
}

export interface HostTelemetry {
  readonly hostId: string;
  readonly cpuUsagePercent: number;
  readonly memoryUsedBytes: string;
  readonly storageUsedBytes: string;
  readonly collectedAt: string;
}

export interface HostAgentPort {
  readonly isRuntimeAvailable: boolean;
  executeMaintenance(
    command: ApprovedHostMaintenanceCommand,
  ): Promise<HostMaintenanceResult>;
  getHostTelemetry(hostId: string): Promise<HostTelemetry | null>;
}
