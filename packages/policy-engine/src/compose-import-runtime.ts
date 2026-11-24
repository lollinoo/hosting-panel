/**
 * How an imported service runs: its health check and its limits. The platform probes a port from outside the
 * container and never runs a command inside it, so the check of the file is read for what it says about a port.
 * Pure, synchronous and never throws; a note states the values the draft uses, never a value of the file.
 */
import { APP_TEMPLATE_LIMITS as LIMITS, appStackHealthPathProblem, type TemplatePath } from "@hosting-panel/contracts";
import { isMapping, isPort, isSafeInt, own, type Mapping } from "./compose-import-document.js";
import { checkComposeKeys, type ComposeImportKeyLevel } from "./compose-import-keys.js";
import type { ImportReport } from "./compose-import-report.js";
import { parseImageReference } from "./image-reference.js";

export type DraftHealthcheck =
  | { readonly kind: "http"; readonly port: number; readonly path: string; readonly intervalSeconds: number; readonly timeoutSeconds: number }
  | { readonly kind: "tcp"; readonly port: number; readonly intervalSeconds: number; readonly timeoutSeconds: number };

type TimingKey = "interval" | "timeout";

/** What the health check of the file says that a probe from outside can use. */
export interface ComposeHealthcheck {
  /**
   * Set when the test asks a local HTTP address with curl or wget; `path` is null when the platform cannot ask for the
   * same address: a query string, a fragment, or a path a template does not accept.
   */
  readonly http: { readonly port: number; readonly path: string | null } | null;
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
  /** One per timing the draft does not take from the file as written; said only if the check is kept. */
  readonly timing: readonly { readonly key: TimingKey; readonly message: string }[];
}

