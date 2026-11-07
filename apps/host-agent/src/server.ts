import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import {
  DEFAULT_IPC_MAX_CLOCK_SKEW_MS,
  HostAgentHealthResponseSchema,
  HostMaintenanceIpcRequestSchema,
  HostSecurityIpcRequestSchema,
  HostTelemetryWireSchema,
  IpcNonceReplayCache,
  createErrorEnvelope,
  verifyIpcRequest,
  type ErrorCode,
  type HostAgentHealthResponse,
  type IpcVerificationKeyring,
  type RuntimeBackend,
} from "@hosting-panel/contracts";
import {
  createApprovedHostMaintenanceCommand,
  createApprovedHostSecurityCommand,
  isAllowlistedHostMaintenanceAction,
  isAllowlistedHostSecurityPolicy,
  type HostAgentPort,
} from "@hosting-panel/host-agent-contracts";
import { HOST_AGENT_VERSION } from "./linux-adapter.js";
import { HostPolicyDeniedError } from "./nftables-baseline.js";

export const DEFAULT_HOST_AGENT_SOCKET_PATH = "/run/hosting-panel/host-agent.sock" as const;
export const DEFAULT_HOST_AGENT_SOCKET_MODE = 0o660;
const MAX_IPC_BODY_BYTES = 64 * 1024;

export type HostAgentTransportMode = "uds" | "pipe" | "loopback-test";

export type HostAgentTransportConfig =
  | {
      readonly transport?: "uds";
      readonly socketPath?: string;
      readonly socketMode?: number;
      readonly host?: undefined;
      readonly port?: undefined;
    }
  | {
      readonly transport: "pipe";
      readonly pipePath: string;
      readonly host?: undefined;
      readonly port?: undefined;
    }
  | {
      readonly transport: "loopback-test";
      readonly host?: "127.0.0.1";
      readonly port?: 0;
    };

export type HostAgentBoundEndpoint =
  | {
      readonly transport: "uds";
      readonly socketPath: string;
    }
  | {
      readonly transport: "pipe";
      readonly pipePath: string;
    }
  | {
      readonly transport: "loopback-test";
      readonly host: "127.0.0.1";
      readonly port: number;
    };

export interface HealthCapableHostAdapter extends HostAgentPort {
  checkHealth?(): Promise<HostAgentHealthResponse>;
}

export interface HostAgentIpcServerOptions {
  readonly adapter: HealthCapableHostAdapter;
  readonly keyring: IpcVerificationKeyring;
  readonly nonceCache?: IpcNonceReplayCache;
  readonly maxClockSkewMs?: number;
  readonly nowProvider?: () => number;
  readonly runtimeBackend?: RuntimeBackend;
  readonly transportConfig?: HostAgentTransportConfig;
}

class PayloadTooLargeError extends Error {
  public constructor() {
    super("IPC request payload exceeds maximum allowed size");
    this.name = "PayloadTooLargeError";
  }
}

function validateTransportConfig(config: HostAgentTransportConfig): {
  readonly mode: HostAgentTransportMode;
  readonly socketPath?: string;
  readonly socketMode?: number;
  readonly pipePath?: string;
} {
  const rawRecord = config as Record<string, unknown>;
  const mode = (rawRecord.transport ?? "uds") as string;

  if (mode !== "uds" && mode !== "pipe" && mode !== "loopback-test") {
    throw new HostPolicyDeniedError(
      `Unsupported IPC transport '${String(mode)}'; only uds, pipe, or loopback-test are permitted`,
    );
  }

  if (mode === "uds") {
    if (rawRecord.host !== undefined || rawRecord.port !== undefined) {
      throw new HostPolicyDeniedError("TCP host or port options are forbidden on UDS transport");
    }
    const socketPath =
      typeof rawRecord.socketPath === "string" && rawRecord.socketPath.length > 0
        ? rawRecord.socketPath
        : DEFAULT_HOST_AGENT_SOCKET_PATH;

    if (
      !socketPath.startsWith("/") ||
      socketPath.includes("..") ||
      /[\0\r\n]/.test(socketPath)
    ) {
      throw new HostPolicyDeniedError("Invalid Unix Domain Socket listener configuration");
    }

    const socketMode =
      typeof rawRecord.socketMode === "number"
        ? rawRecord.socketMode
        : DEFAULT_HOST_AGENT_SOCKET_MODE;

    return {
      mode: "uds",
      socketPath,
      socketMode,
    };
  }

  if (mode === "pipe") {
    if (rawRecord.host !== undefined || rawRecord.port !== undefined) {
      throw new HostPolicyDeniedError("TCP host or port options are forbidden on pipe transport");
    }
    const pipePath = rawRecord.pipePath;
    if (
      typeof pipePath !== "string" ||
      !pipePath.startsWith("\\\\.\\pipe\\") ||
      /[\0\r\n]/.test(pipePath)
    ) {
      throw new HostPolicyDeniedError("Invalid Windows Named Pipe listener configuration");
    }
    return {
      mode: "pipe",
      pipePath,
    };
  }

  // loopback-test mode: strictly 127.0.0.1 and ephemeral port 0
  const host = rawRecord.host ?? "127.0.0.1";
  const port = rawRecord.port ?? 0;

  if (host !== "127.0.0.1") {
    throw new HostPolicyDeniedError(
      "Refusing non-loopback IPC bind address; only 127.0.0.1 is permitted in loopback-test mode",
    );
  }

  if (port !== 0) {
    throw new HostPolicyDeniedError(
      "Refusing arbitrary fixed TCP port; loopback-test mode requires ephemeral port 0",
    );
  }

  return {
    mode: "loopback-test",
  };
}

