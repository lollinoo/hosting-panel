import { z } from "zod";
import { HOST_SERVICES, PANEL_CONTAINERS, type HostService } from "./admin-health.js";
import { IPC_HOST_JOURNAL_UNITS } from "./ipc-schemas.js";
import { SUPPORTED_PHP_VERSIONS } from "./site-runtime.js";

const IsoDateTimeSchema = z.string().datetime({ offset: true });
const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

/** Same source as the updater (infra/linux/lib/common.sh latest_release_version). */
export const PANEL_RELEASE_LATEST_URL = "https://api.github.com/repos/lollinoo/hosting-panel/releases/latest";
export const PANEL_RELEASE_TAG_RE = /^v(\d+\.\d+\.\d+)$/;
export const PANEL_CHECK_TIMEOUT_MS = 10_000;
export const PANEL_CHECK_MAX_BYTES = 1_048_576;

export const HOST_JOB_KIND = "host.job" as const;
export const PANEL_CONTAINER_APPLY_KIND = "panel.container.apply" as const;
export const HOST_JOB_LOCK_KEY = "host:job";
export const HOST_JOB_REFUSALS = ["host_job_running", "site_work_running"] as const;
export const HOST_JOURNAL_SOURCES = IPC_HOST_JOURNAL_UNITS;
export type HostJournalSource = (typeof HOST_JOURNAL_SOURCES)[number];
export const HOST_SERVICE_UNIT = {
  api: "hp-api", web: "hp-web", executor: "hp-docker-executor", host_agent: "hp-host-agent",
} as const satisfies Readonly<Record<HostService, HostJournalSource>>;
export const LogSourceSchema = z.union([z.enum(PANEL_CONTAINERS), z.enum(HOST_JOURNAL_SOURCES)]);

export const PANEL_CHECK_STATES = ["never_checked", "up_to_date", "newer", "no_release", "failed"] as const;
export const HOST_JOB_RESULTS = ["succeeded", "updated", "already_current", "rolled_back", "rollback_unhealthy", "failed", "not_started"] as const;
export const OS_PACKAGE_ORIGINS = ["security", "distribution", "other"] as const;
export const OS_JOBS = ["os_refresh", "os_upgrade"] as const;
export const PINNED_PANEL_CONTAINERS = ["ingress_proxy", "shared_database", "phpmyadmin", "sftp"] as const;
export const SITES_BEHIND_MAX = 200;

export const UpdatesDtoSchema = z.object({
  panel: z.object({
    installedVersion: SemverSchema.nullable(),
    check: z.object({ state: z.enum(PANEL_CHECK_STATES), latestVersion: SemverSchema.nullable(), checkedAt: IsoDateTimeSchema.nullable() }).strict(),
    running: z.object({ operationId: z.string() }).strict().nullable(),
    last: z.object({ operationId: z.string(), result: z.enum(HOST_JOB_RESULTS), endedAt: IsoDateTimeSchema }).strict().nullable(),
  }).strict(),
  components: z.array(z.object({
    component: z.enum(PANEL_CONTAINERS),
    expected: z.boolean().nullable(),
    imageCurrent: z.boolean().nullable(),
    runningOperationId: z.string().nullable(),
  }).strict()).length(PANEL_CONTAINERS.length),
  sites: z.array(z.object({
    siteId: z.string(), siteName: z.string(), organizationName: z.string().nullable(),
    phpVersion: z.enum(SUPPORTED_PHP_VERSIONS), stopped: z.boolean(),
  }).strict()).max(SITES_BEHIND_MAX),
  sitesTotal: z.number().int().nonnegative(),
}).strict();
export type UpdatesDto = z.infer<typeof UpdatesDtoSchema>;

export const OsPackagesDtoSchema = z.object({
  packages: z.array(z.object({ name: z.string().min(1), installedVersion: z.string().min(1), newVersion: z.string().min(1), origin: z.enum(OS_PACKAGE_ORIGINS) }).strict()),
  rebootRequired: z.boolean(),
  canUpgrade: z.boolean(),
  listsReadAt: IsoDateTimeSchema.nullable(),
  running: z.object({ operationId: z.string(), job: z.enum(OS_JOBS) }).strict().nullable(),
}).strict();
export type OsPackagesDto = z.infer<typeof OsPackagesDtoSchema>;

export const HostJobAcceptedDtoSchema = z.object({ operationId: z.string() }).strict();
export const HostServiceRestartAcceptedDtoSchema = z.object({ service: z.enum(HOST_SERVICES), operationId: z.string() }).strict();
export const ComponentApplyAcceptedDtoSchema = z.object({ component: z.enum(PANEL_CONTAINERS), operationId: z.string().nullable() }).strict();
export const SiteImageUpdateAcceptedDtoSchema = z.object({ siteId: z.string(), operationId: z.string() }).strict();
