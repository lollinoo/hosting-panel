import { listAppStackComponents, type DatabaseExecutor } from "@hosting-panel/database";
import { isStackExecutor, type DockerExecutorPort, type ServiceLogLine } from "@hosting-panel/executor-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import type { LogReadGate } from "../sites/log-read-gate.js";
import type { ControlPlaneRuntimeConfig } from "../tokens.js";
import { APP_STACK_LOG_TAIL_DEFAULT, APP_STACK_LOG_TAIL_MAX } from "./app-stack-runtime-policy.js";

export interface AppStackLogsDeps {
  readonly db: DatabaseExecutor;
  readonly executor: DockerExecutorPort;
  readonly config: ControlPlaneRuntimeConfig;
  readonly gate: LogReadGate;
}

/** arch-api's AppStacksService.logs calls this after requireOrgPermission("app.read") and the feature gate. */
export async function readAppStackComponentLogs(
  deps: AppStackLogsDeps,
  input: { readonly organizationId: string; readonly stackId: string; readonly componentKey: string; readonly tail?: number },
): Promise<readonly ServiceLogLine[]> {
  const { organizationId, stackId, componentKey } = input;
  // Lists nothing for a foreign, missing or deleted stack: all three look the same.
  const components = await listAppStackComponents(deps.db, { organizationId, stackId });
  if (!components.some((c) => c.componentKey === componentKey)) {
    throw new ControlPlaneError("NOT_FOUND", "Requested organization or resource was not found.");
  }
  const { executor } = deps;
  if (!isStackExecutor(executor) || !executor.isRuntimeAvailable || deps.config.runtimeBackend === "disabled") {
    const message = "Applications are not available on this server.";
    throw new ControlPlaneError("NOT_SUPPORTED", message, { details: [{ message, reason: "STACK_UNSUPPORTED_FEATURE" }] });
  }
  const tail = Math.min(APP_STACK_LOG_TAIL_MAX, Math.max(1, Math.trunc(input.tail ?? APP_STACK_LOG_TAIL_DEFAULT)));
  return deps.gate.run(organizationId, () =>
    executor.getAppStackComponentLogs({ stackId, organizationId, componentKey, tail }).catch(() => {
      // What the executor said never reaches the caller (ADR 0026 2.3).
      throw new ControlPlaneError("DOCKER_ENGINE_UNAVAILABLE", "The logs are not available right now. Try again in a few minutes.");
    }),
  );
}
