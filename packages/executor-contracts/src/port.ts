import type {
  BackupsAction,
  BackupsIpcRequest,
  BackupsResultByAction,
  DnsProviderApplyRequest,
  OperationStatus,
  PanelContainer,
  PanelContainerState,
  PINNED_PANEL_CONTAINERS,
  SftpAccessApplyRequest,
  SftpApplyResult,
  SftpStatusReport,
  SiteDatabasesIpcRequest,
  SiteDatabasesOp,
  SiteDatabasesResultByOp,
  SiteFileEntryDto,
  SiteFilesIpcRequest,
  SiteFilesOp,
  SiteFilesResultByOp,
  SiteHostRoute,
  SiteTypeKey,
  WordpressImportLoadResult,
  WordpressStateResult,
  WordpressUpdateResult,
} from "@hosting-panel/contracts";
import type { ObservedServiceState } from "@hosting-panel/hosting-domain";
import type { CertificateStatusReport } from "./acme-status.js";
import type {
  MailRelayApplyRequest,
  MailRelayStatusReport,
  MailTestResult,
  PanelMailRequest,
  PanelMailResult,
} from "./mail-relay.js";
import type { ManualTlsRequest, ManualTlsResult } from "./manual-tls.js";
import type { ApprovedServiceSpec } from "./spec.js";

export type SiteDatabasesRequest = SiteDatabasesIpcRequest;
export type SiteDatabasesResult<O extends SiteDatabasesOp = SiteDatabasesOp> = SiteDatabasesResultByOp[O];
export type SiteFileEntry = SiteFileEntryDto;
export type SiteFilesRequest = SiteFilesIpcRequest;
export type SiteFilesResult<O extends SiteFilesOp = SiteFilesOp> = SiteFilesResultByOp[O];
export type BackupsRequest = BackupsIpcRequest;
export type BackupsResult<A extends BackupsAction = BackupsAction> = BackupsResultByAction[A];

export interface DockerExecutionResult {
  readonly operationId: string;
  readonly status: OperationStatus;
  readonly message?: string;
  readonly internalDockerRef?: string;
  readonly containerStatus?: "running" | "stopped";
  readonly ingressConfigured?: boolean;
}

export interface DockerExecutorPort {
  readonly isRuntimeAvailable: boolean;
  deployService(spec: ApprovedServiceSpec): Promise<DockerExecutionResult>;
  /** resolvedSecrets (#7): written again, additively, before the restart. */
  restartService(serviceInstanceId: string, resolvedSecrets?: Readonly<Record<string, string>>): Promise<DockerExecutionResult>;
  stopService(serviceInstanceId: string): Promise<DockerExecutionResult>;
  deleteService(serviceInstanceId: string): Promise<DockerExecutionResult>;
  getObservedState(serviceInstanceId: string): Promise<ObservedServiceState | null>;
  runSiteJob(req: SiteJobRequest): Promise<SiteJobResult>;
  /** Removes a site's volumes, networks and routes; refuses while its containers exist. */
  purgeSite(siteId: string): Promise<void>;
  getServiceLogs(serviceInstanceId: string, tail: number): Promise<readonly ServiceLogLine[]>;
  /** Rewrites only the routing file; the service container is never touched. */
  applySiteRoutes(req: SiteRoutesRequest): Promise<void>;
  /** Read-only: hostnames, expiry and recent ACME failures. Never private keys. */
  getCertificateStatus(req: { failuresSince: string }): Promise<CertificateStatusReport>;
  /** null disables the outgoing mail relay. The password is never logged or echoed. */
  applyMailRelay(req: MailRelayApplyRequest | null): Promise<void>;
  getMailRelayStatus(req: { since: string }): Promise<MailRelayStatusReport>;
  /** null removes the DNS provider. Credentials are never logged or echoed. */
  applyDnsProvider(req: DnsProviderApplyRequest | null): Promise<void>;
  sendTestMail(req: { to: string; from: string }): Promise<MailTestResult>;
  /** Fixed panel texts; the link is the only variable part and is never logged. */
  sendPanelMail(req: PanelMailRequest): Promise<PanelMailResult>;
  /** Confined to the site's files; never touches the running site container. */
  siteFiles<R extends SiteFilesRequest>(req: R): Promise<SiteFilesResult<R["op"]>>;
  siteDatabases<R extends SiteDatabasesRequest>(req: R): Promise<SiteDatabasesResult<R["op"]>>;
  /** Full desired state; an empty list removes hp_sftp (host keys stay). */
  applySftpAccess(req: SftpAccessApplyRequest): Promise<SftpApplyResult>;
  getSftpStatus(): Promise<SftpStatusReport>;
  /** Manual TLS store: PEM in, fingerprints out. Never returns a private key; errors never echo material. */
  manualTls<R extends ManualTlsRequest>(req: R): Promise<ManualTlsResult<R["action"]>>;
  backups<R extends BackupsIpcRequest>(req: R): Promise<BackupsResultByAction[R["action"]]>;
  getPanelContainers(): Promise<readonly PanelContainerStatus[]>;
  getPanelContainerLogs(req: { readonly component: PanelContainer; readonly tail: number }): Promise<readonly ServiceLogLine[]>;
  /** /bin/sh as the site type's owner in the site container; nothing typed or printed is ever logged. */
  openTerminal(req: TerminalOpenRequest): Promise<TerminalOpenResult>;
  // write, read, close and list serve the sessions of sites and of application components alike (ADR-0041).
  writeTerminal(req: { readonly sessionId: string; readonly input: string }): Promise<void>;
  /** Long poll: waits up to TERMINAL_READ_WAIT_MS when nothing is new. */
  readTerminal(req: { readonly sessionId: string; readonly cursor: number }): Promise<TerminalReadResult>;
  /** Kills the shell and its children; an ended session returns its own end and is dropped. */
  closeTerminal(req: { readonly sessionId: string }): Promise<TerminalEnded>;
  listTerminals(): Promise<readonly TerminalSessionRecord[]>;
  /** Restarts one existing panel container; never creates one. */
  restartPanelContainer(req: { readonly component: PanelContainer }): Promise<{ readonly startedAt: string | null }>;
  /** Re-ensures one pinned panel container, recreating it when its image differs from the pin. */
  applyPanelContainerPin(component: PinnedPanelContainer): Promise<PanelContainerStatus>;
}

