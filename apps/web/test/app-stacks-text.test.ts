import { describe, expect, it } from "vitest";
import {
  APP_BUILT_IN_TEMPLATES,
  APP_STACK_BACKUP_KINDS,
  APP_STACK_BACKUP_STATUSES,
  APP_STACK_BACKUP_STEP_KEYS,
  APP_STACK_BACKUP_UNAVAILABLE_REASONS,
  APP_STACK_COMPONENT_HEALTH,
  APP_STACK_REASONS,
  APP_STACK_RESTORE_STATUSES,
  APP_STACK_STATUSES,
  APP_STACK_STEP_KEYS,
  BACKUP_PROBLEMS,
} from "@hosting-panel/contracts";
import { errorMessage } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { appTemplateRefusalText } from "@/components/admin/app-template-text";
import {
  APP_STACK_BACKUP_SHARED_PROBLEMS,
  APP_STACK_STATUS_TONE,
  COMPONENT_HEALTH_TONE,
  appStackBackupProblemText,
  appStackProblemText,
  appStackRefusalText,
  formatCpu,
  formatMemory,
} from "@/components/app-stacks/app-stack-view";

const locales = [
  ["en", en],
  ["it", itMsgs],
] as const;
const CODES = [
  "RESOURCE_LOCKED",
  "OPERATION_AMBIGUOUS",
  "DOMAIN_CONFLICT",
  "CERTIFICATE_IN_USE",
  "IDEMPOTENCY_CONFLICT",
  "NOT_FOUND",
  "NOT_SUPPORTED",
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "DOCKER_ENGINE_UNAVAILABLE",
];
const TONES = ["success", "warning", "destructive", "secondary", "outline"];
const MIB = 2 ** 20;

function leaves(o: object, prefix = ""): [string, string][] {
  return Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [[`${prefix}${k}`, v] as [string, string]] : leaves(v as object, `${prefix}${k}.`)));
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]!).sort();

