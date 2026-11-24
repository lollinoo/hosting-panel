import { ApprovedStackPlanSchema } from "@hosting-panel/contracts";
import { getAppStack, getAppStackRevision, listAppStackComponents, type DatabaseExecutor } from "@hosting-panel/database";
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
  const component = (await listAppStackComponents(deps.db, { organizationId, stackId })).find((c) => c.componentKey === componentKey);
  if (!component) {
    throw new ControlPlaneError("NOT_FOUND", "Requested organization or resource was not found.");
  }
  const { executor } = deps;
  if (!isStackExecutor(executor) || !executor.isRuntimeAvailable || deps.config.runtimeBackend === "disabled") {
    const message = "Applications are not available on this server.";
    throw new ControlPlaneError("NOT_SUPPORTED", message, { details: [{ message, reason: "STACK_UNSUPPORTED_FEATURE" }] });
  }
  const tail = Math.min(APP_STACK_LOG_TAIL_MAX, Math.max(1, Math.trunc(input.tail ?? APP_STACK_LOG_TAIL_DEFAULT)));
  const unavailable = () => new ControlPlaneError("DOCKER_ENGINE_UNAVAILABLE", "The logs are not available right now. Try again in a few minutes.");
  // With no plan to count from, the executor could not tell a missing secret file from none: no read (BUG-43).
  const secretFileCount = await plannedSecretFileCount(deps.db, { organizationId, stackId }, component.appliedRevisionId, componentKey);
  if (secretFileCount === null) throw unavailable();
  return deps.gate.run(organizationId, () =>
    executor.getAppStackComponentLogs({ stackId, organizationId, componentKey, tail, secretFileCount }).catch(() => {
      // What the executor said never reaches the caller (ADR 0026 2.3).
      throw unavailable();
    }),
  );
}

/**
 * How many secret values the plan the component runs from gives it as files: the executor refuses the read when it
 * finds fewer, so a value a reboot took from the tmpfs is never printed unmasked (ADR-0041). The installed revision
 * first, the desired one for a component not installed yet. null: no plan that parses names the component.
 */
async function plannedSecretFileCount(
  db: DatabaseExecutor,
  scope: { readonly organizationId: string; readonly stackId: string },
  componentRevisionId: string | null,
  componentKey: string,
): Promise<number | null> {
  const stack = await getAppStack(db, scope);
  for (const revisionId of new Set([componentRevisionId, stack?.appliedRevisionId ?? null, stack?.desiredRevisionId ?? null])) {
    if (revisionId === null) continue;
    const parsed = ApprovedStackPlanSchema.safeParse((await getAppStackRevision(db, { ...scope, revisionId }))?.plan);
    // A stored plan that no longer parses is not skipped for an older one that might count fewer files.
    if (!parsed.success) return null;
    const planned = parsed.data.components.find((c) => c.key === componentKey);
    if (planned) return new Set(planned.secretFiles.map((file) => file.parameterKey)).size;
  }
  return null;
}
