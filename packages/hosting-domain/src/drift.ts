import type { DriftStatus, ServiceDesiredStatus } from "@hosting-panel/contracts";

export interface ObservedServiceState {
  readonly observedStatus: string;
  readonly observedRevisionHash?: string | null;
  readonly outOfBandModified?: boolean;
  readonly observedAt?: string | Date | null;
}

export interface DriftEvaluationResult {
  readonly driftStatus: DriftStatus;
  readonly stale: boolean;
  readonly requiresOperatorReview: boolean;
  readonly reason: string;
}

export interface EvaluateServiceDriftOptions {
  readonly stalenessThresholdMs?: number;
  readonly now?: Date;
}

const DEFAULT_STALENESS_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export function evaluateServiceDrift(
  desiredStatus: ServiceDesiredStatus,
  desiredSpecHash: string,
  observed: ObservedServiceState | null | undefined,
  options?: EvaluateServiceDriftOptions,
): DriftEvaluationResult {
  if (!observed || !observed.observedStatus || observed.observedStatus === "unknown") {
    return {
      driftStatus: "unknown",
      stale: true,
      requiresOperatorReview: false,
      reason: "NO_OBSERVED_STATE",
    };
  }

  const nowMs = (options?.now ?? new Date()).getTime();
  const threshold = options?.stalenessThresholdMs ?? DEFAULT_STALENESS_THRESHOLD_MS;

  let stale = true;
  if (observed.observedAt) {
    const observedMs =
      typeof observed.observedAt === "string"
        ? Date.parse(observed.observedAt)
        : observed.observedAt.getTime();
    if (!Number.isNaN(observedMs)) {
      stale = nowMs - observedMs > threshold;
    }
  }

  // Out of band modification requires operator review without destructive overwrite (§4.4)
  if (observed.outOfBandModified) {
    return {
      driftStatus: "drifted",
      stale,
      requiresOperatorReview: true,
      reason: "OUT_OF_BAND_MODIFIED",
    };
  }

  // Desired status vs observed status check
  if (desiredStatus !== observed.observedStatus) {
    return {
      driftStatus: "drifted",
      stale,
      requiresOperatorReview: false,
      reason: `STATUS_MISMATCH: desired ${desiredStatus}, observed ${observed.observedStatus}`,
    };
  }

  // Revision / Spec hash check
  if (observed.observedRevisionHash && observed.observedRevisionHash !== desiredSpecHash) {
    return {
      driftStatus: "drifted",
      stale,
      requiresOperatorReview: false,
      reason: `SPEC_HASH_MISMATCH: desired ${desiredSpecHash}, observed ${observed.observedRevisionHash}`,
    };
  }

  return {
    driftStatus: "in_sync",
    stale,
    requiresOperatorReview: false,
    reason: stale ? "IN_SYNC_STALE" : "IN_SYNC",
  };
}
