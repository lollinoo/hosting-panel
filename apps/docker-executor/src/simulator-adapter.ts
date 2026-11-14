import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { CertProblem, MailRelayApplyRequest } from "@hosting-panel/contracts";
import type {
  AcmeFailure,
  ApprovedServiceSpec,
  CertificateStatusReport,
  DockerExecutionResult,
  DockerExecutorPort,
  MailRelayStatusReport,
  MailTestResult,
  ServiceLogLine,
  SiteHostRoute,
  SiteJobKind,
  SiteJobRequest,
  SiteJobResult,
  SiteRoutesRequest,
  StoredCertificate,
} from "@hosting-panel/executor-contracts";
import { assertValidSiteJobRequest } from "./site-jobs.js";
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

export class InMemoryDockerSimulatorAdapter implements DockerExecutorPort {
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
  private ingressProxyContainer: MutableSimulatedContainer | null = null;
  public readonly jobs: SiteJobRequest[] = [];
  public readonly deployedSpecs: ApprovedServiceSpec[] = [];
  /** Latest route plan per site, from applySiteRoutes or a deploy carrying hostRoutes. */
  public readonly appliedRoutes = new Map<string, SiteRoutesRequest>();
  /** Every route plan in order. */
  public readonly routeHistory: SiteRoutesRequest[] = [];
  private readonly certificates = new Map<string, StoredCertificate>();
  private readonly certFailures: AcmeFailure[] = [];
  private certStoreReadable = true;
  public acmeEnabled = true;
  /** Test hook awaited inside runSiteJob. */
  public onJob?: (req: SiteJobRequest) => Promise<void>;
  /** Test hook awaited inside deployService. */
  public onDeploy?: (spec: ApprovedServiceSpec) => Promise<void>;
  private readonly failingJobs: { kind: SiteJobKind; exitCode: number; outputTail: string }[] = [];
  private failDeployOnce = false;
  public mailRelay: SimulatedMailRelayState | null = null;
  /** Every apply in order, null for a disable. */
  public readonly mailRelayApplies: Array<MailRelayApplyRequest | null> = [];
  public readonly mailDeliveries: SimulatedMailDelivery[] = [];
  public nextTestMailResult: MailTestResult = { outcome: "sent", problem: null, detail: null };
  private failingMailApplies = 0;
  private readonly serviceLogs = new Map<string, ServiceLogLine[]>();
  private staticTraefikYaml: string | null = null;

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

  public failNextJob(kind: SiteJobKind, exitCode: number, outputTail = ""): void {
    this.failingJobs.push({ kind, exitCode, outputTail });
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

  public failNextDeploy(): void {
    this.failDeployOnce = true;
  }

  public setServiceLogs(serviceInstanceId: string, lines: ServiceLogLine[]): void {
    this.serviceLogs.set(serviceInstanceId, lines);
  }

  public async runSiteJob(req: SiteJobRequest): Promise<SiteJobResult> {
    this.assertEngineAvailable();
    assertValidSiteJobRequest(req);
    this.jobs.push(req);
    await this.onJob?.(req);
    const idx = this.failingJobs.findIndex((f) => f.kind === req.kind);
    const failure = idx >= 0 ? this.failingJobs.splice(idx, 1)[0] : undefined;
    return {
      jobId: req.jobId,
      exitCode: failure?.exitCode ?? 0,
      outputTail: failure?.outputTail ?? "",
    };
  }

  public async purgeSite(siteId: string): Promise<void> {
    this.assertEngineAvailable();
    assertSafeIdentifier(siteId, "siteId");
    for (const [serviceId, expected] of [...this.expectedByServiceId]) {
      if (expected.siteId === siteId) {
        await this.deleteService(serviceId);
      }
    }
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

  public async deployService(rawSpec: ApprovedServiceSpec): Promise<DockerExecutionResult> {
    this.assertEngineAvailable();
    await this.onDeploy?.(rawSpec);
    if (this.failDeployOnce) {
      this.failDeployOnce = false;
      throw new ExecutorCodedError("Simulated deploy failure", "DOCKER_ENGINE_UNAVAILABLE");
    }
    const spec = validateExecutorServiceSpec(rawSpec, siteRouteOptions(this.panel).reservedHosts);
    this.deployedSpecs.push(rawSpec);

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

  public async restartService(serviceInstanceId: string): Promise<DockerExecutionResult> {
    this.assertEngineAvailable();
    assertSafeIdentifier(serviceInstanceId, "serviceInstanceId");
    const container = this.containersByServiceId.get(serviceInstanceId);
    if (!container) {
      throw new ExecutorCodedError("Managed service container not found", "NOT_FOUND");
    }

    container.running = true;
    container.status = "running";
    container.dead = false;

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
