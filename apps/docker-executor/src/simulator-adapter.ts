import { X509Certificate, createHash, createPrivateKey, randomUUID } from "node:crypto";
import path from "node:path";
import {
  DEFAULT_SFTP_PORT,
  LEGACY_SITE_TYPE,
  SITE_TYPE_KEYS,
  SftpAccessApplyIpcRequestSchema,
  planManualCertificates,
  servedCertificate,
  traefikCertificateNames,
  traefikNameMatches,
  type BackupsIpcRequest,
  type BackupsResultByAction,
  type CertProblem,
  ManualTlsIpcRequestSchema,
  type ManualTlsIpcRequest,
  type ManualTlsResultByAction,
  type SniCertificate,
  type DnsProviderApplyRequest,
  type MailRelayApplyRequest,
  PANEL_CONTAINERS,
  PINNED_PANEL_CONTAINERS,
  type PanelContainer,
  PanelMailIpcRequestSchema,
  type NotificationMailRequest,
  type PanelMailRequest,
  type PanelMailResult,
  type PasswordResetMailRequest,
  type SiteTypeKey,
  type WordpressImportLoadResult,
  type WordpressStateResult,
  type WordpressUpdateResult,
  type AppImageAllowlistEntry,
  type AppStackComponentIpcRequest,
  type AppStackComponentsRemoveIpcRequest,
  type AppStackCreateIpcRequest,
  type AppStackImageResolveIpcRequest,
  type AppStackLogsIpcRequest,
  type AppStackPlanIpcRequest,
  type AppStackPullIpcRequest,
  type AppStackRefIpcRequest,
  type AppStackRemoveIpcRequest,
  type AppStackRoutesIpcRequest,
} from "@hosting-panel/contracts";
import type {
  AcmeFailure,
  ApprovedServiceSpec,
  CertificateStatusReport,
  DockerExecutionResult,
  DockerExecutorPort,
  MailRelayStatusReport,
  MailTestResult,
  PanelContainerStatus,
  PinnedPanelContainer,
  ServiceLogLine,
  SftpAccessApplyRequest,
  SftpAccessUser,
  SftpApplyResult,
  SftpStatusReport,
  SiteDatabasesRequest,
  SiteDatabasesResult,
  SiteFilesRequest,
  SiteFilesResult,
  SiteHostRoute,
  SiteJobKind,
  SiteJobRequest,
  SiteJobResult,
  SiteRoutesRequest,
  StackExecutorPort,
  StoredCertificate,
  TerminalEnded,
  TerminalOpenRequest,
  TerminalOpenResult,
  TerminalReadResult,
  TerminalSessionRecord,
} from "@hosting-panel/executor-contracts";
import { ManualTlsStoreError, normaliseEntries, type ManualTlsEntry } from "./manual-tls-store.js";
import { SimulatedSiteDatabases } from "./simulator-databases.js";
import { SimulatedBackups } from "./simulator-backups.js";
import { SimulatedSiteFiles } from "./simulator-files.js";
import { SimulatedAppStacks } from "./simulator-app-stacks.js";
import { resolveSimulatorSiteType, type SimulatorSiteType } from "./simulator-site-types.js";
import { assertValidSiteJobRequest, parseWordpressJobResult } from "./site-jobs.js";
import { renderPhpIni } from "./site-php.js";
import { maskPhpMyAdminQuery } from "./docker-logs.js";
import { startSimulatedShell } from "./simulator-terminal.js";
import { TerminalSessions, type TerminalLimits, type TerminalShellSink } from "./terminal-sessions.js";
import {
  buildHardenedContainerCreatePayload,
  detectOutOfBandContainerModification,
  isServiceHttpExposed,
  MANAGED_DOCKER_LABELS,
  mapContainerStateToObservedStatus,
  plainHostRoute,
  purgeServiceSecrets,
  validateExecutorServiceSpec,
  writeServiceSecrets,
  type DockerContainerInspectPayload,
  type ExecutorObservedServiceState,
  type ExpectedManagedServiceMetadata,
} from "./docker-engine-adapter.js";
import {
  assertSafeIdentifier,
  buildIngressProxyContainerPayload,
  buildPanelDynamicYaml,
  buildSiteDynamicTraefikYaml,
  siteRouteOptions,
  buildTraefikStaticYaml,
  DEFAULT_INGRESS_HTTP_PORT,
  DEFAULT_TRAEFIK_IMAGE,
  ExecutorCodedError,
  getSiteEdgeNetworkName,
  getSiteInternalNetworkName,
  INGRESS_BRIDGE_NETWORK_NAME,
  INGRESS_PROXY_CONTAINER_NAME,
  TraefikIngressFileManager,
  type PanelIngressConfig,
  type SiteIngressRouteEntry,
} from "./traefik-config.js";

/** Plaintext password on purpose: Task 6 tests read it; it is simulator-only state. */
export type SimulatedMailRelayState = MailRelayApplyRequest;

export interface SimulatedMailDelivery {
  readonly to: string;
  readonly from: string;
  readonly result: MailTestResult;
}

export interface OutOfBandMutationInput {
  readonly image?: string;
  readonly specHash?: string;
  readonly status?: "running" | "stopped" | "degraded";
  readonly privileged?: boolean;
  readonly capAdd?: readonly string[];
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly extraBind?: string;
  readonly restartCount?: number;
}

export interface InMemoryDockerSimulatorAdapterOptions {
  readonly secretsRootDir?: string;
  readonly ingressRootDir?: string;
  readonly traefikImage?: string;
  readonly ingressHttpPort?: number;
  readonly panel?: PanelIngressConfig | null;
  readonly dockerEngineReachable?: boolean;
  /** Short terminal limits for tests. */
  readonly terminalLimits?: Partial<TerminalLimits>;
  /** The simulator's type for a key; tests set their own type here. */
  readonly resolveSiteType?: (key: SiteTypeKey) => SimulatorSiteType;
  /** TEST SEAM: images the stack plan check accepts instead of APP_IMAGE_ALLOWLIST. Never set in production. */
  readonly appImageAllowlist?: readonly AppImageAllowlistEntry[];
}

interface MutableSimulatedContainer {
  id: string;
  name: string;
  restartCount: number;
  running: boolean;
  status: string;
  dead: boolean;
  image: string;
  env: string[];
  labels: Record<string, string>;
  privileged: boolean;
  capDrop: string[];
  capAdd: string[];
  securityOpt: string[];
  pidsLimit: number;
  nanoCpus: number;
  memory: number;
  memorySwap: number;
  restartPolicyName: string;
  networkMode: string;
  binds: string[];
  networks: Record<string, { Aliases?: readonly string[] }>;
}

const VIRTUAL_SECRETS_ROOT = "/run/hosting-panel/secrets";
const VIRTUAL_INGRESS_ROOT = "/var/lib/hosting-panel/ingress";

function buildDeterministicSimRef(prefix: string, seed: string): string {
  const hex = createHash("sha256").update(`${prefix}:${seed}:${randomUUID()}`).digest("hex");
  return hex;
}

/** What every simulated db.import-load answers. */
export const SIMULATED_IMPORT_LOAD_RESULT: WordpressImportLoadResult = { prefix: "wp_", oldUrl: "http://old.example.test", tables: 12 };

/** The state every simulated WordPress site starts with. */
export const SIMULATED_WORDPRESS_STATE: WordpressStateResult = {
  coreVersion: "7.1.4",
  coreUpdate: null,
  updatesKnown: true,
  plugins: [
    { name: "akismet", title: "Akismet Anti-spam", status: "inactive", version: "5.7.2", updateVersion: null },
    { name: "classic-editor", title: "Classic Editor", status: "active", version: "1.6.0", updateVersion: "1.7.0" },
  ],
  themes: [{ name: "twentytwentyfive", title: "Twenty Twenty-Five", status: "active", version: "1.5", updateVersion: null }],
  administrators: [{ id: 1, login: "admin" }],
};

