import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  HostAgentHealthResponseSchema,
  HostFirewallStateWireSchema,
  HostJobStateWireSchema,
  HostJournalLineWireSchema,
  HostOsPackagesWireSchema,
  HostServiceStateWireSchema,
  HostTelemetryWireSchema,
  redactSensitiveValue,
  type HostAgentHealthResponse,
} from "@hosting-panel/contracts";
import {
  createApprovedHostMaintenanceCommand,
  createApprovedHostSecurityCommand,
  HOST_JOURNAL_MAX_LINES,
  HOST_JOURNAL_UNITS,
  hostAgentError,
  type ApprovedHostMaintenanceCommand,
  type ApprovedHostSecurityCommand,
  type HostAgentPort,
  type HostDisk,
  type HostFirewallBaseState,
  type HostFirewallSets,
  type HostFirewallState,
  type HostJob,
  type HostJobState,
  type HostJournalLine,
  type HostJournalUnit,
  type HostMaintenanceResult,
  type HostOsPackages,
  type HostServiceState,
  type HostSecurityResult,
  type HostTelemetry,
} from "@hosting-panel/host-agent-contracts";
import { validateFirewallSets } from "./firewall-sets.js";
import { HOST_AGENT_VERSION } from "./linux-adapter.js";
import {
  DEDICATED_NFTABLES_RULESET_SHA256,
  HostPolicyDeniedError,
  verifyStaticNftablesRuleset,
} from "./nftables-baseline.js";

const DEFAULT_DISKS: readonly HostDisk[] = [
  { paths: ["panel_data", "docker_data", "database_data", "root"], usedBytes: "10737418240", totalBytes: "107374182400" },
];

const EMPTY_SETS: HostFirewallSets = { openedPorts: [], blockedV4: [], blockedV6: [] };
const SINCE = "2026-11-17T08:00:00.000Z";
const DEFAULT_HOST_SERVICES: readonly HostServiceState[] = (["hp-api", "hp-web", "hp-docker-executor", "hp-host-agent"] as const)
  .map((unit) => ({ unit, active: true, activeState: "active", since: SINCE, restarts: 0 }));
const DEFAULT_JOURNAL: readonly HostJournalLine[] = [
  { at: SINCE, message: "Started unit (simulated)." },
  { at: "2026-11-17T08:00:01.000Z", message: "Ready (simulated)." },
];
const DEFAULT_OS_PACKAGES: HostOsPackages = {
  packages: [
    { name: "examplelib", installedVersion: "1.0-1", newVersion: "1.0-2", origin: "security" },
    { name: "sample-tool", installedVersion: "2.1-1", newVersion: "2.2-1", origin: "distribution" },
  ],
  rebootRequired: false,
  canUpgrade: true,
  listsReadAt: SINCE,
};

interface SimulatedJob {
  state: HostJobState;
  exitStatus: number;
  held: boolean;
  due: boolean;
}

export interface InMemoryHostSimulatorOptions {
  /** How long a requested host job runs before it ends (default 50 ms). */
  readonly jobEndDelayMs?: number;
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
  private readonly jobEndDelayMs: number;
  private unavailable = false;
  private baseRules: HostFirewallBaseState = "current";
  private firewallSets: HostFirewallSets = EMPTY_SETS;
  private hostServices: readonly HostServiceState[] = DEFAULT_HOST_SERVICES;
  private readonly journals = new Map<HostJournalUnit, readonly HostJournalLine[]>();
  private osPackages: HostOsPackages = DEFAULT_OS_PACKAGES;
  private readonly jobs = new Map<HostJob, SimulatedJob>();

