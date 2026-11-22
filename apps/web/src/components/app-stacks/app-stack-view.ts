import { APP_STACK_REASONS, APP_STACK_STATUSES, type AppStackComponentHealth, type AppStackStatus } from "@hosting-panel/contracts";
import { errorMessage, format, type Messages } from "@/i18n";

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
