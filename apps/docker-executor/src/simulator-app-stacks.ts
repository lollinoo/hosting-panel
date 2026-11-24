import type {
  AppImageAllowlistEntry,
  AppStackComponentActionIpcResult,
  AppStackComponentIpcRequest,
  AppStackComponentObservation,
  AppStackComponentsRemoveIpcRequest,
  AppStackComponentsRemoveIpcResult,
  AppStackCreateIpcResult,
  AppStackLogsIpcRequest,
  AppStackNetworkRole,
  AppStackPlanIpcRequest,
  AppStackPrepareIpcResult,
  AppStackPullIpcRequest,
  AppStackPullIpcResult,
  AppStackRefIpcRequest,
  AppStackRemoveIpcRequest,
  AppStackRemoveIpcResult,
  AppStackRoutesIpcRequest,
  AppStackRoutesIpcResult,
  AppStackStatusIpcResult,
  AppStackStopIpcResult,
  ApprovedStackPlan,
} from "@hosting-panel/contracts";
import { computeAppStackComponentHash } from "@hosting-panel/hosting-domain";
import type { APP_STACK_EXECUTOR_METHODS, ServiceLogLine, StackExecutorPort } from "@hosting-panel/executor-contracts";
import {
  APP_STACK_LABELS,
  AppStackExecutorError,
  appStackContainerName,
  appStackEdgeNetworkName,
  appStackInternalNetworkName,
  appStackNetworkLabels,
  appStackVolumeLabels,
  appStackVolumeName,
  assertAppStackPayloadHardening,
  assertAppStackSecretContents,
  assertExecutableAppStackPlan,
  buildAppStackContainerCreatePayload,
  decodeAppStackHealthLabel,
  maskAppStackLogLines,
  purgeAppStackComponentSecrets,
  purgeAppStackSecrets,
  readAppStackComponentSecretValues,
  writeAppStackComponentSecrets,
  type AppStackContainerCreatePayload,
} from "./app-stacks/index.js";
import { ExecutorIpcClientError } from "./client.js";
import {
  ExecutorCodedError,
  buildAppStackDynamicTraefikYaml,
  parsePersistedAppStackRoutesFromYaml,
  siteRouteOptions,
  type AppStackRouteEntry,
  type TraefikIngressFileManager,
} from "./traefik-config.js";

export type AppStackSimStep =
  | "pull" | "prepare" | "create" | "start" | "restart" | "stop" | "routes" | "unpublish" | "remove" | "remove_components" | "status" | "logs";
export type AppStackSimFault = "engine_unavailable" | "pull_failed" | "ambiguous_before" | "ambiguous_after";

export interface SimulatedAppStacksOptions {
  readonly secretsRootDir: string | null;
  readonly ingress: TraefikIngressFileManager | null;
  readonly allowlist?: readonly AppImageAllowlistEntry[];
  readonly assertEngineAvailable: () => void;
  readonly now?: () => Date;
  /** The simulated runner's holdAppStackLane (ADR-0038 K4); absent, no backup job ever holds a lane. */
  readonly holdBackupLane?: (stackId: string) => (() => void) | null;
}

type SimState = "created" | "running" | "exited" | "dead";
type MutationKind = SimulatedAppStacks["appStackMutations"][number]["kind"];

interface SimContainer {
  name: string;
  labels: Readonly<Record<string, string>>;
  payload: AppStackContainerCreatePayload;
  state: SimState;
  startedAt: string | null;
  restartCount: number;
  exitCode: number | null;
}

interface SimStack {
  organizationId: string;
  networks: Map<AppStackNetworkRole, Readonly<Record<string, string>>>;
  volumes: Map<string, Readonly<Record<string, string>>>;
  containers: Map<string, SimContainer>;
  secrets: Map<string, string[]>;
  routeYaml: string;
}

export interface AppStackSimSnapshot {
  readonly organizationId: string;
  readonly containers: Record<string, { name: string; labels: Record<string, string>; payload: AppStackContainerCreatePayload; state: SimState }>;
  readonly networks: Partial<Record<AppStackNetworkRole, { name: string; labels: Record<string, string> }>>;
  readonly volumes: Record<string, { name: string; labels: Record<string, string> }>;
  readonly routes: AppStackRouteEntry[];
}

const VIRTUAL_SECRETS_ROOT = "/run/hosting-panel/secrets";

