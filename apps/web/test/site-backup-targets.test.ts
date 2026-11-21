import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SiteBackupDto, SiteBackupPolicyDto, SiteBackupsDto } from "@hosting-panel/contracts";

vi.mock("@/lib/server-api", () => ({
  serverGet: vi.fn(),
  fetchServerSiteBackupPolicy: vi.fn(),
}));

import { en } from "@/i18n/en";
import { it as itCatalog } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";
import {
  bothChoiceIds,
  choiceLabels,
  copyLabel,
  hasRestorableCopy,
  restorableCopies,
  statusView,
} from "@/lib/backup-copies";
import { Dialog } from "@/components/ui/dialog";
import { RestoreBackupForm } from "@/components/customer/restore-backup-dialog";
import {
  SiteBackups,
  triggerPrepareDownload,
  triggerRestoreBackup,
} from "@/components/customer/site-backups";

const T = en.site.backups;
const BASE = "/api/bff/orgs/org_1/managed-sites/site_1/backups";
const LOCAL = "tgt_local1";
const S3A = "tgt_s3a";
const S3B = "tgt_s3b";

function copy(
  targetId: string,
  kind: "s3" | "local",
  status: SiteBackupDto["copies"][number]["status"],
  over: Partial<SiteBackupDto["copies"][number]> = {},
): SiteBackupDto["copies"][number] {
  return {
    targetId,
    kind,
    status,
    sizeBytes: status === "succeeded" ? 2_048 : null,
    problem: null,
    startedAt: "2026-11-01T02:00:00.000Z",
    finishedAt: "2026-11-01T02:05:00.000Z",
    ...over,
  };
}

function row(over: Record<string, unknown> = {}): SiteBackupDto {
  return {
    id: "bak_1",
    kind: "nightly",
    status: "succeeded",
    startedAt: "2026-11-01T02:00:00.000Z",
    finishedAt: "2026-11-01T02:05:00.000Z",
    sizeBytes: 2_048,
    problem: null,
    archive: null,
    copies: [copy(S3A, "s3", "succeeded")],
    ...over,
  } as SiteBackupDto;
}

function dto(backups: SiteBackupDto[]): SiteBackupsDto {
  return {
    available: true,
    configured: true,
    retentionDays: 14,
    manualKept: 3,
    runningOperationId: null,
    lastRestore: null,
    backups,
    targets: [],
  };
}

function render(locale: "en" | "it", element: ReactElement): string {
  const messages = locale === "it" ? itCatalog : en;
  return renderToStaticMarkup(createElement(I18nProvider, { locale, messages, children: element })).replaceAll(
    "&#x27;",
    "'",
  );
}

function page(backups: SiteBackupDto[], policy?: SiteBackupPolicyDto | null, locale: "en" | "it" = "en") {
  return render(
    locale,
    createElement(SiteBackups, { basePath: BASE, initial: dto(backups), csrfToken: "csrf", siteName: "shop", policy }),
  );
}

const choice = (id: string, kind: "s3" | "local") => ({ id, kind });

describe("backup-copies", () => {
  it("labels destinations neutrally and numbers off-server ones only when there are several", () => {
    expect(copyLabel(T.target, "local")).toBe(T.target.thisServer);
    expect(copyLabel(T.target, "s3")).toBe(T.target.offServer);
    expect(choiceLabels(T.target, [{ kind: "s3" }, { kind: "local" }])).toEqual([
      T.target.offServer,
      T.target.thisServer,
    ]);
    expect(choiceLabels(T.target, [{ kind: "s3" }, { kind: "s3" }])).toEqual([
      "Off-server copy 1",
      "Off-server copy 2",
    ]);
  });

  it("gives partial, failed and succeeded a different text and icon, not only a colour", () => {
    const views = ["succeeded", "failed", "partial", "running"].map((s) => statusView(s));
    expect(new Set(views.map((v) => v.icon)).size).toBe(4);
    expect(new Set(views.map((v) => T.status[v.textKey as "succeeded"])).size).toBe(4);
    expect(statusView("nonsense").textKey).toBe("unknown");
  });

  it("restorableCopies keeps succeeded copies; a succeeded backup without any copy stays usable", () => {
    const b = row({ status: "partial", copies: [copy(S3A, "s3", "failed"), copy(LOCAL, "local", "succeeded")] });
    expect(restorableCopies(b).map((c) => c.targetId)).toEqual([LOCAL]);
    expect(hasRestorableCopy(b)).toBe(true);
    expect(hasRestorableCopy(row({ status: "failed", copies: [copy(S3A, "s3", "failed")] }))).toBe(false);
    expect(hasRestorableCopy(row({ copies: [] }))).toBe(true);
    expect(hasRestorableCopy(row({ status: "failed", copies: [] }))).toBe(false);
  });
});

