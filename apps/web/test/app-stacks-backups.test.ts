import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_STACK_BACKUP_STATUSES,
  APP_STACK_BACKUP_UNAVAILABLE_REASONS,
  APP_STACK_PRE_RESTORE_BACKUPS_KEPT,
  APP_STACK_STATUSES,
  MANUAL_BACKUPS_KEPT,
  appStackAllowedActions,
  type AppStackAllowedAction,
  type AppStackBackupDto,
  type AppStackBackupsDto,
  type AppStackStatus,
} from "@hosting-panel/contracts";

const keyedSend = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("@/lib/keyed-send", () => ({ keyedSend: (...a: unknown[]) => keyedSend(...a) }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
// Radix renders its content through a portal, which static markup skips: a stand-in that honours `open`.
vi.mock("@/components/ui/dialog", async () => {
  const { createElement: h } = await import("react");
  const part = (tag: string) => ({ children }: { children?: React.ReactNode }) => h(tag, null, children);
  return {
    Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) => (open ? children : null),
    DialogContent: part("section"),
    DialogHeader: part("header"),
    DialogFooter: part("footer"),
    DialogTitle: part("h2"),
    DialogDescription: part("p"),
  };
});

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";
import { formatSize } from "@/lib/file-browser";
import {
  APP_STACK_BACKUP_STATUS_TONE,
  AppStackBackups,
  appStackBackupBlock,
  canConfirmRestore,
} from "@/components/app-stacks/app-stack-backups";

const NOW = "2026-11-22T10:00:00.000Z";
const BASE = "/api/bff/orgs/org_a1/app-stacks/stk_a1/backups";
const NAME = "team-notes";
const MIB = 2 ** 20;
const TONES = ["success", "warning", "destructive", "secondary", "outline"];
const locales = [
  ["en", en],
  ["it", itMsgs],
] as const;

const backup = (over: Partial<AppStackBackupDto> = {}): AppStackBackupDto => ({
  id: "sbak_0123456789abcdef01234567",
  kind: "manual",
  status: "succeeded",
  problem: null,
  sizeBytes: 5 * MIB,
  volumeKeys: ["notes"],
  copies: [{ priority: 1, status: "succeeded", problem: null }],
  startedAt: NOW,
  finishedAt: NOW,
  restore: null,
  restorable: true,
  incompleteData: false,
  ...over,
});
const GOOD = backup();
const RUNNING = backup({
  id: "sbak_aaaaaaaaaaaaaaaaaaaaaaaa",
  status: "running",
  sizeBytes: null,
  copies: [{ priority: 1, status: "running", problem: null }],
  startedAt: "2026-11-22T11:00:00.000Z",
  finishedAt: null,
  restorable: false,
});
const PARTIAL = backup({
  id: "sbak_bbbbbbbbbbbbbbbbbbbbbbbb",
  kind: "pre_restore",
  status: "partial",
  copies: [
    { priority: 1, status: "succeeded", problem: null },
    { priority: 2, status: "failed", problem: "unreachable" },
  ],
  startedAt: "2026-11-21T08:30:00.000Z",
  finishedAt: "2026-11-21T08:40:00.000Z",
});
const FAILED = backup({
  id: "sbak_cccccccccccccccccccccccc",
  status: "failed",
  problem: "timeout",
  sizeBytes: null,
  copies: [{ priority: 1, status: "failed", problem: "timeout" }],
  startedAt: "2026-11-20T08:30:00.000Z",
  finishedAt: "2026-11-20T09:30:00.000Z",
  restorable: false,
});
const list = (...backups: AppStackBackupDto[]): AppStackBackupsDto => ({ backups, unavailableReason: null, goBackTo: null });
/** What the detail lists for the owner of a settled running application (ADR-0035 §2.10). */
const OFFERED: AppStackAllowedAction[] = ["stack.deploy", "stack.stop", "stack.restart", "stack.delete", "stack.backup", "stack.restore"];
const props = (over: Partial<Parameters<typeof AppStackBackups>[0]> = {}): Parameters<typeof AppStackBackups>[0] => ({
  orgId: "org_a1",
  stackId: "stk_a1",
  csrfToken: "csrf",
  stackName: NAME,
  status: "running",
  stale: false,
  actions: OFFERED,
  busy: false,
  backups: list(GOOD),
  ...over,
});

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const html = (node: ReactNode, m: Messages = en) =>
  decode(renderToStaticMarkup(createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: node })));
