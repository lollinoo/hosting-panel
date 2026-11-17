import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BACKUP_PROBLEMS,
  BackupSettingsInputSchema,
  type AdminSiteBackupStatusDto,
  type BackupSettingsDto,
} from "@hosting-panel/contracts";
import { format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getSessionFromRequest = vi.fn();
const getServerSession = vi.fn();
const getRequestLocale = vi.fn();
const redirect = vi.fn();

vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...args: unknown[]) => fetchUpstream(...args),
}));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: (...args: unknown[]) => getSessionFromRequest(...args),
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));
vi.mock("@/i18n/server", () => ({
  getRequestLocale: (...args: unknown[]) => getRequestLocale(...args),
}));
vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => redirect(...args),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/backups",
}));

import AdminBackupsPage from "@/app/admin/backups/page";
import { DELETE, GET, PATCH } from "@/app/api/admin/backups/route";
import { GET as listSites } from "@/app/api/admin/backups/sites/route";
import { POST as runSiteBackup } from "@/app/api/admin/backups/sites/[siteId]/run/route";
import { POST as restoreSite } from "@/app/api/admin/backups/sites/[siteId]/restore/route";
import { POST as testConnection } from "@/app/api/admin/backups/test/route";
import {
  BackupSettings,
  ConfirmTargetChangeBody,
  RemoveBackupTargetBody,
  adminRestoreErrorText,
  adminRestoreText,
  backupApiErrorText,
  backupProblemText,
  formatDateTime,
  formatLocalHour,
  formatNightlyDate,
  formatUtcHour,
  isBackupTargetChanged,
  startBackupSitesPolling,
  validateBackupSettingsForm,
  type BackupFieldKey,
  type BackupFormDraft,
} from "@/components/admin/backup-settings";
import { RestoreBackupForm } from "@/components/customer/restore-backup-dialog";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { formatDate, formatSize } from "@/lib/file-browser";
import { Dialog } from "@/components/ui/dialog";

const wrap = (m: Messages, child: React.ReactElement) =>
  createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: child });

const decodeHtml = (html: string) => html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"');