describe("destination chooser", () => {
  const inherited = (choices: SiteBackupPolicyDto["choices"]): SiteBackupPolicyDto => ({
    targetIds: [],
    inherited: true,
    choices,
  });

  it("is hidden without a policy or without choices", () => {
    for (const p of [undefined, null, inherited([])]) {
      const html = page([row()], p);
      expect(html).not.toContain(T.target.title);
      expect(html).not.toContain(T.target.save);
    }
  });

  it("shows inherit plus neutral choices and no technical word", () => {
    const html = page([row()], inherited([choice(S3A, "s3"), choice(LOCAL, "local")]));
    expect(html).toContain(T.target.title);
    expect(html).toContain(T.target.inherit);
    expect(html).toContain(T.target.offServer);
    expect(html).toContain(T.target.thisServer);
    expect(html).toMatch(/type="radio"/);
    expect(html).not.toMatch(/restic|\bs3\b|bucket|endpoint/i);
    expect(html).not.toContain(T.target.localWarning);
  });

  it("warns when the local choice is the saved one, in both languages", () => {
    const policy: SiteBackupPolicyDto = { targetIds: [LOCAL], inherited: false, choices: [choice(LOCAL, "local")] };
    expect(page([row()], policy)).toContain(T.target.localWarning);
    expect(page([row()], policy, "it")).toContain(itCatalog.site.backups.target.localWarning);
  });

  it("numbers two off-server choices", () => {
    const html = page([row()], inherited([choice(S3A, "s3"), choice(S3B, "s3")]));
    expect(html).toContain("Off-server copy 1");
    expect(html).toContain("Off-server copy 2");
  });
});

describe("destination chooser: both", () => {
  const both = (targetIds: string[] = []): SiteBackupPolicyDto => ({
    targetIds,
    inherited: targetIds.length === 0,
    choices: [choice(S3A, "s3"), choice(LOCAL, "local")],
  });

  it("offers Both only when the administrator offered exactly two destinations", () => {
    expect(bothChoiceIds([choice(S3A, "s3"), choice(LOCAL, "local")])).toEqual([S3A, LOCAL]);
    expect(bothChoiceIds([choice(S3A, "s3")])).toBeNull();
    expect(bothChoiceIds([choice(S3A, "s3"), choice(S3B, "s3"), choice(LOCAL, "local")])).toBeNull();
    expect(page([row()], both())).toContain(T.target.both);
    expect(page([row()], { targetIds: [], inherited: true, choices: [choice(LOCAL, "local")] })).not.toContain(T.target.both);
    expect(page([row()], { targetIds: [], inherited: true, choices: [choice(S3A, "s3")] })).not.toContain(T.target.both);
  });

  it("marks Both as saved and warns about the local copy when the policy holds both", () => {
    const html = page([row()], both([S3A, LOCAL]));
    expect(html).toMatch(/type="radio"[^>]*checked=""[^>]*value="both"/);
    expect(html).toContain(T.target.localWarning);
    expect(page([row()], both([S3A]))).not.toContain(T.target.localWarning);
  });

  it("has an Italian text for Both", () => {
    expect(page([row()], both(), "it")).toContain(itCatalog.site.backups.target.both);
  });

  it("never offers an encrypted .zip.age download while the export is unavailable", () => {
    const html = page([row({ copies: [copy(S3A, "s3", "succeeded"), copy(LOCAL, "local", "succeeded")] })], both());
    expect(html).not.toMatch(/\.zip\.age|age key|recipient/i);
  });
});

describe("rows with copies", () => {
  it("keeps the legacy single off-server copy invisible", () => {
    expect(page([row()])).not.toContain(T.copies.title);
  });

  it("lists every copy with its status text; partial differs from succeeded and failed", () => {
    const partial = row({
      id: "bak_p",
      status: "partial",
      copies: [copy(S3A, "s3", "failed", { problem: "unreachable" }), copy(LOCAL, "local", "succeeded")],
    });
    const failed = row({ id: "bak_f", status: "failed", copies: [copy(S3A, "s3", "failed")], problem: "unreachable" });
    const ok = row({ id: "bak_o", copies: [copy(S3A, "s3", "succeeded"), copy(LOCAL, "local", "succeeded")] });
    const htmlPartial = page([partial]);
    expect(htmlPartial).toContain(T.status.partial);
    expect(htmlPartial).toContain(T.copies.title);
    expect(htmlPartial).toContain(T.copies.partialHelp);
    expect(htmlPartial).toContain(`${T.target.offServer}: ${T.copies.status.failed}`);
    expect(htmlPartial).toContain(`${T.target.thisServer}: ${T.copies.status.succeeded}, 2 kB`);
    expect(htmlPartial).toContain(T.problem.unreachable);
    expect(htmlPartial).toContain("<svg");
    const htmlFailed = page([failed]);
    const htmlOk = page([ok]);
    expect(htmlFailed).not.toContain(T.status.partial);
    expect(htmlOk).not.toContain(T.status.partial);
    expect(htmlOk).not.toContain(T.copies.partialHelp);
  });

  it("enables restore and download on a partial row with a restorable copy, not on a fully failed one", () => {
    const partial = row({ status: "partial", copies: [copy(S3A, "s3", "failed"), copy(LOCAL, "local", "succeeded")] });
    const failed = row({ id: "bak_f", status: "failed", copies: [copy(S3A, "s3", "failed")] });
    const withPartial = page([partial]);
    expect(withPartial).toContain(`>${T.restore.button}<`);
    expect(withPartial).toContain(`>${T.download.prepare}<`);
    const withFailed = page([failed]);
    expect(withFailed).not.toContain(`>${T.restore.button}<`);
    expect(withFailed).not.toContain(`>${T.download.prepare}<`);
  });

  it("offers a download source select only when more than one copy is restorable", () => {
    const two = row({ copies: [copy(S3A, "s3", "succeeded"), copy(LOCAL, "local", "succeeded")] });
    expect(page([two])).toContain(`aria-label="${T.restore.fromLabel}"`);
    expect(page([row()])).not.toContain(T.restore.fromLabel);
  });
});

