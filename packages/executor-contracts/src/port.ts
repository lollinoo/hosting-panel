import type { OperationStatus, SiteHostRoute } from "@hosting-panel/contracts";
import type { ObservedServiceState } from "@hosting-panel/hosting-domain";
import type { CertificateStatusReport } from "./acme-status.js";
import type { ApprovedServiceSpec } from "./spec.js";

export interface DockerExecutionResult {
  readonly operationId: string;
  readonly status: OperationStatus;
  readonly message?: string;
  readonly internalDockerRef?: string;
  readonly containerStatus?: "running" | "stopped";
  readonly ingressConfigured?: boolean;
}

export interface DockerExecutorPort {
  readonly isRuntimeAvailable: boolean;
  deployService(spec: ApprovedServiceSpec): Promise<DockerExecutionResult>;
  restartService(serviceInstanceId: string): Promise<DockerExecutionResult>;
  stopService(serviceInstanceId: string): Promise<DockerExecutionResult>;
  deleteService(serviceInstanceId: string): Promise<DockerExecutionResult>;
  getObservedState(serviceInstanceId: string): Promise<ObservedServiceState | null>;
  runSiteJob(req: SiteJobRequest): Promise<SiteJobResult>;
  /** Removes a site's volumes, networks and routes; refuses while its containers exist. */
  purgeSite(siteId: string): Promise<void>;
  getServiceLogs(serviceInstanceId: string, tail: number): Promise<readonly ServiceLogLine[]>;
  /** Rewrites only the routing file; the service container is never touched. */
  applySiteRoutes(req: SiteRoutesRequest): Promise<void>;
  /** Read-only: hostnames, expiry and recent ACME failures. Never private keys. */
  getCertificateStatus(req: { failuresSince: string }): Promise<CertificateStatusReport>;
}

export interface SiteRoutesRequest {
  readonly siteId: string;
  readonly serviceInstanceId: string;
  readonly containerName: string;
  readonly internalPort: number;
  readonly hosts: readonly SiteHostRoute[];
}

export interface ServiceLogLine {
  at: string | null;
  stream: "stdout" | "stderr";
  text: string;
}

/** One-off, allowlisted setup jobs. The API picks only the kind; the executor owns image, script and mounts. */
export type SiteJobKind = "db.provision" | "db.drop" | "wordpress.install" | "wordpress.set-url";

export interface SiteJobRequest {
  readonly jobId: string;
  readonly kind: SiteJobKind;
  readonly siteId: string;
  readonly organizationId: string;
  readonly serviceInstanceId?: string;
  readonly params: Readonly<Record<string, string>>;
  readonly resolvedSecrets?: Readonly<Record<string, string>>;
}

export interface SiteJobResult {
  readonly jobId: string;
  readonly exitCode: number;
  /** Last 50 lines, at most 4 KiB, redacted. */
  readonly outputTail: string;
}
