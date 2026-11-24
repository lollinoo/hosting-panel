import http from "node:http";
import {
  ApiErrorEnvelopeSchema,
  AppStackComponentActionIpcResultSchema,
  AppStackComponentsRemoveIpcResultSchema,
  AppStackCreateIpcResultSchema,
  AppStackImageResolveIpcResultSchema,
  AppStackLinksIpcResultSchema,
  AppStackLogsIpcResultSchema,
  AppStackPrepareIpcResultSchema,
  AppStackPullIpcResultSchema,
  AppStackRemoveIpcResultSchema,
  AppStackRoutesIpcResultSchema,
  AppStackStatusIpcResultSchema,
  AppStackStopIpcResultSchema,
  AppStackTaskReadIpcResultSchema,
  AppStackTaskRunIpcResultSchema,
  type AppStackComponentActionIpcResult,
  type AppStackComponentIpcRequest,
  type AppStackComponentsRemoveIpcRequest,
  type AppStackComponentsRemoveIpcResult,
  type AppStackCreateIpcRequest,
  type AppStackCreateIpcResult,
  type AppStackImageResolveIpcRequest,
  type AppStackImageResolveIpcResult,
  type AppStackLinksIpcRequest,
  type AppStackLinksIpcResult,
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
  type AppStackStopIpcRequest,
  type AppStackStopIpcResult,
  type AppStackTaskReadIpcRequest,
  type AppStackTaskReadIpcResult,
  type AppStackTaskRunIpcRequest,
  type AppStackTaskRunIpcResult,
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
  StackTaskExecutorPort,
  TerminalEnded,
  TerminalOpenRequest,
  TerminalOpenResult,
  TerminalReadResult,
  TerminalSessionRecord,
} from "@hosting-panel/executor-contracts";
import { z } from "zod";
import {
  APP_STACK_TASK_READ_TIMEOUT_MS,
  APP_STACK_TASK_RUN_MARGIN_MS,
  APP_STACK_TASK_RUN_PATH,
  appStackTaskReadPath,
} from "./app-stacks/task-ipc.js";
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
export const APP_STACK_LINKS_TIMEOUT_MS = 60_000; // <= 8 applications: one inspect, one attach or detach each
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

/**
 * How an answer that cannot be read ends, per call (#182). "change": a lost answer, see `sendChange`. "read": a failed
 * read, which the recoveries rely on. "kept": a change that still fails as an ordinary error, for the reason next to it.
 * A new op or action does not build until it is classified here.
 */
type UnreadableAnswerClass = "change" | "read" | "kept";

const BACKUPS_ANSWER_CLASS: Readonly<Record<BackupsRequest["action"], UnreadableAnswerClass>> = {
  test: "read",
  // Writes a marker and probes the volume. No test result is recorded, the API answers with its existing "connectivity
  // test timed out" error, and running the set-up again is safe (ADR-0032).
  localInit: "change",
  // See #202: the start holds the site's lock while a recovery read can fail for ever (#183).
  start: "kept",
  status: "read",
  // A failed forget and a lost one end the same way for the retention: it is tried again the next night.
  forget: "kept",
  // See #202: the restore settles through a call that repeats (#199).
  restore: "kept",
  // See #202: the start holds the site's lock while a recovery read can fail for ever (#183).
  archive: "kept",
  readArchive: "read",
  // Best effort: the caller ignores every failure, and the executor drops an archive nobody collects.
  discardArchive: "kept",
  // The restore recovery's own settling call: any failure leaves the restore pending, and the next pass asks again.
  settle: "kept",
  // See #202: the start holds the site's lock while a recovery read can fail for ever (#183).
  panelStart: "kept",
  siteState: "read",
  // The backup jobs of an application (ADR-0038).
  stackStart: "change",
  stackRestore: "change",
  stackForget: "change",
};

const SITE_FILES_ANSWER_CLASS: Readonly<Record<SiteFilesRequest["op"], UnreadableAnswerClass>> = {
  list: "read",
  stat: "read",
  read: "read",
  write: "change",
  mkdir: "change",
  move: "change",
  delete: "change",
  archive: "change",
  extract: "change",
  "import.put": "change",
  // Not a read: it moves the uploaded file into the import's slot, and a second call does not find it.
  "import.take": "change",
  "import.stat": "read",
  "import.discard": "change",
  "import.unpack": "change",
  "import.switch": "change",
  "import.undo": "change",
  "import.finish": "change",
};