const LOCAL_URL = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?(\/[^?#]*)?([?#].*)?$/;
const HTTP_CLIENT = /(?:^|\/)(?:curl|wget)$/;
const DURATION_PART = /([0-9]{1,9}(?:\.[0-9]{1,9})?)(h|ms|us|ns|m|s)/y;
const DURATION_SECONDS: Readonly<Record<string, number>> = { h: 3600, m: 60, s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9 };

/** A Compose duration ('30s', '1m30s', '500ms') in whole seconds, rounded up; null when it is not one. */
function durationSeconds(raw: unknown): number | null {
  if (typeof raw !== "string" || raw === "" || raw.length > 64) return null;
  let seconds = 0;
  let index = 0;
  while (index < raw.length) {
    DURATION_PART.lastIndex = index;
    const part = DURATION_PART.exec(raw);
    if (part === null) return null;
    seconds += Number(part[1]) * (DURATION_SECONDS[part[2] ?? ""] ?? 0);
    index = DURATION_PART.lastIndex;
  }
  return Math.ceil(seconds);
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** The words of a test: the list form after its 'CMD' or 'CMD-SHELL', or the one-line form split on spaces. Null when there is no test to read. */
function testWords(report: ImportReport, raw: unknown, path: TemplatePath): string[] | null {
  const items: readonly unknown[] | null = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : null;
  if (items === null || items.some((item) => typeof item !== "string" && typeof item !== "number")) {
    return report.refused("VALUE_INVALID", path, "The 'test' of a health check is a list of text items, or one line of text.");
  }
  const [first, ...rest] = items.map(String);
  if (first === undefined || (Array.isArray(raw) && first === "NONE")) return null;
  const line = Array.isArray(raw) && (first === "CMD" || first === "CMD-SHELL") ? rest : [first, ...rest];
  // A quote around a word belongs to the shell, not to the address it holds.
  return line.flatMap((item) => item.split(/\s+/)).map((word) => word.replace(/^['"]+|['"]+$/g, ""));
}

/** Null when the file asks for no check: none written, one switched off, or one without a test. */
export function readComposeHealthcheck(report: ImportReport, raw: unknown, path: TemplatePath): ComposeHealthcheck | null {
  if (raw === undefined || raw === null) return null;
  if (!isMapping(raw)) return report.refused("VALUE_INVALID", path, "'healthcheck' is a mapping.");
  checkComposeKeys(report, raw, path, "healthcheck");
  if (own(raw, "disable") === true) return null;
  const test = own(raw, "test");
  if (test === undefined || test === null) {
    report.dropped("HEALTHCHECK_DROPPED", path, "The health check has no 'test' of its own: it is dropped.");
    return null;
  }
  const words = testWords(report, test, [...path, "test"]);
  if (words === null) return null;

  let http: ComposeHealthcheck["http"] = null;
  if (words.some((word) => HTTP_CLIENT.test(word))) {
    for (const word of words) {
      const url = LOCAL_URL.exec(word);
      const port = url === null ? null : url[1] === undefined ? 80 : Number(url[1]);
      if (url === null || !isPort(port)) continue;
      const probe = url[2] ?? "/";
      // A probe of the path without its query string would ask for another address than the file does.
      http = { port, path: url[3] === undefined && appStackHealthPathProblem(probe) === null ? probe : null };
      break;
    }
  }
  const timing: { key: TimingKey; message: string }[] = [];
  const read = (key: TimingKey, fallback: number, min: number, max: number, bound: string): number => {
    const written = own(raw, key);
    if (written === undefined || written === null) return clamp(fallback, min, max);
    const seconds = durationSeconds(written);
    const kept = clamp(seconds ?? fallback, min, max);
    if (seconds === null) {
      timing.push({ key, message: `'${key}' is not a duration the importer reads (a number needs its unit, as in '30s'): the draft uses ${kept} s.` });
    } else if (kept !== seconds) {
      timing.push({ key, message: `'${key}' is outside ${min} to ${max} s${bound}: the draft uses ${kept} s.` });
    }
    return kept;
  };
  const interval = read("interval", LIMITS.healthIntervalDefault, LIMITS.healthIntervalMin, LIMITS.healthIntervalMax, "");
  const longest = Math.min(LIMITS.healthTimeoutMax, interval);
  const timeout = read("timeout", LIMITS.healthTimeoutDefault, LIMITS.healthTimeoutMin, longest, longest < LIMITS.healthTimeoutMax ? " (a timeout is never longer than its interval)" : "");
  return { http, intervalSeconds: interval, timeoutSeconds: timeout, timing };
}

/** Images whose documentation fixes the port they listen on. */
const KNOWN_PORTS: ReadonlyMap<string, number> = new Map([
  ["mariadb", 3306],
  ["mysql", 3306],
  ["postgres", 5432],
  ["postgresql", 5432],
  ["redis", 6379],
  ["valkey", 6379],
  ["mongo", 27017],
  ["mongodb", 27017],
]);

function knownPort(image: string): number | null {
  const parsed = parseImageReference(image);
  return parsed.ok ? (KNOWN_PORTS.get(parsed.value.repository.slice(parsed.value.repository.lastIndexOf("/") + 1)) ?? null) : null;
}

/**
 * The check of the draft. `ingressPort` is the port of the first ingress entry of the service, `expose` the ports
 * the file exposes. A service that receives traffic always gets a check: its route is published once it is healthy.
 */
export function convertHealthcheck(
  report: ImportReport,
  check: ComposeHealthcheck | null,
  path: TemplatePath,
  facts: { readonly ingressPort: number | null; readonly image: string; readonly expose: readonly number[] },
): DraftHealthcheck | null {
  if (check === null) {
    if (facts.ingressPort === null) return null;
    report.info("HEALTHCHECK_ADDED", path, `The service receives traffic and the file gives it no health check: a tcp check on port ${facts.ingressPort} is added.`);
    return { kind: "tcp", port: facts.ingressPort, intervalSeconds: LIMITS.healthIntervalDefault, timeoutSeconds: LIMITS.healthTimeoutDefault };
  }
  const timing = { intervalSeconds: check.intervalSeconds, timeoutSeconds: check.timeoutSeconds };
  const port = check.http?.port ?? facts.ingressPort ?? knownPort(facts.image) ?? facts.expose[0] ?? null;
  if (port === null) {
    report.dropped("HEALTHCHECK_DROPPED", path, "The health check runs a command inside the container and the file names no port to probe instead: it is dropped.");
    return null;
  }
  const probe = check.http?.path ?? null;
  const draft: DraftHealthcheck = probe === null ? { kind: "tcp", port, ...timing } : { kind: "http", port, path: probe, ...timing };
  const kind =
    draft.kind === "http"
      ? "an http check of the same path"
      : check.http === null
        ? "a tcp check"
        : "a tcp check, because a template cannot ask for the address the command asks (it has a query string, or a path a template does not accept),";
  report.changed(
    "HEALTHCHECK_CONVERTED",
    path,
    `The health check became ${kind} on port ${port}, every ${timing.intervalSeconds} s with a timeout of ` +
      `${timing.timeoutSeconds} s: the platform probes from outside the container, and keeps neither the command, the retries nor the start period.`,
  );
  for (const note of check.timing) report.changed("HEALTHCHECK_TIMING_ADJUSTED", [...path, note.key], note.message);
  return draft;
}

export interface DraftLimits {
  readonly cpus: string;
  readonly memory: string;
}

type Reading = { readonly state: "missing" } | { readonly state: "unreadable" } | { readonly state: "read"; readonly amount: number; readonly exact: boolean };

/** Thousandths of a CPU. Zero means 'no limit' to Docker: it counts as missing. */
function readCpus(raw: unknown): Reading {
  if (raw === undefined || raw === null) return { state: "missing" };
  const match = typeof raw === "string" || isSafeInt(raw) ? /^([0-9]{1,6})?(?:\.([0-9]{1,9}))?$/.exec(String(raw).trim()) : null;
  if (match === null || match[0] === "") return { state: "unreadable" };
  const decimals = match[2] ?? "";
  const milli = Number(match[1] ?? "0") * 1000 + Number(decimals.slice(0, 3).padEnd(3, "0"));
  if (milli === 0 && !/[1-9]/.test(decimals)) return { state: "missing" };
  return { state: "read", amount: milli, exact: !/[1-9]/.test(decimals.slice(3)) };
}

/** Bytes, with the binary units Docker reads ('512m', '1g', '1.5GiB'). Zero means 'no limit': it counts as missing. */
function readMemory(raw: unknown): Reading {
  if (raw === undefined || raw === null) return { state: "missing" };
  const match = typeof raw === "string" || isSafeInt(raw) ? /^([0-9]{1,15})(?:\.([0-9]{1,6}))?\s?(?:([kmgt])i?b?|b)?$/i.exec(String(raw).trim()) : null;
  if (match === null) return { state: "unreadable" };
  const bytes = Number(`${match[1] ?? "0"}.${match[2] ?? "0"}`) * 1024 ** (" kmgt".indexOf((match[3] ?? " ").toLowerCase()));
  if (bytes === 0) return { state: "missing" };
  return { state: "read", amount: Math.floor(bytes), exact: Number.isInteger(bytes) };
}

/** "1.5" for 1500: the form the validator reads back to the same number. */
const formatCpus = (milli: number): string => `${Math.floor(milli / 1000)}${milli % 1000 === 0 ? "" : `.${String(milli % 1000).padStart(3, "0").replace(/0+$/, "")}`}`;

/** The largest binary unit that divides the amount, so '512M' stays '512M'. */
function formatMemory(bytes: number): string {
  for (const [unit, size] of [["G", 1024 ** 3], ["M", 1024 ** 2], ["K", 1024]] as const) {
    if (bytes % size === 0) return `${bytes / size}${unit}`;
  }
  return String(bytes);
}

interface LimitRule {
  /** Applied when the file sets no limit: 0.5 CPU and 512M. */
  readonly fallback: number;
  readonly min: number;
  readonly max: number;
  readonly format: (amount: number) => string;
}

const CPU_RULE: LimitRule = { fallback: 500, min: LIMITS.cpuMilliMin, max: LIMITS.cpuMilliMax, format: formatCpus };
const MEMORY_RULE: LimitRule = { fallback: 512 * 1024 ** 2, min: LIMITS.memoryBytesMin, max: LIMITS.memoryBytesMax, format: formatMemory };

/** The mapping under `key`, with its keys checked; null when there is none to read. */
function level(report: ImportReport, parent: Mapping | null, path: TemplatePath, key: ComposeImportKeyLevel): Mapping | null {
  const raw = parent === null ? undefined : own(parent, key);
  if (raw === undefined || raw === null) return null;
  if (!isMapping(raw)) return report.refused("VALUE_INVALID", path, `'${key}' is a mapping.`);
  checkComposeKeys(report, raw, path, key);
  return raw;
}

/**
 * The limits of the draft. `deploy.resources.limits` wins over the older `cpus` and `mem_limit`; a limit the file
 * does not set gets the default, and one outside what the platform allows is brought to the nearest bound.
 */
export function convertLimits(report: ImportReport, service: Mapping, path: TemplatePath): DraftLimits {
  const deployPath = [...path, "deploy"];
  const resourcesPath = [...deployPath, "resources"];
  const limitsPath = [...resourcesPath, "limits"];
  const limits = level(report, level(report, level(report, service, deployPath, "deploy"), resourcesPath, "resources"), limitsPath, "limits");
  const pick = (key: string, older: string): { readonly raw: unknown; readonly at: TemplatePath } => {
    const raw = limits === null ? undefined : own(limits, key);
    const outside = own(service, older);
    if (raw === undefined || raw === null) return { raw: outside, at: [...path, older] };
    if (outside !== undefined && outside !== null) {
      report.dropped(
        "LIMITS_OVERRIDDEN",
        [...path, older],
        `'${older}' is set beside 'deploy.resources.limits.${key}': the limit under 'deploy' is the one the draft uses, and '${older}' is dropped.`,
      );
    }
    return { raw, at: [...limitsPath, key] };
  };
  const missing: string[] = [];
  const settle = (what: string, at: TemplatePath, reading: Reading, rule: LimitRule): string => {
    const { format } = rule;
    if (reading.state === "missing") {
      missing.push(`no ${what} limit (${format(rule.fallback)} applies)`);
      return format(rule.fallback);
    }
    if (reading.state === "unreadable") {
      report.changed("LIMITS_ADJUSTED", at, `The ${what} limit of the file cannot be read: the default ${format(rule.fallback)} is applied.`);
      return format(rule.fallback);
    }
    const amount = clamp(reading.amount, rule.min, rule.max);
    if (amount !== reading.amount) {
      report.changed("LIMITS_ADJUSTED", at, `The ${what} limit of the file is outside ${format(rule.min)} to ${format(rule.max)}: it is set to ${format(amount)}.`);
    } else if (!reading.exact) {
      report.changed("LIMITS_ADJUSTED", at, `The ${what} limit of the file is finer than the platform counts: it is rounded down to ${format(amount)}.`);
    }
    return format(amount);
  };
  const cpuSource = pick("cpus", "cpus");
  const memorySource = pick("memory", "mem_limit");
  const cpus = settle("CPU", cpuSource.at, readCpus(cpuSource.raw), CPU_RULE);
  const memory = settle("memory", memorySource.at, readMemory(memorySource.raw), MEMORY_RULE);
  if (missing.length > 0) report.info("LIMITS_DEFAULTED", path, `The file sets ${missing.join(" and ")} for this service.`);
  return { cpus, memory };
}
