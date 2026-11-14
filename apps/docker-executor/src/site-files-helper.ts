import path from "node:path";
import {
  DEFAULT_PHP_VERSION,
  SITE_FILE_CHUNK_BYTES,
  SITE_FILE_ERROR_REASONS,
  SITE_FILE_REASON_CODES,
  SITE_FILES_MAX_FILE_BYTES,
  SITE_FILES_RESULT_SCHEMAS,
  SUPPORTED_PHP_VERSIONS,
  SiteFilesIpcRequestSchema,
  resolveWordpressImage,
  type ErrorCode,
  type SiteFileErrorReason,
} from "@hosting-panel/contracts";
import type { SiteFilesRequest, SiteFilesResult } from "@hosting-panel/executor-contracts";
import type { z } from "zod";
import { runDockerExec, type DockerExecResult, type DockerExecTarget } from "./docker-exec.js";
import { ExecutorCodedError, assertSafeIdentifier, getManagedVolumeName } from "./traefik-config.js";

export const SITE_FILES_ROLE = "site_files";

const SITE_FILES_MANAGED_LABEL = "io.hostingpanel.managed";
const SITE_FILES_ROLE_LABEL = "io.hostingpanel.role";
const SITE_FILES_SITE_LABEL = "io.hostingpanel.site_id";
const SITE_FILES_FOR_LABEL = "io.hostingpanel.files_for";
const SITE_FILES_SERVICE_LABEL = "io.hostingpanel.service_instance_id";

const DEFAULT_IDLE_MS = 600_000;
const MAX_IDLE_SWEEP_INTERVAL_MS = 60_000;
const MAX_EXEC_OUTPUT_BYTES = 1_048_576;
const SWEEP_TIMEOUT_MS = 30_000;
const DEFAULT_OP_TIMEOUT_MS = 45_000;
const DELETE_OP_TIMEOUT_MS = 90_000;
const ARCHIVE_OP_TIMEOUT_MS = 570_000;

const PHP_CMD: readonly string[] = [
  "php",
  "-d",
  "memory_limit=256M",
  "-d",
  "display_errors=stderr",
  "-d",
  "max_execution_time=0",
  "/usr/local/lib/hp-files/hp-files.php",
];

// timeout(1) returns 124 on default signal timeout and 137 (128 + SIGKILL) with -s KILL.
const TIMEOUT_KILL_EXIT_CODES: ReadonlySet<number> = new Set([124, 137]);

/** Wraps PHP_CMD in coreutils `timeout -s KILL <seconds>` slightly below the Node timer. */
function buildPhpCmd(timeoutMs: number): readonly string[] {
  const timeoutSeconds = Math.max(1, Math.floor(timeoutMs / 1000) - 2);
  return ["timeout", "-s", "KILL", String(timeoutSeconds), ...PHP_CMD];
}

const ALLOWED_WORDPRESS_IMAGES: ReadonlySet<string> = new Set(
  SUPPORTED_PHP_VERSIONS.map(resolveWordpressImage),
);

const ALLOWED_HELPER_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "QUOTA_EXCEEDED",
  "NOT_SUPPORTED",
]);

const VALID_REASON_SET: ReadonlySet<string> = new Set(SITE_FILE_ERROR_REASONS);

function isSiteFileErrorReason(value: unknown): value is SiteFileErrorReason {
  return typeof value === "string" && VALID_REASON_SET.has(value);
}

export const siteFilesHelperName = (serviceInstanceId: string): string => {
  assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
  return `hp_files_${serviceInstanceId}`;
};

export function parseSiteFilesRequest(req: unknown): SiteFilesRequest {
  const parsed = SiteFilesIpcRequestSchema.safeParse(req);
  if (!parsed.success) {
    const firstMessage = parsed.error.issues[0]?.message;
    if (isSiteFileErrorReason(firstMessage)) {
      throw new ExecutorCodedError(firstMessage, SITE_FILE_REASON_CODES[firstMessage]);
    }
    throw new ExecutorCodedError(
      firstMessage ?? "Invalid site files request",
      "VALIDATION_ERROR",
    );
  }

  const data = parsed.data;
  assertSafeIdentifier(data.serviceInstanceId, "serviceInstanceId");

  if (data.op === "write") {
    const decodedLength = Buffer.from(data.dataBase64, "base64").length;
    if (decodedLength > SITE_FILE_CHUNK_BYTES) {
      throw new ExecutorCodedError("too_large", SITE_FILE_REASON_CODES.too_large);
    }
    if (data.offset + decodedLength > SITE_FILES_MAX_FILE_BYTES) {
      throw new ExecutorCodedError("too_large", SITE_FILE_REASON_CODES.too_large);
    }
  } else if (data.op === "move") {
    if (data.from === data.to || data.to.startsWith(`${data.from}/`)) {
      throw new ExecutorCodedError("invalid_path", SITE_FILE_REASON_CODES.invalid_path);
    }
  }

  return data;
}

