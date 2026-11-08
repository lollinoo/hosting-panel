import type { OperationStatus } from "@hosting-panel/contracts";
import type { ObservedServiceState } from "@hosting-panel/hosting-domain";
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
}

/** One-off, allowlisted setup jobs. The API picks only the kind; the executor owns image, script and mounts. */
export type SiteJobKind = "db.provision" | "db.drop" | "wordpress.install";

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