describe("application refusal texts", () => {
  it.each(locales)("%s: appStackRefusalText has its own sentence for every APP_STACK_REASONS value", (_n, m) => {
    const generic = errorMessage(m, "VALIDATION_ERROR");
    for (const r of APP_STACK_REASONS) {
      const text = appStackRefusalText(m, "VALIDATION_ERROR", r);
      expect(text, r).toBe((m.apps.reasons as Record<string, string>)[r]);
      expect(text, r).not.toBe(generic);
      expect(text, r).not.toBe(m.errors.generic);
    }
    expect(appStackRefusalText(m, "ALREADY_EXISTS", "name_taken")).toBe(m.apps.reasons.name_taken);
  });

  it.each(locales)("%s: appTemplateRefusalText has its own sentence for every APP_STACK_REASONS value and the admin reasons", (_n, m) => {
    const generic = errorMessage(m, "VALIDATION_ERROR");
    const reasons = m.admin.appTemplates.reasons as Record<string, string>;
    for (const r of [...APP_STACK_REASONS, "slug_taken", "template_archived", "built_in", "unknown_version"]) {
      const text = appTemplateRefusalText(m, "VALIDATION_ERROR", r);
      expect(text, r).toBe(reasons[r]);
      expect(text, r).not.toBe(generic);
      expect(text, r).not.toBe(m.errors.generic);
    }
    expect(appTemplateRefusalText(m, "NOT_SUPPORTED")).toBe(m.admin.appTemplates.notAvailable);
    expect(appTemplateRefusalText(m, "PERMISSION_DENIED", "nope")).toBe(m.errors.PERMISSION_DENIED);
  });

  it.each(locales)("%s: a status refusal names the status in words; codes map before the generic errors", (_n, m) => {
    expect(appStackRefusalText(m, "RESOURCE_LOCKED", "stopped")).toBe(m.apps.reasons.status.replace("{status}", m.apps.status.stopped));
    expect(Object.keys(m.apps.codes).sort()).toEqual([...CODES].sort());
    for (const c of CODES) expect(appStackRefusalText(m, c), c).toBe((m.apps.codes as Record<string, string>)[c]);
    expect(appStackRefusalText(m, "RESOURCE_LOCKED", "nope")).toBe(m.apps.codes.RESOURCE_LOCKED);
    expect(appStackRefusalText(m, "VALIDATION_ERROR")).toBe(m.errors.VALIDATION_ERROR);
    expect(appStackRefusalText(m, "NOPE")).toBe(m.errors.generic);
  });

  it.each(locales)("%s: a stop that did not finish says what to do, not only the status", (_n, m) => {
    const text = appStackRefusalText(m, "RESOURCE_LOCKED", "stop_unfinished");
    expect(text).toBe((m.apps.reasons as Record<string, string>).stop_unfinished);
    expect(text).toContain(m.apps.actions.stop);
    expect(text).toContain(m.apps.actions.restart);
    expect(text).not.toBe(m.apps.codes.RESOURCE_LOCKED);
  });

  it.each(locales)("%s: a run of a task that holds the application says to try again in a few minutes", (_n, m) => {
    const text = appStackRefusalText(m, "RESOURCE_LOCKED", "task_running");
    expect(text).toBe((m.apps.reasons as Record<string, string>).task_running);
    expect(text).not.toBe(m.apps.codes.RESOURCE_LOCKED);
  });

  it("the Italian status refusal reads as the detail page expects", () => {
    expect(appStackRefusalText(itMsgs, "RESOURCE_LOCKED", "stopped")).toBe("Non è possibile ora: l'applicazione è nello stato «Ferma».");
  });

  it.each(locales)("%s: issue #106, a status refusal names a status only when it is the one the page shows", (_n, m) => {
    expect(appStackRefusalText(m, "RESOURCE_LOCKED", "running", "running")).toBe(m.apps.reasons.status.replace("{status}", m.apps.status.running));
    // A crashed component: the page shows failed, the API refused from its stored running.
    expect(appStackRefusalText(m, "RESOURCE_LOCKED", "running", "failed")).toBe(m.apps.reasons.notNow);
    expect(appStackRefusalText(m, "RESOURCE_LOCKED", "degraded", "unknown")).toBe(m.apps.reasons.notNow);
    for (const status of APP_STACK_STATUSES) expect(m.apps.reasons.notNow, status).not.toContain(m.apps.status[status]);
    // The lock answers without a status: its own sentence.
    expect(appStackRefusalText(m, "RESOURCE_LOCKED", undefined, "failed")).toBe(m.apps.codes.RESOURCE_LOCKED);
  });

  it.each(locales)("%s: appStackProblemText says why for a STACK_* reason or a code with its own sentence, a generic line otherwise", (_n, m) => {
    expect(appStackProblemText(m, null)).toBeNull();
    for (const r of APP_STACK_REASONS) expect(appStackProblemText(m, r), r).toBe((m.apps.reasons as Record<string, string>)[r]);
    for (const c of CODES) expect(appStackProblemText(m, c), c).toBe((m.apps.codes as Record<string, string>)[c]);
    expect(appStackProblemText(m, "OPERATION_AMBIGUOUS")).not.toBe(m.apps.history.problemGeneric);
    for (const p of ["OPERATION_INTERRUPTED", "name_taken", "constructor"]) expect(appStackProblemText(m, p), p).toBe(m.apps.history.problemGeneric);
  });

  it.each(locales)("%s: a setting only the application decides has its own sentence", (_n, m) => {
    const text = appStackRefusalText(m, "VALIDATION_ERROR", "PARAM_VALUE_NOT_CUSTOMER");
    expect(text).toBe(m.apps.reasons.PARAM_VALUE_NOT_CUSTOMER);
    expect(text).not.toBe(errorMessage(m, "VALIDATION_ERROR"));
    expect(text).not.toBe(m.apps.reasons.STACK_PARAMETER_INVALID);
  });

  it.each(locales)("%s: a draft whose version is no longer offered says to remove it and install again; any other status keeps the general text", (_n, m) => {
    expect(appStackRefusalText(m, "VALIDATION_ERROR", "STACK_TEMPLATE_UNPUBLISHED", "draft")).toBe(m.apps.reasons.draftUnpublished);
    expect(m.apps.reasons.draftUnpublished).not.toBe(m.apps.reasons.STACK_TEMPLATE_UNPUBLISHED);
    for (const status of ["running", "stopped", "failed"] as const)
      expect(appStackRefusalText(m, "VALIDATION_ERROR", "STACK_TEMPLATE_UNPUBLISHED", status), status).toBe(m.apps.reasons.STACK_TEMPLATE_UNPUBLISHED);
    expect(appStackRefusalText(m, "VALIDATION_ERROR", "STACK_SECRET_MISSING", "draft")).toBe(m.apps.reasons.STACK_SECRET_MISSING);
  });
});

