import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SiteWordpressLastImportDtoSchema,
  WORDPRESS_IMPORT_LEFT_OUT,
  WORDPRESS_IMPORT_OUTCOMES,
  WORDPRESS_IMPORT_REASONS,
  WORDPRESS_IMPORT_STEP_KEYS,
  type SiteWordpressImportDto,
  type SiteWordpressLastImportDto,
} from "@hosting-panel/contracts";

vi.mock("next/navigation", () => ({
  usePathname: () => "/sites/s1/wordpress",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itCatalog } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";
import { fileErrorText, formatDate, formatSize } from "@/lib/file-browser";
import { prepareQueuedUploads, uploadFailureText } from "@/components/customer/file-uploads";
import {
  ImportConfirmView,
  ImportDiscardView,
  ImportOutcome,
  ImportProgress,
  WordpressImport,
  importChunkErrorText,
  importErrorText,
  importReasonText,
  importStepNumber,
} from "@/components/customer/wordpress-import";
import { WordpressImportCard, WordpressImportCardView } from "@/components/customer/wordpress-import-card";
import { wordpressErrorText } from "@/components/customer/site-wordpress";

type Locale = "en" | "it";
type Op = NonNullable<SiteWordpressImportDto["runningOperation"]>;
const CATALOG: Record<Locale, Messages> = { en, it: itCatalog };
const LOCALES: Locale[] = ["en", "it"];
const BASE = "/api/bff/orgs/o1/managed-sites/s1/wordpress/import";
const HOSTILE = "<img src=x onerror=alert(1)>";
const SITE = "Neutral Shop";

const EMPTY = { state: "empty", size: 0, uploadId: null } as const;
const FULL = (size: number) => ({ state: "complete", size, uploadId: null }) as const;
const PARTIAL = { state: "partial", size: 1_048_576, uploadId: "upload-0123456789abcdef" } as const;

const dto = (over: Partial<SiteWordpressImportDto> = {}): SiteWordpressImportDto => ({
  available: true,
  backupsConfigured: true,
  slots: { archive: EMPTY, dump: EMPTY },
  earlierImportUnfinished: false,
  runningOperation: null,
  lastImport: null,
  ...over,
});

const LAST: SiteWordpressLastImportDto = {
  operationId: `op_${"a".repeat(32)}`,
  finishedAt: "2026-11-15T11:00:00.000Z",
  outcome: "imported",
  reason: null,
  backup: "taken",
  oldAddress: "http://old.example.test",
  leftOut: ["wp-config.php", ".htaccess"],
  tables: 12,
  line: null,
  errorNumber: null,
};

const op = (current: number, over: Partial<Op> = {}): Op => ({
  id: `op_${"b".repeat(32)}`,
  kind: "site.wordpress.import",
  status: "processing",
  steps: WORDPRESS_IMPORT_STEP_KEYS.slice(0, current + 1).map((key, i) => ({
    key,
    status: i < current ? "succeeded" : "running",
  })),
  ...over,
});

const decode = (html: string) =>
  html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");

function render(element: ReactElement, locale: Locale = "en"): string {
  return renderToStaticMarkup(createElement(I18nProvider, { locale, messages: CATALOG[locale], children: element }));
}

const wizard = (initial: unknown, locale: Locale = "en", siteName = SITE) =>
  render(createElement(WordpressImport, { basePath: BASE, siteName, initial, csrfToken: "c", backupsHref: "/sites/s1/backups" }), locale);

describe("pure helpers", () => {
  it("importStepNumber follows the state", () => {
    expect(importStepNumber(dto({ slots: null }))).toBe(1);
    expect(importStepNumber(dto())).toBe(2);
    expect(importStepNumber(dto({ slots: { archive: FULL(10), dump: PARTIAL } }))).toBe(3);
    expect(importStepNumber(dto({ slots: { archive: FULL(10), dump: FULL(20) } }))).toBe(4);
    expect(importStepNumber(dto({ runningOperation: op(0) }))).toBe(5);
  });

  it("importReasonText fills the line and leaves it out when missing", () => {
    const t = en.site.wordpress.import;
    const at = importReasonText(t, "dump_load_failed", { line: 42, errorNumber: 1064 });
    expect(at).toContain(format(t.reasonsAtLine.dump_load_failed, { line: "42" }));
    expect(at).toContain(format(t.outcome.errorNumber, { number: "1064" }));
    expect(importReasonText(t, "dump_load_failed", { line: null, errorNumber: null })).toBe(t.reasons.dump_load_failed);
    expect(importReasonText(t, "staging_unsafe", { line: 3, errorNumber: null })).toBe(t.reasons.staging_unsafe);
  });

  it("importErrorText maps the route refusals and never shows the API message", () => {
    const err = (code: string, reason?: string, extra: Record<string, unknown> = {}) => ({
      error: { code, message: "Too many backup actions", details: reason ? [{ reason, ...extra }] : [] },
    });
    const t = en.site.wordpress.import;
    expect(importErrorText(en, 409, err("RESOURCE_LOCKED", "import_running"))).toBe(t.errors.importRunning);
    expect(importErrorText(en, 409, err("RESOURCE_LOCKED", "files_incomplete"))).toBe(t.confirm.filesIncomplete);
    expect(importErrorText(en, 409, err("RESOURCE_LOCKED", "earlier_import_unfinished"))).toBe(
      t.reasons.earlier_import_unfinished,
    );
    expect(importErrorText(en, 400, err("VALIDATION_ERROR", "is_a_directory"))).toBe(t.pick.notAFile);
    const retryAt = "2026-11-15T15:30:00.000Z"; // the one-hour fallback would give 13:00
    const quota = importErrorText(en, 409, err("QUOTA_EXCEEDED", "too_many_requests", { field: "retryAt", message: retryAt }), {
      locale: "en",
      now: new Date("2026-11-15T12:00:00.000Z"),
    });
    expect(quota).toBe(format(t.errors.tooMany, { time: formatDate(retryAt, "en") }));
    expect(quota).not.toContain("backup actions");
    expect(importErrorText(en, 0, null)).toBe(t.errors.uncertain);
  });
});

describe("upload queue additions", () => {
  it("prepareQueuedUploads copies resume and leaves it out when not given", () => {
    const file = new File(["x"], "site.zip");
    const { items } = prepareQueuedUploads(
      [
        { file, path: "site.zip", overwrite: false, resume: { uploadId: "upload-0123456789abcdef", offset: 7 } },
        { file, path: "site.zip", overwrite: false },
      ],
      en,
    );
    expect(items[0]!.resume).toEqual({ uploadId: "upload-0123456789abcdef", offset: 7 });
    expect(items[1]!.resume).toBeUndefined();
  });
});

describe.each(LOCALES)("a chunk the import refuses (R169.2, %s)", (locale) => {
  const m = CATALOG[locale];
  const t = m.site.wordpress.import;
  // Every refusal of PUT …/wordpress/import/files/{slot} that the queue hands to the caller's wording.
  const REFUSALS: Array<[status: number, code: string, reason: string | undefined, want: string]> = [
    [400, "VALIDATION_ERROR", "not_a_zip", t.reasons.archive_not_zip],
    [400, "VALIDATION_ERROR", "dump_not_sql", t.reasons.dump_not_sql],
    [409, "QUOTA_EXCEEDED", "disk_full", t.reasons.disk_full],
    [409, "QUOTA_EXCEEDED", "too_large", m.site.files.errors.uploadTooLarge],
    [409, "RESOURCE_LOCKED", "import_running", t.errors.importRunning],
    [409, "RESOURCE_LOCKED", "earlier_import_unfinished", t.reasons.earlier_import_unfinished],
    [409, "RESOURCE_LOCKED", "not_ready", m.site.wordpress.errors.notReady],
    [422, "NOT_SUPPORTED", "not_wordpress", m.site.wordpress.notAvailable],
    [422, "NOT_SUPPORTED", "wordpress_unavailable", m.site.wordpress.notAvailable],
    [403, "ORGANIZATION_SUSPENDED", undefined, m.site.wordpress.errors.suspended],
  ];
  // Failures the import has no sentence of its own for: the queue's shipped text.
  const SHIPPED: Array<[status: number | undefined, code: string, reason: string | undefined]> = [
    [400, "VALIDATION_ERROR", "upload_mismatch"],
    [400, "VALIDATION_ERROR", undefined],
    [403, "PERMISSION_DENIED", undefined],
    [403, "PERMISSION_DENIED", "protected"],
    [404, "NOT_FOUND", undefined],
    [409, "OPERATION_AMBIGUOUS", "import_running"],
    [502, "OPERATION_AMBIGUOUS", undefined],
    [503, "DOCKER_ENGINE_UNAVAILABLE", undefined],
    [200, "INTERNAL_ERROR", undefined],
    [undefined, "FILE_UNREADABLE", undefined],
  ];
  const shipped = (code: string, reason?: string) => fileErrorText(m, code, "upload", reason ? [{ reason }] : undefined);
  // Readable: no raw reason or code name (the queue keeps no API message at all).
  const plain = (text: string) => {
    expect(text.length).toBeGreaterThan(10);
    expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b|[A-Z]{2,}_[A-Z]/);
  };

  it("each refusal reads the import's own sentence", () => {
    for (const [status, code, reason, want] of REFUSALS) {
      const text = uploadFailureText(m, { status, code, reason }, importChunkErrorText);
      expect(text, `${code} ${reason}`).toBe(want);
      plain(text);
    }
  });

  it("the wrong kind of file names the kind that is needed", () => {
    expect(uploadFailureText(m, { status: 400, code: "VALIDATION_ERROR", reason: "not_a_zip" }, importChunkErrorText)).toContain(".zip");
    expect(uploadFailureText(m, { status: 400, code: "VALIDATION_ERROR", reason: "dump_not_sql" }, importChunkErrorText)).toContain(".sql");
  });

  it("a failure the import has no sentence for keeps the queue's readable text", () => {
    for (const [status, code, reason] of SHIPPED) {
      expect(importChunkErrorText(m, { status, code, reason }), `${code} ${reason}`).toBeNull();
      const text = uploadFailureText(m, { status, code, reason }, importChunkErrorText);
      expect(text).toBe(shipped(code, reason));
      plain(text);
    }
  });

  it("without the option every failure reads exactly as shipped", () => {
    for (const [status, code, reason] of [...REFUSALS, ...SHIPPED]) {
      expect(uploadFailureText(m, { status, code, reason })).toBe(shipped(code, reason));
    }
  });
});

describe.each(LOCALES)("discard while a file is sent (R169.3, %s)", (locale) => {
  const t = CATALOG[locale].site.wordpress.import;
  const view = (sending: boolean) =>
    decode(render(createElement(ImportDiscardView, { hasFiles: true, sending, note: null, onDiscard: () => {} }), locale));

  it("is disabled and says why while sending, usable otherwise", () => {
    const busy = view(true);
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="import-discard-hint"/);
    expect(busy).toContain(`id="import-discard-hint"`);
    expect(busy).toContain(t.discardBusy);
    const idle = view(false);
    expect(idle).toContain(t.discard);
    expect(idle).not.toContain(`disabled=""`);
    expect(idle).not.toContain("aria-describedby");
    expect(idle).not.toContain(t.discardBusy);
  });
});