function assertSafeProgramDir(programDir: string): string {
  if (
    typeof programDir !== "string" ||
    programDir.length === 0 ||
    !path.posix.isAbsolute(programDir) ||
    programDir === "/" ||
    /[\0\r\n:]/.test(programDir) ||
    programDir.includes("..") ||
    programDir.includes("docker.sock") ||
    path.posix.resolve(programDir) !== programDir
  ) {
    throw new ExecutorCodedError(
      "Unsafe site files helper program directory",
      "HOST_POLICY_DENIED",
    );
  }
  return programDir;
}

export function buildSiteFilesHelperPayload(input: {
  image: string;
  serviceInstanceId: string;
  siteId: string;
  programDir: string;
}): Record<string, unknown> {
  const rawInput = input as Record<string, unknown>;
  if (rawInput.extraBinds !== undefined || rawInput.binds !== undefined) {
    throw new ExecutorCodedError(
      "Extra binds are forbidden on site files helper containers",
      "HOST_POLICY_DENIED",
    );
  }
  assertSafeIdentifier(input.serviceInstanceId, "serviceInstanceId");
  assertSafeIdentifier(input.siteId, "siteId");
  if (typeof input.image !== "string" || input.image.trim().length === 0 || /[\s\0]/.test(input.image)) {
    throw new ExecutorCodedError("Invalid site files helper container image", "HOST_POLICY_DENIED");
  }

  const programDir = assertSafeProgramDir(input.programDir);
  const volumeName = getManagedVolumeName(input.serviceInstanceId, "html");
  const expectedVolumeBind = `${volumeName}:/var/www/html:rw`;
  const expectedProgramBind = `${programDir}:/usr/local/lib/hp-files:ro`;
  const binds = [expectedVolumeBind, expectedProgramBind];

  if (binds.length !== 2 || binds.some((b) => b.includes("docker.sock"))) {
    throw new ExecutorCodedError(
      "Site files helper binds failed allowlist check",
      "HOST_POLICY_DENIED",
    );
  }

  return {
    Image: input.image,
    Entrypoint: ["sleep", "infinity"],
    Cmd: [],
    User: "33:33",
    WorkingDir: "/var/www/html",
    Env: [],
    NetworkDisabled: true,
    StopSignal: "SIGKILL",
    Labels: {
      [SITE_FILES_MANAGED_LABEL]: "true",
      [SITE_FILES_ROLE_LABEL]: SITE_FILES_ROLE,
      [SITE_FILES_SITE_LABEL]: input.siteId,
      [SITE_FILES_FOR_LABEL]: input.serviceInstanceId,
    },
    HostConfig: {
      NetworkMode: "none",
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16m" },
      PidsLimit: 64,
      Memory: 536_870_912,
      MemorySwap: 536_870_912,
      NanoCpus: 1_000_000_000,
      RestartPolicy: { Name: "no" },
      Binds: binds,
    },
  };
}

interface HelperState {
  active: number;
  lastUsed: number;
  containerId: string | null;
}

interface ContainerInspectJson {
  readonly Id?: unknown;
  readonly State?: {
    readonly Running?: unknown;
    readonly Dead?: unknown;
  };
  readonly Config?: {
    readonly Labels?: Readonly<Record<string, string>>;
  };
}

interface VolumeInspectJson {
  readonly Labels?: Readonly<Record<string, string>> | null;
}

interface ContainerSummaryJson {
  readonly Id?: unknown;
  readonly Image?: unknown;
}

function opTimeoutBudgetMs(op: SiteFilesRequest["op"], overrideMs?: number): number {
  if (overrideMs !== undefined) {
    return overrideMs;
  }
  if (op === "archive" || op === "extract") {
    return ARCHIVE_OP_TIMEOUT_MS;
  }
  if (op === "delete") {
    return DELETE_OP_TIMEOUT_MS;
  }
  return DEFAULT_OP_TIMEOUT_MS;
}

