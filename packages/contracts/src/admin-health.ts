import { z } from "zod";
import { CERT_PROBLEMS } from "./site-domains.js";
import { OPERATION_KINDS } from "./operations.js";

const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const PANEL_CONTAINERS = ["ingress_proxy", "shared_database", "phpmyadmin", "sftp", "mail_relay"] as const;
export type PanelContainer = (typeof PANEL_CONTAINERS)[number];
export const HOST_DISK_PATHS = ["panel_data", "docker_data", "database_data", "root"] as const;
export type HostDiskPath = (typeof HOST_DISK_PATHS)[number];

/** Rows of host_agent_heartbeats; only HOST_DAEMON_COMPONENTS are ever listed by listHostAgentHeartbeats. */
export const HEARTBEAT_ROW_COMPONENTS = ["docker_executor", "host_agent", "panel_containers", "panel_certificate"] as const;
export type HeartbeatRowComponent = (typeof HEARTBEAT_ROW_COMPONENTS)[number];

export const PANEL_COMPONENTS = ["api", "web", "database", "executor", "host_agent", "docker_engine", ...PANEL_CONTAINERS] as const;
export type PanelComponent = (typeof PANEL_COMPONENTS)[number];
export const HEALTH_STATES = ["ok", "degraded", "down", "not_in_use", "unknown"] as const;
export type HealthState = (typeof HEALTH_STATES)[number];
export const HEALTH_REASONS = ["not_reporting", "runtime_disabled", "engine_unreachable", "stopped", "restarting", "missing"] as const;
export type HealthReason = (typeof HEALTH_REASONS)[number];
export const SITE_CONTAINER_STATES = ["running", "stopped", "degraded", "missing", "unknown"] as const;
export const SITE_DRIFT_REASONS = ["out_of_band_modified", "status_mismatch", "revision_mismatch"] as const;

export const HEALTH_STALE_AFTER_MS = 5 * 60_000;
export const SITE_CONTAINER_DOWN_GRACE_MS = 5 * 60_000;
// A rise of the restart count counts as restarting this long: above Docker's longest restart wait (1 min) plus one look.
export const SITE_RESTART_QUIET_MS = 2 * 60_000;
export const DISK_HIGH_PERCENT = 90;
export const RESTART_REASON_MAX_LENGTH = 500;
export const RestartInputSchema = z.object({ reason: z.string().trim().min(1).max(RESTART_REASON_MAX_LENGTH) }).strict();
export type RestartInput = z.infer<typeof RestartInputSchema>;
export const PanelContainerSchema = z.enum(PANEL_CONTAINERS);

const DigitsSchema = z.string().regex(/^\d+$/);

export const AdminHealthDtoSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  components: z.array(z.object({
    component: z.enum(PANEL_COMPONENTS),
    state: z.enum(HEALTH_STATES),
    reason: z.enum(HEALTH_REASONS).nullable(),
    observedAt: IsoDateTimeSchema.nullable(),
  }).strict()).length(PANEL_COMPONENTS.length),
  siteContainers: z.array(z.object({
    siteId: z.string(),
    siteName: z.string(),
    organizationName: z.string().nullable(),
    desired: z.enum(["running", "stopped"]),
    observed: z.enum(SITE_CONTAINER_STATES),
    driftReason: z.enum(SITE_DRIFT_REASONS).nullable(),
    restartCount: z.number().int().nonnegative().nullable(),
    observedAt: IsoDateTimeSchema.nullable(),
    stale: z.boolean(),
  }).strict()),
  disks: z.array(z.object({
    paths: z.array(z.enum(HOST_DISK_PATHS)).min(1),
    usedBytes: DigitsSchema,
    totalBytes: DigitsSchema,
    usedPercent: z.number().int().min(0).max(100),
    observedAt: IsoDateTimeSchema,
  }).strict()),
}).strict();
export type AdminHealthDto = z.infer<typeof AdminHealthDtoSchema>;

export const ALERT_KINDS = [
  "disk_high", "certificate_expiring", "certificate_not_issued", "panel_certificate_expiring",
  "backup_failed", "panel_backup_failed", "backup_storage_test_failed", "component_down",
  "site_container_down", "restore_undo_incomplete", "restore_stuck", "operation_unknown", "operation_stuck",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export const ALERT_SEVERITIES = ["warning", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
export const ALERT_SEVERITY: Readonly<Record<AlertKind, AlertSeverity>> = {
  disk_high: "critical", component_down: "critical", site_container_down: "critical", restore_undo_incomplete: "critical",
  certificate_expiring: "warning", certificate_not_issued: "warning", panel_certificate_expiring: "warning",
  backup_failed: "warning", panel_backup_failed: "warning", backup_storage_test_failed: "warning",
  restore_stuck: "warning", operation_unknown: "warning", operation_stuck: "warning",
};

const base = { severity: z.enum(ALERT_SEVERITIES), subject: z.string().min(1), since: IsoDateTimeSchema.nullable() };
const alert = <K extends AlertKind, D extends z.ZodRawShape>(kind: K, details: D) =>
  z.object({ ...base, kind: z.literal(kind), details: z.object(details).strict() }).strict();
const site = { siteId: z.string(), siteName: z.string() };
const op = { operationId: z.string(), kind: z.enum(OPERATION_KINDS), siteId: z.string().nullable(), siteName: z.string().nullable() };

export const AdminAlertDtoSchema = z.discriminatedUnion("kind", [
  alert("disk_high", { paths: z.array(z.enum(HOST_DISK_PATHS)).min(1), usedPercent: z.number().int().min(0).max(100) }),
  alert("certificate_expiring", { ...site, hostname: z.string(), expiresAt: IsoDateTimeSchema.nullable(), problem: z.enum(CERT_PROBLEMS).nullable() }),
  alert("certificate_not_issued", { ...site, hostname: z.string(), problem: z.enum(CERT_PROBLEMS).nullable() }),
  alert("panel_certificate_expiring", { hostname: z.string(), expiresAt: IsoDateTimeSchema }),
  alert("backup_failed", { ...site, failedAt: IsoDateTimeSchema }),
  alert("panel_backup_failed", { failedAt: IsoDateTimeSchema }),
  alert("backup_storage_test_failed", { testedAt: IsoDateTimeSchema }),
  alert("component_down", { component: z.enum(PANEL_COMPONENTS), state: z.enum(["down", "degraded"]), reason: z.enum(HEALTH_REASONS).nullable() }),
  alert("site_container_down", { ...site, observed: z.enum(SITE_CONTAINER_STATES) }),
  alert("restore_undo_incomplete", { ...site, backupId: z.string(), failedAt: IsoDateTimeSchema.nullable() }),
  alert("restore_stuck", { operationId: z.string(), siteId: z.string().nullable(), siteName: z.string().nullable(), startedAt: IsoDateTimeSchema }),
  alert("operation_unknown", op),
  alert("operation_stuck", op),
]);
export type AdminAlertDto = z.infer<typeof AdminAlertDtoSchema>;