const req = (method: string, headers: Record<string, string> = {}, body?: unknown) =>
  new Request("http://localhost:3000/x", {
    method,
    headers: {
      Host: "localhost:3000",
      Origin: "http://localhost:3000",
      "X-CSRF-Token": "csrf",
      ...headers,
    },
    ...(method === "GET" || body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const siteCtx = (siteId = "s1") => ({ params: Promise.resolve({ siteId }) });

const makeSettings = (over: Partial<BackupSettingsDto> = {}): BackupSettingsDto => ({
  available: true,
  configured: true,
  endpoint: "https://s3.example.com",
  region: "eu-south-1",
  bucket: "hosting-backups",
  prefix: "panel/prod",
  accessKeyId: "AKIAEXAMPLE123",
  secretAccessKeySet: true,
  scheduleHourUtc: 2,
  retentionDays: 14,
  lastNightlyRunOn: "2026-11-14",
  lastTest: { outcome: "ok", problem: null, at: "2026-11-14T10:00:00Z" },
  updatedAt: "2026-11-14T09:00:00Z",
  lastPanelBackup: null,
  newestBackupsTotalBytes: 0,
  ...over,
});

const makeSiteRow = (over: Partial<AdminSiteBackupStatusDto> = {}): AdminSiteBackupStatusDto => ({
  siteId: "s1",
  siteName: "Hotel Bella Vista",
  organizationId: "org1",
  organizationName: "Acme SRL",
  lastSuccessAt: "2026-11-14T02:05:00Z",
  lastAttemptAt: "2026-11-14T02:05:00Z",
  lastStatus: "succeeded",
  problem: null,
  runningOperationId: null,
  lastSuccessBackupId: null,
  lastSuccessSizeBytes: null,
  lastRestore: null,
  ...over,
});

const makeDraft = (over: Partial<BackupFormDraft> = {}): BackupFormDraft => ({
  endpoint: "https://s3.example.com",
  region: "eu-south-1",
  bucket: "hosting-backups",
  prefix: "panel/prod",
  accessKeyId: "AKIAEXAMPLE123",
  secretAccessKey: "super-secret-value-123",
  scheduleHourUtc: 2,
  retentionInput: "14",
  ...over,
});

describe("admin backups BFF routes (a, b, c)", () => {
  beforeEach(() => {
    fetchUpstream.mockReset();
    getSessionFromRequest.mockReset();
    getSessionFromRequest.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
  });

  it("(a) forwards paths, methods, timeouts, Idempotency-Key, and validates siteId before upstream", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: {} } });

    await GET(req("GET"));
    await PATCH(req("PATCH", {}, { endpoint: "https://s3.example.com" }));
    await DELETE(req("DELETE"));
    await testConnection(req("POST"));
    await listSites(req("GET"));
    await runSiteBackup(req("POST", { "Idempotency-Key": "idem-1" }, {}), siteCtx("site_1"));

    expect(fetchUpstream.mock.calls.map(([p, o]) => [p, o.method, o.timeoutMs])).toEqual([
      ["v1/admin/backups", "GET", 20_000],
      ["v1/admin/backups", "PATCH", undefined],
      ["v1/admin/backups", "DELETE", undefined],
      ["v1/admin/backups/test", "POST", 45_000],
      ["v1/admin/backups/sites", "GET", 20_000],
      ["v1/admin/backups/sites/site_1/run", "POST", 30_000],
    ]);
    expect(fetchUpstream.mock.calls[5]![1].idempotencyKey).toBe("idem-1");
    expect(fetchUpstream.mock.calls[5]![1].body).toEqual({});

    fetchUpstream.mockClear();
    const missingIdem = await runSiteBackup(req("POST", {}, {}), siteCtx("site_1"));
    expect(missingIdem.status).toBe(400);
    expect(fetchUpstream).not.toHaveBeenCalled();

    for (const badId of ["bad/id", "../escape", "site with space", ""]) {
      const badPath = await runSiteBackup(
        req("POST", { "Idempotency-Key": "idem-2" }, {}),
        siteCtx(badId),
      );
      expect(badPath.status).toBe(400);
      expect(getSessionFromRequest).toHaveBeenCalledTimes(7); // stopped at segment guard before session lookup
      expect(fetchUpstream).not.toHaveBeenCalled();
    }
  });

  it("(a) passes 401 session errors and missing sessions through", async () => {
    fetchUpstream.mockResolvedValue({
      ok: false,
      status: 401,
      error: { error: { code: "UNAUTHENTICATED" } },
    });
    expect((await GET(req("GET"))).status).toBe(401);
    expect((await testConnection(req("POST"))).status).toBe(401);
    expect((await listSites(req("GET"))).status).toBe(401);
    expect(
      (await runSiteBackup(req("POST", { "Idempotency-Key": "k1" }, {}), siteCtx("s1"))).status,
    ).toBe(401);

    getSessionFromRequest.mockResolvedValueOnce(null);
    expect((await GET(req("GET"))).status).toBe(401);
  });

  it("(b) rejects missing/bad CSRF token and mismatched Origin with 403 and no upstream call", async () => {
    const badCsrf = { "X-CSRF-Token": "wrong" };
    const missingCsrf = { "X-CSRF-Token": "" };
    const badOrigin = { Origin: "https://evil.example" };

    for (const headers of [badCsrf, missingCsrf, badOrigin]) {
      expect((await PATCH(req("PATCH", headers, {}))).status).toBe(403);
      expect((await DELETE(req("DELETE", headers))).status).toBe(403);
      expect((await testConnection(req("POST", headers))).status).toBe(403);
      expect(
        (await runSiteBackup(req("POST", { ...headers, "Idempotency-Key": "k1" }, {}), siteCtx("s1")))
          .status,
      ).toBe(403);
    }
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("(c) keeps secretAccessKeySet:true unredacted and never returns secretAccessKey", async () => {
    const payload = makeSettings({ secretAccessKeySet: true });
    fetchUpstream.mockResolvedValueOnce({ ok: true, status: 200, data: { data: payload } });
    const res = await GET(req("GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: BackupSettingsDto };
    expect(body.data.secretAccessKeySet).toBe(true);
    expect(body.data).not.toHaveProperty("secretAccessKey");
    expect(JSON.stringify(body)).not.toContain('"secretAccessKey"');
  });
});

describe("admin backups page and component states (d, e, f)", () => {
  beforeEach(() => {
    fetchUpstream.mockReset();
    getServerSession.mockReset();
    getRequestLocale.mockReset();
    redirect.mockReset();
    getServerSession.mockResolvedValue({
      accessToken: "tok",
      csrfToken: "csrf",
      user: { id: "u1", email: "admin@example.com", name: "Admin", role: "hosting_admin", locale: "en" },
    });
    getRequestLocale.mockResolvedValue("en");
  });

  it("(d) renders keyWarning with /etc/hosting-panel/backup.key in all 4 states including available:false", () => {
    const states: BackupSettingsDto[] = [
      makeSettings({ available: false, configured: false, endpoint: null, region: null, bucket: null, prefix: "", accessKeyId: null, secretAccessKeySet: false, lastTest: null }),
      makeSettings({ available: true, configured: false, endpoint: null, region: null, bucket: null, prefix: "", accessKeyId: null, secretAccessKeySet: false, lastTest: null }),
      makeSettings({ available: true, configured: true, lastTest: { outcome: "failed", problem: "auth_failed", at: "2026-11-14T10:00:00Z" } }),
      makeSettings({ available: true, configured: true, lastTest: null }),
    ];

    for (const m of [en, itMsgs]) {
      for (const dto of states) {
        const html = decodeHtml(
          renderToStaticMarkup(
            wrap(m, createElement(BackupSettings, { csrfToken: "csrf", initial: dto, sites: [] })),
          ),
        );
        expect(html).toContain("/etc/hosting-panel/backup.key");
        expect(html).toContain(m.admin.backups.keyWarning);
      }
    }
  });

  it("(e) renders each state text and hides form, test, remove and table when available:false", () => {
    const notAvailHtml = decodeHtml(
      renderToStaticMarkup(
        wrap(
          en,
          createElement(BackupSettings, {
            csrfToken: "csrf",
            initial: makeSettings({ available: false, configured: false }),
            sites: [makeSiteRow()],
          }),
        ),
      ),
    );
    expect(notAvailHtml).toContain(en.admin.backups.state.notAvailable);
    expect(notAvailHtml).not.toContain("<form");
    expect(notAvailHtml).not.toContain("<table");
    expect(notAvailHtml).not.toContain(en.admin.backups.testButton);
    expect(notAvailHtml).not.toContain(en.admin.backups.removeButton);
    expect(notAvailHtml).not.toContain("Hotel Bella Vista");

    const neverSetUpHtml = decodeHtml(
      renderToStaticMarkup(
        wrap(
          en,
          createElement(BackupSettings, {
            csrfToken: "csrf",
            initial: makeSettings({
              available: true,
              configured: false,
              endpoint: null,
              region: null,
              bucket: null,
              prefix: "",
              accessKeyId: null,
              secretAccessKeySet: false,
              lastTest: null,
            }),
            sites: [],
          }),
        ),
      ),
    );
    expect(neverSetUpHtml).toContain(en.admin.backups.state.neverSetUp);
    expect(neverSetUpHtml).toContain(en.admin.backups.testSaveFirst);
    expect(neverSetUpHtml).not.toContain(en.admin.backups.removeButton);
    expect(neverSetUpHtml).toContain(en.admin.backups.sitesEmpty);

    const failedTestHtml = decodeHtml(
      renderToStaticMarkup(
        wrap(
          en,
          createElement(BackupSettings, {
            csrfToken: "csrf",
            initial: makeSettings({
              lastTest: { outcome: "failed", problem: "wrong_key", at: "2026-11-14T10:00:00Z" },
            }),
            sites: [],
          }),
        ),
      ),
    );
    expect(failedTestHtml).toContain(en.admin.backups.problem.wrong_key);
    expect(failedTestHtml).toContain(en.admin.backups.state.lastTestFailed.split(" ({when})")[0]!);

    const workingNeverHtml = decodeHtml(
      renderToStaticMarkup(
        wrap(
          en,
          createElement(BackupSettings, {
            csrfToken: "csrf",
            initial: makeSettings({ lastNightlyRunOn: null, lastTest: null, scheduleHourUtc: 2 }),
            sites: [],
          }),
        ),
      ),
    );
    expect(workingNeverHtml).toContain("02:00 UTC");
    expect(workingNeverHtml).toContain(en.admin.backups.state.nightlyNever);

    const workingRanHtml = decodeHtml(
      renderToStaticMarkup(
        wrap(
          itMsgs,
          createElement(BackupSettings, {
            csrfToken: "csrf",
            initial: makeSettings({ lastNightlyRunOn: "2026-11-14", scheduleHourUtc: 23 }),
            sites: [],
          }),
        ),
      ),
    );
    expect(workingRanHtml).toContain("23:00 UTC");
    expect(workingRanHtml).toContain(formatLocalHour(23, "it"));
    expect(workingRanHtml).toContain(formatNightlyDate("2026-11-14", "it", itMsgs.admin.backups.state.nightlyNever));
    expect(formatUtcHour(2)).toBe("02:00");
    expect(workingRanHtml).toContain('<option value="0">');
    expect(workingRanHtml).toContain('<option value="23"');
  });

  it("(f) keeps secret input empty and shows secretKeep placeholder only when set", () => {
    for (const m of [en, itMsgs]) {
      const setHtml = decodeHtml(
        renderToStaticMarkup(
          wrap(
            m,
            createElement(BackupSettings, {
              csrfToken: "csrf",
              initial: makeSettings({ secretAccessKeySet: true }),
              sites: [],
            }),
          ),
        ),
      );
      const setSecretInput = setHtml.match(/<input[^>]*id="backup-secret"[^>]*>/)?.[0] ?? "";
      expect(setSecretInput).toContain('type="password"');
      expect(setSecretInput).toContain('value=""');
      expect(setSecretInput).toContain(`placeholder="${m.admin.backups.secretKeep}"`);
      expect(setHtml).toContain(format(m.admin.backups.secretIs, { state: m.admin.backups.secretSet }));

      const unsetHtml = decodeHtml(
        renderToStaticMarkup(
          wrap(
            m,
            createElement(BackupSettings, {
              csrfToken: "csrf",
              initial: makeSettings({ secretAccessKeySet: false }),
              sites: [],
            }),
          ),
        ),
      );
      const unsetSecretInput = unsetHtml.match(/<input[^>]*id="backup-secret"[^>]*>/)?.[0] ?? "";
      expect(unsetSecretInput).toContain('type="password"');
      expect(unsetSecretInput).toContain('value=""');
      expect(unsetSecretInput).not.toContain(`placeholder="${m.admin.backups.secretKeep}"`);
      expect(unsetHtml).toContain(format(m.admin.backups.secretIs, { state: m.admin.backups.secretNotSet }));
    }
  });

  it("renders per-site table statuses, Retry/Run buttons, and sitesLoadFailed", () => {
    const sites: AdminSiteBackupStatusDto[] = [
      makeSiteRow({ siteId: "s1", siteName: "Alpha", lastStatus: "succeeded", problem: null }),
      makeSiteRow({ siteId: "s2", siteName: "Beta", lastStatus: "failed", problem: "no_space" }),
      makeSiteRow({ siteId: "s3", siteName: "Gamma", lastStatus: "running", runningOperationId: "op_1", problem: null }),
      makeSiteRow({ siteId: "s4", siteName: "Delta", lastStatus: null, lastSuccessAt: null, lastAttemptAt: null }),
    ];
    const html = decodeHtml(
      renderToStaticMarkup(
        wrap(en, createElement(BackupSettings, { csrfToken: "csrf", initial: makeSettings(), sites })),
      ),
    );
    expect(html).toContain("Alpha");
    expect(html).toContain("Beta");
    expect(html).toContain("Gamma");
    expect(html).toContain("Delta");
    expect(html).toContain(en.admin.backups.siteState.succeeded);
    expect(html).toContain(en.admin.backups.siteState.failed);
    expect(html).toContain(en.admin.backups.siteState.running);
    expect(html).toContain(en.admin.backups.siteState.never);
    expect(html).toContain(en.admin.backups.problem.no_space);
    expect(html).toContain(en.admin.backups.retry);
    expect(html).toContain(en.admin.backups.runNow);

    const loadFailedHtml = decodeHtml(
      renderToStaticMarkup(
        wrap(en, createElement(BackupSettings, { csrfToken: "csrf", initial: makeSettings(), sites: null })),
      ),
    );
    expect(loadFailedHtml).toContain(en.admin.backups.sitesLoadFailed);
  });

  it("server page redirects when unauthenticated, shows generic error on load fail, and renders BackupSettings", async () => {
    redirect.mockImplementation((url: string) => {
      throw new Error(`REDIRECT:${url}`);
    });
    getServerSession.mockResolvedValueOnce(null);
    await expect(AdminBackupsPage()).rejects.toThrow("REDIRECT:/login");

    fetchUpstream.mockResolvedValueOnce({ ok: false, status: 500 });
    fetchUpstream.mockResolvedValueOnce({ ok: true, status: 200, data: { data: [] } });
    const errEl = await AdminBackupsPage();
    const errHtml = decodeHtml(renderToStaticMarkup(errEl));
    expect(errHtml).toContain(en.errors.generic);

    fetchUpstream.mockResolvedValueOnce({ ok: true, status: 200, data: { data: makeSettings() } });
    fetchUpstream.mockResolvedValueOnce({ ok: true, status: 200, data: { data: [makeSiteRow()] } });
    const okEl = await AdminBackupsPage();
    const okHtml = decodeHtml(renderToStaticMarkup(wrap(en, okEl)));
    expect(okHtml).toContain(en.admin.backups.title);
    expect(okHtml).toContain("Hotel Bella Vista");
    expect(okHtml).toContain("/etc/hosting-panel/backup.key");
  });
});

describe("validation, problem catalog, confirmations and sidebar (g, h, i, j)", () => {
  afterEach(() => vi.useRealTimers());

  it("(g) maps every BackupSettingsInputSchema failure and secret_access_key_required to t.field in IT and EN", () => {
    const cases: Array<{ patch: Partial<BackupFormDraft>; secretSet?: boolean; field: BackupFieldKey; key: keyof typeof en.admin.backups.field }> = [
      { patch: { endpoint: "http://localhost:9000" }, field: "endpoint", key: "endpoint_invalid" },
      { patch: { endpoint: "http://127.0.0.1:9000" }, field: "endpoint", key: "endpoint_invalid" },
      { patch: { endpoint: "http://[::1]:9000" }, field: "endpoint", key: "endpoint_invalid" },
      { patch: { endpoint: "https://s3.example.com:70000" }, field: "endpoint", key: "endpoint_invalid" },
      { patch: { region: "EU-WEST-1" }, field: "region", key: "region_invalid" },
      { patch: { bucket: "Bad_Bucket" }, field: "bucket", key: "bucket_invalid" },
      { patch: { prefix: "a".repeat(256) }, field: "prefix", key: "prefix_invalid" },
      { patch: { accessKeyId: "bad key" }, field: "accessKeyId", key: "access_key_id_invalid" },
      { patch: { secretAccessKey: "bad secret" }, field: "secretAccessKey", key: "secret_access_key_invalid" },
      { patch: { secretAccessKey: "" }, secretSet: false, field: "secretAccessKey", key: "secret_access_key_required" },
      { patch: { scheduleHourUtc: 24 }, field: "scheduleHourUtc", key: "schedule_hour_invalid" },
      { patch: { retentionInput: "" }, field: "retentionDays", key: "retention_days_invalid" },
      { patch: { retentionInput: "366" }, field: "retentionDays", key: "retention_days_invalid" },
    ];

    const seenKeys = new Set<string>();
    for (const c of cases) {
      const res = validateBackupSettingsForm(makeDraft(c.patch), c.secretSet ?? true);
      expect(res.hasUnknownError).toBe(false);
      expect(res.fieldErrors[c.field]).toBe(c.key);
      seenKeys.add(c.key);
      for (const m of [en, itMsgs]) {
        expect(m.admin.backups.field[c.key]).toBeTruthy();
      }
      expect(en.admin.backups.field[c.key]).not.toBe(itMsgs.admin.backups.field[c.key]);
    }
    expect([...seenKeys].sort()).toEqual(Object.keys(en.admin.backups.field).sort());

    const keptSecret = validateBackupSettingsForm(makeDraft({ secretAccessKey: "" }), true);
    expect(keptSecret.fieldErrors).toEqual({});
    expect(BackupSettingsInputSchema.safeParse(keptSecret.input).success).toBe(true);
  });

  it("(h) covers every BACKUP_PROBLEMS key in IT and EN and every error text gives a next step", () => {
    const enNext = /check|fix|use|put|free|try|give|create|reload|save|enter|set up|contact/i;
    const itNext = /controlla|correggi|usa|rimetti|libera|riprova|dai|crea|ricarica|salva|inserisci|configura|contatta/i;

    for (const k of BACKUP_PROBLEMS) {
      expect(en.admin.backups.problem[k]).toBeTruthy();
      expect(itMsgs.admin.backups.problem[k]).toBeTruthy();
      expect(en.admin.backups.problem[k]).not.toBe(itMsgs.admin.backups.problem[k]);
      expect(backupProblemText(en.admin.backups, k)).toBe(en.admin.backups.problem[k]);
      expect(en.admin.backups.problem[k]).toMatch(enNext);
      expect(itMsgs.admin.backups.problem[k]).toMatch(itNext);
    }
    expect(Object.keys(en.admin.backups.problem).sort()).toEqual([...BACKUP_PROBLEMS].sort());
    expect(Object.keys(itMsgs.admin.backups.problem).sort()).toEqual([...BACKUP_PROBLEMS].sort());
    expect(backupProblemText(en.admin.backups, null)).toBe(en.admin.backups.problem.other);

    // Every admin.backups problem, error, ambiguous test and load-failed text names a next step
    for (const [m, re] of [[en, enNext], [itMsgs, itNext]] as const) {
      const texts = [
        ...Object.values(m.admin.backups.errors),
        m.admin.backups.testAmbiguous,
        m.admin.backups.sitesLoadFailed,
      ];
      for (const text of texts) expect(text).toMatch(re);
    }

    // API error mappings
    expect(backupApiErrorText(en, 504, { error: { code: "INTERNAL_ERROR" } }, "test")).toBe(en.admin.backups.testAmbiguous);
    expect(backupApiErrorText(en, 502, { error: { code: "OPERATION_AMBIGUOUS" } }, "test")).toBe(en.admin.backups.testAmbiguous);
    expect(backupApiErrorText(en, 400, { error: { code: "VALIDATION_ERROR", details: [{ message: "not_configured" }] } }, "sites")).toBe(en.admin.backups.errors.notConfigured);
    expect(backupApiErrorText(en, 409, { error: { code: "RESOURCE_LOCKED", details: [{ message: "not_ready" }] } }, "sites")).toBe(en.admin.backups.errors.notReady);
    expect(backupApiErrorText(en, 409, { error: { code: "RESOURCE_LOCKED" } }, "sites")).toBe(en.errors.RESOURCE_LOCKED);
    expect(backupApiErrorText(en, 401, { error: { code: "UNAUTHENTICATED" } }, "settings")).toBe(en.site.files.errors.UNAUTHENTICATED);
    expect(backupApiErrorText(en, 422, { error: { code: "NOT_SUPPORTED" } }, "settings")).toBe(en.admin.backups.state.notAvailable);
  });

  it("(i) target-change and removal confirmations name bucket / nightly consequences", () => {
    expect(en.admin.backups.removeConfirm).toMatch(/bucket/i);
    expect(en.admin.backups.removeConfirm).toMatch(/nightly/i);
    expect(itMsgs.admin.backups.removeConfirm).toMatch(/bucket/i);
    expect(itMsgs.admin.backups.removeConfirm).toMatch(/notturni/i);

    const saved = makeSettings();
    expect(isBackupTargetChanged(saved, { endpoint: saved.endpoint!, bucket: saved.bucket!, prefix: saved.prefix })).toBe(false);
    expect(isBackupTargetChanged(saved, { endpoint: "https://other.example.com", bucket: saved.bucket!, prefix: saved.prefix })).toBe(true);
    expect(isBackupTargetChanged(saved, { endpoint: saved.endpoint!, bucket: "other-bucket", prefix: saved.prefix })).toBe(true);
    expect(isBackupTargetChanged(saved, { endpoint: saved.endpoint!, bucket: saved.bucket!, prefix: "other/prefix" })).toBe(true);
    expect(isBackupTargetChanged(makeSettings({ configured: false }), { endpoint: "https://other.example.com", bucket: "b", prefix: "" })).toBe(false);

    for (const m of [en, itMsgs]) {
      const changeDialogHtml = decodeHtml(
        renderToStaticMarkup(
          wrap(
            m,
            createElement(
              Dialog,
              { open: true },
              createElement(ConfirmTargetChangeBody, {
                busy: false,
                onConfirm: () => {},
                onCancel: () => {},
              }),
            ),
          ),
        ),
      );
      expect(changeDialogHtml).toContain(m.admin.backups.changeWarning);
      expect(changeDialogHtml).toContain(m.admin.backups.save);
      expect(changeDialogHtml).toContain(m.admin.backups.removeCancel);

      const removeDialogHtml = decodeHtml(
        renderToStaticMarkup(
          wrap(
            m,
            createElement(
              Dialog,
              { open: true },
              createElement(RemoveBackupTargetBody, {
                busy: false,
                onConfirm: () => {},
                onCancel: () => {},
              }),
            ),
          ),
        ),
      );
      expect(removeDialogHtml).toContain(m.admin.backups.removeTitle);
      expect(removeDialogHtml).toContain(m.admin.backups.removeConfirm);
      expect(removeDialogHtml).toContain(m.admin.backups.removeAction);
      expect(removeDialogHtml).toContain(m.admin.backups.removeCancel);
    }
  });

  it("(j) sidebar contains /admin/backups in IT and EN", () => {
    for (const m of [en, itMsgs]) {
      const html = renderToStaticMarkup(wrap(m, createElement(SidebarNav)));
      expect(html).toContain('href="/admin/backups"');
      expect(html).toContain(m.admin.nav.backups);
    }
  });

  it("polls sites every 5 s via non-overlapping setTimeout while running and stops when settled or on 401/403/404", async () => {
    vi.useFakeTimers();
    const runningRow = makeSiteRow({ lastStatus: "running", runningOperationId: "op_1" });
    const doneRow = makeSiteRow({ lastStatus: "succeeded", runningOperationId: null });

    let resolveSlow!: (v: { kind: "ok"; sites: AdminSiteBackupStatusDto[] }) => void;
    const load = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (resolveSlow = r)))
      .mockResolvedValueOnce({ kind: "ok", sites: [doneRow] });
    const onSites = vi.fn();
    const onError = vi.fn();

    startBackupSitesPolling({ load, onSites, onError });
    expect(load).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(load).toHaveBeenCalledTimes(1);

    // Slow request stays in flight: no overlapping poll fires
    await vi.advanceTimersByTimeAsync(15_000);
    expect(load).toHaveBeenCalledTimes(1);

    resolveSlow({ kind: "ok", sites: [runningRow] });
    await vi.advanceTimersByTimeAsync(0);
    expect(onSites).toHaveBeenCalledWith([runningRow]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(onSites).toHaveBeenCalledWith([doneRow]);

    // Stopped once no row is running
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();

    // Terminal HTTP stop
    const loadStop = vi.fn().mockResolvedValue({ kind: "error", stop: true });
    startBackupSitesPolling({ load: loadStop, onSites: vi.fn(), onError });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(loadStop).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("panel copy line, storage figures and the administrator's restore (C1)", () => {
  const render = (m: Messages, initial: BackupSettingsDto, sites: AdminSiteBackupStatusDto[] | null = []) =>
    decodeHtml(renderToStaticMarkup(wrap(m, createElement(BackupSettings, { csrfToken: "csrf", initial, sites }))));
  const at = "2026-11-15T01:30:00Z";

  beforeEach(() => {
    fetchUpstream.mockReset();
    getSessionFromRequest.mockReset();
    getSessionFromRequest.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
  });

  it("BFF restore route forwards the body as it is with the Idempotency-Key, and refuses bad requests before upstream", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 202, data: { data: { operationId: "op_1" } } });
    const body = { backupId: `bkp_${"a".repeat(32)}`, confirmName: "Hotel Bella Vista" };
    const res = await restoreSite(req("POST", { "Idempotency-Key": "idem-r" }, body), siteCtx("site_1"));
    expect(res.status).toBe(202);
    const [path, opts] = fetchUpstream.mock.calls[0]!;
    expect([path, opts.method, opts.timeoutMs, opts.idempotencyKey]).toEqual([
      "v1/admin/backups/sites/site_1/restore",
      "POST",
      30_000,
      "idem-r",
    ]);
    expect(opts.body).toEqual(body);

    fetchUpstream.mockClear();
    expect((await restoreSite(req("POST", {}, body), siteCtx("site_1"))).status).toBe(400);
    expect((await restoreSite(req("POST", { "Idempotency-Key": "k" }, body), siteCtx("../x"))).status).toBe(400);
    for (const headers of [{ "X-CSRF-Token": "wrong" }, { Origin: "https://evil.example" }] as Record<string, string>[]) {
      expect((await restoreSite(req("POST", { ...headers, "Idempotency-Key": "k" }, body), siteCtx("s1"))).status).toBe(403);
    }
    expect(fetchUpstream).not.toHaveBeenCalled();

    fetchUpstream.mockResolvedValueOnce({ ok: false, status: 409, error: { error: { code: "RESOURCE_LOCKED" } } });
    expect((await restoreSite(req("POST", { "Idempotency-Key": "k" }, body), siteCtx("s1"))).status).toBe(409);
  });

  it("panel copy line: never, made, failed with the problem; hidden when not available or not configured", () => {
    for (const m of [en, itMsgs]) {
      const t = m.admin.backups;
      const locale = m === en ? "en" : "it";
      expect(render(m, makeSettings({ lastPanelBackup: null }))).toContain(t.panel.never);
      expect(render(m, makeSettings({ lastPanelBackup: { at, status: "succeeded", problem: null } }))).toContain(
        format(t.panel.made, { date: formatDateTime(at, locale) }),
      );
      const failed = render(m, makeSettings({ lastPanelBackup: { at, status: "failed", problem: "panel_dump_failed" } }));
      expect(failed).toContain(format(t.panel.failed, { date: formatDateTime(at, locale) }));
      expect(failed).toContain(t.problem.panel_dump_failed);
      expect(t.keyWarning).toContain("/etc/hosting-panel/backup.key");

      const madeLine = { at, status: "succeeded" as const, problem: null };
      for (const hidden of [
        makeSettings({ available: false, lastPanelBackup: madeLine }),
        makeSettings({ configured: false, lastPanelBackup: madeLine }),
        makeSettings({ configured: false, lastPanelBackup: null }),
      ]) {
        const html = render(m, hidden);
        expect(html).not.toContain(t.panel.never);
        expect(html).not.toContain(format(t.panel.made, { date: formatDateTime(at, locale) }));
      }
    }
    expect(en.admin.backups.keyWarning).toMatch(/panel's own copy/);
    expect(itMsgs.admin.backups.keyWarning).toMatch(/copia del pannello/);
  });

  it("figures: size column per site (dash without a copy) and the total above the table", () => {
    const sites = [
      makeSiteRow({ siteId: "s1", siteName: "Alpha", lastSuccessSizeBytes: 5 * 1024 * 1024 }),
      makeSiteRow({ siteId: "s2", siteName: "Beta", lastSuccessAt: null, lastSuccessSizeBytes: null, lastStatus: null }),
    ];
    for (const m of [en, itMsgs]) {
      const locale = m === en ? "en" : "it";
      const html = render(m, makeSettings({ newestBackupsTotalBytes: 5 * 1024 * 1024 }), sites);
      expect(html).toContain(m.admin.backups.columns.size);
      expect(html).toContain(formatSize(5 * 1024 * 1024, locale));
      expect(html).toContain(format(m.admin.backups.sitesTotal, { size: formatSize(5 * 1024 * 1024, locale) }));
      expect(html.split("\u2014").length).toBeGreaterThan(1);
    }
  });

  it("restore button only for a site with a succeeded copy, named with the site, disabled while the site is busy", () => {
    const t = en.admin.backups;
    const html = render(en, makeSettings(), [
      makeSiteRow({ siteId: "s1", siteName: "Alpha", lastSuccessBackupId: `bkp_${"1".repeat(32)}` }),
      makeSiteRow({ siteId: "s2", siteName: "Beta", lastSuccessAt: null, lastStatus: null }),
    ]);
    expect(html).toContain(`aria-label="${t.restore.button} Alpha"`);
    expect(html).not.toContain(`aria-label="${t.restore.button} Beta"`);

    const busy = render(en, makeSettings(), [
      makeSiteRow({
        siteName: "Alpha",
        lastRestore: { backupId: "bkp_1", backupStartedAt: at, status: "running", finishedAt: null, problem: null },
      }),
    ]);
    expect(busy).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*aria-label="${t.restore.button} Alpha"|<button[^>]*aria-label="${t.restore.button} Alpha"[^>]*disabled=""`));
    expect(busy).toContain(format(t.restore.running, { date: formatDateTime(at, "en") }));
  });

  it("restore outcome under the badge: running, done, done with a problem, failed with the problem", () => {
    for (const m of [en, itMsgs]) {
      const t = m.admin.backups;
      const locale = m === en ? "en" : "it";
      const date = formatDateTime(at, locale);
      const r = { backupId: "bkp_1", backupStartedAt: at, finishedAt: null };
      expect(adminRestoreText(t, null, locale)).toBeNull();
      expect(adminRestoreText(t, { ...r, status: "running", problem: null }, locale)).toBe(format(t.restore.running, { date }));
      expect(adminRestoreText(t, { ...r, status: "succeeded", problem: null }, locale)).toBe(format(t.restore.done, { date }));
      expect(adminRestoreText(t, { ...r, status: "succeeded", problem: "site_not_started" }, locale)).toBe(
        t.problem.site_not_started,
      );
      expect(adminRestoreText(t, { ...r, status: "failed", problem: "no_space" }, locale)).toBe(
        `${format(t.restore.failed, { date })} ${t.problem.no_space}`,
      );
    }
  });

  it("each answer of the restore route has its own text with a next step", () => {
    for (const m of [en, itMsgs]) {
      const t = m.admin.backups;
      const err = (code: string, details?: unknown) => ({ error: { code, details } });
      expect(adminRestoreErrorText(m, 400, err("VALIDATION_ERROR", [{ field: "confirmName" }]))).toBe(t.restore.wrongName);
      expect(
        adminRestoreErrorText(m, 400, err("VALIDATION_ERROR", [{ field: "backupId", message: "no_succeeded_backup" }])),
      ).toBe(t.restore.noCopy);
      expect(adminRestoreErrorText(m, 409, err("RESOURCE_LOCKED"))).toBe(m.errors.RESOURCE_LOCKED);
      expect(adminRestoreErrorText(m, 422, err("NOT_SUPPORTED"))).toBe(t.state.notAvailable);
      expect(adminRestoreErrorText(m, 404, err("NOT_FOUND"))).toBe(m.errors.NOT_FOUND);
      expect(adminRestoreErrorText(m, 500, null)).toBe(m.errors.generic);
    }
  });

  it("the shared dialog shows the administrator's texts when given", () => {
    for (const m of [en, itMsgs]) {
      const t = m.admin.backups.restore;
      const html = decodeHtml(
        renderToStaticMarkup(
          wrap(
            m,
            createElement(
              Dialog,
              { open: true },
              createElement(RestoreBackupForm, {
                backup: { id: "s1", startedAt: at },
                siteName: "Alpha",
                texts: t,
                onConfirm: async () => null,
                onCancel: () => {},
              }),
            ),
          ),
        ),
      );
      const date = formatDate(at, m === en ? "en" : "it");
      expect(html).toContain(format(t.title, { date }));
      expect(html).toContain(format(t.body, { date }));
      expect(html).toContain(t.confirm);
      expect(html).not.toContain(format(m.site.backups.restore.body, { date }));
    }
  });

  it("keeps polling while a restore is running and stops once it settled", async () => {
    vi.useFakeTimers();
    try {
      const restoring = makeSiteRow({
        lastRestore: { backupId: "bkp_1", backupStartedAt: at, status: "running", finishedAt: null, problem: null },
      });
      const restored = makeSiteRow({
        lastRestore: { backupId: "bkp_1", backupStartedAt: at, status: "succeeded", finishedAt: at, problem: null },
      });
      const load = vi
        .fn()
        .mockResolvedValueOnce({ kind: "ok", sites: [restoring] })
        .mockResolvedValueOnce({ kind: "ok", sites: [restored] });
      startBackupSitesPolling({ load, onSites: vi.fn(), onError: vi.fn() });
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(load).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("every new administrator text avoids the forbidden engine words", () => {
    for (const m of [en, itMsgs]) {
      const t = m.admin.backups;
      const texts = [...Object.values(t.panel), ...Object.values(t.restore), t.sitesTotal, t.columns.size];
      for (const text of texts) {
        expect(text).not.toMatch(/docker|container|image|network|volume|revision|\bjob\b|restic|\bS3\b|snapshot|bucket|repository/i);
      }
    }
  });
});
