import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WORDPRESS_PROBLEMS,
  WORDPRESS_STATE_STALE_MS,
  type SiteWordpressDto,
  type SiteWordpressLastUpdateDto,
  type SiteWordpressStateDto,
} from "@hosting-panel/contracts";

vi.mock("next/navigation", () => ({
  usePathname: () => "/sites/s1",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { format } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itCatalog } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";
import { SiteTabs } from "@/components/customer/site-tabs";
import { WEB_SITE_TYPES } from "@/site-types";
import {
  pendingWordpressUpdates,
  wordpressNeedsCheck,
  wordpressOutcomeKey,
  wordpressOverviewKey,
  wordpressStateProblemKey,
  wordpressStatusKey,
} from "@/lib/site-wordpress";
import {
  SiteWordpress,
  WordpressLastUpdate,
  WordpressProgress,
  wordpressErrorText,
} from "@/components/customer/site-wordpress";
import { ResetConfirmView, UpdateConfirmView } from "@/components/customer/wordpress-dialogs";

const t = en.site.wordpress;
const BASE = "/api/bff/orgs/o1/managed-sites/s1/wordpress";
const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const HOSTILE = "<img src=x onerror=alert(1)>";

const STATE: SiteWordpressStateDto = {
  checkedAt: "2026-11-15T10:00:00.000Z",
  problem: null,
  coreVersion: "6.6.1",
  coreUpdate: "6.7.0",
  updatesKnown: true,
  plugins: [
    { name: "akismet", title: "Akismet Anti-spam", status: "active", version: "5.3", updateVersion: "5.4" },
    { name: "net-plugin", title: HOSTILE, status: "active-network", version: "1.0", updateVersion: null },
    { name: "odd name!", title: "Odd Plugin", status: "inactive", version: "1.0", updateVersion: "2.0" },
  ],
  themes: [{ name: "twentytwentyfour", title: "Twenty Twenty-Four", status: "active", version: "1.1", updateVersion: "1.2" }],
  administrators: [{ id: 7, login: "siteowner" }],
};

const dto = (over: Partial<SiteWordpressDto> = {}): SiteWordpressDto => ({
  backupsConfigured: true,
  state: STATE,
  runningOperation: null,
  lastUpdate: null,
  ...over,
});

const LAST: SiteWordpressLastUpdateDto = {
  operationId: "op-1",
  target: { scope: "all" },
  status: "failed",
  finishedAt: "2026-11-15T11:00:00.000Z",
  problem: "items_failed",
  backup: "taken",
  items: [
    { type: "plugin", name: "akismet", oldVersion: "5.2", newVersion: "5.3", status: "updated" },
    { type: "theme", name: "twentytwentyfour", oldVersion: "1.0", newVersion: null, status: "failed" },
  ],
};

function decode(html: string): string {
  return html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

function render(element: ReactElement, locale: "en" | "it" = "en"): string {
  const messages = locale === "it" ? itCatalog : en;
  return renderToStaticMarkup(createElement(I18nProvider, { locale, messages, children: element }));
}

const tab = (d: SiteWordpressDto) => render(createElement(SiteWordpress, { basePath: BASE, initial: d, csrfToken: "c" }));

describe("WordPress tab entry", () => {
  it("is hidden without the flag and second with it", () => {
    const off = render(createElement(SiteTabs, { siteId: "s1" }));
    expect(off).not.toContain("/sites/s1/wordpress");
    const on = render(createElement(SiteTabs, { siteId: "s1", typeTabs: WEB_SITE_TYPES.wordpress.tabs }));
    const hrefs = [...on.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs[1]).toBe("/sites/s1/wordpress");
  });
});

describe("lib helpers", () => {
  it("counts core, plugin and theme updates", () => {
    expect(pendingWordpressUpdates(STATE)).toBe(4);
    expect(pendingWordpressUpdates({ ...STATE, coreUpdate: null, plugins: [], themes: [] })).toBe(0);
  });

  it("asks for a check only when nothing runs and the state is missing or stale", () => {
    const at = (ms: number) => dto({ state: { ...STATE, checkedAt: new Date(NOW - ms).toISOString() } });
    expect(wordpressNeedsCheck(dto({ state: null }), NOW)).toBe(true);
    expect(wordpressNeedsCheck(at(11 * 3_600_000), NOW)).toBe(false);
    expect(wordpressNeedsCheck(at(WORDPRESS_STATE_STALE_MS), NOW)).toBe(true);
    expect(
      wordpressNeedsCheck(
        dto({ state: null, runningOperation: { id: "op", kind: "site.wordpress.inspect", status: "processing", steps: [] } }),
        NOW,
      ),
    ).toBe(false);
    expect(wordpressNeedsCheck(dto({ state: { ...STATE, checkedAt: "not a date" } }), NOW)).toBe(true);
  });

  it("maps the hyphenated statuses to catalog keys", () => {
    expect(wordpressStatusKey("active-network")).toBe("activeNetwork");
    expect(wordpressStatusKey("must-use")).toBe("mustUse");
    expect(wordpressStatusKey("parent")).toBe("parent");
  });

  it("maps every problem to a state key and an outcome key that both catalogs hold", () => {
    for (const problem of WORDPRESS_PROBLEMS) {
      const stateKey = wordpressStateProblemKey(problem);
      expect(en.site.wordpress.problem[stateKey]).toBeTruthy();
      const key = wordpressOutcomeKey({ ...LAST, problem });
      expect(en.site.wordpress.outcome[key], problem).toBeTruthy();
      expect(itCatalog.site.wordpress.outcome[key], problem).toBeTruthy();
    }
    expect(wordpressOutcomeKey({ ...LAST, problem: "item_unknown" })).toBe("itemUnknown");
    expect(wordpressOutcomeKey({ ...LAST, problem: "interrupted" })).toBe("interrupted");
    expect(wordpressOutcomeKey({ ...LAST, problem: "outcome_unknown" })).toBe("outcomeUnknown");
    expect(wordpressOutcomeKey({ ...LAST, problem: null })).toBe("failed");
    expect(wordpressOutcomeKey({ ...LAST, status: "succeeded", problem: null })).toBe("succeeded");
    expect(wordpressOutcomeKey({ ...LAST, status: "succeeded", problem: null, items: [] })).toBe("nothingToDo");
  });

  it("picks the Overview card sentence", () => {
    expect(wordpressOverviewKey(null)).toBe("wordpressLoadFailed");
    expect(
      wordpressOverviewKey(dto({ runningOperation: { id: "o", kind: "site.wordpress.update", status: "queued", steps: [] } })),
    ).toBe("wordpressRunning");
    expect(wordpressOverviewKey(dto({ state: null }))).toBe("wordpressNotChecked");
    expect(wordpressOverviewKey(dto({ state: { ...STATE, problem: "config_broken" } }))).toBe("wordpressProblem");
    expect(wordpressOverviewKey(dto({ state: { ...STATE, updatesKnown: false } }))).toBe("wordpressUnknown");
    expect(
      wordpressOverviewKey(dto({ state: { ...STATE, coreUpdate: null, plugins: [], themes: [] } })),
    ).toBe("wordpressUpToDate");
    expect(wordpressOverviewKey(dto())).toBe("wordpressCount");
  });
});

describe("SiteWordpress static render", () => {
  it("not checked: the notice and Check now, no tables", () => {
    const html = decode(tab(dto({ state: null })));
    expect(html).toContain(t.notices.notCheckedYet);
    expect(html).toContain(t.header.checkNow);
    expect(html).toContain(t.header.notChecked);
    expect(html).not.toContain("<table");
  });

  it("checking: the notice and every action disabled", () => {
    const html = decode(
      tab(dto({ runningOperation: { id: "o", kind: "site.wordpress.inspect", status: "processing", steps: [] } })),
    );
    expect(html).toContain(t.notices.checking);
    expect(html).toContain(t.header.checking);
    for (const m of html.matchAll(/<button[^>]*>/g)) expect(m[0]).toContain("disabled");
  });

  it("update running: steps in order, the current one marked, status words for readers", () => {
    const op = {
      id: "o",
      kind: "site.wordpress.update" as const,
      status: "processing" as const,
      steps: [
        { key: "backup" as const, status: "succeeded" as const },
        { key: "update" as const, status: "running" as const },
        { key: "settle" as const, status: "pending" as const },
      ],
    };
    const html = decode(tab(dto({ runningOperation: op })));
    expect(html).toContain('aria-live="polite"');
    const order = [t.progress.backup, t.progress.update, t.progress.settle].map((s) => html.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toMatch(/aria-current="step"[^>]*>[\s\S]*?Installing the updates/);
    expect(html).toContain(t.step.done);
    expect(html).toContain(t.step.running);
    expect(html).toContain(t.step.waiting);
    for (const m of html.matchAll(/<button[^>]*>/g)) expect(m[0]).toContain("disabled");
  });

  it("a skipped copy is named as such in the progress", () => {
    const html = decode(
      render(
        createElement(WordpressProgress, {
          operation: {
            id: "o",
            kind: "site.wordpress.update",
            status: "processing",
            steps: [{ key: "backup", status: "skipped" }],
          },
        }),
      ),
    );
    expect(html).toContain(t.progress.backupSkipped);
    expect(html).toContain(t.step.skipped);
  });

  it("problem: one sentence and no table at all", () => {
    const html = decode(tab(dto({ state: { ...STATE, problem: "database_unreachable", coreVersion: null } })));
    expect(html).toContain(t.problem.databaseUnreachable);
    expect(html).not.toContain("<table");
    expect(html).not.toContain("siteowner");
  });

  it("updates unknown: installed versions, Unknown, no Update button", () => {
    const html = decode(tab(dto({ state: { ...STATE, updatesKnown: false } })));
    expect(html).toContain(t.notices.updatesUnknown);
    expect(html).toContain(t.tables.unknown);
    expect(html).toContain("5.3");
    expect(html).not.toContain(">Update<");
    expect(html).not.toContain(format(t.tables.updateAll, { count: 4 }));
  });

  it("up to date: the notice and the tables", () => {
    const html = decode(
      tab(dto({ state: { ...STATE, coreUpdate: null, plugins: [{ ...STATE.plugins[0]!, updateVersion: null }], themes: [] } })),
    );
    expect(html).toContain(t.notices.upToDate);
    expect(html).toContain("<table");
    expect(html).toContain(t.tables.emptyThemes);
    expect(html).not.toContain("Update everything");
  });

  it("updates available: labelled row buttons, Update everything, no button for an odd name", () => {
    const html = decode(tab(dto()));
    expect(html).toContain(format(t.tables.updateLabel, { name: "Akismet Anti-spam", version: "5.4" }));
    expect(html).toContain(format(t.tables.updateLabel, { name: "WordPress", version: "6.7.0" }));
    expect(html).toContain(format(t.tables.updateLabel, { name: "Twenty Twenty-Four", version: "1.2" }));
    expect(html).not.toContain(format(t.tables.updateLabel, { name: "Odd Plugin", version: "2.0" }));
    expect(html).toContain("Odd Plugin");
    expect(html).toContain(format(t.tables.updateAll, { count: 4 }));
    expect(html).toContain(format(t.admins.resetLabel, { login: "siteowner" }));
    expect(html).toMatch(/<caption[^>]*sr-only[^>]*>Plugins<\/caption>/);
    expect(html).toContain("<th");
  });

  it("never renders the raw hyphenated status, and renders a hostile title as text", () => {
    const html = tab(dto());
    expect(html).not.toContain("active-network");
    expect(html).toContain(t.status.activeNetwork);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("last update: outcome sentence, the copy sentence and the item list", () => {
    const html = decode(tab(dto({ lastUpdate: LAST })));
    expect(html).toContain(t.outcome.itemsFailed);
    expect(html).toContain(t.outcome.backupTaken);
    expect(html).toContain("akismet");
    expect(html).toContain(t.outcome.updated);
    expect(html).toContain(t.outcome.notUpdated);
    const skipped = decode(
      render(createElement(WordpressLastUpdate, { last: { ...LAST, status: "succeeded", problem: null, backup: "skipped" } })),
    );
    expect(skipped).toContain(t.outcome.succeeded);
    expect(skipped).toContain(t.outcome.backupSkipped);
    expect(skipped).not.toContain(t.outcome.backupTaken);
  });

  it("renders in Italian with the same structure", () => {
    const html = decode(render(createElement(SiteWordpress, { basePath: BASE, initial: dto(), csrfToken: "c" }), "it"));
    expect(html).toContain(itCatalog.site.wordpress.tables.plugins);
    expect(html).toContain(format(itCatalog.site.wordpress.tables.updateAll, { count: 4 }));
  });
});

describe("dialog views", () => {
  const view = (target: Parameters<typeof UpdateConfirmView>[0]["target"], backupsConfigured: boolean) =>
    decode(render(createElement(UpdateConfirmView, { target, state: STATE, backupsConfigured })));

  it("names the copy taken first, or that none will be taken, and the downtime", () => {
    const yes = view({ scope: "plugin", name: "akismet" }, true);
    expect(yes).toContain(t.update.backupTaken);
    expect(yes).not.toContain(t.update.backupNone);
    expect(yes).toContain(t.update.downtime);
    expect(yes).toContain(t.update.noAutoRestore);
    const no = view({ scope: "plugin", name: "akismet" }, false);
    expect(no).toContain(t.update.backupNone);
    expect(no).not.toContain(t.update.backupTaken);
    expect(no).toContain(t.update.downtime);
  });

  it("titles and bodies for one item, WordPress itself and everything", () => {
    const one = view({ scope: "plugin", name: "akismet" }, true);
    expect(one).toContain(format(t.update.titleOne, { name: "Akismet Anti-spam" }));
    expect(one).toContain(format(t.update.bodyOne, { name: "Akismet Anti-spam", from: "5.3", to: "5.4" }));
    const core = view({ scope: "core" }, true);
    expect(core).toContain(t.update.titleCore);
    expect(core).toContain(format(t.update.bodyOne, { name: "WordPress", from: "6.6.1", to: "6.7.0" }));
    const all = view({ scope: "all" }, true);
    expect(all).toContain(t.update.titleAll);
    expect(all).toContain(format(t.update.bodyAll, { count: 4 }));
  });

  it("the reset view names the sign-out and that the password is shown once", () => {
    const html = decode(render(createElement(ResetConfirmView, { login: "siteowner" })));
    expect(html).toContain(format(t.reset.title, { login: "siteowner" }));
    expect(html).toContain(format(t.reset.body, { login: "siteowner" }));
    expect(html).toContain(t.reset.once);
  });
});

describe("wordpressErrorText", () => {
  const err = (code: string, details: unknown[] = []) => ({ error: { code, message: "x", details } });
  const now = new Date("2026-11-15T12:00:00.000Z");

  it("maps the quota answer to the retry time", () => {
    const retryAt = "2026-11-15T12:30:00.000Z";
    const text = wordpressErrorText(en, "update", 409, err("QUOTA_EXCEEDED", [{ field: "retryAt", message: retryAt }]), {
      locale: "en-GB",
      now,
    });
    const time = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(retryAt));
    expect(text).toBe(format(en.site.backups.errors.tooMany, { time }));
  });

  it("maps locks, not ready, unknown items and administrators", () => {
    expect(wordpressErrorText(en, "check", 409, err("RESOURCE_LOCKED"))).toBe(en.errors.RESOURCE_LOCKED);
    expect(wordpressErrorText(en, "update", 409, err("RESOURCE_LOCKED", [{ reason: "not_ready" }]))).toBe(t.errors.notReady);
    expect(wordpressErrorText(en, "update", 400, err("VALIDATION_ERROR", [{ reason: "item_unknown" }]))).toBe(
      t.errors.itemUnknown,
    );
    expect(wordpressErrorText(en, "reset", 400, err("VALIDATION_ERROR", [{ reason: "administrator_unknown" }]))).toBe(
      t.errors.adminUnknown,
    );
  });

  it("says the password was not changed only for the three known reasons", () => {
    const r = (reason: string) => wordpressErrorText(en, "reset", 503, err("DOCKER_ENGINE_UNAVAILABLE", [{ reason }]));
    expect(r("config_broken")).toBe(t.reset.failed.configBroken);
    expect(r("database_unreachable")).toBe(t.reset.failed.databaseUnreachable);
    expect(r("not_installed")).toBe(t.reset.failed.notInstalled);
  });

  it("says the reset outcome is unknown for unavailable, 502, 504, no answer and ambiguity", () => {
    const unknown = t.reset.failed.unknown;
    expect(wordpressErrorText(en, "reset", 503, err("DOCKER_ENGINE_UNAVAILABLE", [{ reason: "unavailable" }]))).toBe(unknown);
    expect(wordpressErrorText(en, "reset", 502, null)).toBe(unknown);
    expect(wordpressErrorText(en, "reset", 504, null)).toBe(unknown);
    expect(wordpressErrorText(en, "reset", 0, null)).toBe(unknown);
    expect(wordpressErrorText(en, "reset", 409, err("OPERATION_AMBIGUOUS"))).toBe(unknown);
  });

  it("says a check or update start is uncertain on 502, 504 and no answer", () => {
    expect(wordpressErrorText(en, "check", 504, null)).toBe(t.errors.uncertain);
    expect(wordpressErrorText(en, "update", 0, null)).toBe(t.errors.uncertain);
    expect(wordpressErrorText(en, "update", 502, null)).toBe(t.errors.uncertain);
  });

  it("maps suspension, permission, unavailability and session", () => {
    expect(wordpressErrorText(en, "update", 403, err("ORGANIZATION_SUSPENDED"))).toBe(t.errors.suspended);
    expect(wordpressErrorText(en, "update", 403, err("PERMISSION_DENIED"))).toBe(en.errors.PERMISSION_DENIED);
    expect(wordpressErrorText(en, "check", 422, err("NOT_SUPPORTED"))).toBe(t.notAvailable);
    expect(wordpressErrorText(en, "check", 401, err("UNAUTHENTICATED"))).toBe(en.site.files.errors.UNAUTHENTICATED);
    expect(wordpressErrorText(en, "check", 500, null)).toBe(en.errors.INTERNAL_ERROR);
  });
});