/** Leaf of a PEM bundle; the key must belong to it. A bad PEM is TLS_MATERIAL_INVALID, like the real store. */
function parseSimulatedLeaf(fullchainPem: string, keyPem: string): X509Certificate {
  try {
    const cert = new X509Certificate(fullchainPem);
    if (!cert.checkPrivateKey(createPrivateKey(keyPem))) throw new Error("mismatch");
    return cert;
  } catch {
    throw new ManualTlsStoreError("TLS_MATERIAL_INVALID", "The certificate or its private key cannot be used");
  }
}

/** Names as Traefik indexes the leaf (CN even when it is not a SAN). */
function simulatedLeafNames(cert: X509Certificate): string[] {
  const cn = /^CN=(.*)$/m.exec(cert.subject)?.[1] ?? "";
  const dnsNames: string[] = [];
  const ipAddresses: string[] = [];
  for (const m of (cert.subjectAltName ?? "").matchAll(/(?:^|, )(DNS|IP Address):("(?:[^"\\]|\\.)*"|[^,]*)/g)) {
    const raw = m[2]!;
    (m[1] === "DNS" ? dnsNames : ipAddresses).push(raw.startsWith('"') ? (JSON.parse(raw) as string) : raw);
  }
  return traefikCertificateNames({ commonName: cn, dnsNames, ipAddresses });
}

export class InMemoryDockerSimulatorAdapter implements DockerExecutorPort, StackExecutorPort {
  public readonly isRuntimeAvailable = true;
  private readonly secretsRootDir: string | null;
  private readonly virtualSecretsRoot: string;
  private readonly ingressFileManager: TraefikIngressFileManager | null;
  private readonly traefikImage: string;
  private readonly ingressHttpPort: number;
  private readonly panel: PanelIngressConfig | null;
  private engineReachable: boolean;

  private readonly containersByServiceId = new Map<string, MutableSimulatedContainer>();
  private readonly expectedByServiceId = new Map<string, ExpectedManagedServiceMetadata>();
  private readonly virtualSecretFiles = new Map<string, Set<string>>();
  private readonly virtualSiteRoutes = new Map<string, Map<string, SiteIngressRouteEntry>>();
  private readonly serviceToSite = new Map<string, string>();
  private readonly siteServices = new Map<string, Set<string>>();
  public readonly files: SimulatedSiteFiles;
  public readonly databases = new SimulatedSiteDatabases();
  public readonly backupState = new SimulatedBackups();
  private ingressProxyContainer: MutableSimulatedContainer | null = null;
  public readonly jobs: SiteJobRequest[] = [];
  public readonly deployedSpecs: ApprovedServiceSpec[] = [];
  /** The ini text the real executor would write, per service; absent when the spec has no phpIni. */
  public readonly phpIniByService = new Map<string, string>();
  /** Latest route plan per site, from applySiteRoutes or a deploy carrying hostRoutes. */
  public readonly appliedRoutes = new Map<string, SiteRoutesRequest>();
  /** Every route plan in order. */
  public readonly routeHistory: SiteRoutesRequest[] = [];
  private readonly certificates = new Map<string, StoredCertificate>();
  private readonly certFailures: AcmeFailure[] = [];
  private certStoreReadable = true;
  private readonly manualVersions = new Map<string, { fingerprintSha256: string; names: string[]; notAfter: string }>();
  private manualState: {
    generation: number;
    current: ManualTlsEntry[];
    verified: boolean;
    lastVerified: { generation: number; entries: ManualTlsEntry[] } | null;
  } = { generation: 0, current: [], verified: true, lastVerified: null };
  private readonly manualFailures: ("not_served_reverted" | "start_failed_restored")[] = [];
  /** Every manual TLS request in order; a putVersion keeps only its id (never the PEM). */
  public readonly manualTlsCalls: unknown[] = [];
  public acmeEnabled = true;
  /** Test hook awaited inside runSiteJob. */
  public onJob?: (req: SiteJobRequest) => Promise<void>;
  /** Test hook awaited inside deployService. */
  public onDeploy?: (spec: ApprovedServiceSpec) => Promise<void>;
  private readonly failingJobs: { kind: SiteJobKind; exitCode: number; outputTail: string; stdout?: string }[] = [];
  /** Per site, seeded from SIMULATED_WORDPRESS_STATE on first use. */
  public readonly wordpressSites = new Map<string, WordpressStateResult>();
  /** false: wordpress.org is unreachable (inspect says unknown, update exits 30). */
  public wordpressOnline = true;
  private failDeployOnce = false;
  public mailRelay: SimulatedMailRelayState | null = null;
  /** Every apply in order, null for a disable. */
  public readonly mailRelayApplies: Array<MailRelayApplyRequest | null> = [];
  public readonly mailDeliveries: SimulatedMailDelivery[] = [];
  public nextTestMailResult: MailTestResult = { outcome: "sent", problem: null, detail: null };
  /** Every password reset mail request in order. */
  public readonly panelMails: PasswordResetMailRequest[] = [];
  /** Every notification mail request in order. */
  public readonly notificationMails: NotificationMailRequest[] = [];
  private failingMailApplies = 0;
  public dnsProvider: DnsProviderApplyRequest | null = null;
  public dnsProviderApplies = 0;
  private failDnsProviderApplyOnce = false;
  public sftpUsers: SftpAccessUser[] = [];
  /** Every SFTP apply request in order. */
  public readonly sftpApplies: SftpAccessApplyRequest[] = [];
  private failingSftpApplies = 0;
  private readonly serviceLogs = new Map<string, ServiceLogLine[]>();
  private readonly panelContainerOverrides = new Map<PanelContainer, Partial<Omit<PanelContainerStatus, "component">>>();
  private readonly panelContainerLogs = new Map<PanelContainer, ServiceLogLine[]>();
  private staticTraefikYaml: string | null = null;
  private readonly terminals: TerminalSessions;
  private readonly resolveSiteType: (key: SiteTypeKey) => SimulatorSiteType;
  private readonly terminalSinks = new Map<string, TerminalShellSink>();
  public readonly appStacks: SimulatedAppStacks;

  public constructor(options?: InMemoryDockerSimulatorAdapterOptions) {
    this.secretsRootDir = options?.secretsRootDir ? path.resolve(options.secretsRootDir) : null;
    this.virtualSecretsRoot = this.secretsRootDir ?? VIRTUAL_SECRETS_ROOT;
    this.ingressFileManager = options?.ingressRootDir
      ? new TraefikIngressFileManager(options.ingressRootDir, options.panel ?? null)
      : null;
    this.traefikImage = options?.traefikImage ?? DEFAULT_TRAEFIK_IMAGE;
    this.ingressHttpPort = options?.ingressHttpPort ?? DEFAULT_INGRESS_HTTP_PORT;
    this.panel = options?.panel ?? null;
    this.engineReachable = options?.dockerEngineReachable ?? true;
    this.terminals = new TerminalSessions(options?.terminalLimits);
    this.resolveSiteType = options?.resolveSiteType ?? resolveSimulatorSiteType;
    this.files = new SimulatedSiteFiles(this.resolveSiteType);
    this.appStacks = new SimulatedAppStacks({
      secretsRootDir: this.secretsRootDir,
      ingress: this.ingressFileManager,
      ...(options?.appImageAllowlist ? { allowlist: options.appImageAllowlist } : {}),
      assertEngineAvailable: () => this.assertEngineAvailable(),
    });
  }

  public setEngineReachable(reachable: boolean): void {
    this.engineReachable = reachable;
  }

  public async pingEngine(): Promise<boolean> {
    return this.engineReachable;
  }

