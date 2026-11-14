import http from "node:http";
import type { Duplex } from "node:stream";
import { ExecutorCodedError } from "./traefik-config.js";

const EXEC_HTTP_TIMEOUT_MS = 10_000;
const EXEC_INSPECT_WAIT_MS = 2_000;
const EXEC_INSPECT_POLL_MS = 50;

export type DockerJsonRequest = (
  method: string,
  path: string,
  jsonBody?: unknown,
  options?: { readonly timeoutMs?: number },
) => Promise<{ readonly statusCode: number; readonly body: Buffer }>;

export interface DockerExecTarget {
  readonly request: DockerJsonRequest;
  readonly socketPath: string;
  readonly apiPrefix: string;
}

export interface DockerExecSpec {
  readonly container: string;
  readonly cmd: readonly string[];
  readonly user?: string;
  readonly workingDir?: string;
  readonly env?: readonly string[];
}

export interface DockerExecResult {
  readonly exitCode: number | null;
  /** True when the exec stream ended without timeout, yet Docker still reported unknown/running exit state. */
  readonly exitUnknown: boolean;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly truncated: boolean;
}

function asEngineError(err: unknown, fallbackMessage: string): ExecutorCodedError {
  if (err instanceof ExecutorCodedError) {
    return err;
  }
  return new ExecutorCodedError(fallbackMessage, "DOCKER_ENGINE_UNAVAILABLE");
}

function parseDockerJson<T>(body: Buffer, what: string): T {
  try {
    return JSON.parse(body.toString("utf8")) as T;
  } catch {
    throw new ExecutorCodedError(
      `Docker Engine returned invalid JSON for ${what}`,
      "DOCKER_ENGINE_UNAVAILABLE",
    );
  }
}

async function requestDockerJson(
  target: DockerExecTarget,
  method: string,
  endpointPath: string,
  jsonBody?: unknown,
  timeoutMs: number = EXEC_HTTP_TIMEOUT_MS,
): Promise<{ readonly statusCode: number; readonly body: Buffer }> {
  try {
    return await target.request(method, endpointPath, jsonBody, { timeoutMs });
  } catch (err) {
    throw asEngineError(err, "Docker Engine request failed");
  }
}

function normalizeUpgradePath(apiPrefix: string, execId: string): string {
  const trimmedPrefix = apiPrefix.replace(/\/+$/, "");
  return `${trimmedPrefix}/exec/${encodeURIComponent(execId)}/start`;
}

