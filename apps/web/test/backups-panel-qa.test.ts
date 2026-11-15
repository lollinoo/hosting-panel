import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type {
  AdminSiteBackupStatusDto,
  BackupLastRestoreDto,
  BackupProblem,
  BackupSettingsDto,
} from "@hosting-panel/contracts";

const mockUpstream = vi.hoisted(() => ({ fetchUpstream: vi.fn() }));
const mockSession = vi.hoisted(() => ({ getSessionFromRequest: vi.fn(), getServerSession: vi.fn() }));
const mockLocale = vi.hoisted(() => ({ getRequestLocale: vi.fn() }));

vi.mock("@/lib/upstream", () => ({ fetchUpstream: mockUpstream.fetchUpstream }));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: mockSession.getSessionFromRequest,
  getServerSession: mockSession.getServerSession,
}));
vi.mock("@/i18n/server", () => ({ getRequestLocale: mockLocale.getRequestLocale }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  notFound: vi.fn(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/backups",
}));

import { POST as restorePost } from "@/app/api/admin/backups/sites/[siteId]/restore/route";
import {
  BackupSettings,
  adminRestoreErrorText,
  adminRestoreText,
  backupProblemText,
  formatDateTime,
  startBackupSitesPolling,
} from "@/components/admin/backup-settings";
import { format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itCatalog } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";
import { MAX_BFF_BODY_BYTES } from "@/lib/bff-files";
import { formatSize } from "@/lib/file-browser";

const CSRF = "csrf-qa-panel-token";
const SITE_ID = "site_qa_panel_1";
const BACKUP_ID = `bkp_${"c".repeat(32)}`;
const AT = "2026-11-15T01:30:00Z";
const NEW_PROBLEMS = ["panel_dump_failed", "panel_dump_tool_missing", "panel_dump_missing", "site_not_started"] as const;
const FORBIDDEN = /\b(snapshot|restic|docker|container|image|volume|network|revision|bucket|S3|job)\b/i;
const LOCALES = [
  ["en", en],
  ["it", itCatalog],
] as const;

// Builds a same-origin admin restore POST with CSRF and an idempotency key unless overridden.
function restoreReq(
  opts: { body?: string; origin?: string | null; csrf?: string | null; key?: string | null; headers?: Record<string, string> } = {},
): NextRequest {
  const headers = new Headers({ Host: "localhost:3000", "Content-Type": "application/json" });
  if (opts.origin !== null) headers.set("Origin", opts.origin ?? "http://localhost:3000");
  if (opts.csrf !== null) headers.set("X-CSRF-Token", opts.csrf ?? CSRF);
  if (opts.key !== null) headers.set("Idempotency-Key", opts.key ?? "idem-qa-1");
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);
  const body = opts.body ?? JSON.stringify({ backupId: BACKUP_ID, confirmName: "QA Site" });
  return new NextRequest(`http://localhost:3000/api/admin/backups/sites/${SITE_ID}/restore`, {
    method: "POST",
    headers,
    body,
  });
}

// Route context with the given siteId param.
function ctx(siteId = SITE_ID) {
  return { params: Promise.resolve({ siteId }) };
}

// Builds settings with a configured destination and no panel copy yet.
function settings(over: Partial<BackupSettingsDto> = {}): BackupSettingsDto {
  return {
    available: true,
    configured: true,
    endpoint: "https://store.example.com",
    region: "eu-south-1",
    bucket: "qa-store",
    prefix: "panel/qa",
    accessKeyId: "AKIAQAEXAMPLE",
    secretAccessKeySet: true,
    scheduleHourUtc: 2,
    retentionDays: 14,
    lastNightlyRunOn: "2026-11-14",
    lastTest: null,
    updatedAt: "2026-11-14T09:00:00Z",
    lastPanelBackup: null,
    newestBackupsTotalBytes: 0,
    ...over,
  };
}

// Builds one admin site row with a succeeded copy.
function row(over: Partial<AdminSiteBackupStatusDto> = {}): AdminSiteBackupStatusDto {
  return {
    siteId: "s1",
    siteName: "QA Alpha",
    organizationId: "org1",
    organizationName: "QA Org",
    lastSuccessAt: AT,
    lastAttemptAt: AT,
    lastStatus: "succeeded",
    problem: null,
    runningOperationId: null,
    lastSuccessBackupId: BACKUP_ID,
    lastSuccessSizeBytes: 1024,
    lastRestore: null,
    ...over,
  };
}