const dateOf = (m: Messages, iso: string) =>
  new Intl.DateTimeFormat(m === en ? "en" : "it", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
/** Calls the component once with stand-in hooks; `state` presets useState slots by index: 0 creating, 1 restoring, 2 typed, 3 busy, 4 error. */
function callHooks<P>(C: (p: P) => ReactNode, p: P, m: Messages = en, state: Record<number, unknown> = {}) {
  let s = 0;
  const sets: Array<[number, unknown]> = [];
  const ctx = { locale: m === en ? "en" : "it", messages: m };
  const prev = internals.H;
  internals.H = {
    useState: (v: unknown) => {
      const k = s++;
      return [k in state ? state[k] : v, (x: unknown) => void sets.push([k, x])];
    },
    useRef: (v: unknown) => ({ current: v }),
    useContext: () => ctx,
  };
  try {
    return { out: C(p), sets };
  } finally {
    internals.H = prev;
  }
}
type El = ReactElement<Record<string, unknown>>;
const els = (node: unknown): El[] => {
  if (Array.isArray(node)) return node.flatMap(els);
  if (!isValidElement(node)) return [];
  return [node as El, ...els((node as El).props.children)];
};
const textOf = (node: unknown): string =>
  typeof node === "string" || typeof node === "number"
    ? String(node)
    : Array.isArray(node)
      ? node.map(textOf).join("")
      : isValidElement(node)
        ? textOf((node.props as Record<string, unknown>).children)
        : "";
const buttons = (tree: unknown, text: string) => els(tree).filter((e) => e.type === Button && textOf(e) === text);
const byId = (tree: unknown, id: string) => els(tree).find((e) => e.props.id === id);
const forms = (tree: unknown) => els(tree).filter((e) => e.type === "form");
const submit = (form: El | undefined) => (form!.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault() {} });
const run = (over: Parameters<typeof props>[0] = {}, m: Messages = en, state: Record<number, unknown> = {}) => {
  const called = callHooks(AppStackBackups, props(over), m, state);
  return { ...called, markup: html(called.out, m) };
};
const count = (markup: string, part: string) => markup.split(part).length - 1;

beforeEach(() => vi.clearAllMocks());