const startIndex = (c: SimContainer) => Number(c.labels[APP_STACK_LABELS.startIndex]) || 0;
const byStartDesc = ([ka, a]: [string, SimContainer], [kb, b]: [string, SimContainer]) =>
  startIndex(b) - startIndex(a) || kb.localeCompare(ka);
const notReady = (message: string) => new AppStackExecutorError("STACK_COMPONENT_NOT_READY", message);
/** The steps the real engine refuses while a backup job holds the application's lane. */
const OUTSIDE_BACKUPS: ReadonlySet<AppStackSimStep> = new Set(["create", "start", "restart", "remove", "remove_components"]);

/** In-memory stack engine: the production plan check, names, labels and container builder over a simulated Engine. */
export class SimulatedAppStacks implements StackExecutorPort {
  public readonly appStackCalls: Array<{
    readonly method: (typeof APP_STACK_EXECUTOR_METHODS)[number];
    readonly stackId: string;
    readonly componentKey?: string;
  }> = [];
  public readonly appStackMutations: Array<{
    readonly kind:
      | "pull" | "network" | "volume" | "container_create" | "container_remove" | "container_start" | "container_stop"
      | "container_restart" | "route_write" | "route_remove" | "volume_remove" | "network_remove";
    readonly name: string;
  }> = [];
  private readonly images = new Set<string>();
  private readonly stacks = new Map<string, SimStack>();
  private readonly faults = new Map<AppStackSimStep, AppStackSimFault[]>();
  private readonly probes = new Map<string, "passed" | "failed">();
  private readonly logs = new Map<string, readonly ServiceLogLine[]>();
  private readonly busy = new Set<string>();
  private readonly secretsRoot: string;
  private readonly now: () => Date;

  public constructor(private readonly options: SimulatedAppStacksOptions) {
    this.secretsRoot = options.secretsRootDir ?? VIRTUAL_SECRETS_ROOT;
    this.now = options.now ?? (() => new Date());
  }

  public failNextAppStackStep(step: AppStackSimStep, fault: AppStackSimFault): void {
    this.faults.set(step, [...(this.faults.get(step) ?? []), fault]);
  }

  public setAppStackComponentProbe(stackId: string, componentKey: string, outcome: "passed" | "failed"): void {
    this.probes.set(appStackContainerName(stackId, componentKey), outcome);
  }

  public crashAppStackComponent(stackId: string, componentKey: string, exitCode = 1): void {
    const container = this.stacks.get(stackId)?.containers.get(componentKey);
    if (container === undefined) throw new Error(`No simulated component ${componentKey}`);
    container.state = "exited";
    container.exitCode = exitCode;
  }

  public setAppStackComponentLogs(stackId: string, componentKey: string, lines: readonly ServiceLogLine[]): void {
    this.logs.set(appStackContainerName(stackId, componentKey), lines.map((line) => ({ ...line })));
  }

  /** What a copy or a restore of this application's volumes would find (ADR-0038 K4). */
  public backupReadiness(
    stackId: string,
    organizationId: string,
    volumeKeys: readonly string[],
  ): "ready" | "running" | "volume_missing" | "foreign" {
    const stack = this.stacks.get(stackId);
    if (stack === undefined) return "volume_missing";
    if (stack.organizationId !== organizationId) return "foreign";
    if ([...stack.containers.values()].some((c) => c.state === "running")) return "running";
    return volumeKeys.every((key) => stack.volumes.has(key)) ? "ready" : "volume_missing";
  }

  public getAppStackSnapshot(stackId: string): AppStackSimSnapshot | null {
    const stack = this.stacks.get(stackId);
    if (stack === undefined) return null;
    return structuredClone({
      organizationId: stack.organizationId,
      containers: Object.fromEntries(
        [...stack.containers].map(([key, c]) => [key, { name: c.name, labels: c.labels, payload: c.payload, state: c.state }]),
      ),
      networks: Object.fromEntries(
        [...stack.networks].map(([role, labels]) => [role, { name: this.networkName(stackId, role), labels }]),
      ),
      volumes: Object.fromEntries(
        [...stack.volumes].map(([key, labels]) => [key, { name: appStackVolumeName(stackId, key), labels }]),
      ),
      routes: parsePersistedAppStackRoutesFromYaml(stack.routeYaml),
    }) as AppStackSimSnapshot;
  }

