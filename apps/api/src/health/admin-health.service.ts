import { Inject, Injectable } from "@nestjs/common";
import { setTimeout as sleep } from "node:timers/promises";
import {
  SITE_TYPE_KEYS,
  ALERT_KINDS,
  AdminHealthDtoSchema,
  ALERT_SEVERITY,
  DISK_HIGH_PERCENT,
  HEALTH_STALE_AFTER_MS,
  HOST_SERVICES,
  HOST_SERVICE_UNIT,
  HostDiskWireSchema,
  OPERATION_TERMINAL_STATUSES,
  PANEL_CONTAINERS,
  PLATFORM_OPS_ORG_ID,
  PanelContainerStatusWireSchema,
  SITE_CONTAINER_DOWN_GRACE_MS,
  SITE_CONTAINER_STATES,
  SITE_RESTART_QUIET_MS,
  isTerminalOperationStatus,
  type AdminAlertDto,
  type AdminHealthDto,
  type HealthReason,
  type HealthState,
  type PanelComponent,
} from "@hosting-panel/contracts";
import {
  and,
  asc,
  backupSettings,
  desc,
  eq,
  gte,
  hostAgentHeartbeats,
  inArray,
  listAdminBackupStatus,
  listUnsettledOperations,
  lte,
  not,
  observedStates,
  operations,
  or,
  organizations,
  serviceInstances,
  sites,
  stackRevisions,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import { evaluateServiceDrift } from "@hosting-panel/hosting-domain";
import { z } from "zod";
import { manualExpiryAlerts } from "../certificates/tls-expiry.js";
import { BACKUP_POLL_DEADLINE_MS } from "../backups/site-backups-applier.js";
import { ManagedSitesService } from "../sites/managed-sites.service.js";
import { CONTROL_PLANE_CONFIG_TOKEN, DATABASE_CLIENT_TOKEN, HOST_AGENT_TOKEN, type ControlPlaneRuntimeConfig } from "../tokens.js";

type Part = AdminHealthDto["components"][number];
type HeartbeatRow = typeof hostAgentHeartbeats.$inferSelect;
type DownSite = { siteId: string; siteName: string; observed: AdminHealthDto["siteContainers"][number]["observed"]; since: string };

const PanelContainersSnapshotSchema = z.object({ containers: z.array(PanelContainerStatusWireSchema) });
const DisksSnapshotSchema = z.object({ disks: z.array(HostDiskWireSchema) });
const HOST_SERVICES_READ_MS = 3_000;
const DRIFT_REASONS = [
  ["OUT_OF_BAND_MODIFIED", "out_of_band_modified"],
  ["STATUS_MISMATCH", "status_mismatch"],
  ["SPEC_HASH_MISMATCH", "revision_mismatch"],
] as const;

/** Panel health and open alerts from stored state; Health alone also reads the host services live. */
@Injectable()
export class AdminHealthService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(ManagedSitesService) private readonly sites: ManagedSitesService,
    @Inject(HOST_AGENT_TOKEN) private readonly hostAgent: HostAgentPort,
  ) {}

  /** Every panel part, site container and disk, and the four host services. */
  public async health(now = new Date()): Promise<AdminHealthDto> {
    const [{ health }, hostServices] = await Promise.all([this.#read(now), this.#hostServices()]);
    return { ...health, hostServices };
  }

  /** One live read of the four services, bound to 3 s; null when disabled, out of reach, slow or malformed. */
  async #hostServices(): Promise<AdminHealthDto["hostServices"]> {
    if (!this.hostAgent.isRuntimeAvailable) return null;
    const bound = new AbortController();
    try {
      const states = await Promise.race([
        this.hostAgent.readHostServices(),
        sleep(HOST_SERVICES_READ_MS, null, { signal: bound.signal }),
      ]);
      if (!states) return null;
      const list = HOST_SERVICES.map((service) => {
        const s = states.find((x) => x.unit === HOST_SERVICE_UNIT[service]);
        return s && { service, active: s.active, activeState: s.activeState, since: s.since, restarts: s.restarts };
      });
      const parsed = AdminHealthDtoSchema.shape.hostServices.safeParse(list);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    } finally {
      bound.abort();
    }
  }

  /** Open alerts, critical first. */
  public async alerts(now = new Date()): Promise<AdminAlertDto[]> {
    const db = this.dbClient.db;
    const { health, downSites } = await this.#read(now);
    const alerts: AdminAlertDto[] = [];
    const push = <A extends AdminAlertDto>(a: Omit<A, "severity"> & { severity?: A["severity"] }) =>
      alerts.push({ severity: ALERT_SEVERITY[a.kind], ...a } as A);

    for (const d of health.disks.filter((d) => d.usedPercent >= DISK_HIGH_PERCENT)) {
      push({ kind: "disk_high", subject: d.paths.join("+"), since: d.observedAt, details: { paths: d.paths, usedPercent: d.usedPercent } });
    }
    const restarts = await db
      .select({ component: operations.resourceId, status: operations.status, completedAt: operations.completedAt })
      .from(operations)
      .where(and(
        eq(operations.kind, "panel.container.restart"),
        or(not(inArray(operations.status, [...OPERATION_TERMINAL_STATUSES])), gte(operations.completedAt, new Date(now.getTime() - HEALTH_STALE_AFTER_MS))),
      ));
    // A look taken while its restart runs, or before the restart ended, is not a down container.
    const restarting = (c: Part) => restarts.some((r) => r.component === c.component &&
      (!isTerminalOperationStatus(r.status) || (r.completedAt !== null && c.observedAt !== null && r.completedAt.getTime() >= Date.parse(c.observedAt))));
    for (const c of health.components) {
      if ((c.state === "down" || c.state === "degraded") && !restarting(c)) {
        push({ kind: "component_down", subject: c.component, since: c.observedAt, details: { component: c.component, state: c.state, reason: c.reason } });
      }
    }
    for (const s of downSites) {
      push({ kind: "site_container_down", subject: s.siteId, since: s.since, details: { siteId: s.siteId, siteName: s.siteName, observed: s.observed } });
    }
    for (const a of await this.sites.certificateAlerts()) {
      if (a.kind === "panel_expiring") {
        if (a.expiresAt) push({ kind: "panel_certificate_expiring", subject: a.hostname, since: null, details: { hostname: a.hostname, expiresAt: a.expiresAt } });
      } else if (a.siteId && a.siteName) {
        const site = { siteId: a.siteId, siteName: a.siteName, hostname: a.hostname, problem: a.problem };
        if (a.kind === "expiring") push({ kind: "certificate_expiring", subject: a.hostname, since: null, details: { ...site, expiresAt: a.expiresAt } });
        else push({ kind: "certificate_not_issued", subject: a.hostname, since: null, details: site });
      }
    }
    for (const m of await manualExpiryAlerts(db, now)) {
      push({
        kind: "manual_certificate_expiring",
        severity: m.tier === "warning" ? "warning" : "critical",
        subject: m.versionId,
        since: null,
        details: { siteId: m.siteId, siteName: m.siteName, certificateId: m.certificateId, certificateName: m.certificateName, notAfter: m.notAfter, tier: m.tier },
      });
    }
    for (const b of await listAdminBackupStatus(db)) {
      if (b.lastStatus === "failed" && b.lastAttemptAt) {
        push({ kind: "backup_failed", subject: b.siteId, since: b.lastAttemptAt, details: { siteId: b.siteId, siteName: b.siteName, failedAt: b.lastAttemptAt } });
      }
      const r = b.lastRestore;
      if (r?.status === "failed" && r.problem === "undo_incomplete") {
        push({ kind: "restore_undo_incomplete", subject: r.backupId, since: r.finishedAt, details: { siteId: b.siteId, siteName: b.siteName, backupId: r.backupId, failedAt: r.finishedAt } });
      }
    }
    const [settings] = await db.select().from(backupSettings).limit(1);
    if (settings?.lastPanelBackupStatus === "failed" && settings.lastPanelBackupAt) {
      const failedAt = settings.lastPanelBackupAt.toISOString();
      push({ kind: "panel_backup_failed", subject: "panel", since: failedAt, details: { failedAt } });
    }
    if (settings?.lastTestOutcome === "failed" && settings.lastTestAt) {
      const testedAt = settings.lastTestAt.toISOString();
      push({ kind: "backup_storage_test_failed", subject: "storage", since: testedAt, details: { testedAt } });
    }
    const stuckRestores = await db
      .select({ operationId: operations.id, startedAt: operations.startedAt, siteId: sites.id, siteName: sites.name })
      .from(operations)
      .leftJoin(sites, and(eq(operations.resourceType, "site"), eq(sites.id, operations.resourceId)))
      .where(and(
        eq(operations.kind, "site.backups.restore"),
        not(inArray(operations.status, [...OPERATION_TERMINAL_STATUSES])),
        lte(operations.startedAt, new Date(now.getTime() - BACKUP_POLL_DEADLINE_MS)),
      ))
      .orderBy(asc(operations.startedAt))
      .limit(50);
    for (const o of stuckRestores) {
      const startedAt = o.startedAt!.toISOString();
      push({ kind: "restore_stuck", subject: o.operationId, since: startedAt, details: { operationId: o.operationId, siteId: o.siteId, siteName: o.siteName, startedAt } });
    }
    // A restore leaves these two kinds: past its deadline it is restore_stuck.
    for (const o of (await listUnsettledOperations(db, now)).filter((o) => o.kind !== "site.backups.restore")) {
      push({ kind: o.alert, subject: o.operationId, since: o.since.toISOString(), details: { operationId: o.operationId, kind: o.kind, siteId: o.siteId, siteName: o.siteName } });
    }

    const rank = (a: AdminAlertDto) => (a.severity === "critical" ? 0 : 1) * ALERT_KINDS.length + ALERT_KINDS.indexOf(a.kind);
    return alerts.sort((a, b) => rank(a) - rank(b) || (a.since ?? "￿").localeCompare(b.since ?? "￿"));
  }

  async #read(now: Date): Promise<{ health: AdminHealthDto; downSites: DownSite[] }> {
    const db = this.dbClient.db;
    const disabled = this.config.runtimeBackend === "disabled";
    const generatedAt = now.toISOString();
    const rows = new Map<string, HeartbeatRow>();
    for (const row of await db.select().from(hostAgentHeartbeats).orderBy(desc(hostAgentHeartbeats.lastSeenAt))) {
      if (!rows.has(row.component)) rows.set(row.component, row);
    }
    const fresh = (row: HeartbeatRow | undefined): row is HeartbeatRow => row !== undefined && now.getTime() - row.lastSeenAt.getTime() <= HEALTH_STALE_AFTER_MS;
    const part = (component: PanelComponent, state: HealthState, reason: HealthReason | null, observedAt: string | null): Part => ({ component, state, reason, observedAt });

    const daemon = (component: PanelComponent, row: HeartbeatRow | undefined): Part => {
      if (disabled) return part(component, "unknown", "runtime_disabled", null);
      if (!row) return part(component, "unknown", "not_reporting", null);
      const at = row.lastSeenAt.toISOString();
      return !fresh(row) || row.status === "offline" ? part(component, "down", "not_reporting", at) : part(component, "ok", null, at);
    };
    const executorRow = rows.get("docker_executor");
    const executor = daemon("executor", executorRow);
    const hostAgent = daemon("host_agent", rows.get("host_agent"));
    // A stored snapshot is any JSON value (null, a number, an array): only an object is read.
    const snap: unknown = executorRow?.telemetrySnapshot;
    const engine: Part =
      executor.state !== "ok"
        ? { ...executor, component: "docker_engine", state: "unknown" }
        : executorRow!.status === "degraded"
          ? part("docker_engine", "down", "engine_unreachable", executor.observedAt)
          : typeof snap !== "object" || snap === null || Array.isArray(snap)
            ? part("docker_engine", "unknown", "not_reporting", executor.observedAt)
            : (snap as { dockerEngineReachable?: unknown }).dockerEngineReachable === false
              ? part("docker_engine", "down", "engine_unreachable", executor.observedAt)
              : part("docker_engine", "ok", null, executor.observedAt);

    const containersRow = rows.get("panel_containers");
    const parsed = fresh(containersRow) && containersRow.status === "online" ? PanelContainersSnapshotSchema.safeParse(containersRow.telemetrySnapshot) : null;
    const containerParts = PANEL_CONTAINERS.map((component): Part => {
      if (disabled) return part(component, "unknown", "runtime_disabled", null);
      if (engine.state === "down") return part(component, "unknown", "engine_unreachable", engine.observedAt);
      if (engine.state === "unknown") return part(component, "unknown", engine.reason, engine.observedAt);
      const c = parsed?.success ? parsed.data.containers.find((x) => x.component === component) : undefined;
      if (!c) return part(component, "unknown", "not_reporting", null);
      const at = containersRow!.lastSeenAt.toISOString();
      if (!c.expected && (c.state === "stopped" || c.state === "missing")) return part(component, "not_in_use", null, at);
      if (c.state === "running") return part(component, "ok", null, at);
      if (c.state === "degraded") return part(component, "degraded", "restarting", at);
      if (c.state === "stopped" || c.state === "missing") return part(component, "down", c.state, at);
      return part(component, "unknown", "not_reporting", at);
    });

    const agentRow = rows.get("host_agent");
    const disksParsed = agentRow ? DisksSnapshotSchema.safeParse(agentRow.telemetrySnapshot) : null;
    const disks = (disksParsed?.success ? disksParsed.data.disks : []).map((d) => {
      const total = BigInt(d.totalBytes);
      return {
        paths: d.paths,
        usedBytes: d.usedBytes,
        totalBytes: d.totalBytes,
        usedPercent: total === 0n ? 0 : Math.min(100, Number((BigInt(d.usedBytes) * 100n) / total)),
        observedAt: agentRow!.lastSeenAt.toISOString(),
      };
    });

    const siteRows = await db
      .select({
        siteId: sites.id, siteName: sites.name, siteStatus: sites.status, orgId: organizations.id, orgName: organizations.name,
        desired: serviceInstances.desiredStatus, obs: observedStates, specHash: stackRevisions.specHash,
      })
      .from(sites)
      .innerJoin(organizations, eq(organizations.id, sites.organizationId))
      .innerJoin(serviceInstances, and(eq(serviceInstances.siteId, sites.id), eq(serviceInstances.organizationId, sites.organizationId)))
      .leftJoin(observedStates, eq(observedStates.serviceInstanceId, serviceInstances.id))
      .leftJoin(stackRevisions, eq(stackRevisions.id, serviceInstances.currentRevisionId))
      .where(inArray(sites.siteType, [...SITE_TYPE_KEYS]))
      .orderBy(asc(sites.name), asc(sites.id));
    const downSites: DownSite[] = [];
    const siteContainers = siteRows.map((s) => {
      const obs = s.obs;
      const reason = obs
        ? evaluateServiceDrift(s.desired, s.specHash ?? "", { observedStatus: obs.observedStatus, observedRevisionHash: obs.observedRevisionHash, outOfBandModified: obs.outOfBandModified, observedAt: obs.observedAt }, { now }).reason
        : "";
      const raw = (obs?.rawState ?? {}) as { restartCount?: unknown; notRunningSince?: unknown; lastRestartAt?: unknown };
      const stale = !obs || now.getTime() - obs.observedAt.getTime() > HEALTH_STALE_AFTER_MS;
      const since = typeof raw.notRunningSince === "string" ? raw.notRunningSince : null;
      // R189 1.3: seen running while the clock runs means restarting.
      const observed = obs?.observedStatus === "running" && since !== null ? "degraded"
        : SITE_CONTAINER_STATES.find((x) => x === obs?.observedStatus) ?? "unknown";
      if (
        s.desired === "running" && !stale &&
        s.siteStatus !== "deploying" && s.siteStatus !== "maintenance" &&
        since !== null && Date.parse(since) <= now.getTime() - SITE_CONTAINER_DOWN_GRACE_MS &&
        // R191 1.2: a running look keeps its clock only while the last rise is recent.
        (obs?.observedStatus !== "running" || now.getTime() - Date.parse(String(raw.lastRestartAt)) < SITE_RESTART_QUIET_MS)
      ) {
        downSites.push({ siteId: s.siteId, siteName: s.siteName, observed, since: new Date(since).toISOString() });
      }
      return {
        siteId: s.siteId,
        siteName: s.siteName,
        organizationName: s.orgId === PLATFORM_OPS_ORG_ID ? null : s.orgName,
        desired: s.desired,
        observed,
        driftReason: DRIFT_REASONS.find(([prefix]) => reason.startsWith(prefix))?.[1] ?? null,
        restartCount: typeof raw.restartCount === "number" && Number.isInteger(raw.restartCount) && raw.restartCount >= 0 ? raw.restartCount : null,
        observedAt: obs?.observedAt.toISOString() ?? null,
        stale,
      };
    });

    const components = [
      part("api", "ok", null, generatedAt),
      part("web", "ok", null, generatedAt),
      part("database", "ok", null, generatedAt),
      executor,
      hostAgent,
      engine,
      ...containerParts,
    ];
    return { health: { generatedAt, components, siteContainers, disks, hostServices: null }, downSites };
  }
}
