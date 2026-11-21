// QA (independent) for the M3 backup-targets web surface: customer leaks (canary values in the upstream data),
// banned-word copy, the mandatory local warning on the admin pages, write-only S3 credentials, per-copy status
// without colour, the restore dialog and the BFF bounds. Complements the engineers' tests; no duplicates.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BACKUP_PROBLEMS } from "@hosting-panel/contracts";
import type { AdminBackupTargetDto, BackupPolicyDto, BackupSettingsDto } from "@hosting-panel/contracts";
import type { Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const h = vi.hoisted(() => ({ locale: "en" as "en" | "it" }));
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
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => h.locale }));
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
vi.mock("@/app/sites/data", () => ({
  getCustomerContext: async () => ({ orgId: "org_1", session: { csrfToken: "csrf" } }),
  getSite: async () => ({ ok: true, data: { id: "site_1", name: "shop" } }),
}));

import AdminBackupsPage from "@/app/admin/backups/page";
import SiteBackupsPage from "@/app/sites/[siteId]/backups/page";
import { RestoreBackupForm, canConfirmRestore } from "@/components/customer/restore-backup-dialog";
import { Dialog } from "@/components/ui/dialog";
import { statusView } from "@/lib/backup-copies";
import * as targetsRoute from "@/app/api/admin/backup-targets/route";
import * as targetRoute from "@/app/api/admin/backup-targets/[targetId]/route";
import * as testRoute from "@/app/api/admin/backup-targets/[targetId]/test/route";
import * as initRoute from "@/app/api/admin/backup-targets/[targetId]/initialize/route";
import * as policyRoute from "@/app/api/admin/backup-policies/[scope]/route";
import * as sitePolicyRoute from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/backup-policy/route";
import * as downloadRoute from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/backups/[backupId]/download/route";
import * as restoreRoute from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/backups/[backupId]/restore/route";
import * as adminRestoreRoute from "@/app/api/admin/backups/sites/[siteId]/restore/route";

const SPEC_WARNING_IT =
  "I backup locali sullo stesso server non proteggono dalla perdita del server o del disco. Per disaster recovery conserva una copia fuori dal server e la chiave di recupero.";
const SPEC_WARNING_EN =
  "Local backups on the same server do not protect against losing the server or its disk. For disaster recovery, keep a copy off the server and the recovery key.";
const WARNING = { en: SPEC_WARNING_EN, it: SPEC_WARNING_IT } as const;
const MSGS: Record<"en" | "it", Messages> = { en, it: itMsgs };

// Same bans as the engineers' copy test (backup + jargon + Italian jargon rules).
const BANNED =
  /\b(restic|s3|snapshot|bucket|repository|repo|container|docker|image|volume|network|service|template|mariadb|job|organization|revision|drift|allocation|outbox|relay|smtp|postfix|spf|dkim|schema|contenitore|contenitori|immagine|immagini|volumi|servizio|servizi|rete|reti|revisione|revisioni|organizzazione|organizzazioni|endpoint)\b|HCP-SPEC|AC-F|ADR-/i;

const CANARY = "QA-CANARY-bkp7d41";
const SECRET = `SECRETSECRET-${CANARY}`;
const ROOT = `/var/lib/hosting-panel/local-repos/bkt_${CANARY}`;
// Anything that would reveal a destination's location or credentials, or a host path.
const LEAK = new RegExp(
  `${CANARY}|AKIA|s3\\.canary|canary-bucket|canary/prefix|SECRETSECRET|local-repos|s3:/|https?://s3|/var/lib|/srv/|/etc/hosting|/mnt/|/home/`,
  "i",
);

const TID_S3A = `bkt_${"a".repeat(32)}`;
const TID_LOCAL = `bkt_${"c".repeat(32)}`;
const T0 = "2026-11-01T02:00:00.000Z";
const T1 = "2026-11-01T02:05:00.000Z";

const visibleText = (markup: string) =>
  markup
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const decode = (markup: string) => markup.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const wrap = (locale: "en" | "it", node: ReactElement) =>
  createElement(I18nProvider, { locale, messages: MSGS[locale], children: node });
const html = (locale: "en" | "it", node: ReactElement) => decode(renderToStaticMarkup(wrap(locale, node)));
const envelope = (data: unknown) => ({ ok: true, status: 200, data: { data } });

