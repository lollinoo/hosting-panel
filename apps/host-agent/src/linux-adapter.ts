import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  HOST_DISK_PATHS,
  HostAgentHealthResponseSchema,
  HostTelemetryWireSchema,
  redactSensitiveValue,
  type HostAgentHealthResponse,
  type HostDiskPath,
} from "@hosting-panel/contracts";
import {
  createApprovedHostMaintenanceCommand,
  createApprovedHostSecurityCommand,
  HOST_JOB_TRIGGER_DIR,
  HOST_JOB_UNITS,
  HOST_JOBS,
  HOST_JOURNAL_MAX_LINES,
  HOST_JOURNAL_UNITS,
  HOST_SERVICE_UNITS,
  hostAgentError,
  type ApprovedHostMaintenanceCommand,
  type ApprovedHostSecurityCommand,
  type HostAgentPort,
  type HostDisk,
  type HostFirewallSets,
  type HostFirewallState,
  type HostJob,
  type HostJobState,
  type HostJournalLine,
  type HostJournalUnit,
  type HostOsPackages,
  type HostServiceState,
  type HostMaintenanceResult,
  type HostSecurityResult,
  type HostTelemetry,
} from "@hosting-panel/host-agent-contracts";
import {
  DEDICATED_NFTABLES_RULESET_SHA256,
  HostPolicyDeniedError,
  INSTALLED_NFTABLES_RULESET_PATH,
  resolveDefaultNftablesRulesetPath,
  verifyStaticNftablesRuleset,
} from "./nftables-baseline.js";
import { buildFirewallSetsProgram, parseFirewallListing, validateFirewallSets } from "./firewall-sets.js";
import {
  HOST_JOB_RUNNING,
  HOST_JOB_UNITS_MISSING,
  HOST_TOOL_FAILED,
  hostJobState,
  hostToolFailed,
  parseAptUpgradeSimulation,
  parseHostServices,
  parseJournalJson,
  parseSystemctlShow,
} from "./host-parsers.js";

const execFileAsync = promisify(execFile);

export const HOST_AGENT_VERSION = "0.2.0" as const;

export const ALLOWED_LINUX_BINARIES = [
  "/usr/sbin/nft",
  "/usr/bin/nft",
  "/usr/bin/uname",
  "/usr/bin/df",
  "/usr/bin/systemctl",
  "/usr/bin/journalctl",
  "/usr/bin/apt-get",
] as const;

export type AllowedLinuxBinary = (typeof ALLOWED_LINUX_BINARIES)[number];

const ALLOWED_LINUX_BINARIES_SET: ReadonlySet<string> = new Set(ALLOWED_LINUX_BINARIES);

export const SANITIZED_LINUX_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  LC_ALL: "C",
});

export interface ExecFileResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly maxBuffer?: number;
}

export type ExecFileRunner = (
  binaryPath: AllowedLinuxBinary,
  args: readonly string[],
  options?: RunOptions,
) => Promise<ExecFileResult>;

const SAFE_ARG_PATTERN = /^[^\r\n\0]{1,512}$/;

const NFT_LIST_FORM = ["-j", "list", "table", "inet", "hp_dedicated_filter"] as const;
const SYSTEMCTL_SERVICES_FORM: readonly string[] = [
  "show", "--timestamp=unix", "--property=Id,ActiveState,ActiveEnterTimestamp,NRestarts", "--",
  ...HOST_SERVICE_UNITS.map((u) => `${u}.service`),
];
const systemctlJobForm = (unit: string): string[] => [
  "show", "--timestamp=unix",
  "--property=Id,LoadState,ActiveState,Result,ExecMainStartTimestamp,ExecMainExitTimestamp,ExecMainStatus", "--",
  `${unit}.service`, `${unit}.path`,
];
const journalctlForm = (unit: string, lines: string): string[] => [
  `--unit=${unit}.service`, `--lines=${lines}`, "--output=json", "--output-fields=MESSAGE", "--no-pager", "--quiet",
];
const sameArgs = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** R198 2.1: systemctl, journalctl and apt-get run only with one of their fixed argument forms. */
export function isClosedArgumentForm(binaryPath: AllowedLinuxBinary, args: readonly string[]): boolean {
  switch (binaryPath) {
    case "/usr/bin/systemctl":
      return sameArgs(args, SYSTEMCTL_SERVICES_FORM) || Object.values(HOST_JOB_UNITS).some((u) => sameArgs(args, systemctlJobForm(u)));
    case "/usr/bin/journalctl": {
      const n = (args[1] ?? "").match(/^--lines=([1-9]\d{0,2})$/)?.[1];
      return n !== undefined && Number(n) <= HOST_JOURNAL_MAX_LINES && HOST_JOURNAL_UNITS.some((u) => sameArgs(args, journalctlForm(u, n)));
    }
    case "/usr/bin/apt-get":
      return sameArgs(args, ["-s", "upgrade"]);
    default:
      return true;
  }
}

