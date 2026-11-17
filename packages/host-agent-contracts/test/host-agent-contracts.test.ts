import { describe, expect, it } from "vitest";
import { HOST_SERVICE_UNIT, IPC_HOST_JOBS, IPC_HOST_JOURNAL_UNITS } from "@hosting-panel/contracts";
import {
  HOST_JOBS,
  HOST_JOB_UNITS,
  HOST_JOURNAL_UNITS,
  HOST_SERVICE_UNITS,
  ALLOWLISTED_HOST_MAINTENANCE_ACTIONS,
  ALLOWLISTED_HOST_SECURITY_POLICIES,
  HostAgentHealthResponseSchema,
  HostMaintenanceIpcRequestSchema,
  HostSecurityIpcRequestSchema,
  HostTelemetryWireSchema,
  Phase1DisabledHostAgent,
  createApprovedHostMaintenanceCommand,
  createApprovedHostSecurityCommand,
  isAllowlistedHostMaintenanceAction,
  isAllowlistedHostSecurityPolicy,
} from "../src/index.js";

describe("@hosting-panel/host-agent-contracts — Maintenance & Security Allowlists (AC-F2-04)", () => {
  it("defines strictly bounded ALLOWLISTED_HOST_MAINTENANCE_ACTIONS", () => {
    expect(ALLOWLISTED_HOST_MAINTENANCE_ACTIONS).toEqual([
      "collect_diagnostics",
      "verify_storage_posture",
      "refresh_host_inventory",
    ]);

    expect(isAllowlistedHostMaintenanceAction("collect_diagnostics")).toBe(true);
    expect(isAllowlistedHostMaintenanceAction("verify_storage_posture")).toBe(true);
    expect(isAllowlistedHostMaintenanceAction("refresh_host_inventory")).toBe(true);
    expect(isAllowlistedHostMaintenanceAction("arbitrary_exec")).toBe(false);
    expect(isAllowlistedHostMaintenanceAction("reboot")).toBe(false);
  });

  it("creates approved maintenance command for allowlisted action", () => {
    const cmd = createApprovedHostMaintenanceCommand({
      hostId: "hst-01",
      action: "collect_diagnostics",
      reason: "Scheduled routine diagnostics",
    });

    expect(cmd.__brand).toBe("ApprovedHostMaintenanceCommand");
    expect(cmd.hostId).toBe("hst-01");
    expect(cmd.action).toBe("collect_diagnostics");
    expect(Object.isFrozen(cmd)).toBe(true);
  });

  it("strictly rejects non-allowlisted maintenance action with HOST_POLICY_DENIED", () => {
    try {
      createApprovedHostMaintenanceCommand({
        hostId: "hst-01",
        action: "run_shell_script",
      });
      expect.fail("Should have thrown");
    } catch (err: unknown) {
      expect((err as { code: string }).code).toBe("HOST_POLICY_DENIED");
    }
  });

  it("defines strictly bounded ALLOWLISTED_HOST_SECURITY_POLICIES and rejects non-allowlisted policies (AC-F2-04)", () => {
    expect(ALLOWLISTED_HOST_SECURITY_POLICIES).toEqual([
      "verify_baseline_firewall",
      "apply_dedicated_nftables_22_80_443",
    ]);

    expect(isAllowlistedHostSecurityPolicy("verify_baseline_firewall")).toBe(true);
    expect(isAllowlistedHostSecurityPolicy("apply_dedicated_nftables_22_80_443")).toBe(true);
    expect(isAllowlistedHostSecurityPolicy("nft flush ruleset")).toBe(false);
    expect(isAllowlistedHostSecurityPolicy("sh -c 'iptables -F'")).toBe(false);

    const secCmd = createApprovedHostSecurityCommand({
      hostId: "hst-01",
      policyRef: "verify_baseline_firewall",
      reason: "Routine firewall verification",
    });
    expect(secCmd.__brand).toBe("ApprovedHostSecurityCommand");
    expect(secCmd.policyRef).toBe("verify_baseline_firewall");
    expect(Object.isFrozen(secCmd)).toBe(true);

    expect(() =>
      createApprovedHostSecurityCommand({
        hostId: "hst-01",
        policyRef: "open_port_3306",
      }),
    ).toThrowError(expect.objectContaining({ code: "HOST_POLICY_DENIED" }));
  });

  it("validates Host Agent IPC Zod schemas", () => {
    expect(
      HostMaintenanceIpcRequestSchema.parse({
        operationId: "op_01",
        hostId: "hst_01",
        action: "verify_storage_posture",
      }).action,
    ).toBe("verify_storage_posture");

    expect(
      HostMaintenanceIpcRequestSchema.safeParse({
        hostId: "hst_01",
        action: "rm -rf /",
      }).success,
    ).toBe(false);

    expect(
      HostSecurityIpcRequestSchema.parse({
        operationId: "op_02",
        hostId: "hst_01",
        policyRef: "apply_dedicated_nftables_22_80_443",
      }).policyRef,
    ).toBe("apply_dedicated_nftables_22_80_443");

    expect(
      HostSecurityIpcRequestSchema.safeParse({
        hostId: "hst_01",
        policyRef: "custom_nft_rule",
      }).success,
    ).toBe(false);

    expect(
      HostTelemetryWireSchema.parse({
        hostId: "hst_01",
        cpuUsagePercent: 12.4,
        memoryUsedBytes: "2147483648",
        memoryTotalBytes: "8589934592",
        storageUsedBytes: "10737418240",
        storageTotalBytes: "107374182400",
        uptimeSeconds: 3600,
        kernelVersion: "6.8.0-45-generic",
        dockerEngineReachable: true,
        collectedAt: "2026-11-07T12:00:00.000Z",
      }).dockerEngineReachable,
    ).toBe(true);

    expect(
      HostAgentHealthResponseSchema.parse({
        component: "host_agent",
        status: "online",
        version: "0.2.0",
        checkedAt: "2026-11-07T12:00:00.000Z",
      }).status,
    ).toBe("online");
  });
});

