import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  APP_STACK_ENV_NAME_PATTERN,
  APP_STACK_KEY_PATTERN,
  APP_STACK_PIDS_LIMIT,
  APP_STACK_PROCESS_MARK_PATTERN,
  APP_STACK_SECRET_ENV_LIMITS,
  APP_STACK_STANDARD_PIDS_LIMIT,
  APP_TEMPLATE_LIMITS,
  appStackComponentProfile,
  appStackComponentSecretEnvironment,
  appStackHealthPathProblem,
  appStackSecretFilePath,
  type AppStackHealthcheck,
  type AppStackPlanComponent,
  type ApprovedStackPlan,
} from "@hosting-panel/contracts";
import { ExecutorCodedError } from "../traefik-config.js";
import { AppStackExecutorError } from "./errors.js";
import {
  APP_STACK_COMPONENT_ROLE,
  APP_STACK_LABELS,
  appStackComponentLabels,
  appStackContainerName,
  appStackEdgeNetworkName,
  appStackInternalNetworkName,
  appStackSecretDirKey,
  appStackVolumeName,
} from "./names.js";

export const APP_STACK_TMPFS = Object.freeze({ "/tmp": "rw,noexec,nosuid,nodev,size=64m" });
/** The whole capability set of the "standard" run profile (ADR-0036): what an image that starts as root and then drops
 *  to its own user needs to take over its data directory and listen on a low port. A template never names a capability. */
export const APP_STACK_STANDARD_CAP_ADD: readonly string[] = Object.freeze([
  "CHOWN",
  "DAC_OVERRIDE",
  "FOWNER",
  "SETGID",
  "SETUID",
  "NET_BIND_SERVICE",
]);
export const APP_STACK_STOP_TIMEOUT_SECONDS = 10;
export const APP_STACK_RESTART_POLICY = Object.freeze({ Name: "unless-stopped" });
export const APP_STACK_LOG_CONFIG = Object.freeze({
  Type: "json-file",
  Config: Object.freeze({ "max-size": "10m", "max-file": "3" }),
});

export interface AppStackContainerCreatePayload {
  readonly Image: string;
  readonly User?: string;
  readonly Cmd?: readonly string[];
  readonly Env: readonly string[];
  readonly Labels: Readonly<Record<string, string>>;
  readonly ExposedPorts: Readonly<Record<string, Readonly<Record<string, never>>>>;
  readonly StopTimeout: number;
  readonly HostConfig: {
    readonly Privileged: boolean;
    readonly CapDrop: readonly string[];
    /** Only in the "standard" profile, and then exactly APP_STACK_STANDARD_CAP_ADD. */
    readonly CapAdd?: readonly string[];
    readonly SecurityOpt: readonly string[];
    readonly ReadonlyRootfs: boolean;
    /** Only in the "strict" profile (the root filesystem of "standard" is writable). */
    readonly Tmpfs?: Readonly<Record<string, string>>;
    readonly PidsLimit: number;
    readonly NanoCpus: number;
    readonly Memory: number;
    readonly MemorySwap: number;
    readonly RestartPolicy: { readonly Name: string };
    readonly NetworkMode: string;
    readonly Binds: readonly string[];
    readonly Mounts: readonly {
      readonly Type: string;
      readonly Source: string;
      readonly Target: string;
      readonly ReadOnly: boolean;
    }[];
    readonly LogConfig: { readonly Type: string; readonly Config: Readonly<Record<string, string>> };
  };
  readonly NetworkingConfig: {
    readonly EndpointsConfig: Readonly<Record<string, { readonly Aliases: readonly string[] }>>;
  };
}

/** The environment secrets of a version 2 component as "NAME=value" entries, in plan order; [] for a version 1 one.
 *  The values exist only in the returned strings: no message or log line of this function carries one. `stackId` names
 *  the application in the log line of a refused joined value. */