export async function runAllowlistedBinary(
  binaryPath: AllowedLinuxBinary,
  args: readonly string[],
  options: RunOptions = {},
): Promise<ExecFileResult> {
  if (!ALLOWED_LINUX_BINARIES_SET.has(binaryPath)) {
    throw new HostPolicyDeniedError("Requested Linux binary is not allowlisted");
  }

  if (!isClosedArgumentForm(binaryPath, args)) {
    throw new HostPolicyDeniedError("Requested arguments are not an accepted form");
  }

  for (const arg of args) {
    if (!SAFE_ARG_PATTERN.test(arg)) {
      throw new HostPolicyDeniedError("Unsafe control characters in binary argument array");
    }
  }

  const pending = execFileAsync(binaryPath, [...args], {
    shell: false,
    env: SANITIZED_LINUX_ENV,
    timeout: 10_000,
    maxBuffer: options.maxBuffer ?? 256 * 1024,
    windowsHide: true,
  });
  // stdin always closes, so no program waits on it.
  pending.child?.stdin?.on("error", () => undefined);
  pending.child?.stdin?.end();
  const { stdout, stderr } = await pending;

  return {
    stdout: String(stdout),
    stderr: String(stderr),
  };
}

interface CpuTickSample {
  readonly total: bigint;
  readonly idleAll: bigint;
}

export function parseProcStatCpuLine(procStatContent: string): CpuTickSample | null {
  const lines = procStatContent.split("\n");
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith("cpu ")) {
      continue;
    }

    const parts = trimmed.split(/\s+/).slice(1);
    if (parts.length < 4) {
      return null;
    }

    const values: bigint[] = [];
    for (const part of parts) {
      if (!/^\d+$/.test(part)) {
        break;
      }
      values.push(BigInt(part));
    }

    if (values.length < 4) {
      return null;
    }

    let total = 0n;
    for (const val of values) {
      total += val;
    }

    const idle = values[3] ?? 0n;
    const iowait = values[4] ?? 0n;
    return {
      total,
      idleAll: idle + iowait,
    };
  }

  return null;
}

export function parseProcMeminfoBytes(procMeminfoContent: string): {
  readonly totalBytes: bigint;
  readonly availableBytes: bigint;
  readonly usedBytes: bigint;
} | null {
  let memTotalKb: bigint | null = null;
  let memAvailableKb: bigint | null = null;
  let memFreeKb = 0n;
  let buffersKb = 0n;
  let cachedKb = 0n;

  for (const rawLine of procMeminfoContent.split("\n")) {
    const match = rawLine.trim().match(/^([A-Za-z0-9_()]+):\s+(\d+)\s*kB\b/i);
    if (!match) {
      continue;
    }
    const key = match[1];
    const valueKb = BigInt(match[2] ?? "0");
    if (key === "MemTotal") {
      memTotalKb = valueKb;
    } else if (key === "MemAvailable") {
      memAvailableKb = valueKb;
    } else if (key === "MemFree") {
      memFreeKb = valueKb;
    } else if (key === "Buffers") {
      buffersKb = valueKb;
    } else if (key === "Cached") {
      cachedKb = valueKb;
    }
  }

  if (memTotalKb === null || memTotalKb <= 0n) {
    return null;
  }

  const effectiveAvailableKb =
    memAvailableKb !== null ? memAvailableKb : memFreeKb + buffersKb + cachedKb;
  const clampedAvailableKb =
    effectiveAvailableKb > memTotalKb ? memTotalKb : effectiveAvailableKb;
  const totalBytes = memTotalKb * 1024n;
  const availableBytes = clampedAvailableKb * 1024n;
  const usedBytes = totalBytes >= availableBytes ? totalBytes - availableBytes : 0n;

  return {
    totalBytes,
    availableBytes,
    usedBytes,
  };
}

function clampCpuPercent(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return Number(value.toFixed(2));
}

function computeCpuUsageFromSamples(prev: CpuTickSample, next: CpuTickSample): number {
  const totalDelta = next.total - prev.total;
  const idleDelta = next.idleAll - prev.idleAll;
  if (totalDelta <= 0n) {
    if (next.total <= 0n) {
      return 0;
    }
    const busyCumulative = next.total >= next.idleAll ? next.total - next.idleAll : 0n;
    return clampCpuPercent((Number(busyCumulative) / Number(next.total)) * 100);
  }

  const busyDelta = totalDelta >= idleDelta ? totalDelta - idleDelta : 0n;
  return clampCpuPercent((Number(busyDelta) / Number(totalDelta)) * 100);
}