describe("backups of an application: the list", () => {
  it.each(locales)("%s: says what a backup is, that the application stops, and how many are kept", (_n, m) => {
    const t = m.apps.backups;
    const { markup } = run({}, m);
    expect(markup).toContain(t.intro);
    expect(markup).toContain(t.stopNote);
    expect(markup).toContain(`>${t.create}</button>`);
    expect([MANUAL_BACKUPS_KEPT, APP_STACK_PRE_RESTORE_BACKUPS_KEPT]).toEqual([3, 3]);
    expect(markup).toContain(format(t.keptNote, { kept: 3, safety: 3 }));
    expect(markup).not.toMatch(/\{\w+\}/);
  });

  it.each(locales)("%s: with no backup yet there is the empty line and no list", (_n, m) => {
    const { markup } = run({ backups: list() }, m);
    expect(markup).toContain(m.apps.backups.none);
    expect(markup).not.toContain("<ul");
    expect(markup).not.toContain(`>${m.apps.backups.restore}</button>`);
    expect(markup).toContain(`>${m.apps.backups.create}</button>`);
  });

  it.each(locales)("%s: a row has its date in a time element, how it was made, a status word and its size", (_n, m) => {
    const t = m.apps.backups;
    const { markup } = run({}, m);
    expect(markup).toMatch(new RegExp(`<time datetime="${NOW}">`, "i"));
    expect(markup).toContain(`>${dateOf(m, NOW)}</time>`);
    expect(markup).toContain(t.kind.manual);
    expect(markup).toContain(`>${t.status.succeeded}<`);
    expect(markup).toContain(formatSize(5 * MIB, m === en ? "en" : "it"));
    expect(markup).not.toContain(t.none);
    expect(count(markup, "<li")).toBe(1);
  });

  it.each(locales)("%s: a row is in the order the server gave, one per backup", (_n, m) => {
    const { markup } = run({ backups: list(RUNNING, GOOD, PARTIAL, FAILED) }, m);
    expect(count(markup, "<li")).toBe(4);
    const at = [RUNNING, GOOD, PARTIAL, FAILED].map((b) => markup.search(new RegExp(`<time datetime="${b.startedAt}"`, "i")));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const s of APP_STACK_BACKUP_STATUSES) expect(markup, s).toContain(`>${m.apps.backups.status[s]}<`);
    expect(markup).toContain(m.apps.backups.kind.pre_restore);
  });

  it.each(locales)("%s: only a backup that can be restored has the button, named with its date", (_n, m) => {
    const t = m.apps.backups;
    const { out, markup } = run({ backups: list(RUNNING, GOOD, FAILED) }, m);
    expect(count(markup, `>${t.restore}</button>`)).toBe(1);
    expect(markup).toContain(`aria-label="${format(t.restoreNamed, { date: dateOf(m, NOW) })}"`);
    expect(buttons(out, t.restore)).toHaveLength(1);
    expect(buttons(out, t.restore)[0]!.props.disabled).toBe(false);
  });

  it.each(locales)("%s: with more than one copy it says how many succeeded; with one it says nothing", (_n, m) => {
    const t = m.apps.backups;
    expect(run({ backups: list(PARTIAL) }, m).markup).toContain(format(t.copies, { good: 1, total: 2 }));
    const one = run({ backups: list(GOOD) }, m).markup;
    expect(one).not.toContain(format(t.copies, { good: 1, total: 1 }));
  });

  it.each(locales)("%s: a failed backup says why; a partial one says a copy failed, why, and that it can be restored", (_n, m) => {
    const t = m.apps.backups;
    const failed = run({ backups: list(FAILED) }, m).markup;
    expect(failed).toContain(t.problem.timeout);
    expect(failed).not.toContain(t.partialNote);
    const partial = run({ backups: list(PARTIAL) }, m).markup;
    expect(partial).toContain(t.partialNote);
    expect(partial).toContain(m.site.backups.problem.unreachable);
    expect(partial).toContain(`>${t.restore}</button>`);
    const good = run({}, m).markup;
    for (const text of [t.partialNote, t.problem.other, t.problem.timeout]) expect(good).not.toContain(text);
  });

  it.each(locales)("%s: a problem the page has no sentence for reads as the generic one, never as its code", (_n, m) => {
    const markup = run({ backups: list(backup({ status: "failed", problem: "database_dump_failed", restorable: false })) }, m).markup;
    expect(markup).toContain(m.apps.backups.problem.other);
    expect(markup).not.toContain("database_dump_failed");
    expect(markup).not.toContain(m.site.backups.problem.database_dump_failed);
  });

  it.each(locales)("%s: a restore from a backup shows on its row: in progress, done, or failed with the reason", (_n, m) => {
    const t = m.apps.backups;
    const note = t.restoreFailedNote.slice(0, t.restoreFailedNote.indexOf("{"));
    const going = run({ backups: list(backup({ restore: { status: "running", problem: null, at: null } })) }, m).markup;
    expect(going).toContain(t.lastRestore.running);
    expect(going).not.toContain(note);
    const done = run({ backups: list(backup({ restore: { status: "succeeded", problem: null, at: "2026-11-22T12:00:00.000Z" } })) }, m).markup;
    expect(done).toContain(t.lastRestore.succeeded);
    expect(done).toContain(`>${dateOf(m, "2026-11-22T12:00:00.000Z")}</time>`);
    expect(done).not.toContain(note);
    // The server names no backup to go back to: the restore did not leave the data half written.
    const bad = run({ backups: list(backup({ restore: { status: "failed", problem: "no_space", at: NOW } })) }, m).markup;
    expect(bad).toContain(t.lastRestore.failed);
    expect(bad).toContain(t.problem.no_space);
    expect(bad).not.toContain(note);
    const gone = run({ backups: list(backup({ restore: { status: "failed", problem: "backup_copy_missing", at: NOW } })) }, m).markup;
    expect(gone).toContain(m.site.backups.problem.backup_copy_missing);
  });

  it.each(locales)("%s: after a restore left the data half written it names the backup to restore by its date, and marks copies of incomplete data", (_n, m) => {
    const t = m.apps.backups;
    const original = backup({ id: "sbak_dddddddddddddddddddddddd", kind: "pre_restore", startedAt: "2026-11-21T09:15:00.000Z" });
    const broken = backup({ id: "sbak_eeeeeeeeeeeeeeeeeeeeeeee", kind: "pre_restore", startedAt: "2026-11-22T11:00:00.000Z", incompleteData: true });
    const source = backup({ restore: { status: "failed", problem: "no_space", at: NOW } });
    const named = format(t.restoreFailedNote, { date: dateOf(m, original.startedAt) });
    const { markup } = run({ backups: { ...list(broken, source, original), goBackTo: original.id } }, m);
    expect(count(markup, named)).toBe(1);
    expect(markup).not.toMatch(/\{\w+\}/);
    // The mark is on the row of the copy of incomplete data, before the next row.
    expect(count(markup, t.incompleteNote)).toBe(1);
    const mark = markup.indexOf(t.incompleteNote);
    const row = (b: AppStackBackupDto) => markup.search(new RegExp(`<time datetime="${b.startedAt}"`, "i"));
    expect(row(broken)).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(row(broken));
    expect(mark).toBeLessThan(row(source));
    const plain = run({ backups: list(broken, source, original) }, m).markup;
    expect(plain).not.toContain(t.restoreFailedNote.slice(0, t.restoreFailedNote.indexOf("{")));
  });

  it.each(locales)("%s: a backup made by hand from incomplete data carries the same mark as a safety backup", (_n, m) => {
    const t = m.apps.backups;
    const manual = backup({ incompleteData: true });
    const markup = run({ backups: list(manual, PARTIAL) }, m).markup;
    expect(count(markup, t.incompleteNote)).toBe(1);
    expect(markup.indexOf(t.incompleteNote)).toBeLessThan(markup.search(new RegExp(`<time datetime="${PARTIAL.startedAt}"`, "i")));
  });

  it.each(locales)("%s: never an identifier, an address of the panel or where the copies are kept", (_n, m) => {
    const markup = run({ backups: list(RUNNING, GOOD, PARTIAL, FAILED) }, m, { 1: GOOD.id }).markup;
    expect(markup).not.toMatch(/sbak_|stk_a1|org_a1|\/api\/|\/backups|notes"|s3:|restic/i);
    expect(markup).not.toContain("href=");
  });

  it("a backup refused as busy says that other backups were running on the server", () => {
    expect(en.apps.backups.problem.site_busy).toBe("Other backups were running on the server. Try again in a few minutes.");
    expect(itMsgs.apps.backups.problem.site_busy).toBe("Sul server erano in corso altri backup. Riprova tra qualche minuto.");
  });

  it("every status has a badge tone", () => {
    expect(Object.keys(APP_STACK_BACKUP_STATUS_TONE)).toEqual([...APP_STACK_BACKUP_STATUSES]);
    for (const tone of Object.values(APP_STACK_BACKUP_STATUS_TONE)) expect(TONES).toContain(tone);
    expect(APP_STACK_BACKUP_STATUS_TONE.failed).toBe("destructive");
    expect(APP_STACK_BACKUP_STATUS_TONE.succeeded).toBe("success");
  });
});