/**
 * An answer the client could not read after a change was sent: the executor may have made the change, so it is a lost
 * answer, not a refusal. The words are fixed: never the body, never a schema message that could quote it.
 */
function unreadableChangeAnswer(what: string): ExecutorIpcClientError {
  return new ExecutorIpcClientError(
    `Unreadable docker-executor IPC answer after mutating command dispatch: ${what}`,
    "OPERATION_AMBIGUOUS",
    502,
    true,
  );
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

export class SignedDockerExecutorIpcClient implements DockerExecutorPort, StackExecutorPort, AppStackTerminalPort, StackTaskExecutorPort {
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

  /** Kept as it is (#182): nothing in the API calls it. */
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

    return this.sendChange("/v1/services/deploy", payload, DEPLOY_TIMEOUT_MS, ExecutionResultDataEnvelopeSchema.shape.data);
  }

  /** Kept as it is, see #202: the restore's database-password job is sent again on every recovery pass. */
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

  /** Kept as it is (#182): the site's removal fails its operation on any failure of this call. */
  public async purgeSite(siteId: string): Promise<void> {
    assertSafeIdentifier(siteId, "siteId");
    const payload: SitePurgeIpcRequest = { siteId };
    await this.sendSignedJsonRequest("POST", "/v1/sites/purge", payload, SITE_PURGE_TIMEOUT_MS);
  }

  /**
   * Kept as it is (#182): the domains change fails its operation on any failure and the reconciler publishes the routes
   * again; the certificate change rolls the routes back on any failure but a lost connection.
   */
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

  /** Kept as it is (#182): any failure is logged and the next tick applies the whole configuration again. */
  public async applyMailRelay(req: MailRelayApplyRequest | null): Promise<void> {
    await this.sendSignedJsonRequest(
      "POST",
      "/v1/mail-relay/apply",
      { config: req },
      MAIL_RELAY_APPLY_TIMEOUT_MS,
    );
  }

  /** Kept as it is (#182): any failure is logged and the next tick applies the whole configuration again. */
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
    return this.sendChange("/v1/mail-relay/test", { to: req.to, from: req.from }, undefined, MailTestIpcResponseSchema);
  }

  /** Kept as it is (#182): every failure is "failed" to its callers. */
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
    const schema = SITE_FILES_RESULT_SCHEMAS[req.op] as z.ZodTypeAny;
    if (SITE_FILES_ANSWER_CLASS[req.op] === "change") {
      return (await this.sendChange("/v1/sites/files", req, timeoutMs, schema)) as SiteFilesResult<R["op"]>;
    }
    const json = await this.sendSignedJsonRequest("POST", "/v1/sites/files", req, timeoutMs);
    return z.object({ data: schema }).parse(json).data as SiteFilesResult<R["op"]>;
  }

  /** Kept as it is (#182), every op: the API answers the same retryable refusal for a lost answer and an unreadable one. */
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

  /** Kept as it is (#182): any failure marks the access to apply again, and the loop sends the whole set. */
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
    const schema = BACKUPS_RESULT_SCHEMAS[req.action] as z.ZodTypeAny;
    if (BACKUPS_ANSWER_CLASS[req.action] === "change") {
      return (await this.sendChange("/v1/backups", req, timeoutMs, schema)) as BackupsResult<R["action"]>;
    }
    const json = await this.sendSignedJsonRequest("POST", "/v1/backups", req, timeoutMs);
    return z.object({ data: schema }).parse(json).data as BackupsResult<R["action"]>;
  }

  /** putVersion, publish and gc kept as they are, see #202: the certificate applier's two paths are not read yet. */
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

  /**
   * Kept as it is (#182), like the application's below: on any failure but a lost connection the session is recorded as
   * not started, and the server's sweep closes a shell nobody holds. As a lost answer the row would stay open for nobody.
   */
  public async openTerminal(req: TerminalOpenRequest): Promise<TerminalOpenResult> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/terminal/open", req, TERMINAL_OPEN_TIMEOUT_MS);
    return z.object({ data: TerminalOpenWireSchema }).parse(json).data;
  }

  /** A terminal in one component of an application (ADR-0041); the session is then written, read and closed as a site's. */
  public async openAppStackTerminal(req: AppStackTerminalOpenIpcRequest): Promise<TerminalOpenResult> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/app-stacks/terminal/open", req, TERMINAL_OPEN_TIMEOUT_MS);
    return z.object({ data: TerminalOpenWireSchema }).parse(json).data;
  }

  /** Kept as it is (#182): every failure but a gone session is "unavailable", a lost answer included; the next read shows the keys. */
  public async writeTerminal(req: { readonly sessionId: string; readonly input: string }): Promise<void> {
    EmptyDataEnvelopeSchema.parse(await this.sendSignedJsonRequest("POST", "/v1/terminal/write", req, TERMINAL_WRITE_TIMEOUT_MS));
  }

  public async readTerminal(req: { readonly sessionId: string; readonly cursor: number }): Promise<TerminalReadResult> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/terminal/read", req, TERMINAL_READ_TIMEOUT_MS);
    return z.object({ data: TerminalReadWireSchema }).parse(json).data;
  }

  /** Kept as it is (#182): any failure but a gone session keeps the row open, and the sweep closes it again. */
  public async closeTerminal(req: { readonly sessionId: string }): Promise<TerminalEnded> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/terminal/close", req, TERMINAL_CLOSE_TIMEOUT_MS);
    return TerminalEndedEnvelopeSchema.parse(json).data;
  }

  public async listTerminals(): Promise<readonly TerminalSessionRecord[]> {
    const json = await this.sendSignedJsonRequest("GET", "/v1/terminal/sessions", undefined, TERMINAL_LIST_TIMEOUT_MS);
    return TerminalSessionsEnvelopeSchema.parse(json).data;
  }

  /** Kept as it is (#182), like the pin below: every failure settles the operation failed, never unknown. */
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
    return this.sendChange("/v1/app-stacks/pull", req, APP_STACK_PULL_TIMEOUT_MS, AppStackPullIpcResultSchema);
  }

  public async prepareAppStack(req: AppStackPlanIpcRequest): Promise<AppStackPrepareIpcResult> {
    return this.sendChange("/v1/app-stacks/prepare", req, APP_STACK_PREPARE_TIMEOUT_MS, AppStackPrepareIpcResultSchema);
  }

  public async createAppStackComponents(req: AppStackCreateIpcRequest): Promise<AppStackCreateIpcResult> {
    return this.sendChange("/v1/app-stacks/create", req, APP_STACK_CREATE_TIMEOUT_MS, AppStackCreateIpcResultSchema);
  }

  public async startAppStackComponent(req: AppStackComponentIpcRequest): Promise<AppStackComponentActionIpcResult> {
    return this.sendChange("/v1/app-stacks/start", req, APP_STACK_COMPONENT_TIMEOUT_MS, AppStackComponentActionIpcResultSchema);
  }

  public async restartAppStackComponent(req: AppStackComponentIpcRequest): Promise<AppStackComponentActionIpcResult> {
    return this.sendChange("/v1/app-stacks/restart", req, APP_STACK_COMPONENT_TIMEOUT_MS, AppStackComponentActionIpcResultSchema);
  }

  public async stopAppStack(req: AppStackStopIpcRequest): Promise<AppStackStopIpcResult> {
    return this.sendChange("/v1/app-stacks/stop", req, APP_STACK_STOP_TIMEOUT_MS, AppStackStopIpcResultSchema);
  }

  public async publishAppStackRoutes(req: AppStackRoutesIpcRequest): Promise<AppStackRoutesIpcResult> {
    return this.sendChange("/v1/app-stacks/routes", req, APP_STACK_ROUTES_TIMEOUT_MS, AppStackRoutesIpcResultSchema);
  }

  /** Waits in the same route-file line as publish, so it shares its budget. */
  public async unpublishAppStackRoutes(req: AppStackRefIpcRequest): Promise<AppStackRoutesIpcResult> {
    return this.sendChange("/v1/app-stacks/unpublish", req, APP_STACK_ROUTES_TIMEOUT_MS, AppStackRoutesIpcResultSchema);
  }

  public async removeAppStack(req: AppStackRemoveIpcRequest): Promise<AppStackRemoveIpcResult> {
    return this.sendChange("/v1/app-stacks/remove", req, APP_STACK_REMOVE_TIMEOUT_MS, AppStackRemoveIpcResultSchema);
  }

  public async removeAppStackComponents(req: AppStackComponentsRemoveIpcRequest): Promise<AppStackComponentsRemoveIpcResult> {
    return this.sendChange("/v1/app-stacks/remove-components", req, APP_STACK_REMOVE_TIMEOUT_MS, AppStackComponentsRemoveIpcResultSchema);
  }

  /** Kept as it is (#182): any failure marks the links unsettled, and they are sent again. */
  public async syncAppStackLinks(req: AppStackLinksIpcRequest): Promise<AppStackLinksIpcResult> {
    const json = await this.sendSignedJsonRequest("POST", "/v1/app-stacks/links", req, APP_STACK_LINKS_TIMEOUT_MS);
    return z.object({ data: AppStackLinksIpcResultSchema }).parse(json).data;
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

  /**
   * A task of an application (ADR-0042). The answer comes when the command ended, so the wait is the run's own time
   * limit plus a margin; an answer that does not come is a lost one (`ambiguousOutcome`): ask with getAppStackTaskRun.
   */
  public async runAppStackTask(req: AppStackTaskRunIpcRequest): Promise<AppStackTaskRunIpcResult> {
    const waitMs = req.timeoutSeconds * 1000 + APP_STACK_TASK_RUN_MARGIN_MS;
    return this.sendChange(APP_STACK_TASK_RUN_PATH, req, waitMs, AppStackTaskRunIpcResultSchema);
  }

  public async getAppStackTaskRun(req: AppStackTaskReadIpcRequest): Promise<AppStackTaskReadIpcResult> {
    const json = await this.sendSignedJsonRequest("GET", appStackTaskReadPath(req), undefined, APP_STACK_TASK_READ_TIMEOUT_MS);
    return z.object({ data: AppStackTaskReadIpcResultSchema }).parse(json).data;
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
    return this.sendChange("/v1/services/action", payload, undefined, ExecutionResultDataEnvelopeSchema.shape.data);
  }

  /**
   * A call of the closed list of changes (an application's: ADR-0035, ADR-0038, ADR-0042; a site's, a service's and
   * the test mail: #182), whose request may have changed the server once sent. An answer that cannot be read (a 2xx that
   * fails the schema, an empty body included; a body that is not JSON; a 5xx without the executor's error envelope) is a
   * lost one (`ambiguousOutcome`): the caller handles it as a lost connection and never sends the change again by itself.
   * The outbox settles it from a read; the site provisioner fails its operation and leaves the site degraded. A refusal
   * with the envelope, whatever its status, and a 4xx stay refusals. No `timeoutMs` is the client's default wait.
   */
  private async sendChange<S extends z.ZodTypeAny>(
    path: string,
    body: unknown,
    timeoutMs: number | undefined,
    schema: S,
  ): Promise<z.output<S>> {
    const json = await this.sendSignedJsonRequest("POST", path, body, timeoutMs, { unreadableChangeIsLost: true });
    const parsed = z.object({ data: schema as z.ZodTypeAny }).safeParse(json);
    if (!parsed.success) throw unreadableChangeAnswer("the result does not have the expected shape");
    return parsed.data.data as z.output<S>;
  }

  private async sendSignedJsonRequest(
    method: "GET" | "POST",
    pathWithQuery: string,
    bodyObject?: unknown,
    perCallTimeoutMs?: number,
    options: { readonly unreadableChangeIsLost?: boolean } = {},
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
        if (options.unreadableChangeIsLost === true && (response.statusCode < 400 || response.statusCode >= 500)) {
          throw unreadableChangeAnswer("the body is not JSON");
        }
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
      if (options.unreadableChangeIsLost === true && response.statusCode >= 500) {
        throw unreadableChangeAnswer(`HTTP ${String(response.statusCode)} without an error envelope`);
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
