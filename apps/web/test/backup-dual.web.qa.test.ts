// QA (independent) for the M4 web surface of HCP-SPEC-004: two destinations per policy, the `partial` status and the
// `backup_partial` alert without colour in IT and EN, the same-server warning, the customer "Both" choice, no
// `.zip.age` anywhere while the encrypted export is refused (BLOCKED #4), and the download BFF bounds.
// Complements the engineers' tests (admin-backup-targets, site-backup-targets) and the M3 QA file; no duplicates.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AdminAlertDtoSchema,
  BACKUP_STATUSES,
  MAX_BACKUP_POLICY_TARGETS,
  type AdminAlertDto,
  type AdminBackupTargetDto,
  type AdminSiteBackupStatusDto,
  type BackupPolicyDto,
  type BackupSettingsDto,
  type SiteBackupDto,
  type SiteBackupPolicyDto,
  type SiteBackupsDto,
} from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import type { Messages } from "@/i18n";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getSession = vi.fn();
vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...a: unknown[]) => fetchUpstream(...a),
}));
vi.mock("@/lib/server-session", () => ({
  getServerSession: async () => ({ accessToken: "tok", csrfToken: "csrf", user: {} }),
  getSessionFromRequest: (...a: unknown[]) => getSession(...a),
}));
vi.mock("@/lib/server-api", () => ({ serverGet: vi.fn(), fetchServerSiteBackupPolicy: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));

import { BackupSettings } from "@/components/admin/backup-settings";
import { BackupPolicyForm, policyPatch, toggleTarget } from "@/components/admin/backup-policy";
import { SiteBackups, backupErrorText } from "@/components/customer/site-backups";
import { bothChoiceIds, statusView } from "@/lib/backup-copies";
import { alertLink, alertText } from "@/lib/admin-alerts";
import * as downloadRoute from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/backups/[backupId]/download/route";
import * as policyRoute from "@/app/api/admin/backup-policies/[scope]/route";
import * as sitePolicyRoute from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/backup-policy/route";

const LOCALES = ["en", "it"] as const;
type Locale = (typeof LOCALES)[number];
const MSGS: Record<Locale, Messages> = { en, it: itMsgs };

const WARNING = {
  en: "Local backups on the same server do not protect against losing the server or its disk. For disaster recovery, keep a copy off the server and the recovery key.",
  it: "I backup locali sullo stesso server non proteggono dalla perdita del server o del disco. Per disaster recovery conserva una copia fuori dal server e la chiave di recupero.",
} as const;

const T0 = "2026-11-01T02:00:00.000Z";
const T1 = "2026-11-01T02:05:00.000Z";
const NOW = "2026-11-21T10:00:00.000Z";

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const html = (locale: Locale, node: ReactElement) =>
  decode(renderToStaticMarkup(createElement(I18nProvider, { locale, messages: MSGS[locale], children: node })));
const visibleText = (markup: string) =>
  markup
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ");
/** An element holding only text and at most one icon: the status badge, never an outer wrapper. */
const BADGE_RE = /<(?:div|span)[^>]*>(?:<svg[\s\S]*?<\/svg>)?[^<]*<\/(?:div|span)>/g;
const stripColour = (s: string) => s.replace(/\sclass="[^"]*"/g, "");

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const S3A = `bkt_${"a".repeat(32)}`;
const S3B = `bkt_${"b".repeat(32)}`;
const LOCAL = `bkt_${"c".repeat(32)}`;
const LOCAL2 = `bkt_${"d".repeat(32)}`;

function adminTarget(id: string, kind: "s3" | "local", over: Partial<AdminBackupTargetDto> = {}): AdminBackupTargetDto {
  return {
    id,
    kind,
    name: kind === "local" ? `Disk ${id.slice(4, 6)}` : `Offsite ${id.slice(4, 6)}`,
    enabled: true,
    customerSelectable: true,
    legacy: false,
    archivedAt: null,
    retentionDays: null,
    s3: kind === "s3" ? { endpoint: "https://s3.example.com", region: "eu-west-1", bucket: "panel-bkp", prefix: "hp", accessKeyId: "AKIA1234", secretAccessKeySet: true } : null,
    local: kind === "local" ? { root: "/var/lib/hosting-panel/local-repos", initializedAt: null } : null,
    lastTest: null,
    usage: { policies: [], copies: 0 },
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as unknown as AdminBackupTargetDto;
}
const tS3A = adminTarget(S3A, "s3");
const tS3B = adminTarget(S3B, "s3");
const tLocal = adminTarget(LOCAL, "local");
const tLocal2 = adminTarget(LOCAL2, "local");

const kindOf = (id: string) => (id === LOCAL || id === LOCAL2 ? "local" : "s3");
function adminPolicy(scope: "default_site" | "panel", ids: string[]): BackupPolicyDto {
  return {
    scope,
    siteId: null,
    scheduleHourUtc: scope === "panel" ? null : 2,
    retentionDays: 14,
    targets: ids.map((id, i) => ({ targetId: id, kind: kindOf(id), priority: i + 1, required: true })),
    updatedAt: NOW,
  } as BackupPolicyDto;
}
function policyForm(locale: Locale, o: { sites: string[]; panel: string[]; targets?: AdminBackupTargetDto[] }) {
  return html(
    locale,
    createElement(BackupPolicyForm, {
      csrfToken: "csrf",
      siteDefault: adminPolicy("default_site", o.sites),
      panel: adminPolicy("panel", o.panel),
      targets: o.targets ?? [tS3A, tS3B, tLocal],
    }),
  );
}
/** The inputs of one policy card: the sites card is named policy-default-target, the panel card policy-panel-target. */
const boxes = (out: string, card: "default" | "panel") =>
  (out.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? []).filter((b) => b.includes(`name="policy-${card}-target"`));
const isChecked = (b: string) => /\schecked(=|\s|>)/.test(b);
const isDisabled = (b: string) => /\sdisabled(=|\s|>)/.test(b);

function copy(targetId: string, kind: "s3" | "local", status: SiteBackupDto["copies"][number]["status"], over: Partial<SiteBackupDto["copies"][number]> = {}) {
  return {
    targetId,
    kind,
    status,
    sizeBytes: status === "succeeded" ? 2_048 : null,
    problem: null,
    startedAt: T0,
    finishedAt: T1,
    ...over,
  } as SiteBackupDto["copies"][number];
}
function row(over: Record<string, unknown> = {}): SiteBackupDto {
  return {
    id: "bak_1",
    kind: "nightly",
    status: "succeeded",
    startedAt: T0,
    finishedAt: T1,
    sizeBytes: 2_048,
    problem: null,
    archive: null,
    copies: [copy(S3A, "s3", "succeeded"), copy(LOCAL, "local", "succeeded")],
    ...over,
  } as SiteBackupDto;
}
function dto(backups: SiteBackupDto[]): SiteBackupsDto {
  return { available: true, configured: true, retentionDays: 14, manualKept: 3, runningOperationId: null, lastRestore: null, backups, targets: [] };
}
const choice = (id: string, kind: "s3" | "local") => ({ id, kind });
const BASE = "/api/bff/orgs/org_1/managed-sites/site_1/backups";
function customerPage(locale: Locale, backups: SiteBackupDto[], policy?: SiteBackupPolicyDto | null) {
  return html(locale, createElement(SiteBackups, { basePath: BASE, initial: dto(backups), csrfToken: "csrf", siteName: "shop", policy }));
}
const policyOf = (choices: ReturnType<typeof choice>[], targetIds: string[] = []): SiteBackupPolicyDto => ({ targetIds, inherited: targetIds.length === 0, choices });

function siteRow(over: Partial<AdminSiteBackupStatusDto> = {}): AdminSiteBackupStatusDto {
  return {
    siteId: "s1",
    siteName: "Alpha",
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
  } as AdminSiteBackupStatusDto;
}
const settings = (): BackupSettingsDto =>
  ({
    available: true,
    configured: true,
    endpoint: "https://s3.example.com",
    region: "eu-west-1",
    bucket: "panel-bkp",
    prefix: "hp",
    accessKeyId: "AKIA1234",
    secretAccessKeySet: true,
    scheduleHourUtc: 2,
    retentionDays: 14,
    lastNightlyRunOn: null,
    lastTest: null,
    updatedAt: NOW,
    lastPanelBackup: null,
    newestBackupsTotalBytes: 0,
  }) as unknown as BackupSettingsDto;

// ---------------------------------------------------------------------------------------------
// Partial is distinguishable without colour in every list
// ---------------------------------------------------------------------------------------------

describe("partial without colour: admin sites list", () => {
  for (const locale of LOCALES) {
    it(`[${locale}] one badge per state; with every class stripped partial keeps its own word and an icon, and no two badges are alike`, () => {
      const t = MSGS[locale].admin.backups.siteState;
      const states: [string, Partial<AdminSiteBackupStatusDto>][] = [
        ["succeeded", { lastStatus: "succeeded" }],
        ["partial", { lastStatus: "partial" }],
        ["failed", { lastStatus: "failed", problem: "unreachable" }],
        ["running", { lastStatus: "running", runningOperationId: "op_1" }],
        ["never", { lastStatus: null, lastSuccessAt: null, lastAttemptAt: null }],
      ];
      const badges = new Map<string, string>();
      for (const [key, over] of states) {
        const out = stripColour(html(locale, createElement(BackupSettings, { csrfToken: "csrf", initial: settings(), sites: [siteRow(over)] })));
        const word = t[key as keyof typeof t];
        const found = (out.match(BADGE_RE) ?? []).filter((d) => visibleText(d).trim() === word);
        expect(found.length, key).toBe(1);
        badges.set(key, found[0]!);
      }
      expect(badges.get("partial")).toContain("<svg");
      expect(badges.get("partial")).toContain('aria-hidden="true"');
      expect(new Set(badges.values()).size).toBe(states.length);
      // the words are all different too, so a reader without colour or icon still tells them apart
      expect(new Set(Object.values(t)).size).toBe(Object.values(t).length);
    });

    it(`[${locale}] a partial row without a problem shows no error line; with a problem it shows the translated text, never the raw code`, () => {
      const m = MSGS[locale].admin.backups;
      const clean = html(locale, createElement(BackupSettings, { csrfToken: "csrf", initial: settings(), sites: [siteRow({ lastStatus: "partial", problem: null })] }));
      for (const text of Object.values(m.problem)) expect(clean).not.toContain(text as string);
      const withProblem = html(locale, createElement(BackupSettings, { csrfToken: "csrf", initial: settings(), sites: [siteRow({ lastStatus: "partial", problem: "no_space" })] }));
      expect(withProblem).toContain(m.problem.no_space);
      expect(visibleText(withProblem)).not.toContain("no_space");
    });

    it(`[${locale}] the admin list keeps a restore action for a partial row that has a good copy`, () => {
      const out = html(locale, createElement(BackupSettings, { csrfToken: "csrf", initial: settings(), sites: [siteRow({ lastStatus: "partial", problem: "unreachable" })] }));
      expect(out).toContain(`aria-label="${MSGS[locale].admin.backups.restore.button} Alpha"`);
    });
  }
});

describe("partial without colour: customer backups list", () => {
  const partial = () =>
    row({ id: "bak_p", status: "partial", copies: [copy(S3A, "s3", "failed", { problem: "unreachable" }), copy(LOCAL, "local", "succeeded")] });

  for (const locale of LOCALES) {
    it(`[${locale}] the partial row reads in words and icons with no class: status, then each copy with its neutral source and status`, () => {
      const t = MSGS[locale].site.backups;
      const out = stripColour(customerPage(locale, [partial()]));
      const tr = out.split("<tr").find((r) => r.includes("bak_p") || r.includes(t.status.partial)) ?? "";
      const text = visibleText(tr);
      const order = [t.status.partial, `${t.target.offServer}: ${t.copies.status.failed}`, t.problem.unreachable, `${t.target.thisServer}: ${t.copies.status.succeeded}`];
      let at = -1;
      for (const part of order) {
        const next = text.indexOf(part);
        expect(next, part).toBeGreaterThan(at);
        at = next;
      }
      // the badge and each copy line carry an icon the reader's eye can use without colour
      const ul = tr.match(/<ul[^>]*aria-label="[^"]*"[^>]*>[\s\S]*?<\/ul>/)?.[0] ?? "";
      const lis = ul.split("<li").slice(1);
      expect(lis).toHaveLength(2);
      for (const li of lis) expect(li).toContain("<svg");
      const glyph = (li: string) => li.match(/<svg[\s\S]*?<\/svg>/)?.[0];
      expect(glyph(lis[0]!)).not.toBe(glyph(lis[1]!)); // failed and succeeded copies use different shapes
      // the long explanation is also a title on the badge, for hover and assistive tech
      expect(tr).toContain(`title="${t.status.partialLong}"`);
    });

    it(`[${locale}] no catalog word of the other language leaks into the page (no hard-coded English or Italian)`, () => {
      const other = locale === "en" ? itMsgs : en;
      const mine = MSGS[locale];
      const out = visibleText(customerPage(locale, [partial(), row({ id: "bak_ok" })], policyOf([choice(S3A, "s3"), choice(LOCAL, "local")], [S3A, LOCAL])));
      const sample = (m: Messages) => [m.site.backups.status.partial, m.site.backups.copies.status.failed, m.site.backups.copies.status.succeeded, m.site.backups.target.both, m.site.backups.target.offServer, m.site.backups.target.thisServer];
      const own = new Set(sample(mine));
      for (const w of sample(other).filter((x) => !own.has(x))) expect(out, w).not.toContain(w);
    });
  }

  it("a partial row whose copies are missing still shows its word and icon (the list never depends on the copies array)", () => {
    for (const locale of LOCALES) {
      const out = customerPage(locale, [row({ status: "partial", copies: [] })]);
      expect(out).toContain(MSGS[locale].site.backups.status.partial);
      const badge = (out.match(BADGE_RE) ?? []).find((d) => visibleText(d).trim() === MSGS[locale].site.backups.status.partial) ?? "";
      expect(badge).toContain("<svg");
    }
  });

  it("every backup status has a text in both languages and a distinct icon+text view", () => {
    const pairs = new Set<string>();
    for (const status of BACKUP_STATUSES) {
      for (const m of [en, itMsgs]) expect(Object.hasOwn(m.site.backups.status, status), status).toBe(true);
      for (const m of [en, itMsgs]) expect(Object.hasOwn(m.admin.backups.siteState, status), status).toBe(true);
      const v = statusView(status);
      pairs.add(`${v.icon}|${v.textKey}`);
    }
    expect(pairs.size).toBe(BACKUP_STATUSES.length);
    expect(en.site.backups.status.partial).not.toBe(itMsgs.site.backups.status.partial);
  });
});

describe("partial without colour: the backup_partial alert", () => {
  const alert = (over: Record<string, unknown> = {}): AdminAlertDto =>
    AdminAlertDtoSchema.parse({
      severity: "warning",
      subject: "s1",
      since: T1,
      kind: "backup_partial",
      details: { siteId: "s1", siteName: "Hotel Bella Vista", backupId: "bkp_SECRETID", at: T1 },
      ...over,
    });

  for (const locale of LOCALES) {
    it(`[${locale}] names the site and the date, says which part failed and what to do, and never shows the backup id`, () => {
      const m = MSGS[locale];
      const text = alertText(m, alert());
      expect(text).toContain("Hotel Bella Vista");
      expect(text).not.toContain("bkp_SECRETID");
      expect(text).not.toMatch(/\{[a-z]+\}/); // no unfilled placeholder
      expect(text).toMatch(locale === "en" ? /check|run|open/i : /controlla|fai|apri/i);
      expect(text.length).toBeGreaterThan(40);
      expect(alertLink(alert())).toEqual({ href: "/admin/backups", label: "openBackups" });
    });
  }

  it("the severity is a word (warning/critical), not only a badge colour, in the alert line of both languages", () => {
    expect(en.admin.alertLine.severity.warning).toBe("warning");
    expect(itMsgs.admin.alertLine.severity.warning).not.toBe("");
    expect(itMsgs.admin.alertLine.severity.warning).not.toBe(itMsgs.admin.alertLine.severity.critical);
  });
});

// ---------------------------------------------------------------------------------------------
// Admin policy: at most two destinations, mandatory same-server warning
// ---------------------------------------------------------------------------------------------

describe("admin policy: at most two destinations", () => {
  it("toggleTarget never keeps more than two or a duplicate, keeps the tick order, and always lets a tick be cleared (random walks)", () => {
    const pool = [S3A, S3B, LOCAL, LOCAL2];
    let seed = 20261121;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let walk = 0; walk < 200; walk += 1) {
      let ids: string[] = [];
      for (let step = 0; step < 30; step += 1) {
        const pick = pool[Math.floor(rnd() * pool.length)]!;
        const before = ids;
        ids = toggleTarget(ids, pick);
        expect(ids.length).toBeLessThanOrEqual(MAX_BACKUP_POLICY_TARGETS);
        expect(new Set(ids).size).toBe(ids.length);
        expect(before).toEqual(before.slice()); // the input is not mutated
        if (before.includes(pick)) expect(ids).toEqual(before.filter((x) => x !== pick));
        else if (before.length < MAX_BACKUP_POLICY_TARGETS) expect(ids).toEqual([...before, pick]);
        else expect(ids).toBe(before);
      }
    }
    const input = [S3A, LOCAL];
    toggleTarget(input, S3B);
    toggleTarget(input, S3A);
    expect(input).toEqual([S3A, LOCAL]);
  });

  for (const locale of LOCALES) {
    it(`[${locale}] in both cards: nothing is disabled with 0 or 1 ticked; with 2 ticked exactly the unticked ones are disabled`, () => {
      const targets = [tS3A, tS3B, tLocal, tLocal2];
      const out = policyForm(locale, { sites: [S3A], panel: [S3A, LOCAL], targets });
      const sites = boxes(out, "default");
      const panel = boxes(out, "panel");
      expect(sites).toHaveLength(4);
      expect(panel).toHaveLength(4);
      expect(sites.filter(isDisabled)).toHaveLength(0);
      expect(sites.filter(isChecked)).toHaveLength(1);
      expect(panel.filter(isChecked)).toHaveLength(2);
      expect(panel.filter(isDisabled)).toHaveLength(2);
      for (const b of panel) expect(isDisabled(b), b).toBe(!isChecked(b));
      // a ticked box is never disabled: the administrator can always untick to change the pair
      expect(panel.filter((b) => isChecked(b) && isDisabled(b))).toHaveLength(0);
    });

    it(`[${locale}] the hint explains two destinations and Partial; no radio remains and the policy still needs a destination`, () => {
      const m = MSGS[locale].admin.backups.policy;
      const out = policyForm(locale, { sites: [S3A, LOCAL], panel: [S3A] });
      expect(out).toContain(m.destinationsHint);
      expect(m.destinationsHint).toMatch(locale === "en" ? /two/i : /due/i);
      expect(m.destinationsHint).toContain(MSGS[locale].site.backups.status.partial);
      expect(out).not.toContain('type="radio"');
      expect(Object.hasOwn(m, "targetRequired")).toBe(true);
    });

    it(`[${locale}] the same-server warning follows the chosen set: local first, local second, two S3, nothing local`, () => {
      const count = (s: string) => s.split(WARNING[locale]).length - 1;
      const cases: [string, string[], string[], number][] = [
        ["local first on the sites card", [LOCAL, S3A], [S3A], 1],
        ["local second on the sites card", [S3A, LOCAL], [S3A], 1],
        ["local on both cards", [S3A, LOCAL], [LOCAL, S3A], 2],
        ["two off-server only", [S3A, S3B], [S3A, S3B], 0],
        ["local available but not chosen", [S3A], [S3B], 0],
        ["two local", [LOCAL, LOCAL2], [S3A], 1],
      ];
      for (const [name, sites, panel, expected] of cases) {
        const out = policyForm(locale, { sites, panel, targets: [tS3A, tS3B, tLocal, tLocal2] });
        expect(count(out), name).toBe(expected);
      }
    });
  }

  it("the warning sentence is the same in both languages' policy cards as the spec text, in an accessible note", () => {
    for (const locale of LOCALES) {
      const out = policyForm(locale, { sites: [S3A, LOCAL], panel: [S3A] });
      const at = out.indexOf(WARNING[locale]);
      expect(at).toBeGreaterThan(0);
      expect(out.slice(Math.max(0, at - 400), at)).toMatch(/role="note"/);
    }
  });

  it("policyPatch sends the ids in the order they were ticked and omits them when nothing changed", () => {
    const saved = adminPolicy("default_site", [S3A, LOCAL]);
    expect(policyPatch(saved, { targetIds: [S3A, LOCAL] })).toEqual({});
    expect(policyPatch(saved, { targetIds: [LOCAL, S3A] })).toEqual({ targetIds: [LOCAL, S3A] });
    expect(policyPatch(saved, { targetIds: [S3A] })).toEqual({ targetIds: [S3A] });
  });
});

describe("policy BFF: more than two destinations never reach the API", () => {
  type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
  const request = (body: unknown) =>
    new Request("http://localhost:3000/x", {
      method: "PATCH",
      headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Idempotency-Key": "k-1", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const targets: [string, Handler, Record<string, string>][] = [
    ["default policy", policyRoute.PATCH as unknown as Handler, { scope: "default" }],
    ["panel policy", policyRoute.PATCH as unknown as Handler, { scope: "panel" }],
    ["site policy", sitePolicyRoute.PATCH as unknown as Handler, { orgId: "org_1", siteId: "site_1" }],
  ];
  beforeEach(() => {
    fetchUpstream.mockReset();
    getSession.mockReset();
    getSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: {} } });
  });
  for (const [name, h, params] of targets) {
    it(`${name}: three destinations are a 400 with no upstream call, two are forwarded`, async () => {
      const three = await h(request({ targetIds: [S3A, S3B, LOCAL] }), { params: Promise.resolve(params) });
      expect(three.status).toBe(400);
      expect(three.headers.get("cache-control")).toMatch(/no-store/);
      expect(fetchUpstream).not.toHaveBeenCalled();
      const two = await h(request({ targetIds: [S3A, LOCAL] }), { params: Promise.resolve(params) });
      expect(two.status).toBe(200);
      expect(fetchUpstream).toHaveBeenCalledTimes(1);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Customer: "Both" only when both destinations are offered
// ---------------------------------------------------------------------------------------------

describe("customer chooser: Both", () => {
  const bothRadio = (out: string) => out.match(/<input[^>]*type="radio"[^>]*value="both"[^>]*>|<input[^>]*value="both"[^>]*type="radio"[^>]*>/)?.[0] ?? null;
  const radios = (out: string) => out.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];

  for (const locale of LOCALES) {
    it(`[${locale}] Both exists for exactly two offered destinations and never for 0, 1 or 3`, () => {
      const t = MSGS[locale].site.backups.target;
      const offers: [string, ReturnType<typeof choice>[], boolean][] = [
        ["none", [], false],
        ["one off-server", [choice(S3A, "s3")], false],
        ["one local", [choice(LOCAL, "local")], false],
        ["off-server + local", [choice(S3A, "s3"), choice(LOCAL, "local")], true],
        ["local + off-server", [choice(LOCAL, "local"), choice(S3A, "s3")], true],
        ["two off-server", [choice(S3A, "s3"), choice(S3B, "s3")], true],
        ["three", [choice(S3A, "s3"), choice(S3B, "s3"), choice(LOCAL, "local")], false],
      ];
      for (const [name, choices, expected] of offers) {
        const out = customerPage(locale, [row()], policyOf(choices));
        expect(bothRadio(out) !== null, name).toBe(expected);
        expect(out.includes(t.both), name).toBe(expected);
        // the inherit option plus one radio per destination, plus Both when offered
        if (choices.length > 0) expect(radios(out), name).toHaveLength(1 + choices.length + (expected ? 1 : 0));
      }
    });

    it(`[${locale}] the same-server warning shows for Both with a local destination and not for Both with two off-server ones`, () => {
      const t = MSGS[locale].site.backups.target;
      const withLocal = customerPage(locale, [row()], policyOf([choice(S3A, "s3"), choice(LOCAL, "local")], [LOCAL, S3A]));
      expect(bothRadio(withLocal)).toMatch(/checked/);
      expect(withLocal).toContain(t.localWarning);
      const twoS3 = customerPage(locale, [row()], policyOf([choice(S3A, "s3"), choice(S3B, "s3")], [S3A, S3B]));
      expect(bothRadio(twoS3)).toMatch(/checked/);
      expect(twoS3).not.toContain(t.localWarning);
    });

    it(`[${locale}] two saved destinations that are not the offered pair never mark Both as saved`, () => {
      const out = customerPage(locale, [row()], policyOf([choice(S3A, "s3"), choice(LOCAL, "local")], [S3A, "bkt_" + "f".repeat(32)]));
      expect(bothRadio(out)).not.toMatch(/checked/);
    });

    it(`[${locale}] the Both label is neutral and names both places`, () => {
      const label = MSGS[locale].site.backups.target.both;
      expect(label).not.toMatch(/\b(s3|restic|bucket|snapshot|repository)\b/i);
      expect(label).toMatch(locale === "en" ? /off-server/i : /esterna/i);
      expect(label).toMatch(/server/i);
    });
  }

  it("bothChoiceIds takes the pair only from exactly two choices and keeps their order", () => {
    expect(bothChoiceIds([])).toBeNull();
    expect(bothChoiceIds([{ id: "a" }])).toBeNull();
    expect(bothChoiceIds([{ id: "a" }, { id: "b" }])).toEqual(["a", "b"]);
    expect(bothChoiceIds([{ id: "b" }, { id: "a" }])).toEqual(["b", "a"]);
    expect(bothChoiceIds([{ id: "a" }, { id: "b" }, { id: "c" }])).toBeNull();
  });

  // The Both option has a help text in the catalog (what Partial means, that the other copy still restores).
  // site-backups.tsx never renders it, so a customer who picks Both is not told what a failed copy would mean.
  // ISSUE (low): apps/web/src/components/customer/site-backups.tsx:682-705 (BackupTargetChooser) never uses
  // t.bothHelp. Input: policy choices [s3, local], saved targets [s3, local]. Expected: the page shows
  // site.backups.target.bothHelp near the Both radio. Actual: the text is absent from the markup (dead catalog key).
  for (const locale of LOCALES) {
    it(`[${locale}] the Both option explains Partial with its help text`, () => {
      const out = customerPage(locale, [row()], policyOf([choice(S3A, "s3"), choice(LOCAL, "local")], [S3A, LOCAL]));
      expect(out).toContain(MSGS[locale].site.backups.target.bothHelp);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// .zip.age is never offered while the encrypted export is refused (BLOCKED #4)
// ---------------------------------------------------------------------------------------------

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) filesUnder(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("no .zip.age in the web while the encrypted export is refused", () => {
  const LEAK_AGE = /zip\.age|\bage1[02-9ac-hj-np-z]{4}|\.age\b|name="recipient"|name="format"|recipient|destinatario della chiave/i;

  for (const locale of LOCALES) {
    it(`[${locale}] the customer backups page (partial, ready archive, Both, local) offers no format, key or recipient field`, () => {
      const rows = [
        row({ id: "bak_ok" }),
        row({ id: "bak_p", status: "partial", copies: [copy(S3A, "s3", "failed"), copy(LOCAL, "local", "succeeded")] }),
        row({ id: "bak_ready", archive: { status: "ready", readyUntil: "2999-01-01T00:00:00.000Z", problem: null } }),
        row({ id: "bak_prep", archive: { status: "preparing", readyUntil: null, problem: null } }),
      ];
      const out = customerPage(locale, rows, policyOf([choice(S3A, "s3"), choice(LOCAL, "local")], [S3A, LOCAL]));
      expect(out).toContain(MSGS[locale].site.backups.download.fetch); // a download is really on the page
      expect(out).not.toMatch(LEAK_AGE);
      expect(out).not.toMatch(/<textarea|<select[^>]*name="format"/);
      expect(out.match(/<input[^>]*type="(text|password|file)"/g)).toBeNull();
    });

    it(`[${locale}] the admin backups list and policy offer none either`, () => {
      const list = html(locale, createElement(BackupSettings, { csrfToken: "csrf", initial: settings(), sites: [siteRow({ lastStatus: "partial" })] }));
      const pol = policyForm(locale, { sites: [S3A, LOCAL], panel: [S3A, LOCAL] });
      expect(list).not.toMatch(LEAK_AGE);
      expect(pol).not.toMatch(LEAK_AGE);
    });
  }

  it("no web source file mentions the .zip.age format: a UI for it has to arrive together with the capability", () => {
    const root = join(__dirname, "..", "src");
    const hits = filesUnder(root).filter((f) => /zip\.age/.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  it("a 422 refusal of the download is shown as 'not available', never as a raw code or the format name", () => {
    for (const locale of LOCALES) {
      const m = MSGS[locale];
      const r = backupErrorText(m, 422, { error: { code: "NOT_SUPPORTED", message: "zip.age is not supported", details: [] } }, { action: "download" });
      expect(r.kind).toBe("notAvailable");
      expect(r.message).toBe(m.site.backups.notAvailable);
      expect(r.message).not.toMatch(/zip\.age|NOT_SUPPORTED|age1/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Download BFF: recipient with format zip and oversize bodies never reach the API
// ---------------------------------------------------------------------------------------------

describe("download BFF: body refusals before any upstream call", () => {
  type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
  const post = downloadRoute.POST as unknown as Handler;
  const ctx = { params: Promise.resolve({ orgId: "org_1", siteId: "site_1", backupId: "bak_1" }) };
  const RECIPIENT = `age1${"q".repeat(58)}`;
  const request = (o: { body?: string; headers?: Record<string, string> } = {}) =>
    new Request("http://localhost:3000/x", {
      method: "POST",
      headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Idempotency-Key": "k-1", "Content-Type": "application/json", ...(o.headers ?? {}) },
      body: o.body,
    });
  const send = (body: unknown) => post(request({ body: JSON.stringify(body) }), ctx);

  beforeEach(() => {
    fetchUpstream.mockReset();
    getSession.mockReset();
    getSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
    fetchUpstream.mockResolvedValue({ ok: true, status: 202, data: { data: { operationId: "op_1" } } });
  });

  const refused: [string, unknown][] = [
    ["recipient with format zip", { format: "zip", recipient: RECIPIENT }],
    ["recipient without a format", { recipient: RECIPIENT }],
    ["recipient with a target and format zip", { targetId: S3A, format: "zip", recipient: RECIPIENT }],
    ["empty recipient with format zip", { format: "zip", recipient: "" }],
    ["null recipient with format zip", { format: "zip", recipient: null }],
    ["zip.age without a recipient", { format: "zip.age" }],
    ["zip.age with a short recipient", { format: "zip.age", recipient: "age1short" }],
    ["zip.age with an uppercase recipient", { format: "zip.age", recipient: RECIPIENT.toUpperCase() }],
    ["zip.age with a recipient and a newline", { format: "zip.age", recipient: `${RECIPIENT}\n` }],
    ["zip.age with a secret key instead of a public one", { format: "zip.age", recipient: `AGE-SECRET-KEY-1${"Q".repeat(58)}` }],
    ["zip.age with a numeric recipient", { format: "zip.age", recipient: 7 }],
    ["zip.age with a 200 kB recipient", { format: "zip.age", recipient: `age1${"q".repeat(200_000)}` }],
    ["unknown format", { format: "tar" }],
    ["format in the wrong case", { format: "ZIP" }],
    ["an extra field", { format: "zip", compress: true }],
    ["a __proto__ key", JSON.parse('{"format":"zip","__proto__":{"recipient":"x"}}')],
    ["an array", [{ format: "zip" }]],
    ["null", null],
    ["a string", "zip"],
  ];
  for (const [name, body] of refused) {
    it(`refuses ${name} with 400, no-store and no upstream call`, async () => {
      const res = await send(body);
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
      expect(await res.text()).not.toContain(RECIPIENT);
      expect(fetchUpstream).not.toHaveBeenCalled();
    });
  }

  it("refuses an oversize body before reading the format: declared length, streamed, and a huge recipient", async () => {
    const pad = (n: number) => JSON.stringify({ format: "zip", pad: "a".repeat(n) });
    const declared = pad(1_100_000);
    const a = await post(request({ body: declared, headers: { "Content-Length": String(declared.length) } }), ctx);
    expect(a.status).toBe(413);
    const b = await post(request({ body: pad(5_000_000) }), ctx);
    expect(b.status).toBe(413);
    const huge = JSON.stringify({ format: "zip.age", recipient: `age1${"q".repeat(2_000_000)}` });
    const c = await post(request({ body: huge }), ctx);
    expect(c.status).toBe(413);
    // a body that lies about its length with a small number is still bounded while streaming
    const d = await post(request({ body: pad(1_100_000), headers: { "Content-Length": "10" } }), ctx);
    expect([400, 413]).toContain(d.status);
    for (const res of [a, b, c, d]) expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("refuses non-JSON bodies and a missing CSRF token before any upstream call, with a recipient in the body or not", async () => {
    for (const raw of ["{not json", `{"format":"zip","recipient":"${RECIPIENT}"`, "<xml/>"]) {
      const res = await post(request({ body: raw }), ctx);
      expect(res.status, raw).toBe(400);
    }
    const noCsrf = await post(request({ body: JSON.stringify({ format: "zip" }), headers: { "X-CSRF-Token": "" } }), ctx);
    expect(noCsrf.status).toBe(403);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("still forwards the valid shapes unchanged: empty, {}, zip, zip with a copy, and a well-formed zip.age request that the API refuses", async () => {
    const valid: unknown[] = [undefined, {}, { format: "zip" }, { targetId: S3A }, { targetId: LOCAL, format: "zip" }, { format: "zip.age", recipient: RECIPIENT }];
    for (const body of valid) {
      fetchUpstream.mockClear();
      const res = await post(request(body === undefined ? {} : { body: JSON.stringify(body) }), ctx);
      expect(res.status, JSON.stringify(body)).toBe(202);
      expect(fetchUpstream).toHaveBeenCalledTimes(1);
      const [path, opts] = fetchUpstream.mock.calls[0] as [string, { method: string; body?: unknown; idempotencyKey?: string }];
      expect(path).toBe("v1/organizations/org_1/managed-sites/site_1/backups/bak_1/download");
      expect(opts.method).toBe("POST");
      expect(opts.body).toEqual(body);
      expect(opts.idempotencyKey).toBe("k-1");
    }
  });

  it("relays the API's 422 refusal of zip.age as is, no-store, without adding the recipient to the answer", async () => {
    fetchUpstream.mockResolvedValue({ ok: false, status: 422, error: { error: { code: "NOT_SUPPORTED", message: "unsupported", details: [] } } });
    const res = await send({ format: "zip.age", recipient: RECIPIENT });
    expect(res.status).toBe(422);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const text = await res.text();
    expect(text).toContain("NOT_SUPPORTED");
    expect(text).not.toContain(RECIPIENT);
  });
});