function logHelperFailure(exitCode: number | null, truncated: boolean): void {
  console.warn(
    JSON.stringify({
      component: "hp-docker-executor",
      event: "site_files_helper_failed",
      exitCode,
      truncated,
      timestamp: new Date().toISOString(),
    }),
  );
}

function parseDockerPayload<T>(body: Buffer, what: string): T {
  try {
    return JSON.parse(body.toString("utf8")) as T;
  } catch {
    throw new ExecutorCodedError(
      `Docker Engine returned invalid JSON for ${what}`,
      "DOCKER_ENGINE_UNAVAILABLE",
    );
  }
}

export class SiteFilesHelpers {
  private readonly target: DockerExecTarget;
  private readonly programDir: string;
  private readonly idleMs: number;
  private readonly opTimeoutMs?: number;
  private readonly states = new Map<string, HelperState>();
  private readonly ensureInFlight = new Map<string, Promise<string>>();
  private readonly removeInFlight = new Map<string, Promise<void>>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  public constructor(deps: {
    target: DockerExecTarget;
    programDir: string;
    idleMs?: number;
    opTimeoutMs?: number;
  }) {
    this.target = deps.target;
    this.programDir = deps.programDir;
    this.idleMs = Math.max(1, deps.idleMs ?? DEFAULT_IDLE_MS);
    this.opTimeoutMs = deps.opTimeoutMs;
  }

  public async run<R extends SiteFilesRequest>(req: R): Promise<SiteFilesResult<R["op"]>> {
    const parsedReq = parseSiteFilesRequest(req) as R;
    const svc = parsedReq.serviceInstanceId;
    const state = this.getOrCreateState(svc);
    state.active += 1;
    state.lastUsed = Date.now();

    const { serviceInstanceId: _svc, ...programPayload } = parsedReq;
    const stdin = Buffer.from(`${JSON.stringify(programPayload)}\n`, "utf8");
    const timeoutMs = opTimeoutBudgetMs(parsedReq.op, this.opTimeoutMs);

    try {
      let containerRef = await this.ensure(svc);
      let execResult: DockerExecResult;
      try {
        execResult = await this.execPhp(containerRef, stdin, timeoutMs);
      } catch (err) {
        if (err instanceof ExecutorCodedError && err.code === "NOT_FOUND") {
          this.clearStateContainer(svc, containerRef);
          containerRef = await this.ensure(svc);
          execResult = await this.execPhp(containerRef, stdin, timeoutMs);
        } else {
          throw err;
        }
      }

      if (execResult.exitCode !== null && TIMEOUT_KILL_EXIT_CODES.has(execResult.exitCode)) {
        throw new ExecutorCodedError(
          "Site files operation timed out",
          "OPERATION_INTERRUPTED",
        );
      }

      if (execResult.exitCode === null) {
        if (execResult.exitUnknown && !execResult.truncated) {
          const decoded = this.decodeHelperReply(parsedReq.op as R["op"], execResult.stdout);
          if (decoded.kind === "result") {
            return decoded.result;
          }
          if (decoded.kind === "refusal") {
            throw decoded.error;
          }
        }
        if (state.active === 1) {
          await this.forceRemoveTracked(svc, containerRef);
        }
        throw new ExecutorCodedError(
          "Site files operation timed out",
          "OPERATION_INTERRUPTED",
        );
      }

      if (execResult.exitCode !== 0 || execResult.truncated) {
        logHelperFailure(execResult.exitCode, execResult.truncated);
        throw new ExecutorCodedError("Site files helper failed", "INTERNAL_ERROR");
      }

      return this.parseHelperReply(parsedReq.op as R["op"], execResult);
    } finally {
      state.active -= 1;
      state.lastUsed = Date.now();
      if (state.active === 0 && state.containerId === null) {
        this.states.delete(svc);
      }
      this.syncIdleTimer();
    }
  }

