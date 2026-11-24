import { APP_STACK_EXECUTOR_REASON_CODES, type AppStackExecutorReason } from "@hosting-panel/contracts";
import { ExecutorCodedError } from "../traefik-config.js";

export class AppStackExecutorError extends ExecutorCodedError {
  public readonly reason: AppStackExecutorReason;

  public constructor(reason: AppStackExecutorReason, message: string) {
    super(message, APP_STACK_EXECUTOR_REASON_CODES[reason]);
    this.name = "AppStackExecutorError";
    this.reason = reason;
  }
}

/**
 * Says of a refusal that its call changed nothing (#111). An engine failure is not a refusal: whether Docker did what
 * it was asked cannot be said from the error, so `DOCKER_ENGINE_UNAVAILABLE` is never marked.
 */
export function markRefusedBeforeChange(err: unknown): void {
  if (err instanceof ExecutorCodedError && err.code !== "DOCKER_ENGINE_UNAVAILABLE") err.beforeChange = true;
}
