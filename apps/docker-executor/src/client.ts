import http from "node:http";
import {
  ApiErrorEnvelopeSchema,
  AppStackComponentActionIpcResultSchema,
  AppStackComponentsRemoveIpcResultSchema,
  AppStackCreateIpcResultSchema,
  AppStackImageResolveIpcResultSchema,
  AppStackLogsIpcResultSchema,
  AppStackPrepareIpcResultSchema,
  AppStackPullIpcResultSchema,
  AppStackRemoveIpcResultSchema,
  AppStackRoutesIpcResultSchema,
  AppStackStatusIpcResultSchema,
  AppStackStopIpcResultSchema,
  type AppStackComponentActionIpcResult,
  type AppStackComponentIpcRequest,
  type AppStackComponentsRemoveIpcRequest,
  type AppStackComponentsRemoveIpcResult,
  type AppStackCreateIpcRequest,
  type AppStackCreateIpcResult,
  type AppStackImageResolveIpcRequest,
  type AppStackImageResolveIpcResult,
  type AppStackLogsIpcRequest,
  type AppStackPlanIpcRequest,
  type AppStackPrepareIpcResult,
  type AppStackPullIpcRequest,
  type AppStackPullIpcResult,
  type AppStackRefIpcRequest,
  type AppStackTerminalOpenIpcRequest,
  type AppStackRemoveIpcRequest,
  type AppStackRemoveIpcResult,
  type AppStackRoutesIpcRequest,
  type AppStackRoutesIpcResult,
  type AppStackStatusIpcResult,
  type AppStackStopIpcResult,
  type ErrorDetail,
  BACKUPS_RESULT_SCHEMAS,
  ErrorCodeSchema,
  CertificateStatusReportWireSchema,
  EmptyDataEnvelopeSchema,
  MANUAL_TLS_RESULT_SCHEMAS,
  ExecutorHealthResponseSchema,
  MailRelayStatusReportWireSchema,
  MailTestIpcResponseSchema,
  PanelMailIpcResponseSchema,
  ObservedServiceStateWireSchema,
  SftpApplyIpcResponseSchema,
  SftpStatusReportWireSchema,
  SITE_DATABASES_RESULT_SCHEMAS,
  SITE_FILES_RESULT_SCHEMAS,
  SITE_JOB_LIMIT_MS,
  signIpcRequest,
  siteJobClientWaitMs,
  WORDPRESS_RESET_CLIENT_WAIT_MS,
  type CertificateStatusIpcRequest,
  type DeployServiceIpcRequest,
  type DnsProviderApplyRequest,
  type ErrorCode,
  type ExecutorHealthResponse,
  type IpcSigningKey,
  type ObservedServiceStateWire,
  type PanelContainer,
  PanelContainerRestartWireSchema,
  PanelContainerStatusWireSchema,
  PanelContainersDataEnvelopeSchema,
  TerminalEndedEnvelopeSchema,
  TerminalOpenWireSchema,
  TerminalReadWireSchema,
  TerminalSessionsEnvelopeSchema,
  type ServiceInstanceActionIpcRequest,
  type ServiceLogsIpcRequest,
  type SiteJobIpcRequest,
  type SitePurgeIpcRequest,
  type SiteRoutesIpcRequest,
} from "@hosting-panel/contracts";
import type {
  ApprovedServiceSpec,
  BackupsRequest,
  BackupsResult,
  DockerExecutionResult,
  DockerExecutorPort,
  CertificateStatusReport,
  MailRelayApplyRequest,
  MailRelayStatusReport,
  MailTestResult,
  PanelMailRequest,
  PanelMailResult,
  PanelContainerStatus,
  PinnedPanelContainer,
  ServiceLogLine,
  SftpAccessApplyRequest,
  SftpApplyResult,
  SftpStatusReport,
  ManualTlsRequest,
  ManualTlsResult,
  SiteDatabasesRequest,
  SiteDatabasesResult,
  SiteFilesRequest,
  SiteFilesResult,
  SiteJobRequest,
  SiteJobResult,
  SiteRoutesRequest,
  AppStackTerminalPort,
  StackExecutorPort,
  TerminalEnded,
  TerminalOpenRequest,
  TerminalOpenResult,
  TerminalReadResult,
  TerminalSessionRecord,
} from "@hosting-panel/executor-contracts";
import { z } from "zod";
import {
  DEFAULT_EXECUTOR_SOCKET_PATH,
  type IpcTransportMode,
} from "./server.js";
import { SITE_JOB_SPECS } from "./site-jobs.js";
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

