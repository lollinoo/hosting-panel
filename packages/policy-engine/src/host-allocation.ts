import { PLATFORM_OPS_ORG_ID } from "@hosting-panel/contracts";
import type {
  ErrorCode,
  HostAllocationStatus,
  HostStatus,
  HostingMode,
} from "@hosting-panel/contracts";

export interface HostAdmissionTarget {
  readonly id: string;
  readonly status: HostStatus;
  readonly hostingMode: HostingMode;
  readonly securityReviewed: boolean;
  readonly sharedApproved: boolean;
}

export interface ExistingAllocationSnapshot {
  readonly id: string;
  readonly organizationId: string;
  readonly status: HostAllocationStatus;
  readonly hostingMode: HostingMode;
}

export interface HostAllocationAdmissionResult {
  readonly admitted: boolean;
  readonly errorCode: ErrorCode | null;
  readonly reason: string;
}

export function evaluateHostAllocationAdmission(
  host: HostAdmissionTarget,
  requestOrganizationId: string,
  existingAllocations: readonly ExistingAllocationSnapshot[],
  targetHostingMode?: HostingMode,
): HostAllocationAdmissionResult {
  if (host.status !== "ready") {
    return {
      admitted: false,
      errorCode: "HOST_POLICY_DENIED",
      reason: `Host status '${host.status}' is not ready for allocation`,
    };
  }

  const effectiveMode = targetHostingMode ?? host.hostingMode;

  if (effectiveMode === "shared") {
    if (!host.securityReviewed || !host.sharedApproved) {
      return {
        admitted: false,
        errorCode: "SHARED_MODE_GATED",
        reason: "Shared hosting mode requires completed security review and explicit approval",
      };
    }
  }

  // Platform-ops only holds unassigned sites: it neither occupies a dedicated host nor is refused one.
  if (effectiveMode === "dedicated" && requestOrganizationId !== PLATFORM_OPS_ORG_ID) {
    // Dedicated single-customer-org rule across pending | active | suspended allocations (AC-F1-01)
    const occupyingAllocations = existingAllocations.filter(
      (a) =>
        a.organizationId !== PLATFORM_OPS_ORG_ID &&
        (a.status === "pending" || a.status === "active" || a.status === "suspended"),
    );

    const conflictingAllocation = occupyingAllocations.find(
      (a) => a.organizationId !== requestOrganizationId,
    );

    if (conflictingAllocation) {
      return {
        admitted: false,
        errorCode: "DEDICATED_HOST_OCCUPIED",
        reason: `Dedicated host is already occupied by organization '${conflictingAllocation.organizationId}' (AC-F1-01)`,
      };
    }
  }

  return {
    admitted: true,
    errorCode: null,
    reason: "ADMITTED",
  };
}

export interface HostModeTransitionResult {
  readonly allowed: boolean;
  readonly errorCode: ErrorCode | null;
  readonly reason: string;
}

export function evaluateHostModeTransition(
  currentMode: HostingMode,
  targetMode: HostingMode,
  hostReviewStatus?: { securityReviewed: boolean; sharedApproved: boolean },
): HostModeTransitionResult {
  // AC-F1-06: Direct dedicated -> shared field change is strictly rejected with SHARED_MODE_GATED
  if (currentMode === "dedicated" && targetMode === "shared") {
    return {
      allowed: false,
      errorCode: "SHARED_MODE_GATED",
      reason:
        "Direct transition from dedicated to shared hosting mode is prohibited by security policy (AC-F1-06)",
    };
  }

  if (currentMode === targetMode) {
    return {
      allowed: true,
      errorCode: null,
      reason: "NOOP",
    };
  }

  if (targetMode === "shared") {
    if (!hostReviewStatus?.securityReviewed || !hostReviewStatus?.sharedApproved) {
      return {
        allowed: false,
        errorCode: "SHARED_MODE_GATED",
        reason: "Shared hosting mode requires completed security review and explicit approval",
      };
    }
  }

  return {
    allowed: true,
    errorCode: null,
    reason: "TRANSITION_ALLOWED",
  };
}