describe("restore dialog", () => {
  const backup = { id: "bak_1", startedAt: "2026-11-01T02:00:00.000Z" };
  const form = (copies?: { targetId: string; label: string }[]) =>
    render(
      "en",
      createElement(Dialog, {
        open: true,
        children: createElement(RestoreBackupForm, {
          backup,
          siteName: "shop",
          onConfirm: async () => null,
          onCancel: () => {},
          copies,
        }),
      }),
    );

  it("shows the source radios only when more than one copy is restorable, and names the source with one (SPEC 8.2)", () => {
    const copies = [
      { targetId: S3A, label: T.target.offServer },
      { targetId: LOCAL, label: T.target.thisServer },
    ];
    const html = form(copies);
    expect(html).toContain(T.restore.fromLabel);
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toContain(T.target.thisServer);
    // SPEC 8.2: with one copy the dialog still NAMES its source, but offers no choice.
    const single = form(copies.slice(0, 1));
    expect(single).toContain(T.restore.fromLabel);
    expect(single).toContain(T.target.offServer);
    expect(single).not.toContain('type="radio"');
    expect(form()).not.toContain('type="radio"');
  });
});

describe("request bodies", () => {
  const send = (fn: typeof triggerRestoreBackup | typeof triggerPrepareDownload, extra: Record<string, unknown>) => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 202 }));
    return fn({
      basePath: BASE,
      backupId: "bak_1",
      confirmName: "shop",
      csrfToken: "csrf",
      inFlightRef: { current: false },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      makeIdempotencyKey: () => "k",
      ...extra,
    } as never).then(() => (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body);
  };

  it("restore sends targetId only when one is given", async () => {
    expect(await send(triggerRestoreBackup, {})).toBe('{"confirmName":"shop"}');
    expect(await send(triggerRestoreBackup, { targetId: LOCAL })).toBe(`{"confirmName":"shop","targetId":"${LOCAL}"}`);
  });

  it("download prepare never sends a format or recipient", async () => {
    expect(await send(triggerPrepareDownload, { targetId: LOCAL })).not.toMatch(/format|recipient/);
  });

  it("download prepare sends {} unless a target is given", async () => {
    expect(await send(triggerPrepareDownload, {})).toBe("{}");
    expect(await send(triggerPrepareDownload, { targetId: S3A })).toBe(`{"targetId":"${S3A}"}`);
  });
});

describe("destination choice request", () => {
  it("PATCHes {targetIds} with the CSRF token; null returns to the default", async () => {
    const { saveSiteBackupPolicy } = await import("@/components/customer/site-backups");
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const path = "/api/bff/orgs/org_1/managed-sites/site_1/backup-policy";
    expect(await saveSiteBackupPolicy({ policyPath: path, targetIds: null, csrfToken: "c", fetchImpl: fetchImpl as never })).toBe(true);
    expect(await saveSiteBackupPolicy({ policyPath: path, targetIds: [LOCAL], csrfToken: "c", fetchImpl: fetchImpl as never })).toBe(true);
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit & { headers: Record<string, string> }][];
    expect(calls[0]![0]).toBe(path);
    expect(calls[0]![1].method).toBe("PATCH");
    expect(calls[0]![1].body).toBe('{"targetIds":null}');
    expect(calls[1]![1].body).toBe(`{"targetIds":["${LOCAL}"]}`);
    expect(calls[1]![1].headers["x-csrf-token"]).toBe("c");
    await saveSiteBackupPolicy({ policyPath: path, targetIds: [S3A, LOCAL], csrfToken: "c", fetchImpl: fetchImpl as never });
    expect((fetchImpl.mock.calls[2] as unknown as [string, RequestInit])[1].body).toBe(`{"targetIds":["${S3A}","${LOCAL}"]}`);
    const failing = vi.fn(async () => new Response("{}", { status: 500 }));
    expect(await saveSiteBackupPolicy({ policyPath: path, targetIds: null, csrfToken: "c", fetchImpl: failing as never })).toBe(false);
  });
});