function isMissingCapNetAdminError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (code === "EPERM" || code === "EACCES") {
    return true;
  }
  const stderr = String((err as { stderr?: unknown }).stderr ?? "");
  const combined = `${err.message}\n${stderr}`;
  return /operation not permitted|permission denied|cache initialization failed/i.test(combined);
}

// Shipped formula: used = total - bavail*bsize, so reserved blocks count as used.
function statfsUsage(fsStats: { bsize: number; blocks: number; bavail: number }): {
  readonly totalBytes: bigint;
  readonly availableBytes: bigint;
  readonly usedBytes: bigint;
} {
  const bsize = BigInt(Math.max(1, Number(fsStats.bsize)));
  const blocks = BigInt(Math.max(0, Number(fsStats.blocks)));
  const bavail = BigInt(Math.max(0, Number(fsStats.bavail)));
  const clampedAvail = bavail > blocks ? blocks : bavail;
  const totalBytes = blocks * bsize;
  const availableBytes = clampedAvail * bsize;
  const usedBytes = totalBytes >= availableBytes ? totalBytes - availableBytes : 0n;
  return { totalBytes, availableBytes, usedBytes };
}

export interface LinuxSystemHostAdapterOptions {
  readonly storagePath?: string;
  readonly fallbackStoragePath?: string;
  readonly diskPaths?: Partial<Record<HostDiskPath, string>>;
  readonly runtimeDirPath?: string;
  readonly dockerSocketPath?: string;
  readonly procStatPath?: string;
  readonly procMeminfoPath?: string;
  readonly cgroupControllersPath?: string;
  readonly nftablesRulesetPath?: string;
  readonly nftablesInstalledPath?: string;
  readonly expectedRulesetSha256?: string;
  readonly cpuSampleDelayMs?: number;
  readonly requireProvisionedDirectories?: boolean;
  readonly allowUnprivilegedVerifyFallback?: boolean;
  readonly execFileRunner?: ExecFileRunner;
  readonly hostJobTriggerDir?: string;
  readonly rebootRequiredPath?: string;
  readonly aptListsDir?: string;
  readonly unattendedUpgradePath?: string;
}

export class LinuxSystemHostAdapter implements HostAgentPort {
  public readonly isRuntimeAvailable = true;

  private readonly storagePath: string;
  private readonly fallbackStoragePath: string;
  private readonly diskPaths: Record<HostDiskPath, string>;
  private readonly runtimeDirPath: string;
  private readonly dockerSocketPath: string;
  private readonly procStatPath: string;
  private readonly procMeminfoPath: string;
  private readonly cgroupControllersPath: string;
  private readonly nftablesRulesetPath: string;
  private readonly nftablesInstalledPath: string;
  private readonly expectedRulesetSha256: string;
  private readonly cpuSampleDelayMs: number;
  private readonly requireProvisionedDirectories: boolean;
  private readonly allowUnprivilegedVerifyFallback: boolean;
  private readonly execFileRunner: ExecFileRunner;
  private readonly hostJobTriggerDir: string;
  private readonly rebootRequiredPath: string;
  private readonly aptListsDir: string;
  private readonly unattendedUpgradePath: string;
  private lastCpuSample: CpuTickSample | null = null;

  public constructor(options?: LinuxSystemHostAdapterOptions) {
    this.storagePath = options?.storagePath ?? "/var/lib/hosting-panel";
    this.fallbackStoragePath = options?.fallbackStoragePath ?? "/";
    this.diskPaths = {
      panel_data: this.storagePath,
      docker_data: "/var/lib/docker",
      database_data: "/var/lib/postgresql",
      root: "/",
      ...options?.diskPaths,
    };
    this.runtimeDirPath = options?.runtimeDirPath ?? "/run/hosting-panel";
    this.dockerSocketPath = options?.dockerSocketPath ?? "/var/run/docker.sock";
    this.procStatPath = options?.procStatPath ?? "/proc/stat";
    this.procMeminfoPath = options?.procMeminfoPath ?? "/proc/meminfo";
    this.cgroupControllersPath =
      options?.cgroupControllersPath ?? "/sys/fs/cgroup/cgroup.controllers";
    this.nftablesRulesetPath =
      options?.nftablesRulesetPath ?? resolveDefaultNftablesRulesetPath();
    this.nftablesInstalledPath = options?.nftablesInstalledPath ?? INSTALLED_NFTABLES_RULESET_PATH;
    this.expectedRulesetSha256 =
      options?.expectedRulesetSha256 ?? DEDICATED_NFTABLES_RULESET_SHA256;
    this.cpuSampleDelayMs = options?.cpuSampleDelayMs ?? 20;
    this.requireProvisionedDirectories = options?.requireProvisionedDirectories ?? false;
    this.allowUnprivilegedVerifyFallback = options?.allowUnprivilegedVerifyFallback ?? true;
    this.execFileRunner = options?.execFileRunner ?? runAllowlistedBinary;
    this.hostJobTriggerDir = options?.hostJobTriggerDir ?? HOST_JOB_TRIGGER_DIR;
    this.rebootRequiredPath = options?.rebootRequiredPath ?? "/run/reboot-required";
    this.aptListsDir = options?.aptListsDir ?? "/var/lib/apt/lists";
    this.unattendedUpgradePath = options?.unattendedUpgradePath ?? "/usr/bin/unattended-upgrade";
  }