describe("@hosting-panel/host-agent-contracts — Phase1DisabledHostAgent", () => {
  it("enforces Phase 1 disabled execution returning NOT_SUPPORTED for maintenance and security", async () => {
    const agent = new Phase1DisabledHostAgent();
    expect(agent.isRuntimeAvailable).toBe(false);

    const maintCmd = createApprovedHostMaintenanceCommand({
      hostId: "hst-01",
      action: "refresh_host_inventory",
    });

    await expect(agent.executeMaintenance(maintCmd)).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
    });

    const secCmd = createApprovedHostSecurityCommand({
      hostId: "hst-01",
      policyRef: "verify_baseline_firewall",
    });

    await expect(agent.executeSecurityPolicy(secCmd)).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
    });

    const telemetry = await agent.getHostTelemetry("hst-01");
    expect(telemetry).toBeNull();
  });
});

describe("@hosting-panel/host-agent-contracts — M5d host jobs", () => {
  it("takes the closed lists from the wire schemas, not copies", () => {
    expect(HOST_JOBS).toBe(IPC_HOST_JOBS);
    expect(HOST_JOURNAL_UNITS).toBe(IPC_HOST_JOURNAL_UNITS);
  });

  it("names the four services as the public contract and the journal list do", () => {
    expect(HOST_SERVICE_UNITS).toEqual(Object.values(HOST_SERVICE_UNIT));
    expect(HOST_SERVICE_UNITS).toEqual(HOST_JOURNAL_UNITS.slice(0, 4));
  });

  it("gives every job its unit", () => {
    expect(Object.keys(HOST_JOB_UNITS).sort()).toEqual([...HOST_JOBS].sort());
    for (const job of HOST_JOBS) expect(HOST_JOB_UNITS[job]).toMatch(/^hp-[a-z@-]+$/);
  });

  it("refuses each of the seven calls when the agent is disabled", async () => {
    const agent = new Phase1DisabledHostAgent();
    const calls = [
      () => agent.readFirewall(),
      () => agent.replaceFirewallSets({ openedPorts: [], blockedV4: [], blockedV6: [] }),
      () => agent.readHostServices(),
      () => agent.readHostJournal("hp-api", 10),
      () => agent.readOsPackages(),
      () => agent.requestHostJob("os_refresh"),
      () => agent.readHostJob("os_refresh"),
    ];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });
});
