import http from "node:http";
import { z } from "zod";
import {
  ApiErrorEnvelopeSchema,
  HostAgentHealthResponseSchema,
  HostTelemetryWireSchema,
  signIpcRequest,
  type ErrorCode,
  type HostAgentHealthResponse,
  type IpcSigningKey,
} from "@hosting-panel/contracts";
import {
  createApprovedHostMaintenanceCommand,
  createApprovedHostSecurityCommand,
  type ApprovedHostMaintenanceCommand,
  type ApprovedHostSecurityCommand,
  type HostAgentPort,
  type HostMaintenanceResult,
  type HostSecurityResult,
  type HostTelemetry,
} from "@hosting-panel/host-agent-contracts";
import { HostPolicyDeniedError } from "./nftables-baseline.js";
import { DEFAULT_HOST_AGENT_SOCKET_PATH, type HostAgentBoundEndpoint } from "./server.js";

const HostMaintenanceResultEnvelopeSchema = z.object({
  data: z.object({
    operationId: z.string().min(1),
    hostId: z.string().min(1),
    action: z.string().min(1),
    status: z.enum(["succeeded", "failed"]),
    output: z.string().optional(),
  }),
});

const HostSecurityResultEnvelopeSchema = z.object({
  data: z.object({
    operationId: z.string().min(1),
    hostId: z.string().min(1),
    policyRef: z.string().min(1),
    status: z.enum(["succeeded", "failed"]),
    output: z.string().optional(),
  }),
});

const HostTelemetryEnvelopeSchema = z.object({
  data: HostTelemetryWireSchema,
});

export class HostAgentIpcClientError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly ambiguousOutcome: boolean;

  public constructor(
    code: ErrorCode,
    statusCode: number,
    message: string,
    retryable: boolean = false,
    ambiguousOutcome: boolean = false,
  ) {
    super(message);
    this.name = "HostAgentIpcClientError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.ambiguousOutcome = ambiguousOutcome;
  }
}

export interface SignedHostAgentIpcClientOptions {
  readonly signingKey: IpcSigningKey;
  readonly endpoint?: HostAgentBoundEndpoint;
  readonly socketPath?: string;
  readonly timeoutMs?: number;
  readonly nowProvider?: () => number;
}

function normalizeClientEndpoint(options: SignedHostAgentIpcClientOptions): HostAgentBoundEndpoint {
  if (options.endpoint) {
    if (options.endpoint.transport === "loopback-test") {
      if (options.endpoint.host !== "127.0.0.1") {
        throw new HostPolicyDeniedError(
          "SignedHostAgentIpcClient refuses non-loopback TCP endpoint",
        );
      }
      if (!Number.isInteger(options.endpoint.port) || options.endpoint.port <= 0) {
        throw new HostPolicyDeniedError("Invalid loopback-test port for SignedHostAgentIpcClient");
      }
      return options.endpoint;
    }

    if (options.endpoint.transport === "pipe") {
      if (!options.endpoint.pipePath.startsWith("\\\\.\\pipe\\")) {
        throw new HostPolicyDeniedError("Invalid Named Pipe endpoint for SignedHostAgentIpcClient");
      }
      return options.endpoint;
    }

    if (
      !options.endpoint.socketPath.startsWith("/") ||
      options.endpoint.socketPath.includes("..")
    ) {
      throw new HostPolicyDeniedError(
        "Invalid Unix Domain Socket endpoint for SignedHostAgentIpcClient",
      );
    }
    return options.endpoint;
  }

  const socketPath = options.socketPath ?? DEFAULT_HOST_AGENT_SOCKET_PATH;
  if (!socketPath.startsWith("/") || socketPath.includes("..")) {
    throw new HostPolicyDeniedError("Invalid Unix Domain Socket path for SignedHostAgentIpcClient");
  }

  return {
    transport: "uds",
    socketPath,
  };
}

export class SignedHostAgentIpcClient implements HostAgentPort {
  public readonly isRuntimeAvailable = true;

  private readonly signingKey: IpcSigningKey;
  private readonly endpoint: HostAgentBoundEndpoint;
  private readonly timeoutMs: number;
  private readonly nowProvider?: () => number;

