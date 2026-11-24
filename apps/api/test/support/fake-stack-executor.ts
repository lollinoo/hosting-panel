import { createHash } from "node:crypto";
import {
  APP_STACK_EXECUTOR_REASON_CODES,
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
  type AppStackPlanIpcRequest,
  type AppStackPrepareIpcResult,
  type AppStackPullIpcRequest,
  type AppStackPullIpcResult,
  type AppStackRefIpcRequest,
  type AppStackRemoveIpcRequest,
  type AppStackRemoveIpcResult,
  type AppStackRouteWire,
  type AppStackRoutesIpcRequest,
  type AppStackRoutesIpcResult,
  type AppStackStatusIpcResult,
  type AppStackStopIpcResult,
  type ErrorCode,
} from "@hosting-panel/contracts";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { DockerExecutorPort, ServiceLogLine, StackExecutorPort } from "@hosting-panel/executor-contracts";
import { computeAppStackComponentHash } from "@hosting-panel/hosting-domain";

// Scripted in-memory StackExecutorPort for unit tests; every DockerExecutorPort method is the simulator's.
// Components started without a fault are healthy at once; holdUnhealthy/setHealth script their probes.

export type FakeStackMethod = keyof StackExecutorPort;
export interface FakeStackCall {
  readonly method: FakeStackMethod;
  readonly componentKey?: string;
  readonly request: unknown;
}
interface FakeComponent {
  state: AppStackComponentObservation["state"];
  readonly componentHash: string;
  readonly revisionId: string;
  readonly healthcheck: boolean;
}
export interface FakeStackModel {
  readonly components: Map<string, FakeComponent>;
  networks: { internal: boolean; edge: boolean };
  readonly volumes: Set<string>;
  routes: AppStackRouteWire[];
}

const failure = (code: ErrorCode, reason: string | undefined, ambiguousOutcome: boolean): Error =>
  Object.assign(new Error("simulated executor failure"), {
    code,
    ambiguousOutcome,
    details: reason === undefined ? [] : [{ field: "stack", reason }],
  });
const definite = (reason?: string): Error =>
  failure(
    (APP_STACK_EXECUTOR_REASON_CODES as Readonly<Record<string, ErrorCode>>)[reason ?? ""] ?? "DOCKER_ENGINE_UNAVAILABLE",
    reason,
    false,
  );
const hostnamesOf = (routes: readonly AppStackRouteWire[]): string[] => routes.flatMap((r) => r.hosts.map((h) => h.hostname)).sort();

export class FakeStackExecutor implements StackExecutorPort {
  public readonly isRuntimeAvailable = true;
  public readonly simulator = new InMemoryDockerSimulatorAdapter();
  /** Every stack call in order, with its request as received. */
  public readonly calls: FakeStackCall[] = [];
  public readonly stacks = new Map<string, FakeStackModel>();
  /** Volume keys removeAppStack keeps (reported in retainedVolumes) even with removeVolumes. */
  public readonly volumesInUse = new Set<string>();
  /** Scripted answers of resolveAppStackImage (reference -> "sha256:<hex>"). */
  public readonly imageDigests = new Map<string, string>();
  readonly #faults: { method: FakeStackMethod; mode: "definite" | "ambiguous"; reason?: string }[] = [];
  readonly #health = new Map<string, "healthy" | "unhealthy">();
  readonly #unhealthyReads = new Map<string, number>();

  private constructor() {}

