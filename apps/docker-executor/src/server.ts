import { randomUUID } from "node:crypto";
import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  CertificateStatusIpcRequestSchema,
  DeployServiceIpcRequestSchema,
  ERROR_CODE_HTTP_STATUS,
  ErrorCodeSchema,
  ExecutorHealthResponseSchema,
  IpcNonceReplayCache,
  ObservedServiceStateWireSchema,
  ServiceInstanceActionIpcRequestSchema,
  ServiceLogsIpcRequestSchema,
  SiteJobIpcRequestSchema,
  SitePurgeIpcRequestSchema,
  SiteRoutesIpcRequestSchema,
  createErrorEnvelope,
  findPlaintextSecretKeys,
  findUnsafeDockerInputFields,
  redactSensitiveString,
  validateServiceVolumeMount,
  verifyIpcRequest,
  type ErrorCode,
  type ExecutorHealthResponse,
  type IpcVerificationKeyring,
  type RuntimeBackend,
  type ServiceVolumeMountSpec,
} from "@hosting-panel/contracts";
import {
  createApprovedServiceSpec,
  type DockerExecutionResult,
  type DockerExecutorPort,
} from "@hosting-panel/executor-contracts";
import { z } from "zod";
import { ExecutorCodedError, assertSafeIdentifier } from "./traefik-config.js";

export const DEFAULT_EXECUTOR_SOCKET_PATH = "/run/hosting-panel/executor.sock" as const;
export const DEFAULT_EXECUTOR_SOCKET_MODE = 0o660 as const;
export const DEFAULT_EXECUTOR_VERSION = "0.2.0" as const;
const MAX_IPC_BODY_BYTES = 1_048_576;
const WINDOWS_NAMED_PIPE_PATTERN = /^\\\\\.\\pipe\\[a-zA-Z0-9._-]+$/;

export type IpcTransportMode = "uds" | "pipe" | "loopback-test";

export interface IngressCapableDockerExecutor extends DockerExecutorPort {
  pingEngine?(): Promise<boolean>;
  ensureIngressProxy?(): Promise<{
    readonly component: "ingress_proxy";
    readonly status: "running";
    readonly ensuredAt: string;
  }>;
}

export interface DockerExecutorIpcServerOptions {
  readonly executor: IngressCapableDockerExecutor;
  readonly keyring: IpcVerificationKeyring;
  readonly nonceCache?: IpcNonceReplayCache;
  readonly transport?: IpcTransportMode;
  readonly socketPath?: string;
  readonly socketMode?: number;
  readonly host?: string;
  readonly port?: number;
  readonly runtimeBackend?: RuntimeBackend;
  readonly version?: string;
  readonly maxClockSkewMs?: number;
  readonly nowMs?: () => number;
}

export interface BoundExecutorEndpoint {
  readonly transport: IpcTransportMode;
  readonly socketPath?: string;
  readonly host?: string;
  readonly port?: number;
}