  public constructor(options?: InMemoryHostSimulatorOptions) {
    this.jobEndDelayMs = options?.jobEndDelayMs ?? 50;
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

  /** Makes each of the seven M5d calls throw HOST_AGENT_UNAVAILABLE. */
  public setUnavailable(unavailable: boolean): void {
    this.unavailable = unavailable;
  }

  /** Sets the state of the base table; a table that is not current holds no sets. */
  public setFirewallBaseRules(state: HostFirewallBaseState): void {
    this.baseRules = state;
    if (state !== "current") this.firewallSets = EMPTY_SETS;
  }

  /** Writes the kernel side with no check, as a change made over SSH would. */
  public overwriteFirewallSets(sets: HostFirewallSets): void {
    this.firewallSets = sets;
  }

  public setHostJobExitStatus(job: HostJob, exitStatus: number): void {
    this.job(job).exitStatus = exitStatus;
  }

  /** Keeps the job running past its end until releaseHostJob. */
  public holdHostJob(job: HostJob): void {
    this.job(job).held = true;
  }

  public releaseHostJob(job: HostJob): void {
    const entry = this.job(job);
    entry.held = false;
    if (entry.due) this.endJob(entry);
  }

  public setHostServices(services: readonly HostServiceState[]): void {
    this.hostServices = services;
  }

  public setHostJournal(unit: HostJournalUnit, lines: readonly HostJournalLine[]): void {
    this.journals.set(unit, lines);
  }

  public setOsPackages(value: HostOsPackages): void {
    this.osPackages = value;
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
        disks: custom?.disks ?? this.defaultTelemetry.disks ?? DEFAULT_DISKS,
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
      disks: this.defaultTelemetry.disks ?? DEFAULT_DISKS,
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
    const apply = approved.policyRef === "apply_dedicated_nftables_22_80_443";
    // R203 3.2: as the real agent, no apply where the installer left the firewall to the administrator.
    const refused = apply && this.baseRules === "unmanaged";
    const output = redactSensitiveValue({
      policyRef: approved.policyRef,
      simulator: true,
      rulesetId: "nftables-dedicated-22-80-443",
      rulesetSha256: verifiedSha256,
      rulesetSha256Verified: true,
      ...(refused ? { reason: "panel firewall not installed on this server" } : { applied: apply }),
      checkedAt: nowIso,
    });
    // The real apply deletes the table and loads the file: the three sets come back empty.
    if (apply && !refused) {
      this.baseRules = "current";
      this.firewallSets = EMPTY_SETS;
    }

    const result: HostSecurityResult = {
      operationId,
      hostId: approved.hostId,
      policyRef: approved.policyRef,
      status: refused ? "failed" : "succeeded",
      output: JSON.stringify(output),
    };
    this.securityHistory.push(result);
    return result;
  }

  public async readFirewall(): Promise<HostFirewallState> {
    this.assertAvailable();
    const { openedPorts, blockedV4, blockedV6 } = this.firewallSets;
    return HostFirewallStateWireSchema.parse({
      baseRules: this.baseRules,
      openedPorts: [...openedPorts].sort((a, b) => a - b),
      blockedV4: [...blockedV4].sort(),
      blockedV6: [...blockedV6].sort(),
      readAt: this.nowProvider().toISOString(),
    });
  }

  public async replaceFirewallSets(sets: HostFirewallSets): Promise<HostFirewallState> {
    this.assertAvailable();
    const valid = validateFirewallSets(sets);
    if (this.baseRules !== "current") throw hostAgentError("RESOURCE_LOCKED", "Firewall base rules are not current");
    this.firewallSets = valid;
    return this.readFirewall();
  }

  public async readHostServices(): Promise<readonly HostServiceState[]> {
    this.assertAvailable();
    return z.array(HostServiceStateWireSchema).parse(this.hostServices);
  }

  public async readHostJournal(unit: HostJournalUnit, lines: number): Promise<readonly HostJournalLine[]> {
    this.assertAvailable();
    if (!HOST_JOURNAL_UNITS.includes(unit) || !Number.isInteger(lines) || lines < 1 || lines > HOST_JOURNAL_MAX_LINES)
      throw new HostPolicyDeniedError("Journal request refused");
    return z.array(HostJournalLineWireSchema).parse((this.journals.get(unit) ?? DEFAULT_JOURNAL).slice(-lines));
  }

  public async readOsPackages(): Promise<HostOsPackages> {
    this.assertAvailable();
    return HostOsPackagesWireSchema.parse(this.osPackages);
  }

  public async requestHostJob(job: HostJob): Promise<HostJobState> {
    this.assertAvailable();
    const entry = this.job(job);
    if (entry.state.state === "running") throw hostAgentError("RESOURCE_LOCKED", "Host job is already running");
    entry.state = { job, state: "running", exitStatus: null, startedAt: this.wholeSecond(), endedAt: null };
    entry.due = false;
    setTimeout(() => {
      entry.due = true;
      if (!entry.held) this.endJob(entry);
    }, this.jobEndDelayMs).unref();
    return HostJobStateWireSchema.parse(entry.state);
  }

  public async readHostJob(job: HostJob): Promise<HostJobState> {
    this.assertAvailable();
    return HostJobStateWireSchema.parse(this.job(job).state);
  }

  private job(job: HostJob): SimulatedJob {
    let entry = this.jobs.get(job);
    if (!entry) {
      entry = { state: { job, state: "never_run", exitStatus: null, startedAt: null, endedAt: null }, exitStatus: 0, held: false, due: false };
      this.jobs.set(job, entry);
    }
    return entry;
  }

  private endJob(entry: SimulatedJob): void {
    if (entry.state.state !== "running") return;
    entry.due = false;
    entry.state = {
      ...entry.state,
      state: entry.exitStatus === 0 ? "succeeded" : "failed",
      exitStatus: entry.exitStatus,
      endedAt: this.wholeSecond(),
    };
  }

  // systemd gives job times in whole seconds.
  private wholeSecond(): string {
    return new Date(Math.floor(this.nowProvider().getTime() / 1000) * 1000).toISOString();
  }

  private assertAvailable(): void {
    if (this.unavailable) throw hostAgentError("HOST_AGENT_UNAVAILABLE", "Host agent is unavailable");
  }
}