function sendJsonResponse(res: ServerResponse, statusCode: number, payload: unknown): void {
  const serialized = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(serialized, "utf8")),
    "cache-control": "no-store",
  });
  res.end(serialized);
}

function sendErrorResponse(
  res: ServerResponse,
  statusCode: number,
  code: ErrorCode,
  message: string,
  requestId: string,
): void {
  sendJsonResponse(
    res,
    statusCode,
    createErrorEnvelope({
      code,
      message,
      requestId,
    }),
  );
}

async function readBoundedBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    totalBytes += buf.byteLength;
    if (totalBytes > MAX_IPC_BODY_BYTES) {
      throw new PayloadTooLargeError();
    }
    chunks.push(buf);
  }

  return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
}

function parseJsonObject(rawBody: Buffer): Record<string, unknown> | null {
  if (rawBody.byteLength === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export class HostAgentIpcServer {
  private readonly adapter: HealthCapableHostAdapter;
  private readonly keyring: IpcVerificationKeyring;
  private readonly nonceCache: IpcNonceReplayCache;
  private readonly maxClockSkewMs: number;
  private readonly nowProvider: () => number;
  private readonly runtimeBackend: RuntimeBackend;
  private readonly validatedTransport: ReturnType<typeof validateTransportConfig>;
  private server: http.Server | null = null;
  private boundEndpoint: HostAgentBoundEndpoint | null = null;

  public constructor(options: HostAgentIpcServerOptions) {
    this.adapter = options.adapter;
    this.keyring = options.keyring;
    this.nonceCache = options.nonceCache ?? new IpcNonceReplayCache();
    this.maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_IPC_MAX_CLOCK_SKEW_MS;
    this.nowProvider = options.nowProvider ?? (() => Date.now());
    this.runtimeBackend = options.runtimeBackend ?? "linux-systemd";
    this.validatedTransport = validateTransportConfig(
      options.transportConfig ?? { transport: "uds" },
    );
  }

  public getEndpoint(): HostAgentBoundEndpoint {
    if (!this.boundEndpoint) {
      throw new Error("HostAgentIpcServer has not been started");
    }
    return this.boundEndpoint;
  }

  public async start(): Promise<HostAgentBoundEndpoint> {
    if (this.server && this.boundEndpoint) {
      return this.boundEndpoint;
    }

    const httpServer = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    if (this.validatedTransport.mode === "uds") {
      const socketPath = this.validatedTransport.socketPath ?? DEFAULT_HOST_AGENT_SOCKET_PATH;
      const socketMode = this.validatedTransport.socketMode ?? DEFAULT_HOST_AGENT_SOCKET_MODE;

      await mkdir(dirname(socketPath), { recursive: true, mode: 0o750 });

      try {
        const existing = await lstat(socketPath);
        if (!existing.isSocket()) {
          throw new HostPolicyDeniedError(
            "Refusing to overwrite non-socket filesystem entry at IPC listener location",
          );
        }
        await unlink(socketPath);
      } catch (err) {
        if (err instanceof HostPolicyDeniedError) {
          throw err;
        }
        const code = (err as { code?: unknown }).code;
        if (code !== "ENOENT") {
          throw err;
        }
      }

      await new Promise<void>((resolveListen, rejectListen) => {
        httpServer.once("error", rejectListen);
        httpServer.listen(socketPath, () => {
          httpServer.off("error", rejectListen);
          resolveListen();
        });
      });

      await chmod(socketPath, socketMode);

      this.server = httpServer;
      this.boundEndpoint = Object.freeze({
        transport: "uds" as const,
        socketPath,
      });
      return this.boundEndpoint;
    }

    if (this.validatedTransport.mode === "pipe") {
      const pipePath = this.validatedTransport.pipePath!;
      await new Promise<void>((resolveListen, rejectListen) => {
        httpServer.once("error", rejectListen);
        httpServer.listen(pipePath, () => {
          httpServer.off("error", rejectListen);
          resolveListen();
        });
      });

      this.server = httpServer;
      this.boundEndpoint = Object.freeze({
        transport: "pipe" as const,
        pipePath,
      });
      return this.boundEndpoint;
    }

    // loopback-test mode
    await new Promise<void>((resolveListen, rejectListen) => {
      httpServer.once("error", rejectListen);
      httpServer.listen(0, "127.0.0.1", () => {
        httpServer.off("error", rejectListen);
        resolveListen();
      });
    });

    const address = httpServer.address() as AddressInfo | null;
    if (!address || typeof address.port !== "number") {
      httpServer.close();
      throw new Error("Failed to resolve ephemeral port for loopback-test IPC listener");
    }

    this.server = httpServer;
    this.boundEndpoint = Object.freeze({
      transport: "loopback-test" as const,
      host: "127.0.0.1" as const,
      port: address.port,
    });
    return this.boundEndpoint;
  }

  public async stop(): Promise<void> {
    const activeServer = this.server;
    const activeEndpoint = this.boundEndpoint;
    this.server = null;
    this.boundEndpoint = null;

    if (activeServer) {
      activeServer.closeAllConnections?.();
      await new Promise<void>((resolveClose) => {
        activeServer.close(() => resolveClose());
      });
    }

    if (activeEndpoint?.transport === "uds") {
      await unlink(activeEndpoint.socketPath).catch(() => undefined);
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = `req_${randomUUID()}`;
    const method = (req.method ?? "GET").toUpperCase();
    const pathWithQuery = req.url ?? "/";

    let rawBody: Buffer;
    try {
      rawBody = await readBoundedBody(req);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendErrorResponse(
          res,
          400,
          "VALIDATION_ERROR",
          "IPC request payload exceeds maximum size",
          requestId,
        );
        return;
      }
      sendErrorResponse(res, 400, "VALIDATION_ERROR", "Malformed IPC request stream", requestId);
      return;
    }

    const verification = verifyIpcRequest({
      method,
      pathWithQuery,
      headers: req.headers,
      body: rawBody,
      keyring: this.keyring,
      nonceCache: this.nonceCache,
      nowMs: this.nowProvider(),
      maxClockSkewMs: this.maxClockSkewMs,
    });

    if (!verification.ok) {
      sendErrorResponse(
        res,
        verification.statusCode,
        verification.code,
        verification.reason,
        requestId,
      );
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(pathWithQuery, "http://ipc.local");
    } catch {
      sendErrorResponse(res, 400, "VALIDATION_ERROR", "Invalid IPC request URL", requestId);
      return;
    }

    const pathname = parsedUrl.pathname;

    try {
      if (method === "GET" && pathname === "/v1/health") {
        const health = this.adapter.checkHealth
          ? await this.adapter.checkHealth()
          : HostAgentHealthResponseSchema.parse({
              component: "host_agent",
              status: this.adapter.isRuntimeAvailable ? "online" : "offline",
              version: HOST_AGENT_VERSION,
              runtimeBackend: this.runtimeBackend,
              checkedAt: new Date().toISOString(),
            });

        sendJsonResponse(res, 200, HostAgentHealthResponseSchema.parse(health));
        return;
      }

      if (method === "GET" && pathname === "/v1/telemetry") {
        const hostId = parsedUrl.searchParams.get("hostId")?.trim() ?? "";
        if (hostId.length === 0 || hostId.length > 128) {
          sendErrorResponse(
            res,
            400,
            "VALIDATION_ERROR",
            "Query parameter 'hostId' is required (1..128 characters)",
            requestId,
          );
          return;
        }

        if (!this.adapter.isRuntimeAvailable) {
          sendErrorResponse(
            res,
            422,
            "NOT_SUPPORTED",
            "Host telemetry runtime is disabled",
            requestId,
          );
          return;
        }

        const telemetry = await this.adapter.getHostTelemetry(hostId);
        if (!telemetry) {
          sendErrorResponse(
            res,
            404,
            "NOT_FOUND",
            `Telemetry not available for host '${hostId}'`,
            requestId,
          );
          return;
        }

        sendJsonResponse(res, 200, {
          data: HostTelemetryWireSchema.parse(telemetry),
        });
        return;
      }

      if (method === "POST" && pathname === "/v1/maintenance") {
        const bodyObj = parseJsonObject(rawBody);
        if (!bodyObj) {
          sendErrorResponse(
            res,
            400,
            "VALIDATION_ERROR",
            "Request body must be a valid JSON object",
            requestId,
          );
          return;
        }

        if (
          typeof bodyObj.action === "string" &&
          !isAllowlistedHostMaintenanceAction(bodyObj.action)
        ) {
          sendErrorResponse(
            res,
            403,
            "HOST_POLICY_DENIED",
            "Requested maintenance action is denied by static allowlist policy",
            requestId,
          );
          return;
        }

        const parsed = HostMaintenanceIpcRequestSchema.safeParse(bodyObj);
        if (!parsed.success) {
          sendErrorResponse(
            res,
            400,
            "VALIDATION_ERROR",
            "Invalid host maintenance IPC payload",
            requestId,
          );
          return;
        }

        const approved = createApprovedHostMaintenanceCommand({
          hostId: parsed.data.hostId,
          action: parsed.data.action,
          reason: parsed.data.reason,
        });

        const result = await this.adapter.executeMaintenance(approved);
        sendJsonResponse(res, 200, {
          data: {
            ...result,
            operationId: parsed.data.operationId ?? result.operationId,
          },
        });
        return;
      }

      if (method === "POST" && pathname === "/v1/security") {
        const bodyObj = parseJsonObject(rawBody);
        if (!bodyObj) {
          sendErrorResponse(
            res,
            400,
            "VALIDATION_ERROR",
            "Request body must be a valid JSON object",
            requestId,
          );
          return;
        }

        if (
          typeof bodyObj.policyRef === "string" &&
          !isAllowlistedHostSecurityPolicy(bodyObj.policyRef)
        ) {
          sendErrorResponse(
            res,
            403,
            "HOST_POLICY_DENIED",
            "Requested security policy is denied by static allowlist policy",
            requestId,
          );
          return;
        }

        const parsed = HostSecurityIpcRequestSchema.safeParse(bodyObj);
        if (!parsed.success) {
          sendErrorResponse(
            res,
            400,
            "VALIDATION_ERROR",
            "Invalid host security IPC payload",
            requestId,
          );
          return;
        }

        const approved = createApprovedHostSecurityCommand({
          hostId: parsed.data.hostId,
          policyRef: parsed.data.policyRef,
          reason: parsed.data.reason,
        });

        const result = await this.adapter.executeSecurityPolicy(approved);
        sendJsonResponse(res, 200, {
          data: {
            ...result,
            operationId: parsed.data.operationId ?? result.operationId,
          },
        });
        return;
      }

      sendErrorResponse(res, 404, "NOT_FOUND", "Unknown host-agent IPC endpoint", requestId);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === "HOST_POLICY_DENIED" || err instanceof HostPolicyDeniedError) {
        sendErrorResponse(
          res,
          403,
          "HOST_POLICY_DENIED",
          err instanceof Error ? err.message : "Host policy denied operation",
          requestId,
        );
        return;
      }
      if (code === "NOT_SUPPORTED") {
        sendErrorResponse(
          res,
          422,
          "NOT_SUPPORTED",
          err instanceof Error ? err.message : "Operation not supported",
          requestId,
        );
        return;
      }

      sendErrorResponse(
        res,
        500,
        "INTERNAL_ERROR",
        "Internal host-agent execution error",
        requestId,
      );
    }
  }
}

export function createHostAgentIpcServer(options: HostAgentIpcServerOptions): HostAgentIpcServer {
  return new HostAgentIpcServer(options);
}
