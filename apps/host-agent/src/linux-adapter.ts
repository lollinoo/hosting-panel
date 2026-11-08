import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile, stat, statfs } from "node:fs/promises";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
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
import {
  DEDICATED_NFTABLES_RULESET_SHA256,
  HostPolicyDeniedError,
  resolveDefaultNftablesRulesetPath,
  verifyStaticNftablesRuleset,
} from "./nftables-baseline.js";

const execFileAsync = promisify(execFile);

export const HOST_AGENT_VERSION = "0.2.0" as const;

export const ALLOWED_LINUX_BINARIES = [
  "/usr/sbin/nft",
  "/usr/bin/nft",
  "/usr/bin/uname",
  "/usr/bin/df",
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

export type ExecFileRunner = (
  binaryPath: AllowedLinuxBinary,
  args: readonly string[],
) => Promise<ExecFileResult>;

const SAFE_ARG_PATTERN = /^[^\r\n\0]{1,512}$/;

export async function runAllowlistedBinary(
  binaryPath: AllowedLinuxBinary,
  args: readonly string[],
): Promise<ExecFileResult> {
  if (!ALLOWED_LINUX_BINARIES_SET.has(binaryPath)) {
    throw new HostPolicyDeniedError("Requested Linux binary is not allowlisted");
  }

  for (const arg of args) {
    if (!SAFE_ARG_PATTERN.test(arg)) {
      throw new HostPolicyDeniedError("Unsafe control characters in binary argument array");
    }
  }

  const { stdout, stderr } = await execFileAsync(binaryPath, [...args], {
    shell: false,
    env: SANITIZED_LINUX_ENV,
    timeout: 10_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });

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

export interface LinuxSystemHostAdapterOptions {
  readonly storagePath?: string;
  readonly fallbackStoragePath?: string;
  readonly runtimeDirPath?: string;
  readonly dockerSocketPath?: string;
  readonly procStatPath?: string;
  readonly procMeminfoPath?: string;
  readonly cgroupControllersPath?: string;
  readonly nftablesRulesetPath?: string;
  readonly expectedRulesetSha256?: string;
  readonly cpuSampleDelayMs?: number;
  readonly requireProvisionedDirectories?: boolean;
  readonly allowUnprivilegedVerifyFallback?: boolean;
  readonly execFileRunner?: ExecFileRunner;
}

export class LinuxSystemHostAdapter implements HostAgentPort {
  public readonly isRuntimeAvailable = true;

  private readonly storagePath: string;
  private readonly fallbackStoragePath: string;
  private readonly runtimeDirPath: string;
  private readonly dockerSocketPath: string;
  private readonly procStatPath: string;
  private readonly procMeminfoPath: string;
  private readonly cgroupControllersPath: string;
  private readonly nftablesRulesetPath: string;
  private readonly expectedRulesetSha256: string;
  private readonly cpuSampleDelayMs: number;
  private readonly requireProvisionedDirectories: boolean;
  private readonly allowUnprivilegedVerifyFallback: boolean;
  private readonly execFileRunner: ExecFileRunner;
  private lastCpuSample: CpuTickSample | null = null;

  public constructor(options?: LinuxSystemHostAdapterOptions) {
    this.storagePath = options?.storagePath ?? "/var/lib/hosting-panel";
    this.fallbackStoragePath = options?.fallbackStoragePath ?? "/";
    this.runtimeDirPath = options?.runtimeDirPath ?? "/run/hosting-panel";
    this.dockerSocketPath = options?.dockerSocketPath ?? "/var/run/docker.sock";
    this.procStatPath = options?.procStatPath ?? "/proc/stat";
    this.procMeminfoPath = options?.procMeminfoPath ?? "/proc/meminfo";
    this.cgroupControllersPath =
      options?.cgroupControllersPath ?? "/sys/fs/cgroup/cgroup.controllers";
    this.nftablesRulesetPath =
      options?.nftablesRulesetPath ?? resolveDefaultNftablesRulesetPath();
    this.expectedRulesetSha256 =
      options?.expectedRulesetSha256 ?? DEDICATED_NFTABLES_RULESET_SHA256;
    this.cpuSampleDelayMs = options?.cpuSampleDelayMs ?? 20;
    this.requireProvisionedDirectories = options?.requireProvisionedDirectories ?? false;
    this.allowUnprivilegedVerifyFallback = options?.allowUnprivilegedVerifyFallback ?? true;
    this.execFileRunner = options?.execFileRunner ?? runAllowlistedBinary;
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

    const bsize = BigInt(Math.max(1, Number(fsStats.bsize)));
    const blocks = BigInt(Math.max(0, Number(fsStats.blocks)));
    const bavail = BigInt(Math.max(0, Number(fsStats.bavail)));
    const clampedAvail = bavail > blocks ? blocks : bavail;
    const totalBytes = blocks * bsize;
    const availableBytes = clampedAvail * bsize;
    const usedBytes = totalBytes >= availableBytes ? totalBytes - availableBytes : 0n;

    return {
      totalBytes,
      availableBytes,
      usedBytes,
      resolvedTargetPath: targetPath,
    };
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

    const [cpuUsagePercent, memory, storage, dockerEngineReachable] = await Promise.all([
      this.sampleCpuUsagePercent(),
      this.readMemoryUsage(),
      this.readStorageUsage(),
      this.isDockerSocketPresent(),
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

    const nftBinary = await this.resolveNftBinaryPath();
    const operationId = `op_sec_${randomUUID()}`;

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
}
