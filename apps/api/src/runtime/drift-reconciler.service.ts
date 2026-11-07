import { Inject, Injectable } from "@nestjs/common";
import type {
  ExecutorHealthResponse,
  HostAgentHealthResponse,
  HostDaemonStatus,
} from "@hosting-panel/contracts";
import {
  asc,
  dockerResources,
  hosts,
  recordObservedStateReconciliationTransactional,
  serviceInstances,
  upsertHostAgentHeartbeat,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  HOST_AGENT_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";

export interface DriftReconcileSummary {
  readonly reconciledServices: number;
  readonly driftedServices: number;
  readonly newlyDriftedServices: number;
  readonly heartbeatsUpdated: number;
}

interface HealthCheckableExecutor extends DockerExecutorPort {
  checkHealth?: () => Promise<ExecutorHealthResponse>;
  pingEngine?: () => Promise<boolean>;
}

interface HealthCheckableHostAgent extends HostAgentPort {
  checkHealth?: () => Promise<HostAgentHealthResponse>;
}

const DEFAULT_DAEMON_VERSION = "0.2.0";

@Injectable()
export class DriftReconcilerService {
  #stopped = false;
  #timer: NodeJS.Timeout | null = null;
  #activeRunPromise: Promise<DriftReconcileSummary> | null = null;

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly dockerExecutor: DockerExecutorPort,
    @Inject(HOST_AGENT_TOKEN) private readonly hostAgent: HostAgentPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
  ) {}

  public startBackgroundLoop(): void {
    const intervalMs = this.config.driftReconcileIntervalMs;
    if (this.#stopped || this.#timer || !intervalMs || intervalMs <= 0) {
      return;
    }

    this.#timer = setInterval(() => {
      if (this.#stopped) {
        return;
      }
      void this.reconcileAllOnce().catch(() => undefined);
    }, intervalMs);
    this.#timer.unref();
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#activeRunPromise !== null) {
      await this.#activeRunPromise.catch(() => undefined);
    }
  }

  /**
   * Strictly observe-only drift reconciliation & daemon heartbeat poll (TH-10 / AC-F2-08).
   * NEVER restarts, stops, recreates, or mutates any container or host resource.
   */
  public async reconcileAllOnce(): Promise<DriftReconcileSummary> {
    if (this.#activeRunPromise !== null) {
      return this.#activeRunPromise;
    }

    const promise = this.#executeReconcilePass();
    this.#activeRunPromise = promise;
    try {
      return await promise;
    } finally {
      this.#activeRunPromise = null;
    }
  }

  async #executeReconcilePass(): Promise<DriftReconcileSummary> {
    if (this.config.runtimeBackend === "disabled") {
      return {
        reconciledServices: 0,
        driftedServices: 0,
        newlyDriftedServices: 0,
        heartbeatsUpdated: 0,
      };
    }

    const db = this.dbClient.db;
    let heartbeatsUpdated = 0;

    const allHosts = await db
      .select()
      .from(hosts)
      .orderBy(asc(hosts.id));

    const executorHealth = await this.#probeDockerExecutorHealth();
    const hostAgentHealth = await this.#probeHostAgentHealth();

    for (const host of allHosts) {
      if (this.#stopped) {
        break;
      }

      if (this.dockerExecutor.isRuntimeAvailable) {
        await upsertHostAgentHeartbeat(db, {
          hostId: host.id,
          component: "docker_executor",
          status: executorHealth.status,
          version: executorHealth.version,
          telemetrySnapshot: executorHealth.snapshot,
        });
        heartbeatsUpdated += 1;
      }

      if (this.hostAgent.isRuntimeAvailable) {
        let telemetrySnapshot: Record<string, unknown> = { ...hostAgentHealth.snapshot };
        try {
          const telemetry = await this.hostAgent.getHostTelemetry(host.id);
          if (telemetry) {
            telemetrySnapshot = {
              ...telemetrySnapshot,
              cpuUsagePercent: telemetry.cpuUsagePercent,
              memoryUsedBytes: telemetry.memoryUsedBytes,
              storageUsedBytes: telemetry.storageUsedBytes,
              dockerEngineReachable: Boolean(telemetry.dockerEngineReachable),
            };
          }
        } catch {
          // Keep probed daemon status if per-host telemetry is unavailable
        }

        await upsertHostAgentHeartbeat(db, {
          hostId: host.id,
          component: "host_agent",
          status: hostAgentHealth.status,
          version: hostAgentHealth.version,
          telemetrySnapshot,
        });
        heartbeatsUpdated += 1;
      }
    }

    let reconciledServices = 0;
    let driftedServices = 0;
    let newlyDriftedServices = 0;

    if (this.dockerExecutor.isRuntimeAvailable) {
      const svcs = await db
        .select()
        .from(serviceInstances)
        .orderBy(asc(serviceInstances.id));

      const dockRows = await db.select().from(dockerResources);
      const dockerRefByServiceId = new Map<string, string>();
      for (const row of dockRows) {
        if (row.serviceInstanceId && row.resourceType === "container") {
          dockerRefByServiceId.set(row.serviceInstanceId, row.internalDockerRef);
        }
      }

      for (const svc of svcs) {
        if (this.#stopped) {
          break;
        }

        let obs: Awaited<ReturnType<DockerExecutorPort["getObservedState"]>>;
        try {
          obs = await this.dockerExecutor.getObservedState(svc.id);
        } catch {
          // Runtime unreachable; leave existing observed_states row untouched so staleness window applies
          continue;
        }

        if (obs !== null) {
          const rawRestartCount = (obs as unknown as { restartCount?: unknown }).restartCount;
          const restartCount = typeof rawRestartCount === "number" ? rawRestartCount : 0;
          const result = await recordObservedStateReconciliationTransactional(db, {
            serviceInstanceId: svc.id,
            observedStatus: obs.observedStatus,
            observedRevisionHash: obs.observedRevisionHash ?? null,
            outOfBandModified: Boolean(obs.outOfBandModified),
            rawState: {
              restartCount,
            },
            observedAt: obs.observedAt ? new Date(obs.observedAt) : new Date(),
          });

          reconciledServices += 1;
          if (result.drift.driftStatus === "drifted") {
            driftedServices += 1;
          }
          if (result.newlyDrifted) {
            newlyDriftedServices += 1;
          }
        } else {
          const boundRef = dockerRefByServiceId.get(svc.id);
          const wasPreviouslyDeployedToRuntime =
            typeof boundRef === "string" &&
            boundRef.length > 0 &&
            !boundRef.startsWith("cnt_");

          if (wasPreviouslyDeployedToRuntime && svc.desiredStatus === "running") {
            const result = await recordObservedStateReconciliationTransactional(db, {
              serviceInstanceId: svc.id,
              observedStatus: "missing",
              observedRevisionHash: null,
              outOfBandModified: true,
              rawState: {
                missingContainer: true,
              },
              observedAt: new Date(),
            });

            reconciledServices += 1;
            if (result.drift.driftStatus === "drifted") {
              driftedServices += 1;
            }
            if (result.newlyDrifted) {
              newlyDriftedServices += 1;
            }
          }
        }
      }
    }

    return {
      reconciledServices,
      driftedServices,
      newlyDriftedServices,
      heartbeatsUpdated,
    };
  }

  async #probeDockerExecutorHealth(): Promise<{
    readonly status: HostDaemonStatus;
    readonly version: string;
    readonly snapshot: Record<string, unknown>;
  }> {
    if (!this.dockerExecutor.isRuntimeAvailable) {
      return { status: "offline", version: DEFAULT_DAEMON_VERSION, snapshot: {} };
    }

    const checkable = this.dockerExecutor as HealthCheckableExecutor;
    try {
      if (typeof checkable.checkHealth === "function") {
        const health = await checkable.checkHealth();
        return {
          status: health.status,
          version: health.version,
          snapshot: {
            dockerEngineReachable: health.dockerEngineReachable,
            runtimeBackend: health.runtimeBackend,
          },
        };
      }
      if (typeof checkable.pingEngine === "function") {
        const reachable = await checkable.pingEngine();
        return {
          status: reachable ? "online" : "degraded",
          version: DEFAULT_DAEMON_VERSION,
          snapshot: {
            dockerEngineReachable: reachable,
            runtimeBackend: this.config.runtimeBackend,
          },
        };
      }
      return {
        status: "online",
        version: DEFAULT_DAEMON_VERSION,
        snapshot: { runtimeBackend: this.config.runtimeBackend },
      };
    } catch {
      return { status: "offline", version: DEFAULT_DAEMON_VERSION, snapshot: {} };
    }
  }

  async #probeHostAgentHealth(): Promise<{
    readonly status: HostDaemonStatus;
    readonly version: string;
    readonly snapshot: Record<string, unknown>;
  }> {
    if (!this.hostAgent.isRuntimeAvailable) {
      return { status: "offline", version: DEFAULT_DAEMON_VERSION, snapshot: {} };
    }

    const checkable = this.hostAgent as HealthCheckableHostAgent;
    try {
      if (typeof checkable.checkHealth === "function") {
        const health = await checkable.checkHealth();
        return {
          status: health.status,
          version: health.version,
          snapshot: { runtimeBackend: health.runtimeBackend },
        };
      }
      return {
        status: "online",
        version: DEFAULT_DAEMON_VERSION,
        snapshot: { runtimeBackend: this.config.runtimeBackend },
      };
    } catch {
      return { status: "offline", version: DEFAULT_DAEMON_VERSION, snapshot: {} };
    }
  }
}
