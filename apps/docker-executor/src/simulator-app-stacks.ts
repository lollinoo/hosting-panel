import { createHash } from "node:crypto";
import {
  appStackImageLookupProblem,
  appStackLinkAlias,
  type AppImageAllowlistEntry,
  type AppStackComponentActionIpcResult,
  type AppStackComponentIpcRequest,
  type AppStackComponentObservation,
  type AppStackComponentsRemoveIpcRequest,
  type AppStackComponentsRemoveIpcResult,
  type AppStackCreateIpcRequest,
  type AppStackCreateIpcResult,
  type AppStackImageResolveIpcRequest,
  type AppStackImageResolveIpcResult,
  type AppStackLinksIpcRequest,
  type AppStackLinksIpcResult,
  type AppStackLogsIpcRequest,
  type AppStackNetworkRole,
  type AppStackPlanIpcRequest,
  type AppStackPrepareIpcResult,
  type AppStackPullIpcRequest,
  type AppStackPullIpcResult,
  type AppStackRefIpcRequest,
  type AppStackRemoveIpcRequest,
  type AppStackRemoveIpcResult,
  type AppStackRoutesIpcRequest,
  type AppStackRoutesIpcResult,
  type AppStackStatusIpcResult,
  type AppStackStopIpcResult,
  type ApprovedStackPlan,
} from "@hosting-panel/contracts";
import { computeAppStackComponentHash } from "@hosting-panel/hosting-domain";
import type { APP_STACK_EXECUTOR_METHODS, ServiceLogLine, StackExecutorPort } from "@hosting-panel/executor-contracts";
import {
  APP_STACK_LABELS,
  AppStackExecutorError,
  appStackContainerName,
  appStackEdgeNetworkName,
  appStackInternalNetworkName,
  appStackLogMaskValues,
  appStackNetworkLabels,
  appStackVolumeLabels,
  appStackVolumeName,
  assertAppStackCreateSecretContents,
  assertAppStackPayloadHardening,
  assertAppStackRoutesInPlan,
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
  | "pull" | "prepare" | "create" | "start" | "restart" | "stop" | "routes" | "unpublish" | "remove" | "remove_components" | "links"
  | "status" | "logs" | "resolve";
export type AppStackSimFault = "engine_unavailable" | "pull_failed" | "ambiguous_before" | "ambiguous_after";

export interface SimulatedAppStacksOptions {
  readonly secretsRootDir: string | null;
  readonly ingress: TraefikIngressFileManager | null;
  readonly allowlist?: readonly AppImageAllowlistEntry[];
  readonly assertEngineAvailable: () => void;
  readonly now?: () => Date;
  /** Told when the container of a component stops running or is removed, replaced or restarted (it ends its terminals). */
  readonly onComponentGone?: (stackId: string, componentKey: string) => void;
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
  /** The applications whose private network this container is attached to (ADR-0039); gone with the container. */
  links: Set<string>;
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
      | "container_restart" | "route_write" | "route_remove" | "volume_remove" | "network_remove" | "network_connect"
      | "network_disconnect";
    readonly name: string;
  }> = [];
  /** The references asked to resolveAppStackImage, in order (a lookup belongs to no stack, so it is not in appStackCalls). */
  public readonly appStackImageLookups: string[] = [];
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
    this.gone(stackId, componentKey);
  }

  /**
   * The running container of one component, for a terminal (ADR-0041): refused when the application is another
   * customer's, NOT_FOUND when the component is missing or not running. `user` is the Config.User of its payload.
   */
  public runningAppStackComponent(req: { readonly stackId: string; readonly organizationId: string; readonly componentKey: string }): {
    readonly name: string;
    readonly user: string | null;
  } {
    this.options.assertEngineAvailable();
    const container = this.own(req.stackId, req.organizationId)?.containers.get(req.componentKey);
    if (container === undefined) throw new ExecutorCodedError("Component not found", "NOT_FOUND");
    if (container.state !== "running") throw new ExecutorCodedError("The component is not running", "NOT_FOUND");
    return { name: container.name, user: container.payload.User ?? null };
  }

  public setAppStackComponentLogs(stackId: string, componentKey: string, lines: readonly ServiceLogLine[]): void {
    this.logs.set(appStackContainerName(stackId, componentKey), lines.map((line) => ({ ...line })));
  }

  /** The applications a stack's components are attached to through a link, ascending; [] when it has none. */
  public getAppStackLinkedApplications(stackId: string): string[] {
    const linked = new Set<string>();
    for (const c of this.stacks.get(stackId)?.containers.values() ?? []) for (const id of c.links) linked.add(id);
    return [...linked].sort();
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

  /** For the simulated tasks: is the component there and running, and which values its output must never show. */
  public async findAppStackComponent(req: {
    readonly stackId: string;
    readonly organizationId: string;
    readonly componentKey: string;
  }): Promise<{ readonly running: boolean; readonly secretValues: readonly string[] } | null> {
    const stack = this.own(req.stackId, req.organizationId);
    const container = stack?.containers.get(req.componentKey);
    if (stack === undefined || container === undefined) return null;
    const secretValues =
      this.options.secretsRootDir !== null
        ? await readAppStackComponentSecretValues(this.options.secretsRootDir, req.stackId, req.componentKey)
        : (stack.secrets.get(req.componentKey) ?? []);
    return { running: container.state === "running", secretValues };
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

  /** A registry that knows every well-formed reference: the digest is the SHA-256 of the reference text. */
  public async resolveAppStackImage(req: AppStackImageResolveIpcRequest): Promise<AppStackImageResolveIpcResult> {
    this.appStackImageLookups.push(req.image);
    this.options.assertEngineAvailable();
    const fault = this.faults.get("resolve")?.shift();
    if (fault === "engine_unavailable") {
      throw new ExecutorCodedError("Simulated Docker Engine is currently unreachable", "DOCKER_ENGINE_UNAVAILABLE");
    }
    if (fault === "ambiguous_before" || fault === "ambiguous_after") throw ambiguous();
    if (appStackImageLookupProblem(req.image) !== null) {
      throw new AppStackExecutorError("STACK_PLAN_INVALID", "The image reference is not valid");
    }
    if (fault === "pull_failed") {
      throw new AppStackExecutorError("STACK_IMAGE_PULL_FAILED", "Could not find the software of the application in its registry");
    }
    return { image: req.image, digest: `sha256:${createHash("sha256").update(req.image).digest("hex")}` };
  }

  public createAppStackComponents(req: AppStackCreateIpcRequest): Promise<AppStackCreateIpcResult> {
    return this.run("create", { method: "createAppStackComponents", stackId: req.plan.stackId }, true, async () => {
      const plan = this.checkPlan(req.plan);
      const secretContents = assertAppStackCreateSecretContents(plan, req.secretContents);
      const stack = this.own(plan.stackId, plan.organizationId);
      if (stack === undefined || !stack.networks.has("app_internal") || (plan.ingress.length > 0 && !stack.networks.has("app_edge"))) {
        throw notReady("The stack network is not prepared");
      }
      if (plan.volumes.some(({ key }) => !stack.volumes.has(key))) throw notReady("A stack volume is not prepared");
      if (plan.components.some((c) => !this.images.has(c.image))) {
        throw new AppStackExecutorError("STACK_IMAGE_MISSING", "The image is not available on this server");
      }
      // Like the engine: every body is built and checked before the first removal or create.
      const ctx = {
        secretsRootDir: this.secretsRoot,
        plan,
        secretContents,
        ...(this.options.allowlist ? { allowlist: this.options.allowlist } : {}),
      };
      const payloads = new Map<string, AppStackContainerCreatePayload>();
      for (const { key } of plan.components) {
        if (stack.containers.get(key)?.labels[APP_STACK_LABELS.componentHash] === computeAppStackComponentHash(plan, key)) continue;
        const payload = buildAppStackContainerCreatePayload(plan, key, ctx);
        assertAppStackPayloadHardening(payload, ctx);
        payloads.set(key, payload);
      }
      const keys = new Set(plan.components.map((c) => c.key));
      const removedComponents = [...stack.containers.keys()].filter((key) => !keys.has(key)).sort();
      for (const key of removedComponents) await this.removeComponent(stack, plan.stackId, key);
      const components = plan.components.map(({ key }) => {
        const existing = stack.containers.get(key);
        const payload = payloads.get(key);
        if (payload === undefined) return { componentKey: key, outcome: "unchanged" as const };
        if (existing !== undefined) {
          stack.containers.delete(key);
          this.mutate("container_remove", existing.name);
          this.gone(plan.stackId, key);
        }
        const name = appStackContainerName(plan.stackId, key);
        stack.containers.set(key, {
          name,
          labels: payload.Labels,
          payload,
          state: "created",
          startedAt: null,
          restartCount: 0,
          exitCode: null,
          links: new Set(),
        });
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
        this.gone(req.stackId, key);
        return { componentKey: key, outcome: "stopped" as const };
      });
      return { components };
    });
  }

  public publishAppStackRoutes(req: AppStackRoutesIpcRequest): Promise<AppStackRoutesIpcResult> {
    return this.run("routes", { method: "publishAppStackRoutes", stackId: req.plan.stackId }, true, async () => {
      const plan = this.checkPlan(req.plan);
      const receiving = assertAppStackRoutesInPlan(plan, req.routes);
      const stack = this.own(plan.stackId, plan.organizationId);
      if (req.routes.length > 0) {
        if (stack?.networks.has("app_edge") !== true) throw notReady("The stack network is not prepared");
        for (const componentKey of receiving) this.readyContainer(stack, plan, componentKey, true);
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
        this.gone(req.stackId, key);
        result.removedComponents.push(key);
      }
      stack.secrets.clear();
      for (const role of ["app_edge", "app_internal"] as const) {
        // The databases linked to this application are detached before its private network goes (ADR-0039).
        if (role === "app_internal" && stack.networks.has(role)) this.detachLinked(req.stackId);
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

  /** The engine's rules over the simulated objects: one component, the same customer, a private network that exists. */
  public syncAppStackLinks(req: AppStackLinksIpcRequest): Promise<AppStackLinksIpcResult> {
    const call = { method: "syncAppStackLinks" as const, stackId: req.stackId, componentKey: req.componentKey };
    return this.run("links", call, false, async () => {
      // It gives way to a change of the database that is running, and holds nothing a change waits for.
      if (this.busy.has(req.stackId)) throw new AppStackExecutorError("STACK_BUSY", "Another change of this application stack is running");
      const desired = [...new Set(req.consumerStackIds)];
      if (appStackLinkAlias(req.stackId) === null || desired.includes(req.stackId)) {
        throw new AppStackExecutorError("STACK_PLAN_INVALID", "This application cannot be linked");
      }
      const stack = this.own(req.stackId, req.organizationId);
      if (stack === undefined || stack.containers.size === 0) {
        return { container: false, links: desired.map((consumerStackId) => ({ consumerStackId, outcome: "pending" as const })), disconnected: [] };
      }
      const container = stack.containers.get(req.componentKey);
      if (container === undefined || stack.containers.size > 1) {
        throw new AppStackExecutorError("STACK_PLAN_INVALID", "Only an application with one component can be linked");
      }
      for (const consumer of desired) this.own(consumer, req.organizationId);
      const disconnected = [...container.links].filter((id) => !desired.includes(id)).sort();
      for (const id of disconnected) {
        container.links.delete(id);
        this.mutate("network_disconnect", appStackInternalNetworkName(id));
      }
      const links = desired.map((consumerStackId) => {
        const name = appStackInternalNetworkName(consumerStackId);
        const present = this.stacks.get(consumerStackId)?.networks.has("app_internal") === true;
        if (container.links.has(consumerStackId)) {
          if (present) return { consumerStackId, outcome: "already_connected" as const };
          container.links.delete(consumerStackId);
          this.mutate("network_disconnect", name);
        }
        if (!present || this.busy.has(consumerStackId)) return { consumerStackId, outcome: "pending" as const };
        container.links.add(consumerStackId);
        this.mutate("network_connect", name);
        return { consumerStackId, outcome: "connected" as const };
      });
      return { container: true, links, disconnected };
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
      const files = this.options.secretsRootDir !== null
        ? await readAppStackComponentSecretValues(this.options.secretsRootDir, req.stackId, req.componentKey)
        : (stack?.secrets.get(req.componentKey) ?? []);
      const values = appStackLogMaskValues(req.componentKey, { labels: container.labels, env: container.payload.Env }, files);
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
      await this.writeSecrets(stack!, plan.stackId, component.key, Object.keys(contents).length > 0 ? contents : null);
      if (container.state === "running") this.gone(plan.stackId, component.key); // a restart ends what ran in it
      container.state = "running";
      container.startedAt = this.now().toISOString();
      container.exitCode = null;
      this.mutate(step === "start" ? "container_start" : "container_restart", container.name);
      return { componentKey: component.key, outcome: step === "start" ? "started" : "restarted" };
    });
  }

  private gone(stackId: string, componentKey: string): void {
    this.options.onComponentGone?.(stackId, componentKey);
  }

  private detachLinked(consumerStackId: string): void {
    for (const other of this.stacks.values()) {
      for (const c of other.containers.values()) {
        if (c.links.delete(consumerStackId)) this.mutate("network_disconnect", appStackInternalNetworkName(consumerStackId));
      }
    }
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
    this.gone(stackId, key);
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