  public async ensureIngressProxy(): Promise<{
    readonly component: "ingress_proxy";
    readonly status: "running";
    readonly ensuredAt: string;
  }> {
    this.assertEngineAvailable();

    let staticPath = `${VIRTUAL_INGRESS_ROOT}/static/traefik.yml`;
    let dynamicPath = `${VIRTUAL_INGRESS_ROOT}/dynamic`;
    let acmePath = `${VIRTUAL_INGRESS_ROOT}/acme`;
    if (this.ingressFileManager) {
      const paths = await this.ingressFileManager.ensureStaticConfig(this.panel);
      staticPath = paths.staticConfigPath;
      dynamicPath = paths.dynamicDirPath;
      acmePath = paths.acmeDirPath;
    } else if (this.panel) {
      buildPanelDynamicYaml(this.panel); // same validation as the on-disk path
    }
    this.staticTraefikYaml = buildTraefikStaticYaml(this.panel);

    const payload = buildIngressProxyContainerPayload({
      traefikImage: this.traefikImage,
      httpHostPort: this.ingressHttpPort,
      staticConfigHostPath: staticPath,
      dynamicDirHostPath: dynamicPath,
      acmeDirHostPath: acmePath,
    });

    if (!this.ingressProxyContainer) {
      this.ingressProxyContainer = {
        id: buildDeterministicSimRef("ingress", INGRESS_PROXY_CONTAINER_NAME),
        name: `/${INGRESS_PROXY_CONTAINER_NAME}`,
        restartCount: 0,
        running: true,
        status: "running",
        dead: false,
        image: payload.Image,
        env: [],
        labels: { ...payload.Labels },
        privileged: payload.HostConfig.Privileged,
        capDrop: [...payload.HostConfig.CapDrop],
        capAdd: [...payload.HostConfig.CapAdd],
        securityOpt: [...payload.HostConfig.SecurityOpt],
        pidsLimit: payload.HostConfig.PidsLimit,
        nanoCpus: 250_000_000,
        memory: 268_435_456,
        memorySwap: 268_435_456,
        restartPolicyName: payload.HostConfig.RestartPolicy.Name,
        networkMode: payload.HostConfig.NetworkMode,
        binds: [...payload.HostConfig.Binds],
        networks: {
          [INGRESS_BRIDGE_NETWORK_NAME]: { Aliases: [INGRESS_PROXY_CONTAINER_NAME] },
        },
      };
    } else {
      this.ingressProxyContainer.running = true;
      this.ingressProxyContainer.status = "running";
    }

    return {
      component: "ingress_proxy",
      status: "running",
      ensuredAt: new Date().toISOString(),
    };
  }

  /** stdout: the raw result text, checked by the same parser as the real adapter. */
  public failNextJob(kind: SiteJobKind, exitCode: number, outputTail = "", stdout?: string): void {
    this.failingJobs.push({ kind, exitCode, outputTail, ...(stdout !== undefined ? { stdout } : {}) });
  }

  public failNextMailRelayApply(n = 1): void {
    this.failingMailApplies = n;
  }

  public async applyMailRelay(req: MailRelayApplyRequest | null): Promise<void> {
    if (this.failingMailApplies > 0) {
      this.failingMailApplies -= 1;
      throw new ExecutorCodedError("Simulated mail relay apply failure", "DOCKER_ENGINE_UNAVAILABLE");
    }
    this.mailRelayApplies.push(req === null ? null : { ...req });
    this.mailRelay = req === null ? null : { ...req };
  }

  public failNextDnsProviderApply(): void {
    this.failDnsProviderApplyOnce = true;
  }

  public async applyDnsProvider(req: DnsProviderApplyRequest | null): Promise<void> {
    if (this.failDnsProviderApplyOnce) {
      this.failDnsProviderApplyOnce = false;
      throw new ExecutorCodedError("Simulated DNS provider apply failure", "DOCKER_ENGINE_UNAVAILABLE");
    }
    this.dnsProviderApplies += 1;
    this.dnsProvider = req === null ? null : structuredClone(req);
  }

  public async getMailRelayStatus(_req: { since: string }): Promise<MailRelayStatusReport> {
    const present = this.mailRelay !== null;
    return { present, running: present, sentCount: this.mailDeliveries.length, failures: [] };
  }

  public async sendTestMail(req: { to: string; from: string }): Promise<MailTestResult> {
    if (this.mailRelay === null) {
      throw new ExecutorCodedError("Mail relay is not running", "MAIL_RELAY_UNAVAILABLE");
    }
    const result = { ...this.nextTestMailResult };
    this.mailDeliveries.push({ to: req.to, from: req.from, result });
    return result;
  }

  public async sendPanelMail(req: PanelMailRequest): Promise<PanelMailResult> {
    const parsed = PanelMailIpcRequestSchema.safeParse(req);
    if (!parsed.success) throw new ExecutorCodedError("Invalid panel mail", "VALIDATION_ERROR");
    if (parsed.data.kind === "notification") this.notificationMails.push(parsed.data);
    else this.panelMails.push(parsed.data);
    return { outcome: this.mailRelay ? "queued" : "failed" };
  }

  public failNextSftpApply(n = 1): void {
    this.failingSftpApplies = n;
  }

  public async applySftpAccess(req: SftpAccessApplyRequest): Promise<SftpApplyResult> {
    const parsed = SftpAccessApplyIpcRequestSchema.safeParse(req);
    if (!parsed.success) {
      throw new ExecutorCodedError("Invalid SFTP access configuration", "VALIDATION_ERROR");
    }
    if (this.failingSftpApplies > 0) {
      this.failingSftpApplies -= 1;
      throw new ExecutorCodedError("Simulated SFTP apply failure", "DOCKER_ENGINE_UNAVAILABLE");
    }
    const copy: SftpAccessApplyRequest = {
      users: parsed.data.users.map((u) => ({ ...u })),
    };
    this.sftpApplies.push(copy);
    this.sftpUsers = parsed.data.users.map((u) => ({ ...u }));
    return { applied: copy.users.length };
  }

  public async getSftpStatus(): Promise<SftpStatusReport> {
    return { running: false, port: DEFAULT_SFTP_PORT, hostKeyFingerprint: null };
  }

  public failNextDeploy(): void {
    this.failDeployOnce = true;
  }

  public setServiceLogs(serviceInstanceId: string, lines: ServiceLogLine[]): void {
    this.serviceLogs.set(serviceInstanceId, lines);
  }

  /** Overrides fields of one panel container's status over the defaults. */
  public setPanelContainer(component: PanelContainer, partial: Partial<Omit<PanelContainerStatus, "component">>): void {
    this.panelContainerOverrides.set(component, { ...this.panelContainerOverrides.get(component), ...partial });
  }

  /** Sets the log lines one panel container returns. */
  public setPanelContainerLogs(component: PanelContainer, lines: ServiceLogLine[]): void {
    this.panelContainerLogs.set(component, lines);
  }

  public async runSiteJob(req: SiteJobRequest): Promise<SiteJobResult> {
    this.assertEngineAvailable();
    assertValidSiteJobRequest(req);
    this.jobs.push(req);
    await this.onJob?.(req);
    const idx = this.failingJobs.findIndex((f) => f.kind === req.kind);
    const failure = idx >= 0 ? this.failingJobs.splice(idx, 1)[0] : undefined;
    const run = failure ?? { exitCode: 0, outputTail: "", ...this.simulateWordpressJob(req) };
    const exitCode = run.exitCode;
    if (exitCode === 0) {
      if (req.kind === "db.provision") {
        this.databases.provision(req.siteId);
      } else if (req.kind === "db.drop") {
        this.databases.drop(req.siteId);
      }
    }
    const result = run.stdout === undefined ? undefined : parseWordpressJobResult(req.kind, run.stdout);
    return {
      jobId: req.jobId,
      exitCode,
      outputTail: run.outputTail,
      ...(result !== undefined ? { result } : {}),
    };
  }