export function expandAppStackSecretEnvironment(
  component: AppStackPlanComponent,
  contents: Readonly<Record<string, string>>,
  stackId?: string,
): string[] {
  return appStackComponentSecretEnvironment(component).map((entry) => {
    const value = entry.pieces
      .map((piece) => {
        if ("literal" in piece) return piece.literal;
        const content = Object.hasOwn(contents, piece.parameterKey) ? contents[piece.parameterKey] : undefined;
        if (content === undefined) {
          throw new AppStackExecutorError("STACK_SECRET_MISSING", `A secret of component ${component.key} is missing`);
        }
        return content;
      })
      .join("");
    if (Buffer.byteLength(value, "utf8") > APP_STACK_SECRET_ENV_LIMITS.expandedBytes) {
      throw new AppStackExecutorError("STACK_PLAN_INVALID", `An environment value of component ${component.key} is too long`);
    }
    // Every piece passed the mark rule alone; joined they can still spell a mark the terminal's clean-up looks for (ADR-0041 §4).
    if (APP_STACK_PROCESS_MARK_PATTERN.test(value)) {
      // The API answers this refusal with a generic one: this line is what tells the operator which component it was.
      console.warn(
        JSON.stringify({
          component: "hp-docker-executor",
          event: "app_stack_env_mark_refused",
          stackId: stackId ?? null,
          componentKey: component.key,
          timestamp: new Date().toISOString(),
        }),
      );
      throw new AppStackExecutorError("STACK_PLAN_INVALID", `An environment value of component ${component.key} holds the mark of a platform process`);
    }
    return `${entry.name}=${value}`;
  });
}

/** The stack container create body (L16): no ports, no Entrypoint; the run profile decides the root filesystem, /tmp,
 *  the process limit and the fixed capability set ("strict": read-only, no CapAdd). `secretContents` (parameterKey ->
 *  value) is needed only by a component with environment secrets. */
export function buildAppStackContainerCreatePayload(
  plan: ApprovedStackPlan,
  componentKey: string,
  ctx: { readonly secretsRootDir: string; readonly secretContents?: Readonly<Record<string, string>> },
): AppStackContainerCreatePayload {
  const c = plan.components.find((component) => component.key === componentKey);
  if (c === undefined) throw new RangeError(`Unknown stack component: ${componentKey}`);
  const standard = appStackComponentProfile(c) === "standard";
  const root = path.resolve(ctx.secretsRootDir);
  const net = appStackInternalNetworkName(plan.stackId);
  const isEdge = plan.ingress.some((route) => route.componentKey === c.key);
  const keys = [...new Set(c.secretFiles.map((file) => file.parameterKey))].sort();
  return {
    Image: c.image,
    ...(c.runAsUser !== null ? { User: c.runAsUser } : {}),
    ...(c.argv !== null ? { Cmd: [...c.argv] } : {}),
    Env: [
      ...c.environment.map((entry) => `${entry.name}=${entry.value}`),
      ...c.secretFiles.map((file) => `${file.envName}=${appStackSecretFilePath(file.parameterKey)}`),
      ...expandAppStackSecretEnvironment(c, ctx.secretContents ?? {}, plan.stackId),
    ],
    Labels: appStackComponentLabels(plan, c.key),
    ExposedPorts: Object.fromEntries(c.expose.map((port) => [`${port}/tcp`, {}])),
    StopTimeout: APP_STACK_STOP_TIMEOUT_SECONDS,
    HostConfig: {
      Privileged: false,
      CapDrop: ["ALL"],
      ...(standard ? { CapAdd: [...APP_STACK_STANDARD_CAP_ADD] } : {}),
      SecurityOpt: ["no-new-privileges:true"],
      ReadonlyRootfs: !standard,
      ...(standard ? {} : { Tmpfs: { ...APP_STACK_TMPFS } }),
      PidsLimit: standard ? APP_STACK_STANDARD_PIDS_LIMIT : APP_STACK_PIDS_LIMIT,
      NanoCpus: c.resources.cpuMilli * 1_000_000,
      Memory: Number(c.resources.memoryBytes),
      MemorySwap: Number(c.resources.memoryBytes),
      RestartPolicy: { ...APP_STACK_RESTART_POLICY },
      NetworkMode: net,
      Binds: keys.map(
        (k) => `${path.join(root, appStackSecretDirKey(plan.stackId, c.key), k)}:${appStackSecretFilePath(k)}:ro`,
      ),
      Mounts: c.volumes.map((mount) => ({
        Type: "volume",
        Source: appStackVolumeName(plan.stackId, mount.volumeKey),
        Target: mount.containerPath,
        ReadOnly: mount.readOnly,
      })),
      LogConfig: { Type: APP_STACK_LOG_CONFIG.Type, Config: { ...APP_STACK_LOG_CONFIG.Config } },
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [net]: { Aliases: [c.key] },
        ...(isEdge ? { [appStackEdgeNetworkName(plan.stackId)]: { Aliases: [appStackContainerName(plan.stackId, c.key)] } } : {}),
      },
    },
  };
}

