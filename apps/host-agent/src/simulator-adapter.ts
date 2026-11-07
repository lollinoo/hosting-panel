import { randomUUID } from "node:crypto";
import {
  HostAgentHealthResponseSchema,
  HostTelemetryWireSchema,
  redactSensitiveValue,
  type HostAgentHealthResponse,
} from "@hosting-panel/contracts";
import {
  createApprovedHostMaintenanceCommand,
  createApprovedHostSecurityCommand,
  type ApprovedHostMaintenanceCommand,
  type ApprovedHostSecurityCommand,
  type HostAgentPort,
  type HostMaintenanceResult,
  type HostSecurityResult,
  type HostTelemetry,
} from "@hosting-panel/host-agent-contracts";
import { HOST_AGENT_VERSION } from "./linux-adapter.js";
import {
  DEDICATED_NFTABLES_RULESET_SHA256,
  verifyStaticNftablesRuleset,
} from "./nftables-baseline.js";

export interface InMemoryHostSimulatorOptions {
  readonly defaultTelemetry?: Partial<Omit<HostTelemetry, "hostId" | "collectedAt">>;
  readonly nftablesRulesetPath?: string;
  readonly expectedRulesetSha256?: string;
  readonly nowProvider?: () => Date;
}

export class InMemoryHostSimulatorAdapter implements HostAgentPort {
  public readonly isRuntimeAvailable = true;

  private readonly defaultTelemetry: Partial<Omit<HostTelemetry, "hostId" | "collectedAt">>;
  private readonly nftablesRulesetPath?: string;
  private readonly expectedRulesetSha256: string;
  private readonly nowProvider: () => Date;
  private readonly telemetryOverrides = new Map<
    string,
    Partial<Omit<HostTelemetry, "hostId">> | null
  >();
  private readonly maintenanceHistory: HostMaintenanceResult[] = [];
  private readonly securityHistory: HostSecurityResult[] = [];

  public constructor(options?: InMemoryHostSimulatorOptions) {
    this.defaultTelemetry = options?.defaultTelemetry ?? {};
    this.nftablesRulesetPath = options?.nftablesRulesetPath;
    this.expectedRulesetSha256 =
      options?.expectedRulesetSha256 ?? DEDICATED_NFTABLES_RULESET_SHA256;
    this.nowProvider = options?.nowProvider ?? (() => new Date());
  }

  public setTelemetryOverride(
    hostId: string,
    override: Partial<Omit<HostTelemetry, "hostId">> | null,
  ): void {
    this.telemetryOverrides.set(hostId, override);
  }

  public getExecutedMaintenanceHistory(): readonly HostMaintenanceResult[] {
    return [...this.maintenanceHistory];
  }

  public getExecutedSecurityHistory(): readonly HostSecurityResult[] {
    return [...this.securityHistory];
  }

  public async checkHealth(): Promise<HostAgentHealthResponse> {
    return HostAgentHealthResponseSchema.parse({
      component: "host_agent",
      status: "online",
      version: HOST_AGENT_VERSION,
      runtimeBackend: "local-simulator",
      checkedAt: this.nowProvider().toISOString(),
    });
  }

  public async getHostTelemetry(hostId: string): Promise<HostTelemetry | null> {
    if (!hostId || hostId.trim().length === 0) {
      throw new Error("hostId must not be empty");
    }

    const normalizedHostId = hostId.trim();
    if (this.telemetryOverrides.has(normalizedHostId)) {
      const custom = this.telemetryOverrides.get(normalizedHostId);
      if (custom === null) {
        return null;
      }
      return HostTelemetryWireSchema.parse({
        hostId: normalizedHostId,
        cpuUsagePercent: custom?.cpuUsagePercent ?? this.defaultTelemetry.cpuUsagePercent ?? 12.5,
        memoryUsedBytes:
          custom?.memoryUsedBytes ?? this.defaultTelemetry.memoryUsedBytes ?? "2147483648",
        memoryTotalBytes:
          custom?.memoryTotalBytes ?? this.defaultTelemetry.memoryTotalBytes ?? "8589934592",
        storageUsedBytes:
          custom?.storageUsedBytes ?? this.defaultTelemetry.storageUsedBytes ?? "10737418240",
        storageTotalBytes:
          custom?.storageTotalBytes ?? this.defaultTelemetry.storageTotalBytes ?? "107374182400",
        uptimeSeconds: custom?.uptimeSeconds ?? this.defaultTelemetry.uptimeSeconds ?? 86400,
        kernelVersion:
          custom?.kernelVersion ?? this.defaultTelemetry.kernelVersion ?? "6.8.0-simulator",
        dockerEngineReachable:
          custom?.dockerEngineReachable ?? this.defaultTelemetry.dockerEngineReachable ?? true,
        collectedAt: custom?.collectedAt ?? this.nowProvider().toISOString(),
      });
    }

    return HostTelemetryWireSchema.parse({
      hostId: normalizedHostId,
      cpuUsagePercent: this.defaultTelemetry.cpuUsagePercent ?? 12.5,
      memoryUsedBytes: this.defaultTelemetry.memoryUsedBytes ?? "2147483648",
      memoryTotalBytes: this.defaultTelemetry.memoryTotalBytes ?? "8589934592",
      storageUsedBytes: this.defaultTelemetry.storageUsedBytes ?? "10737418240",
      storageTotalBytes: this.defaultTelemetry.storageTotalBytes ?? "107374182400",
      uptimeSeconds: this.defaultTelemetry.uptimeSeconds ?? 86400,
      kernelVersion: this.defaultTelemetry.kernelVersion ?? "6.8.0-simulator",
      dockerEngineReachable: this.defaultTelemetry.dockerEngineReachable ?? true,
      collectedAt: this.nowProvider().toISOString(),
    });
  }