  /** The effect and stdout of inspect, update and reset on the site's stored state, and the import load's answer. */
  private simulateWordpressJob(req: SiteJobRequest): { exitCode?: number; stdout?: string } {
    if (req.kind === "db.import-load") return { stdout: `${JSON.stringify(SIMULATED_IMPORT_LOAD_RESULT)}\n` };
    if (req.kind !== "wordpress.inspect" && req.kind !== "wordpress.update" && req.kind !== "wordpress.reset-password") {
      return {};
    }
    let site = this.wordpressSites.get(req.siteId);
    if (site === undefined) {
      site = structuredClone(SIMULATED_WORDPRESS_STATE);
      this.wordpressSites.set(req.siteId, site);
    }
    const line = (v: unknown) => `${JSON.stringify(v)}\n`;
    if (req.kind === "wordpress.reset-password") {
      return { exitCode: site.administrators.some((a) => String(a.id) === req.params.userId) ? 0 : 40 };
    }
    if (req.kind === "wordpress.inspect") {
      if (this.wordpressOnline) return { stdout: line(site) };
      const unknown = <T>(i: T) => ({ ...i, updateVersion: null });
      return {
        stdout: line({ ...site, coreUpdate: null, updatesKnown: false, plugins: site.plugins.map(unknown), themes: site.themes.map(unknown) }),
      };
    }
    if (!this.wordpressOnline) return { exitCode: 30 };
    const target = req.params.target ?? "";
    const items: WordpressUpdateResult["items"] = [];
    if ((target === "core" || target === "all") && site.coreUpdate !== null) {
      items.push({ type: "core", name: "wordpress", oldVersion: site.coreVersion, newVersion: site.coreUpdate, status: "updated" });
      site.coreVersion = site.coreUpdate;
      site.coreUpdate = null;
    }
    for (const [type, list] of [["plugin", site.plugins], ["theme", site.themes]] as const) {
      if (target.startsWith(`${type}:`) && !list.some((i) => `${type}:${i.name}` === target)) return { exitCode: 31 };
      for (const item of list) {
        if ((target === "all" || target === `${type}:${item.name}`) && item.updateVersion !== null) {
          items.push({ type, name: item.name, oldVersion: item.version, newVersion: item.updateVersion, status: "updated" });
          item.version = item.updateVersion;
          item.updateVersion = null;
        }
      }
    }
    return { stdout: line({ items }) };
  }

  public async siteFiles<R extends SiteFilesRequest>(req: R): Promise<SiteFilesResult<R["op"]>> {
    this.assertEngineAvailable();
    return this.files.handle(req);
  }

  public async siteDatabases<R extends SiteDatabasesRequest>(
    req: R,
  ): Promise<SiteDatabasesResult<R["op"]>> {
    this.assertEngineAvailable();
    return this.databases.handle(req);
  }

  public async backups<R extends BackupsIpcRequest>(
    req: R,
  ): Promise<BackupsResultByAction[R["action"]]> {
    this.assertEngineAvailable();
    return this.backupState.handle(req);
  }

  /**
   * In-memory manual TLS store: same plan function as the real executor over the simulator's ACME certificates
   * (names = [hostname]) and the hosts of the applied routes, and the "served" certificate is the computed winner.
   */
  public async manualTls<R extends ManualTlsIpcRequest>(req: R): Promise<ManualTlsResultByAction[R["action"]]> {
    this.assertEngineAvailable();
    const parsed = ManualTlsIpcRequestSchema.safeParse(req);
    if (!parsed.success) throw new ExecutorCodedError("Invalid manual TLS payload", "VALIDATION_ERROR");
    const body = parsed.data;
    this.manualTlsCalls.push(body.action === "putVersion" ? { action: "putVersion", versionId: body.versionId } : body);
    switch (body.action) {
      case "putVersion": {
        const x509 = parseSimulatedLeaf(body.fullchainPem, body.keyPem);
        const fingerprintSha256 = x509.fingerprint256.replaceAll(":", "").toLowerCase();
        if (fingerprintSha256 !== body.fingerprintSha256) {
          throw new ManualTlsStoreError("TLS_MATERIAL_INVALID", "The certificate does not match the announced fingerprint");
        }
        const existing = this.manualVersions.get(body.versionId);
        if (existing) {
          if (existing.fingerprintSha256 !== fingerprintSha256) {
            throw new ManualTlsStoreError("TLS_VERSION_CONFLICT", "The version already holds other material");
          }
          return { versionId: body.versionId, written: false } as ManualTlsResultByAction[R["action"]];
        }
        this.manualVersions.set(body.versionId, {
          fingerprintSha256,
          names: simulatedLeafNames(x509),
          notAfter: x509.validToDate.toISOString(),
        });
        return { versionId: body.versionId, written: true } as ManualTlsResultByAction[R["action"]];
      }
      case "publish":
        return this.publishManualTls(body) as ManualTlsResultByAction[R["action"]];
      case "probe":
        return { served: this.simulatedServed(body.hostnames) } as ManualTlsResultByAction[R["action"]];
      case "inventory":
        return {
          generation: this.manualState.generation,
          verified: this.manualState.verified,
          versions: [...this.manualVersions].sort(([a], [b]) => (a < b ? -1 : 1)).map(([versionId, v]) => ({
            versionId,
            fingerprintSha256: v.fingerprintSha256,
            notAfter: v.notAfter,
            names: [...v.names],
          })),
          entries: this.manualState.current.map((e) => ({ versionId: e.versionId, assignedHosts: [...e.assignedHosts] })),
          missing: [],
          acme: [...this.certificates.values()].map((c) => ({
            id: `sim#${c.hostname}`,
            resolver: "le",
            names: [c.hostname.toLowerCase()],
            notAfter: c.notAfter,
          })),
        } as ManualTlsResultByAction[R["action"]];
      case "gc": {
        if (body.baseGeneration !== this.manualState.generation) {
          throw new ManualTlsStoreError("TLS_MANIFEST_CONFLICT", "The manual certificate set changed since it was read");
        }
        const keep = new Set(
          [...this.manualState.current, ...(this.manualState.lastVerified?.entries ?? [])].map((e) => e.versionId),
        );
        const removed: string[] = [];
        if (this.manualState.verified && this.manualState.generation > 0) {
          for (const id of [...this.manualVersions.keys()].sort()) {
            if (keep.has(id)) continue;
            this.manualVersions.delete(id);
            removed.push(id);
          }
        }
        return { removed } as ManualTlsResultByAction[R["action"]];
      }
    }
  }

  /** The next `times` manual TLS publishes end in this outcome (start_failed_restored needs an ACME eviction). */
  public failManualTlsPublish(outcome: "not_served_reverted" | "start_failed_restored" = "not_served_reverted", times = 1): void {
    this.manualFailures.push(...Array.from({ length: times }, () => outcome));
  }

  private simulatedRoutedHosts(): string[] {
    const hosts = new Set<string>();
    if (this.panel) hosts.add(this.panel.hostname.trim().toLowerCase());
    for (const route of this.appliedRoutes.values()) for (const h of route.hosts) hosts.add(h.hostname.toLowerCase());
    return [...hosts];
  }

  private simulatedAcme(): SniCertificate[] {
    return [...this.certificates.values()].map((c) => ({ id: `sim#${c.hostname}`, source: "acme", names: [c.hostname.toLowerCase()] }));
  }

  /** Winner of the SNI selection for each host, as a fingerprint (ACME: a stable fake one). */
  private simulatedServed(hostnames: readonly string[]): { hostname: string; fingerprintSha256: string | null }[] {
    const certs: SniCertificate[] = [
      ...this.manualState.current.flatMap((e) => {
        const v = this.manualVersions.get(e.versionId);
        return v ? [{ id: e.versionId, source: "manual" as const, names: v.names }] : [];
      }),
      ...this.simulatedAcme(),
    ];
    return [...new Set(hostnames)].map((hostname) => {
      const winner = servedCertificate(hostname.toLowerCase(), certs).winner;
      const fingerprintSha256 = !winner
        ? null
        : winner.source === "manual"
          ? (this.manualVersions.get(winner.id)?.fingerprintSha256 ?? null)
          : createHash("sha256").update(`sim-acme:${winner.id}`).digest("hex");
      return { hostname, fingerprintSha256 };
    });
  }