  public pullAppStackImage(req: AppStackPullIpcRequest): Promise<AppStackPullIpcResult> {
    return this.run("pull", { method: "pullAppStackImage", stackId: req.plan.stackId }, true, async (fault) => {
      const plan = this.checkPlan(req.plan);
      if (!plan.components.some((c) => c.image === req.image)) {
        throw new AppStackExecutorError("STACK_PLAN_INVALID", "The image is not part of the plan");
      }
      if (fault === "pull_failed") {
        throw new AppStackExecutorError("STACK_IMAGE_PULL_FAILED", "Could not download the software of the application");
      }
      if (this.images.has(req.image)) return { image: req.image, pulled: false };
      this.images.add(req.image);
      this.mutate("pull", req.image);
      return { image: req.image, pulled: true };
    });
  }

  public prepareAppStack(req: AppStackPlanIpcRequest): Promise<AppStackPrepareIpcResult> {
    return this.run("prepare", { method: "prepareAppStack", stackId: req.plan.stackId }, true, async () => {
      const plan = this.checkPlan(req.plan);
      const stack = this.own(plan.stackId, plan.organizationId) ?? this.newStack(plan);
      const roles: AppStackNetworkRole[] = plan.ingress.length > 0 ? ["app_internal", "app_edge"] : ["app_internal"];
      const networks = roles.map((role) => {
        const created = !stack.networks.has(role);
        if (created) {
          stack.networks.set(role, appStackNetworkLabels(plan, role));
          this.mutate("network", this.networkName(plan.stackId, role));
        }
        return { role, created };
      });
      const volumes = plan.volumes.map(({ key }) => {
        const created = !stack.volumes.has(key);
        if (created) {
          stack.volumes.set(key, appStackVolumeLabels(plan, key));
          this.mutate("volume", appStackVolumeName(plan.stackId, key));
        }
        return { volumeKey: key, created };
      });
      return { networks, volumes };
    });
  }

  public createAppStackComponents(req: AppStackPlanIpcRequest): Promise<AppStackCreateIpcResult> {
    return this.run("create", { method: "createAppStackComponents", stackId: req.plan.stackId }, true, async () => {
      const plan = this.checkPlan(req.plan);
      const stack = this.own(plan.stackId, plan.organizationId);
      if (stack === undefined || !stack.networks.has("app_internal") || (plan.ingress.length > 0 && !stack.networks.has("app_edge"))) {
        throw notReady("The stack network is not prepared");
      }
      if (plan.volumes.some(({ key }) => !stack.volumes.has(key))) throw notReady("A stack volume is not prepared");
      if (plan.components.some((c) => !this.images.has(c.image))) {
        throw new AppStackExecutorError("STACK_IMAGE_MISSING", "The image is not available on this server");
      }
      const keys = new Set(plan.components.map((c) => c.key));
      const removedComponents = [...stack.containers.keys()].filter((key) => !keys.has(key)).sort();
      for (const key of removedComponents) await this.removeComponent(stack, plan.stackId, key);
      const components = plan.components.map(({ key }) => {
        const existing = stack.containers.get(key);
        if (existing?.labels[APP_STACK_LABELS.componentHash] === computeAppStackComponentHash(plan, key)) {
          return { componentKey: key, outcome: "unchanged" as const };
        }
        if (existing !== undefined) {
          stack.containers.delete(key);
          this.mutate("container_remove", existing.name);
        }
        const payload = buildAppStackContainerCreatePayload(plan, key, { secretsRootDir: this.secretsRoot });
        assertAppStackPayloadHardening(payload, { secretsRootDir: this.secretsRoot });
        const name = appStackContainerName(plan.stackId, key);
        stack.containers.set(key, { name, labels: payload.Labels, payload, state: "created", startedAt: null, restartCount: 0, exitCode: null });
        this.mutate("container_create", name);
        return { componentKey: key, outcome: existing === undefined ? ("created" as const) : ("replaced" as const) };
      });
      return { components, removedComponents };
    });
  }

  public startAppStackComponent(req: AppStackComponentIpcRequest): Promise<AppStackComponentActionIpcResult> {
    return this.runComponent("start", "startAppStackComponent", req);
  }

  public restartAppStackComponent(req: AppStackComponentIpcRequest): Promise<AppStackComponentActionIpcResult> {
    return this.runComponent("restart", "restartAppStackComponent", req);
  }

  public stopAppStack(req: AppStackRefIpcRequest): Promise<AppStackStopIpcResult> {
    return this.run("stop", { method: "stopAppStack", stackId: req.stackId }, true, async () => {
      const stack = this.own(req.stackId, req.organizationId);
      const components = [...(stack?.containers ?? [])].sort(byStartDesc).map(([key, c]) => {
        if (c.state !== "running") return { componentKey: key, outcome: "already_stopped" as const };
        c.state = "exited";
        c.exitCode = 0;
        this.mutate("container_stop", c.name);
        return { componentKey: key, outcome: "stopped" as const };
      });
      return { components };
    });
  }