  public async checkHealth(): Promise<HostAgentHealthResponse> {
    return HostAgentHealthResponseSchema.parse({
      component: "host_agent",
      status: "online",
      version: HOST_AGENT_VERSION,
      runtimeBackend: "linux-systemd",
      checkedAt: new Date().toISOString(),
    });
  }

  private async sampleCpuUsagePercent(): Promise<number> {
    try {
      const firstRaw = await readFile(this.procStatPath, "utf8");
      const first = parseProcStatCpuLine(firstRaw);
      if (!first) {
        return 0;
      }

      if (this.cpuSampleDelayMs > 0) {
        await delay(this.cpuSampleDelayMs);
      }

      const secondRaw = await readFile(this.procStatPath, "utf8");
      const second = parseProcStatCpuLine(secondRaw);
      if (!second) {
        return 0;
      }

      let usage: number;
      if (second.total > first.total) {
        usage = computeCpuUsageFromSamples(first, second);
      } else if (this.lastCpuSample && second.total > this.lastCpuSample.total) {
        usage = computeCpuUsageFromSamples(this.lastCpuSample, second);
      } else {
        usage = computeCpuUsageFromSamples(first, second);
      }

      this.lastCpuSample = second;
      return usage;
    } catch {
      return 0;
    }
  }

  private async readMemoryUsage(): Promise<{
    readonly totalBytes: bigint;
    readonly availableBytes: bigint;
    readonly usedBytes: bigint;
  }> {
    try {
      const raw = await readFile(this.procMeminfoPath, "utf8");
      const parsed = parseProcMeminfoBytes(raw);
      if (parsed) {
        return parsed;
      }
    } catch {
      // Fallback to Node os memory primitives on non-Linux environments
    }

    const totalBytes = BigInt(Math.max(0, os.totalmem()));
    const availableBytes = BigInt(Math.max(0, Math.min(os.totalmem(), os.freemem())));
    const usedBytes = totalBytes >= availableBytes ? totalBytes - availableBytes : 0n;
    return {
      totalBytes,
      availableBytes,
      usedBytes,
    };
  }

  private async readStorageUsage(): Promise<{
    readonly totalBytes: bigint;
    readonly availableBytes: bigint;
    readonly usedBytes: bigint;
    readonly resolvedTargetPath: string;
  }> {
    let targetPath = this.storagePath;
    let fsStats;
    try {
      fsStats = await statfs(targetPath);
    } catch {
      targetPath = this.fallbackStoragePath;
      fsStats = await statfs(targetPath);
    }

    return { ...statfsUsage(fsStats), resolvedTargetPath: targetPath };
  }

  // One row per filesystem, in order of first appearance; a place that cannot be read is skipped.
  private async readDisks(): Promise<HostDisk[]> {
    const rows: { dev: number; paths: HostDiskPath[]; usedBytes: string; totalBytes: string }[] = [];
    for (const name of HOST_DISK_PATHS) {
      try {
        const { dev } = await stat(this.diskPaths[name]);
        const row = rows.find((r) => r.dev === dev);
        if (row) {
          row.paths.push(name);
          continue;
        }
        const usage = statfsUsage(await statfs(this.diskPaths[name]));
        rows.push({
          dev,
          paths: [name],
          usedBytes: usage.usedBytes.toString(),
          totalBytes: usage.totalBytes.toString(),
        });
      } catch {
        // Missing or unreadable place: no row.
      }
    }
    return rows.map(({ paths, usedBytes, totalBytes }) => ({ paths, usedBytes, totalBytes }));
  }

  private async isDockerSocketPresent(): Promise<boolean> {
    try {
      const sockStat = await stat(this.dockerSocketPath);
      return sockStat.isSocket();
    } catch {
      return false;
    }
  }