  private publishManualTls(
    body: Extract<ReturnType<typeof ManualTlsIpcRequestSchema.parse>, { action: "publish" }>,
  ): ManualTlsResultByAction["publish"] {
    const wanted = normaliseEntries(body.entries);
    const state = this.manualState;
    const replay =
      state.generation === body.baseGeneration + 1 && JSON.stringify(state.current) === JSON.stringify(wanted);
    if (!replay && state.generation !== body.baseGeneration) {
      throw new ManualTlsStoreError("TLS_MANIFEST_CONFLICT", "The manual certificate set changed since it was read");
    }
    const missing = wanted.map((e) => e.versionId).filter((id) => !this.manualVersions.has(id));
    if (missing.length > 0) {
      throw new ManualTlsStoreError("TLS_VERSION_MISSING", "Certificate versions are missing on the executor", missing);
    }
    const assigned = new Set(wanted.flatMap((e) => e.assignedHosts));
    const plan = planManualCertificates({
      entries: wanted.map((e) => ({ versionId: e.versionId, names: this.manualVersions.get(e.versionId)!.names, assignedHosts: e.assignedHosts })),
      acme: this.simulatedAcme(),
      guardHosts: this.simulatedRoutedHosts().filter((h) => !assigned.has(h)),
    });
    const refusal = (outcome: ManualTlsResultByAction["publish"]["outcome"]): ManualTlsResultByAction["publish"] => ({
      generation: state.generation,
      outcome,
      served: [],
      violations: plan.violations.map((v) => ({ ...v, blockerIds: [...v.blockerIds] })),
      evicted: [],
      collateralHosts: [],
    });
    const hard = plan.violations.filter((v) => v.kind !== "acme_eviction_required");
    if (hard.length > 0) return refusal(hard.some((v) => v.kind === "manual_overlap") ? "manual_overlap" : "captures_host");
    const needsEviction = plan.violations.length > 0;
    if (needsEviction && !body.evictAcme) return refusal("acme_eviction_required");

    const forced = this.manualFailures[0];
    const evictHosts = plan.violations.map((v) => v.hostname.toLowerCase());
    const removedAcme = needsEviction
      ? [...this.certificates.values()].filter((c) => evictHosts.some((h) => traefikNameMatches(h, c.hostname.toLowerCase())))
      : [];
    for (const c of removedAcme) this.certificates.delete(c.hostname);
    const evicted = removedAcme.map((c) => ({ resolver: "le", main: c.hostname }));

    const generation = replay ? state.generation : state.generation + 1;
    if (!replay) {
      this.manualState = { generation, current: wanted, verified: false, lastVerified: state.lastVerified };
    }
    const revert = (): void => {
      const last = this.manualState.lastVerified ?? { generation, entries: [] };
      this.manualState = { generation, current: [...last.entries], verified: true, lastVerified: last };
    };
    const done = (outcome: ManualTlsResultByAction["publish"]["outcome"]): ManualTlsResultByAction["publish"] => ({
      generation,
      outcome,
      served: this.simulatedServed(body.expect.map((e) => e.hostname)),
      violations: [],
      evicted,
      collateralHosts: needsEviction ? [...plan.collateralHosts] : [],
    });
    if (forced === "start_failed_restored" && needsEviction) {
      this.manualFailures.shift();
      for (const c of removedAcme) this.certificates.set(c.hostname, c);
      revert();
      return { ...done("start_failed_restored"), evicted: [] };
    }
    // A reverted publish puts the removed ACME entries back, like the real adapter's acme.json restore.
    const restoreAcme = (): void => {
      for (const c of removedAcme) this.certificates.set(c.hostname, c);
    };
    if (forced === "not_served_reverted") {
      this.manualFailures.shift();
      const result = { ...done("not_served_reverted"), evicted: [], collateralHosts: [] };
      restoreAcme();
      revert();
      return { ...result, served: result.served.map((s) => ({ ...s, fingerprintSha256: null })) };
    }
    const served = this.simulatedServed(body.expect.map((e) => e.hostname));
    const ok = body.expect.every((e) => {
      const seen = served.find((s) => s.hostname === e.hostname)?.fingerprintSha256 ?? null;
      if (seen === null) return false;
      if (e.fingerprintSha256 !== undefined && seen !== e.fingerprintSha256) return false;
      return e.notFingerprintSha256 === undefined || seen !== e.notFingerprintSha256;
    });
    if (!ok) {
      restoreAcme();
      revert();
      return { ...done("not_served_reverted"), served, evicted: [], collateralHosts: [] };
    }
    this.manualState = { generation, current: wanted, verified: true, lastVerified: { generation, entries: wanted } };
    return done("served");
  }

  public async purgeSite(siteId: string): Promise<void> {
    this.assertEngineAvailable();
    assertSafeIdentifier(siteId, "siteId");
    for (const [serviceId, expected] of [...this.expectedByServiceId]) {
      if (expected.siteId === siteId) {
        await this.deleteService(serviceId);
      }
    }
    for (const serviceId of this.siteServices.get(siteId) ?? []) {
      this.files.drop(serviceId);
    }
    this.siteServices.delete(siteId);
  }

  public async applySiteRoutes(req: SiteRoutesRequest): Promise<void> {
    this.assertEngineAvailable();
    assertSafeIdentifier(req.siteId, "siteId");
    const expected = this.expectedByServiceId.get(req.serviceInstanceId);
    if (
      !expected ||
      expected.siteId !== req.siteId ||
      expected.containerName !== req.containerName
    ) {
      throw new ExecutorCodedError("Managed service container not found", "NOT_FOUND");
    }
    await this.applyRoutes(req);
  }

  public async getCertificateStatus(req: { failuresSince: string }): Promise<CertificateStatusReport> {
    const since = Date.parse(req.failuresSince);
    return {
      acmeEnabled: this.acmeEnabled,
      dnsChallenge: this.acmeEnabled && this.dnsProvider !== null,
      trusted: true,
      readable: this.certStoreReadable,
      certificates: this.certStoreReadable ? [...this.certificates.values()] : [],
      failures: this.certFailures.filter((f) => Date.parse(f.at) >= since),
    };
  }

  public issueCertificate(hostname: string, notAfter: string): void {
    this.certificates.set(hostname, { hostname, notAfter, serialNumber: `sim-${hostname}` });
  }

  public removeCertificate(hostname: string): void {
    this.certificates.delete(hostname);
  }

  public failCertificate(
    hostname: string,
    problem: CertProblem,
    at = new Date().toISOString(),
    kind: AcmeFailure["kind"] = "obtain",
  ): void {
    this.certFailures.push({ hostname, at, kind, problem, detail: `simulated ${problem}` });
  }

  public setCertificateStoreReadable(readable: boolean): void {
    this.certStoreReadable = readable;
  }

  private async applyRoutes(req: SiteRoutesRequest): Promise<boolean> {
    if (req.hosts.length > 0) {
      await this.ensureIngressProxy();
      if (this.ingressProxyContainer) {
        this.ingressProxyContainer.networks[getSiteEdgeNetworkName(req.siteId)] = {};
      }
      const routeEntry: SiteIngressRouteEntry = {
        serviceInstanceId: req.serviceInstanceId,
        containerName: req.containerName,
        internalPort: req.internalPort,
        hosts: req.hosts,
      };
      // The real manager validates the hosts first, so a refused plan leaves no trace here.
      if (this.ingressFileManager) {
        await this.ingressFileManager.upsertServiceRoute(req.siteId, routeEntry);
      }
      this.upsertVirtualRoute(req.siteId, routeEntry);
      this.appliedRoutes.set(req.siteId, req);
      this.routeHistory.push(req);
      return true;
    }
    this.removeVirtualRoute(req.serviceInstanceId);
    if (this.ingressFileManager) {
      await this.ingressFileManager.removeServiceRoute(req.serviceInstanceId, req.siteId);
    }
    this.appliedRoutes.set(req.siteId, req);
    this.routeHistory.push(req);
    return false;
  }