// Builds a lastRestore value with the given status and problem.
function restore(status: BackupLastRestoreDto["status"], problem: BackupProblem | null = null): BackupLastRestoreDto {
  return { backupId: BACKUP_ID, backupStartedAt: AT, status, finishedAt: status === "running" ? null : AT, problem };
}

// Renders the admin backups page component in a locale and decodes common entities.
function renderPage(m: Messages, s: BackupSettingsDto, sites: AdminSiteBackupStatusDto[] | null): string {
  const locale = m === en ? "en" : "it";
  const html = renderToStaticMarkup(
    createElement(I18nProvider, {
      locale,
      messages: m,
      children: createElement(BackupSettings, { csrfToken: CSRF, initial: s, sites }),
    }),
  );
  return html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

// Collects dotted leaf paths with their string values.
function leaves(node: unknown, prefix = ""): Array<[string, string]> {
  if (typeof node === "string") return [[prefix, node]];
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return [];
}

// Returns the new M3c admin texts (panel line, restore, size, total, the four problems) of one catalog.
function newAdminTexts(m: Messages): Array<[string, string]> {
  const t = m.admin.backups;
  return [
    ...leaves(t.panel, "panel"),
    ...leaves(t.panelProblem, "panelProblem"),
    ...leaves(t.restore, "restore"),
    ["sitesTotal", t.sitesTotal],
    ["columns.size", t.columns.size],
    ...NEW_PROBLEMS.map((p): [string, string] => [`problem.${p}`, t.problem[p]]),
  ];
}

// Matches a <button> carrying the aria-label and the disabled attribute in any order.
function disabledButton(label: string): RegExp {
  const l = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<button(?=[^>]*aria-label="${l}")(?=[^>]*disabled="")[^>]*>`);
}

describe("QA M3c web: admin restore BFF route", () => {
  beforeEach(() => {
    mockUpstream.fetchUpstream.mockReset();
    mockSession.getSessionFromRequest.mockReset();
    mockSession.getSessionFromRequest.mockResolvedValue({ accessToken: "tok-qa", csrfToken: CSRF });
  });

  it("refuses hostile siteId values before any upstream call", async () => {
    mockUpstream.fetchUpstream.mockResolvedValue({ ok: true, status: 202, data: { data: { operationId: "op_qa" } } });
    for (const bad of ["..", "%2e%2e", "a".repeat(129), "a b", "a/b"]) {
      expect((await restorePost(restoreReq(), ctx(bad))).status, bad).toBe(400);
    }
    expect(mockUpstream.fetchUpstream).not.toHaveBeenCalled();
    expect((await restorePost(restoreReq(), ctx("a".repeat(128)))).status).toBe(202);
  });

  it("refuses cross-origin, missing CSRF and wrong CSRF with 403 before upstream", async () => {
    for (const opts of [{ origin: "https://evil.example" }, { csrf: null }, { csrf: "wrong-token" }]) {
      expect((await restorePost(restoreReq(opts), ctx())).status, JSON.stringify(opts)).toBe(403);
    }
    expect(mockUpstream.fetchUpstream).not.toHaveBeenCalled();
  });

  it("refuses an oversized body (header and actual), non-JSON, an empty body and a missing key before upstream", async () => {
    const big = restoreReq({ headers: { "Content-Length": String(MAX_BFF_BODY_BYTES + 1) } });
    expect((await restorePost(big, ctx())).status).toBe(413);
    const actual = restoreReq({ body: JSON.stringify({ backupId: BACKUP_ID, confirmName: "x".repeat(MAX_BFF_BODY_BYTES + 10) }) });
    actual.headers.delete("Content-Length");
    expect((await restorePost(actual, ctx())).status).toBe(413);
    expect((await restorePost(restoreReq({ body: "{not json" }), ctx())).status).toBe(400);
    expect((await restorePost(restoreReq({ body: "" }), ctx())).status).toBe(400);
    expect((await restorePost(restoreReq({ key: null }), ctx())).status).toBe(400);
    expect(mockUpstream.fetchUpstream).not.toHaveBeenCalled();
  });

  it("answers 401 without a session and never calls upstream", async () => {
    mockSession.getSessionFromRequest.mockResolvedValue(null);
    expect((await restorePost(restoreReq(), ctx())).status).toBe(401);
    expect(mockUpstream.fetchUpstream).not.toHaveBeenCalled();
  });

  it("forwards the body unchanged with the idempotency key and adds nothing", async () => {
    mockUpstream.fetchUpstream.mockResolvedValue({ ok: true, status: 202, data: { data: { operationId: "op_qa" } } });
    const body = { backupId: BACKUP_ID, confirmName: "QA Site", extra: { nested: [1, "two"] } };
    const res = await restorePost(restoreReq({ body: JSON.stringify(body), key: "idem-qa-forward" }), ctx());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ data: { operationId: "op_qa" } });
    expect(mockUpstream.fetchUpstream).toHaveBeenCalledTimes(1);
    const [path, opts] = mockUpstream.fetchUpstream.mock.calls[0]!;
    expect(path).toBe(`v1/admin/backups/sites/${SITE_ID}/restore`);
    expect(opts).toEqual({
      method: "POST",
      accessToken: "tok-qa",
      idempotencyKey: "idem-qa-forward",
      body,
      timeoutMs: 30_000,
    });
  });

  it("passes upstream 400/403/404/409/422 through unchanged", async () => {
    for (const status of [400, 403, 404, 409, 422]) {
      const error = { error: { code: `CODE_${status}`, message: `m${status}`, details: [{ field: "backupId", message: "x" }] } };
      mockUpstream.fetchUpstream.mockResolvedValueOnce({ ok: false, status, error });
      const res = await restorePost(restoreReq(), ctx());
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(error);
    }
  });

  it("documents what passes through: an upstream answer with a secret or a host path reaches the browser unchanged", async () => {
    // The route is a pure pass-through: scrubbing is the API's job (the API QA file checks no answer carries these).
    const leaky = {
      error: { code: "INTERNAL_ERROR", message: "boom", details: [{ field: "x", message: "/var/lib/hosting-panel/backups/k.bin" }] },
      secretAccessKey: "QA-SECRET-SENTINEL",
    };
    mockUpstream.fetchUpstream.mockResolvedValueOnce({ ok: false, status: 409, error: leaky });
    const res = await restorePost(restoreReq(), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(leaky);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });
});

describe("QA M3c web: page logic", () => {
  afterEach(() => vi.useRealTimers());

  it("panel line: never, made, failed with problem text; hidden when unavailable or not configured", () => {
    for (const [locale, m] of LOCALES) {
      const t = m.admin.backups;
      const date = formatDateTime(AT, locale);
      expect(renderPage(m, settings(), [])).toContain(t.panel.never);
      const made = renderPage(m, settings({ lastPanelBackup: { at: AT, status: "succeeded", problem: null } }), []);
      expect(made).toContain(format(t.panel.made, { date }));
      expect(made).not.toContain(t.panel.never);
      const failed = renderPage(m, settings({ lastPanelBackup: { at: AT, status: "failed", problem: "panel_dump_tool_missing" } }), []);
      expect(failed).toContain(format(t.panel.failed, { date }));
      expect(failed).toContain(t.problem.panel_dump_tool_missing);
      expect(failed).not.toContain(format(t.panel.made, { date }));
      for (const s of [settings({ available: false }), settings({ configured: false })]) {
        const withLine = { ...s, lastPanelBackup: { at: AT, status: "failed" as const, problem: "panel_dump_failed" as const } };
        const html = renderPage(m, withLine, []);
        expect(html).not.toContain(t.panel.never);
        expect(html).not.toContain(format(t.panel.failed, { date }));
        expect(html).not.toContain(t.problem.panel_dump_failed);
      }
    }
  });

  it("panel line: a failed copy never points to a retry button or a site and says it runs again next night", () => {
    const rules = {
      en: { banned: /\b(retry|try again|site)\b|this site/i, again: /next night/i },
      it: { banned: /riprova|\bsito\b|questo sito/i, again: /notte successiva/i },
    };
    for (const [locale, m] of LOCALES) {
      const failed = format(m.admin.backups.panel.failed, { date: formatDateTime(AT, locale) });
      for (const problem of ["interrupted", "other", "repository_locked", "timeout", "files_unreadable", "no_space"] as const) {
        const html = renderPage(m, settings({ lastPanelBackup: { at: AT, status: "failed", problem } }), []);
        const text = html.split(`${failed}</p><p>`)[1]?.split("</p>")[0] ?? "";
        expect(text.length, `${locale} ${problem}`).toBeGreaterThan(20);
        expect(text, `${locale} ${problem}`).not.toMatch(rules[locale].banned);
        expect(text, `${locale} ${problem}`).toMatch(rules[locale].again);
      }
    }
  });

  it("the key warning says the key also opens every stored password with the storage access", () => {
    expect(en.admin.backups.keyWarning).toMatch(/all stored passwords/i);
    expect(en.admin.backups.keyWarning).toMatch(/as secret as a password/i);
    expect(itCatalog.admin.backups.keyWarning).toMatch(/tutte le password salvate/i);
    expect(itCatalog.admin.backups.keyWarning).toMatch(/segreto come una password/i);
  });

  it("the four new problems have texts in both languages wherever problems are shown, each with a next step", () => {
    const nextStep = { en: /\b(try|contact|check|install)\b/i, it: /\b(riprova|contatta|controlla|installa)\b/i };
    for (const [locale, m] of LOCALES) {
      const places: Array<[string, Record<string, string>]> = [
        ["site.backups.problem", m.site.backups.problem],
        ["site.backups.copyProblem", m.site.backups.copyProblem],
        ["admin.backups.problem", m.admin.backups.problem],
      ];
      for (const [where, texts] of places) {
        for (const p of NEW_PROBLEMS) {
          const text = texts[p];
          expect(typeof text, `${locale} ${where}.${p}`).toBe("string");
          expect(text!.trim().length, `${locale} ${where}.${p}`).toBeGreaterThan(20);
          expect(text, `${locale} ${where}.${p}`).toMatch(nextStep[locale]);
          expect(text, `${locale} ${where}.${p} is the generic fallback`).not.toBe(texts.other);
        }
      }
      for (const p of NEW_PROBLEMS) expect(backupProblemText(m.admin.backups, p)).toBe(m.admin.backups.problem[p]);
    }
  });

  it("customer texts of the four problems never use engine words", () => {
    for (const [locale, m] of LOCALES) {
      for (const texts of [m.site.backups.problem, m.site.backups.copyProblem] as Array<Record<string, string>>) {
        for (const p of NEW_PROBLEMS) expect(texts[p], `${locale} ${p}`).not.toMatch(FORBIDDEN);
      }
    }
  });

  it("size column and total line: 0, 1 and many sites, and a site without a copy", () => {
    for (const [locale, m] of LOCALES) {
      const t = m.admin.backups;
      const total = (n: number) => format(t.sitesTotal, { size: formatSize(n, locale) });

      const none = renderPage(m, settings({ newestBackupsTotalBytes: 0 }), []);
      expect(none).toContain(t.sitesEmpty);
      expect(none).not.toContain(total(0));
      expect(none).not.toContain(t.columns.size);

      const one = renderPage(m, settings({ newestBackupsTotalBytes: 3 * 1024 * 1024 }), [
        row({ lastSuccessSizeBytes: 3 * 1024 * 1024 }),
      ]);
      expect(one).toContain(total(3 * 1024 * 1024));
      expect(one).toContain(t.columns.size);
      expect(one).toContain(formatSize(3 * 1024 * 1024, locale));

      const sizes = [1024, 5 * 1024 * 1024, 2 * 1024 * 1024 * 1024];
      const sum = sizes.reduce((a, b) => a + b, 0);
      const many = renderPage(m, settings({ newestBackupsTotalBytes: sum }), [
        ...sizes.map((s, i) => row({ siteId: `s${i}`, siteName: `QA Site ${i}`, lastSuccessSizeBytes: s })),
        row({ siteId: "sx", siteName: "QA Never", lastSuccessAt: null, lastSuccessBackupId: null, lastSuccessSizeBytes: null, lastStatus: null }),
      ]);
      expect(many).toContain(total(sum));
      for (const s of sizes) expect(many).toContain(formatSize(s, locale));
      // Row without a copy: dash in the size cell (and in the date cell).
      expect(many).toMatch(/QA Never<\/td>(?:<td[^>]*>[^<]*<\/td>){2}<td[^>]*>—<\/td>/);
      // The total is the server figure, shown even when 0 bytes with rows present.
      expect(renderPage(m, settings({ newestBackupsTotalBytes: 0 }), [row({ lastSuccessSizeBytes: 0 })])).toContain(total(0));
    }
  });

  it("restore button only with a succeeded copy; disabled while a backup or a restore runs", () => {
    const t = en.admin.backups;
    const label = (n: string) => `${t.restore.button} ${n}`;
    const html = renderPage(en, settings(), [
      row({ siteId: "a", siteName: "QA Ready" }),
      row({ siteId: "b", siteName: "QA None", lastSuccessAt: null, lastSuccessBackupId: null, lastSuccessSizeBytes: null, lastStatus: null }),
      row({ siteId: "c", siteName: "QA Failed Only", lastSuccessAt: null, lastSuccessBackupId: null, lastStatus: "failed", problem: "unreachable" }),
      row({ siteId: "d", siteName: "QA Backing", lastStatus: "running", runningOperationId: "op_1" }),
      row({ siteId: "e", siteName: "QA Restoring", lastRestore: restore("running") }),
    ]);
    expect(html).toContain(`aria-label="${label("QA Ready")}"`);
    expect(html).not.toMatch(disabledButton(label("QA Ready")));
    expect(html).not.toContain(`aria-label="${label("QA None")}"`);
    expect(html).not.toContain(`aria-label="${label("QA Failed Only")}"`);
    expect(html).toMatch(disabledButton(label("QA Backing")));
    expect(html).toMatch(disabledButton(label("QA Restoring")));
  });

  it("the restore request carries the row's backupId and a fresh key per confirmation; the form guards double clicks (source check)", () => {
    // No DOM library in apps/web: the click flow cannot run, so the source is checked instead.
    const src = readFileSync(fileURLToPath(new URL("../src/components/admin/backup-settings.tsx", import.meta.url)), "utf8");
    const handler = src.slice(src.indexOf("async function handleConfirmRestore"), src.indexOf("const fieldErrorNode"));
    expect(handler).toMatch(/\{\s*backupId:\s*row\.lastSuccessBackupId[^,]*,\s*confirmName\s*\}/);
    expect(handler).toMatch(/"Idempotency-Key":\s*crypto\.randomUUID\(\)/);
    expect(handler).toMatch(/\/restore`/);
    const form = readFileSync(fileURLToPath(new URL("../src/components/customer/restore-backup-dialog.tsx", import.meta.url)), "utf8");
    expect(form).toMatch(/if \(inFlightRef\.current \|\|.*\) return;\s*inFlightRef\.current = true;/);
    expect(src).toMatch(/onConfirm=\{handleConfirmRestore\}/);
  });

  it("each restore answer has its own text: wrong name, no copy, 409, 422, other", () => {
    for (const [, m] of LOCALES) {
      const t = m.admin.backups;
      const err = (code: string, details?: unknown) => ({ error: { code, message: "x", details } });
      const texts = [
        adminRestoreErrorText(m, 400, err("VALIDATION_ERROR", [{ field: "confirmName", message: "does_not_match" }])),
        adminRestoreErrorText(m, 400, err("VALIDATION_ERROR", [{ field: "backupId", message: "no_succeeded_backup" }])),
        adminRestoreErrorText(m, 409, err("RESOURCE_LOCKED")),
        adminRestoreErrorText(m, 422, err("NOT_SUPPORTED")),
        adminRestoreErrorText(m, 500, err("INTERNAL_ERROR")),
      ];
      expect(texts[0]).toBe(t.restore.wrongName);
      expect(texts[1]).toBe(t.restore.noCopy);
      expect(new Set(texts).size).toBe(texts.length);
      for (const x of texts) expect(x.trim().length).toBeGreaterThan(10);
      expect(adminRestoreErrorText(m, 500, null)).toBe(m.errors.generic);
    }
  });

  it("outcome texts: running, done, done with a problem, failed with the problem", () => {
    for (const [locale, m] of LOCALES) {
      const t = m.admin.backups;
      const date = formatDateTime(AT, locale);
      expect(adminRestoreText(t, null, locale)).toBeNull();
      expect(adminRestoreText(t, restore("running"), locale)).toBe(format(t.restore.running, { date }));
      expect(adminRestoreText(t, restore("succeeded"), locale)).toBe(format(t.restore.done, { date }));
      expect(adminRestoreText(t, restore("succeeded", "site_not_started"), locale)).toBe(t.problem.site_not_started);
      expect(adminRestoreText(t, restore("failed", "restore_prepare_failed"), locale)).toBe(
        `${format(t.restore.failed, { date })} ${t.problem.restore_prepare_failed}`,
      );
      expect(adminRestoreText(t, restore("failed", null), locale)).toBe(`${format(t.restore.failed, { date })} ${t.problem.other}`);
      const html = renderPage(m, settings(), [row({ lastRestore: restore("failed", "restore_prepare_failed") })]);
      expect(html).toContain(`${format(t.restore.failed, { date })} ${t.problem.restore_prepare_failed}`);
    }
  });

  it("polling continues while a restore runs and stops once it settles", async () => {
    vi.useFakeTimers();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ kind: "ok", sites: [row({ lastRestore: restore("running") })] })
      .mockResolvedValueOnce({ kind: "ok", sites: [row({ lastRestore: restore("running") })] })
      .mockResolvedValueOnce({ kind: "ok", sites: [row({ lastRestore: restore("succeeded") })] });
    const onSites = vi.fn();
    startBackupSitesPolling({ load, onSites, onError: vi.fn(), intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(load).toHaveBeenCalledTimes(3);
    expect(onSites).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("polling stops after a 401 (load answers stop) and the page's loader maps 401 to stop", async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValue({ kind: "error", stop: true });
    const onError = vi.fn();
    startBackupSitesPolling({ load, onSites: vi.fn(), onError, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    // The loader lives inside a useEffect (no DOM here): check its 401 branch in the source.
    const src = readFileSync(fileURLToPath(new URL("../src/components/admin/backup-settings.tsx", import.meta.url)), "utf8");
    expect(src).toMatch(/if \(res\.status === 401[^)]*\) \{[^}]*return \{ kind: "error", stop: true \};/);
  });
});