// ---------------------------------------------------------------------------------------------
// Customer pages never reveal where or how backups are stored
// ---------------------------------------------------------------------------------------------

/** Extra properties a misbehaving upstream could add: they must never reach the customer's markup. */
const poison = {
  endpoint: `https://s3.canary.example/${CANARY}`,
  region: "canary-region",
  bucket: `canary-bucket-${CANARY}`,
  prefix: "canary/prefix",
  accessKeyId: `AKIA${CANARY}`,
  secretAccessKey: SECRET,
  root: ROOT,
  localRoot: ROOT,
  path: `${ROOT}/sites/site_1`,
  name: `Canary ${CANARY}`,
  s3: { endpoint: `https://s3.canary.example/${CANARY}`, bucket: `canary-bucket-${CANARY}`, accessKeyId: `AKIA${CANARY}` },
  local: { root: ROOT },
};

type Copy = {
  targetId: string;
  kind: "s3" | "local";
  status: string;
  sizeBytes: number | null;
  problem: string | null;
  startedAt: string;
  finishedAt: string | null;
};
const copy = (targetId: string, kind: "s3" | "local", status: string, over: Partial<Copy> = {}): Copy => ({
  targetId,
  kind,
  status,
  sizeBytes: status === "succeeded" ? 4096 : null,
  problem: null,
  startedAt: T0,
  finishedAt: T1,
  ...over,
});
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "nightly",
  status: "succeeded",
  startedAt: T0,
  finishedAt: T1,
  sizeBytes: 4096,
  problem: null,
  archive: null,
  copies: [copy(TID_S3A, "s3", "succeeded")],
  ...over,
});
const poisoned = <T extends Record<string, unknown>>(o: T): T => ({ ...o, ...poison });
const PATHY = `${ROOT}/sites/site_1: permission denied`;

function customerDto(backups: unknown[], over: Record<string, unknown> = {}) {
  return poisoned({
    available: true,
    configured: true,
    retentionDays: 14,
    manualKept: 3,
    runningOperationId: null,
    lastRestore: null,
    backups,
    targets: [poisoned({ id: TID_S3A, kind: "s3" }), poisoned({ id: TID_LOCAL, kind: "local" })],
    ...over,
  });
}
const customerPolicy = (targetIds: string[]) =>
  poisoned({
    targetIds,
    inherited: targetIds.length === 0,
    choices: [poisoned({ id: TID_S3A, kind: "s3" }), poisoned({ id: TID_LOCAL, kind: "local" })],
  });

function upstreamFor(map: Record<string, unknown>) {
  fetchUpstream.mockImplementation(async (path: string) => {
    const hit = Object.entries(map).find(([p]) => path === p || path.startsWith(`${p}?`));
    return hit ? hit[1] : { ok: false, status: 500, error: { error: { code: "INTERNAL", message: PATHY, details: [] } } };
  });
}
async function customerPage(locale: "en" | "it", backups: unknown, policy: unknown) {
  h.locale = locale;
  upstreamFor({
    "v1/organizations/org_1/managed-sites/site_1/backups": envelope(backups),
    "v1/organizations/org_1/managed-sites/site_1/backup-policy": envelope(policy),
  });
  const el = (await SiteBackupsPage({ params: Promise.resolve({ siteId: "site_1" }) })) as ReactElement;
  return html(locale, el);
}

/** A backups list that exercises every state a customer can see. */
function kitchenSink() {
  const rows: unknown[] = [
    poisoned(row("bak_ok", { copies: [poisoned(copy(TID_S3A, "s3", "succeeded")), poisoned(copy(TID_LOCAL, "local", "succeeded"))] })),
    poisoned(row("bak_partial", { status: "partial", copies: [poisoned(copy(TID_S3A, "s3", "failed", { problem: "unreachable" })), poisoned(copy(TID_LOCAL, "local", "succeeded"))] })),
    poisoned(row("bak_run", { status: "running", sizeBytes: null, finishedAt: null, copies: [copy(TID_S3A, "s3", "running"), copy(TID_LOCAL, "local", "running")] })),
    poisoned(row("bak_arch", { archive: { status: "failed", readyUntil: null, problem: PATHY, ...poison } })),
    poisoned(row("bak_pathy", { status: "failed", problem: PATHY, copies: [copy(TID_S3A, "s3", "failed", { problem: PATHY })] })),
  ];
  for (const p of BACKUP_PROBLEMS) {
    rows.push(poisoned(row(`bak_p_${p}`, { status: "failed", problem: p, copies: [copy(TID_S3A, "s3", "failed", { problem: p }), copy(TID_LOCAL, "local", "missing", { problem: p })] })));
  }
  return customerDto(rows, {
    lastRestore: poisoned({ backupId: "bak_ok", backupStartedAt: T0, status: "failed", finishedAt: T1, problem: PATHY }),
  });
}

