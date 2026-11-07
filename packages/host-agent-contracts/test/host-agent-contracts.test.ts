import { describe, expect, it } from "vitest";
import {
  ALLOWLISTED_HOST_MAINTENANCE_ACTIONS,
  Phase1DisabledHostAgent,
  createApprovedHostMaintenanceCommand,
  isAllowlistedHostMaintenanceAction,
} from "../src/index.js";

describe("@hosting-panel/host-agent-contracts — Maintenance Actions Allowlist", () => {
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
});

describe("@hosting-panel/host-agent-contracts — Phase1DisabledHostAgent", () => {
  it("enforces Phase 1 disabled execution returning NOT_SUPPORTED", async () => {
    const agent = new Phase1DisabledHostAgent();
    expect(agent.isRuntimeAvailable).toBe(false);

    const cmd = createApprovedHostMaintenanceCommand({
      hostId: "hst-01",
      action: "refresh_host_inventory",
    });

    await expect(agent.executeMaintenance(cmd)).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
    });

    const telemetry = await agent.getHostTelemetry("hst-01");
    expect(telemetry).toBeNull();
  });
});