/** Creates an exec instance and hijacks its TCP stream over the Docker Engine unix socket. */
export async function startDockerExec(
  target: DockerExecTarget,
  spec: DockerExecSpec & { readonly tty?: boolean },
): Promise<{ readonly execId: string; readonly socket: Duplex }> {
  if (!Array.isArray(spec.cmd) || spec.cmd.length === 0) {
    throw new ExecutorCodedError("Exec command must be a non-empty argv array", "VALIDATION_ERROR");
  }

  const tty = spec.tty === true;
  const createPayload = {
    Cmd: [...spec.cmd],
    ...(spec.user !== undefined ? { User: spec.user } : {}),
    ...(spec.workingDir !== undefined ? { WorkingDir: spec.workingDir } : {}),
    ...(spec.env !== undefined ? { Env: [...spec.env] } : {}),
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: tty,
  };

  const createRes = await requestDockerJson(
    target,
    "POST",
    `/containers/${encodeURIComponent(spec.container)}/exec`,
    createPayload,
  );
  if (createRes.statusCode === 404 || createRes.statusCode === 409) {
    throw new ExecutorCodedError(
      `Exec target container is not found or not running (HTTP ${String(createRes.statusCode)})`,
      "NOT_FOUND",
    );
  }
  if (createRes.statusCode !== 201) {
    throw new ExecutorCodedError(
      `Failed to create Docker exec (HTTP ${String(createRes.statusCode)})`,
      "DOCKER_ENGINE_UNAVAILABLE",
    );
  }

  const created = parseDockerJson<{ readonly Id?: unknown }>(createRes.body, "exec create");
  if (typeof created.Id !== "string" || created.Id.length === 0) {
    throw new ExecutorCodedError(
      "Docker Engine returned missing exec id",
      "DOCKER_ENGINE_UNAVAILABLE",
    );
  }
  const execId = created.Id;
  const startBody = Buffer.from(JSON.stringify({ Detach: false, Tty: tty }), "utf8");

  const socket = await new Promise<Duplex>((resolve, reject) => {
    let settled = false;
    const settleReject = (err: ExecutorCodedError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };

    const req = http.request({
      socketPath: target.socketPath,
      method: "POST",
      path: normalizeUpgradePath(target.apiPrefix, execId),
      headers: {
        Host: "docker",
        "Content-Type": "application/json",
        "Content-Length": startBody.length,
        Connection: "Upgrade",
        Upgrade: "tcp",
      },
    });

    // Manage handshake timeout separately so no socket idle timeout lingers on the upgraded stream.
    const timer = setTimeout(() => {
      req.destroy();
      settleReject(
        new ExecutorCodedError(
          "Timed out waiting for Docker exec connection upgrade",
          "DOCKER_ENGINE_UNAVAILABLE",
        ),
      );
    }, EXEC_HTTP_TIMEOUT_MS);

    req.on("upgrade", (_res, upgradedSocket, head) => {
      if (settled) {
        upgradedSocket.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (head.length > 0) {
        upgradedSocket.unshift(head);
      }
      resolve(upgradedSocket);
    });

    req.on("response", (res) => {
      res.on("error", () => undefined);
      res.resume();
      const status = res.statusCode ?? 500;
      if (status === 404 || status === 409) {
        settleReject(
          new ExecutorCodedError(
            `Exec instance not found or container stopped (HTTP ${String(status)})`,
            "NOT_FOUND",
          ),
        );
        return;
      }
      settleReject(
        new ExecutorCodedError(
          `Docker Engine refused exec upgrade (HTTP ${String(status)})`,
          "DOCKER_ENGINE_UNAVAILABLE",
        ),
      );
    });

    req.on("error", () => {
      settleReject(
        new ExecutorCodedError(
          "Failed to connect to Docker Engine for exec start",
          "DOCKER_ENGINE_UNAVAILABLE",
        ),
      );
    });

    req.end(startBody);
  });

  return { execId, socket };
}

class DockerFrameDemuxer {
  private readonly maxOutputBytes: number;
  private readonly headerBuf = Buffer.alloc(8);
  private headerOffset = 0;
  private remainingPayload = 0;
  private currentStream = 0;
  private readonly stdoutChunks: Buffer[] = [];
  private readonly stderrChunks: Buffer[] = [];
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private truncated = false;

  public constructor(maxOutputBytes: number) {
    this.maxOutputBytes = Math.max(0, maxOutputBytes);
  }

  public push(chunk: Buffer): void {
    let pos = 0;
    while (pos < chunk.length) {
      if (this.remainingPayload === 0) {
        const need = 8 - this.headerOffset;
        const take = Math.min(need, chunk.length - pos);
        chunk.copy(this.headerBuf, this.headerOffset, pos, pos + take);
        this.headerOffset += take;
        pos += take;
        if (this.headerOffset === 8) {
          this.currentStream = this.headerBuf[0] ?? 0;
          this.remainingPayload = this.headerBuf.readUInt32BE(4);
          this.headerOffset = 0;
        }
      } else {
        const take = Math.min(this.remainingPayload, chunk.length - pos);
        this.appendPayloadSlice(chunk.subarray(pos, pos + take));
        pos += take;
        this.remainingPayload -= take;
      }
    }
  }

  public finish(): {
    readonly stdout: Buffer;
    readonly stderr: Buffer;
    readonly truncated: boolean;
  } {
    return {
      stdout: Buffer.concat(this.stdoutChunks),
      stderr: Buffer.concat(this.stderrChunks),
      truncated: this.truncated,
    };
  }

  private appendPayloadSlice(slice: Buffer): void {
    if (slice.length === 0) {
      return;
    }
    if (this.currentStream === 1) {
      const room = this.maxOutputBytes - this.stdoutBytes;
      if (room <= 0) {
        this.truncated = true;
        return;
      }
      if (slice.length > room) {
        this.stdoutChunks.push(slice.subarray(0, room));
        this.stdoutBytes += room;
        this.truncated = true;
        return;
      }
      this.stdoutChunks.push(slice);
      this.stdoutBytes += slice.length;
      return;
    }

    if (this.currentStream === 2) {
      const room = this.maxOutputBytes - this.stderrBytes;
      if (room <= 0) {
        this.truncated = true;
        return;
      }
      if (slice.length > room) {
        this.stderrChunks.push(slice.subarray(0, room));
        this.stderrBytes += room;
        this.truncated = true;
        return;
      }
      this.stderrChunks.push(slice);
      this.stderrBytes += slice.length;
    }
  }
}

async function inspectExecExitCode(
  target: DockerExecTarget,
  execId: string,
): Promise<{ readonly exitCode: number | null; readonly exitUnknown: boolean }> {
  const deadline = Date.now() + EXEC_INSPECT_WAIT_MS;
  for (;;) {
    const res = await requestDockerJson(
      target,
      "GET",
      `/exec/${encodeURIComponent(execId)}/json`,
    );
    if (res.statusCode !== 200) {
      throw new ExecutorCodedError(
        `Failed to inspect Docker exec state (HTTP ${String(res.statusCode)})`,
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
    const parsed = parseDockerJson<{ readonly Running?: unknown; readonly ExitCode?: unknown }>(
      res.body,
      "exec inspect",
    );
    if (parsed.Running !== true) {
      return typeof parsed.ExitCode === "number"
        ? { exitCode: parsed.ExitCode, exitUnknown: false }
        : { exitCode: null, exitUnknown: true };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { exitCode: null, exitUnknown: true };
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(EXEC_INSPECT_POLL_MS, remaining)),
    );
  }
}

/** Runs a non-TTY exec with half-closed stdin, byte-safe demux, per-stream cap, and timeout. */
export async function runDockerExec(
  target: DockerExecTarget,
  spec: DockerExecSpec,
  opts: { readonly stdin?: Buffer; readonly timeoutMs: number; readonly maxOutputBytes: number },
): Promise<DockerExecResult> {
  const { execId, socket } = await startDockerExec(target, { ...spec, tty: false });
  const demuxer = new DockerFrameDemuxer(opts.maxOutputBytes);
  const timeoutMs = Math.max(1, opts.timeoutMs);

  const outcome = await new Promise<{ readonly timedOut: boolean }>((resolve, reject) => {
    let settled = false;
    let ended = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ timedOut: true });
    }, timeoutMs);

    socket.on("data", (chunk: Buffer | string) => {
      demuxer.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });

    socket.on("end", () => {
      ended = true;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false });
    });

    socket.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new ExecutorCodedError("Docker exec stream failed", "DOCKER_ENGINE_UNAVAILABLE"));
    });

    socket.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ended) {
        resolve({ timedOut: false });
        return;
      }
      reject(
        new ExecutorCodedError(
          "Docker exec stream closed before EOF",
          "DOCKER_ENGINE_UNAVAILABLE",
        ),
      );
    });

    if (socket.destroyed) {
      settled = true;
      clearTimeout(timer);
      reject(
        new ExecutorCodedError(
          "Docker exec stream closed immediately",
          "DOCKER_ENGINE_UNAVAILABLE",
        ),
      );
      return;
    }

    if (opts.stdin !== undefined && opts.stdin.length > 0) {
      socket.end(opts.stdin);
    } else {
      socket.end();
    }
  });

  const output = demuxer.finish();
  if (outcome.timedOut) {
    return {
      exitCode: null,
      exitUnknown: false,
      stdout: output.stdout,
      stderr: output.stderr,
      truncated: output.truncated,
    };
  }

  const exit = await inspectExecExitCode(target, execId);
  return {
    exitCode: exit.exitCode,
    exitUnknown: exit.exitUnknown,
    stdout: output.stdout,
    stderr: output.stderr,
    truncated: output.truncated,
  };
}