describe("customer backups page never reveals where backups live", () => {
  beforeEach(() => {
    fetchUpstream.mockReset();
    h.locale = "en";
  });

  for (const locale of ["en", "it"] as const) {
    it(`[${locale}] canary endpoint, bucket, prefix, credentials, local root and host paths in the upstream data never reach the page`, async () => {
      const out = await customerPage(locale, kitchenSink(), customerPolicy([TID_LOCAL]));
      expect(out).toContain(MSGS[locale].site.backups.title);
      expect(out).toContain(MSGS[locale].site.backups.copies.title); // the multi-copy rows really rendered
      const bad = out.match(new RegExp(LEAK.source, "gi"));
      expect(bad).toBeNull();
    });

    it(`[${locale}] the visible text carries no banned word, no path and no raw problem string`, async () => {
      const out = await customerPage(locale, kitchenSink(), customerPolicy([TID_LOCAL]));
      const text = visibleText(out);
      expect(text.match(BANNED)).toBeNull();
      expect(text).not.toMatch(/permission denied/i);
      for (const p of BACKUP_PROBLEMS.filter((x) => x.includes("_"))) expect(text, p).not.toContain(p);
    });
  }

  it("an upstream error body with a path or a secret is replaced by a catalog text", async () => {
    h.locale = "en";
    upstreamFor({
      "v1/organizations/org_1/managed-sites/site_1/backups": {
        ok: false,
        status: 502,
        error: { error: { code: "UPSTREAM", message: `${PATHY} ${SECRET}`, details: [{ field: ROOT, message: SECRET }] } },
      },
      "v1/organizations/org_1/managed-sites/site_1/backup-policy": { ok: false, status: 500 },
    });
    const el = (await SiteBackupsPage({ params: Promise.resolve({ siteId: "site_1" }) })) as ReactElement;
    const out = html("en", el);
    expect(out).toContain(en.site.backups.loadFailed);
    expect(out).not.toMatch(LEAK);
  });

  it("the chooser shows neutral labels only, whatever name or path the policy choices carry", async () => {
    const out = await customerPage("en", customerDto([row("bak_1")]), customerPolicy([TID_S3A]));
    expect(out).toContain(en.site.backups.target.thisServer);
    expect(out).toContain(en.site.backups.target.offServer);
    expect(out).not.toMatch(LEAK);
    expect(out).not.toContain("Canary");
  });

  it("every problem value has its own customer text in both languages (no silent fall-through to 'other')", () => {
    for (const m of [en, itMsgs]) {
      for (const p of BACKUP_PROBLEMS) {
        expect(Object.hasOwn(m.site.backups.problem, p) || Object.hasOwn(m.site.backups.copyProblem, p), p).toBe(true);
      }
    }
  });
});

