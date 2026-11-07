import type { ErrorCode } from "@hosting-panel/contracts";

export interface QuotaSnapshot {
  readonly maxSites: number;
  readonly maxServices: number;
  readonly maxCpuMilli: number;
  readonly maxMemoryBytes: string;
  readonly maxStorageBytes: string;
  readonly usedSites: number;
  readonly usedServices: number;
  readonly usedCpuMilli: number;
  readonly usedMemoryBytes: string;
  readonly usedStorageBytes: string;
}

export interface QuotaDemand {
  readonly sites?: number;
  readonly services?: number;
  readonly cpuMilli?: number;
  readonly memoryBytes?: string;
  readonly storageBytes?: string;
}

export interface ExistingQuotaReservation {
  readonly sites: number;
  readonly services: number;
  readonly cpuMilli: number;
  readonly memoryBytes: string;
  readonly storageBytes: string;
  readonly status: "pending" | "committed" | "released";
}

export interface QuotaAdmissionResult {
  readonly admitted: boolean;
  readonly errorCode: ErrorCode | null;
  readonly dimension?: "sites" | "services" | "cpuMilli" | "memoryBytes" | "storageBytes";
  readonly message: string;
}

export function evaluateQuotaAdmission(
  quota: QuotaSnapshot,
  demand: QuotaDemand,
  existingReservations: readonly ExistingQuotaReservation[] = [],
): QuotaAdmissionResult {
  let pendingSites = 0;
  let pendingServices = 0;
  let pendingCpuMilli = 0;
  let pendingMemoryBytes = 0n;
  let pendingStorageBytes = 0n;

  for (const res of existingReservations) {
    if (res.status === "pending") {
      pendingSites += res.sites;
      pendingServices += res.services;
      pendingCpuMilli += res.cpuMilli;
      pendingMemoryBytes += BigInt(res.memoryBytes);
      pendingStorageBytes += BigInt(res.storageBytes);
    }
  }

  const requestedSites = demand.sites ?? 0;
  const requestedServices = demand.services ?? 0;
  const requestedCpuMilli = demand.cpuMilli ?? 0;
  const requestedMemoryBytes = BigInt(demand.memoryBytes ?? "0");
  const requestedStorageBytes = BigInt(demand.storageBytes ?? "0");

  const totalSites = quota.usedSites + pendingSites + requestedSites;
  if (totalSites > quota.maxSites) {
    return {
      admitted: false,
      errorCode: "QUOTA_EXCEEDED",
      dimension: "sites",
      message: `Sites quota exceeded: requested ${requestedSites}, used ${quota.usedSites}, pending ${pendingSites}, max ${quota.maxSites}`,
    };
  }

  const totalServices = quota.usedServices + pendingServices + requestedServices;
  if (totalServices > quota.maxServices) {
    return {
      admitted: false,
      errorCode: "QUOTA_EXCEEDED",
      dimension: "services",
      message: `Services quota exceeded: requested ${requestedServices}, used ${quota.usedServices}, pending ${pendingServices}, max ${quota.maxServices}`,
    };
  }

  const totalCpuMilli = quota.usedCpuMilli + pendingCpuMilli + requestedCpuMilli;
  if (totalCpuMilli > quota.maxCpuMilli) {
    return {
      admitted: false,
      errorCode: "QUOTA_EXCEEDED",
      dimension: "cpuMilli",
      message: `CPU quota exceeded: requested ${requestedCpuMilli}m, used ${quota.usedCpuMilli}m, pending ${pendingCpuMilli}m, max ${quota.maxCpuMilli}m`,
    };
  }

  const totalMemoryBytes =
    BigInt(quota.usedMemoryBytes) + pendingMemoryBytes + requestedMemoryBytes;
  if (totalMemoryBytes > BigInt(quota.maxMemoryBytes)) {
    return {
      admitted: false,
      errorCode: "QUOTA_EXCEEDED",
      dimension: "memoryBytes",
      message: `Memory quota exceeded: requested ${requestedMemoryBytes}B, used ${quota.usedMemoryBytes}B, max ${quota.maxMemoryBytes}B`,
    };
  }

  const totalStorageBytes =
    BigInt(quota.usedStorageBytes) + pendingStorageBytes + requestedStorageBytes;
  if (totalStorageBytes > BigInt(quota.maxStorageBytes)) {
    return {
      admitted: false,
      errorCode: "QUOTA_EXCEEDED",
      dimension: "storageBytes",
      message: `Storage quota exceeded: requested ${requestedStorageBytes}B, used ${quota.usedStorageBytes}B, max ${quota.maxStorageBytes}B`,
    };
  }

  return {
    admitted: true,
    errorCode: null,
    message: "ADMITTED",
  };
}