  public async getServiceLogs(
    serviceInstanceId: string,
    tail: number,
  ): Promise<readonly ServiceLogLine[]> {
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    return (this.serviceLogs.get(serviceInstanceId) ?? []).slice(-Math.max(1, tail));
  }

  public async getPanelContainers(): Promise<readonly PanelContainerStatus[]> {
    this.assertEngineAvailable();
    return PANEL_CONTAINERS.map((component) => this.panelContainerStatus(component));
  }

  public async getPanelContainerLogs(req: {
    readonly component: PanelContainer;
    readonly tail: number;
  }): Promise<readonly ServiceLogLine[]> {
    this.assertEngineAvailable();
    if (this.panelContainerStatus(req.component).state === "missing") {
      throw new ExecutorCodedError("Panel container not found", "NOT_FOUND");
    }
    const lines = (this.panelContainerLogs.get(req.component) ?? []).slice(-Math.max(1, req.tail));
    return req.component === "phpmyadmin" ? lines.map((line) => ({ ...line, text: maskPhpMyAdminQuery(line.text) })) : lines;
  }

  /** Restarts an existing panel container: a new start time and a restart count of 0. */
  public async restartPanelContainer(req: { readonly component: PanelContainer }): Promise<{ readonly startedAt: string | null }> {
    this.assertEngineAvailable();
    if (this.panelContainerStatus(req.component).state === "missing") {
      throw new ExecutorCodedError("Panel container not found", "NOT_FOUND");
    }
    const startedAt = new Date().toISOString();
    this.setPanelContainer(req.component, { state: "running", startedAt, restartCount: 0 });
    return { startedAt };
  }

  /** Moves an existing pinned panel container to its pin; answers as the real one. */
  public async applyPanelContainerPin(component: PinnedPanelContainer): Promise<PanelContainerStatus> {
    this.assertEngineAvailable();
    if (!(PINNED_PANEL_CONTAINERS as readonly string[]).includes(component)) {
      throw new ExecutorCodedError("Invalid panel apply request", "VALIDATION_ERROR");
    }
    if (this.panelContainerStatus(component).state === "missing") {
      throw new ExecutorCodedError("Panel container not found", "NOT_FOUND");
    }
    this.setPanelContainer(component, { imageCurrent: true });
    return this.panelContainerStatus(component);
  }

  /** A fake shell in a running container of that site. */
  public async openTerminal(req: TerminalOpenRequest): Promise<TerminalOpenResult> {
    this.assertEngineAvailable();
    const type = this.resolveSiteType(req.siteType ?? LEGACY_SITE_TYPE);
    return this.terminals.open(req, async (sink) => {
      const container = this.containersByServiceId.get(req.serviceInstanceId);
      if (!container?.running || this.expectedByServiceId.get(req.serviceInstanceId)?.siteId !== req.siteId) {
        throw new ExecutorCodedError("Site container not found", "NOT_FOUND");
      }
      this.terminalSinks.set(req.sessionId, sink);
      // The sink holds the session's output: let go of it however the session ends.
      const forget = () => this.terminalSinks.delete(req.sessionId);
      const shell = startSimulatedShell({ data: sink.data, exit: (reason) => { forget(); sink.exit(reason); } }, type);
      return { shell: { write: (bytes) => shell.write(bytes), kill: () => { forget(); return shell.kill(); } }, containerName: container.name.slice(1) };
    });
  }

  public async writeTerminal(req: { readonly sessionId: string; readonly input: string }): Promise<void> {
    this.assertEngineAvailable();
    this.terminals.write(req);
  }

  public async readTerminal(req: { readonly sessionId: string; readonly cursor: number }): Promise<TerminalReadResult> {
    this.assertEngineAvailable();
    return this.terminals.read(req);
  }

  public async closeTerminal(req: { readonly sessionId: string }): Promise<TerminalEnded> {
    this.assertEngineAvailable();
    return this.terminals.close(req);
  }

  public async listTerminals(): Promise<readonly TerminalSessionRecord[]> {
    this.assertEngineAvailable();
    return this.terminals.list();
  }

  /** Test hook: output from the shell of that session, as if it printed it. */
  public emitTerminalOutput(sessionId: string, text: string): void {
    this.terminalSinks.get(sessionId)?.data(Buffer.from(text, "utf8"));
  }

  /** Test hook: forgets every session, as an executor restart does. */
  public forgetTerminalSessions(): void {
    this.terminals.forgetAll();
  }

  private panelContainerStatus(component: PanelContainer): PanelContainerStatus {
    const on = (expected: boolean) => ({ state: expected ? "running" : "missing", expected }) as const;
    const base =
      component === "ingress_proxy"
        ? { state: "running", expected: this.panel !== null } as const
        : component === "shared_database"
          ? on(true)
          : component === "phpmyadmin"
            ? on(false)
            : component === "sftp"
              ? on(this.sftpUsers.length > 0)
              : on(this.mailRelay !== null);
    const status = { component, ...base, startedAt: null, restartCount: 0, imageCurrent: true, ...this.panelContainerOverrides.get(component) };
    return status.state === "missing" ? { ...status, imageCurrent: null } : status;
  }