  public publishAppStackRoutes(req: AppStackRoutesIpcRequest): Promise<AppStackRoutesIpcResult> {
    return this.run("routes", { method: "publishAppStackRoutes", stackId: req.plan.stackId }, true, async () => {
      const plan = this.checkPlan(req.plan);
      for (const route of req.routes) {
        if (!plan.ingress.some((i) => i.componentKey === route.componentKey && i.port === route.internalPort)) {
          throw new AppStackExecutorError("STACK_PLAN_INVALID", "The route is not an ingress of the plan");
        }
        if (route.hosts.some((host) => host.source !== undefined || host.redirectTo !== null)) {
          throw new AppStackExecutorError(
            "STACK_UNSUPPORTED_FEATURE",
            "Only automatic certificates and plain host routes are supported for applications",
          );
        }
      }
      const stack = this.own(plan.stackId, plan.organizationId);
      if (req.routes.length > 0) {
        if (stack?.networks.has("app_edge") !== true) throw notReady("The stack network is not prepared");
        for (const { componentKey } of req.routes) this.readyContainer(stack, plan, componentKey, true);
      }
      const yaml = buildAppStackDynamicTraefikYaml(plan.stackId, req.routes, siteRouteOptions(null));
      const written = this.options.ingress
        ? await this.options.ingress.writeAppStackRoutes(plan.stackId, req.routes)
        : { changed: yaml !== (stack?.routeYaml ?? ""), hostnames: req.routes.flatMap((r) => r.hosts.map((h) => h.hostname)).sort() };
      if (stack !== undefined) stack.routeYaml = yaml;
      if (written.changed) this.mutate(yaml === "" ? "route_remove" : "route_write", `app_${plan.stackId}.yml`);
      return { routeCount: req.routes.length, hostnames: written.hostnames, changed: written.changed };
    });
  }

  public unpublishAppStackRoutes(req: AppStackRefIpcRequest): Promise<AppStackRoutesIpcResult> {
    return this.run("unpublish", { method: "unpublishAppStackRoutes", stackId: req.stackId }, true, async () => {
      const changed = await this.removeRoutes(req.stackId, this.own(req.stackId, req.organizationId));
      return { routeCount: 0, hostnames: [], changed };
    });
  }

  public removeAppStack(req: AppStackRemoveIpcRequest): Promise<AppStackRemoveIpcResult> {
    return this.run("remove", { method: "removeAppStack", stackId: req.stackId }, true, async () => {
      const stack = this.own(req.stackId, req.organizationId);
      await this.removeRoutes(req.stackId, stack);
      const result: AppStackRemoveIpcResult = { removedComponents: [], removedNetworks: [], removedVolumes: [], retainedVolumes: [] };
      if (this.options.secretsRootDir !== null) await purgeAppStackSecrets(this.options.secretsRootDir, req.stackId);
      if (stack === undefined) return result;
      for (const [key, c] of [...stack.containers].sort(byStartDesc)) {
        stack.containers.delete(key);
        this.mutate("container_remove", c.name);
        result.removedComponents.push(key);
      }
      stack.secrets.clear();
      for (const role of ["app_edge", "app_internal"] as const) {
        if (stack.networks.delete(role)) {
          this.mutate("network_remove", this.networkName(req.stackId, role));
          result.removedNetworks.push(role);
        }
      }
      for (const key of [...stack.volumes.keys()].sort()) {
        if (!req.removeVolumes) {
          result.retainedVolumes.push(key);
          continue;
        }
        stack.volumes.delete(key);
        this.mutate("volume_remove", appStackVolumeName(req.stackId, key));
        result.removedVolumes.push(key);
      }
      if (stack.volumes.size === 0) this.stacks.delete(req.stackId);
      return result;
    });
  }

  public removeAppStackComponents(req: AppStackComponentsRemoveIpcRequest): Promise<AppStackComponentsRemoveIpcResult> {
    return this.run("remove_components", { method: "removeAppStackComponents", stackId: req.plan.stackId }, true, async () => {
      const plan = this.checkPlan(req.plan);
      const stack = this.own(plan.stackId, plan.organizationId);
      const removedComponents = [...req.componentKeys].sort().filter((key) => stack?.containers.has(key) === true);
      for (const key of removedComponents) await this.removeComponent(stack!, plan.stackId, key);
      return { removedComponents };
    });
  }

