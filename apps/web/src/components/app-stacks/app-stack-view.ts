import {
  APP_STACK_REASONS,
  APP_STACK_SECRET_ENV_LIMITS,
  APP_STACK_SECRET_MIN_LENGTH,
  APP_STACK_STATUSES,
  type AppStackComponentHealth,
  type AppStackStatus,
  type AppStackSummaryDto,
  type SiteSummaryDto,
} from "@hosting-panel/contracts";
import { errorMessage, format, type Locale, type Messages } from "@/i18n";

export type Tone = "success" | "warning" | "destructive" | "secondary" | "outline";

export const APP_STACK_STATUS_TONE: Readonly<Record<AppStackStatus, Tone>> = {
  running: "success",
  degraded: "warning",
  unknown: "warning",
  failed: "destructive",
  delete_failed: "destructive",
  queued: "secondary",
  deploying: "secondary",
  starting: "secondary",
  stopping: "secondary",
  updating: "secondary",
  deleting: "secondary",
  draft: "outline",
  stopped: "outline",
  deleted: "outline",
};

export const COMPONENT_HEALTH_TONE: Readonly<Record<AppStackComponentHealth, Tone>> = {
  healthy: "success",
  starting: "secondary",
  unhealthy: "destructive",
  missing: "destructive",
  stopped: "outline",
  unknown: "warning",
};

const isStatus = (s: string | undefined): s is AppStackStatus => (APP_STACK_STATUSES as readonly (string | undefined)[]).includes(s);

/** A known reason has its own sentence, a status refusal names the status, then the application codes, then the generic errors. A draft on a version no longer offered is told to start again. */
export function appStackRefusalText(m: Messages, code: string, reason?: string, status?: AppStackStatus): string {
  const { reasons, codes } = m.apps;
  if (reason === "STACK_TEMPLATE_UNPUBLISHED" && status === "draft") return reasons.draftUnpublished;
  if (reason === "value_too_long") return format(reasons.value_too_long, { max: APP_STACK_SECRET_ENV_LIMITS.secretBytes });
  if (reason === "value_too_short") return format(reasons.value_too_short, { min: APP_STACK_SECRET_MIN_LENGTH });
  if (reason !== undefined && Object.hasOwn(reasons, reason)) return (reasons as Record<string, string>)[reason]!;
  if (isStatus(reason)) return format(reasons.status, { status: m.apps.status[reason] });
  if (Object.hasOwn(codes, code)) return (codes as Record<string, string>)[code]!;
  return errorMessage(m, code);
}

/** Deployment `problem`: a STACK_* reason or an application code says why; any other value reads as a generic failure. */
export function appStackProblemText(m: Messages, problem: string | null): string | null {
  if (problem === null) return null;
  if ((APP_STACK_REASONS as readonly string[]).includes(problem)) return (m.apps.reasons as Record<string, string>)[problem]!;
  return Object.hasOwn(m.apps.codes, problem) ? (m.apps.codes as Record<string, string>)[problem]! : m.apps.history.problemGeneric;
}

/** Problem classes about the place the copies are kept: the sites' sentences name no site, so they are shared. */
export const APP_STACK_BACKUP_SHARED_PROBLEMS = [
  "unreachable",
  "tls_failed",
  "wrong_region",
  "auth_failed",
  "bucket_missing",
  "write_denied",
  "wrong_key",
  "key_file_missing",
  "local_target_unmounted",
  "local_target_readonly",
  "local_target_unsafe",
  "backup_copy_missing",
] as const;

/** Why a backup, a copy or a restore of an application failed: its own sentence, a shared one, or the generic one. Never the raw class. */
export function appStackBackupProblemText(m: Messages, problem: string | null): string {
  const own: Record<string, string> = m.apps.backups.problem;
  if (problem !== null && Object.hasOwn(own, problem)) return own[problem]!;
  const shared: Record<string, string> = m.site.backups.problem;
  if (problem !== null && (APP_STACK_BACKUP_SHARED_PROBLEMS as readonly string[]).includes(problem) && Object.hasOwn(shared, problem)) {
    return shared[problem]!;
  }
  return m.apps.backups.problem.other;
}

export function formatCpu(cpuMilli: number): string {
  return `${Number((cpuMilli / 1000).toFixed(2))} vCPU`;
}

const MIB = 1n << 20n;
const GIB = 1n << 30n;

export function formatMemory(memoryBytes: string): string {
  const bytes = BigInt(memoryBytes);
  const [unit, label] = bytes >= GIB ? [GIB, "GiB"] : [MIB, "MiB"];
  return `${Number((bytes * 10n + unit / 2n) / unit) / 10} ${label}`;
}

export type AppKind = "site" | "stack";
export type AppEntry =
  | { kind: "site"; id: string; name: string; site: SiteSummaryDto }
  | { kind: "stack"; id: string; name: string; stack: AppStackSummaryDto };
/** What the top bar's switcher needs (serialisable: passed from a server layout to a client component). */
export type AppLink = { kind: AppKind; id: string; name: string; label: string | null };

/** The detail page of one application of either kind. */
export const appHref = (kind: AppKind, id: string): string => `${kind === "site" ? "/sites" : "/apps"}/${encodeURIComponent(id)}`;

/** Both kinds in one order: by name in the reader's language, then sites before stacks, then by id. */
export function appEntries(sites: readonly SiteSummaryDto[], stacks: readonly AppStackSummaryDto[], locale: Locale): AppEntry[] {
  const entries: AppEntry[] = [
    ...sites.map((site) => ({ kind: "site" as const, id: site.id, name: site.name, site })),
    ...stacks.map((stack) => ({ kind: "stack" as const, id: stack.id, name: stack.name, stack })),
  ];
  return entries.sort(
    (a, b) =>
      a.name.localeCompare(b.name, locale, { sensitivity: "base" }) ||
      (a.kind === b.kind ? 0 : a.kind === "site" ? -1 : 1) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** The kind a list names: «WordPress» for a WordPress site, the catalog entry's name for a stack, null for a site of no known type. */
export function appKindLabel(m: Messages, e: AppEntry): string | null {
  if (e.kind === "stack") return e.stack.templateName;
  return e.site.siteType === "wordpress" ? m.apps.list.wordpress : null;
}

export const appLinks = (m: Messages, entries: readonly AppEntry[]): AppLink[] =>
  entries.map((e) => ({ kind: e.kind, id: e.id, name: e.name, label: appKindLabel(m, e) }));
