import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  UpdateDefaultSiteBackupPolicyInputSchema,
  UpdatePanelBackupPolicyInputSchema,
  type AdminBackupTargetDto,
  type BackupPolicyDto,
  type BackupSettingsDto,
} from "@hosting-panel/contracts";
import { format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getServerSession = vi.fn();
const getRequestLocale = vi.fn();

vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...args: unknown[]) => fetchUpstream(...args),
}));
vi.mock("@/lib/server-session", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));
vi.mock("@/i18n/server", () => ({ getRequestLocale: (...args: unknown[]) => getRequestLocale(...args) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/backups",
}));

import AdminBackupsPage from "@/app/admin/backups/page";
import { BackupTargets, canDeleteTarget, isLowSpace, targetErrorText, targetStateText } from "@/components/admin/backup-targets";
import { BackupPolicyForm, policyPatch, toggleTarget } from "@/components/admin/backup-policy";
import { BackupDisasterRecovery } from "@/components/admin/backup-disaster-recovery";

const SPEC_WARNING_IT =
  "I backup locali sullo stesso server non proteggono dalla perdita del server o del disco. Per disaster recovery conserva una copia fuori dal server e la chiave di recupero.";
const SPEC_WARNING_EN =
  "Local backups on the same server do not protect against losing the server or its disk. For disaster recovery, keep a copy off the server and the recovery key.";

const NOW = "2026-11-21T10:00:00.000Z";
const GIB = 1024 ** 3;