const SECRET_BIND_PATTERN = /:\/run\/secrets\/([a-z][a-z0-9_]{0,31}):ro$/;
const TOP_LEVEL_KEYS = new Set(["Image", "User", "Cmd", "Env", "Labels", "ExposedPorts", "StopTimeout", "HostConfig", "NetworkingConfig"]);
const HOST_CONFIG_KEYS = new Set([
  "Privileged",
  "CapDrop",
  "SecurityOpt",
  "ReadonlyRootfs",
  "Tmpfs",
  "PidsLimit",
  "NanoCpus",
  "Memory",
  "MemorySwap",
  "RestartPolicy",
  "NetworkMode",
  "Binds",
  "Mounts",
  "LogConfig",
]);
/** "standard": the fixed capability set instead of the /tmp tmpfs. */
const STANDARD_HOST_CONFIG_KEYS = new Set([...[...HOST_CONFIG_KEYS].filter((key) => key !== "Tmpfs"), "CapAdd"]);
const MOUNT_KEYS = new Set(["Type", "Source", "Target", "ReadOnly"]);

const onlyKeys = (value: object, allowed: ReadonlySet<string>) => Object.keys(value).every((key) => allowed.has(key));
const inRange = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;

/** Run on every body before POST /containers/create: refuses a body that lost any hardening property.
 *  With the plan, the User, the edge network, the run profile and the environment names must also be the plan
 *  component's; without it only the "strict" body passes. */
