import http from "node:http";
import {
  ApiErrorEnvelopeSchema,
  ErrorCodeSchema,
  ExecutorHealthResponseSchema,
  ObservedServiceStateWireSchema,
  signIpcRequest,
  type DeployServiceIpcRequest,
  type ErrorCode,
  type ExecutorHealthResponse,
  type IpcSigningKey,
  type ObservedServiceStateWire,
  type ServiceInstanceActionIpcRequest,
} from "@hosting-panel/contracts";
import type {
  ApprovedServiceSpec,
  DockerExecutionResult,
  DockerExecutorPort,
} from "@hosting-panel/executor-contracts";
import { z } from "zod";
import {
  DEFAULT_EXECUTOR_SOCKET_PATH,
  type IpcTransportMode,
} from "./server.js";
import { ExecutorCodedError, assertSafeIdentifier } from "./traefik-config.js";

const ExecutionResultDataEnvelopeSchema = z.object({
  data: z.object({
    operationId: z.string().min(1),
    status: z.enum([
      "queued",
      "processing",
      "accepted",
      "reconciling",
      "succeeded",
      "failed",
      "unknown",
      "cancelled",
    ]),
    message: z.string().optional(),
    internalDockerRef: z.string().optional(),
    containerStatus: z.enum(["running", "stopped"]).optional(),
    ingressConfigured: z.boolean().optional(),
  }),
});

const ObservedStateDataEnvelopeSchema = z.object({
  data: ObservedServiceStateWireSchema.nullable(),
});

const IngressEnsureDataEnvelopeSchema = z.object({
  data: z.object({
    component: z.literal("ingress_proxy"),
    status: z.literal("running"),
    ensuredAt: z.string().datetime({ offset: true }),
  }),
});

export class ExecutorIpcClientError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly ambiguousOutcome: boolean;

  public constructor(
    message: string,
    code: ErrorCode,
    statusCode: number,
    ambiguousOutcome: boolean = false,
  ) {
    super(message);
    this.name = "ExecutorIpcClientError";
    this.code = code;
    this.statusCode = statusCode;
    this.ambiguousOutcome = ambiguousOutcome;
  }
}

export interface SignedDockerExecutorIpcClientOptions {
  readonly signingKey: IpcSigningKey;
  readonly transport?: IpcTransportMode;
  readonly socketPath?: string;
  readonly host?: string;
  readonly port?: number;
  readonly timeoutMs?: number;
  readonly isRuntimeAvailable?: boolean;
}

export class SignedDockerExecutorIpcClient implements DockerExecutorPort {
  public readonly isRuntimeAvailable: boolean;
  private readonly signingKey: IpcSigningKey;
  private readonly transport: IpcTransportMode;
  private readonly socketPath?: string;
  private readonly port?: number;
  private readonly timeoutMs: number;

  public constructor(options: SignedDockerExecutorIpcClientOptions) {
    const transport = options.transport ?? "uds";
    if (transport !== "uds" && transport !== "pipe" && transport !== "loopback-test") {
      throw new ExecutorCodedError(
        "Unsupported IPC client transport mode",
        "HOST_POLICY_DENIED",
      );
    }

    if (transport === "uds") {
      if (options.host !== undefined || options.port !== undefined) {
        throw new ExecutorCodedError(
          "TCP host/port is forbidden for uds IPC client",
          "HOST_POLICY_DENIED",
        );
      }
      const socketPath = options.socketPath ?? DEFAULT_EXECUTOR_SOCKET_PATH;
      if (!socketPath.startsWith("/") || socketPath.includes("..") || socketPath.includes("\0")) {
        throw new ExecutorCodedError(
          "Invalid Unix Domain Socket path for IPC client",
          "HOST_POLICY_DENIED",
        );
      }
      this.socketPath = socketPath;
    } else if (transport === "pipe") {
      if (!options.socketPath || !/^\\\\\.\\pipe\\[a-zA-Z0-9._-]+$/.test(options.socketPath)) {
        throw new ExecutorCodedError(
          "Invalid Named Pipe path for IPC client",
          "HOST_POLICY_DENIED",
        );
      }
      this.socketPath = options.socketPath;
    } else {
      if (options.host !== undefined && options.host !== "127.0.0.1") {
        throw new ExecutorCodedError(
          "Loopback IPC client only permits host 127.0.0.1",
          "HOST_POLICY_DENIED",
        );
      }
      if (
        typeof options.port !== "number" ||
        !Number.isInteger(options.port) ||
        options.port < 1 ||
        options.port > 65535
      ) {
        throw new ExecutorCodedError(
          "Loopback IPC client requires a valid bound loopback port",
          "VALIDATION_ERROR",
        );
      }
      this.port = options.port;
    }

    this.transport = transport;
    this.signingKey = options.signingKey;
    this.timeoutMs = options.timeoutMs ?? 35_000;
    this.isRuntimeAvailable = options.isRuntimeAvailable ?? true;
  }

