import { setTimeout as sleep } from "node:timers/promises";
import {
  APP_STACK_HASH_PATTERN,
  APP_STACK_ID_PATTERN,
  APP_STACK_KEY_PATTERN,
  APP_STACK_LOG_TAIL_MAX,
  APP_STACK_NETWORK_ROLES,
  type AppImageAllowlistEntry,
  type AppStackComponentActionIpcResult,
  type AppStackComponentIpcRequest,
  type AppStackComponentObservation,
  type AppStackComponentsRemoveIpcRequest,
  type AppStackComponentsRemoveIpcResult,
  type AppStackCreateIpcResult,
  type AppStackExecutorReason,
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
import type { ServiceLogLine, StackExecutorPort } from "@hosting-panel/executor-contracts";
import { LOG_READ_MAX_BYTES } from "../docker-logs.js";
import { ExecutorCodedError, type AppStackRouteEntry } from "../traefik-config.js";
import {
  assertAppStackPayloadHardening,
  buildAppStackContainerCreatePayload,
  decodeAppStackHealthLabel,
  type AppStackContainerCreatePayload,
} from "./container-payload.js";
import { AppStackExecutorError } from "./errors.js";
import { probeAppStackHealth, type AppStackHealthProbe } from "./health-probe.js";
import {
  APP_STACK_COMPONENT_ROLE,
  APP_STACK_LABELS,
  appStackContainerName,
  appStackEdgeNetworkName,
  appStackInternalNetworkName,
  appStackNetworkLabels,
  appStackVolumeLabels,
  appStackVolumeName,
  isOwnAppStackResource,
} from "./names.js";
import { appStackImageDigestMatches, assertAppStackSecretContents, assertExecutableAppStackPlan } from "./plan-check.js";
import {
  maskAppStackLogLines,
  purgeAppStackComponentSecrets,
  purgeAppStackSecrets,
  readAppStackComponentSecretValues,
  writeAppStackComponentSecrets,
} from "./secrets.js";

export type AppStackDockerRequest = (
  method: "GET" | "POST" | "DELETE",
  endpointPath: string,
  body?: unknown,
  options?: { readonly timeoutMs?: number; readonly maxBodyBytes?: number },
) => Promise<{ readonly statusCode: number; readonly body: Buffer }>;

export interface AppStackRouteStore {
  write(stackId: string, routes: readonly AppStackRouteEntry[]): Promise<{ readonly changed: boolean; readonly hostnames: string[] }>;
  remove(stackId: string): Promise<boolean>;
  read(stackId: string): Promise<AppStackRouteEntry[]>;
}

export interface AppStackEngineDeps {
  readonly request: AppStackDockerRequest;
  readonly secretsRootDir: string;
  readonly pullMissingImages: boolean;
  readonly allowlist?: readonly AppImageAllowlistEntry[];
  readonly routes: AppStackRouteStore;
  readonly proxy: { readonly containerName: string; ensure(): Promise<void> };
  /** Not called: the stack path reads the raw stream to mask each line before it is cut (S5-M1). */
  readonly readLogs: (containerRef: string, tail: number) => Promise<ServiceLogLine[]>;
  readonly probe?: AppStackHealthProbe;
  readonly now?: () => Date;
}

export const APP_STACK_PULL_ENGINE_TIMEOUT_MS = 240_000;

const REMOVAL_POLL_MS = 100;
const REMOVAL_WAIT_MS = 5_000;
const STOPPED_STATES = new Set(["created", "exited", "dead"]);
const LOG_LINE_MAX_CHARS = 2_000;
const LOG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\S+) ?/;

type Labels = Readonly<Record<string, string>>;
type EngineResponse = Awaited<ReturnType<AppStackDockerRequest>>;
interface ContainerInspect {
  readonly Id: string;
  readonly Name?: string;
  readonly Config?: { readonly Labels?: Labels | null };
  readonly State?: {
    readonly Status?: string;
    readonly Running?: boolean;
    readonly Restarting?: boolean;
    readonly ExitCode?: number;
    readonly OOMKilled?: boolean;
    readonly StartedAt?: string;
  };
  readonly RestartCount?: number;
  readonly NetworkSettings?: { readonly Networks?: Readonly<Record<string, { readonly IPAddress?: string }>> };
}
interface NetworkView {
  readonly Name?: string;
  readonly Driver?: string;
  readonly Internal?: boolean;
  readonly Labels?: Labels | null;
  readonly Options?: Labels | null;
}
interface VolumeView {
  readonly Name?: string;
  readonly Driver?: string;
  readonly Labels?: Labels | null;
  readonly Options?: Labels | null;
}
interface OwnContainer {
  readonly id: string;
  readonly key: string;
  readonly labels: Labels;
  readonly state: string;
}
interface Ids {
  readonly stackId: string;
  readonly organizationId: string;
}