export function assertAppStackPayloadHardening(
  payload: AppStackContainerCreatePayload,
  ctx: { readonly secretsRootDir: string; readonly plan?: ApprovedStackPlan },
): void {
  const refuse = (rule: string): never => {
    throw new ExecutorCodedError(`The application container body breaks the ${rule} rule`, "HOST_POLICY_DENIED");
  };
  const host = payload.HostConfig;
  const stackId = payload.Labels[APP_STACK_LABELS.stackId] ?? "";
  const key = payload.Labels[APP_STACK_LABELS.component] ?? "";
  const secretDir = path.join(path.resolve(ctx.secretsRootDir), appStackSecretDirKey(stackId, key));
  const volumePrefix = `hp_appvol_${stackId}_`;
  const hostPath = (source: string) => source.includes("docker.sock") || source.includes("/var/run");

  if (!onlyKeys(payload, TOP_LEVEL_KEYS)) refuse("body keys");
  const label = APP_STACK_LABELS; // read here, not at load: names.ts imports this module back
  const labelKeys = new Set([
    label.managed,
    label.role,
    label.stackId,
    label.organizationId,
    label.component,
    label.componentHash,
    label.revisionId,
    label.startIndex,
    label.health,
    label.secretEnvironment,
  ]);
  if (!onlyKeys(payload.Labels, labelKeys) || payload.Labels[label.role] !== APP_STACK_COMPONENT_ROLE) refuse("Labels");
  const { plan } = ctx;
  const component = plan?.stackId === stackId ? plan.components.find((c) => c.key === key) : undefined;
  if (plan !== undefined && component === undefined) refuse("Labels");
  const standard = component !== undefined && appStackComponentProfile(component) === "standard";
  if (!onlyKeys(host, standard ? STANDARD_HOST_CONFIG_KEYS : HOST_CONFIG_KEYS)) refuse("HostConfig keys");
  if (component !== undefined && (payload.User ?? null) !== component.runAsUser) refuse("User");
  if (host.Privileged !== false) refuse("Privileged");
  if (!isDeepStrictEqual(host.CapDrop, ["ALL"])) refuse("CapDrop");
  if (!isDeepStrictEqual(host.SecurityOpt, ["no-new-privileges:true"])) refuse("SecurityOpt");
  if (standard) {
    // The closed "standard" profile: exactly its capability set, a writable root filesystem, its own process limit.
    if (!isDeepStrictEqual(host.CapAdd, [...APP_STACK_STANDARD_CAP_ADD])) refuse("CapAdd");
    if (host.ReadonlyRootfs !== false) refuse("ReadonlyRootfs");
    if (host.PidsLimit !== APP_STACK_STANDARD_PIDS_LIMIT) refuse("PidsLimit");
  } else {
    if (host.ReadonlyRootfs !== true) refuse("ReadonlyRootfs");
    if (!isDeepStrictEqual(host.Tmpfs, APP_STACK_TMPFS)) refuse("Tmpfs");
    if (host.PidsLimit !== APP_STACK_PIDS_LIMIT) refuse("PidsLimit");
  }
  // The body carries no plan: the limits must be ones a plan can hold (memory = swap, whole millicores).
  const { memoryBytesMin, memoryBytesMax, cpuMilliMin, cpuMilliMax } = APP_TEMPLATE_LIMITS;
  if (!inRange(host.Memory, memoryBytesMin, memoryBytesMax) || host.MemorySwap !== host.Memory) refuse("Memory");
  if (!inRange(host.NanoCpus / 1_000_000, cpuMilliMin, cpuMilliMax)) refuse("NanoCpus");
  if (host.NetworkMode !== appStackInternalNetworkName(stackId)) refuse("NetworkMode");
  // Only the stack's own networks, each with only its alias (no fixed address); the edge one for an ingress component.
  const edge = appStackEdgeNetworkName(stackId);
  const onEdge =
    plan === undefined ? Object.hasOwn(payload.NetworkingConfig.EndpointsConfig, edge) : plan.ingress.some((r) => r.componentKey === key);
  const endpoints = {
    [host.NetworkMode]: { Aliases: [key] },
    ...(onEdge ? { [edge]: { Aliases: [appStackContainerName(stackId, key)] } } : {}),
  };
  if (!isDeepStrictEqual(payload.NetworkingConfig, { EndpointsConfig: endpoints })) refuse("NetworkingConfig");
  for (const bind of host.Binds) {
    const k = SECRET_BIND_PATTERN.exec(bind)?.[1];
    if (k === undefined || bind !== `${path.join(secretDir, k)}:${appStackSecretFilePath(k)}:ro` || hostPath(bind)) refuse("Binds");
  }
  for (const mount of host.Mounts) {
    if (
      !onlyKeys(mount, MOUNT_KEYS) ||
      mount.Type !== "volume" ||
      !mount.Source.startsWith(volumePrefix) ||
      !APP_STACK_KEY_PATTERN.test(mount.Source.slice(volumePrefix.length)) ||
      hostPath(mount.Source)
    ) {
      refuse("Mounts");
    }
  }
  // With the plan: its plain entries exactly and in order, then one entry per environment secret under the plan's name.
  // The value of an environment secret is opaque here; the text around it is the plan's and is checked as such.
  const secretEntries = component === undefined ? [] : appStackComponentSecretEnvironment(component);
  const plainCount = payload.Env.length - secretEntries.length;
  if (component !== undefined) {
    const plain = [
      ...component.environment.map((entry) => `${entry.name}=${entry.value}`),
      ...component.secretFiles.map((file) => `${file.envName}=${appStackSecretFilePath(file.parameterKey)}`),
    ];
    if (
      !isDeepStrictEqual(payload.Env.slice(0, Math.max(0, plainCount)), plain) ||
      secretEntries.some((entry, index) => payload.Env[plain.length + index]?.startsWith(`${entry.name}=`) !== true)
    ) {
      refuse("Env");
    }
  }
  // The log reader masks by this label: exactly the plan component's, and none without the plan.
  const secretEnvLabel = component === undefined ? null : encodeAppStackSecretEnvLabel(component);
  if ((payload.Labels[label.secretEnvironment] ?? null) !== secretEnvLabel) refuse("Labels");
  // The plan schema's text rule for environment values and argv.
  const literals = secretEntries.flatMap((entry) => entry.pieces.flatMap((piece) => ("literal" in piece ? [piece.literal] : [])));
  if ([...payload.Env.slice(0, Math.max(0, plainCount)), ...literals, ...(payload.Cmd ?? [])].some((text) => /docker\.sock/i.test(text))) {
    refuse("host socket");
  }
}

