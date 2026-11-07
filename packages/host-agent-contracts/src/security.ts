export const ALLOWLISTED_HOST_SECURITY_POLICIES = [
  "verify_baseline_firewall",
  "apply_dedicated_nftables_22_80_443",
] as const;

export type AllowlistedHostSecurityPolicy =
  (typeof ALLOWLISTED_HOST_SECURITY_POLICIES)[number];

const ALLOWLISTED_SECURITY_POLICIES_SET: ReadonlySet<string> = new Set(
  ALLOWLISTED_HOST_SECURITY_POLICIES,
);

export function isAllowlistedHostSecurityPolicy(
  policyRef: string,
): policyRef is AllowlistedHostSecurityPolicy {
  return ALLOWLISTED_SECURITY_POLICIES_SET.has(policyRef);
}

export interface ApprovedHostSecurityCommand {
  readonly __brand: "ApprovedHostSecurityCommand";
  readonly hostId: string;
  readonly policyRef: AllowlistedHostSecurityPolicy;
  readonly reason?: string;
  readonly approvedAt: string;
}

export interface CreateApprovedHostSecurityCommandInput {
  readonly hostId: string;
  readonly policyRef: string;
  readonly reason?: string;
}

export function createApprovedHostSecurityCommand(
  input: CreateApprovedHostSecurityCommandInput,
): ApprovedHostSecurityCommand {
  if (!isAllowlistedHostSecurityPolicy(input.policyRef)) {
    const error = new Error(
      `Security policy '${input.policyRef}' is not in ALLOWLISTED_HOST_SECURITY_POLICIES (${ALLOWLISTED_HOST_SECURITY_POLICIES.join(
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
    __brand: "ApprovedHostSecurityCommand" as const,
    hostId: input.hostId,
    policyRef: input.policyRef,
    reason: input.reason,
    approvedAt: new Date().toISOString(),
  });
}
