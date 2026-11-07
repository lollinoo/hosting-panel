import {
  isAllowlistedHostMaintenanceAction,
  type ApprovedHostMaintenanceCommand,
} from "./maintenance.js";
import type { HostAgentPort, HostMaintenanceResult, HostTelemetry } from "./port.js";

export class Phase1DisabledHostAgent implements HostAgentPort {
  readonly isRuntimeAvailable = false;

  async executeMaintenance(
    command: ApprovedHostMaintenanceCommand,
  ): Promise<HostMaintenanceResult> {
    if (!isAllowlistedHostMaintenanceAction(command.action)) {
      const error = new Error(`Maintenance action '${command.action}' is not allowlisted`);
      (error as unknown as { code: string }).code = "HOST_POLICY_DENIED";
      throw error;
    }

    const error = new Error(
      "Host agent runtime execution is disabled in Phase 1 (HCP-SPEC-002 §1.3 & ADR-006)",
    );
    (error as unknown as { code: string }).code = "NOT_SUPPORTED";
    throw error;
  }

  async getHostTelemetry(_hostId: string): Promise<HostTelemetry | null> {
    return null;
  }
}