const SiteJobResultDataEnvelopeSchema = z.object({
  data: z.object({
    jobId: z.string().min(1),
    exitCode: z.number().int(),
    outputTail: z.string(),
    result: z.unknown().optional(),
  }),
});

const ServiceLogsDataEnvelopeSchema = z.object({
  data: z.array(
    z.object({
      at: z.string().nullable(),
      stream: z.enum(["stdout", "stderr"]),
      text: z.string(),
    }),
  ),
});

/** Per-call budgets, each above the executor's own worst case for that call. */
export const DEPLOY_TIMEOUT_MS = 300_000;
export const SITE_JOB_TIMEOUT_MS = 510_000;
export const SITE_PURGE_TIMEOUT_MS = 120_000;
export const MAIL_RELAY_APPLY_TIMEOUT_MS = 300_000;
/** A proxy recreate may pull the image. */
export const DNS_PROVIDER_APPLY_TIMEOUT_MS = 300_000;
export const SITE_FILES_TIMEOUT_MS = 60_000;

/** Kinds with their own limit wait limit + 300 s; the rest keep the shipped waits. */
function siteJobWaitMs(kind: SiteJobIpcRequest["kind"]): number {
  if (Object.hasOwn(SITE_JOB_LIMIT_MS, kind)) return siteJobClientWaitMs(kind as keyof typeof SITE_JOB_LIMIT_MS);
  return kind === "wordpress.reset-password" ? WORDPRESS_RESET_CLIENT_WAIT_MS : SITE_JOB_TIMEOUT_MS;
}
export const SITE_FILES_DELETE_TIMEOUT_MS = 100_000;
export const SITE_FILES_ARCHIVE_TIMEOUT_MS = 600_000;
export const SFTP_APPLY_TIMEOUT_MS = 120_000;
export const SFTP_STATUS_TIMEOUT_MS = 10_000;
export const SITE_DATABASES_TIMEOUT_MS = 75_000;
export const SITE_DATABASES_SIGNON_TIMEOUT_MS = 120_000;
export const MANUAL_TLS_PUT_TIMEOUT_MS = 15_000;
export const MANUAL_TLS_PUBLISH_TIMEOUT_MS = 30_000;
export const MANUAL_TLS_PUBLISH_EVICT_TIMEOUT_MS = 90_000; // stop proxy, edit acme.json, start proxy
export const MANUAL_TLS_PROBE_TIMEOUT_MS = 25_000;
export const MANUAL_TLS_QUICK_TIMEOUT_MS = 10_000; // inventory, gc
export const BACKUPS_TEST_TIMEOUT_MS = 40_000;
export const BACKUPS_TIMEOUT_MS = 30_000;
export const PANEL_CONTAINERS_TIMEOUT_MS = 10_000;
export const PANEL_LOGS_TIMEOUT_MS = 35_000;
export const TERMINAL_OPEN_TIMEOUT_MS = 20_000;
export const TERMINAL_WRITE_TIMEOUT_MS = 10_000;
export const TERMINAL_READ_TIMEOUT_MS = 35_000;
export const TERMINAL_CLOSE_TIMEOUT_MS = 20_000;
export const TERMINAL_LIST_TIMEOUT_MS = 10_000;
export const PANEL_RESTART_TIMEOUT_MS = 35_000;
export const PANEL_APPLY_TIMEOUT_MS = 900_000; // an image pull can take minutes
export const APP_STACK_PULL_TIMEOUT_MS = 270_000; // one image: engine pull budget 240 s + inspect
export const APP_STACK_PREPARE_TIMEOUT_MS = 60_000;
export const APP_STACK_CREATE_TIMEOUT_MS = 180_000; // <= 8 x (stop 10 s + remove + create)
export const APP_STACK_COMPONENT_TIMEOUT_MS = 60_000; // start, restart (t=10) of one component
export const APP_STACK_STOP_TIMEOUT_MS = 150_000; // <= 8 x stop t=10
export const APP_STACK_ROUTES_TIMEOUT_MS = 300_000; // may run ensureIngressProxy (= DEPLOY_TIMEOUT_MS)
export const APP_STACK_REMOVE_TIMEOUT_MS = 180_000;
export const APP_STACK_STATUS_TIMEOUT_MS = 60_000; // GET; probes run in parallel, each <= 30 s
export const APP_STACK_LOGS_TIMEOUT_MS = 35_000; // GET
export const APP_STACK_RESOLVE_TIMEOUT_MS = 40_000; // GET; engine registry lookup budget 30 s

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
  /** The executor's error details (manual TLS: details[0].reason is the executor-internal TLS_* condition). */
  public readonly details: readonly ErrorDetail[];

  public constructor(
    message: string,
    code: ErrorCode,
    statusCode: number,
    ambiguousOutcome: boolean = false,
    details: readonly ErrorDetail[] = [],
  ) {
    super(message);
    this.name = "ExecutorIpcClientError";
    this.code = code;
    this.statusCode = statusCode;
    this.ambiguousOutcome = ambiguousOutcome;
    this.details = details;
  }

  /** TLS_MANIFEST_CONFLICT | TLS_VERSION_MISSING | TLS_VERSION_CONFLICT | TLS_MATERIAL_INVALID | ... or undefined. */
  public get reason(): string | undefined {
    return this.details[0]?.reason;
  }

  /** Ids of the versions a TLS_VERSION_MISSING names. */
  public get versionIds(): string[] {
    return this.details.filter((d) => d.field === "versionId").map((d) => d.message);
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

const handledIpcSockets = new WeakSet<object>();

export class SignedDockerExecutorIpcClient implements DockerExecutorPort, StackExecutorPort, AppStackTerminalPort {
  public readonly isRuntimeAvailable: boolean;
  private readonly signingKey: IpcSigningKey;
  private readonly transport: IpcTransportMode;
  private readonly socketPath?: string;
  private readonly port?: number;
  private readonly timeoutMs: number;
  /** An explicit constructor timeout wins over the per-call budgets (tests, tuning). */
  private readonly timeoutOverrideMs?: number;

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
    if (options.timeoutMs !== undefined) {
      this.timeoutOverrideMs = options.timeoutMs;
    }
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
        ...(spec.hostRoutes !== undefined
          ? { hostRoutes: spec.hostRoutes.map((r) => ({ ...r })) }
          : {}),
        ...(spec.exposeHttp !== undefined ? { exposeHttp: spec.exposeHttp } : {}),
        ...(spec.siteMail !== undefined ? { siteMail: spec.siteMail } : {}),
        ...(spec.phpIni !== undefined ? { phpIni: { ...spec.phpIni } } : {}),
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

    const json = await this.sendSignedJsonRequest(
      "POST",
      "/v1/services/deploy",
      payload,
      DEPLOY_TIMEOUT_MS,
    );
    return ExecutionResultDataEnvelopeSchema.parse(json).data;
  }

  public async runSiteJob(req: SiteJobRequest): Promise<SiteJobResult> {
    const payload: SiteJobIpcRequest = {
      jobId: req.jobId,
      kind: req.kind,
      siteId: req.siteId,
      organizationId: req.organizationId,
      ...(req.serviceInstanceId !== undefined ? { serviceInstanceId: req.serviceInstanceId } : {}),
      params: { ...req.params },
      ...(req.resolvedSecrets !== undefined ? { resolvedSecrets: { ...req.resolvedSecrets } } : {}),
    };
    const json = await this.sendSignedJsonRequest(
      "POST",
      "/v1/jobs/run",
      payload,
      siteJobWaitMs(req.kind),
    );
    const { result, ...data } = SiteJobResultDataEnvelopeSchema.parse(json).data;
    // Checked again on this side against the kind's own schema; a result that fails is dropped (result_unreadable).
    const checked = result === undefined ? undefined : SITE_JOB_SPECS[req.kind].result?.safeParse(result);
    return checked?.success === true ? { ...data, result: checked.data } : data;
  }

  public async purgeSite(siteId: string): Promise<void> {
    assertSafeIdentifier(siteId, "siteId");
    const payload: SitePurgeIpcRequest = { siteId };
    await this.sendSignedJsonRequest("POST", "/v1/sites/purge", payload, SITE_PURGE_TIMEOUT_MS);
  }

  public async applySiteRoutes(req: SiteRoutesRequest): Promise<void> {
    assertSafeIdentifier(req.siteId, "siteId");
    assertSafeIdentifier(req.serviceInstanceId, "serviceInstanceId");
    const payload: SiteRoutesIpcRequest = {
      siteId: req.siteId,
      serviceInstanceId: req.serviceInstanceId,
      containerName: req.containerName,
      internalPort: req.internalPort,
      hosts: req.hosts.map((h) => ({ ...h })),
    };
    await this.sendSignedJsonRequest("POST", "/v1/sites/routes", payload);
  }

  public async getCertificateStatus(req: { failuresSince: string }): Promise<CertificateStatusReport> {
    const payload: CertificateStatusIpcRequest = { failuresSince: req.failuresSince };
    const json = await this.sendSignedJsonRequest("POST", "/v1/ingress/certificates", payload);
    return z.object({ data: CertificateStatusReportWireSchema }).parse(json).data;
  }

  public async applyMailRelay(req: MailRelayApplyRequest | null): Promise<void> {
    await this.sendSignedJsonRequest(
      "POST",
      "/v1/mail-relay/apply",
      { config: req },
      MAIL_RELAY_APPLY_TIMEOUT_MS,
    );
  }

  public async applyDnsProvider(req: DnsProviderApplyRequest | null): Promise<void> {
    await this.sendSignedJsonRequest(
      "POST",
      "/v1/ingress/dns-provider/apply",
      { config: req },
      DNS_PROVIDER_APPLY_TIMEOUT_MS,
    );
  }

  public async getMailRelayStatus(req: { since: string }): Promise<MailRelayStatusReport> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/mail-relay/status", { since: req.since });
    return z.object({ data: MailRelayStatusReportWireSchema }).parse(json).data;
  }

  public async sendTestMail(req: { to: string; from: string }): Promise<MailTestResult> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/mail-relay/test", {
      to: req.to,
      from: req.from,
    });
    return z.object({ data: MailTestIpcResponseSchema }).parse(json).data;
  }

  public async sendPanelMail(req: PanelMailRequest): Promise<PanelMailResult> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/mail-relay/panel", req);
    return z.object({ data: PanelMailIpcResponseSchema }).parse(json).data;
  }

  public async siteFiles<R extends SiteFilesRequest>(req: R): Promise<SiteFilesResult<R["op"]>> {
    assertSafeIdentifier(req.serviceInstanceId, "serviceInstanceId");
    const timeoutMs =
      req.op === "archive" ||
      req.op === "extract" ||
      req.op === "import.unpack" ||
      req.op === "import.discard" ||
      req.op === "import.undo" ||
      req.op === "import.finish"
        ? SITE_FILES_ARCHIVE_TIMEOUT_MS
        : req.op === "delete"
          ? SITE_FILES_DELETE_TIMEOUT_MS
          : SITE_FILES_TIMEOUT_MS;
    const json = await this.sendSignedJsonRequest("POST", "/v1/sites/files", req, timeoutMs);
    const schema = SITE_FILES_RESULT_SCHEMAS[req.op] as z.ZodTypeAny;
    return z.object({ data: schema }).parse(json).data as SiteFilesResult<R["op"]>;
  }

  public async siteDatabases<R extends SiteDatabasesRequest>(
    req: R,
  ): Promise<SiteDatabasesResult<R["op"]>> {
    const timeoutMs =
      req.op === "phpMyAdminSignOn"
        ? SITE_DATABASES_SIGNON_TIMEOUT_MS
        : SITE_DATABASES_TIMEOUT_MS;
    const json = await this.sendSignedJsonRequest("POST", "/v1/sites/databases", req, timeoutMs);
    const schema = SITE_DATABASES_RESULT_SCHEMAS[req.op] as z.ZodTypeAny;
    return z.object({ data: schema }).parse(json).data as SiteDatabasesResult<R["op"]>;
  }

  public async applySftpAccess(req: SftpAccessApplyRequest): Promise<SftpApplyResult> {
    const json = await this.sendSignedJsonRequest(
      "POST",
      "/v1/sftp/apply",
      req,
      SFTP_APPLY_TIMEOUT_MS,
    );
    return z.object({ data: SftpApplyIpcResponseSchema }).parse(json).data;
  }

  public async getSftpStatus(): Promise<SftpStatusReport> {
    const json = await this.sendSignedJsonRequest(
      "POST",
      "/v1/sftp/status",
      {},
      SFTP_STATUS_TIMEOUT_MS,
    );
    return z.object({ data: SftpStatusReportWireSchema }).parse(json).data;
  }

  public async backups<R extends BackupsRequest>(req: R): Promise<BackupsResult<R["action"]>> {
    // localInit writes a marker and probes the volume, like test it is bounded by the 40 s budget.
    const timeoutMs =
      req.action === "test" || req.action === "localInit"
        ? BACKUPS_TEST_TIMEOUT_MS
        : BACKUPS_TIMEOUT_MS;
    const json = await this.sendSignedJsonRequest("POST", "/v1/backups", req, timeoutMs);
    const schema = BACKUPS_RESULT_SCHEMAS[req.action] as z.ZodTypeAny;
    return z.object({ data: schema }).parse(json).data as BackupsResult<R["action"]>;
  }

  public async manualTls<R extends ManualTlsRequest>(req: R): Promise<ManualTlsResult<R["action"]>> {
    const timeoutMs =
      req.action === "putVersion"
        ? MANUAL_TLS_PUT_TIMEOUT_MS
        : req.action === "publish"
          ? req.evictAcme === true
            ? MANUAL_TLS_PUBLISH_EVICT_TIMEOUT_MS
            : MANUAL_TLS_PUBLISH_TIMEOUT_MS
          : req.action === "probe"
            ? MANUAL_TLS_PROBE_TIMEOUT_MS
            : MANUAL_TLS_QUICK_TIMEOUT_MS;
    const json = await this.sendSignedJsonRequest("POST", "/v1/ingress/manual-tls", req, timeoutMs);
    const schema = MANUAL_TLS_RESULT_SCHEMAS[req.action] as z.ZodTypeAny;
    return z.object({ data: schema }).parse(json).data as ManualTlsResult<R["action"]>;
  }

  public async getServiceLogs(
    serviceInstanceId: string,
    tail: number,
  ): Promise<readonly ServiceLogLine[]> {
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    const payload: ServiceLogsIpcRequest = { serviceInstanceId, tail };
    const json = await this.sendSignedJsonRequest("POST", "/v1/services/logs", payload);
    return ServiceLogsDataEnvelopeSchema.parse(json).data;
  }

  public async getPanelContainers(): Promise<readonly PanelContainerStatus[]> {
    const json = await this.sendSignedJsonRequest("GET", "/v1/panel/containers", undefined, PANEL_CONTAINERS_TIMEOUT_MS);
    return PanelContainersDataEnvelopeSchema.parse(json).data;
  }

  public async getPanelContainerLogs(req: {
    readonly component: PanelContainer;
    readonly tail: number;
  }): Promise<readonly ServiceLogLine[]> {
    const query = new URLSearchParams({ component: req.component, tail: String(req.tail) });
    const json = await this.sendSignedJsonRequest("GET", `/v1/panel/logs?${query}`, undefined, PANEL_LOGS_TIMEOUT_MS);
    return ServiceLogsDataEnvelopeSchema.parse(json).data;
  }

  public async openTerminal(req: TerminalOpenRequest): Promise<TerminalOpenResult> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/terminal/open", req, TERMINAL_OPEN_TIMEOUT_MS);
    return z.object({ data: TerminalOpenWireSchema }).parse(json).data;
  }

  /** A terminal in one component of an application (ADR-0041); the session is then written, read and closed as a site's. */
  public async openAppStackTerminal(req: AppStackTerminalOpenIpcRequest): Promise<TerminalOpenResult> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/app-stacks/terminal/open", req, TERMINAL_OPEN_TIMEOUT_MS);
    return z.object({ data: TerminalOpenWireSchema }).parse(json).data;
  }

  public async writeTerminal(req: { readonly sessionId: string; readonly input: string }): Promise<void> {
    EmptyDataEnvelopeSchema.parse(await this.sendSignedJsonRequest("POST", "/v1/terminal/write", req, TERMINAL_WRITE_TIMEOUT_MS));
  }

  public async readTerminal(req: { readonly sessionId: string; readonly cursor: number }): Promise<TerminalReadResult> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/terminal/read", req, TERMINAL_READ_TIMEOUT_MS);
    return z.object({ data: TerminalReadWireSchema }).parse(json).data;
  }

  public async closeTerminal(req: { readonly sessionId: string }): Promise<TerminalEnded> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/terminal/close", req, TERMINAL_CLOSE_TIMEOUT_MS);
    return TerminalEndedEnvelopeSchema.parse(json).data;
  }

  public async listTerminals(): Promise<readonly TerminalSessionRecord[]> {
    const json = await this.sendSignedJsonRequest("GET", "/v1/terminal/sessions", undefined, TERMINAL_LIST_TIMEOUT_MS);
    return TerminalSessionsEnvelopeSchema.parse(json).data;
  }

  public async restartPanelContainer(req: { readonly component: PanelContainer }): Promise<{ readonly startedAt: string | null }> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/panel/restart", req, PANEL_RESTART_TIMEOUT_MS);
    return z.object({ data: PanelContainerRestartWireSchema }).parse(json).data;
  }

  public async applyPanelContainerPin(component: PinnedPanelContainer): Promise<PanelContainerStatus> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/panel/apply", { component }, PANEL_APPLY_TIMEOUT_MS);
    return z.object({ data: PanelContainerStatusWireSchema }).parse(json).data;
  }

  public async restartService(
    serviceInstanceId: string,
    resolvedSecrets?: Readonly<Record<string, string>>,
  ): Promise<DockerExecutionResult> {
    return this.sendServiceAction(serviceInstanceId, "restart", resolvedSecrets);
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

  public async pullAppStackImage(req: AppStackPullIpcRequest): Promise<AppStackPullIpcResult> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/app-stacks/pull", req, APP_STACK_PULL_TIMEOUT_MS);
    return z.object({ data: AppStackPullIpcResultSchema }).parse(json).data;
  }

  public async prepareAppStack(req: AppStackPlanIpcRequest): Promise<AppStackPrepareIpcResult> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/app-stacks/prepare", req, APP_STACK_PREPARE_TIMEOUT_MS);
    return z.object({ data: AppStackPrepareIpcResultSchema }).parse(json).data;
  }

  public async createAppStackComponents(req: AppStackCreateIpcRequest): Promise<AppStackCreateIpcResult> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/app-stacks/create", req, APP_STACK_CREATE_TIMEOUT_MS);
    return z.object({ data: AppStackCreateIpcResultSchema }).parse(json).data;
  }

  public async startAppStackComponent(req: AppStackComponentIpcRequest): Promise<AppStackComponentActionIpcResult> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/app-stacks/start", req, APP_STACK_COMPONENT_TIMEOUT_MS);
    return z.object({ data: AppStackComponentActionIpcResultSchema }).parse(json).data;
  }

  public async restartAppStackComponent(req: AppStackComponentIpcRequest): Promise<AppStackComponentActionIpcResult> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/app-stacks/restart", req, APP_STACK_COMPONENT_TIMEOUT_MS);
    return z.object({ data: AppStackComponentActionIpcResultSchema }).parse(json).data;
  }

  public async stopAppStack(req: AppStackRefIpcRequest): Promise<AppStackStopIpcResult> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/app-stacks/stop", req, APP_STACK_STOP_TIMEOUT_MS);
    return z.object({ data: AppStackStopIpcResultSchema }).parse(json).data;
  }

  public async publishAppStackRoutes(req: AppStackRoutesIpcRequest): Promise<AppStackRoutesIpcResult> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/app-stacks/routes", req, APP_STACK_ROUTES_TIMEOUT_MS);
    return z.object({ data: AppStackRoutesIpcResultSchema }).parse(json).data;
  }

  /** Waits in the same route-file line as publish, so it shares its budget. */
  public async unpublishAppStackRoutes(req: AppStackRefIpcRequest): Promise<AppStackRoutesIpcResult> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/app-stacks/unpublish", req, APP_STACK_ROUTES_TIMEOUT_MS);
    return z.object({ data: AppStackRoutesIpcResultSchema }).parse(json).data;
  }

  public async removeAppStack(req: AppStackRemoveIpcRequest): Promise<AppStackRemoveIpcResult> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/app-stacks/remove", req, APP_STACK_REMOVE_TIMEOUT_MS);
    return z.object({ data: AppStackRemoveIpcResultSchema }).parse(json).data;
  }

  public async removeAppStackComponents(req: AppStackComponentsRemoveIpcRequest): Promise<AppStackComponentsRemoveIpcResult> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/app-stacks/remove-components", req, APP_STACK_REMOVE_TIMEOUT_MS);
    return z.object({ data: AppStackComponentsRemoveIpcResultSchema }).parse(json).data;
  }

  public async getAppStackStatus(req: AppStackRefIpcRequest): Promise<AppStackStatusIpcResult> {
    const query = new URLSearchParams({ organizationId: req.organizationId });
    const pathWithQuery = `/v1/app-stacks/${encodeURIComponent(req.stackId)}/status?${query}`;
    const json = await this.sendSignedJsonRequest("GET", pathWithQuery, undefined, APP_STACK_STATUS_TIMEOUT_MS);
    return z.object({ data: AppStackStatusIpcResultSchema }).parse(json).data;
  }

  public async getAppStackComponentLogs(req: AppStackLogsIpcRequest): Promise<readonly ServiceLogLine[]> {
    const query = new URLSearchParams({ organizationId: req.organizationId, tail: String(req.tail) });
    const pathWithQuery = `/v1/app-stacks/${encodeURIComponent(req.stackId)}/components/${encodeURIComponent(req.componentKey)}/logs?${query}`;
    const json = await this.sendSignedJsonRequest("GET", pathWithQuery, undefined, APP_STACK_LOGS_TIMEOUT_MS);
    return z.object({ data: AppStackLogsIpcResultSchema }).parse(json).data;
  }

  public async resolveAppStackImage(req: AppStackImageResolveIpcRequest): Promise<AppStackImageResolveIpcResult> {
    const pathWithQuery = `/v1/app-stacks/image-digest?${new URLSearchParams({ image: req.image })}`;
    const json = await this.sendSignedJsonRequest("GET", pathWithQuery, undefined, APP_STACK_RESOLVE_TIMEOUT_MS);
    return z.object({ data: AppStackImageResolveIpcResultSchema }).parse(json).data;
  }

  private async sendServiceAction(
    serviceInstanceId: string,
    action: "restart" | "stop" | "delete",
    resolvedSecrets?: Readonly<Record<string, string>>,
  ): Promise<DockerExecutionResult> {
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    const payload: ServiceInstanceActionIpcRequest = {
      serviceInstanceId,
      action,
      ...(resolvedSecrets ? { resolvedSecrets: { ...resolvedSecrets } } : {}),
    };
    const json = await this.sendSignedJsonRequest("POST", "/v1/services/action", payload);
    return ExecutionResultDataEnvelopeSchema.parse(json).data;
  }

  private async sendSignedJsonRequest(
    method: "GET" | "POST",
    pathWithQuery: string,
    bodyObject?: unknown,
    perCallTimeoutMs?: number,
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
              timeout: this.timeoutOverrideMs ?? perCallTimeoutMs ?? this.timeoutMs,
            }
          : {
              socketPath: this.socketPath,
              path: pathWithQuery,
              method,
              headers,
              timeout: this.timeoutOverrideMs ?? perCallTimeoutMs ?? this.timeoutMs,
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
        if (!handledIpcSockets.has(sock)) {
          handledIpcSockets.add(sock);
          // Swallow post-settlement socket errors (e.g. write EPIPE after an early server reply).
          sock.on("error", () => undefined);
        }
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
          false,
          parsedError.data.error.details,
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