  public async executeMaintenance(
    command: ApprovedHostMaintenanceCommand,
  ): Promise<HostMaintenanceResult> {
    const approved = createApprovedHostMaintenanceCommand({
      hostId: command.hostId,
      action: command.action,
      reason: command.reason,
    });

    const nowIso = this.nowProvider().toISOString();
    const operationId = `sim_maint_${randomUUID()}`;

    const summaryByAction: Record<ApprovedHostMaintenanceCommand["action"], unknown> = {
      collect_diagnostics: {
        action: "collect_diagnostics",
        simulator: true,
        loadAverage: { oneMinute: 0.15, fiveMinutes: 0.12, fifteenMinutes: 0.1 },
        memory: {
          totalBytes: "8589934592",
          availableBytes: "6442450944",
          usedBytes: "2147483648",
        },
        cgroupV2Unified: true,
        kernelRelease: "6.8.0-simulator",
        collectedAt: nowIso,
      },
      verify_storage_posture: {
        action: "verify_storage_posture",
        simulator: true,
        allProvisionedAndCompliant: true,
        targets: [
          {
            target: "data_directory",
            provisioned: true,
            modeOctal: "0750",
            permissionsCompliant: true,
            availableBytes: "96636764160",
            totalBytes: "107374182400",
          },
          {
            target: "runtime_directory",
            provisioned: true,
            modeOctal: "0750",
            permissionsCompliant: true,
            availableBytes: "1073741824",
            totalBytes: "1073741824",
          },
        ],
        checkedAt: nowIso,
      },
      refresh_host_inventory: {
        action: "refresh_host_inventory",
        simulator: true,
        logicalCpus: 4,
        totalCpuMilli: 4000,
        totalMemoryBytes: "8589934592",
        totalStorageBytes: "107374182400",
        architecture: "x64",
        kernelRelease: "6.8.0-simulator",
        refreshedAt: nowIso,
      },
    };

    const sanitized = redactSensitiveValue(summaryByAction[approved.action]);
    const result: HostMaintenanceResult = {
      operationId,
      hostId: approved.hostId,
      action: approved.action,
      status: "succeeded",
      output: JSON.stringify(sanitized),
    };
    this.maintenanceHistory.push(result);
    return result;
  }

  public async executeSecurityPolicy(
    command: ApprovedHostSecurityCommand,
  ): Promise<HostSecurityResult> {
    const approved = createApprovedHostSecurityCommand({
      hostId: command.hostId,
      policyRef: command.policyRef,
      reason: command.reason,
    });

    let verifiedSha256 = this.expectedRulesetSha256;
    if (this.nftablesRulesetPath) {
      const verified = await verifyStaticNftablesRuleset(
        this.nftablesRulesetPath,
        this.expectedRulesetSha256,
      );
      verifiedSha256 = verified.sha256;
    }

    const nowIso = this.nowProvider().toISOString();
    const operationId = `sim_sec_${randomUUID()}`;
    const output = redactSensitiveValue({
      policyRef: approved.policyRef,
      simulator: true,
      rulesetId: "nftables-dedicated-22-80-443",
      rulesetSha256: verifiedSha256,
      rulesetSha256Verified: true,
      applied: approved.policyRef === "apply_dedicated_nftables_22_80_443",
      checkedAt: nowIso,
    });

    const result: HostSecurityResult = {
      operationId,
      hostId: approved.hostId,
      policyRef: approved.policyRef,
      status: "succeeded",
      output: JSON.stringify(output),
    };
    this.securityHistory.push(result);
    return result;
  }
}