function validateTransportOptions(options: DockerExecutorIpcServerOptions): {
  readonly transport: IpcTransportMode;
  readonly socketPath?: string;
  readonly socketMode: number;
} {
  const transport = options.transport ?? "uds";
  if (transport !== "uds" && transport !== "pipe" && transport !== "loopback-test") {
    throw new ExecutorCodedError(
      "Unsupported IPC transport mode; must be 'uds', 'pipe', or 'loopback-test'",
      "HOST_POLICY_DENIED",
    );
  }

  const socketMode = options.socketMode ?? DEFAULT_EXECUTOR_SOCKET_MODE;

  if (transport === "uds") {
    if (options.host !== undefined || options.port !== undefined) {
      throw new ExecutorCodedError(
        "TCP host/port binding is strictly forbidden in Unix Domain Socket transport mode (AC-F2-01)",
        "HOST_POLICY_DENIED",
      );
    }
    const socketPath = options.socketPath ?? DEFAULT_EXECUTOR_SOCKET_PATH;
    if (
      !socketPath.startsWith("/") ||
      socketPath.includes("\0") ||
      socketPath.includes("..") ||
      socketPath.startsWith("//")
    ) {
      throw new ExecutorCodedError(
        "Unix Domain Socket path must be a normalized absolute POSIX path",
        "HOST_POLICY_DENIED",
      );
    }
    return { transport, socketPath, socketMode };
  }

  if (transport === "pipe") {
    if (options.host !== undefined || options.port !== undefined) {
      throw new ExecutorCodedError(
        "TCP host/port binding is strictly forbidden in Named Pipe transport mode (AC-F2-01)",
        "HOST_POLICY_DENIED",
      );
    }
    const pipePath = options.socketPath ?? "";
    if (!WINDOWS_NAMED_PIPE_PATTERN.test(pipePath)) {
      throw new ExecutorCodedError(
        "Named Pipe path must match \\\\.\\pipe\\<identifier>",
        "HOST_POLICY_DENIED",
      );
    }
    return { transport, socketPath: pipePath, socketMode };
  }

  // transport === "loopback-test"
  if (options.socketPath !== undefined) {
    throw new ExecutorCodedError(
      "socketPath cannot be combined with loopback-test transport",
      "HOST_POLICY_DENIED",
    );
  }
  if (options.host !== undefined && options.host !== "127.0.0.1") {
    throw new ExecutorCodedError(
      `Refusing to bind non-loopback address '${options.host.slice(0, 32)}'; only 127.0.0.1:0 is permitted in loopback-test mode (AC-F2-01)`,
      "HOST_POLICY_DENIED",
    );
  }
  if (options.port !== undefined && options.port !== 0) {
    throw new ExecutorCodedError(
      "Refusing to bind fixed TCP port; only ephemeral 127.0.0.1:0 is permitted in loopback-test mode (AC-F2-01)",
      "HOST_POLICY_DENIED",
    );
  }

  return { transport, socketMode };
}

class RequestPayloadTooLargeError extends Error {
  public constructor() {
    super("IPC request body exceeds maximum allowed size");
    this.name = "RequestPayloadTooLargeError";
  }
}

function readRawRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer | string) => {
      if (aborted) {
        return;
      }
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        aborted = true;
        reject(new RequestPayloadTooLargeError());
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => {
      if (!aborted) {
        resolve(Buffer.concat(chunks));
      }
    });

    req.on("error", (err) => {
      if (!aborted) {
        reject(err);
      }
    });
  });
}

function writeJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const serialized = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": serialized.length,
    "Cache-Control": "no-store",
  });
  res.end(serialized);
}

export class DockerExecutorIpcServer {
  private readonly executor: IngressCapableDockerExecutor;
  private readonly keyring: IpcVerificationKeyring;
  private readonly nonceCache: IpcNonceReplayCache;
  private readonly transport: IpcTransportMode;
  private readonly configuredSocketPath?: string;
  private readonly socketMode: number;
  private readonly runtimeBackend: RuntimeBackend;
  private readonly version: string;
  private readonly maxClockSkewMs?: number;
  private readonly nowMs?: () => number;
  private readonly server: http.Server;
  private boundEndpoint: BoundExecutorEndpoint | null = null;

  public constructor(options: DockerExecutorIpcServerOptions) {
    const validatedTransport = validateTransportOptions(options);
    this.executor = options.executor;
    this.keyring = options.keyring;
    this.nonceCache = options.nonceCache ?? new IpcNonceReplayCache();
    this.transport = validatedTransport.transport;
    this.configuredSocketPath = validatedTransport.socketPath;
    this.socketMode = validatedTransport.socketMode;
    this.runtimeBackend = options.runtimeBackend ?? "linux-systemd";
    this.version = options.version ?? DEFAULT_EXECUTOR_VERSION;
    this.maxClockSkewMs = options.maxClockSkewMs;
    this.nowMs = options.nowMs;

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
  }