  private async readKernelRelease(): Promise<string> {
    try {
      const { stdout } = await this.execFileRunner("/usr/bin/uname", ["-r"]);
      const trimmed = stdout.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    } catch {
      // Fallback to os.release()
    }
    return os.release();
  }

  private async resolveNftBinaryPath(): Promise<AllowedLinuxBinary> {
    const candidates: readonly AllowedLinuxBinary[] = ["/usr/sbin/nft", "/usr/bin/nft"];
    for (const candidate of candidates) {
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Try next allowlisted path
      }
    }
    return "/usr/sbin/nft";
  }

  public async getHostTelemetry(hostId: string): Promise<HostTelemetry | null> {
    if (!hostId || hostId.trim().length === 0) {
      throw new Error("hostId must not be empty");
    }

    const [cpuUsagePercent, memory, storage, dockerEngineReachable, disks] = await Promise.all([
      this.sampleCpuUsagePercent(),
      this.readMemoryUsage(),
      this.readStorageUsage(),
      this.isDockerSocketPresent(),
      this.readDisks(),
    ]);

    const wire = HostTelemetryWireSchema.parse({
      hostId: hostId.trim(),
      cpuUsagePercent,
      memoryUsedBytes: memory.usedBytes.toString(),
      memoryTotalBytes: memory.totalBytes.toString(),
      storageUsedBytes: storage.usedBytes.toString(),
      storageTotalBytes: storage.totalBytes.toString(),
      uptimeSeconds: Math.max(0, Math.floor(os.uptime())),
      kernelVersion: os.release(),
      dockerEngineReachable,
      collectedAt: new Date().toISOString(),
      disks,
    });

    return wire;
  }

  public async executeMaintenance(
    command: ApprovedHostMaintenanceCommand,
  ): Promise<HostMaintenanceResult> {
    const approved = createApprovedHostMaintenanceCommand({
      hostId: command.hostId,
      action: command.action,
      reason: command.reason,
    });

    const operationId = `op_maint_${randomUUID()}`;

    if (approved.action === "collect_diagnostics") {
      const [memory, storage, kernelRelease, cgroupV2Unified] = await Promise.all([
        this.readMemoryUsage(),
        this.readStorageUsage(),
        this.readKernelRelease(),
        access(this.cgroupControllersPath, fsConstants.R_OK)
          .then(() => true)
          .catch(() => false),
      ]);

      let dfVerified: boolean;
      try {
        const dfRes = await this.execFileRunner("/usr/bin/df", [
          "-P",
          "-B1",
          storage.resolvedTargetPath,
        ]);
        dfVerified = dfRes.stdout.trim().split("\n").length >= 2;
      } catch {
        dfVerified = false;
      }

      const [load1m = 0, load5m = 0, load15m = 0] = os.loadavg();
      const summary = redactSensitiveValue({
        action: approved.action,
        loadAverage: {
          oneMinute: Number(load1m.toFixed(2)),
          fiveMinutes: Number(load5m.toFixed(2)),
          fifteenMinutes: Number(load15m.toFixed(2)),
        },
        memory: {
          totalBytes: memory.totalBytes.toString(),
          availableBytes: memory.availableBytes.toString(),
          usedBytes: memory.usedBytes.toString(),
        },
        storage: {
          totalBytes: storage.totalBytes.toString(),
          availableBytes: storage.availableBytes.toString(),
          usedBytes: storage.usedBytes.toString(),
          dfProbeSucceeded: dfVerified,
        },
        cgroupV2Unified,
        kernelRelease,
        uptimeSeconds: Math.max(0, Math.floor(os.uptime())),
        collectedAt: new Date().toISOString(),
      });

      return {
        operationId,
        hostId: approved.hostId,
        action: approved.action,
        status: "succeeded",
        output: JSON.stringify(summary),
      };
    }

    if (approved.action === "verify_storage_posture") {
      const targets = [
        { target: "data_directory", targetPath: this.storagePath },
        { target: "runtime_directory", targetPath: this.runtimeDirPath },
      ] as const;

      const targetReports: Array<Record<string, unknown>> = [];
      let allProvisionedAndCompliant = true;

      for (const entry of targets) {
        try {
          const [dirStat, dirFs] = await Promise.all([
            stat(entry.targetPath),
            statfs(entry.targetPath),
          ]);
          const modeOctal = dirStat.mode & 0o777;
          // The runtime dir is group-writable (3770 root:hp-ipc) so the daemons can create their sockets.
          const permissionsCompliant =
            dirStat.isDirectory() &&
            (modeOctal === 0o750 ||
              modeOctal === 0o700 ||
              (entry.target === "runtime_directory" && modeOctal === 0o770));
          const bsize = BigInt(Math.max(1, Number(dirFs.bsize)));
          const availableBytes = BigInt(Math.max(0, Number(dirFs.bavail))) * bsize;
          const totalBytes = BigInt(Math.max(0, Number(dirFs.blocks))) * bsize;

          if (!permissionsCompliant || availableBytes <= 0n) {
            allProvisionedAndCompliant = false;
          }

          targetReports.push({
            target: entry.target,
            provisioned: true,
            modeOctal: `0${modeOctal.toString(8)}`,
            permissionsCompliant,
            availableBytes: availableBytes.toString(),
            totalBytes: totalBytes.toString(),
          });
        } catch {
          allProvisionedAndCompliant = false;
          const fallbackStorage = await this.readStorageUsage();
          targetReports.push({
            target: entry.target,
            provisioned: false,
            modeOctal: null,
            permissionsCompliant: false,
            availableBytes: fallbackStorage.availableBytes.toString(),
            totalBytes: fallbackStorage.totalBytes.toString(),
          });
        }
      }

      const status =
        this.requireProvisionedDirectories && !allProvisionedAndCompliant
          ? "failed"
          : "succeeded";

      const postureSummary = redactSensitiveValue({
        action: approved.action,
        allProvisionedAndCompliant,
        targets: targetReports,
        checkedAt: new Date().toISOString(),
      });

      return {
        operationId,
        hostId: approved.hostId,
        action: approved.action,
        status,
        output: JSON.stringify(postureSummary),
      };
    }

    // refresh_host_inventory
    const [memory, storage, kernelRelease] = await Promise.all([
      this.readMemoryUsage(),
      this.readStorageUsage(),
      this.readKernelRelease(),
    ]);
    const logicalCpus = Math.max(1, os.cpus().length);

    const inventorySummary = redactSensitiveValue({
      action: approved.action,
      logicalCpus,
      totalCpuMilli: logicalCpus * 1000,
      totalMemoryBytes: memory.totalBytes.toString(),
      totalStorageBytes: storage.totalBytes.toString(),
      architecture: os.arch(),
      kernelRelease,
      refreshedAt: new Date().toISOString(),
    });

    return {
      operationId,
      hostId: approved.hostId,
      action: approved.action,
      status: "succeeded",
      output: JSON.stringify(inventorySummary),
    };
  }

  public async executeSecurityPolicy(
    command: ApprovedHostSecurityCommand,
  ): Promise<HostSecurityResult> {
    const approved = createApprovedHostSecurityCommand({
      hostId: command.hostId,
      policyRef: command.policyRef,
      reason: command.reason,
    });

    // Mandatory SHA-256 integrity verification BEFORE invoking nft
    const verifiedRuleset = await verifyStaticNftablesRuleset(
      this.nftablesRulesetPath,
      this.expectedRulesetSha256,
    );

    const operationId = `op_sec_${randomUUID()}`;
    if (!(await this.firewallInstalled())) {
      return {
        operationId,
        hostId: approved.hostId,
        policyRef: approved.policyRef,
        status: "failed",
        output: JSON.stringify({
          policyRef: approved.policyRef,
          rulesetId: verifiedRuleset.rulesetId,
          rulesetSha256Verified: true,
          reason: "panel firewall not installed on this server",
          checkedAt: new Date().toISOString(),
        }),
      };
    }
    const nftBinary = await this.resolveNftBinaryPath();

    if (approved.policyRef === "verify_baseline_firewall") {
      try {
        await this.execFileRunner(nftBinary, ["-c", "-f", this.nftablesRulesetPath]);
        const output = redactSensitiveValue({
          policyRef: approved.policyRef,
          rulesetId: verifiedRuleset.rulesetId,
          rulesetSha256: verifiedRuleset.sha256,
          rulesetSha256Verified: true,
          kernelDryRunVerified: true,
          checkedAt: new Date().toISOString(),
        });
        return {
          operationId,
          hostId: approved.hostId,
          policyRef: approved.policyRef,
          status: "succeeded",
          output: JSON.stringify(output),
        };
      } catch (err) {
        if (this.allowUnprivilegedVerifyFallback && isMissingCapNetAdminError(err)) {
          const nftBinaryPresent = await access(nftBinary, fsConstants.X_OK)
            .then(() => true)
            .catch(() => false);
          const output = redactSensitiveValue({
            policyRef: approved.policyRef,
            rulesetId: verifiedRuleset.rulesetId,
            rulesetSha256: verifiedRuleset.sha256,
            rulesetSha256Verified: true,
            nftBinaryPresent,
            kernelDryRunVerified: false,
            kernelCheckNote: "unprivileged_cap_net_admin_unavailable",
            checkedAt: new Date().toISOString(),
          });
          return {
            operationId,
            hostId: approved.hostId,
            policyRef: approved.policyRef,
            status: nftBinaryPresent ? "succeeded" : "failed",
            output: JSON.stringify(output),
          };
        }

        const failureOutput = redactSensitiveValue({
          policyRef: approved.policyRef,
          rulesetId: verifiedRuleset.rulesetId,
          rulesetSha256Verified: true,
          kernelDryRunVerified: false,
          reason: "nftables syntax or kernel check failed",
          checkedAt: new Date().toISOString(),
        });
        return {
          operationId,
          hostId: approved.hostId,
          policyRef: approved.policyRef,
          status: "failed",
          output: JSON.stringify(failureOutput),
        };
      }
    }

    // apply_dedicated_nftables_22_80_443
    try {
      await this.execFileRunner(nftBinary, ["-f", this.nftablesRulesetPath]);
      const output = redactSensitiveValue({
        policyRef: approved.policyRef,
        rulesetId: verifiedRuleset.rulesetId,
        rulesetSha256: verifiedRuleset.sha256,
        rulesetSha256Verified: true,
        applied: true,
        appliedAt: new Date().toISOString(),
      });
      return {
        operationId,
        hostId: approved.hostId,
        policyRef: approved.policyRef,
        status: "succeeded",
        output: JSON.stringify(output),
      };
    } catch (err) {
      const missingCap = isMissingCapNetAdminError(err);
      const failureOutput = redactSensitiveValue({
        policyRef: approved.policyRef,
        rulesetId: verifiedRuleset.rulesetId,
        rulesetSha256Verified: true,
        applied: false,
        reason: missingCap
          ? "CAP_NET_ADMIN capability is required to apply nftables ruleset"
          : "nftables ruleset application failed",
        checkedAt: new Date().toISOString(),
      });
      return {
        operationId,
        hostId: approved.hostId,
        policyRef: approved.policyRef,
        status: "failed",
        output: JSON.stringify(failureOutput),
      };
    }
  }

  /** Runs a tool; any failure but a policy refusal becomes the fixed sentence. */
  private async runTool(binary: AllowedLinuxBinary, args: readonly string[], options?: RunOptions): Promise<string> {
    try {
      return (await this.execFileRunner(binary, args, options)).stdout;
    } catch (err) {
      if (err instanceof HostPolicyDeniedError) throw err;
      throw hostToolFailed();
    }
  }

  /** True only when the installer's boot copy of the ruleset is a file (R202 1.2). */
  private firewallInstalled(): Promise<boolean> {
    return stat(this.nftablesInstalledPath).then((s) => s.isFile(), () => false);
  }

  public async readFirewall(): Promise<HostFirewallState> {
    const readAt = new Date().toISOString();
    if (!(await this.firewallInstalled()))
      return { baseRules: "unmanaged", openedPorts: [], blockedV4: [], blockedV6: [], readAt };
    try {
      const { stdout } = await this.execFileRunner(await this.resolveNftBinaryPath(), NFT_LIST_FORM);
      return { ...parseFirewallListing(stdout), readAt };
    } catch (err) {
      if (err instanceof HostPolicyDeniedError || (err as { code?: unknown }).code === "NOT_SUPPORTED") throw err;
      // nft answers a missing table with ENOENT text; only that case is "absent".
      if (/No such file or directory/.test(String((err as { stderr?: unknown }).stderr ?? "")))
        return { baseRules: "absent", openedPorts: [], blockedV4: [], blockedV6: [], readAt };
      throw hostToolFailed();
    }
  }

  public async replaceFirewallSets(sets: HostFirewallSets): Promise<HostFirewallState> {
    const valid = validateFirewallSets(sets);
    if ((await this.readFirewall()).baseRules !== "current")
      throw hostAgentError("RESOURCE_LOCKED", "Firewall base rules are not current");
    // nft refuses "-f -" when stdin is the socket Node gives a child ("Not a regular file"), so the
    // one-transaction program goes to a 0600 file in a fresh 0700 folder (the unit's PrivateTmp).
    const programDir = await mkdtemp(join(os.tmpdir(), "hp-nft-"));
    try {
      const programPath = join(programDir, "sets.nft");
      await writeFile(programPath, buildFirewallSetsProgram(valid), { mode: 0o600, flag: "wx" });
      await this.runTool(await this.resolveNftBinaryPath(), ["-f", programPath]);
    } finally {
      await rm(programDir, { recursive: true, force: true });
    }
    return this.readFirewall();
  }

  public async readHostServices(): Promise<readonly HostServiceState[]> {
    return parseHostServices(await this.runTool("/usr/bin/systemctl", SYSTEMCTL_SERVICES_FORM));
  }

  public async readHostJournal(unit: HostJournalUnit, lines: number): Promise<readonly HostJournalLine[]> {
    if (!(HOST_JOURNAL_UNITS as readonly string[]).includes(unit) || !Number.isInteger(lines) || lines < 1 || lines > HOST_JOURNAL_MAX_LINES)
      throw new HostPolicyDeniedError("Journal request refused");
    return parseJournalJson(await this.runTool("/usr/bin/journalctl", journalctlForm(unit, String(lines)), { maxBuffer: 10 * 1024 * 1024 }));
  }

  public async readOsPackages(): Promise<HostOsPackages> {
    const packages = parseAptUpgradeSimulation(await this.runTool("/usr/bin/apt-get", ["-s", "upgrade"], { maxBuffer: 1024 * 1024 }));
    const [rebootRequired, canUpgrade, listsReadAt] = await Promise.all([
      access(this.rebootRequiredPath).then(() => true, () => false),
      access(this.unattendedUpgradePath, fsConstants.X_OK).then(() => true, () => false),
      this.newestAptListTime(),
    ]);
    return { packages, rebootRequired, canUpgrade, listsReadAt };
  }

  /** Newest mtime of a regular file in the apt lists directory, or null. */
  private async newestAptListTime(): Promise<string | null> {
    const entries = await readdir(this.aptListsDir, { withFileTypes: true }).catch(() => []);
    let newest = 0;
    for (const e of entries) {
      if (!e.isFile()) continue;
      // apt-get update may remove a list between readdir and stat: that file is skipped.
      const st = await stat(join(this.aptListsDir, e.name)).catch((err: unknown) => {
        if ((err as { code?: unknown }).code === "ENOENT") return null;
        throw err;
      });
      if (st) newest = Math.max(newest, st.mtimeMs);
    }
    return newest > 0 ? new Date(newest).toISOString() : null;
  }

  private assertHostJob(job: HostJob): void {
    if (!(HOST_JOBS as readonly string[]).includes(job)) throw new HostPolicyDeniedError("Host job refused");
  }

  private async readJobBlocks(job: HostJob): Promise<Map<string, Record<string, string>>> {
    return parseSystemctlShow(await this.runTool("/usr/bin/systemctl", systemctlJobForm(HOST_JOB_UNITS[job])));
  }

  private triggerExists(job: HostJob): Promise<boolean> {
    return access(join(this.hostJobTriggerDir, HOST_JOB_UNITS[job])).then(() => true, () => false);
  }

  /** On the job calls only missing units are NOT_SUPPORTED; any other tool failure is retryable (R203 1.2). */
  private async jobRead<T>(read: Promise<T>): Promise<T> {
    try {
      return await read;
    } catch (err) {
      if (err instanceof HostPolicyDeniedError || (err as Error).message === HOST_JOB_UNITS_MISSING) throw err;
      throw hostAgentError("HOST_AGENT_UNAVAILABLE", HOST_TOOL_FAILED);
    }
  }

  public async requestHostJob(job: HostJob): Promise<HostJobState> {
    this.assertHostJob(job);
    const blocks = await this.jobRead(this.readJobBlocks(job));
    const trigger = join(this.hostJobTriggerDir, HOST_JOB_UNITS[job]);
    // R198 2.4: a file no active path unit watches would wait forever; remove it.
    if (blocks.get(`${HOST_JOB_UNITS[job]}.path`)?.ActiveState !== "active") {
      await rm(trigger, { force: true });
      throw hostAgentError("NOT_SUPPORTED", HOST_JOB_UNITS_MISSING);
    }
    if ((await this.jobRead(this.triggerExists(job).then((t) => hostJobState(job, blocks, t)))).state === "running")
      throw hostAgentError("RESOURCE_LOCKED", HOST_JOB_RUNNING);
    try {
      await writeFile(trigger, "", { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as { code?: unknown }).code === "EEXIST") throw hostAgentError("RESOURCE_LOCKED", HOST_JOB_RUNNING);
      throw hostToolFailed();
    }
    // R203 1.1: root's unit may already run; a read here that failed would say "not started".
    return hostJobState(job, blocks, true);
  }

  public async readHostJob(job: HostJob): Promise<HostJobState> {
    this.assertHostJob(job);
    return this.jobRead(this.readJobBlocks(job).then(async (blocks) => hostJobState(job, blocks, await this.triggerExists(job))));
  }
}