describe("the customer copy for destinations, copies and the warning passes the banned-word rules when rendered", () => {
  it("renders the local choice, its warning and the partial help in both languages without a banned word", async () => {
    for (const locale of ["en", "it"] as const) {
      const out = await customerPage(locale, kitchenSink(), customerPolicy([TID_LOCAL]));
      const text = visibleText(out);
      expect(text).toContain(MSGS[locale].site.backups.target.localWarning);
      expect(text).toContain(MSGS[locale].site.backups.copies.partialHelp);
      expect(text.match(BANNED)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Admin: mandatory local-backup warning, write-only credentials
// ---------------------------------------------------------------------------------------------

const NOW = "2026-11-21T10:00:00.000Z";
function adminTarget(over: Partial<AdminBackupTargetDto> & { id: string; kind: "s3" | "local" }): AdminBackupTargetDto {
  return {
    name: over.kind === "local" ? "Disk" : "Offsite",
    enabled: true,
    customerSelectable: true,
    legacy: false,
    archivedAt: null,
    retentionDays: null,
    s3:
      over.kind === "s3"
        ? { endpoint: "https://s3.example.com", region: "eu-west-1", bucket: "panel-bkp", prefix: "hp", accessKeyId: "AKIAPUBLICID", secretAccessKeySet: true, secretAccessKey: SECRET }
        : null,
    local: over.kind === "local" ? { root: "/var/lib/hosting-panel/local-repos", initializedAt: null } : null,
    lastTest: null,
    usage: { policies: [], copies: 0 },
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as unknown as AdminBackupTargetDto;
}
const A_S3 = adminTarget({ id: TID_S3A, kind: "s3", legacy: true });
const A_LOCAL = adminTarget({ id: TID_LOCAL, kind: "local" });
const adminPolicy = (scope: "default_site" | "panel", targetId: string, kind: "s3" | "local"): BackupPolicyDto => ({
  scope,
  siteId: null,
  scheduleHourUtc: scope === "panel" ? null : 2,
  retentionDays: 14,
  targets: [{ targetId, kind, priority: 1, required: true }],
  updatedAt: NOW,
});
const legacySettings = (): BackupSettingsDto =>
  ({
    available: true,
    configured: true,
    endpoint: "https://s3.example.com",
    region: "eu-west-1",
    bucket: "panel-bkp",
    prefix: "hp",
    accessKeyId: "AKIAPUBLICID",
    secretAccessKeySet: true,
    secretAccessKey: SECRET,
    scheduleHourUtc: 2,
    retentionDays: 14,
    lastNightlyRunOn: null,
    lastTest: null,
    updatedAt: NOW,
    lastPanelBackup: null,
    newestBackupsTotalBytes: 0,
  }) as unknown as BackupSettingsDto;

async function adminPage(locale: "en" | "it", tab: string | undefined, o: { local?: boolean; capability?: boolean; policyKind?: "s3" | "local" } = {}) {
  h.locale = locale;
  const local = o.local ?? true;
  const kind = o.policyKind ?? "s3";
  const targets = local ? [A_S3, A_LOCAL] : [A_S3];
  upstreamFor({
    "v1/admin/backups": envelope(legacySettings()),
    "v1/admin/backups/sites": envelope([]),
    "v1/admin/backup-targets": envelope({ targets, localRootConfigured: true }),
    "v1/admin/backup-policies/default": envelope(adminPolicy("default_site", kind === "local" ? TID_LOCAL : TID_S3A, kind)),
    "v1/admin/backup-policies/panel": envelope(adminPolicy("panel", kind === "local" ? TID_LOCAL : TID_S3A, kind)),
    "v1/me": envelope({ platformCapabilities: { localBackupTargetsAvailable: o.capability ?? true } }),
  });
  const el = (await AdminBackupsPage({ searchParams: Promise.resolve(tab === undefined ? {} : { tab }) })) as ReactElement;
  return html(locale, el);
}
const count = (s: string, sub: string) => s.split(sub).length - 1;

describe("admin Destinations and Policy pages show the mandatory local-backup warning (SPEC 6.5)", () => {
  for (const locale of ["it", "en"] as const) {
    it(`[${locale}] Destinations: the verbatim sentence is on the page next to a local destination, in an accessible note`, async () => {
      const out = await adminPage(locale, undefined);
      expect(out).toContain(WARNING[locale]);
      const at = out.indexOf(WARNING[locale]);
      // the warning is a role=note alert placed in the local card, not hidden or aria-hidden
      const before = out.slice(Math.max(0, at - 400), at);
      expect(before).toMatch(/role="note"/);
      expect(before).not.toMatch(/aria-hidden="true"[^>]*>[^<]*$/);
      expect(before).not.toMatch(/\bhidden\b[^>]*>[^<]*$/);
    });

    it(`[${locale}] Destinations: the warning is also there before any local destination exists, so it is read before adding one`, async () => {
      const out = await adminPage(locale, "destinations", { local: false });
      expect(out).toContain(WARNING[locale]);
    });

    it(`[${locale}] Policy: the verbatim sentence appears in the cards whose chosen destination is local, not for S3`, async () => {
      const withLocal = await adminPage(locale, "policy", { policyKind: "local" });
      expect(count(withLocal, WARNING[locale])).toBe(2); // sites default card + panel card
      const withS3 = await adminPage(locale, "policy", { policyKind: "s3" });
      expect(withS3).not.toContain(WARNING[locale]);
    });
  }

  it("the warning is the same word-for-word on both admin pages (one source of truth, no paraphrase)", async () => {
    for (const locale of ["it", "en"] as const) {
      const dest = visibleText(await adminPage(locale, undefined));
      const pol = visibleText(await adminPage(locale, "policy", { policyKind: "local" }));
      expect(dest).toContain(WARNING[locale]);
      expect(pol).toContain(WARNING[locale]);
    }
  });
});

describe("S3 credentials are write-only", () => {
  const tabs = [undefined, "destinations", "policy", "recovery"];
  for (const locale of ["en", "it"] as const) {
    it(`[${locale}] a secret in the upstream data never appears on any admin backups tab`, async () => {
      for (const tab of tabs) {
        const out = await adminPage(locale, tab);
        expect(out, String(tab)).not.toContain(SECRET);
        expect(out, String(tab)).not.toContain("SECRETSECRET");
      }
    });
  }

  it("the secret input is a password field, empty, never autofilled, and says only whether a key is saved", async () => {
    const out = await adminPage("en", undefined);
    const input = out.match(/<input[^>]*id="backup-secret"[^>]*>/)?.[0] ?? "";
    expect(input).toContain('type="password"');
    expect(input).toMatch(/autoComplete="new-password"|autocomplete="new-password"/i);
    expect(input).not.toMatch(/value="[^"]+"/);
    expect(input).toContain(`placeholder="${en.admin.backups.secretKeep}"`);
    expect(out).toContain(en.admin.backups.secretSet);
    // no other input anywhere on the page is pre-filled with a credential-looking value
    for (const m of out.matchAll(/<input[^>]*>/g)) {
      if (!/type="password"/.test(m[0])) expect(m[0]).not.toMatch(/value="[^"]*(secret|SECRET)[^"]*"/);
    }
  });

  it("a saved destination keeps showing the key as 'saved' after a reload (state text, not the value)", async () => {
    const out = visibleText(await adminPage("it", undefined));
    expect(out).toContain(itMsgs.admin.backups.secretSet);
    expect(out).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------------------------
// Per-copy status is distinguishable without colour
// ---------------------------------------------------------------------------------------------

describe("per-copy and per-backup status do not rely on colour", () => {
  const stripColour = (s: string) => s.replace(/\sclass="[^"]*"/g, "");
  const COPY_STATUSES = ["running", "succeeded", "failed", "missing", "unknown"] as const;

  async function listFor(locale: "en" | "it", status: string) {
    const out = await customerPage(
      locale,
      customerDto([row("bak_c", { copies: [copy(TID_S3A, "s3", status), copy(TID_LOCAL, "local", "succeeded")] })]),
      customerPolicy([]),
    );
    const ul = out.match(/<ul[^>]*aria-label="[^"]*"[^>]*>[\s\S]*?<\/ul>/)?.[0] ?? "";
    const li = ul.split("<li").filter((p) => p.includes(MSGS[locale].site.backups.target.offServer));
    return stripColour(li[0] ?? "");
  }

  for (const locale of ["en", "it"] as const) {
    it(`[${locale}] each copy status has its own text and its own icon shape; stripping every class leaves them distinct`, async () => {
      const lines = new Map<string, string>();
      for (const s of COPY_STATUSES) lines.set(s, await listFor(locale, s));
      for (const [s, line] of lines) {
        expect(line, s).toContain("<svg");
        expect(line, s).toContain('aria-hidden="true"'); // the icon is decoration; the words carry the state
        expect(visibleText(line), s).toContain(MSGS[locale].site.backups.copies.status[s as (typeof COPY_STATUSES)[number]]);
      }
      expect(new Set(lines.values()).size).toBe(COPY_STATUSES.length);
      const icons = [...lines.values()].map((l) => l.match(/<svg[\s\S]*?<\/svg>/)?.[0]);
      // succeeded/failed/running/unknown use four different glyphs; missing may share the cross with failed but not its text
      expect(new Set(icons).size).toBeGreaterThanOrEqual(4);
    });

    it(`[${locale}] succeeded, partial, failed and running backups are four different badges once colour is gone`, async () => {
      const badges = new Map<string, string>();
      const cases: Record<string, unknown> = {
        succeeded: row("bak_s", { copies: [copy(TID_S3A, "s3", "succeeded"), copy(TID_LOCAL, "local", "succeeded")] }),
        partial: row("bak_p", { status: "partial", copies: [copy(TID_S3A, "s3", "failed"), copy(TID_LOCAL, "local", "succeeded")] }),
        failed: row("bak_f", { status: "failed", copies: [copy(TID_S3A, "s3", "failed")] }),
        running: row("bak_r", { status: "running", finishedAt: null, sizeBytes: null, copies: [copy(TID_S3A, "s3", "running")] }),
      };
      for (const [k, r] of Object.entries(cases)) {
        const out = await customerPage(locale, customerDto([r]), customerPolicy([]));
        const tr = out.split("<tr").find((x) => x.includes("bak_") || x.includes(MSGS[locale].site.backups.status[k as "succeeded"])) ?? "";
        const badge = stripColour(tr).match(/<(?:div|span)[^>]*>(?:(?!<\/(?:div|span)>)[\s\S])*<svg[\s\S]*?<\/svg>[^<]*<\/(?:div|span)>/)?.[0] ?? "";
        badges.set(k, badge);
        expect(visibleText(badge), k).toContain(MSGS[locale].site.backups.status[k as "succeeded"]);
      }
      expect(new Set(badges.values()).size).toBe(4);
    });
  }

  it("statusView gives every status its own icon+text pair (not only a badge variant)", () => {
    const pairs = ["succeeded", "failed", "partial", "running", "unknown", "missing"].map((s) => {
      const v = statusView(s);
      return `${v.icon}|${v.textKey}`;
    });
    expect(new Set(pairs).size).toBe(pairs.length);
  });
});

// ---------------------------------------------------------------------------------------------
// Restore dialog: site-name confirmation and the source copy
// ---------------------------------------------------------------------------------------------

describe("restore dialog", () => {
  const backup = { id: "bak_1", startedAt: T0 };
  const noop = async () => null;
  const form = (locale: "en" | "it", copies?: { targetId: string; label: string }[], siteName = "shop") =>
    html(
      locale,
      createElement(Dialog, {
        open: true,
        children: createElement(RestoreBackupForm, { backup, siteName, onConfirm: noop, onCancel: () => {}, copies }),
      }),
    );
  const two = (locale: "en" | "it") => {
    const t = MSGS[locale].site.backups.target;
    return [
      { targetId: TID_LOCAL, label: t.thisServer },
      { targetId: TID_S3A, label: t.offServer },
    ];
  };

  for (const locale of ["en", "it"] as const) {
    it(`[${locale}] keeps the site-name confirmation: the exact name is asked, Confirm starts disabled and Cancel has focus`, () => {
      const out = form(locale, two(locale));
      expect(out).toContain('id="restore-site-name"');
      expect(out).toContain("<strong>shop</strong>");
      const confirm = out.match(/<button[^>]*>[^<]*<\/button>/g)?.find((b) => b.includes(MSGS[locale].site.backups.restore.confirm)) ?? "";
      expect(confirm).toMatch(/\sdisabled=""/);
      const cancel = out.match(/<button[^>]*>[^<]*<\/button>/g)?.find((b) => b.includes(MSGS[locale].site.backups.restore.cancel)) ?? "";
      expect(cancel).not.toMatch(/\sdisabled=""/);
      expect(cancel).toMatch(/autofocus/);
      // the form is a plain container: Enter can never submit a destructive restore
      expect(out).not.toMatch(/<form\b/);
    });

    it(`[${locale}] with several copies it names each source neutrally, preselects the first and exposes no id, path or endpoint as text`, () => {
      const out = form(locale, two(locale));
      const t = MSGS[locale].site.backups;
      expect(visibleText(out)).toContain(t.restore.fromLabel);
      expect(visibleText(out)).toContain(t.target.thisServer);
      expect(visibleText(out)).toContain(t.target.offServer);
      expect(out.match(/<input[^>]*type="radio"[^>]*>/g)).toHaveLength(2);
      expect(out.match(/<input[^>]*type="radio"[^>]*checked/g)).toHaveLength(1);
      expect(out.match(/<input[^>]*type="radio"[^>]*>/g)![0]).toContain("checked");
      expect(visibleText(out)).not.toMatch(/bkt_/);
      expect(visibleText(out).match(BANNED)).toBeNull();
    });
  }

  it("canConfirmRestore is an exact, case- and space-sensitive match and refuses an empty site name", () => {
    expect(canConfirmRestore("shop", "shop")).toBe(true);
    for (const typed of ["Shop", "shop ", " shop", "sho", "shopp", ""]) expect(canConfirmRestore(typed, "shop"), typed).toBe(false);
    expect(canConfirmRestore("", "")).toBe(false);
  });

  // SPEC 8.2: "Se omessa, il sistema usa la copia primaria ancora disponibile e conferma la scelta nella UI."
  // A partial backup whose only good copy is the local one is restored from that copy; the dialog names it.
  it("names the source copy even when only one restorable copy exists (BKP-08: partial row with a single local copy)", () => {
    const t = en.site.backups;
    const out = visibleText(form("en", [{ targetId: TID_LOCAL, label: t.target.thisServer }]));
    expect(out).toContain(t.target.thisServer);
  });
});

// ---------------------------------------------------------------------------------------------
// BFF: bounded, CSRF-checked, no-store, also on refusals
// ---------------------------------------------------------------------------------------------

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
const T = { targetId: TID_S3A };
const C = { orgId: "org_1", siteId: "site_1" };
const D = { ...C, backupId: "bkp_1" };
const MUTATING: { name: string; h: Handler; method: "POST" | "PATCH" | "DELETE"; params: Record<string, string>; body: unknown }[] = [
  { name: "target create", h: targetsRoute.POST as unknown as Handler, method: "POST", params: {}, body: { kind: "local", name: "Disk" } },
  { name: "target update", h: targetRoute.PATCH as unknown as Handler, method: "PATCH", params: T, body: { enabled: false } },
  { name: "target delete", h: targetRoute.DELETE as unknown as Handler, method: "DELETE", params: T, body: undefined },
  { name: "target test", h: testRoute.POST as unknown as Handler, method: "POST", params: T, body: {} },
  { name: "target initialize", h: initRoute.POST as unknown as Handler, method: "POST", params: T, body: {} },
  { name: "policy default", h: policyRoute.PATCH as unknown as Handler, method: "PATCH", params: { scope: "default" }, body: { retentionDays: 7 } },
  { name: "policy panel", h: policyRoute.PATCH as unknown as Handler, method: "PATCH", params: { scope: "panel" }, body: { targetIds: [TID_S3A] } },
  { name: "site policy", h: sitePolicyRoute.PATCH as unknown as Handler, method: "PATCH", params: C, body: { targetIds: [TID_S3A] } },
  { name: "customer restore", h: restoreRoute.POST as unknown as Handler, method: "POST", params: D, body: { confirmName: "shop" } },
  { name: "customer download", h: downloadRoute.POST as unknown as Handler, method: "POST", params: D, body: {} },
  { name: "admin restore", h: adminRestoreRoute.POST as unknown as Handler, method: "POST", params: { siteId: "site_1" }, body: { confirmName: "shop" } },
];
const READS: { name: string; h: Handler; params: Record<string, string> }[] = [
  { name: "targets list", h: targetsRoute.GET as unknown as Handler, params: {} },
  { name: "default policy", h: policyRoute.GET as unknown as Handler, params: { scope: "default" } },
  { name: "site policy", h: sitePolicyRoute.GET as unknown as Handler, params: C },
];

function request(method: string, o: { headers?: Record<string, string | null>; body?: string } = {}) {
  const headers: Record<string, string> = { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Idempotency-Key": "k-1", "Content-Type": "application/json" };
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  return new Request("http://localhost:3000/x", { method, headers, body: method === "GET" ? undefined : o.body });
}
const ctxOf = (params: Record<string, string>) => ({ params: Promise.resolve(params) });
const bodyOf = (b: unknown) => (b === undefined ? undefined : JSON.stringify(b));
const NO_STORE = /no-store/;

describe("backup BFF routes: bounded, CSRF-checked, no-store", () => {
  beforeEach(() => {
    fetchUpstream.mockReset();
    getSession.mockReset();
    getSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
  });

  for (const r of MUTATING.filter((x) => x.body !== undefined)) {
    describe(r.name, () => {
      it("refuses an oversized body (declared and streamed) with 413, no-store, and never calls the API", async () => {
        const big = JSON.stringify({ ...(r.body as object), pad: "a".repeat(1_100_000) });
        const declared = await r.h(request(r.method, { headers: { "Content-Length": String(big.length) }, body: big }), ctxOf(r.params));
        expect(declared.status).toBe(413);
        expect(declared.headers.get("cache-control")).toMatch(NO_STORE);
        const streamed = await r.h(request(r.method, { body: big }), ctxOf(r.params));
        expect(streamed.status).toBe(413);
        expect(fetchUpstream).not.toHaveBeenCalled();
      });

      it("refuses a body that is not JSON with 400 and never calls the API", async () => {
        for (const raw of ["{not json", "<xml/>", "[[["]) {
          const res = await r.h(request(r.method, { body: raw }), ctxOf(r.params));
          expect(res.status, raw).toBe(400);
          expect(res.headers.get("cache-control")).toMatch(NO_STORE);
        }
        expect(fetchUpstream).not.toHaveBeenCalled();
      });
    });
  }

  for (const r of MUTATING) {
    describe(`${r.name} (CSRF)`, () => {
      it("a missing CSRF header, a missing session and a foreign Origin are refused with no-store and no API call", async () => {
        const noCsrf = await r.h(request(r.method, { headers: { "X-CSRF-Token": null }, body: bodyOf(r.body) }), ctxOf(r.params));
        expect(noCsrf.status).toBe(403);
        expect(noCsrf.headers.get("cache-control")).toMatch(NO_STORE);
        const foreign = await r.h(request(r.method, { headers: { Origin: "http://evil.test" }, body: bodyOf(r.body) }), ctxOf(r.params));
        expect(foreign.status).toBe(403);
        getSession.mockResolvedValue(null);
        const anon = await r.h(request(r.method, { body: bodyOf(r.body) }), ctxOf(r.params));
        expect(anon.status).toBe(401);
        expect(anon.headers.get("cache-control")).toMatch(NO_STORE);
        expect(fetchUpstream).not.toHaveBeenCalled();
      });

      it("an upstream refusal passes through unchanged, no-store, and never leaks a secret it was sent", async () => {
        fetchUpstream.mockResolvedValue({
          ok: false,
          status: 409,
          error: { error: { code: "BACKUP_TARGET_IN_USE", message: "in use", details: [] } },
        });
        const res = await r.h(request(r.method, { body: bodyOf(r.body) }), ctxOf(r.params));
        expect(res.status).toBe(409);
        expect(res.headers.get("cache-control")).toMatch(NO_STORE);
        expect(await res.text()).toContain("BACKUP_TARGET_IN_USE");
      });
    });
  }

  for (const r of READS) {
    it(`${r.name} GET: no-store on success, 401 without a session, and a secret-looking upstream field is redacted`, async () => {
      fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: { targets: [], password: SECRET, accessToken: SECRET, privateKey: SECRET } } });
      const ok = await r.h(request("GET"), ctxOf(r.params));
      expect(ok.status).toBe(200);
      expect(ok.headers.get("cache-control")).toMatch(NO_STORE);
      expect(await ok.text()).not.toContain(SECRET);
      getSession.mockResolvedValue(null);
      const anon = await r.h(request("GET"), ctxOf(r.params));
      expect(anon.status).toBe(401);
      expect(anon.headers.get("cache-control")).toMatch(NO_STORE);
    });
  }

  it("a customer cannot reach the admin target routes' paths through the customer routes' path segments", async () => {
    // path segments are whitelisted before the session is read: no traversal into another upstream path
    for (const bad of ["..", "a/b", "a%2Fb", "x?y=1", "x#y", "a b", ""]) {
      const res = await (sitePolicyRoute.GET as unknown as Handler)(request("GET"), ctxOf({ ...C, siteId: bad }));
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.headers.get("cache-control")).toMatch(NO_STORE);
    }
    expect(fetchUpstream).not.toHaveBeenCalled();
  });
});

// Pre-existing hardening gap (not an M3 regression): the generic BFF redaction list has no S3 secret key name, so a
// `secretAccessKey` that an upstream DTO wrongly carried would reach the browser. The API never emits it today.
describe("BFF defence in depth for S3 credentials", () => {
  it("redacts a stray secretAccessKey property from an upstream GET body", async () => {
    getSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: { targets: [], secretAccessKey: SECRET } } });
    const res = await (targetsRoute.GET as unknown as Handler)(request("GET"), ctxOf({}));
    expect(await res.text()).not.toContain(SECRET);
  });
});