  public async checkHealth(): Promise<ExecutorHealthResponse> {
    const json = await this.sendSignedJsonRequest("GET", "/v1/health");
    return ExecutorHealthResponseSchema.parse(json);
  }

  public async ensureIngressProxy(): Promise<{
    readonly component: "ingress_proxy";
    readonly status: "running";
    readonly ensuredAt: string;
  }> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/ingress/ensure", {});
    return IngressEnsureDataEnvelopeSchema.parse(json).data;
  }

  public async deployService(spec: ApprovedServiceSpec): Promise<DockerExecutionResult> {
    const rawRecord = spec as unknown as Record<string, unknown>;
    const {
      resolvedSecrets: _rs,
      __brand: _brand,
      ...extraConfig
    } = rawRecord;

    const payload: DeployServiceIpcRequest = {
      spec: {
        ...(extraConfig as Record<string, unknown>),
        serviceInstanceId: spec.serviceInstanceId,
        siteId: spec.siteId,
        organizationId: spec.organizationId,
        image: spec.image,
        containerName: spec.containerName,
        env: { ...spec.env },
        portBindings: spec.portBindings.map((pb) => ({ ...pb })),
        resourceLimits: spec.resourceLimits ? { ...spec.resourceLimits } : null,
        ...(spec.revisionNumber !== undefined ? { revisionNumber: spec.revisionNumber } : {}),
        ...(spec.specHash !== undefined ? { specHash: spec.specHash } : {}),
        ...(spec.domains !== undefined ? { domains: [...spec.domains] } : {}),
        ...(spec.exposeHttp !== undefined ? { exposeHttp: spec.exposeHttp } : {}),
        ...(spec.internalPort !== undefined ? { internalPort: spec.internalPort } : {}),
        ...(spec.pidsLimit !== undefined ? { pidsLimit: spec.pidsLimit } : {}),
        ...(spec.volumeMounts !== undefined
          ? { volumeMounts: spec.volumeMounts.map((m) => ({ ...m })) }
          : {}),
        ...(spec.resolvedSecrets !== undefined
          ? { resolvedSecrets: { ...spec.resolvedSecrets } }
          : {}),
        ...(spec.approvedAt ? { approvedAt: spec.approvedAt } : {}),
      } as DeployServiceIpcRequest["spec"],
    };

    const json = await this.sendSignedJsonRequest("POST", "/v1/services/deploy", payload);
    return ExecutionResultDataEnvelopeSchema.parse(json).data;
  }

  public async restartService(serviceInstanceId: string): Promise<DockerExecutionResult> {
    return this.sendServiceAction(serviceInstanceId, "restart");
  }

  public async stopService(serviceInstanceId: string): Promise<DockerExecutionResult> {
    return this.sendServiceAction(serviceInstanceId, "stop");
  }

  public async deleteService(serviceInstanceId: string): Promise<DockerExecutionResult> {
    return this.sendServiceAction(serviceInstanceId, "delete");
  }

  public async getObservedState(
    serviceInstanceId: string,
  ): Promise<ObservedServiceStateWire | null> {
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    const pathWithQuery = `/v1/services/${encodeURIComponent(serviceInstanceId)}/observed-state`;
    const json = await this.sendSignedJsonRequest("GET", pathWithQuery);
    return ObservedStateDataEnvelopeSchema.parse(json).data;
  }

  private async sendServiceAction(
    serviceInstanceId: string,
    action: "restart" | "stop" | "delete",
  ): Promise<DockerExecutionResult> {
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    const payload: ServiceInstanceActionIpcRequest = {
      serviceInstanceId,
      action,
    };
    const json = await this.sendSignedJsonRequest("POST", "/v1/services/action", payload);
    return ExecutionResultDataEnvelopeSchema.parse(json).data;
  }

  private async sendSignedJsonRequest(
    method: "GET" | "POST",
    pathWithQuery: string,
    bodyObject?: unknown,
  ): Promise<unknown> {
    const bodyBuffer =
      bodyObject !== undefined ? Buffer.from(JSON.stringify(bodyObject), "utf8") : undefined;

    const signedHeaders = signIpcRequest({
      method,
      pathWithQuery,
      body: bodyBuffer ?? null,
      key: this.signingKey,
    });

    const headers: Record<string, string | number> = {
      ...signedHeaders,
      Accept: "application/json",
      Host: "hp-executor.internal",
    };

    if (bodyBuffer !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      headers["Content-Length"] = bodyBuffer.length;
    }

    const response = await new Promise<{ statusCode: number; body: Buffer }>((resolve, reject) => {
      const isMutating = method !== "GET";
      let socketConnected = false;
      let writeStarted = false;
      let timedOut = false;
      let settled = false;

      const rejectOnce = (err: ExecutorIpcClientError): void => {
        if (settled) {
          return;
        }
        settled = true;
        reject(err);
      };

      const requestOptions: http.RequestOptions =
        this.transport === "loopback-test"
          ? {
              host: "127.0.0.1",
              port: this.port,
              path: pathWithQuery,
              method,
              headers,
              timeout: this.timeoutMs,
            }
          : {
              socketPath: this.socketPath,
              path: pathWithQuery,
              method,
              headers,
              timeout: this.timeoutMs,
            };

      const req = http.request(requestOptions, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer | string) => {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        });
        res.on("end", () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve({
            statusCode: res.statusCode ?? 500,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", () => {
          rejectOnce(
            isMutating
              ? new ExecutorIpcClientError(
                  "IPC response stream dropped after mutating command was dispatched to docker-executor",
                  "OPERATION_AMBIGUOUS",
                  502,
                  true,
                )
              : new ExecutorIpcClientError(
                  "Failed while reading IPC response from docker-executor daemon",
                  "DOCKER_ENGINE_UNAVAILABLE",
                  503,
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
        req.destroy();
        rejectOnce(
          isMutating && (socketConnected || writeStarted)
            ? new ExecutorIpcClientError(
                "Timed out waiting for docker-executor IPC response after mutating command dispatch",
                "OPERATION_AMBIGUOUS",
                502,
                true,
              )
            : new ExecutorIpcClientError(
                "Timed out waiting for docker-executor IPC response",
                "DOCKER_ENGINE_UNAVAILABLE",
                503,
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
            new ExecutorIpcClientError(
              "Connection to docker-executor IPC daemon dropped after mutating command dispatch",
              "OPERATION_AMBIGUOUS",
              502,
              true,
            ),
          );
          return;
        }
        rejectOnce(
          new ExecutorIpcClientError(
            "Docker executor IPC daemon is unreachable",
            "DOCKER_ENGINE_UNAVAILABLE",
            503,
            false,
          ),
        );
      });

      writeStarted = true;
      if (bodyBuffer !== undefined) {
        req.write(bodyBuffer);
      }
      req.end();
    });

    const rawText = response.body.toString("utf8");
    let parsedJson: unknown = null;
    if (rawText.trim().length > 0) {
      try {
        parsedJson = JSON.parse(rawText) as unknown;
      } catch {
        throw new ExecutorIpcClientError(
          "Received non-JSON payload from docker-executor daemon",
          "INTERNAL_ERROR",
          response.statusCode,
        );
      }
    }

    if (response.statusCode >= 400) {
      const parsedError = ApiErrorEnvelopeSchema.safeParse(parsedJson);
      if (parsedError.success) {
        throw new ExecutorIpcClientError(
          parsedError.data.error.message,
          parsedError.data.error.code,
          response.statusCode,
        );
      }
      const fallbackCode: ErrorCode =
        response.statusCode === 401
          ? "UNAUTHENTICATED"
          : response.statusCode === 403
            ? "HOST_POLICY_DENIED"
            : response.statusCode === 404
              ? "NOT_FOUND"
              : response.statusCode === 409
                ? "IDEMPOTENCY_CONFLICT"
                : ErrorCodeSchema.parse("INTERNAL_ERROR");
      throw new ExecutorIpcClientError(
        `Executor IPC request failed with HTTP ${String(response.statusCode)}`,
        fallbackCode,
        response.statusCode,
      );
    }

    return parsedJson;
  }
}