describe("backups of an application: when one cannot be asked", () => {
  it.each(locales)("%s: a list that could not be read is the section's error line and nothing else", (_n, m) => {
    const { out, markup } = run({ backups: null }, m);
    expect(markup).toContain(m.apps.detail.sectionError);
    expect(markup).not.toContain("<button");
    expect(els(out)).toHaveLength(1);
  });

  it.each(locales.flatMap(([n, m]) => APP_STACK_BACKUP_UNAVAILABLE_REASONS.map((r) => [n, r, m] as const)))(
    "%s: %s with nothing kept is one sentence, with no button",
    (_n, reason, m) => {
      const { out, markup } = run({ backups: { backups: [], unavailableReason: reason, goBackTo: null } }, m);
      expect(count(markup, m.apps.backups.unavailable[reason])).toBe(1);
      expect(markup).not.toContain("<button");
      expect(markup).not.toContain(m.apps.backups.intro);
      expect(els(out)).toHaveLength(1);
    },
  );

  it.each(locales)("%s: backups kept from before stay in the list, but none can be made or restored, and it says why", (_n, m) => {
    const t = m.apps.backups;
    const { out, markup } = run({ backups: { backups: [GOOD], unavailableReason: "no_destination", goBackTo: null } }, m);
    expect(count(markup, "<li")).toBe(1);
    const create = buttons(out, t.create)[0]!;
    expect(create.props.disabled).toBe(true);
    expect(create.props["aria-describedby"]).toBe("app-backup-block");
    expect(textOf(byId(out, "app-backup-block"))).toBe(t.unavailable.no_destination);
    expect(buttons(out, t.restore)[0]!.props.disabled).toBe(true);
    expect(markup).toMatch(/<button[^>]*disabled[^>]*aria-describedby="app-backup-block"|<button[^>]*aria-describedby="app-backup-block"[^>]*disabled/);
  });

  it.each(locales)("%s: the buttons follow what the detail lists for the stored status, and a refusing status is said in words", (_n, m) => {
    const t = m.apps.backups;
    const free: AppStackStatus[] = [];
    for (const status of APP_STACK_STATUSES) {
      const { out } = run({ status, actions: appStackAllowedActions(status, false, () => true) }, m);
      const create = buttons(out, t.create)[0]!;
      if (!appStackAllowedActions(status, false, () => true).includes("stack.backup")) {
        expect(create.props.disabled, status).toBe(true);
        expect(create.props["aria-describedby"], status).toBe("app-backup-block");
        expect(textOf(byId(out, "app-backup-block")), status).toBe(format(m.apps.reasons.status, { status: m.apps.status[status] }));
        expect(buttons(out, t.restore)[0]!.props.disabled, status).toBe(true);
      } else {
        free.push(status);
        expect(create.props.disabled, status).toBe(false);
        expect(create.props["aria-describedby"], status).toBeUndefined();
        expect(byId(out, "app-backup-block"), status).toBeUndefined();
        expect(buttons(out, t.restore)[0]!.props.disabled, status).toBe(false);
      }
    }
    expect([...free].sort()).toEqual(["degraded", "failed", "running", "stopped"]);
  });

  it.each(locales)("%s: issue #106: a stale reading shows unknown while the stored status takes a backup: both are offered", (_n, m) => {
    const t = m.apps.backups;
    const { out } = run({ status: "unknown", stale: true, actions: OFFERED }, m);
    expect(buttons(out, t.create)[0]!.props.disabled).toBe(false);
    expect(byId(out, "app-backup-block")).toBeUndefined();
    expect(buttons(out, t.restore)[0]!.props.disabled).toBe(false);
  });

  it.each(locales)("%s: issue #106: while an operation holds a running application neither is offered, and the line says it is busy", (_n, m) => {
    const t = m.apps.backups;
    const { out, markup } = run({ status: "running", busy: true, actions: [] }, m);
    const create = buttons(out, t.create)[0]!;
    expect(create.props.disabled).toBe(true);
    expect(create.props["aria-describedby"]).toBe("app-backup-block");
    expect(textOf(byId(out, "app-backup-block"))).toBe(t.busy);
    expect(buttons(out, t.restore)[0]!.props.disabled).toBe(true);
    // Never a status the application is not in.
    expect(markup).not.toContain(format(m.apps.reasons.status, { status: m.apps.status.running }));
  });

  it.each(locales)("%s: the line names only what is true: the busy application, the stored status, else the caller's access", (_n, m) => {
    const t = m.apps.backups;
    const offer = (over: Partial<Parameters<typeof appStackBackupBlock>[3]> = {}) => ({ actions: OFFERED, busy: false, status: "running" as AppStackStatus, stale: false, ...over });
    const said = (status: AppStackStatus) => format(m.apps.reasons.status, { status: m.apps.status[status] });
    // The server's reason comes first: the backups list knows it.
    const noData: AppStackBackupsDto = { backups: [GOOD], unavailableReason: "no_data", goBackTo: null };
    expect(appStackBackupBlock(m, noData, "stack.backup", offer({ actions: [], status: "deploying" }))).toBe(t.unavailable.no_data);
    expect(appStackBackupBlock(m, list(GOOD), "stack.backup", offer())).toBeNull();
    expect(appStackBackupBlock(m, list(), "stack.restore", offer({ status: "stopped" }))).toBeNull();
    // Each kind follows its own entry of the list.
    expect(appStackBackupBlock(m, list(GOOD), "stack.backup", offer({ actions: ["stack.restore"] }))).not.toBeNull();
    expect(appStackBackupBlock(m, list(GOOD), "stack.restore", offer({ actions: ["stack.backup"] }))).not.toBeNull();
    // An operation in flight: busy, whatever the status shown.
    for (const status of ["running", "stopped", "failed", "unknown"] as const) {
      expect(appStackBackupBlock(m, list(GOOD), "stack.backup", offer({ actions: [], busy: true, status })), status).toBe(t.busy);
    }
    // A status that refuses is the stored one, unless the shown unknown is a stale reading.
    expect(appStackBackupBlock(m, list(GOOD), "stack.backup", offer({ actions: [], status: "deploying" }))).toBe(said("deploying"));
    expect(appStackBackupBlock(m, list(GOOD), "stack.backup", offer({ actions: [], status: "unknown" }))).toBe(said("unknown"));
    // Else the caller may not: a reader, an editor without app.control, a suspended organisation.
    for (const [status, stale] of [["running", false], ["stopped", false], ["failed", false], ["unknown", true]] as const) {
      expect(appStackBackupBlock(m, list(GOOD), "stack.backup", offer({ actions: [], status, stale })), status).toBe(t.notAllowed);
    }
  });
});