function target(over: Partial<AdminBackupTargetDto> & { id: string; kind: "s3" | "local" }): AdminBackupTargetDto {
  return {
    name: over.kind === "local" ? "This server" : "Offsite",
    enabled: true,
    customerSelectable: false,
    legacy: false,
    archivedAt: null,
    retentionDays: null,
    s3:
      over.kind === "s3"
        ? { endpoint: "https://s3.example.com", region: "eu-west-1", bucket: "panel-bkp", prefix: "hp/main", accessKeyId: "AKIA1234", secretAccessKeySet: true }
        : null,
    local: over.kind === "local" ? { root: "/var/lib/hosting-panel/local-repos", initializedAt: null } : null,
    lastTest: null,
    usage: { policies: [], copies: 0 },
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as AdminBackupTargetDto;
}

const S3 = target({ id: "bkt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", kind: "s3", legacy: true, usage: { policies: ["default_site", "panel"], copies: 12 } });
const S3_ARCHIVED = target({ id: "bkt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", kind: "s3", name: "Old bucket", archivedAt: NOW, usage: { policies: [], copies: 0 } });
const LOCAL = target({ id: "bkt_cccccccccccccccccccccccccccccccc", kind: "local" });

const wrap = (m: Messages, node: ReactElement, locale: "en" | "it" = "en") =>
  createElement(I18nProvider, { locale, messages: m, children: node });
const html = (m: Messages, node: ReactElement, locale: "en" | "it" = "en") =>
  renderToStaticMarkup(wrap(m, node, locale)).replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function policy(over: Partial<BackupPolicyDto> = {}): BackupPolicyDto {
  return {
    scope: "default_site",
    siteId: null,
    scheduleHourUtc: 2,
    retentionDays: 14,
    targets: [{ targetId: S3.id, kind: "s3", priority: 1, required: true }],
    updatedAt: NOW,
    ...over,
  };
}

function legacySettings(): BackupSettingsDto {
  return {
    available: true,
    configured: true,
    endpoint: "https://s3.example.com",
    region: "eu-west-1",
    bucket: "panel-bkp",
    prefix: "hp/main",
    accessKeyId: "AKIA1234",
    secretAccessKeySet: true,
    scheduleHourUtc: 2,
    retentionDays: 14,
    lastNightlyRunOn: null,
    lastTest: null,
    updatedAt: NOW,
    lastPanelBackup: null,
    newestBackupsTotalBytes: 0,
  };
}

describe("BackupTargets (destinations tab)", () => {
  const props = { csrfToken: "csrf", localAvailable: true } as const;

  it("lists every target with state text and the two switches; the legacy one is marked", () => {
    const out = html(en, createElement(BackupTargets, { ...props, initial: { targets: [S3, S3_ARCHIVED], localRootConfigured: true } }));
    expect(out).toContain(en.admin.backups.targets.title);
    expect(out).toContain("Offsite");
    expect(out).toContain(en.admin.backups.targets.legacy);
    expect(out).toContain(en.admin.backups.targets.state.enabled);
    expect(out).toContain(en.admin.backups.targets.state.archived);
    expect(out).toContain(en.admin.backups.targets.state.neverTested);
    expect(out).toContain(en.admin.backups.targets.switches.customerSelectable);
    expect(out).toContain(format(en.admin.backups.targets.copiesCount, { count: 12 }));
    expect(out.match(/role="switch"/g)).toHaveLength(4);
    // An archived row is read-only: its two switches are disabled.
    const archivedRow = out.split("<tr").find((r) => r.includes("Old bucket")) ?? "";
    expect(archivedRow.match(/role="switch"[^>]*disabled/g)).toHaveLength(2);
  });

  it("shows an empty text when nothing is saved", () => {
    const out = html(en, createElement(BackupTargets, { ...props, localAvailable: false, initial: { targets: [], localRootConfigured: true } }));
    expect(out).toContain(en.admin.backups.targets.empty);
  });

  it("offers Delete only for an unused, non-legacy row and Archive for a live one", () => {
    expect(canDeleteTarget(S3)).toBe(false); // legacy and in use
    expect(canDeleteTarget({ ...S3, usage: { policies: [], copies: 0 } })).toBe(false); // legacy
    expect(canDeleteTarget(S3_ARCHIVED)).toBe(true);
    expect(canDeleteTarget({ ...S3_ARCHIVED, usage: { policies: [], copies: 3 } })).toBe(false);
    const out = html(en, createElement(BackupTargets, { ...props, initial: { targets: [S3, S3_ARCHIVED], localRootConfigured: true } }));
    const row = (name: string) => out.split("<tr").find((r) => r.includes(name)) ?? "";
    expect(row("Old bucket")).toContain(en.admin.backups.targets.delete.button);
    expect(row("Old bucket")).not.toContain(`>${en.admin.backups.targets.archive.button}<`);
    expect(row("Offsite")).not.toContain(en.admin.backups.targets.delete.button);
    expect(row("Offsite")).toContain(`>${en.admin.backups.targets.archive.button}<`);
  });

  it("states the last test with its problem text, in both languages", () => {
    const failed = target({
      id: "bkt_dddddddddddddddddddddddddddddddd",
      kind: "local",
      lastTest: { at: NOW, outcome: "failed", problem: "local_target_unmounted", availableBytes: null, totalBytes: null },
    });
    for (const [m, locale] of [[en, "en"], [itMsgs, "it"]] as const) {
      const text = targetStateText(m, failed, locale);
      expect(text).toContain(m.admin.backups.problem.local_target_unmounted);
      expect(text).toContain(m.admin.backups.targets.state.testFailed.replace(/\{when\}.*$/, "").trim());
    }
    const ok = target({ id: "bkt_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", kind: "local", lastTest: { at: NOW, outcome: "ok", problem: null, availableBytes: 5 * GIB, totalBytes: 10 * GIB } });
    expect(targetStateText(en, ok, "en")).toContain(en.admin.backups.targets.state.testOk.replace(/\s*\(\{when\}\)$/, ""));
    expect(targetStateText(en, S3_ARCHIVED, "en")).toBe(en.admin.backups.targets.state.archived);
    expect(targetStateText(en, { ...S3, enabled: false }, "en")).toContain(en.admin.backups.targets.state.disabled);
  });

  it("maps BACKUP_TARGET_IN_USE to its own text and anything else to the catalog", () => {
    expect(targetErrorText(en, "BACKUP_TARGET_IN_USE")).toBe(en.admin.backups.targets.inUse);
    expect(targetErrorText(en, "")).toBe(en.admin.backups.targets.saveFailed);
    expect(targetErrorText(en, "RATE_LIMITED")).toBe(en.errors.RATE_LIMITED);
  });

  it("flags low space like the health alert: under 1 GiB or under a tenth of the disk", () => {
    const test = (a: number | null, t: number | null) => ({ at: NOW, outcome: "ok" as const, problem: null, availableBytes: a, totalBytes: t });
    expect(isLowSpace(null)).toBe(false);
    expect(isLowSpace(test(null, null))).toBe(false);
    expect(isLowSpace(test(GIB / 2, 100 * GIB))).toBe(true);
    expect(isLowSpace(test(5 * GIB, 100 * GIB))).toBe(true);
    expect(isLowSpace(test(20 * GIB, 100 * GIB))).toBe(false);
  });

  describe("local card", () => {
    it("is hidden when the capability is false", () => {
      const out = html(en, createElement(BackupTargets, { ...props, localAvailable: false, initial: { targets: [LOCAL], localRootConfigured: true } }));
      expect(out).not.toContain(en.admin.backups.targets.local.title);
      expect(out).not.toContain(SPEC_WARNING_EN);
    });

    it("offers adding one (name only, never a path) when no live local target exists, with the warning visible", () => {
      for (const [m, warning, locale] of [[en, SPEC_WARNING_EN, "en"], [itMsgs, SPEC_WARNING_IT, "it"]] as const) {
        const out = html(m, createElement(BackupTargets, { ...props, initial: { targets: [S3], localRootConfigured: true } }), locale);
        expect(out).toContain(m.admin.backups.targets.local.title);
        expect(out).toContain(m.admin.backups.targets.local.add);
        expect(out).toContain(warning);
        expect(out).toContain('role="note"');
        expect(out).not.toMatch(/name="(path|root|localRoot)"/);
      }
    });

    it("hides the add form once a live local target exists and shows its root read-only, mount state and capacity", () => {
      const local = target({
        id: "bkt_ffffffffffffffffffffffffffffffff",
        kind: "local",
        local: { root: "/mnt/backups", initializedAt: NOW },
        lastTest: { at: NOW, outcome: "ok", problem: null, availableBytes: 40 * GIB, totalBytes: 100 * GIB },
      });
      const out = html(en, createElement(BackupTargets, { ...props, initial: { targets: [S3, local], localRootConfigured: true } }));
      expect(out).not.toContain(en.admin.backups.targets.local.add);
      expect(out).toContain("/mnt/backups");
      expect(out).toMatch(/<code[^>]*>\/mnt\/backups<\/code>/);
      expect(out).not.toMatch(/<input[^>]*value="\/mnt\/backups"/);
      expect(out).toContain(en.admin.backups.targets.local.initialise);
      expect(out).toContain(en.admin.backups.targets.test.button);
      expect(out).toContain(en.admin.backups.targets.local.initialised.replace(/\{when\}.*$/, ""));
      expect(out).toMatch(/40(\.0)? GB|40 GiB|40(\.0)? GiB/);
      expect(out).not.toContain(en.admin.backups.targets.lowSpace.slice(0, 20));
    });

    it("says it is not initialised, explains missing capacity and warns on low space", () => {
      const fresh = html(en, createElement(BackupTargets, { ...props, initial: { targets: [LOCAL], localRootConfigured: true } }));
      expect(fresh).toContain(en.admin.backups.targets.local.notInitialised);
      expect(fresh).toContain(en.admin.backups.targets.capacityUnknown);
      const low = target({
        id: "bkt_11111111111111111111111111111111",
        kind: "local",
        lastTest: { at: NOW, outcome: "ok", problem: null, availableBytes: GIB / 4, totalBytes: 100 * GIB },
      });
      const out = html(en, createElement(BackupTargets, { ...props, initial: { targets: [low], localRootConfigured: true } }));
      expect(out).toContain(en.admin.backups.targets.lowSpace.slice(0, 24));
    });

    it("an archived local target does not block adding a new one", () => {
      const out = html(
        en,
        createElement(BackupTargets, { ...props, initial: { targets: [{ ...LOCAL, archivedAt: NOW }], localRootConfigured: true } }),
      );
      expect(out).toContain(en.admin.backups.targets.local.add);
    });
  });
});

describe("BackupPolicyForm (policy tab)", () => {
  const panel = policy({ scope: "panel", scheduleHourUtc: null, retentionDays: 30 });
  const mount = (over: Partial<Parameters<typeof BackupPolicyForm>[0]> = {}, m: Messages = en) =>
    html(m, createElement(BackupPolicyForm, { csrfToken: "csrf", siteDefault: policy(), panel, targets: [S3, LOCAL, S3_ARCHIVED], ...over }));

  it("renders both cards with hour (UTC and local), retention and a destination choice of live targets only", () => {
    const out = mount();
    expect(out).toContain(en.admin.backups.policy.sites.title);
    expect(out).toContain(en.admin.backups.policy.panel.title);
    expect(out).toContain(en.admin.backups.policy.sites.hour);
    expect(out).toContain(en.admin.backups.policy.sites.retention);
    expect(out).toContain(format(en.admin.backups.policy.panel.schedule, { utc: "02:00", days: 30 }));
    expect(out).toContain(format(en.admin.backups.policy.option, { name: "Offsite", kind: "S3" }));
    expect(out).toContain(format(en.admin.backups.policy.option, { name: "This server", kind: "Local" }));
    expect(out).not.toContain("Old bucket");
    expect(out).not.toContain('type="radio"');
    expect(out.match(/type="checkbox"/g)).toHaveLength(4); // 2 targets x 2 cards: up to two destinations
    expect(out.match(/type="checkbox"[^>]*checked/g)).toHaveLength(2);
    expect(out).toContain(en.admin.backups.policy.destinationsHint);
  });

  it("shows both destinations of a two-target policy ticked, with the mandatory warning", () => {
    const both = policy({
      targets: [
        { targetId: S3.id, kind: "s3", priority: 1, required: true },
        { targetId: LOCAL.id, kind: "local", priority: 2, required: true },
      ],
    });
    const out = mount({ siteDefault: both });
    expect(out.match(/type="checkbox"[^>]*checked/g)).toHaveLength(3); // 2 on the sites card + 1 on the panel card
    expect(out).toContain(SPEC_WARNING_EN);
    expect(mount({ siteDefault: both }, itMsgs)).toContain(itMsgs.admin.backups.policy.destinationsHint);
  });

  it("stops at two destinations: with two ticked the third is disabled and a ticked one can be cleared", () => {
    const third = target({ id: "bkt_dddddddddddddddddddddddddddddddd", kind: "s3", name: "Second bucket" });
    const both = policy({
      targets: [
        { targetId: S3.id, kind: "s3", priority: 1, required: true },
        { targetId: LOCAL.id, kind: "local", priority: 2, required: true },
      ],
    });
    const sitesCard = mount({ siteDefault: both, targets: [S3, LOCAL, third] }).split('name="policy-panel-target"')[0] ?? "";
    const boxes = sitesCard.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(boxes).toHaveLength(3);
    expect(boxes.filter((b) => b.includes("disabled"))).toHaveLength(1);
    expect(boxes.find((b) => b.includes("disabled"))).toContain(third.id);
    expect(toggleTarget([S3.id, LOCAL.id], third.id)).toEqual([S3.id, LOCAL.id]);
    expect(toggleTarget([S3.id, LOCAL.id], S3.id)).toEqual([LOCAL.id]);
    expect(toggleTarget([LOCAL.id], S3.id)).toEqual([LOCAL.id, S3.id]);
    expect(toggleTarget([], S3.id)).toEqual([S3.id]);
  });

  it("shows the mandatory warning only when the chosen set holds a local target", () => {
    expect(mount()).not.toContain(SPEC_WARNING_EN);
    const local = policy({ targets: [{ targetId: LOCAL.id, kind: "local", priority: 1, required: true }] });
    expect(mount({ siteDefault: local })).toContain(SPEC_WARNING_EN);
    expect(mount({ panel: { ...local, scope: "panel", scheduleHourUtc: null } }, en)).toContain(SPEC_WARNING_EN);
    expect(mount({ siteDefault: local }, itMsgs)).toContain(SPEC_WARNING_IT);
  });

  it("tells the administrator there is nothing to choose without a live destination", () => {
    const out = mount({ targets: [S3_ARCHIVED] });
    expect(out).toContain(en.admin.backups.policy.noTargets);
  });

  it("builds a PATCH body with only the changed fields, valid for the contract schemas", () => {
    const base = policy();
    expect(policyPatch(base, { scheduleHourUtc: 2, retentionDays: 14, targetIds: [S3.id] })).toEqual({});
    expect(policyPatch(base, { scheduleHourUtc: 3, retentionDays: 14, targetIds: [S3.id] })).toEqual({ scheduleHourUtc: 3 });
    expect(policyPatch(base, { scheduleHourUtc: 2, retentionDays: 30, targetIds: [LOCAL.id] })).toEqual({
      retentionDays: 30,
      targetIds: [LOCAL.id],
    });
    const patch = policyPatch(base, { scheduleHourUtc: 5, retentionDays: 7, targetIds: [LOCAL.id] });
    expect(UpdateDefaultSiteBackupPolicyInputSchema.safeParse(patch).success).toBe(true);
    // The panel card sends destinations only.
    expect(policyPatch(base, { scheduleHourUtc: 2, retentionDays: 14, targetIds: [S3.id, LOCAL.id] })).toEqual({
      targetIds: [S3.id, LOCAL.id],
    });
    const twoPatch = policyPatch(base, { targetIds: [S3.id, LOCAL.id] });
    expect(UpdateDefaultSiteBackupPolicyInputSchema.safeParse(twoPatch).success).toBe(true);
    const panelPatch = policyPatch(panel, { targetIds: [LOCAL.id] });
    expect(panelPatch).toEqual({ targetIds: [LOCAL.id] });
    expect(UpdatePanelBackupPolicyInputSchema.safeParse(panelPatch).success).toBe(true);
  });
});

describe("BackupDisasterRecovery (recovery tab)", () => {
  const out = (targets: AdminBackupTargetDto[], m: Messages = en) => renderToStaticMarkup(createElement(BackupDisasterRecovery, { m, targets }))
    .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

  it("is text only: no button, no form, no link that acts", () => {
    const markup = out([S3, LOCAL]);
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("<input");
  });

  it("names backup.key and fills the real target ids and values into the commands", () => {
    const markup = out([S3, LOCAL, S3_ARCHIVED]);
    expect(markup).toContain("/etc/hosting-panel/backup.key");
    expect(markup).toContain(
      "hp-restore-panel --endpoint https://s3.example.com --region eu-west-1 --bucket panel-bkp --prefix hp/main",
    );
    expect(markup).toContain(S3.id);
    expect(markup).toContain(`hp-restore-panel --local-repo /var/lib/hosting-panel/local-repos/${LOCAL.id}/panel`);
    expect(markup).toContain(en.admin.backups.recovery.local.exits);
    expect(markup).toContain(en.admin.backups.recovery.local.lostDisk);
    expect(markup).not.toContain("{");
    expect(markup).not.toContain("AKIA1234");
  });

  it("drops --prefix when the S3 destination has none, and shows the empty texts", () => {
    const noPrefix = target({ id: "bkt_22222222222222222222222222222222", kind: "s3", s3: { ...S3.s3!, prefix: "" } });
    const markup = out([noPrefix]);
    expect(markup).toContain("--bucket panel-bkp");
    expect(markup).not.toMatch(/--prefix\s*</);
    expect(markup).toContain(en.admin.backups.recovery.s3.noPrefix);
    expect(markup).toContain(en.admin.backups.recovery.local.empty);
    expect(out([LOCAL])).toContain(en.admin.backups.recovery.s3.empty);
  });

  it("renders in Italian with the same commands", () => {
    const markup = out([S3, LOCAL], itMsgs);
    expect(markup).toContain(itMsgs.admin.backups.recovery.title);
    expect(markup).toContain(`--local-repo /var/lib/hosting-panel/local-repos/${LOCAL.id}/panel`);
  });
});

describe("admin backups page tabs", () => {
  const envelope = (data: unknown) => ({ ok: true, status: 200, data: { data } });
  const route = (tab: string | undefined, upstream: Record<string, unknown>) => {
    fetchUpstream.mockImplementation(async (path: string) => {
      const hit = Object.entries(upstream).find(([p]) => path === p || path.startsWith(`${p}?`));
      return hit ? hit[1] : { ok: false, status: 500 };
    });
    return AdminBackupsPage({ searchParams: Promise.resolve(tab === undefined ? {} : { tab }) });
  };
  const targetsDto = { targets: [S3, LOCAL], localRootConfigured: true };
  const upstream = {
    "v1/admin/backups": envelope(legacySettings()),
    "v1/admin/backups/sites": envelope([]),
    "v1/admin/backup-targets": envelope(targetsDto),
    "v1/admin/backup-policies/default": envelope(policy()),
    "v1/admin/backup-policies/panel": envelope(policy({ scope: "panel", scheduleHourUtc: null })),
    "v1/me": envelope({ platformCapabilities: { localBackupTargetsAvailable: true } }),
  };
  const render = async (tab: string | undefined, extra: Record<string, unknown> = {}) =>
    html(en, (await route(tab, { ...upstream, ...extra })) as ReactElement);

  beforeEach(() => {
    fetchUpstream.mockReset();
    getServerSession.mockReset();
    getRequestLocale.mockReset();
    getServerSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
    getRequestLocale.mockResolvedValue("en");
  });

  it("links the three tabs as plain navigation and marks the current one", async () => {
    const out = await render(undefined);
    for (const tab of ["destinations", "policy", "recovery"]) expect(out).toContain(`href="/admin/backups?tab=${tab}"`);
    expect(out).toContain(`aria-label="${en.admin.backups.tabs.label}"`);
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    expect(out).toMatch(/aria-current="page"[^>]*>[^<]*Destinations|Destinations<\/a>/);
  });

  it("defaults to destinations: the legacy S3 form, then the targets, then the local card", async () => {
    for (const tab of [undefined, "destinations", "bogus"]) {
      const out = await render(tab);
      expect(out).toContain(en.admin.backups.endpoint);
      expect(out).toContain(en.admin.backups.targets.title);
      expect(out).toContain(en.admin.backups.targets.local.title);
      expect(out.indexOf(en.admin.backups.endpoint)).toBeLessThan(out.indexOf(en.admin.backups.targets.title));
      expect(out).not.toContain(en.admin.backups.policy.title);
    }
  });

  it("hides the local card unless the server reports the capability", async () => {
    const out = await render("destinations", { "v1/me": envelope({ platformCapabilities: { localBackupTargetsAvailable: false } }) });
    expect(out).toContain(en.admin.backups.targets.title);
    expect(out).not.toContain(en.admin.backups.targets.local.title);
  });

  it("still shows the legacy form when the target list can't be loaded", async () => {
    const out = await render("destinations", { "v1/admin/backup-targets": { ok: false, status: 500 } });
    expect(out).toContain(en.admin.backups.endpoint);
    expect(out).toContain(en.admin.backups.targets.loadFailed);
  });

  it("policy tab loads both policies and the targets, and mounts only the policy form", async () => {
    const out = await render("policy");
    expect(out).toContain(en.admin.backups.policy.sites.title);
    expect(out).not.toContain(en.admin.backups.endpoint);
    const paths = fetchUpstream.mock.calls.map((c) => c[0]);
    expect(paths).toEqual(expect.arrayContaining(["v1/admin/backup-policies/default", "v1/admin/backup-policies/panel", "v1/admin/backup-targets"]));
    expect(paths).not.toContain("v1/admin/backups");
  });

  it("policy tab says it could not load when a policy is missing", async () => {
    const out = await render("policy", { "v1/admin/backup-policies/panel": { ok: false, status: 500 } });
    expect(out).toContain(en.admin.backups.policy.loadFailed);
  });

  it("recovery tab is read-only text built from the targets", async () => {
    const out = await render("recovery");
    expect(out).toContain(en.admin.backups.recovery.title);
    expect(out).toContain(LOCAL.id);
    expect(out).not.toContain("<form");
    expect(fetchUpstream.mock.calls.map((c) => c[0])).toEqual(["v1/admin/backup-targets"]);
  });

  it("a tab array or unknown value falls back to destinations before any data is read", async () => {
    getServerSession.mockResolvedValue(null);
    await expect(AdminBackupsPage({ searchParams: Promise.resolve({ tab: ["policy"] }) })).rejects.toThrow("REDIRECT:/login");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });
});