  /** A FakeStackExecutor that is also a full DockerExecutorPort (the simulator's methods, bound). */
  public static create(): FakeStackExecutor & DockerExecutorPort {
    const fake = new FakeStackExecutor();
    const sim = fake.simulator as unknown as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(InMemoryDockerSimulatorAdapter.prototype)) {
      const method = sim[name];
      if (name !== "constructor" && typeof method === "function" && !(name in fake)) {
        Object.assign(fake, { [name]: (method as (...args: unknown[]) => unknown).bind(sim) });
      }
    }
    return fake as FakeStackExecutor & DockerExecutorPort;
  }

  /** The next call of `method` throws: "definite" before any effect, "ambiguous" (OPERATION_AMBIGUOUS) after it. */
  public failNext(method: FakeStackMethod, mode: "definite" | "ambiguous", reason?: string): void {
    this.#faults.push({ method, mode, ...(reason === undefined ? {} : { reason }) });
  }

  /** A running component with a health check probes this way from now on. */
  public setHealth(componentKey: string, health: "healthy" | "unhealthy"): void {
    this.#health.set(componentKey, health);
  }

  /** A running component with a health check probes unhealthy for the next `reads` status reads (default: always). */
  public holdUnhealthy(componentKey: string, reads = Number.POSITIVE_INFINITY): void {
    this.#unhealthyReads.set(componentKey, reads);
  }

  public stack(stackId: string): FakeStackModel {
    let model = this.stacks.get(stackId);
    if (!model) {
      model = { components: new Map(), networks: { internal: false, edge: false }, volumes: new Set(), routes: [] };
      this.stacks.set(stackId, model);
    }
    return model;
  }

  async #call<T>(method: FakeStackMethod, request: unknown, effect: () => T, componentKey?: string): Promise<T> {
    this.calls.push({ method, request, ...(componentKey === undefined ? {} : { componentKey }) });
    const index = this.#faults.findIndex((f) => f.method === method);
    const fault = index < 0 ? undefined : this.#faults.splice(index, 1)[0];
    if (fault?.mode === "definite") throw definite(fault.reason);
    const result = effect();
    if (fault) throw failure("OPERATION_AMBIGUOUS", undefined, true);
    return result;
  }

  public pullAppStackImage(req: AppStackPullIpcRequest): Promise<AppStackPullIpcResult> {
    return this.#call("pullAppStackImage", req, () => ({ image: req.image, pulled: true }));
  }

  public prepareAppStack(req: AppStackPlanIpcRequest): Promise<AppStackPrepareIpcResult> {
    return this.#call("prepareAppStack", req, () => {
      const s = this.stack(req.plan.stackId);
      const edge = req.plan.ingress.length > 0;
      const networks: AppStackPrepareIpcResult["networks"] = [
        { role: "app_internal", created: !s.networks.internal },
        ...(edge ? [{ role: "app_edge" as const, created: !s.networks.edge }] : []),
      ];
      s.networks = { internal: true, edge: s.networks.edge || edge };
      const volumes = req.plan.volumes.map((v) => ({ volumeKey: v.key, created: !s.volumes.has(v.key) }));
      for (const v of req.plan.volumes) s.volumes.add(v.key);
      return { networks, volumes };
    });
  }

  /** A registry that knows every reference: `imageDigests` scripts an answer, otherwise the SHA-256 of the reference. */
  public resolveAppStackImage(req: AppStackImageResolveIpcRequest): Promise<AppStackImageResolveIpcResult> {
    return this.#call("resolveAppStackImage", req, () => ({
      image: req.image,
      digest: this.imageDigests.get(req.image) ?? `sha256:${createHash("sha256").update(req.image).digest("hex")}`,
    }));
  }

  public createAppStackComponents(req: AppStackCreateIpcRequest): Promise<AppStackCreateIpcResult> {
    return this.#call("createAppStackComponents", req, () => {
      const { plan } = req;
      const s = this.stack(plan.stackId);
      const components = plan.components.map((c) => {
        const componentHash = computeAppStackComponentHash(plan, c.key);
        const existing = s.components.get(c.key);
        if (existing?.componentHash === componentHash) return { componentKey: c.key, outcome: "unchanged" as const };
        s.components.set(c.key, { state: "created", componentHash, revisionId: plan.revisionId, healthcheck: c.healthcheck !== null });
        return { componentKey: c.key, outcome: existing ? ("replaced" as const) : ("created" as const) };
      });
      const removedComponents = [...s.components.keys()].filter((k) => !plan.components.some((c) => c.key === k)).sort();
      for (const key of removedComponents) s.components.delete(key);
      return { components, removedComponents };
    });
  }

  #start(req: AppStackComponentIpcRequest, restart: boolean): AppStackComponentActionIpcResult {
    const s = this.stack(req.plan.stackId);
    const component = s.components.get(req.componentKey);
    if (!component) throw failure("NOT_FOUND", undefined, false);
    const dependsOn = req.plan.components.find((c) => c.key === req.componentKey)?.dependsOn ?? [];
    if (dependsOn.some((d) => s.components.get(d)?.state !== "running")) throw definite("STACK_COMPONENT_NOT_READY");
    if (!restart && component.state === "running") return { componentKey: req.componentKey, outcome: "already_running" };
    component.state = "running";
    return { componentKey: req.componentKey, outcome: restart ? "restarted" : "started" };
  }

  public startAppStackComponent(req: AppStackComponentIpcRequest): Promise<AppStackComponentActionIpcResult> {
    return this.#call("startAppStackComponent", req, () => this.#start(req, false), req.componentKey);
  }

  public restartAppStackComponent(req: AppStackComponentIpcRequest): Promise<AppStackComponentActionIpcResult> {
    return this.#call("restartAppStackComponent", req, () => this.#start(req, true), req.componentKey);
  }

  public stopAppStack(req: AppStackRefIpcRequest): Promise<AppStackStopIpcResult> {
    return this.#call("stopAppStack", req, () => ({
      components: [...this.stack(req.stackId).components.entries()].reverse().map(([componentKey, c]) => {
        const running = c.state === "running" || c.state === "restarting";
        if (running) c.state = "exited";
        return { componentKey, outcome: running ? ("stopped" as const) : ("already_stopped" as const) };
      }),
    }));
  }

  #routes(stackId: string, routes: AppStackRouteWire[]): AppStackRoutesIpcResult {
    const s = this.stack(stackId);
    const changed = JSON.stringify(s.routes) !== JSON.stringify(routes);
    s.routes = routes;
    return { routeCount: routes.length, hostnames: hostnamesOf(routes), changed };
  }

  public publishAppStackRoutes(req: AppStackRoutesIpcRequest): Promise<AppStackRoutesIpcResult> {
    return this.#call("publishAppStackRoutes", req, () => this.#routes(req.plan.stackId, req.routes));
  }

  public unpublishAppStackRoutes(req: AppStackRefIpcRequest): Promise<AppStackRoutesIpcResult> {
    return this.#call("unpublishAppStackRoutes", req, () => this.#routes(req.stackId, []));
  }

  public removeAppStack(req: AppStackRemoveIpcRequest): Promise<AppStackRemoveIpcResult> {
    return this.#call("removeAppStack", req, () => {
      const s = this.stack(req.stackId);
      const removedComponents = [...s.components.keys()].sort();
      const removedNetworks: AppStackRemoveIpcResult["removedNetworks"] = [
        ...(s.networks.internal ? (["app_internal"] as const) : []),
        ...(s.networks.edge ? (["app_edge"] as const) : []),
      ];
      const volumes = [...s.volumes].sort();
      const removedVolumes = req.removeVolumes ? volumes.filter((v) => !this.volumesInUse.has(v)) : [];
      s.components.clear();
      s.networks = { internal: false, edge: false };
      s.routes = [];
      for (const v of removedVolumes) s.volumes.delete(v);
      return { removedComponents, removedNetworks, removedVolumes, retainedVolumes: volumes.filter((v) => !removedVolumes.includes(v)) };
    });
  }

  /** Applications each database is attached to (ADR-0039). */
  public readonly links = new Map<string, Set<string>>();

  public syncAppStackLinks(req: AppStackLinksIpcRequest): Promise<AppStackLinksIpcResult> {
    return this.#call(
      "syncAppStackLinks",
      req,
      () => {
        const attached = this.links.get(req.stackId) ?? new Set<string>();
        this.links.set(req.stackId, attached);
        if (!this.stack(req.stackId).components.has(req.componentKey)) {
          return { container: false, links: req.consumerStackIds.map((consumerStackId) => ({ consumerStackId, outcome: "pending" as const })), disconnected: [] };
        }
        const disconnected = [...attached].filter((id) => !req.consumerStackIds.includes(id)).sort();
        for (const id of disconnected) attached.delete(id);
        const links = req.consumerStackIds.map((consumerStackId) => {
          if (attached.has(consumerStackId)) return { consumerStackId, outcome: "already_connected" as const };
          if (!this.stack(consumerStackId).networks.internal) return { consumerStackId, outcome: "pending" as const };
          attached.add(consumerStackId);
          return { consumerStackId, outcome: "connected" as const };
        });
        return { container: true, links, disconnected };
      },
      req.componentKey,
    );
  }

  public removeAppStackComponents(req: AppStackComponentsRemoveIpcRequest): Promise<AppStackComponentsRemoveIpcResult> {
    return this.#call("removeAppStackComponents", req, () => {
      const s = this.stack(req.plan.stackId);
      return { removedComponents: req.componentKeys.filter((k) => s.components.delete(k)).sort() };
    });
  }

  #unhealthy(componentKey: string): boolean {
    const scripted = this.#health.get(componentKey);
    if (scripted !== undefined) return scripted === "unhealthy";
    const reads = this.#unhealthyReads.get(componentKey) ?? 0;
    if (reads <= 0) return false;
    this.#unhealthyReads.set(componentKey, reads - 1);
    return true;
  }

  public getAppStackStatus(req: AppStackRefIpcRequest): Promise<AppStackStatusIpcResult> {
    return this.#call("getAppStackStatus", req, () => {
      const s = this.stack(req.stackId);
      const components = [...s.components.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([componentKey, c]): AppStackComponentObservation => {
          const running = c.state === "running";
          const health = !running ? "stopped" : c.healthcheck && this.#unhealthy(componentKey) ? "unhealthy" : "healthy";
          return {
            componentKey,
            state: c.state,
            health,
            probe: !running ? "not_run" : !c.healthcheck ? "none" : health === "healthy" ? "passed" : "failed",
            componentHash: c.componentHash,
            revisionId: c.revisionId,
            startedAt: running ? new Date(0).toISOString() : null,
            restartCount: 0,
            exitCode: c.state === "exited" ? 0 : null,
            oomKilled: false,
          };
        });
      return {
        stackId: req.stackId,
        observedAt: new Date().toISOString(),
        components,
        networks: { ...s.networks },
        volumes: [...s.volumes].sort(),
        routes: { published: s.routes.length > 0, hostnames: hostnamesOf(s.routes) },
      };
    });
  }

  public getAppStackComponentLogs(req: AppStackLogsIpcRequest): Promise<readonly ServiceLogLine[]> {
    return this.#call("getAppStackComponentLogs", req, () => [], req.componentKey);
  }
}
