import type { ObservedServiceState } from "@hosting-panel/hosting-domain";
import type {
  DockerExecutionResult,
  DockerExecutorPort,
  ServiceLogLine,
  SiteRoutesRequest,
  SiteJobRequest,
  SiteJobResult,
} from "./port.js";
import type { CertificateStatusReport } from "./acme-status.js";
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

  async runSiteJob(_req: SiteJobRequest): Promise<SiteJobResult> {
    return this.refuse();
  }

  async purgeSite(_siteId: string): Promise<void> {
    return this.refuse();
  }

  async getServiceLogs(_serviceInstanceId: string, _tail: number): Promise<readonly ServiceLogLine[]> {
    return this.refuse();
  }

  async applySiteRoutes(_req: SiteRoutesRequest): Promise<void> {
    return this.refuse();
  }

  async getCertificateStatus(_req: { failuresSince: string }): Promise<CertificateStatusReport> {
    return this.refuse();
  }

  private refuse(): never {
    const error = new Error("Docker executor runtime is disabled in Phase 1 (HCP-SPEC-002 §1.3)");
    (error as unknown as { code: string }).code = "NOT_SUPPORTED";
    throw error;
  }

  async getObservedState(_serviceInstanceId: string): Promise<ObservedServiceState | null> {
    return null;
  }
}