  public getBoundEndpoint(): BoundExecutorEndpoint | null {
    return this.boundEndpoint;
  }

  public async start(): Promise<BoundExecutorEndpoint> {
    if (this.boundEndpoint) {
      return this.boundEndpoint;
    }

    if (this.transport === "uds") {
      const socketPath = this.configuredSocketPath ?? DEFAULT_EXECUTOR_SOCKET_PATH;
      await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o750 });
      try {
        const existingStat = await stat(socketPath);
        if (!existingStat.isSocket()) {
          throw new ExecutorCodedError(
            "Refusing to overwrite non-socket file at configured IPC socket path",
            "HOST_POLICY_DENIED",
          );
        }
        await unlink(socketPath);
      } catch (err) {
        if (err instanceof ExecutorCodedError) {
          throw err;
        }
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }

      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          this.server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          this.server.off("error", onError);
          resolve();
        };
        this.server.once("error", onError);
        this.server.once("listening", onListening);
        this.server.listen(socketPath);
      });

      await chmod(socketPath, this.socketMode);
      this.boundEndpoint = Object.freeze({
        transport: "uds",
        socketPath,
      });
      return this.boundEndpoint;
    }

    if (this.transport === "pipe") {
      const pipePath = this.configuredSocketPath ?? "";
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          this.server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          this.server.off("error", onError);
          resolve();
        };
        this.server.once("error", onError);
        this.server.once("listening", onListening);
        this.server.listen(pipePath);
      });

      this.boundEndpoint = Object.freeze({
        transport: "pipe",
        socketPath: pipePath,
      });
      return this.boundEndpoint;
    }

    // loopback-test -> strictly 127.0.0.1:0
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(0, "127.0.0.1");
    });

    const address = this.server.address() as AddressInfo | null;
    if (!address || typeof address.port !== "number") {
      throw new ExecutorCodedError(
        "Failed to resolve ephemeral loopback port",
        "INTERNAL_ERROR",
      );
    }

    this.boundEndpoint = Object.freeze({
      transport: "loopback-test",
      host: "127.0.0.1",
      port: address.port,
    });
    return this.boundEndpoint;
  }

  public async stop(): Promise<void> {
    const endpoint = this.boundEndpoint;
    this.boundEndpoint = null;

    if (this.server.listening) {
      await new Promise<void>((resolve, reject) => {
        this.server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }

    if (endpoint?.transport === "uds" && endpoint.socketPath) {
      await unlink(endpoint.socketPath).catch(() => undefined);
    }
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const requestId = `ipc_req_${randomUUID()}`;
    const method = (req.method ?? "GET").toUpperCase();
    const rawUrl = req.url ?? "/";

    let rawBody: Buffer;
    try {
      rawBody = await readRawRequestBody(req, MAX_IPC_BODY_BYTES);
    } catch (err) {
      if (err instanceof RequestPayloadTooLargeError) {
        writeJson(
          res,
          400,
          createErrorEnvelope({
            code: "VALIDATION_ERROR",
            message: err.message,
            requestId,
          }),
        );
        return;
      }
      writeJson(
        res,
        400,
        createErrorEnvelope({
          code: "VALIDATION_ERROR",
          message: "Failed to read IPC request body",
          requestId,
        }),
      );
      return;
    }

    const verification = verifyIpcRequest({
      method,
      pathWithQuery: rawUrl,
      headers: req.headers,
      body: rawBody,
      keyring: this.keyring,
      nonceCache: this.nonceCache,
      ...(this.maxClockSkewMs !== undefined ? { maxClockSkewMs: this.maxClockSkewMs } : {}),
      ...(this.nowMs !== undefined ? { nowMs: this.nowMs() } : {}),
    });

    if (!verification.ok) {
      writeJson(
        res,
        verification.statusCode,
        createErrorEnvelope({
          code: verification.code,
          message: verification.reason,
          requestId,
        }),
      );
      return;
    }

    const parsedUrl = new URL(rawUrl, "http://hp-executor.internal");
    const pathname = parsedUrl.pathname;

    try {
      if (method === "GET" && pathname === "/v1/health") {
        const health = await this.buildHealthResponse();
        writeJson(res, 200, health);
        return;
      }

      if (method === "POST" && pathname === "/v1/services/deploy") {
        const result = await this.handleDeployService(rawBody);
        writeJson(res, 200, { data: result });
        return;
      }

      if (method === "POST" && pathname === "/v1/services/action") {
        const result = await this.handleServiceAction(rawBody);
        writeJson(res, 200, { data: result });
        return;
      }

      if (method === "POST" && pathname === "/v1/jobs/run") {
        const req = this.parseBody(SiteJobIpcRequestSchema, rawBody, "site job");
        const result = await this.executor.runSiteJob(req);
        writeJson(res, 200, { data: result });
        return;
      }

      if (method === "POST" && pathname === "/v1/sites/purge") {
        const { siteId } = this.parseBody(SitePurgeIpcRequestSchema, rawBody, "site purge");
        assertSafeIdentifier(siteId, "siteId");
        await this.executor.purgeSite(siteId);
        writeJson(res, 200, { data: { siteId } });
        return;
      }

      if (method === "POST" && pathname === "/v1/sites/routes") {
        const req = this.parseBody(SiteRoutesIpcRequestSchema, rawBody, "site routes");
        assertSafeIdentifier(req.siteId, "siteId");
        assertSafeIdentifier(req.serviceInstanceId, "serviceInstanceId");
        await this.executor.applySiteRoutes(req);
        writeJson(res, 200, { data: { siteId: req.siteId } });
        return;
      }

      if (method === "POST" && pathname === "/v1/ingress/certificates") {
        const req = this.parseBody(CertificateStatusIpcRequestSchema, rawBody, "certificate status");
        writeJson(res, 200, { data: await this.executor.getCertificateStatus(req) });
        return;
      }

      if (method === "POST" && pathname === "/v1/services/logs") {
        const { serviceInstanceId, tail } = this.parseBody(
          ServiceLogsIpcRequestSchema,
          rawBody,
          "service logs",
        );
        assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
        const lines = await this.executor.getServiceLogs(serviceInstanceId, tail);
        writeJson(res, 200, { data: lines });
        return;
      }

      const observedMatch = /^\/v1\/services\/([^/]+)\/observed-state$/.exec(pathname);
      if (method === "GET" && observedMatch && observedMatch[1]) {
        const serviceInstanceId = decodeURIComponent(observedMatch[1]);
        assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
        const state = await this.executor.getObservedState(serviceInstanceId);
        if (state === null) {
          writeJson(res, 200, { data: null });
          return;
        }
        const observedAtIso =
          state.observedAt instanceof Date
            ? state.observedAt.toISOString()
            : typeof state.observedAt === "string"
              ? state.observedAt
              : new Date().toISOString();
        const extraState = state as unknown as Record<string, unknown>;
        const validatedWire = ObservedServiceStateWireSchema.parse({
          serviceInstanceId,
          observedStatus: state.observedStatus,
          observedRevisionHash: state.observedRevisionHash ?? null,
          outOfBandModified: Boolean(state.outOfBandModified),
          observedAt: observedAtIso,
          ...(typeof extraState.restartCount === "number"
            ? { restartCount: extraState.restartCount }
            : {}),
          ...(typeof extraState.internalDockerRef === "string"
            ? { internalDockerRef: extraState.internalDockerRef }
            : {}),
        });
        writeJson(res, 200, { data: validatedWire });
        return;
      }

      if (method === "POST" && pathname === "/v1/ingress/ensure") {
        if (!this.executor.ensureIngressProxy) {
          throw new ExecutorCodedError(
            "Ingress proxy management is not supported by active executor backend",
            "NOT_SUPPORTED",
          );
        }
        const ensured = await this.executor.ensureIngressProxy();
        writeJson(res, 200, { data: ensured });
        return;
      }

      writeJson(
        res,
        404,
        createErrorEnvelope({
          code: "NOT_FOUND",
          message: `Unknown executor IPC route: ${method} ${pathname}`,
          requestId,
        }),
      );
    } catch (err) {
      const { statusCode, errorCode, safeMessage } = this.classifyError(err);
      writeJson(
        res,
        statusCode,
        createErrorEnvelope({
          code: errorCode,
          message: safeMessage,
          requestId,
        }),
      );
    }
  }

  private async buildHealthResponse(): Promise<ExecutorHealthResponse> {
    const dockerEngineReachable = this.executor.pingEngine
      ? await this.executor.pingEngine()
      : this.executor.isRuntimeAvailable;

    return ExecutorHealthResponseSchema.parse({
      component: "docker_executor",
      status: dockerEngineReachable ? "online" : "degraded",
      version: this.version,
      runtimeBackend: this.runtimeBackend,
      dockerEngineReachable,
      checkedAt: new Date().toISOString(),
    });
  }

  private parseJsonBody(rawBody: Buffer): unknown {
    const text = rawBody.toString("utf8").trim();
    if (text.length === 0) {
      throw new ExecutorCodedError("Request JSON body must not be empty", "VALIDATION_ERROR");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ExecutorCodedError("Malformed JSON request body", "VALIDATION_ERROR");
    }
  }

  private parseBody<S extends z.ZodType>(schema: S, rawBody: Buffer, what: string): z.infer<S> {
    const parsed = schema.safeParse(this.parseJsonBody(rawBody));
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw new ExecutorCodedError(
        firstIssue ? `Invalid ${what} payload: ${firstIssue.message}` : `Invalid ${what} payload`,
        "VALIDATION_ERROR",
      );
    }
    return parsed.data;
  }

  private async handleDeployService(rawBody: Buffer): Promise<DockerExecutionResult> {
    const parsedJson = this.parseJsonBody(rawBody);

    let rawDeclarativeSpec: Record<string, unknown> = {};
    if (
      parsedJson !== null &&
      typeof parsedJson === "object" &&
      "spec" in parsedJson &&
      parsedJson.spec !== null &&
      typeof parsedJson.spec === "object" &&
      !Array.isArray(parsedJson.spec)
    ) {
      const { resolvedSecrets: _rs, ...restSpec } = parsedJson.spec as Record<string, unknown>;
      rawDeclarativeSpec = restSpec;

      const unsafeFields = findUnsafeDockerInputFields(rawDeclarativeSpec);
      if (unsafeFields.length > 0) {
        throw new ExecutorCodedError(
          `Unsafe Docker input fields rejected: ${unsafeFields.join(", ")}`,
          "HOST_POLICY_DENIED",
        );
      }

      const plaintextSecrets = findPlaintextSecretKeys(rawDeclarativeSpec);
      if (plaintextSecrets.length > 0) {
        throw new ExecutorCodedError(
          `Plaintext secrets in declarative spec rejected: ${plaintextSecrets.join(", ")}`,
          "HOST_POLICY_DENIED",
        );
      }

      if (Array.isArray(rawDeclarativeSpec.volumeMounts)) {
        for (const candidateMount of rawDeclarativeSpec.volumeMounts) {
          if (candidateMount && typeof candidateMount === "object") {
            const check = validateServiceVolumeMount(candidateMount as ServiceVolumeMountSpec);
            if (!check.valid) {
              throw new ExecutorCodedError(check.reason, "HOST_POLICY_DENIED");
            }
          }
        }
      }

      if (typeof rawDeclarativeSpec.pidsLimit === "number") {
        if (
          !Number.isInteger(rawDeclarativeSpec.pidsLimit) ||
          rawDeclarativeSpec.pidsLimit < 16 ||
          rawDeclarativeSpec.pidsLimit > 4096
        ) {
          throw new ExecutorCodedError(
            "pidsLimit must be an integer between 16 and 4096",
            "HOST_POLICY_DENIED",
          );
        }
      }
    }

    const parsed = DeployServiceIpcRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw new ExecutorCodedError(
        firstIssue ? `Invalid deploy payload: ${firstIssue.message}` : "Invalid deploy payload",
        "VALIDATION_ERROR",
      );
    }

    const wireSpec = parsed.data.spec;
    const approvedSpec = createApprovedServiceSpec({
      serviceInstanceId: wireSpec.serviceInstanceId,
      siteId: wireSpec.siteId,
      organizationId: wireSpec.organizationId,
      image: wireSpec.image,
      containerName: wireSpec.containerName,
      env: wireSpec.env,
      portBindings: wireSpec.portBindings,
      resourceLimits: wireSpec.resourceLimits,
      revisionNumber: wireSpec.revisionNumber,
      specHash: wireSpec.specHash,
      domains: wireSpec.domains,
      hostRoutes: wireSpec.hostRoutes,
      exposeHttp: wireSpec.exposeHttp,
      siteMail: wireSpec.siteMail,
      internalPort: wireSpec.internalPort,
      pidsLimit: wireSpec.pidsLimit,
      volumeMounts: wireSpec.volumeMounts,
      resolvedSecrets: wireSpec.resolvedSecrets,
      rawConfig: rawDeclarativeSpec,
    });

    const result = await this.executor.deployService(approvedSpec);
    if (parsed.data.operationId) {
      return {
        ...result,
        operationId: parsed.data.operationId,
      };
    }
    return result;
  }

  private async handleServiceAction(rawBody: Buffer): Promise<DockerExecutionResult> {
    const parsedJson = this.parseJsonBody(rawBody);
    const parsed = ServiceInstanceActionIpcRequestSchema.safeParse(parsedJson);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw new ExecutorCodedError(
        firstIssue ? `Invalid service action payload: ${firstIssue.message}` : "Invalid action payload",
        "VALIDATION_ERROR",
      );
    }

    const { serviceInstanceId, action, operationId } = parsed.data;
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");

    let result: DockerExecutionResult;
    if (action === "restart") {
      result = await this.executor.restartService(serviceInstanceId);
    } else if (action === "stop") {
      result = await this.executor.stopService(serviceInstanceId);
    } else {
      result = await this.executor.deleteService(serviceInstanceId);
    }

    if (operationId) {
      return {
        ...result,
        operationId,
      };
    }
    return result;
  }

  private classifyError(err: unknown): {
    readonly statusCode: number;
    readonly errorCode: ErrorCode;
    readonly safeMessage: string;
  } {
    const rawCode = (err as { code?: unknown } | null)?.code;
    const parsedCode = ErrorCodeSchema.safeParse(rawCode);
    const errorCode: ErrorCode = parsedCode.success ? parsedCode.data : "INTERNAL_ERROR";
    const statusCode = ERROR_CODE_HTTP_STATUS[errorCode];

    if (errorCode === "INTERNAL_ERROR") {
      return {
        statusCode,
        errorCode,
        safeMessage: "Internal executor daemon failure",
      };
    }

    const rawMessage = err instanceof Error ? err.message : "Executor request failed";
    return {
      statusCode,
      errorCode,
      safeMessage: redactSensitiveString(rawMessage).slice(0, 512) || "Executor request failed",
    };
  }
}

export function createDockerExecutorIpcServer(
  options: DockerExecutorIpcServerOptions,
): DockerExecutorIpcServer {
  return new DockerExecutorIpcServer(options);
}