export type TerminalExecutorEndReason = "closed" | "shell_exited" | "idle" | "time_limit" | "container_gone";
export interface TerminalEnded { readonly reason: TerminalExecutorEndReason; readonly at: string }
export interface TerminalOpenRequest { readonly sessionId: string; readonly siteId: string; readonly serviceInstanceId: string; readonly siteType?: SiteTypeKey }
export interface TerminalOpenResult { readonly containerName: string; readonly openedAt: string }
export interface TerminalReadResult { readonly output: string; readonly cursor: number; readonly dropped: boolean; readonly ended: TerminalEnded | null }
export interface SiteTerminalSessionRecord {
  readonly sessionId: string; readonly siteId: string; readonly serviceInstanceId: string;
  readonly containerName: string; readonly openedAt: string; readonly ended: TerminalEnded | null;
}
/** A session in one component of an application (ADR-0041). */
export interface AppStackTerminalSessionRecord {
  readonly sessionId: string; readonly stackId: string; readonly organizationId: string; readonly componentKey: string;
  readonly containerName: string; readonly openedAt: string; readonly ended: TerminalEnded | null;
}
export type TerminalSessionRecord = SiteTerminalSessionRecord | AppStackTerminalSessionRecord;

export type PinnedPanelContainer = (typeof PINNED_PANEL_CONTAINERS)[number];

export interface PanelContainerStatus {
  readonly component: PanelContainer;
  readonly state: PanelContainerState;
  readonly expected: boolean;
  readonly startedAt: string | null;
  readonly restartCount: number;
  /** Whether the image the container was created from is the pin; null when it does not exist. */
  readonly imageCurrent?: boolean | null;
}

export interface SiteRoutesRequest {
  readonly siteId: string;
  readonly serviceInstanceId: string;
  readonly containerName: string;
  readonly internalPort: number;
  readonly hosts: readonly SiteHostRoute[];
}

export interface ServiceLogLine {
  at: string | null;
  stream: "stdout" | "stderr";
  text: string;
}

/** One-off, allowlisted setup jobs. The API picks only the kind; the executor owns image, script and mounts. */
export type SiteJobKind =
  | "db.provision"
  | "db.drop"
  | "wordpress.install"
  | "wordpress.set-url"
  | "wordpress.inspect"
  | "wordpress.update"
  | "wordpress.settle"
  | "wordpress.reset-password"
  | "db.import"
  | "db.import-load"
  | "wordpress.import-finalize";

export interface SiteJobRequest {
  readonly jobId: string;
  readonly kind: SiteJobKind;
  readonly siteId: string;
  readonly organizationId: string;
  readonly serviceInstanceId?: string;
  readonly params: Readonly<Record<string, string>>;
  readonly resolvedSecrets?: Readonly<Record<string, string>>;
}

export interface SiteJobResult {
  readonly jobId: string;
  readonly exitCode: number;
  /** Last 50 lines, at most 4 KiB, redacted. */
  readonly outputTail: string;
  /** inspect, update and import-load only, present only when it passed the schema. */
  readonly result?: WordpressStateResult | WordpressUpdateResult | WordpressImportLoadResult;
}
