import type {
  AppStackComponentActionIpcResult, AppStackComponentIpcRequest, AppStackCreateIpcRequest, AppStackCreateIpcResult,
  AppStackImageResolveIpcRequest, AppStackImageResolveIpcResult, AppStackLogsIpcRequest,
  AppStackPlanIpcRequest, AppStackPrepareIpcResult, AppStackPullIpcRequest, AppStackPullIpcResult, AppStackRefIpcRequest,
  AppStackRemoveIpcRequest, AppStackRemoveIpcResult, AppStackComponentsRemoveIpcRequest, AppStackComponentsRemoveIpcResult,
  AppStackRoutesIpcRequest, AppStackRoutesIpcResult,
  AppStackStatusIpcResult, AppStackStopIpcResult,
} from "@hosting-panel/contracts";
import type { ServiceLogLine } from "./port.js";

/** Application stacks (ADR-0035). Optional beside DockerExecutorPort: feature-detect with isStackExecutor. Every
 *  method is one IPC call and idempotent; POSTs re-validate the plan; the three reads are GET (never ambiguous). */
export interface StackExecutorPort {
  /** One image of the plan, by digest; verifies RepoDigests. */
  pullAppStackImage(req: AppStackPullIpcRequest): Promise<AppStackPullIpcResult>;
  /** hp_appnet_<id> (+ hp_appedge_<id> when the plan has ingress) and every plan volume. */
  prepareAppStack(req: AppStackPlanIpcRequest): Promise<AppStackPrepareIpcResult>;
  /** Every component container, created and NOT started; changed hash = replaced; key not in the plan = removed.
   *  A version 2 plan with environment secrets needs their contents here (ADR-0036); nothing is removed without them. */
  createAppStackComponents(req: AppStackCreateIpcRequest): Promise<AppStackCreateIpcResult>;
  /** One component; its dependsOn containers must be running. Writes its secrets first. */
  startAppStackComponent(req: AppStackComponentIpcRequest): Promise<AppStackComponentActionIpcResult>;
  restartAppStackComponent(req: AppStackComponentIpcRequest): Promise<AppStackComponentActionIpcResult>;
  /** Every component, reverse start order. Secret files stay until remove. */
  stopAppStack(req: AppStackRefIpcRequest): Promise<AppStackStopIpcResult>;
  /** Full desired route set of the stack; [] removes the file. */
  publishAppStackRoutes(req: AppStackRoutesIpcRequest): Promise<AppStackRoutesIpcResult>;
  unpublishAppStackRoutes(req: AppStackRefIpcRequest): Promise<AppStackRoutesIpcResult>;
  /** Route file, containers, networks, secret files; volumes only with removeVolumes. */
  removeAppStack(req: AppStackRemoveIpcRequest): Promise<AppStackRemoveIpcResult>;
  /** Only the named containers (+ their secret dirs); volumes, networks and routes untouched (upgrade cleanup). */
  removeAppStackComponents(req: AppStackComponentsRemoveIpcRequest): Promise<AppStackComponentsRemoveIpcResult>;
  /** Read-only observation + bounded tcp/http probes. */
  getAppStackStatus(req: AppStackRefIpcRequest): Promise<AppStackStatusIpcResult>;
  /** Masked tail of one component. */
  getAppStackComponentLogs(req: AppStackLogsIpcRequest): Promise<readonly ServiceLogLine[]>;
  /** Read-only registry lookup of "[registry/]repository[:tag]" for the Compose importer; a GET, tied to no stack. */
  resolveAppStackImage(req: AppStackImageResolveIpcRequest): Promise<AppStackImageResolveIpcResult>;
}

export const APP_STACK_EXECUTOR_METHODS = [
  "pullAppStackImage", "prepareAppStack", "createAppStackComponents", "startAppStackComponent",
  "restartAppStackComponent", "stopAppStack", "publishAppStackRoutes", "unpublishAppStackRoutes", "removeAppStack",
  "removeAppStackComponents", "getAppStackStatus", "getAppStackComponentLogs", "resolveAppStackImage",
] as const satisfies readonly (keyof StackExecutorPort)[];

export function isStackExecutor(value: unknown): value is StackExecutorPort {
  return typeof value === "object" && value !== null &&
    APP_STACK_EXECUTOR_METHODS.every((m) => typeof (value as Record<string, unknown>)[m] === "function");
}