export type AppStackHealthLabel =
  | { kind: "none" }
  | { kind: "tcp"; port: number; timeoutSeconds: number }
  | { kind: "http"; port: number; timeoutSeconds: number; path: string };

export function encodeAppStackHealthLabel(health: AppStackHealthcheck | null): string {
  if (health === null) return "none";
  return health.kind === "tcp"
    ? `tcp:${health.port}:${health.timeoutSeconds}`
    : `http:${health.port}:${health.timeoutSeconds}:${health.path}`;
}

/** One environment secret as its container label holds it: the name, then each piece (template text, null = a secret). */
export interface AppStackSecretEnvShape {
  readonly name: string;
  readonly pieces: readonly (string | null)[];
}

/** The label that lets the log reader find a component's environment secrets in its own Config.Env, which outlives the
 *  secret files: `[["NAME", "text", null, ...], ...]` in plan order. Names and template text only, never a value;
 *  null for a component without environment secrets (every version 1 one), whose labels stay as they were. */
export function encodeAppStackSecretEnvLabel(component: AppStackPlanComponent): string | null {
  const entries = appStackComponentSecretEnvironment(component);
  if (entries.length === 0) return null;
  return JSON.stringify(entries.map((entry) => [entry.name, ...entry.pieces.map((piece) => ("literal" in piece ? piece.literal : null))]));
}

/** null = malformed: not a list of a name and pieces with at least one secret and no two texts side by side. */
export function decodeAppStackSecretEnvLabel(value: string): AppStackSecretEnvShape[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const entries: AppStackSecretEnvShape[] = [];
  for (const item of parsed as unknown[]) {
    if (!Array.isArray(item)) return null;
    const [name, ...pieces] = item as unknown[];
    const valid = pieces.every(
      (piece, i) => piece === null || (typeof piece === "string" && piece !== "" && typeof pieces[i - 1] !== "string"),
    );
    if (typeof name !== "string" || !APP_STACK_ENV_NAME_PATTERN.test(name) || !valid || !pieces.includes(null)) return null;
    entries.push({ name, pieces: pieces as (string | null)[] });
  }
  return entries;
}

/** null = malformed. */
export function decodeAppStackHealthLabel(value: string | undefined): AppStackHealthLabel | null {
  if (value === "none") return { kind: "none" };
  const tcp = /^tcp:([0-9]{1,5}):([0-9]{1,2})$/.exec(value ?? "");
  const match = tcp ?? /^http:([0-9]{1,5}):([0-9]{1,2}):(\/[A-Za-z0-9._~/-]{0,255})$/.exec(value ?? "");
  if (match === null) return null;
  const port = Number(match[1]);
  const timeoutSeconds = Number(match[2]);
  if (port < 1 || port > 65_535) return null;
  if (timeoutSeconds < APP_TEMPLATE_LIMITS.healthTimeoutMin || timeoutSeconds > APP_TEMPLATE_LIMITS.healthTimeoutMax) return null;
  if (tcp !== null) return { kind: "tcp", port, timeoutSeconds };
  const healthPath = match[3] ?? "";
  return appStackHealthPathProblem(healthPath) === null ? { kind: "http", port, timeoutSeconds, path: healthPath } : null;
}