describe("backups of an application: creating one", () => {
  it("the button opens the dialog with nothing left from before", () => {
    const { out, sets, markup } = run({}, en, { 2: "old", 4: "old error" });
    expect(markup).not.toContain(en.apps.backups.createTitle);
    (buttons(out, en.apps.backups.create)[0]!.props.onClick as () => void)();
    expect(sets).toEqual([
      [2, ""],
      [4, null],
      [0, true],
      [1, null],
    ]);
    expect(keyedSend).not.toHaveBeenCalled();
  });

  it.each(locales)("%s: the dialog says the application stops and starts again, with a way out", (_n, m) => {
    const t = m.apps.backups;
    const { markup } = run({}, m, { 0: true });
    expect(markup).toContain(`<h2>${t.createTitle}</h2>`);
    expect(markup).toContain(t.createBody);
    expect(markup).toMatch(new RegExp(`<button[^>]*type="submit"[^>]*>${t.createConfirm}</button>`));
    expect(markup).toMatch(new RegExp(`<button[^>]*type="button"[^>]*>${m.apps.actions.cancel}</button>`));
    expect(markup).not.toContain(t.restoreTitle);
    expect(markup).not.toContain('role="alert"');
  });

  it("confirming sends an empty body under its own key, then closes and reads the page again", async () => {
    keyedSend.mockResolvedValue({ ok: true, data: { data: { operationId: "op_9" } } });
    const { out, sets } = run({}, en, { 0: true });
    await submit(forms(out)[0]);
    expect(keyedSend).toHaveBeenCalledTimes(1);
    expect(keyedSend).toHaveBeenCalledWith(expect.any(Object), "csrf", "create", "POST", BASE, {});
    expect(sets).toEqual([
      [3, true],
      [4, null],
      [3, false],
      [0, false],
      [1, null],
    ]);
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(router.push).not.toHaveBeenCalled();
  });

  it.each(
    locales.flatMap(([n, m]) =>
      (
        [
          ["QUOTA_EXCEEDED", "too_many_requests", m.apps.reasons.too_many_requests],
          ["VALIDATION_ERROR", "no_data", m.apps.reasons.no_data],
          ["VALIDATION_ERROR", "no_destination", m.apps.reasons.no_destination],
          ["RESOURCE_LOCKED", "deploying", format(m.apps.reasons.status, { status: m.apps.status.deploying })],
          ["NOT_SUPPORTED", undefined, m.apps.codes.NOT_SUPPORTED],
          ["NOT_FOUND", undefined, m.apps.codes.NOT_FOUND],
          ["", undefined, m.errors.generic],
        ] as const
      ).map(([code, reason, text]) => [n, code || "a lost reply", reason ?? "-", { m, code, reason, text }] as const),
    ),
  )("%s: refused with %s (%s) → the dialog stays open and says why", async (_n, _c, _r, { m, code, reason, text }) => {
    keyedSend.mockResolvedValue({ ok: false, code, reason });
    const { out, sets } = run({}, m, { 0: true });
    await submit(forms(out)[0]);
    expect(sets).toEqual([
      [3, true],
      [4, null],
      [3, false],
      [4, text],
    ]);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it.each(locales)("%s: the reason of a refusal is an alert inside the dialog", (_n, m) => {
    const text = m.apps.reasons.too_many_requests;
    const { markup } = run({}, m, { 0: true, 4: text });
    expect(count(markup, 'role="alert"')).toBe(1);
    expect(markup).toContain(text);
    expect(run({}, m, { 4: text }).markup).not.toContain('role="alert"');
  });

  it.each(locales)("%s: while it is being sent nothing can be sent again or closed", async (_n, m) => {
    const t = m.apps.backups;
    const { out, sets, markup } = run({}, m, { 0: true, 3: true });
    expect(markup).toMatch(new RegExp(`<button[^>]*type="submit"[^>]*disabled[^>]*>${t.starting}</button>`));
    expect(markup).not.toContain(`>${t.createConfirm}</button>`);
    await submit(forms(out)[0]);
    expect(keyedSend).not.toHaveBeenCalled();
    const cancel = buttons(out, m.apps.actions.cancel)[0]!;
    expect(cancel.props.disabled).toBe(true);
    (cancel.props.onClick as () => void)();
    for (const d of els(out).filter((e) => e.type === Dialog)) (d.props.onOpenChange as (o: boolean) => void)(false);
    expect(sets).toEqual([]);
  });

  it("closing the dialog closes both and sends nothing", () => {
    const { out, sets } = run({}, en, { 0: true });
    const dialogs = els(out).filter((e) => e.type === Dialog);
    expect(dialogs.map((d) => d.props.open)).toEqual([true, false]);
    (dialogs[0]!.props.onOpenChange as (o: boolean) => void)(true);
    expect(sets).toEqual([]);
    (dialogs[0]!.props.onOpenChange as (o: boolean) => void)(false);
    expect(sets).toEqual([
      [0, false],
      [1, null],
    ]);
    expect(keyedSend).not.toHaveBeenCalled();
  });
});

describe("backups of an application: restoring one", () => {
  it("the button of a row opens the dialog of that backup with nothing typed", () => {
    const { out, sets, markup } = run({ backups: list(GOOD, PARTIAL) }, en, { 2: NAME, 4: "old error" });
    expect(markup).not.toContain(en.apps.backups.restoreTitle);
    (buttons(out, en.apps.backups.restore)[1]!.props.onClick as () => void)();
    expect(sets).toEqual([
      [2, ""],
      [4, null],
      [0, false],
      [1, PARTIAL.id],
    ]);
  });

  it.each(locales)("%s: the dialog says what is replaced, from which date, and asks for the application's name", (_n, m) => {
    const t = m.apps.backups;
    const { out, markup } = run({ backups: list(GOOD, PARTIAL) }, m, { 1: PARTIAL.id });
    expect(markup).toContain(`<h2>${t.restoreTitle}</h2>`);
    expect(markup).toContain(format(t.restoreBody, { date: dateOf(m, PARTIAL.startedAt) }));
    expect(markup).not.toContain(format(t.restoreBody, { date: dateOf(m, GOOD.startedAt) }));
    expect(markup).toContain(t.restoreFailNote);
    expect(markup).toMatch(new RegExp(`<label[^>]*for="app-restore-name"[^>]*>${format(t.typeName, { name: NAME })}</label>`));
    expect(markup).toMatch(/<input[^>]*id="app-restore-name"/);
    expect(byId(out, "app-restore-name")!.props.autoComplete).toBe("off");
    expect(markup).toMatch(new RegExp(`<button[^>]*type="submit"[^>]*disabled[^>]*>${t.restoreConfirm}</button>`));
    expect(markup).not.toContain(t.createTitle);
    expect(markup).not.toMatch(/\{\w+\}/);
  });

  it("the Italian label names the application", () => {
    expect(run({}, itMsgs, { 1: GOOD.id }).markup).toContain("Scrivi team-notes per confermare");
  });

  it("the name must be typed exactly, and nothing is confirmed while it is being sent", () => {
    for (const [typed, busy, can] of [
      [NAME, false, true],
      [NAME, true, false],
      ["", false, false],
      ["Team-Notes", false, false],
      [`${NAME} `, false, false],
      [` ${NAME}`, false, false],
      ["team-note", false, false],
    ] as const)
      expect(canConfirmRestore(typed, NAME, busy), `${typed}|${busy}`).toBe(can);
    const confirm = (state: Record<number, unknown>) => buttons(run({}, en, state).out, en.apps.backups.restoreConfirm)[0]!.props.disabled;
    expect(confirm({ 1: GOOD.id, 2: NAME })).toBe(false);
    expect(confirm({ 1: GOOD.id, 2: "Team-Notes" })).toBe(true);
    expect(confirm({ 1: GOOD.id, 2: "" })).toBe(true);
  });

  it("typing goes to its own state and sends nothing", () => {
    const { out, sets } = run({}, en, { 1: GOOD.id });
    (byId(out, "app-restore-name")!.props.onChange as (e: unknown) => void)({ target: { value: "team" } });
    expect(sets).toEqual([[2, "team"]]);
    expect(keyedSend).not.toHaveBeenCalled();
  });

  it("with the wrong name the form sends nothing", async () => {
    for (const typed of ["", "Team-Notes", `${NAME} `]) {
      const { out, sets } = run({}, en, { 1: GOOD.id, 2: typed });
      await submit(forms(out)[1]);
      expect(sets).toEqual([]);
    }
    expect(keyedSend).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("with the name it sends it to the restore of that backup under that backup's key, then closes and reads the page again", async () => {
    keyedSend.mockResolvedValue({ ok: true, data: { data: { operationId: "op_9" } } });
    const { out, sets } = run({ backups: list(GOOD, PARTIAL) }, en, { 1: PARTIAL.id, 2: NAME });
    await submit(forms(out)[1]);
    expect(keyedSend).toHaveBeenCalledTimes(1);
    expect(keyedSend).toHaveBeenCalledWith(expect.any(Object), "csrf", `restore:${PARTIAL.id}`, "POST", `${BASE}/${PARTIAL.id}/restore`, {
      confirmName: NAME,
    });
    expect(sets).toEqual([
      [3, true],
      [4, null],
      [3, false],
      [0, false],
      [1, null],
    ]);
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it.each(
    locales.flatMap(([n, m]) =>
      (
        [
          ["VALIDATION_ERROR", "not_restorable", m.apps.reasons.not_restorable],
          ["VALIDATION_ERROR", "confirmation_mismatch", m.apps.reasons.confirmation_mismatch],
          ["VALIDATION_ERROR", "no_destination", m.apps.reasons.no_destination],
          ["QUOTA_EXCEEDED", "too_many_requests", m.apps.reasons.too_many_requests],
          ["RESOURCE_LOCKED", "updating", format(m.apps.reasons.status, { status: m.apps.status.updating })],
          ["NOT_FOUND", undefined, m.apps.codes.NOT_FOUND],
        ] as const
      ).map(([code, reason, text]) => [n, code, reason ?? "-", { m, code, reason, text }] as const),
    ),
  )("%s: refused with %s (%s) → the dialog stays open and says why", async (_n, _c, _r, { m, code, reason, text }) => {
    keyedSend.mockResolvedValue({ ok: false, code, reason });
    const { out, sets } = run({}, m, { 1: GOOD.id, 2: NAME });
    await submit(forms(out)[1]);
    expect(sets).toEqual([
      [3, true],
      [4, null],
      [3, false],
      [4, text],
    ]);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it.each(locales)("%s: while it is being sent the name cannot be changed, and nothing can be sent again or closed", async (_n, m) => {
    const t = m.apps.backups;
    const { out, sets, markup } = run({}, m, { 1: GOOD.id, 2: NAME, 3: true });
    expect(byId(out, "app-restore-name")!.props.readOnly).toBe(true);
    expect(markup).toMatch(new RegExp(`<button[^>]*type="submit"[^>]*disabled[^>]*>${t.starting}</button>`));
    await submit(forms(out)[1]);
    expect(keyedSend).not.toHaveBeenCalled();
    for (const d of els(out).filter((e) => e.type === Dialog)) (d.props.onOpenChange as (o: boolean) => void)(false);
    expect(sets).toEqual([]);
  });

  it("a backup that is no longer in the list opens nothing", () => {
    const { out, markup } = run({}, en, { 1: "sbak_ffffffffffffffffffffffff", 2: NAME });
    expect(markup).not.toContain(en.apps.backups.restoreTitle);
    expect(forms(out)).toHaveLength(1);
    expect(els(out).filter((e) => e.type === Dialog).map((d) => d.props.open)).toEqual([false, false]);
  });

  it("each backup has a key of its own, and creating has another", async () => {
    keyedSend.mockResolvedValue({ ok: true, data: {} });
    await submit(forms(run({}, en, { 0: true }).out)[0]);
    await submit(forms(run({ backups: list(GOOD, PARTIAL) }, en, { 1: GOOD.id, 2: NAME }).out)[1]);
    await submit(forms(run({ backups: list(GOOD, PARTIAL) }, en, { 1: PARTIAL.id, 2: NAME }).out)[1]);
    const names = keyedSend.mock.calls.map(([, , name]) => name);
    expect(names).toEqual(["create", `restore:${GOOD.id}`, `restore:${PARTIAL.id}`]);
    expect(new Set(names).size).toBe(3);
  });
});
