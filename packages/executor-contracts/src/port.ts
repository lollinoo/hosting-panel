import type { OperationStatus } from "@hosting-panel/contracts";
import type { ObservedServiceState } from "@hosting-panel/hosting-domain";
import type { ApprovedServiceSpec } from "./spec.js";

export interface DockerExecutionResult {
  readonly operationId: string;
  readonly status: OperationStatus;
  readonly message?: string;
}

export interface DockerExecutorPort {
  readonly isRuntimeAvailable: boolean;
  deployService(spec: ApprovedServiceSpec): Promise<DockerExecutionResult>;
  restartService(serviceInstanceId: string): Promise<DockerExecutionResult>;
  stopService(serviceInstanceId: string): Promise<DockerExecutionResult>;
  deleteService(serviceInstanceId: string): Promise<DockerExecutionResult>;
  getObservedState(serviceInstanceId: string): Promise<ObservedServiceState | null>;
}
