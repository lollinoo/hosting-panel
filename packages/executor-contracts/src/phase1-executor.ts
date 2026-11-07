import type { ObservedServiceState } from "@hosting-panel/hosting-domain";
import type { DockerExecutionResult, DockerExecutorPort } from "./port.js";
import type { ApprovedServiceSpec } from "./spec.js";

export class Phase1DisabledDockerExecutor implements DockerExecutorPort {
  readonly isRuntimeAvailable = false;

  async deployService(_spec: ApprovedServiceSpec): Promise<DockerExecutionResult> {
    const error = new Error("Docker executor runtime is disabled in Phase 1 (HCP-SPEC-002 §1.3)");
    (error as unknown as { code: string }).code = "NOT_SUPPORTED";
    throw error;
  }

  async restartService(_serviceInstanceId: string): Promise<DockerExecutionResult> {
    const error = new Error("Docker executor runtime is disabled in Phase 1 (HCP-SPEC-002 §1.3)");
    (error as unknown as { code: string }).code = "NOT_SUPPORTED";
    throw error;
  }

  async stopService(_serviceInstanceId: string): Promise<DockerExecutionResult> {
    const error = new Error("Docker executor runtime is disabled in Phase 1 (HCP-SPEC-002 §1.3)");
    (error as unknown as { code: string }).code = "NOT_SUPPORTED";
    throw error;
  }

  async deleteService(_serviceInstanceId: string): Promise<DockerExecutionResult> {
    const error = new Error("Docker executor runtime is disabled in Phase 1 (HCP-SPEC-002 §1.3)");
    (error as unknown as { code: string }).code = "NOT_SUPPORTED";
    throw error;
  }

  async getObservedState(_serviceInstanceId: string): Promise<ObservedServiceState | null> {
    return null;
  }
}