  public async deployService(rawSpec: ApprovedServiceSpec): Promise<DockerExecutionResult> {
    this.assertEngineAvailable();
    await this.onDeploy?.(rawSpec);
    if (this.failDeployOnce) {
      this.failDeployOnce = false;
      throw new ExecutorCodedError("Simulated deploy failure", "DOCKER_ENGINE_UNAVAILABLE");
    }
    const spec = validateExecutorServiceSpec(rawSpec, siteRouteOptions(this.panel).reservedHosts);
    this.deployedSpecs.push(rawSpec);
    if (spec.phpIni && Object.keys(spec.phpIni).length > 0) {
      this.phpIniByService.set(spec.serviceInstanceId, renderPhpIni(spec.phpIni));
    } else {
      this.phpIniByService.delete(spec.serviceInstanceId);
    }

    for (const [existingSvcId, existingCtr] of this.containersByServiceId) {
      if (existingSvcId !== spec.serviceInstanceId && existingCtr.name === `/${spec.containerName}`) {
        throw new ExecutorCodedError(
          "Target container name is already bound to another service instance",
          "RESOURCE_LOCKED",
        );
      }
    }

    let secretBinds: readonly string[];
    let secretFileEnv: readonly string[];

    if (this.secretsRootDir) {
      const diskSecrets = await writeServiceSecrets(
        this.secretsRootDir,
        spec.serviceInstanceId,
        spec.resolvedSecrets,
      );
      secretBinds = diskSecrets.secretBinds;
      secretFileEnv = diskSecrets.secretFileEnv;
    } else {
      const sortedSecretNames = Object.keys(spec.resolvedSecrets ?? {}).sort((a, b) =>
        a.localeCompare(b),
      );
      if (sortedSecretNames.length > 0) {
        this.virtualSecretFiles.set(spec.serviceInstanceId, new Set(sortedSecretNames));
      } else {
        this.virtualSecretFiles.delete(spec.serviceInstanceId);
      }
      secretBinds = sortedSecretNames.map(
        (envName) =>
          `${path.resolve(this.virtualSecretsRoot, spec.serviceInstanceId, envName)}:/run/secrets/${envName}:ro`,
      );
      secretFileEnv = sortedSecretNames.map((envName) => `${envName}_FILE=/run/secrets/${envName}`);
    }

    const createPayload = buildHardenedContainerCreatePayload(spec, {
      secretBinds,
      secretFileEnv,
    });

    const siteNetworkName = getSiteInternalNetworkName(spec.siteId);
    const networks: Record<string, { Aliases?: readonly string[] }> = {
      [siteNetworkName]: { Aliases: [spec.containerName] },
    };

    if (isServiceHttpExposed(spec)) {
      const edgeNetworkName = getSiteEdgeNetworkName(spec.siteId);
      networks[edgeNetworkName] = { Aliases: [spec.containerName] };
    }

    const containerId = buildDeterministicSimRef("svc", spec.serviceInstanceId);
    const simulated: MutableSimulatedContainer = {
      id: containerId,
      name: `/${spec.containerName}`,
      restartCount: 0,
      running: true,
      status: "running",
      dead: false,
      image: createPayload.Image,
      env: [...createPayload.Env],
      labels: { ...createPayload.Labels },
      privileged: createPayload.HostConfig.Privileged,
      capDrop: [...createPayload.HostConfig.CapDrop],
      capAdd: [...(createPayload.HostConfig.CapAdd ?? [])],
      securityOpt: [...createPayload.HostConfig.SecurityOpt],
      pidsLimit: createPayload.HostConfig.PidsLimit,
      nanoCpus: createPayload.HostConfig.NanoCpus,
      memory: createPayload.HostConfig.Memory,
      memorySwap: createPayload.HostConfig.MemorySwap,
      restartPolicyName: createPayload.HostConfig.RestartPolicy.Name,
      networkMode: createPayload.HostConfig.NetworkMode,
      binds: [...createPayload.HostConfig.Binds],
      networks,
    };

    this.terminals.endService(spec.serviceInstanceId, "container_gone");
    this.containersByServiceId.set(spec.serviceInstanceId, simulated);
    this.expectedByServiceId.set(spec.serviceInstanceId, {
      serviceInstanceId: spec.serviceInstanceId,
      siteId: spec.siteId,
      organizationId: spec.organizationId,
      image: spec.image,
      containerName: spec.containerName,
      specHash: spec.specHash ?? "",
      revisionNumber: spec.revisionNumber ?? 1,
      expectedEnv: createPayload.Env,
    });
    let svcs = this.siteServices.get(spec.siteId);
    if (!svcs) {
      svcs = new Set();
      this.siteServices.set(spec.siteId, svcs);
    }
    svcs.add(spec.serviceInstanceId);
    const filesType = SITE_TYPE_KEYS.map((k) => this.resolveSiteType(k)).find((t) =>
      spec.volumeMounts?.some((m) => m.volumeSuffix === t.def.files.volumeSuffix),
    );
    if (filesType) {
      this.files.create(spec.serviceInstanceId, filesType);
    }

    const hosts: readonly SiteHostRoute[] =
      spec.hostRoutes ?? (spec.domains ?? []).map(plainHostRoute);
    const planned: SiteRoutesRequest = {
      siteId: spec.siteId,
      serviceInstanceId: spec.serviceInstanceId,
      containerName: spec.containerName,
      internalPort: spec.internalPort ?? spec.portBindings[0]?.containerPort ?? 80,
      hosts,
    };
    let ingressConfigured: boolean;
    if (spec.hostRoutes !== undefined) {
      ingressConfigured = await this.applyRoutes(planned);
    } else if (hosts.length > 0) {
      // Plain domains: configured as before, but not recorded as a route plan.
      await this.ensureIngressProxy();
      if (this.ingressProxyContainer) {
        this.ingressProxyContainer.networks[getSiteEdgeNetworkName(spec.siteId)] = {};
      }
      const routeEntry: SiteIngressRouteEntry = { ...planned };
      this.upsertVirtualRoute(spec.siteId, routeEntry);
      if (this.ingressFileManager) {
        await this.ingressFileManager.upsertServiceRoute(spec.siteId, routeEntry);
      }
      ingressConfigured = true;
    } else {
      ingressConfigured = false;
      this.removeVirtualRoute(spec.serviceInstanceId);
      if (this.ingressFileManager) {
        await this.ingressFileManager.removeServiceRoute(spec.serviceInstanceId, spec.siteId);
      }
    }

    return {
      operationId: `sim_op_${randomUUID()}`,
      status: "succeeded",
      message: "Simulated service container deployed with hardened isolation policy",
      internalDockerRef: containerId,
      containerStatus: "running",
      ingressConfigured,
    };
  }

  public async restartService(
    serviceInstanceId: string,
    resolvedSecrets?: Readonly<Record<string, string>>,
  ): Promise<DockerExecutionResult> {
    this.assertEngineAvailable();
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    const container = this.containersByServiceId.get(serviceInstanceId);
    if (!container) {
      throw new ExecutorCodedError("Managed service container not found", "NOT_FOUND");
    }
    if (resolvedSecrets && Object.keys(resolvedSecrets).length > 0) {
      if (this.secretsRootDir) {
        await writeServiceSecrets(this.secretsRootDir, serviceInstanceId, resolvedSecrets, { additive: true });
      } else {
        const names = this.virtualSecretFiles.get(serviceInstanceId) ?? new Set<string>();
        for (const name of Object.keys(resolvedSecrets)) {
          names.add(name);
        }
        this.virtualSecretFiles.set(serviceInstanceId, names);
      }
    }

    container.running = true;
    container.status = "running";
    container.dead = false;
    this.terminals.endService(serviceInstanceId, "container_gone");

    return {
      operationId: `sim_op_${randomUUID()}`,
      status: "succeeded",
      message: "Simulated service container restarted",
      internalDockerRef: container.id,
      containerStatus: "running",
    };
  }

  public async stopService(serviceInstanceId: string): Promise<DockerExecutionResult> {
    this.assertEngineAvailable();
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    const container = this.containersByServiceId.get(serviceInstanceId);
    if (!container) {
      await this.cleanupSecrets(serviceInstanceId);
      throw new ExecutorCodedError("Managed service container not found", "NOT_FOUND");
    }

    container.running = false;
    container.status = "exited";
    this.terminals.endService(serviceInstanceId, "container_gone");
    await this.cleanupSecrets(serviceInstanceId);

    return {
      operationId: `sim_op_${randomUUID()}`,
      status: "succeeded",
      message: "Simulated service container stopped and transient secrets purged",
      internalDockerRef: container.id,
      containerStatus: "stopped",
    };
  }

  public async deleteService(serviceInstanceId: string): Promise<DockerExecutionResult> {
    this.assertEngineAvailable();
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    const container = this.containersByServiceId.get(serviceInstanceId);
    const knownSiteId =
      container?.labels[MANAGED_DOCKER_LABELS.siteId] ??
      this.expectedByServiceId.get(serviceInstanceId)?.siteId;

    this.containersByServiceId.delete(serviceInstanceId);
    this.expectedByServiceId.delete(serviceInstanceId);
    this.phpIniByService.delete(serviceInstanceId);
    this.terminals.endService(serviceInstanceId, "container_gone");
    await this.cleanupSecrets(serviceInstanceId);

    const remaining = this.removeVirtualRoute(serviceInstanceId);
    if (this.ingressFileManager) {
      await this.ingressFileManager.removeServiceRoute(serviceInstanceId, knownSiteId);
    }

    if (knownSiteId && remaining === 0 && this.ingressProxyContainer) {
      delete this.ingressProxyContainer.networks[getSiteEdgeNetworkName(knownSiteId)];
    }

    return {
      operationId: `sim_op_${randomUUID()}`,
      status: "succeeded",
      message: "Simulated service container removed and transient secrets purged",
      ...(container ? { internalDockerRef: container.id } : {}),
      containerStatus: "stopped",
      ingressConfigured: false,
    };
  }