describe("QA M3c web: texts", () => {
  it("every new admin.backups text exists in both languages, is non-empty and is not its own key", () => {
    const enTexts = new Map(newAdminTexts(en));
    const itTexts = new Map(newAdminTexts(itCatalog));
    expect([...enTexts.keys()].sort()).toEqual([...itTexts.keys()].sort());
    for (const [key, value] of [...enTexts, ...itTexts]) {
      expect(value.trim().length, key).toBeGreaterThan(0);
      expect(value, key).not.toBe(key);
      expect(value, key).not.toBe(key.split(".").pop());
      expect(value, key).not.toBe(`admin.backups.${key}`);
    }
    for (const [key, value] of enTexts) expect(itTexts.get(key), `${key} not translated`).not.toBe(value);
  });

  it("both languages have the same keys (whole catalog)", () => {
    const enKeys = leaves(en).map(([k]) => k).sort();
    const itKeys = leaves(itCatalog).map(([k]) => k).sort();
    expect(itKeys).toEqual(enKeys);
  });

  it("no new admin text uses an engine word", () => {
    for (const [locale, m] of LOCALES) {
      for (const [key, value] of newAdminTexts(m)) {
        // By design (web-infra-docs.md:337-338) admin problem texts name the systemd unit to inspect;
        // only that literal command token is set aside.
        const text = value.replaceAll("hp-docker-executor", "hp-unit");
        expect(text, `${locale} ${key}`).not.toMatch(FORBIDDEN);
      }
    }
  });

  it("the restore dialog says that what is on the site now is lost", () => {
    expect(en.admin.backups.restore.body).toMatch(/lost/i);
    expect(itCatalog.admin.backups.restore.body).toMatch(/pers[oaie]/i);
    for (const m of [en, itCatalog]) {
      const s = m.admin.backups.restore;
      expect(s.backupFirst.length).toBeGreaterThan(0);
      expect(s.confirm).not.toBe(s.cancel);
    }
  });
});
