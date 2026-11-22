import { describe, expect, it } from "vitest";
import { APP_BUILT_IN_TEMPLATES, APP_STACK_COMPONENT_HEALTH, APP_STACK_REASONS, APP_STACK_STATUSES, APP_STACK_STEP_KEYS } from "@hosting-panel/contracts";
import { errorMessage } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { appTemplateRefusalText } from "@/components/admin/app-template-text";
import {
  APP_STACK_STATUS_TONE,
  COMPONENT_HEALTH_TONE,
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

  it("the Italian status refusal reads as the detail page expects", () => {
    expect(appStackRefusalText(itMsgs, "RESOURCE_LOCKED", "stopped")).toBe("Non è possibile ora: l'applicazione è nello stato «Ferma».");
  });

  it.each(locales)("%s: appStackProblemText says why for a STACK_* reason, a generic line otherwise", (_n, m) => {
    expect(appStackProblemText(m, null)).toBeNull();
    for (const r of APP_STACK_REASONS) expect(appStackProblemText(m, r), r).toBe((m.apps.reasons as Record<string, string>)[r]);
    for (const p of ["DOCKER_ENGINE_UNAVAILABLE", "OPERATION_INTERRUPTED", "OPERATION_AMBIGUOUS", "name_taken"])
      expect(appStackProblemText(m, p), p).toBe(m.apps.history.problemGeneric);
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