  public async getObservedState(
    serviceInstanceId: string,
  ): Promise<ExecutorObservedServiceState | null> {
    this.assertEngineAvailable();
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    const inspect = this.getSimulatedContainerInspect(serviceInstanceId);
    if (!inspect) {
      return null;
    }

    const expected = this.expectedByServiceId.get(serviceInstanceId);
    const outOfBandModified = detectOutOfBandContainerModification(
      inspect,
      serviceInstanceId,
      this.virtualSecretsRoot,
      expected,
    );

    const labels = inspect.Config?.Labels ?? {};
    return {
      serviceInstanceId,
      observedStatus: mapContainerStateToObservedStatus(inspect.State),
      observedRevisionHash: labels[MANAGED_DOCKER_LABELS.specHash] || null,
      outOfBandModified,
      observedAt: new Date().toISOString(),
      restartCount: inspect.RestartCount ?? 0,
      internalDockerRef: inspect.Id,
    };
  }

  public simulateOutOfBandModification(
    serviceInstanceId: string,
    mutation?: OutOfBandMutationInput,
  ): void {
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    const container = this.containersByServiceId.get(serviceInstanceId);
    if (!container) {
      throw new ExecutorCodedError("Managed service container not found", "NOT_FOUND");
    }

    if (!mutation) {
      container.image = `${container.image}-tampered`;
      return;
    }

    if (mutation.image !== undefined) {
      container.image = mutation.image;
    }
    if (mutation.specHash !== undefined) {
      container.labels[MANAGED_DOCKER_LABELS.specHash] = mutation.specHash;
    }
    if (mutation.privileged !== undefined) {
      container.privileged = mutation.privileged;
    }
    if (mutation.capAdd !== undefined) {
      container.capAdd = [...mutation.capAdd];
    }
    if (mutation.extraEnv !== undefined) {
      for (const [k, v] of Object.entries(mutation.extraEnv)) {
        container.env.push(`${k}=${v}`);
      }
    }
    if (mutation.extraBind !== undefined) {
      container.binds.push(mutation.extraBind);
    }
    if (mutation.restartCount !== undefined) {
      container.restartCount = mutation.restartCount;
    }
    if (mutation.status !== undefined) {
      if (mutation.status === "running") {
        container.running = true;
        container.status = "running";
        container.dead = false;
      } else if (mutation.status === "stopped") {
        container.running = false;
        container.status = "exited";
        container.dead = false;
      } else {
        container.running = false;
        container.status = "dead";
        container.dead = true;
      }
    }
  }

  public getSimulatedContainerInspect(
    serviceInstanceId: string,
  ): DockerContainerInspectPayload | null {
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    const container = this.containersByServiceId.get(serviceInstanceId);
    if (!container) {
      return null;
    }
    return this.toInspectPayload(container);
  }

  public getSimulatedIngressProxyInspect(): DockerContainerInspectPayload | null {
    if (!this.ingressProxyContainer) {
      return null;
    }
    return this.toInspectPayload(this.ingressProxyContainer);
  }

  public getStaticTraefikYaml(): string | null {
    return this.staticTraefikYaml;
  }

  public getSiteDynamicTraefikYaml(siteId: string): string | null {
    assertSafeIdentifier(siteId, "siteId");
    const siteMap = this.virtualSiteRoutes.get(siteId);
    if (!siteMap || siteMap.size === 0) {
      return null;
    }
    return buildSiteDynamicTraefikYaml(
      siteId,
      [...siteMap.values()],
      siteRouteOptions(this.panel),
    );
  }

  public pullAppStackImage(req: AppStackPullIpcRequest) { return this.appStacks.pullAppStackImage(req); }
  public prepareAppStack(req: AppStackPlanIpcRequest) { return this.appStacks.prepareAppStack(req); }
  public createAppStackComponents(req: AppStackCreateIpcRequest) { return this.appStacks.createAppStackComponents(req); }
  public resolveAppStackImage(req: AppStackImageResolveIpcRequest) { return this.appStacks.resolveAppStackImage(req); }
  public startAppStackComponent(req: AppStackComponentIpcRequest) { return this.appStacks.startAppStackComponent(req); }
  public restartAppStackComponent(req: AppStackComponentIpcRequest) { return this.appStacks.restartAppStackComponent(req); }
  public stopAppStack(req: AppStackRefIpcRequest) { return this.appStacks.stopAppStack(req); }
  public publishAppStackRoutes(req: AppStackRoutesIpcRequest) { return this.appStacks.publishAppStackRoutes(req); }
  public unpublishAppStackRoutes(req: AppStackRefIpcRequest) { return this.appStacks.unpublishAppStackRoutes(req); }
  public removeAppStack(req: AppStackRemoveIpcRequest) { return this.appStacks.removeAppStack(req); }
  public removeAppStackComponents(req: AppStackComponentsRemoveIpcRequest) { return this.appStacks.removeAppStackComponents(req); }
  public getAppStackStatus(req: AppStackRefIpcRequest) { return this.appStacks.getAppStackStatus(req); }
  public getAppStackComponentLogs(req: AppStackLogsIpcRequest) { return this.appStacks.getAppStackComponentLogs(req); }

  public hasActiveVirtualSecret(serviceInstanceId: string, envName?: string): boolean {
    const set = this.virtualSecretFiles.get(serviceInstanceId);
    if (!set || set.size === 0) {
      return false;
    }
    return envName ? set.has(envName) : true;
  }

  private assertEngineAvailable(): void {
    if (!this.engineReachable) {
      throw new ExecutorCodedError(
        "Simulated Docker Engine is currently unreachable",
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
  }

  private async cleanupSecrets(serviceInstanceId: string): Promise<void> {
    this.virtualSecretFiles.delete(serviceInstanceId);
    if (this.secretsRootDir) {
      await purgeServiceSecrets(this.secretsRootDir, serviceInstanceId);
    }
  }

  private upsertVirtualRoute(siteId: string, route: SiteIngressRouteEntry): void {
    const previousSite = this.serviceToSite.get(route.serviceInstanceId);
    if (previousSite && previousSite !== siteId) {
      this.virtualSiteRoutes.get(previousSite)?.delete(route.serviceInstanceId);
    }

    let siteMap = this.virtualSiteRoutes.get(siteId);
    if (!siteMap) {
      siteMap = new Map<string, SiteIngressRouteEntry>();
      this.virtualSiteRoutes.set(siteId, siteMap);
    }
    siteMap.set(route.serviceInstanceId, route);
    this.serviceToSite.set(route.serviceInstanceId, siteId);
  }

  private removeVirtualRoute(serviceInstanceId: string): number {
    const siteId = this.serviceToSite.get(serviceInstanceId);
    if (!siteId) {
      return 0;
    }
    this.serviceToSite.delete(serviceInstanceId);
    const siteMap = this.virtualSiteRoutes.get(siteId);
    if (!siteMap) {
      return 0;
    }
    siteMap.delete(serviceInstanceId);
    if (siteMap.size === 0) {
      this.virtualSiteRoutes.delete(siteId);
      return 0;
    }
    return siteMap.size;
  }

  private toInspectPayload(container: MutableSimulatedContainer): DockerContainerInspectPayload {
    return Object.freeze({
      Id: container.id,
      Name: container.name,
      RestartCount: container.restartCount,
      State: Object.freeze({
        Status: container.status,
        Running: container.running,
        Restarting: false,
        OOMKilled: false,
        Dead: container.dead,
      }),
      Config: Object.freeze({
        Image: container.image,
        Env: Object.freeze([...container.env]),
        Labels: Object.freeze({ ...container.labels }),
      }),
      HostConfig: Object.freeze({
        Privileged: container.privileged,
        CapDrop: Object.freeze([...container.capDrop]),
        CapAdd: Object.freeze([...container.capAdd]),
        SecurityOpt: Object.freeze([...container.securityOpt]),
        PidsLimit: container.pidsLimit,
        NanoCpus: container.nanoCpus,
        Memory: container.memory,
        MemorySwap: container.memorySwap,
        RestartPolicy: Object.freeze({ Name: container.restartPolicyName }),
        NetworkMode: container.networkMode,
        Binds: Object.freeze([...container.binds]),
      }),
      NetworkSettings: Object.freeze({
        Networks: Object.freeze({ ...container.networks }),
      }),
    });
  }
}
