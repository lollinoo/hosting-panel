export const ALLOWLISTED_HOST_MAINTENANCE_ACTIONS = [
  "collect_diagnostics",
  "verify_storage_posture",
  "refresh_host_inventory",
] as const;

export type AllowlistedHostMaintenanceAction =
  (typeof ALLOWLISTED_HOST_MAINTENANCE_ACTIONS)[number];

const ALLOWLISTED_ACTIONS_SET: ReadonlySet<string> = new Set(
  ALLOWLISTED_HOST_MAINTENANCE_ACTIONS,
);

export function isAllowlistedHostMaintenanceAction(
  action: string,
): action is AllowlistedHostMaintenanceAction {
  return ALLOWLISTED_ACTIONS_SET.has(action);
}

export interface ApprovedHostMaintenanceCommand {
  readonly __brand: "ApprovedHostMaintenanceCommand";
  readonly hostId: string;
  readonly action: AllowlistedHostMaintenanceAction;
  readonly reason?: string;
  readonly approvedAt: string;
}

export interface CreateApprovedHostMaintenanceCommandInput {
  readonly hostId: string;
  readonly action: string;
  readonly reason?: string;
}

export function createApprovedHostMaintenanceCommand(
  input: CreateApprovedHostMaintenanceCommandInput,
): ApprovedHostMaintenanceCommand {
  if (!isAllowlistedHostMaintenanceAction(input.action)) {
    const error = new Error(
      `Action '${input.action}' is not in ALLOWLISTED_HOST_MAINTENANCE_ACTIONS (${ALLOWLISTED_HOST_MAINTENANCE_ACTIONS.join(
        ", ",
      )})`,
    );
    (error as unknown as { code: string }).code = "HOST_POLICY_DENIED";
    throw error;
  }

  if (!input.hostId || input.hostId.trim().length === 0) {
    throw new Error("hostId must not be empty");
  }

  return Object.freeze({
    __brand: "ApprovedHostMaintenanceCommand" as const,
    hostId: input.hostId,
    action: input.action,
    reason: input.reason,
    approvedAt: new Date().toISOString(),
  });
}
