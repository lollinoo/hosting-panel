import type {
  AppStackTaskReadIpcRequest,
  AppStackTaskReadIpcResult,
  AppStackTaskRunIpcRequest,
  AppStackTaskRunIpcResult,
} from "@hosting-panel/contracts";

/**
 * Tasks of applications (ADR-0042). Optional beside StackExecutorPort: feature-detect with isStackTaskExecutor; without
 * it a run is refused before anything is sent.
 */
export interface StackTaskExecutorPort {
  /**
   * Runs the command in the existing container of one component and answers when it ended, or at its time limit. The
   * container is derived from the application and the component; the request never names one. A second call with the
   * id of a run this executor already saw never starts the command again.
   */
  runAppStackTask(req: AppStackTaskRunIpcRequest): Promise<AppStackTaskRunIpcResult>;
  /** How a run went, for a caller that lost the answer. A read: it starts nothing. */
  getAppStackTaskRun(req: AppStackTaskReadIpcRequest): Promise<AppStackTaskReadIpcResult>;
}

export const APP_STACK_TASK_EXECUTOR_METHODS = ["runAppStackTask", "getAppStackTaskRun"] as const satisfies
  readonly (keyof StackTaskExecutorPort)[];

export function isStackTaskExecutor(value: unknown): value is StackTaskExecutorPort {
  return (
    typeof value === "object" &&
    value !== null &&
    APP_STACK_TASK_EXECUTOR_METHODS.every((name) => typeof (value as Record<string, unknown>)[name] === "function")
  );
}
