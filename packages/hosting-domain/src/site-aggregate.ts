import type { DriftStatus, DriftSummary, ServiceDesiredStatus, SiteStatus } from "@hosting-panel/contracts";

export interface ServiceAggregateInput {
  readonly id: string;
  readonly desiredStatus: ServiceDesiredStatus;
  readonly driftStatus: DriftStatus;
  readonly operationalStatus?: "running" | "stopped" | "deploying" | "failed" | "degraded";
}

export interface SiteAggregateSummaryResult {
  readonly siteStatus: SiteStatus;
  readonly driftSummary: DriftSummary;
}

export function computeSiteAggregateSummary(
  services: readonly ServiceAggregateInput[],
): SiteAggregateSummaryResult {
  const totalServices = services.length;
  let inSyncCount = 0;
  let driftedCount = 0;
  let unknownCount = 0;

  let anyDeploying = false;
  let anyFailed = false;
  let allStopped = totalServices > 0;

  for (const svc of services) {
    if (svc.driftStatus === "in_sync") {
      inSyncCount++;
    } else if (svc.driftStatus === "drifted") {
      driftedCount++;
    } else {
      unknownCount++;
    }

    if (svc.operationalStatus === "deploying") {
      anyDeploying = true;
    }
    if (svc.operationalStatus === "failed" || svc.driftStatus === "drifted") {
      anyFailed = true;
    }
    if (svc.desiredStatus !== "stopped") {
      allStopped = false;
    }
  }

  let overallDriftStatus: DriftStatus = "in_sync";
  if (driftedCount > 0) {
    overallDriftStatus = "drifted";
  } else if (unknownCount > 0) {
    overallDriftStatus = "unknown";
  }

  let siteStatus: SiteStatus;
  if (totalServices === 0) {
    siteStatus = "ready";
  } else if (allStopped) {
    siteStatus = "stopped";
  } else if (anyDeploying) {
    siteStatus = "deploying";
  } else if (anyFailed) {
    siteStatus = "degraded";
  } else {
    siteStatus = "ready";
  }

  return {
    siteStatus,
    driftSummary: {
      totalServices,
      inSyncCount,
      driftedCount,
      unknownCount,
      overallDriftStatus,
    },
  };
}
