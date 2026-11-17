import {
  hostAgentError,
  type HostFirewallSets,
  type HostFirewallState,
  type HostJob,
  type HostJobState,
  type HostJournalLine,
  type HostJournalUnit,
  type HostOsPackages,
  type HostServiceState,
} from "./host-jobs.js";
import {
  isAllowlistedHostMaintenanceAction,
  type ApprovedHostMaintenanceCommand,
} from "./maintenance.js";
import type {
  HostAgentPort,
  HostMaintenanceResult,
  HostSecurityResult,
  HostTelemetry,
} from "./port.js";
import {
  isAllowlistedHostSecurityPolicy,
  type ApprovedHostSecurityCommand,
} from "./security.js";

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

  async executeSecurityPolicy(
    command: ApprovedHostSecurityCommand,
  ): Promise<HostSecurityResult> {
    if (!isAllowlistedHostSecurityPolicy(command.policyRef)) {
      const error = new Error(`Security policy '${command.policyRef}' is not allowlisted`);
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

  async readFirewall(): Promise<HostFirewallState> {
    throw disabled();
  }

  async replaceFirewallSets(_sets: HostFirewallSets): Promise<HostFirewallState> {
    throw disabled();
  }

  async readHostServices(): Promise<readonly HostServiceState[]> {
    throw disabled();
  }

  async readHostJournal(_unit: HostJournalUnit, _lines: number): Promise<readonly HostJournalLine[]> {
    throw disabled();
  }

  async readOsPackages(): Promise<HostOsPackages> {
    throw disabled();
  }

  async requestHostJob(_job: HostJob): Promise<HostJobState> {
    throw disabled();
  }

  async readHostJob(_job: HostJob): Promise<HostJobState> {
    throw disabled();
  }
}

/** The refusal of every M5d call while the runtime is disabled. */
function disabled(): Error {
  return hostAgentError("NOT_SUPPORTED", "Host agent runtime execution is disabled in Phase 1 (HCP-SPEC-002 §1.3 & ADR-006)");
}