  public getAppStackStatus(req: AppStackRefIpcRequest): Promise<AppStackStatusIpcResult> {
    return this.run("status", { method: "getAppStackStatus", stackId: req.stackId }, false, async () => {
      const stack = this.own(req.stackId, req.organizationId);
      const components = [...(stack?.containers ?? [])]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, c]) => this.observe(key, c));
      const routes = parsePersistedAppStackRoutesFromYaml(stack?.routeYaml ?? "");
      return {
        stackId: req.stackId,
        observedAt: this.now().toISOString(),
        components,
        networks: { internal: stack?.networks.has("app_internal") === true, edge: stack?.networks.has("app_edge") === true },
        volumes: [...(stack?.volumes.keys() ?? [])].sort(),
        routes: { published: routes.length > 0, hostnames: routes.flatMap((r) => r.hosts.map((h) => h.hostname)).sort() },
      };
    });
  }

  public getAppStackComponentLogs(req: AppStackLogsIpcRequest): Promise<readonly ServiceLogLine[]> {
    return this.run("logs", { method: "getAppStackComponentLogs", stackId: req.stackId, componentKey: req.componentKey }, false, async () => {
      const stack = this.own(req.stackId, req.organizationId);
      const container = stack?.containers.get(req.componentKey);
      if (container === undefined) throw new ExecutorCodedError("Component not found", "NOT_FOUND");
      const values = this.options.secretsRootDir !== null
        ? await readAppStackComponentSecretValues(this.options.secretsRootDir, req.stackId, req.componentKey)
        : (stack?.secrets.get(req.componentKey) ?? []);
      return maskAppStackLogLines((this.logs.get(container.name) ?? []).slice(-req.tail), values);
    });
  }

  private async run<T>(
    step: AppStackSimStep,
    call: SimulatedAppStacks["appStackCalls"][number],
    mutating: boolean,
    fn: (fault: AppStackSimFault | undefined) => Promise<T>,
  ): Promise<T> {
    this.appStackCalls.push(call);
    this.options.assertEngineAvailable();
    const fault = this.faults.get(step)?.shift();
    if (fault === "engine_unavailable") {
      throw new ExecutorCodedError("Simulated Docker Engine is currently unreachable", "DOCKER_ENGINE_UNAVAILABLE");
    }
    if (fault === "ambiguous_before") throw ambiguous();
    if (mutating && this.busy.has(call.stackId)) {
      throw new AppStackExecutorError("STACK_BUSY", "Another change of this application stack is running");
    }
    const hold = OUTSIDE_BACKUPS.has(step) ? this.options.holdBackupLane : undefined;
    const release = hold === undefined ? () => undefined : hold(call.stackId);
    if (release === null) throw new AppStackExecutorError("STACK_BUSY", "A backup or a restore of this application is running");
    if (mutating) this.busy.add(call.stackId);
    try {
      const result = await fn(fault);
      if (fault === "ambiguous_after") throw ambiguous();
      return result;
    } finally {
      if (mutating) this.busy.delete(call.stackId);
      release();
    }
  }

  private runComponent(
    step: "start" | "restart",
    method: "startAppStackComponent" | "restartAppStackComponent",
    req: AppStackComponentIpcRequest,
  ): Promise<AppStackComponentActionIpcResult> {
    return this.run(step, { method, stackId: req.plan.stackId, componentKey: req.componentKey }, true, async () => {
      const plan = this.checkPlan(req.plan);
      const component = plan.components.find((c) => c.key === req.componentKey);
      if (component === undefined) throw new AppStackExecutorError("STACK_PLAN_INVALID", "The component is not part of the plan");
      const contents = assertAppStackSecretContents(plan, component.key, req.secretFileContents);
      const stack = this.own(plan.stackId, plan.organizationId);
      for (const dependency of component.dependsOn) {
        if (stack?.containers.get(dependency)?.state !== "running") throw notReady(`Component ${dependency} is not running`);
      }
      const container = this.readyContainer(stack, plan, component.key, false);
      if (step === "start" && container.state === "running") return { componentKey: component.key, outcome: "already_running" };
      await this.writeSecrets(stack!, plan.stackId, component.key, component.secretFiles.length > 0 ? contents : null);
      container.state = "running";
      container.startedAt = this.now().toISOString();
      container.exitCode = null;
      this.mutate(step === "start" ? "container_start" : "container_restart", container.name);
      return { componentKey: component.key, outcome: step === "start" ? "started" : "restarted" };
    });
  }

  private checkPlan(plan: unknown): ApprovedStackPlan {
    return assertExecutableAppStackPlan(plan, this.options.allowlist ? { allowlist: this.options.allowlist } : {});
  }

  /** The stack's objects, refused when the same stack id is labelled with another organisation. */
  private own(stackId: string, organizationId: string): SimStack | undefined {
    const stack = this.stacks.get(stackId);
    if (stack !== undefined && stack.organizationId !== organizationId) {
      throw new AppStackExecutorError("STACK_NAMESPACE_CONFLICT", "The application stack belongs to another organization");
    }
    return stack;
  }

  private newStack(plan: ApprovedStackPlan): SimStack {
    const stack: SimStack = { organizationId: plan.organizationId, networks: new Map(), volumes: new Map(), containers: new Map(), secrets: new Map(), routeYaml: "" };
    this.stacks.set(plan.stackId, stack);
    return stack;
  }

  private readyContainer(stack: SimStack | undefined, plan: ApprovedStackPlan, key: string, running: boolean): SimContainer {
    const container = stack?.containers.get(key);
    if (container === undefined) throw notReady(`Component ${key} is not created`);
    if (container.labels[APP_STACK_LABELS.componentHash] !== computeAppStackComponentHash(plan, key)) {
      throw notReady(`Component ${key} was created from another plan`);
    }
    if (running && container.state !== "running") throw notReady(`Component ${key} is not running`);
    return container;
  }

  private observe(key: string, c: SimContainer): AppStackComponentObservation {
    const running = c.state === "running";
    const health = running ? decodeAppStackHealthLabel(c.labels[APP_STACK_LABELS.health]) : undefined;
    const probe = health === undefined ? "not_run" : health === null ? "failed" : health.kind === "none" ? "none" : (this.probes.get(c.name) ?? "passed");
    return {
      componentKey: key,
      state: c.state,
      health: !running ? "stopped" : probe === "failed" ? "unhealthy" : "healthy",
      probe,
      componentHash: c.labels[APP_STACK_LABELS.componentHash] ?? null,
      revisionId: c.labels[APP_STACK_LABELS.revisionId] ?? null,
      startedAt: c.startedAt,
      restartCount: c.restartCount,
      exitCode: running ? null : c.exitCode,
      oomKilled: false,
    };
  }

  private async writeSecrets(stack: SimStack, stackId: string, key: string, contents: Readonly<Record<string, string>> | null): Promise<void> {
    if (contents === null) stack.secrets.delete(key);
    else stack.secrets.set(key, Object.values(contents));
    const root = this.options.secretsRootDir;
    if (root === null) return;
    try {
      await (contents === null ? purgeAppStackComponentSecrets(root, stackId, key) : writeAppStackComponentSecrets(root, stackId, key, contents));
    } catch {
      throw new ExecutorCodedError(`Could not prepare the secret files of component ${key}`, "DOCKER_ENGINE_UNAVAILABLE");
    }
  }

  private async removeComponent(stack: SimStack, stackId: string, key: string): Promise<void> {
    const container = stack.containers.get(key);
    if (container === undefined) return;
    stack.containers.delete(key);
    this.mutate("container_remove", container.name);
    stack.secrets.delete(key);
    if (this.options.secretsRootDir !== null) await purgeAppStackComponentSecrets(this.options.secretsRootDir, stackId, key);
  }

  private async removeRoutes(stackId: string, stack: SimStack | undefined): Promise<boolean> {
    const changed = this.options.ingress
      ? await this.options.ingress.removeAppStackRoutes(stackId)
      : (stack?.routeYaml ?? "") !== "";
    if (stack !== undefined) stack.routeYaml = "";
    if (changed) this.mutate("route_remove", `app_${stackId}.yml`);
    return changed;
  }

  private networkName(stackId: string, role: AppStackNetworkRole): string {
    return role === "app_edge" ? appStackEdgeNetworkName(stackId) : appStackInternalNetworkName(stackId);
  }

  private mutate(kind: MutationKind, name: string): void {
    this.appStackMutations.push({ kind, name });
  }
}

function ambiguous(): ExecutorIpcClientError {
  return new ExecutorIpcClientError(
    "IPC response stream dropped after mutating command was dispatched to docker-executor",
    "OPERATION_AMBIGUOUS",
    502,
    true,
  );
}