  public constructor(options: SignedHostAgentIpcClientOptions) {
    this.signingKey = options.signingKey;
    this.endpoint = normalizeClientEndpoint(options);
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.nowProvider = options.nowProvider;
  }

  private async requestJson(
    method: "GET" | "POST",
    pathWithQuery: string,
    bodyObject?: unknown,
  ): Promise<{ readonly statusCode: number; readonly bodyText: string }> {
    const bodyString = bodyObject !== undefined ? JSON.stringify(bodyObject) : undefined;
    const signedHeaders = signIpcRequest({
      method,
      pathWithQuery,
      body: bodyString ?? null,
      key: this.signingKey,
      timestampMs: this.nowProvider?.(),
    });

    const headers: Record<string, string> = {
      accept: "application/json",
      ...signedHeaders,
    };

    if (bodyString !== undefined) {
      headers["content-type"] = "application/json; charset=utf-8";
      headers["content-length"] = String(Buffer.byteLength(bodyString, "utf8"));
    }

    const requestOptions: http.RequestOptions =
      this.endpoint.transport === "loopback-test"
        ? {
            host: "127.0.0.1",
            port: this.endpoint.port,
            method,
            path: pathWithQuery,
            headers,
            timeout: this.timeoutMs,
          }
        : {
            socketPath:
              this.endpoint.transport === "pipe"
                ? this.endpoint.pipePath
                : this.endpoint.socketPath,
            method,
            path: pathWithQuery,
            headers,
            timeout: this.timeoutMs,
          };

    return await new Promise<{ readonly statusCode: number; readonly bodyText: string }>(
      (resolveReq, rejectReq) => {
        const isMutating = method !== "GET";
        let socketConnected = false;
        let writeStarted = false;
        let timedOut = false;
        let settled = false;

        const rejectOnce = (err: HostAgentIpcClientError): void => {
          if (settled) {
            return;
          }
          settled = true;
          rejectReq(err);
        };

        const req = http.request(requestOptions, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer | Uint8Array) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          res.on("end", () => {
            if (settled) {
              return;
            }
            settled = true;
            resolveReq({
              statusCode: res.statusCode ?? 500,
              bodyText: Buffer.concat(chunks).toString("utf8"),
            });
          });
          res.on("error", (err) => {
            rejectOnce(
              isMutating
                ? new HostAgentIpcClientError(
                    "OPERATION_AMBIGUOUS",
                    502,
                    `Host agent IPC response stream dropped after mutating command dispatch: ${err.message}`,
                    false,
                    true,
                  )
                : new HostAgentIpcClientError(
                    "HOST_AGENT_UNAVAILABLE",
                    503,
                    `Host agent IPC response stream failed: ${err.message}`,
                    true,
                    false,
                  ),
            );
          });
        });

        req.on("socket", (sock) => {
          if (!sock.connecting) {
            socketConnected = true;
          } else {
            sock.once("connect", () => {
              socketConnected = true;
            });
          }
        });

        req.on("timeout", () => {
          timedOut = true;
          req.destroy(new Error("IPC request timed out"));
          rejectOnce(
            isMutating && (socketConnected || writeStarted)
              ? new HostAgentIpcClientError(
                  "OPERATION_AMBIGUOUS",
                  502,
                  "Timed out waiting for host-agent IPC response after mutating command dispatch",
                  false,
                  true,
                )
              : new HostAgentIpcClientError(
                  "HOST_AGENT_UNAVAILABLE",
                  503,
                  "Timed out waiting for host-agent IPC response",
                  true,
                  false,
                ),
          );
        });

        req.on("error", (err) => {
          const errno = (err as NodeJS.ErrnoException | null)?.code;
          const preConnectDefiniteRefusal =
            !socketConnected &&
            (errno === "ENOENT" ||
              errno === "ECONNREFUSED" ||
              errno === "EACCES" ||
              errno === "ENOTSOCK");
          if (
            isMutating &&
            !preConnectDefiniteRefusal &&
            (timedOut || (socketConnected && writeStarted))
          ) {
            rejectOnce(
              new HostAgentIpcClientError(
                "OPERATION_AMBIGUOUS",
                502,
                `Host agent IPC connection dropped after mutating command dispatch: ${err.message}`,
                false,
                true,
              ),
            );
            return;
          }
          rejectOnce(
            new HostAgentIpcClientError(
              "HOST_AGENT_UNAVAILABLE",
              503,
              `Host agent IPC transport unavailable: ${err.message}`,
              true,
              false,
            ),
          );
        });

        writeStarted = true;
        if (bodyString !== undefined) {
          req.write(bodyString, "utf8");
        }
        req.end();
      },
    );
  }

  private parseOrThrowError(statusCode: number, bodyText: string): never {
    try {
      const parsedJson: unknown = JSON.parse(bodyText);
      const envelope = ApiErrorEnvelopeSchema.safeParse(parsedJson);
      if (envelope.success) {
        throw new HostAgentIpcClientError(
          envelope.data.error.code,
          statusCode,
          envelope.data.error.message,
          envelope.data.error.retryable,
        );
      }
    } catch (err) {
      if (err instanceof HostAgentIpcClientError) {
        throw err;
      }
    }

    throw new HostAgentIpcClientError(
      statusCode === 401
        ? "UNAUTHENTICATED"
        : statusCode === 403
          ? "HOST_POLICY_DENIED"
          : statusCode === 404
            ? "NOT_FOUND"
            : statusCode === 409
              ? "IDEMPOTENCY_CONFLICT"
              : "INTERNAL_ERROR",
      statusCode,
      `Host agent IPC returned unexpected status ${String(statusCode)}`,
      false,
    );
  }

  public async checkHealth(): Promise<HostAgentHealthResponse> {
    const { statusCode, bodyText } = await this.requestJson("GET", "/v1/health");
    if (statusCode !== 200) {
      this.parseOrThrowError(statusCode, bodyText);
    }
    return HostAgentHealthResponseSchema.parse(JSON.parse(bodyText));
  }

  public async getHostTelemetry(hostId: string): Promise<HostTelemetry | null> {
    if (!hostId || hostId.trim().length === 0) {
      throw new Error("hostId must not be empty");
    }

    const query = new URLSearchParams({ hostId: hostId.trim() }).toString();
    const { statusCode, bodyText } = await this.requestJson("GET", `/v1/telemetry?${query}`);
    if (statusCode === 404) {
      return null;
    }
    if (statusCode !== 200) {
      this.parseOrThrowError(statusCode, bodyText);
    }

    const parsed = HostTelemetryEnvelopeSchema.parse(JSON.parse(bodyText));
    return parsed.data;
  }

  public async executeMaintenance(
    command: ApprovedHostMaintenanceCommand,
    operationId?: string,
  ): Promise<HostMaintenanceResult> {
    const approved = createApprovedHostMaintenanceCommand({
      hostId: command.hostId,
      action: command.action,
      reason: command.reason,
    });

    const { statusCode, bodyText } = await this.requestJson("POST", "/v1/maintenance", {
      ...(operationId ? { operationId } : {}),
      hostId: approved.hostId,
      action: approved.action,
      ...(approved.reason ? { reason: approved.reason } : {}),
    });

    if (statusCode !== 200) {
      this.parseOrThrowError(statusCode, bodyText);
    }

    const parsed = HostMaintenanceResultEnvelopeSchema.parse(JSON.parse(bodyText));
    return parsed.data;
  }

  public async executeSecurityPolicy(
    command: ApprovedHostSecurityCommand,
    operationId?: string,
  ): Promise<HostSecurityResult> {
    const approved = createApprovedHostSecurityCommand({
      hostId: command.hostId,
      policyRef: command.policyRef,
      reason: command.reason,
    });

    const { statusCode, bodyText } = await this.requestJson("POST", "/v1/security", {
      ...(operationId ? { operationId } : {}),
      hostId: approved.hostId,
      policyRef: approved.policyRef,
      ...(approved.reason ? { reason: approved.reason } : {}),
    });

    if (statusCode !== 200) {
      this.parseOrThrowError(statusCode, bodyText);
    }

    const parsed = HostSecurityResultEnvelopeSchema.parse(JSON.parse(bodyText));
    return parsed.data;
  }
}
