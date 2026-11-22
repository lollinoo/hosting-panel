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