const enc = encodeURIComponent;

function refuse(reason: AppStackExecutorReason, message: string): never {
  throw new AppStackExecutorError(reason, message);
}

const conflict = () =>
  new AppStackExecutorError("STACK_NAMESPACE_CONFLICT", "An object on this server uses the name or label of this application stack");

const engineError = (verb: string, statusCode: number) =>
  new ExecutorCodedError(`Failed to ${verb} (HTTP ${String(statusCode)})`, "DOCKER_ENGINE_UNAVAILABLE");

const malformed = () => new ExecutorCodedError("The container engine answered with malformed data", "DOCKER_ENGINE_UNAVAILABLE");

function json<T>(res: EngineResponse): T {
  try {
    return JSON.parse(res.body.toString("utf8")) as T;
  } catch {
    throw malformed();
  }
}

interface LogEntry {
  readonly at: string | null;
  readonly stream: ServiceLogLine["stream"];
  readonly parts: Buffer[];
}

/** The byte length of the "<timestamp> " a line part starts with, and the timestamp; [0, null] without one. */
function logStamp(part: Buffer): [number, string | null] {
  const [prefix = "", stamp = ""] = LOG_TIMESTAMP.exec(part.toString("latin1", 0, 64)) ?? [];
  return stamp !== "" && !Number.isNaN(Date.parse(stamp)) ? [prefix.length, stamp] : [0, null];
}

/** demuxDockerLogStream (docker-logs.ts), but the frames Docker split a line into are joined as bytes (each part without
 *  its own timestamp) and the whole line is masked before its 2 000-character cut; when the read limit cut the stream,
 *  the lines still waiting for their end are dropped, so no piece of a value comes back (S5-M1). */
function maskedLogLines(body: Buffer, values: readonly string[]): ServiceLogLine[] {
  const entries: LogEntry[] = [];
  const open = new Map<ServiceLogLine["stream"], LogEntry>();
  for (let offset = 0; offset + 8 <= body.length; ) {
    const stream = body[offset] === 2 ? "stderr" : "stdout";
    const end = Math.min(body.length, offset + 8 + body.readUInt32BE(offset + 4));
    const payload = body.subarray(offset + 8, end);
    offset = end;
    for (let start = 0; start < payload.length; ) {
      const newline = payload.indexOf(10, start);
      const stop = newline === -1 ? payload.length : newline;
      const part = payload.subarray(start, stop);
      const [skip, at] = logStamp(part);
      let entry = open.get(stream);
      if (entry === undefined) entries.push((entry = { at, stream, parts: [] }));
      entry.parts.push(part.subarray(skip));
      if (newline === -1) open.set(stream, entry);
      else open.delete(stream);
      start = stop + 1;
    }
  }
  const cut = new Set(body.length >= LOG_READ_MAX_BYTES ? open.values() : []);
  const lines = entries.flatMap((entry): ServiceLogLine[] => {
    const text = Buffer.concat(entry.parts).toString("utf8").replace(/\r$/, "");
    return cut.has(entry) || (text === "" && entry.at === null) ? [] : [{ at: entry.at, stream: entry.stream, text }];
  });
  return maskAppStackLogLines(lines, values).map((line) => ({ ...line, text: line.text.slice(0, LOG_LINE_MAX_CHARS) }));
}

const networkName = (stackId: string, role: AppStackNetworkRole) =>
  role === "app_internal" ? appStackInternalNetworkName(stackId) : appStackEdgeNetworkName(stackId);

const rolesOf = (plan: ApprovedStackPlan): AppStackNetworkRole[] =>
  plan.ingress.length > 0 ? ["app_internal", "app_edge"] : ["app_internal"];

const labelFilter = (stackId: string) => enc(JSON.stringify({ label: [`${APP_STACK_LABELS.stackId}=${stackId}`] }));

/** The component key of an own container (Docker names carry a leading "/"), else null. */
function ownComponentKey(labels: Labels | null | undefined, name: string | undefined, ids: Ids): string | null {
  const key = labels?.[APP_STACK_LABELS.component];
  return isOwnAppStackResource(labels ?? undefined, ids.stackId, ids.organizationId) &&
    labels?.[APP_STACK_LABELS.role] === APP_STACK_COMPONENT_ROLE &&
    key !== undefined &&
    APP_STACK_KEY_PATTERN.test(key) &&
    name === `/${appStackContainerName(ids.stackId, key)}`
    ? key
    : null;
}