describe("application backup texts", () => {
  it.each(locales)("%s: status, kind, restore and reason words follow the contract lists", (_n, m) => {
    const t = m.apps.backups;
    expect(Object.keys(t.status)).toEqual([...APP_STACK_BACKUP_STATUSES]);
    expect(Object.keys(t.kind)).toEqual([...APP_STACK_BACKUP_KINDS]);
    expect(Object.keys(t.lastRestore)).toEqual([...APP_STACK_RESTORE_STATUSES]);
    expect(Object.keys(t.unavailable)).toEqual([...APP_STACK_BACKUP_UNAVAILABLE_REASONS]);
  });

  it.each(locales)("%s: every step of a backup, a restore and a clean-up has a label beside the ones every operation has", (_n, m) => {
    const steps: Record<string, string> = { ...m.apps.steps, ...m.apps.backups.steps };
    for (const k of APP_STACK_BACKUP_STEP_KEYS) expect(Object.hasOwn(steps, k), k).toBe(true);
    for (const k of Object.keys(m.apps.backups.steps)) {
      expect(APP_STACK_BACKUP_STEP_KEYS as readonly string[], k).toContain(k);
      expect(Object.hasOwn(m.apps.steps, k), k).toBe(false);
    }
  });

  it.each(locales)("%s: a problem reads in the application's words, a storage one in the shared words, anything else generically", (_n, m) => {
    const own: Record<string, string> = m.apps.backups.problem;
    const shared: Record<string, string> = m.site.backups.problem;
    for (const p of Object.keys(own)) {
      expect(BACKUP_PROBLEMS as readonly string[], p).toContain(p);
      expect(appStackBackupProblemText(m, p), p).toBe(own[p]);
    }
    for (const p of APP_STACK_BACKUP_SHARED_PROBLEMS) {
      expect(BACKUP_PROBLEMS as readonly string[], p).toContain(p);
      expect(Object.hasOwn(own, p), p).toBe(false);
      expect(shared[p], p).toBeTruthy();
      expect(appStackBackupProblemText(m, p), p).toBe(shared[p]);
    }
    const known = new Set<string>([...Object.keys(own), ...APP_STACK_BACKUP_SHARED_PROBLEMS]);
    const rest = BACKUP_PROBLEMS.filter((p) => !known.has(p));
    expect(rest).toContain("database_dump_failed");
    expect(rest).toContain("site_not_started");
    for (const p of [...rest, "nope", "constructor", "__proto__", "toString", ""]) expect(appStackBackupProblemText(m, p), p).toBe(own.other);
    expect(appStackBackupProblemText(m, null)).toBe(own.other);
  });

  it.each(locales)("%s: no sentence a backup problem can read names a site", (_n, m) => {
    for (const p of [...BACKUP_PROBLEMS, "nope"]) expect(appStackBackupProblemText(m, p), p).not.toMatch(/\b(sito|siti|site|sites)\b/i);
  });

  it.each(locales)("%s: the refusals of a backup or a restore have their own sentences", (_n, m) => {
    const reasons: Record<string, string> = m.apps.reasons;
    for (const [code, reason] of [
      ["VALIDATION_ERROR", "no_data"],
      ["VALIDATION_ERROR", "no_destination"],
      ["VALIDATION_ERROR", "not_restorable"],
      ["QUOTA_EXCEEDED", "too_many_requests"],
      ["VALIDATION_ERROR", "confirmation_mismatch"],
    ] as const) {
      const text = appStackRefusalText(m, code, reason);
      expect(text, reason).toBe(reasons[reason]);
      expect(text, reason).not.toBe(errorMessage(m, code));
      expect(text, reason).not.toBe(m.apps.codes.QUOTA_EXCEEDED);
    }
  });
});

describe("application formats and tones", () => {
  it("formatCpu writes vCPU with at most two decimals and a dot", () => {
    for (const [milli, text] of [
      [0, "0 vCPU"],
      [500, "0.5 vCPU"],
      [1000, "1 vCPU"],
      [1250, "1.25 vCPU"],
      [2000, "2 vCPU"],
    ] as const)
      expect(formatCpu(milli)).toBe(text);
  });

  it("formatMemory writes MiB below 1 GiB and GiB from there, one decimal at most", () => {
    for (const [bytes, text] of [
      ["0", "0 MiB"],
      [String(256 * MIB), "256 MiB"],
      [String(1536 * MIB), "1.5 GiB"],
      [String(16 * 1024 * MIB), "16 GiB"],
    ] as const)
      expect(formatMemory(bytes)).toBe(text);
  });

  it("the tone tables cover every status and every component health with a Badge variant", () => {
    expect(Object.keys(APP_STACK_STATUS_TONE).sort()).toEqual([...APP_STACK_STATUSES].sort());
    expect(Object.keys(COMPONENT_HEALTH_TONE).sort()).toEqual([...APP_STACK_COMPONENT_HEALTH].sort());
    for (const t of [...Object.values(APP_STACK_STATUS_TONE), ...Object.values(COMPONENT_HEALTH_TONE)]) expect(TONES).toContain(t);
  });
});

describe("application catalogs", () => {
  it("apps and admin.appTemplates have the same keys and the same placeholders in Italian and English", () => {
    for (const [e, i] of [
      [en.apps, itMsgs.apps],
      [en.admin.appTemplates, itMsgs.admin.appTemplates],
    ] as const) {
      const ie = new Map(leaves(i));
      expect(leaves(e).map(([k]) => k)).toEqual([...ie.keys()]);
      for (const [k, v] of leaves(e)) expect(placeholders(v), k).toEqual(placeholders(ie.get(k)!));
    }
  });

  it.each(locales)("%s: statuses, health and step words follow the contract lists", (_n, m) => {
    expect(Object.keys(m.apps.status)).toEqual([...APP_STACK_STATUSES]);
    expect(Object.keys(m.apps.health).sort()).toEqual([...APP_STACK_COMPONENT_HEALTH].sort());
    expect(Object.keys(m.apps.steps)).toEqual([...APP_STACK_STEP_KEYS]);
  });

  it.each(locales)("%s: every built-in application category has a label in apps and admin.appTemplates", (_n, m) => {
    for (const { category } of APP_BUILT_IN_TEMPLATES) {
      expect(Object.hasOwn(m.apps.category, category), category).toBe(true);
      expect(Object.hasOwn(m.admin.appTemplates.category, category), category).toBe(true);
    }
  });
});