  public async removeAll(): Promise<void> {
    const filters = JSON.stringify({
      label: [`${SITE_FILES_ROLE_LABEL}=${SITE_FILES_ROLE}`],
    });
    const res = await this.dockerRequest(
      "GET",
      `/containers/json?all=true&filters=${encodeURIComponent(filters)}`,
    );
    if (res.statusCode !== 200) {
      throw new ExecutorCodedError(
        `Failed to list site files helpers (HTTP ${String(res.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }

    const containers = parseDockerPayload<ContainerSummaryJson[]>(res.body, "helper list");
    for (const container of containers) {
      if (typeof container.Id === "string" && container.Id.length > 0) {
        await this.forceRemoveContainer(container.Id);
      }
    }

    for (const [svc, state] of this.states.entries()) {
      state.containerId = null;
      if (state.active === 0) {
        this.states.delete(svc);
      }
    }
    this.syncIdleTimer();
  }

  public stop(): void {
    this.stopped = true;
    this.stopIdleTimer();
  }

  private getOrCreateState(svc: string): HelperState {
    let state = this.states.get(svc);
    if (!state) {
      state = { active: 0, lastUsed: Date.now(), containerId: null };
      this.states.set(svc, state);
    }
    return state;
  }

  private clearStateContainer(svc: string, expectedId: string): void {
    const state = this.states.get(svc);
    if (state && state.containerId === expectedId) {
      state.containerId = null;
    }
  }

  private syncIdleTimer(): void {
    if (this.stopped || this.states.size === 0) {
      this.stopIdleTimer();
      return;
    }
    if (this.idleTimer !== null) {
      return;
    }
    const intervalMs = Math.max(1, Math.min(MAX_IDLE_SWEEP_INTERVAL_MS, this.idleMs));
    this.idleTimer = setInterval(() => {
      void this.sweepIdleHelpers();
    }, intervalMs);
    this.idleTimer.unref();
  }

  private stopIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private isIdleCandidate(
    svc: string,
    state: HelperState | undefined,
    now: number,
    expectedContainerId?: string,
  ): state is HelperState & { containerId: string } {
    if (!state || state.containerId === null) {
      return false;
    }
    if (expectedContainerId !== undefined && state.containerId !== expectedContainerId) {
      return false;
    }
    return (
      state.active === 0 &&
      !this.ensureInFlight.has(svc) &&
      !this.removeInFlight.has(svc) &&
      now - state.lastUsed >= this.idleMs
    );
  }

  private async sweepIdleHelpers(): Promise<void> {
    const now = Date.now();
    const candidates: Array<{ svc: string; containerRef: string }> = [];

    for (const [svc, state] of this.states.entries()) {
      if (this.isIdleCandidate(svc, state, now)) {
        candidates.push({ svc, containerRef: state.containerId });
      }
    }

    for (const candidate of candidates) {
      if (
        !this.isIdleCandidate(
          candidate.svc,
          this.states.get(candidate.svc),
          Date.now(),
          candidate.containerRef,
        )
      ) {
        continue;
      }
      await this.forceRemoveTracked(candidate.svc, candidate.containerRef).catch(() => undefined);
    }
    this.syncIdleTimer();
  }

  private async forceRemoveTracked(svc: string, containerRef: string): Promise<void> {
    const state = this.states.get(svc);
    if (state && state.containerId === containerRef) {
      state.containerId = null;
      if (state.active === 0) {
        this.states.delete(svc);
      }
    }
    const pending = this.removeInFlight.get(svc);
    const next = (pending ?? Promise.resolve()).then(() =>
      this.forceRemoveContainer(containerRef),
    );
    const tracked = next.finally(() => {
      if (this.removeInFlight.get(svc) === tracked) {
        this.removeInFlight.delete(svc);
      }
    });
    this.removeInFlight.set(svc, tracked);
    await tracked;
  }

  private ensure(svc: string): Promise<string> {
    const existing = this.ensureInFlight.get(svc);
    if (existing) {
      return existing;
    }
    const pending = this.ensureOnce(svc).finally(() => {
      if (this.ensureInFlight.get(svc) === pending) {
        this.ensureInFlight.delete(svc);
      }
    });
    this.ensureInFlight.set(svc, pending);
    return pending;
  }

  private async ensureOnce(svc: string): Promise<string> {
    const pendingRemove = this.removeInFlight.get(svc);
    if (pendingRemove) {
      await pendingRemove.catch(() => undefined);
    }

    const helperName = siteFilesHelperName(svc);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Step 1: Inspect existing helper container; reuse only if running with role=site_files.
      const inspectRes = await this.dockerRequest(
        "GET",
        `/containers/${encodeURIComponent(helperName)}/json`,
      );
      if (inspectRes.statusCode === 200) {
        const inspect = parseDockerPayload<ContainerInspectJson>(
          inspectRes.body,
          "helper inspect",
        );
        const id = typeof inspect.Id === "string" ? inspect.Id : "";
        const labels = inspect.Config?.Labels;
        const filesFor = labels?.[SITE_FILES_FOR_LABEL];
        const reusable =
          id.length > 0 &&
          inspect.State?.Running === true &&
          inspect.State?.Dead !== true &&
          labels?.[SITE_FILES_ROLE_LABEL] === SITE_FILES_ROLE &&
          (filesFor === undefined || filesFor === svc);
        if (reusable) {
          const state = this.getOrCreateState(svc);
          state.containerId = id;
          return id;
        }
        if (id.length > 0) {
          await this.forceRemoveContainer(id);
        } else {
          await this.forceRemoveContainer(helperName);
        }
      } else if (inspectRes.statusCode !== 404) {
        throw new ExecutorCodedError(
          `Failed to inspect site files helper (HTTP ${String(inspectRes.statusCode)})`,
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }

      // Step 2: Volume must already exist; never let a container bind create it implicitly.
      const volumeName = getManagedVolumeName(svc, "html");
      const volRes = await this.dockerRequest("GET", `/volumes/${encodeURIComponent(volumeName)}`);
      if (volRes.statusCode === 404) {
        throw new ExecutorCodedError("not_found", SITE_FILE_REASON_CODES.not_found);
      }
      if (volRes.statusCode !== 200) {
        throw new ExecutorCodedError(
          `Failed to inspect site files volume (HTTP ${String(volRes.statusCode)})`,
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }

      // Step 3: Validate siteId label from the volume.
      const vol = parseDockerPayload<VolumeInspectJson>(volRes.body, "volume inspect");
      const siteId = assertSafeIdentifier(vol.Labels?.[SITE_FILES_SITE_LABEL] ?? "", "siteId");

      // Step 4: Pick an allowlisted WordPress image from the site container (or default) without pulling.
      const image = await this.resolveHelperImage(svc);
      const imgRes = await this.dockerRequest("GET", `/images/${encodeURIComponent(image)}/json`);
      if (imgRes.statusCode !== 200) {
        throw new ExecutorCodedError(
          "Site files helper image is unavailable",
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }

      // Step 5: Create and start the hardened helper container.
      const payload = buildSiteFilesHelperPayload({
        image,
        serviceInstanceId: svc,
        siteId,
        programDir: this.programDir,
      });
      const createRes = await this.dockerRequest(
        "POST",
        `/containers/create?name=${encodeURIComponent(helperName)}`,
        payload,
      );
      if (createRes.statusCode === 409 && attempt === 0) {
        continue;
      }
      if (createRes.statusCode !== 201) {
        throw new ExecutorCodedError(
          `Failed to create site files helper (HTTP ${String(createRes.statusCode)})`,
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }

      const created = parseDockerPayload<{ readonly Id?: unknown }>(
        createRes.body,
        "helper create",
      );
      if (typeof created.Id !== "string" || created.Id.length === 0) {
        throw new ExecutorCodedError(
          "Docker Engine returned missing helper container id",
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }
      const containerId = created.Id;

      const startRes = await this.dockerRequest(
        "POST",
        `/containers/${encodeURIComponent(containerId)}/start`,
      );
      if (startRes.statusCode !== 204 && startRes.statusCode !== 304) {
        await this.forceRemoveContainer(containerId).catch(() => undefined);
        throw new ExecutorCodedError(
          `Failed to start site files helper (HTTP ${String(startRes.statusCode)})`,
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }

      const state = this.getOrCreateState(svc);
      state.containerId = containerId;
      this.fireSweep(containerId);
      return containerId;
    }

    throw new ExecutorCodedError(
      "Failed to create site files helper after name conflict",
      "DOCKER_ENGINE_UNAVAILABLE",
    );
  }

  private async resolveHelperImage(svc: string): Promise<string> {
    const filters = JSON.stringify({ label: [`${SITE_FILES_SERVICE_LABEL}=${svc}`] });
    const res = await this.dockerRequest(
      "GET",
      `/containers/json?all=true&filters=${encodeURIComponent(filters)}`,
    );
    if (res.statusCode !== 200) {
      throw new ExecutorCodedError(
        `Failed to query site container image (HTTP ${String(res.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
    const list = parseDockerPayload<ContainerSummaryJson[]>(res.body, "site container list");
    const candidate = list[0]?.Image;
    if (typeof candidate === "string" && ALLOWED_WORDPRESS_IMAGES.has(candidate)) {
      return candidate;
    }
    return resolveWordpressImage(DEFAULT_PHP_VERSION);
  }

  private fireSweep(containerId: string): void {
    const stdin = Buffer.from('{"op":"sweep"}\n', "utf8");
    void this.execPhp(containerId, stdin, SWEEP_TIMEOUT_MS).catch(() => undefined);
  }

  private execPhp(
    containerRef: string,
    stdin: Buffer,
    timeoutMs: number,
  ): Promise<DockerExecResult> {
    return runDockerExec(
      this.target,
      {
        container: containerRef,
        cmd: buildPhpCmd(timeoutMs),
        user: "33:33",
        workingDir: "/var/www/html",
        env: [],
      },
      {
        stdin,
        timeoutMs,
        maxOutputBytes: MAX_EXEC_OUTPUT_BYTES,
      },
    );
  }

  private decodeHelperReply<O extends SiteFilesRequest["op"]>(
    op: O,
    stdout: Buffer,
  ):
    | { readonly kind: "result"; readonly result: SiteFilesResult<O> }
    | { readonly kind: "refusal"; readonly error: ExecutorCodedError }
    | { readonly kind: "invalid"; readonly message: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.toString("utf8")) as unknown;
    } catch {
      return { kind: "invalid", message: "Site files helper returned invalid JSON" };
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "invalid", message: "Site files helper returned malformed reply" };
    }

    const record = parsed as Record<string, unknown>;
    if (record.ok === true) {
      const schema = SITE_FILES_RESULT_SCHEMAS[op] as z.ZodTypeAny;
      const checked = schema.safeParse(record.result);
      if (!checked.success) {
        return { kind: "invalid", message: "Site files helper returned invalid result payload" };
      }
      return { kind: "result", result: checked.data as SiteFilesResult<O> };
    }

    if (record.ok === false) {
      const rawCode = record.code;
      const rawReason = record.reason;
      if (
        typeof rawCode === "string" &&
        ALLOWED_HELPER_ERROR_CODES.has(rawCode as ErrorCode) &&
        isSiteFileErrorReason(rawReason) &&
        SITE_FILE_REASON_CODES[rawReason] === rawCode
      ) {
        return {
          kind: "refusal",
          error: new ExecutorCodedError(rawReason, SITE_FILE_REASON_CODES[rawReason]),
        };
      }
      return { kind: "invalid", message: "Site files helper returned disallowed error payload" };
    }

    return { kind: "invalid", message: "Site files helper returned unknown reply status" };
  }

  private parseHelperReply<O extends SiteFilesRequest["op"]>(
    op: O,
    execResult: DockerExecResult,
  ): SiteFilesResult<O> {
    const decoded = this.decodeHelperReply(op, execResult.stdout);
    if (decoded.kind === "result") {
      return decoded.result;
    }
    if (decoded.kind === "refusal") {
      throw decoded.error;
    }
    logHelperFailure(execResult.exitCode, execResult.truncated);
    throw new ExecutorCodedError(decoded.message, "INTERNAL_ERROR");
  }

  private async dockerRequest(
    method: string,
    endpointPath: string,
    jsonBody?: unknown,
  ): Promise<{ readonly statusCode: number; readonly body: Buffer }> {
    try {
      return await this.target.request(method, endpointPath, jsonBody);
    } catch (err) {
      if (err instanceof ExecutorCodedError) {
        throw err;
      }
      throw new ExecutorCodedError(
        "Docker Engine request failed",
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
  }

  private async forceRemoveContainer(containerRef: string): Promise<void> {
    const res = await this.dockerRequest(
      "DELETE",
      `/containers/${encodeURIComponent(containerRef)}?force=true&v=true`,
    );
    if (res.statusCode !== 204 && res.statusCode !== 404) {
      throw new ExecutorCodedError(
        `Failed to remove site files helper (HTTP ${String(res.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
  }
}
