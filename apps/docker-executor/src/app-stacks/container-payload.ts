import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  APP_STACK_KEY_PATTERN,
  APP_STACK_PIDS_LIMIT,
  APP_TEMPLATE_LIMITS,
  appStackHealthPathProblem,
  appStackSecretFilePath,
  type AppStackHealthcheck,
  type ApprovedStackPlan,
} from "@hosting-panel/contracts";
import { ExecutorCodedError } from "../traefik-config.js";
import {
  APP_STACK_LABELS,
  appStackComponentLabels,
  appStackContainerName,
  appStackEdgeNetworkName,
  appStackInternalNetworkName,
  appStackSecretDirKey,
  appStackVolumeName,
} from "./names.js";

export const APP_STACK_TMPFS = Object.freeze({ "/tmp": "rw,noexec,nosuid,nodev,size=64m" });
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
    readonly SecurityOpt: readonly string[];
    readonly ReadonlyRootfs: boolean;
    readonly Tmpfs: Readonly<Record<string, string>>;
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

/** The stack container create body (L16): no CapAdd, no ports, no Entrypoint, read-only root filesystem. */
export function buildAppStackContainerCreatePayload(
  plan: ApprovedStackPlan,
  componentKey: string,
  ctx: { readonly secretsRootDir: string },
): AppStackContainerCreatePayload {
  const c = plan.components.find((component) => component.key === componentKey);
  if (c === undefined) throw new RangeError(`Unknown stack component: ${componentKey}`);
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
    ],
    Labels: appStackComponentLabels(plan, c.key),
    ExposedPorts: Object.fromEntries(c.expose.map((port) => [`${port}/tcp`, {}])),
    StopTimeout: APP_STACK_STOP_TIMEOUT_SECONDS,
    HostConfig: {
      Privileged: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      ReadonlyRootfs: true,
      Tmpfs: { ...APP_STACK_TMPFS },
      PidsLimit: APP_STACK_PIDS_LIMIT,
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
const MOUNT_KEYS = new Set(["Type", "Source", "Target", "ReadOnly"]);

const onlyKeys = (value: object, allowed: ReadonlySet<string>) => Object.keys(value).every((key) => allowed.has(key));
const inRange = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;

/** Run on every body before POST /containers/create: refuses a body that lost any hardening property. */
export function assertAppStackPayloadHardening(
  payload: AppStackContainerCreatePayload,
  ctx: { readonly secretsRootDir: string },
): void {
  const refuse = (rule: string): never => {
    throw new ExecutorCodedError(`The application container body breaks the ${rule} rule`, "HOST_POLICY_DENIED");
  };
  const host = payload.HostConfig;
  const stackId = payload.Labels[APP_STACK_LABELS.stackId] ?? "";
  const secretDir = path.join(
    path.resolve(ctx.secretsRootDir),
    appStackSecretDirKey(stackId, payload.Labels[APP_STACK_LABELS.component] ?? ""),
  );
  const volumePrefix = `hp_appvol_${stackId}_`;
  const hostPath = (source: string) => source.includes("docker.sock") || source.includes("/var/run");

  if (!onlyKeys(payload, TOP_LEVEL_KEYS)) refuse("body keys");
  if (!onlyKeys(host, HOST_CONFIG_KEYS)) refuse("HostConfig keys");
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
  ]);
  if (!onlyKeys(payload.Labels, labelKeys)) refuse("Labels");
  if (host.Privileged !== false) refuse("Privileged");
  if (!isDeepStrictEqual(host.CapDrop, ["ALL"])) refuse("CapDrop");
  if (!isDeepStrictEqual(host.SecurityOpt, ["no-new-privileges:true"])) refuse("SecurityOpt");
  if (host.ReadonlyRootfs !== true) refuse("ReadonlyRootfs");
  if (!isDeepStrictEqual(host.Tmpfs, APP_STACK_TMPFS)) refuse("Tmpfs");
  if (host.PidsLimit !== APP_STACK_PIDS_LIMIT) refuse("PidsLimit");
  // The body carries no plan: the limits must be ones a plan can hold (memory = swap, whole millicores).
  const { memoryBytesMin, memoryBytesMax, cpuMilliMin, cpuMilliMax } = APP_TEMPLATE_LIMITS;
  if (!inRange(host.Memory, memoryBytesMin, memoryBytesMax) || host.MemorySwap !== host.Memory) refuse("Memory");
  if (!inRange(host.NanoCpus / 1_000_000, cpuMilliMin, cpuMilliMax)) refuse("NanoCpus");
  if (host.NetworkMode !== appStackInternalNetworkName(stackId)) refuse("NetworkMode");
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
  // The plan schema's text rule for environment values and argv.
  if ([...payload.Env, ...(payload.Cmd ?? [])].some((text) => /docker\.sock/i.test(text))) refuse("host socket");
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