describe.each(LOCALES)("wizard (%s)", (locale) => {
  const t = CATALOG[locale].site.wordpress.import;
  const page = (initial: unknown, siteName?: string) => decode(wizard(initial, locale, siteName));

  it("both files missing: five numbered steps, one h2 title (the site layout holds the h1), step 2 is the current one", () => {
    const html = wizard(dto(), locale);
    expect(html).not.toContain("<h1");
    expect(html.match(/<h2/g)?.length).toBe(1);
    expect(decode(html)).toContain(t.title);
    for (let n = 1; n <= 5; n++) expect(decode(html)).toContain(format(t.stepOf, { n: String(n) }));
    const current = html.split('aria-current="step"');
    expect(current.length).toBe(2);
    expect(decode(current[1]!.split("</h3>")[0]!)).toContain(t.steps.archive);
    expect(decode(html)).toContain(t.slot.empty);
    expect(decode(html)).toContain(t.pick.sftpWarning);
    expect(decode(html)).not.toContain(t.confirm.go);
    expect(html).not.toContain(`>${t.discard}</button>`);
  });

  it("one file partly received asks for the same file again", () => {
    const html = page(dto({ slots: { archive: PARTIAL, dump: EMPTY } }));
    expect(html).toContain(format(t.slot.partial, { received: formatSize(PARTIAL.size, locale) }));
    expect(html).toContain(`>${t.discard}</button>`);
  });

  it("one file complete, the other empty: step 3 is current", () => {
    const html = wizard(dto({ slots: { archive: FULL(2048), dump: EMPTY } }), locale);
    expect(decode(html)).toContain(format(t.slot.filled, { size: formatSize(2048, locale) }));
    expect(decode(html.split('aria-current="step"')[1]!.split("</h3>")[0]!)).toContain(t.steps.dump);
  });

  it("both files complete: step 4 with the copy, the oldest-copy sentence and the left-out list", () => {
    const html = page(dto({ slots: { archive: FULL(2048), dump: FULL(4096) } }));
    expect(html).toContain(t.confirm.replaces);
    expect(html).toContain(t.confirm.backupTaken);
    expect(html).toContain(t.confirm.oldestCopy);
    expect(html).not.toContain(t.confirm.backupNone);
    expect(html).toContain(format(t.confirm.leftOut, { list: WORDPRESS_IMPORT_LEFT_OUT.join(", ") }));
    expect(html).toContain(t.confirm.go);
  });

  it("step 4 without backups says no copy will be taken", () => {
    const html = page(dto({ backupsConfigured: false, slots: { archive: FULL(1), dump: FULL(1) } }));
    expect(html).toContain(t.confirm.backupNone);
    expect(html).not.toContain(t.confirm.backupTaken);
    expect(html).not.toContain(t.confirm.oldestCopy);
  });

  it("the confirm button stays disabled until the exact site name is typed", () => {
    const view = (typed: string) =>
      render(
        createElement(ImportConfirmView, {
          backupsConfigured: true,
          siteName: SITE,
          typed,
          busy: false,
          error: null,
          onTyped: () => {},
          onConfirm: () => {},
        }),
        locale,
      );
    const button = (html: string) => html.match(/<button[^>]*>[^<]*<\/button>/g)!.find((b) => decode(b).includes(t.confirm.go))!;
    for (const typed of ["", "neutral shop", `${SITE} `]) {
      const html = view(typed);
      expect(button(html)).toMatch(/disabled=""/);
      expect(button(html)).toMatch(/aria-describedby="[^"]+"/);
      expect(decode(html)).toContain(t.confirm.typeHint);
    }
    expect(button(view(SITE))).not.toMatch(/disabled=""/);
    expect(decode(view(SITE))).toContain(SITE);
  });

  it("running: only the progress, focusable heading, each step current in turn", () => {
    const html = wizard(dto({ slots: { archive: FULL(1), dump: FULL(1) }, runningOperation: op(2) }), locale);
    expect(decode(html)).toContain(t.progress.title);
    expect(decode(html)).not.toContain(t.confirm.go);
    expect(decode(html)).not.toContain(t.pick.sftpWarning);
    expect(html).toMatch(/<h3[^>]*tabindex="-1"/i);
    expect(html).toContain('aria-live="polite"');
    WORDPRESS_IMPORT_STEP_KEYS.forEach((key, i) => {
      const progress = render(createElement(ImportProgress, { operation: op(i) }), locale);
      const current = progress.split('aria-current="step"');
      expect(current.length).toBe(2);
      expect(decode(current[1]!.split("</li>")[0]!)).toContain(t.progress[key]);
      expect(decode(progress)).not.toContain(t.progress.unsettled);
    });
  });

  it("running with the copy skipped says so", () => {
    const operation = op(2);
    operation.steps[1] = { key: "backup", status: "skipped" };
    expect(decode(render(createElement(ImportProgress, { operation }), locale))).toContain(t.progress.backupSkipped);
  });

  it("an end not known yet is neither failed nor imported", () => {
    for (const operation of [op(5, { status: "unknown" }), { ...op(5), steps: op(5).steps.map((s) => (s.key === "finish" ? { ...s, status: "unknown" as const } : s)) }]) {
      const html = decode(render(createElement(ImportProgress, { operation }), locale));
      expect(html).toContain(t.progress.unsettled);
      expect(html).not.toContain(t.outcome.imported);
      expect(html).not.toContain(CATALOG[locale].site.wordpress.step.failed);
    }
  });

  const outcome = (last: SiteWordpressLastImportDto) =>
    decode(render(createElement(ImportOutcome, { last, backupsHref: "/sites/s1/backups" }), locale));

  it("imported with old address, table count and left-out list", () => {
    const html = outcome(LAST);
    expect(html).toContain(t.outcome.imported);
    expect(html).toContain(format(t.outcome.oldAddress, { address: "http://old.example.test" }));
    expect(html).toContain(format(t.outcome.tables, { count: "12" }));
    expect(html).toContain(format(t.outcome.leftOut, { list: "wp-config.php, .htaccess" }));
    expect(html).toContain(t.outcome.backup.taken);
  });

  it("imported after a recovery leaves out the lines without a value", () => {
    const html = outcome({ ...LAST, oldAddress: null, leftOut: [], tables: null });
    expect(html).toContain(t.outcome.imported);
    for (const line of [t.outcome.oldAddress, t.outcome.tables, t.outcome.leftOut]) {
      expect(html).not.toContain(line.split("{")[0]!);
    }
  });

  it("nothing changed and site restored carry their reason", () => {
    const a = outcome({ ...LAST, outcome: "nothing_changed", reason: "archive_not_wordpress" });
    expect(a).toContain(t.outcome.nothingChanged);
    expect(a).toContain(t.reasons.archive_not_wordpress);
    const b = outcome({ ...LAST, outcome: "site_restored", reason: "dump_load_failed", line: 7, errorNumber: null });
    expect(b).toContain(t.outcome.siteRestored);
    expect(b).toContain(format(t.reasonsAtLine.dump_load_failed, { line: "7" }));
  });

  it("undo incomplete is dated and names the copy taken before the import", () => {
    const date = formatDate(LAST.finishedAt, CATALOG[locale].common.dateLocale);
    const taken = outcome({ ...LAST, outcome: "undo_incomplete", reason: "other" });
    expect(taken).toContain(format(t.outcome.undoTaken, { date }));
    expect(taken).toContain('href="/sites/s1/backups"');
    for (const backup of ["skipped", "failed"] as const) {
      const html = outcome({ ...LAST, outcome: "undo_incomplete", reason: "other", backup });
      expect(html).toContain(format(t.outcome.undoNoCopy, { date }));
      expect(html).not.toContain(format(t.outcome.undoTaken, { date }));
    }
  });

  it("the outcome shows above step 1 when nothing runs", () => {
    const html = page(dto({ lastImport: { ...LAST, outcome: "nothing_changed", reason: "dump_unsafe" } }));
    expect(html.indexOf(t.outcome.nothingChanged)).toBeGreaterThan(-1);
    expect(html.indexOf(t.outcome.nothingChanged)).toBeLessThan(html.indexOf(t.steps.intro));
  });

  it("not available, files unknown, earlier import unfinished", () => {
    expect(page(dto({ available: false }))).toContain(CATALOG[locale].site.wordpress.notAvailable);
    const noSlots = page(dto({ slots: null }));
    expect(noSlots).toContain(t.filesUnknown);
    expect(noSlots).not.toContain(t.pick.sftpWarning);
    const earlier = page(dto({ earlierImportUnfinished: true, slots: { archive: FULL(1), dump: FULL(1) } }));
    expect(earlier.indexOf(t.reasons.earlier_import_unfinished)).toBeLessThan(earlier.indexOf(t.steps.intro));
    expect(earlier).not.toContain(t.confirm.go);
    expect(earlier).toContain(t.pick.sftpWarning);
  });

  it("an answer that does not parse is 'could not load'", () => {
    expect(page({ nope: true })).toContain(t.loadFailed);
    const bad = page(dto({ lastImport: { ...LAST, oldAddress: HOSTILE } }));
    expect(bad).toContain(t.loadFailed);
    expect(page(dto({ lastImport: { ...LAST, leftOut: [HOSTILE as never] } }))).toContain(t.loadFailed);
  });

  it("a hostile site name renders as text", () => {
    const html = render(
      createElement(ImportConfirmView, {
        backupsConfigured: true,
        siteName: HOSTILE,
        typed: "",
        busy: false,
        error: null,
        onTyped: () => {},
        onConfirm: () => {},
      }),
      locale,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe.each(LOCALES)("card (%s)", (locale) => {
  const t = CATALOG[locale].site.wordpress.import;
  const card = (initial: SiteWordpressImportDto) =>
    render(createElement(WordpressImportCard, { basePath: BASE, importHref: "/sites/s1/wordpress/import", initial }), locale);

  it("idle without a last import", () => {
    const html = decode(card(dto()));
    expect(html).toContain(t.card.title);
    expect(html).toContain(t.card.body);
    expect(html).toContain('href="/sites/s1/wordpress/import"');
    expect(html).toContain(t.card.start);
    expect(html).not.toContain(t.card.last.split("{")[0]!);
  });

  it("idle with a last import", () => {
    const html = decode(card(dto({ lastImport: { ...LAST, outcome: "site_restored", reason: "site_check_failed" } })));
    const date = formatDate(LAST.finishedAt, CATALOG[locale].common.dateLocale);
    expect(html).toContain(format(t.card.last, { date, result: t.card.result.site_restored }));
  });

  it("running shows the progress and the follow link", () => {
    const html = decode(card(dto({ runningOperation: op(3) })));
    expect(html).toContain(t.card.running);
    expect(html).toContain(t.card.follow);
    expect(html).toContain(t.progress.database);
    expect(html).not.toContain(t.card.start);
  });
});

describe("catalog", () => {
  it("has a sentence for every reason and step in both languages", () => {
    for (const locale of LOCALES) {
      const t = CATALOG[locale].site.wordpress.import;
      for (const r of WORDPRESS_IMPORT_REASONS) expect(t.reasons[r], `${locale} ${r}`).toBeTruthy();
      for (const k of WORDPRESS_IMPORT_STEP_KEYS) expect(t.progress[k], `${locale} ${k}`).toBeTruthy();
    }
  });
});

// R171: review round 1 of cycle 9.
const OUTCOME_WORDS: Record<Locale, RegExp> = {
  en: /as it was|put back|nothing was (changed|done)|was undone|unchanged|was restored/i,
  it: /com'era|ripristinat|riportat|rimess|non è stato (cambiato|fatto) nulla|annullat|invariat/i,
};
const SITE_AS_IT_WAS: Record<Locale, RegExp> = {
  en: /is as it was|nothing was changed/i,
  it: /è com'era|non è stato cambiato nulla/i,
};
const parsedLast = (over: Partial<SiteWordpressLastImportDto>) => SiteWordpressLastImportDtoSchema.parse({ ...LAST, ...over });

describe.each(LOCALES)("R171 (%s)", (locale) => {
  const m = CATALOG[locale];
  const t = m.site.wordpress.import;
  const box = (last: SiteWordpressLastImportDto) =>
    decode(render(createElement(ImportOutcome, { last, backupsHref: "/sites/s1/backups" }), locale)).replace(/<[^>]*>/g, " ");

  it("R171.1: no reason sentence states what became of the site", () => {
    for (const outcome of WORDPRESS_IMPORT_OUTCOMES.filter((o) => o !== "imported")) {
      for (const reason of WORDPRESS_IMPORT_REASONS) {
        for (const line of [null, 7]) {
          const last = parsedLast({ outcome, reason, line, oldAddress: null, leftOut: [], tables: null });
          const sentence = importReasonText(t, reason, last);
          const html = box(last);
          expect(html, `${outcome} ${reason}`).toContain(sentence);
          expect(sentence, `${outcome} ${reason}`).not.toMatch(OUTCOME_WORDS[locale]);
          if (outcome === "undo_incomplete") expect(html, reason).not.toMatch(SITE_AS_IT_WAS[locale]);
        }
      }
    }
  });

  it("R171.2: the card shows the wizard's time-limit and session sentences", () => {
    const pageError = wordpressErrorText(m, "check", 401, null);
    const view = (slow: boolean, err: string | null) =>
      decode(
        render(
          createElement(WordpressImportCardView, {
            data: dto({ runningOperation: op(2) }),
            slow,
            pageError: err,
            importHref: "/sites/s1/wordpress/import",
          }),
          locale,
        ),
      );
    expect(view(true, null)).toContain(t.progress.slow);
    expect(view(false, pageError)).toContain(pageError);
    const quiet = view(false, null);
    expect(quiet).not.toContain(t.progress.slow);
    expect(quiet).not.toContain(pageError);
  });

  it("R171.3: only PERMISSION_DENIED reads as no permission", () => {
    const err = (code: string, reason?: string) => ({ error: { code, message: "sentinel", details: reason ? [{ reason }] : [] } });
    expect(importErrorText(m, 403, err("PERMISSION_DENIED"))).toBe(t.errors.permission);
    expect(importErrorText(m, 403, null)).not.toBe(t.errors.permission);
    expect(importErrorText(m, 403, null)).toBe(wordpressErrorText(m, "update", 403, null));
    expect(importErrorText(m, 403, err("ORGANIZATION_SUSPENDED"))).toBe(m.site.wordpress.errors.suspended);
    expect(importErrorText(m, 403, err("PERMISSION_DENIED", "protected"))).toBe(m.site.files.errors.PERMISSION_DENIED);
  });

  it("R171.4: the copy line names no cause; the running step keeps its own", () => {
    expect(t.outcome.backup.skipped).not.toMatch(/because|not set up|perché|non sono configurati/i);
    expect(box(parsedLast({ outcome: "nothing_changed", reason: "dump_unsafe", backup: "skipped" }))).toContain(t.outcome.backup.skipped);
    expect(t.progress.backupSkipped).not.toBe(t.outcome.backup.skipped);
  });
});

describe("R171.6: Discard is locked while a pick or the start call is on its way", () => {
  it("each slot reports its pick and the start call joins the lock", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/components/customer/wordpress-import.tsx", import.meta.url)), "utf8");
    expect(src).toContain("onSending(slot, locked)");
    expect(src).toMatch(/sending=\{sendingSlots\.archive \|\| sendingSlots\.dump \|\| busy\}/);
  });
});

// R173.7: address_unsupported says what an import needs.
describe("R173.7: address_unsupported names what an import needs", () => {
  const need: Record<Locale, RegExp[]> = {
    en: [/root/i, /sub-folder/i, /same domain/i, /"WordPress Address \(URL\)"/, /"Site Address \(URL\)"/, /Settings, General/, /export again/i, /site's users/i],
    it: [/radice/i, /sottocartella/i, /stesso dominio/i, /«Indirizzo WordPress \(URL\)»/, /«Indirizzo sito \(URL\)»/, /Impostazioni, Generali/, /esporta di nuovo/i, /utenti del sito/i],
  };
  it.each(LOCALES)("%s", (locale) => {
    const s = CATALOG[locale].site.wordpress.import.reasons.address_unsupported;
    for (const re of need[locale]) expect(s, String(re)).toMatch(re);
    expect(s).not.toMatch(/siteurl|\bhome\b/i);
  });
});