function isOwnNetwork(view: NetworkView, ids: Ids, role: AppStackNetworkRole): boolean {
  return (
    isOwnAppStackResource(view.Labels ?? undefined, ids.stackId, ids.organizationId) &&
    view.Labels?.[APP_STACK_LABELS.networkRole] === role &&
    view.Name === networkName(ids.stackId, role) &&
    view.Internal === (role === "app_internal") &&
    view.Driver === "bridge" &&
    !Object.hasOwn(view.Options ?? {}, "com.docker.network.bridge.name")
  );
}

function ownVolumeKey(view: VolumeView, ids: Ids): string | null {
  const key = view.Labels?.[APP_STACK_LABELS.volumeKey];
  return isOwnAppStackResource(view.Labels ?? undefined, ids.stackId, ids.organizationId) &&
    key !== undefined &&
    APP_STACK_KEY_PATTERN.test(key) &&
    view.Name === appStackVolumeName(ids.stackId, key) &&
    view.Driver === "local" &&
    Object.keys(view.Options ?? {}).length === 0
    ? key
    : null;
}

const byKey = (a: { readonly key: string }, b: { readonly key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** app_start_index descending (non-numeric = 0), ties by key descending. */
function reverseStartOrder(containers: readonly OwnContainer[]): OwnContainer[] {
  const index = (c: OwnContainer) => {
    const raw = c.labels[APP_STACK_LABELS.startIndex] ?? "";
    return /^[0-9]{1,3}$/.test(raw) ? Number(raw) : 0;
  };
  return [...containers].sort((a, b) => index(b) - index(a) || byKey(b, a));
}

export class AppStackEngine implements StackExecutorPort {
  private readonly deps: AppStackEngineDeps;
  private readonly busy = new Set<string>();

  public constructor(deps: AppStackEngineDeps) {
    this.deps = deps;
  }

  public pullAppStackImage(req: AppStackPullIpcRequest): Promise<AppStackPullIpcResult> {
    return this.locked(req.plan.stackId, async () => {
      const plan = this.check(req.plan);
      const { image } = req;
      if (!plan.components.some((c) => c.image === image)) refuse("STACK_PLAN_INVALID", "The image is not part of the plan");
      const inspectPath = `/images/${enc(image)}/json`;
      let found = await this.get<{ RepoDigests?: unknown[] }>(inspectPath, "inspect an application image");
      const pulled = found === null;
      if (found === null) {
        if (!this.deps.pullMissingImages) refuse("STACK_IMAGE_MISSING", "The image is not available on this server");
        const res = await this.deps.request("POST", `/images/create?fromImage=${enc(image)}`, undefined, {
          timeoutMs: APP_STACK_PULL_ENGINE_TIMEOUT_MS,
        });
        // The Engine answers 200 even when the pull fails; the error is a JSON line in the stream.
        const failed =
          res.statusCode !== 200 ||
          res.body
            .toString("utf8")
            .split("\n")
            .some((line) => line.startsWith("{") && /"error"\s*:/.test(line));
        found = failed ? null : await this.get<{ RepoDigests?: unknown[] }>(inspectPath, "inspect an application image").catch(() => null);
        if (found === null) refuse("STACK_IMAGE_PULL_FAILED", "Could not download the software of the application");
      }
      if (!appStackImageDigestMatches(image, found.RepoDigests)) {
        refuse("STACK_IMAGE_DIGEST_MISMATCH", "The downloaded software does not match its pinned fingerprint");
      }
      return { image, pulled };
    });
  }

  public prepareAppStack(req: AppStackPlanIpcRequest): Promise<AppStackPrepareIpcResult> {
    return this.locked(req.plan.stackId, async () => {
      const plan = this.check(req.plan);
      const networks: { role: AppStackNetworkRole; created: boolean }[] = [];
      for (const role of rolesOf(plan)) networks.push({ role, created: await this.ensureNetwork(plan, role) });
      const volumes: { volumeKey: string; created: boolean }[] = [];
      for (const { key } of plan.volumes) volumes.push({ volumeKey: key, created: await this.ensureVolume(plan, key) });
      return { networks, volumes };
    });
  }

  public createAppStackComponents(req: AppStackPlanIpcRequest): Promise<AppStackCreateIpcResult> {
    return this.locked(req.plan.stackId, async () => {
      const plan = this.check(req.plan);
      // The Engine refuses a CPU limit above its processor count only at create, after a replaced container is gone.
      const { NCPU } = await this.list<{ NCPU?: unknown }>("/info", "read the server information");
      if (typeof NCPU !== "number") throw malformed();
      if (plan.components.some((c) => c.resources.cpuMilli > NCPU * 1000)) {
        refuse("STACK_PLAN_INVALID", "The application needs more processors than this server has");
      }
      for (const role of rolesOf(plan)) {
        const view = await this.get<NetworkView>(`/networks/${enc(networkName(plan.stackId, role))}`, "inspect a stack network");
        if (view === null || !isOwnNetwork(view, plan, role)) refuse("STACK_COMPONENT_NOT_READY", "The stack network is not prepared");
      }
      for (const { key } of plan.volumes) {
        const view = await this.get<VolumeView>(`/volumes/${enc(appStackVolumeName(plan.stackId, key))}`, "inspect a stack volume");
        if (view === null || ownVolumeKey(view, plan) !== key) refuse("STACK_COMPONENT_NOT_READY", "A stack volume is not prepared");
      }
      for (const image of new Set(plan.components.map((c) => c.image))) {
        const found = await this.get<{ RepoDigests?: unknown[] }>(`/images/${enc(image)}/json`, "inspect an application image");
        if (found === null) refuse("STACK_IMAGE_MISSING", "The image is not available on this server");
        if (!appStackImageDigestMatches(image, found.RepoDigests)) {
          refuse("STACK_IMAGE_DIGEST_MISMATCH", "The downloaded software does not match its pinned fingerprint");
        }
      }
      const listed = await this.listContainers(plan);
      // Every body and every derived name is checked before the first removal or create.
      const ctx = { secretsRootDir: this.deps.secretsRootDir, plan };
      const bodies = new Map<string, AppStackContainerCreatePayload>();
      for (const { key } of plan.components) {
        const existing = listed.find((c) => c.key === key);
        if (existing?.labels[APP_STACK_LABELS.componentHash] === computeAppStackComponentHash(plan, key)) continue;
        const name = appStackContainerName(plan.stackId, key);
        if (existing === undefined && (await this.get(`/containers/${enc(name)}/json`, "inspect an application container")) !== null) {
          throw conflict();
        }
        const body = buildAppStackContainerCreatePayload(plan, key, ctx);
        assertAppStackPayloadHardening(body, ctx);
        bodies.set(key, body);
      }
      const keys = new Set(plan.components.map((c) => c.key));
      const removedComponents: string[] = [];
      for (const stale of listed.filter((c) => !keys.has(c.key)).sort(byKey)) {
        await this.removeContainer(stale.id);
        await purgeAppStackComponentSecrets(this.deps.secretsRootDir, plan.stackId, stale.key);
        removedComponents.push(stale.key);
      }
      const components: AppStackCreateIpcResult["components"] = [];
      for (const { key } of plan.components) {
        const body = bodies.get(key);
        if (body === undefined) {
          components.push({ componentKey: key, outcome: "unchanged" });
          continue;
        }
        const existing = listed.find((c) => c.key === key);
        if (existing !== undefined) await this.removeContainer(existing.id);
        await this.createContainer(key, appStackContainerName(plan.stackId, key), body);
        components.push({ componentKey: key, outcome: existing === undefined ? "created" : "replaced" });
      }
      return { components, removedComponents };
    });
  }

  public startAppStackComponent(req: AppStackComponentIpcRequest): Promise<AppStackComponentActionIpcResult> {
    return this.runComponent(req, "start");
  }

  public restartAppStackComponent(req: AppStackComponentIpcRequest): Promise<AppStackComponentActionIpcResult> {
    return this.runComponent(req, "restart");
  }

  public stopAppStack(req: AppStackRefIpcRequest): Promise<AppStackStopIpcResult> {
    return this.locked(req.stackId, async () => {
      const components: AppStackStopIpcResult["components"] = [];
      for (const c of reverseStartOrder(await this.listContainers(req))) {
        if (STOPPED_STATES.has(c.state)) {
          components.push({ componentKey: c.key, outcome: "already_stopped" });
          continue;
        }
        const res = await this.deps.request("POST", `/containers/${enc(c.id)}/stop?t=10`);
        if (res.statusCode === 404) continue;
        if (res.statusCode !== 204 && res.statusCode !== 304) throw engineError("stop an application container", res.statusCode);
        components.push({ componentKey: c.key, outcome: "stopped" });
      }
      return { components };
    });
  }

  public publishAppStackRoutes(req: AppStackRoutesIpcRequest): Promise<AppStackRoutesIpcResult> {
    return this.locked(req.plan.stackId, async () => {
      const plan = this.check(req.plan);
      for (const route of req.routes) {
        if (!plan.ingress.some((i) => i.componentKey === route.componentKey && i.port === route.internalPort)) {
          refuse("STACK_PLAN_INVALID", "The route is not an ingress of the plan");
        }
        if (route.hosts.some((host) => host.source !== undefined || host.redirectTo !== null)) {
          refuse("STACK_UNSUPPORTED_FEATURE", "Only automatic certificates and plain host routes are supported for applications");
        }
      }
      if (req.routes.length > 0) {
        const edge = appStackEdgeNetworkName(plan.stackId);
        const view = await this.get<NetworkView>(`/networks/${enc(edge)}`, "inspect a stack network");
        if (view === null || !isOwnNetwork(view, plan, "app_edge")) refuse("STACK_COMPONENT_NOT_READY", "The stack network is not prepared");
        for (const key of new Set(req.routes.map((route) => route.componentKey))) {
          const target = await this.get<ContainerInspect>(
            `/containers/${enc(appStackContainerName(plan.stackId, key))}/json`,
            "inspect an application container",
          );
          if (
            target === null ||
            ownComponentKey(target.Config?.Labels, target.Name, plan) !== key ||
            target.Config?.Labels?.[APP_STACK_LABELS.componentHash] !== computeAppStackComponentHash(plan, key) ||
            target.State?.Running !== true ||
            target.NetworkSettings?.Networks?.[edge] === undefined
          ) {
            refuse("STACK_COMPONENT_NOT_READY", `Component ${key} is not ready to receive traffic`);
          }
        }
        await this.deps.proxy.ensure();
        const res = await this.deps.request("POST", `/networks/${enc(edge)}/connect`, { Container: this.deps.proxy.containerName });
        const attached =
          res.statusCode === 200 ||
          res.statusCode === 204 ||
          ((res.statusCode === 403 || res.statusCode === 409) && res.body.toString("utf8").toLowerCase().includes("already exists"));
        if (!attached) throw engineError("attach the proxy to a stack network", res.statusCode);
      }
      const written = await this.deps.routes.write(plan.stackId, req.routes);
      return { routeCount: req.routes.length, hostnames: written.hostnames, changed: written.changed };
    });
  }

  public unpublishAppStackRoutes(req: AppStackRefIpcRequest): Promise<AppStackRoutesIpcResult> {
    return this.locked(req.stackId, async () => {
      await this.listAll(req);
      return { routeCount: 0, hostnames: [], changed: await this.deps.routes.remove(req.stackId) };
    });
  }

  public removeAppStack(req: AppStackRemoveIpcRequest): Promise<AppStackRemoveIpcResult> {
    return this.locked(req.stackId, async () => {
      const listed = await this.listAll(req);
      await this.deps.routes.remove(req.stackId);
      const removedComponents: string[] = [];
      for (const c of reverseStartOrder(listed.containers)) {
        await this.removeContainer(c.id);
        removedComponents.push(c.key);
      }
      await purgeAppStackSecrets(this.deps.secretsRootDir, req.stackId);
      const removedNetworks: AppStackNetworkRole[] = [];
      for (const role of ["app_edge", "app_internal"] as const) {
        if (!listed.networks.includes(role)) continue;
        const name = networkName(req.stackId, role);
        if (role === "app_edge") {
          await this.deps
            .request("POST", `/networks/${enc(name)}/disconnect`, { Container: this.deps.proxy.containerName, Force: true })
            .catch(() => undefined);
        }
        const res = await this.deps.request("DELETE", `/networks/${enc(name)}`);
        if (res.statusCode === 403 || res.statusCode === 409) {
          refuse("STACK_NAMESPACE_CONFLICT", "A stack network is still used by another container");
        }
        if (res.statusCode !== 204 && res.statusCode !== 404) throw engineError("remove a stack network", res.statusCode);
        removedNetworks.push(role);
      }
      const volumeKeys = [...listed.volumes].sort();
      if (!req.removeVolumes) return { removedComponents, removedNetworks, removedVolumes: [], retainedVolumes: volumeKeys };
      const removedVolumes: string[] = [];
      for (const key of volumeKeys) {
        const res = await this.deps.request("DELETE", `/volumes/${enc(appStackVolumeName(req.stackId, key))}`);
        if (res.statusCode === 409) refuse("STACK_VOLUME_IN_USE", "A stack volume is still in use");
        if (res.statusCode !== 204 && res.statusCode !== 404) throw engineError("remove a stack volume", res.statusCode);
        removedVolumes.push(key);
      }
      return { removedComponents, removedNetworks, removedVolumes, retainedVolumes: [] };
    });
  }

  public removeAppStackComponents(req: AppStackComponentsRemoveIpcRequest): Promise<AppStackComponentsRemoveIpcResult> {
    return this.locked(req.plan.stackId, async () => {
      const plan = this.check(req.plan);
      const listed = await this.listContainers(plan);
      const removedComponents: string[] = [];
      for (const key of [...req.componentKeys].sort()) {
        const found = listed.find((c) => c.key === key);
        if (found === undefined) continue;
        await this.removeContainer(found.id);
        await purgeAppStackComponentSecrets(this.deps.secretsRootDir, plan.stackId, key);
        removedComponents.push(key);
      }
      return { removedComponents };
    });
  }

  public async getAppStackStatus(req: AppStackRefIpcRequest): Promise<AppStackStatusIpcResult> {
    const listed = await this.listAll(req);
    const observed = await Promise.all(listed.containers.map((c) => this.observe(req.stackId, c)));
    const routes = await this.deps.routes.read(req.stackId);
    return {
      stackId: req.stackId,
      observedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      components: observed
        .filter((o): o is AppStackComponentObservation => o !== null)
        .sort((a, b) => byKey({ key: a.componentKey }, { key: b.componentKey })),
      networks: { internal: listed.networks.includes("app_internal"), edge: listed.networks.includes("app_edge") },
      volumes: [...listed.volumes].sort(),
      routes: {
        published: routes.length > 0,
        hostnames: [...new Set(routes.flatMap((route) => route.hosts.map((host) => host.hostname)))].sort(),
      },
    };
  }

  public async getAppStackComponentLogs(req: AppStackLogsIpcRequest): Promise<readonly ServiceLogLine[]> {
    const target = await this.get<ContainerInspect>(
      `/containers/${enc(appStackContainerName(req.stackId, req.componentKey))}/json`,
      "inspect an application container",
    );
    if (target === null) throw new ExecutorCodedError("Component not found", "NOT_FOUND");
    if (ownComponentKey(target.Config?.Labels, target.Name, req) !== req.componentKey) throw conflict();
    const tail = Math.min(APP_STACK_LOG_TAIL_MAX, Math.max(1, Math.trunc(req.tail) || 1));
    const res = await this.deps.request(
      "GET",
      `/containers/${enc(target.Id)}/logs?stdout=1&stderr=1&timestamps=1&tail=${String(tail)}`,
      undefined,
      { maxBodyBytes: LOG_READ_MAX_BYTES },
    );
    if (res.statusCode === 404) throw new ExecutorCodedError("Component not found", "NOT_FOUND");
    if (res.statusCode !== 200) throw engineError("read service logs", res.statusCode);
    return maskedLogLines(res.body, await readAppStackComponentSecretValues(this.deps.secretsRootDir, req.stackId, req.componentKey));
  }

  private async locked<T>(stackId: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(stackId)) refuse("STACK_BUSY", "Another change of this application stack is running");
    this.busy.add(stackId);
    try {
      return await fn();
    } finally {
      this.busy.delete(stackId);
    }
  }

  private check(plan: unknown): ApprovedStackPlan {
    return assertExecutableAppStackPlan(plan, this.deps.allowlist === undefined ? {} : { allowlist: this.deps.allowlist });
  }

  /** 200 -> body, 404 -> null, anything else -> engine error. */
  private async get<T>(endpointPath: string, verb: string): Promise<T | null> {
    const res = await this.deps.request("GET", endpointPath);
    if (res.statusCode === 404) return null;
    if (res.statusCode !== 200) throw engineError(verb, res.statusCode);
    return json<T>(res);
  }

  private async list<T>(endpointPath: string, verb: string): Promise<T> {
    const res = await this.deps.request("GET", endpointPath);
    if (res.statusCode !== 200) throw engineError(verb, res.statusCode);
    return json<T>(res);
  }

  /** Own containers by label; any labelled container that is not own refuses the call. */
  private async listContainers(ids: Ids): Promise<OwnContainer[]> {
    const summaries = await this.list<{ Id: string; Names?: string[]; Labels?: Labels | null; State?: string }[]>(
      `/containers/json?all=true&filters=${labelFilter(ids.stackId)}`,
      "list application containers",
    );
    return summaries.map((s) => {
      const key = ownComponentKey(s.Labels, s.Names?.[0], ids);
      if (key === null) throw conflict();
      return { id: s.Id, key, labels: s.Labels ?? {}, state: s.State ?? "" };
    });
  }

  private async listAll(ids: Ids) {
    const containers = await this.listContainers(ids);
    const networks = (await this.list<NetworkView[]>(`/networks?filters=${labelFilter(ids.stackId)}`, "list stack networks")).map(
      (view) => {
        const role = APP_STACK_NETWORK_ROLES.find((r) => r === view.Labels?.[APP_STACK_LABELS.networkRole]);
        if (role === undefined || !isOwnNetwork(view, ids, role)) throw conflict();
        return role;
      },
    );
    const volumes = (
      (await this.list<{ Volumes?: VolumeView[] | null }>(`/volumes?filters=${labelFilter(ids.stackId)}`, "list stack volumes"))
        .Volumes ?? []
    ).map((view) => {
      const key = ownVolumeKey(view, ids);
      if (key === null) throw conflict();
      return key;
    });
    return { containers, networks, volumes };
  }

  private async ensureNetwork(plan: ApprovedStackPlan, role: AppStackNetworkRole): Promise<boolean> {
    const name = networkName(plan.stackId, role);
    const present = async () => {
      const view = await this.get<NetworkView>(`/networks/${enc(name)}`, "inspect a stack network");
      if (view !== null && !isOwnNetwork(view, plan, role)) throw conflict();
      return view !== null;
    };
    if (await present()) return false;
    const res = await this.deps.request("POST", "/networks/create", {
      Name: name,
      Driver: "bridge",
      Internal: role === "app_internal",
      CheckDuplicate: true,
      Labels: appStackNetworkLabels(plan, role),
    });
    if (res.statusCode === 201) return true;
    if (res.statusCode === 409 && (await present())) return false;
    throw engineError("create a stack network", res.statusCode);
  }

  private async ensureVolume(plan: ApprovedStackPlan, key: string): Promise<boolean> {
    const name = appStackVolumeName(plan.stackId, key);
    const view = await this.get<VolumeView>(`/volumes/${enc(name)}`, "inspect a stack volume");
    if (view !== null) {
      if (ownVolumeKey(view, plan) !== key) throw conflict();
      return false;
    }
    const res = await this.deps.request("POST", "/volumes/create", { Name: name, Driver: "local", Labels: appStackVolumeLabels(plan, key) });
    if (res.statusCode === 200 || res.statusCode === 201) return true;
    throw engineError("create a stack volume", res.statusCode);
  }

  private async createContainer(key: string, name: string, body: AppStackContainerCreatePayload): Promise<void> {
    const res = await this.deps.request("POST", `/containers/create?name=${enc(name)}`, body);
    if (res.statusCode === 201) return;
    if (res.statusCode === 409) throw conflict();
    if (res.statusCode === 404) refuse("STACK_COMPONENT_NOT_READY", `Component ${key} needs an image or network that is missing`);
    throw engineError("create an application container", res.statusCode);
  }

  /** Stop (any status), then force-remove; v=true drops only anonymous volumes, named volumes stay. */
  private async removeContainer(id: string): Promise<void> {
    await this.deps.request("POST", `/containers/${enc(id)}/stop?t=10`).catch(() => undefined);
    const res = await this.deps.request("DELETE", `/containers/${enc(id)}?force=true&v=true`);
    if (res.statusCode === 409) {
      // With force=true Docker answers 409 only while another removal of this container runs; wait for it.
      for (let waited = 0; waited <= REMOVAL_WAIT_MS; waited += REMOVAL_POLL_MS) {
        if ((await this.get(`/containers/${enc(id)}/json`, "inspect an application container")) === null) return;
        await sleep(REMOVAL_POLL_MS);
      }
    }
    if (res.statusCode !== 204 && res.statusCode !== 404) throw engineError("remove an application container", res.statusCode);
  }

  private runComponent(req: AppStackComponentIpcRequest, action: "start" | "restart"): Promise<AppStackComponentActionIpcResult> {
    return this.locked(req.plan.stackId, async () => {
      const plan = this.check(req.plan);
      const component =
        plan.components.find((c) => c.key === req.componentKey) ?? refuse("STACK_PLAN_INVALID", "The component is not part of the plan");
      const { key } = component;
      const contents = assertAppStackSecretContents(plan, key, req.secretFileContents);
      for (const dependency of component.dependsOn) {
        const found = await this.get<ContainerInspect>(
          `/containers/${enc(appStackContainerName(plan.stackId, dependency))}/json`,
          "inspect an application container",
        );
        if (found === null || ownComponentKey(found.Config?.Labels, found.Name, plan) !== dependency || found.State?.Running !== true) {
          refuse("STACK_COMPONENT_NOT_READY", `Component ${dependency} is not running`);
        }
      }
      const target = await this.get<ContainerInspect>(
        `/containers/${enc(appStackContainerName(plan.stackId, key))}/json`,
        "inspect an application container",
      );
      if (target === null) refuse("STACK_COMPONENT_NOT_READY", `Component ${key} is not created`);
      if (ownComponentKey(target.Config?.Labels, target.Name, plan) !== key) throw conflict();
      if (target.Config?.Labels?.[APP_STACK_LABELS.componentHash] !== computeAppStackComponentHash(plan, key)) {
        refuse("STACK_COMPONENT_NOT_READY", `Component ${key} was created from another plan`);
      }
      if (action === "start" && target.State?.Running === true) return { componentKey: key, outcome: "already_running" };
      try {
        if (component.secretFiles.length > 0) await writeAppStackComponentSecrets(this.deps.secretsRootDir, plan.stackId, key, contents);
        else await purgeAppStackComponentSecrets(this.deps.secretsRootDir, plan.stackId, key);
      } catch {
        throw new ExecutorCodedError(`Could not prepare the secret files of component ${key}`, "DOCKER_ENGINE_UNAVAILABLE");
      }
      const res = await this.deps.request(
        "POST",
        action === "start" ? `/containers/${enc(target.Id)}/start` : `/containers/${enc(target.Id)}/restart?t=10`,
      );
      if (res.statusCode === 404) refuse("STACK_COMPONENT_NOT_READY", `Component ${key} is not created`);
      if (res.statusCode === 204 || (action === "start" && res.statusCode === 304)) {
        return { componentKey: key, outcome: action === "start" ? "started" : "restarted" };
      }
      throw engineError(`${action} an application container`, res.statusCode);
    });
  }

  private async observe(stackId: string, c: OwnContainer): Promise<AppStackComponentObservation | null> {
    const inspect = await this.get<ContainerInspect>(`/containers/${enc(c.id)}/json`, "inspect an application container");
    if (inspect === null) return null;
    const s = inspect.State ?? {};
    const labels = inspect.Config?.Labels ?? {};
    const state =
      s.Restarting === true ? "restarting" : s.Running === true ? "running" : s.Status === "created" ? "created" : s.Status === "dead" ? "dead" : "exited";
    let health: AppStackComponentObservation["health"] = state === "restarting" ? "unhealthy" : "stopped";
    let probe: AppStackComponentObservation["probe"] = "not_run";
    if (state === "running") {
      const decoded = decodeAppStackHealthLabel(labels[APP_STACK_LABELS.health]);
      const outcome =
        decoded === null
          ? "failed"
          : decoded.kind === "none"
            ? "none"
            : await (this.deps.probe ?? probeAppStackHealth)({
                address: inspect.NetworkSettings?.Networks?.[appStackInternalNetworkName(stackId)]?.IPAddress ?? "",
                componentKey: c.key,
                health: decoded,
              });
      health = outcome === "failed" ? "unhealthy" : "healthy";
      probe = outcome;
    }
    const hash = labels[APP_STACK_LABELS.componentHash];
    const revisionId = labels[APP_STACK_LABELS.revisionId];
    return {
      componentKey: c.key,
      state,
      health,
      probe,
      componentHash: hash !== undefined && APP_STACK_HASH_PATTERN.test(hash) ? hash : null,
      revisionId: revisionId !== undefined && APP_STACK_ID_PATTERN.test(revisionId) ? revisionId : null,
      startedAt: typeof s.StartedAt === "string" && !s.StartedAt.startsWith("0001-") ? s.StartedAt : null,
      restartCount: inspect.RestartCount ?? 0,
      exitCode: s.Running === true ? null : (s.ExitCode ?? null),
      oomKilled: s.OOMKilled === true,
    };
  }
}
