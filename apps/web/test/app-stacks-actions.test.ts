import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_STACK_STATUSES,
  appStackEnqueueTarget,
  type AppStackPlanDiffDto,
  type AppStackStatus,
  type OperationDto,
} from "@hosting-panel/contracts";

const keyedSend = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/keyed-send", () => ({ keyedSend: (...a: unknown[]) => keyedSend(...a) }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/apps/stk_a1" }));
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
import { appStackRefusalText } from "@/components/app-stacks/app-stack-view";
import {
  APP_STACK_POLL_LIMIT,
  APP_STACK_POLL_MS,
  AppStackProgress,
  useOperationPoll,
} from "@/components/app-stacks/app-stack-progress";
import { AppStackActions, stackActionEnabled } from "@/components/app-stacks/app-stack-actions";
import { AppStackDelete, canConfirmDelete } from "@/components/app-stacks/app-stack-delete";

const NOW = "2026-11-22T10:00:00.000Z";
const ORG = "org_a1";
const BASE = "/api/bff/orgs/org_a1/app-stacks/stk_a1";
const locales = [
  ["en", en],
  ["it", itMsgs],
] as const;

const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
type Effect = () => void | (() => void);
/** Calls a component (or hook) once with stand-in hooks; `state` overrides the initial value of a useState slot, `refs` keeps useRef slots across calls. */
function callHooks<P, R>(C: (p: P) => R, props: P, m: Messages = en, state: Record<number, unknown> = {}, refs: Array<{ current: unknown }> = []) {
  let s = 0;
  let r = 0;
  const sets: Array<[number, unknown]> = [];
  const effects: Effect[] = [];
  const ctx = { locale: m === en ? "en" : "it", messages: m };
  const prev = internals.H;
  internals.H = {
    useState: (v: unknown) => {
      const k = s++;
      return [k in state ? state[k] : v, (x: unknown) => void sets.push([k, x])];
    },
    useRef: (v: unknown) => (refs[r++] ??= { current: v }),
    useEffect: (f: Effect) => void effects.push(f),
    useContext: () => ctx,
  };
  try {
    return { out: C(props), sets, effects };
  } finally {
    internals.H = prev;
  }
}
type El = ReactElement<Record<string, unknown>>;
/** Elements of a tree; a closed dialog hides its content. */
const els = (node: unknown): El[] => {
  if (Array.isArray(node)) return node.flatMap(els);
  if (!isValidElement(node)) return [];
  const e = node as El;
  if (e.type === Dialog && !e.props.open) return [e];
  return [e, ...els(e.props.children)];
};
const textOf = (node: unknown): string =>
  typeof node === "string" || typeof node === "number"
    ? String(node)
    : Array.isArray(node)
      ? node.map(textOf).join("")
      : isValidElement(node)
        ? textOf((node.props as Record<string, unknown>).children)
        : "";
const button = (tree: unknown, text: string) => els(tree).find((e) => e.type === Button && textOf(e) === text);
const click = (e: El | undefined) => (e!.props.onClick as () => Promise<void> | void)();
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const wrap = (m: Messages, child: ReactElement) =>
  decode(renderToStaticMarkup(createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: child })));
const html = (tree: ReactNode) => decode(renderToStaticMarkup(createElement(React.Fragment, null, tree)));
const respond = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const accepted = { ok: true, data: { data: { stackId: "stk_a1", operationId: "op_9", deploymentId: "dep_9", status: "queued" } } };

const UPGRADE = { templateVersionId: "atv_notes_3", versionNumber: 3 };
const ROLLBACK = { revisionId: "srev_a1", revisionNumber: 1, templateVersionNumber: 1 };
const actionProps = (status: AppStackStatus, over: Record<string, unknown> = {}) => ({
  orgId: ORG,
  stackId: "stk_a1",
  csrfToken: "csrf",
  status,
  upgrade: UPGRADE,
  rollback: ROLLBACK,
  ...over,
});
const DIFF: AppStackPlanDiffDto = {
  planHash: `sha256:${"a".repeat(64)}`,
  fromRevisionId: "srev_a2",
  fromVersionNumber: 2,
  toTemplateVersionId: "atv_notes_3",
  toVersionNumber: 3,
  newRevision: true,
  components: [
    { key: "web", change: "updated", restart: true },
    { key: "cache", change: "added", restart: false },
  ],
  volumes: [
    { key: "notes", change: "unchanged" },
    { key: "uploads", change: "removed" },
  ],
  parameters: [{ key: "title", change: "updated" }],
  newSecrets: [],
  ingress: [{ componentKey: "web", port: 8080, change: "unchanged" }],
  downtime: true,
  dataRisk: true,
};

beforeEach(() => {
  keyedSend.mockReset();
  router.push.mockReset();
  router.refresh.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("stackActionEnabled", () => {
  const actions = ["start", "stop", "restart", "deploy", "upgrade", "rollback"] as const;

  it("follows appStackEnqueueTarget over all 14 statuses × 6 actions", () => {
    expect(APP_STACK_STATUSES).toHaveLength(14);
    for (const status of APP_STACK_STATUSES)
      for (const a of actions) expect(stackActionEnabled(a, status), `${a} ${status}`).toBe(appStackEnqueueTarget(`stack.${a}`, status) !== null);
  });

  it("renders each of the six buttons enabled exactly when the action may be queued", () => {
    const labels = (status: AppStackStatus) => ({
      start: en.apps.actions.start,
      stop: en.apps.actions.stop,
      restart: en.apps.actions.restart,
      deploy: status === "draft" ? en.apps.actions.install : en.apps.actions.reinstall,
      upgrade: format(en.apps.upgrade.open, { n: 3 }),
      rollback: format(en.apps.rollback.open, { n: 1 }),
    });
    for (const status of APP_STACK_STATUSES) {
      const { out } = callHooks(AppStackActions, actionProps(status));
      for (const [a, label] of Object.entries(labels(status))) {
        const b = button(out, label);
        expect(b, `${a} ${status}`).toBeDefined();
        expect(b!.props.disabled, `${a} ${status}`).toBe(appStackEnqueueTarget(`stack.${a}` as never, status) === null);
      }
    }
  });

  it("offers no upgrade or rollback without a target", () => {
    const { out } = callHooks(AppStackActions, actionProps("running", { upgrade: null, rollback: null }));
    expect(els(out).filter((e) => e.type === Button).map(textOf)).toEqual([
      en.apps.actions.start,
      en.apps.actions.stop,
      en.apps.actions.restart,
      en.apps.actions.reinstall,
    ]);
  });
});

describe("AppStackActions requests", () => {
  it("start, restart and (re)install send {} with a key and refresh on an accepted 202", async () => {
    keyedSend.mockResolvedValue(accepted);
    for (const [status, label, action] of [
      ["stopped", en.apps.actions.start, "start"],
      ["running", en.apps.actions.restart, "restart"],
      ["draft", en.apps.actions.install, "deploy"],
      ["failed", en.apps.actions.reinstall, "deploy"],
    ] as const) {
      keyedSend.mockClear();
      router.refresh.mockClear();
      const { out, sets } = callHooks(AppStackActions, actionProps(status));
      await click(button(out, label));
      expect(keyedSend).toHaveBeenCalledWith(expect.any(Object), "csrf", `${action}:${status}`, "POST", `${BASE}/${action}`, {});
      expect(sets).toContainEqual([1, en.apps.actions.accepted]);
      expect(router.refresh).toHaveBeenCalledTimes(1);
    }
  });

  it("one change at a time: a second click while a request is out sends nothing", async () => {
    let release!: (v: unknown) => void;
    keyedSend.mockReturnValue(new Promise((r) => (release = r)));
    const { out } = callHooks(AppStackActions, actionProps("running"));
    const first = click(button(out, en.apps.actions.restart));
    void click(button(out, en.apps.actions.reinstall));
    expect(keyedSend).toHaveBeenCalledTimes(1);
    release(accepted);
    await first;
  });

  it.each(locales)("a refusal reads as its sentence, a status refusal names the status, no refresh (%s)", async (_l, m) => {
    keyedSend.mockResolvedValue({ ok: false, code: "RESOURCE_LOCKED", reason: "stopped" });
    const { out, sets } = callHooks(AppStackActions, actionProps("running"), m);
    await click(button(out, m.apps.actions.restart));
    const text = appStackRefusalText(m, "RESOURCE_LOCKED", "stopped");
    expect(text).toBe(format(m.apps.reasons.status, { status: m.apps.status.stopped }));
    expect(sets).toContainEqual([2, text]);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it.each(locales)("installing a draft whose version left the catalog says to remove the draft and install again (%s)", async (_l, m) => {
    keyedSend.mockResolvedValue({ ok: false, code: "VALIDATION_ERROR", reason: "STACK_TEMPLATE_UNPUBLISHED" });
    const { out, sets } = callHooks(AppStackActions, actionProps("draft"), m);
    await click(button(out, m.apps.actions.install));
    expect(sets).toContainEqual([2, m.apps.reasons.draftUnpublished]);
    expect(m.apps.reasons.draftUnpublished).not.toBe(m.apps.reasons.STACK_TEMPLATE_UNPUBLISHED);
  });

  it("a kept key serves only a retry from the same status: stop (reply lost) → start → stop sends a new key", async () => {
    let lost = true;
    const used: string[] = [];
    keyedSend.mockImplementation(async (keys: Record<string, string>, _csrf: string, name: string) => {
      used.push((keys[name] ??= `key-${used.length}`));
      if (lost) return { ok: false, code: "" };
      delete keys[name];
      return accepted;
    });
    const refs: Array<{ current: unknown }> = [];
    let shown: AppStackStatus | null = null;
    // Each render with a new status runs the effects, as React does for a changed dependency.
    const render = (status: AppStackStatus, state: Record<number, unknown> = {}) => {
      const r = callHooks(AppStackActions, actionProps(status), en, state, refs);
      if (status !== shown) for (const f of r.effects) f();
      shown = status;
      return r.out;
    };
    const stop = async () => {
      const dialog = els(render("running", { 3: true })).find((e) => e.type === Dialog && e.props.open)!;
      await click(els(dialog).find((e) => e.type === Button && textOf(e) === en.apps.actions.stopConfirm));
    };
    await stop();
    await stop(); // a true retry
    expect(used[1]).toBe(used[0]);
    lost = false;
    await click(button(render("stopped"), en.apps.actions.start));
    await stop();
    expect(new Set(used).size).toBe(3);
    expect(used[3]).not.toBe(used[0]);
  });

  it("a 2xx without an operation id is not reported as accepted", async () => {
    keyedSend.mockResolvedValue({ ok: true, data: { data: {} } });
    const { out, sets } = callHooks(AppStackActions, actionProps("running"));
    await click(button(out, en.apps.actions.restart));
    expect(sets).not.toContainEqual([1, en.apps.actions.accepted]);
    expect(sets).toContainEqual([2, en.errors.generic]);
  });

  it.each(locales)("stop asks first, names the action and says the addresses go offline (%s)", async (_l, m) => {
    const closed = callHooks(AppStackActions, actionProps("running"), m);
    await click(button(closed.out, m.apps.actions.stop));
    expect(keyedSend).not.toHaveBeenCalled();
    expect(closed.sets).toEqual([[3, true]]);

    keyedSend.mockResolvedValue(accepted);
    const open = callHooks(AppStackActions, actionProps("running"), m, { 3: true });
    const markup = html(open.out);
    expect(markup).toContain(m.apps.actions.stopTitle);
    expect(markup).toContain(m.apps.actions.stopBody);
    const dialog = els(open.out).find((e) => e.type === Dialog && e.props.open)!;
    const confirm = els(dialog).find((e) => e.type === Button && textOf(e) === m.apps.actions.stopConfirm)!;
    expect(confirm.props.variant).toBe("destructive");
    await click(confirm);
    expect(keyedSend).toHaveBeenCalledWith(expect.any(Object), "csrf", "stop:running", "POST", `${BASE}/stop`, {});
    expect(open.sets).toContainEqual([3, false]);
  });

  it("a dialog refuses to close while a request is out", async () => {
    let release!: (v: unknown) => void;
    keyedSend.mockReturnValue(new Promise((r) => (release = r)));
    const { out, sets } = callHooks(AppStackActions, actionProps("running"), en, { 3: true });
    const dialog = els(out).find((e) => e.type === Dialog && e.props.open)!;
    const pending = click(els(dialog).find((e) => e.type === Button && textOf(e) === en.apps.actions.stopConfirm));
    (dialog.props.onOpenChange as (o: boolean) => void)(false);
    expect(sets).not.toContainEqual([3, false]);
    release(accepted);
    await pending;
  });

  it.each(locales)("renders the labels as words in both languages (%s)", (_l, m) => {
    const markup = wrap(m, createElement(AppStackActions, actionProps("draft")));
    for (const t of [m.apps.actions.start, m.apps.actions.stop, m.apps.actions.restart, m.apps.actions.install]) expect(markup).toContain(`>${t}<`);
    expect(markup).not.toContain(`>${m.apps.actions.reinstall}<`);
  });
});

describe("upgrade and rollback plan dialog", () => {
  const planDialog = (tree: unknown) => els(tree).find((e) => typeof e.type === "function" && e.type.name === "PlanDialog")!;
  const openDialog = (mode: "upgrade" | "rollback", m: Messages = en) => {
    const label = mode === "upgrade" ? format(m.apps.upgrade.open, { n: 3 }) : format(m.apps.rollback.open, { n: 1 });
    const closed = callHooks(AppStackActions, actionProps("running"), m);
    void click(button(closed.out, label));
    expect(closed.sets).toEqual([[4, mode]]);
    const parent = callHooks(AppStackActions, actionProps("running"), m, { 4: mode });
    return { d: planDialog(parent.out), parentSets: parent.sets };
  };
  const run = (d: El, m: Messages = en, state: Record<number, unknown> = {}) =>
    callHooks(d.type as (p: Record<string, unknown>) => ReactNode, d.props, m, state);

  for (const [mode, target] of [
    ["upgrade", { templateVersionId: "atv_notes_3" }],
    ["rollback", { revisionId: "srev_a1" }],
  ] as const) {
    it(`${mode}: opening asks the plan with ${Object.keys(target)[0]}, CSRF and no key`, async () => {
      const fetchMock = vi.fn(async () => respond(200, { data: DIFF }));
      vi.stubGlobal("fetch", fetchMock);
      const { effects, sets } = run(openDialog(mode).d);
      effects.forEach((f) => f());
      await vi.waitFor(() => expect(sets).toContainEqual([0, DIFF]));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`${BASE}/plan`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual(target);
      const headers = init.headers as Record<string, string>;
      expect(headers["X-CSRF-Token"]).toBe("csrf");
      expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("idempotency-key");
    });

    it(`${mode}: confirm sends the plan hash, closes and refreshes`, async () => {
      keyedSend.mockResolvedValue(accepted);
      const { d, parentSets } = openDialog(mode);
      const blocked = run(d, en, { 0: DIFF });
      const confirmText = mode === "upgrade" ? en.apps.upgrade.confirm : en.apps.rollback.confirm;
      expect(button(blocked.out, confirmText)!.props.disabled).toBe(true); // dataRisk not acknowledged yet
      const { out } = run(d, en, { 0: DIFF, 2: true });
      const confirm = button(out, confirmText)!;
      expect(confirm.props.disabled).toBe(false);
      await click(confirm);
      expect(keyedSend).toHaveBeenCalledWith(expect.any(Object), "csrf", `${mode}:running`, "POST", `${BASE}/${mode}`, { ...target, planHash: DIFF.planHash });
      expect(router.refresh).toHaveBeenCalledTimes(1);
      expect(parentSets).toContainEqual([1, en.apps.actions.accepted]);
      expect(parentSets).toContainEqual([4, null]);
    });
  }

  it.each(locales)("shows the changes as words, the addresses, the data warnings and the acknowledgement (%s)", (_l, m) => {
    const t = m.apps.upgrade;
    const markup = html(run(openDialog("upgrade", m).d, m, { 0: DIFF }).out);
    expect(markup).toContain(t.title);
    for (const w of [t.componentsTitle, t.dataTitle, t.settingsTitle, t.addressesTitle, t.change.updated, t.change.added, t.change.removed, t.change.unchanged, t.restarts])
      expect(markup).toContain(w);
    expect(markup).toContain("web:8080");
    expect(markup).toContain(t.downtime);
    expect(markup).toContain(t.dataRemoved);
    expect(markup).toContain(t.dataWarning);
    expect(markup).toMatch(/<input[^>]*id="app-plan-ack"/);
    expect(markup).toContain(`for="app-plan-ack"`);
    expect(markup).toContain(m.apps.rollback.ack);
    expect(markup).not.toContain(m.apps.rollback.body);
  });

  it.each(locales)("a quiet plan: no downtime, nothing removed, no acknowledgement, the data warning stays (%s)", (_l, m) => {
    const quiet = { ...DIFF, downtime: false, dataRisk: false, volumes: [{ key: "notes", change: "unchanged" as const }] };
    const { out } = run(openDialog("rollback", m).d, m, { 0: quiet });
    const markup = html(out);
    expect(markup).toContain(m.apps.rollback.title);
    expect(markup).toContain(m.apps.rollback.body);
    expect(markup).toContain(m.apps.upgrade.dataWarning);
    expect(markup).not.toContain(m.apps.upgrade.downtime);
    expect(markup).not.toContain(m.apps.upgrade.dataRemoved);
    expect(markup).not.toContain("app-plan-ack");
    expect(button(out, m.apps.rollback.confirm)!.props.disabled).toBe(false);
  });

  it("a plan refusal shows its sentence and keeps confirm disabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(400, { error: { code: "VALIDATION_ERROR", details: [{ reason: "STACK_IMAGE_NOT_ALLOWED" }] } })));
    const { d } = openDialog("upgrade");
    const { effects, sets } = run(d);
    effects.forEach((f) => f());
    await vi.waitFor(() => expect(sets).toContainEqual([1, en.apps.reasons.STACK_IMAGE_NOT_ALLOWED]));
    const { out } = run(d, en, { 1: en.apps.reasons.STACK_IMAGE_NOT_ALLOWED });
    expect(html(out)).toContain(en.apps.reasons.STACK_IMAGE_NOT_ALLOWED);
    expect(button(out, en.apps.upgrade.confirm)!.props.disabled).toBe(true);
  });

  describe("private values the new version needs (issue #89)", () => {
    const ASKING: AppStackPlanDiffDto = { ...DIFF, dataRisk: false, newSecrets: [{ key: "mail_password", label: "Mail password" }] };
    const TYPED = "typed-mail-password-9c1";
    /** The dialog's only ref holds its fields: stand-ins with a value, as the browser's inputs. */
    const fields = (value: string) => {
      const input = { value };
      return { input, refs: [{ current: new Map([["mail_password", input]]) }] };
    };
    const dialog = (d: El, state: Record<number, unknown>, refs: Array<{ current: unknown }> = []) =>
      callHooks(d.type as (p: Record<string, unknown>) => ReactNode, d.props, en, state, refs);

    it.each(locales)("an upgrade shows a field for each, with its label, the required mark and the private-value note (%s)", (_l, m) => {
      const markup = html(run(openDialog("upgrade", m).d, m, { 0: ASKING }).out);
      for (const text of [m.apps.upgrade.secretsTitle, m.apps.upgrade.secretsHint, "Mail password", m.apps.secrets.required, m.apps.wizard.secretHint])
        expect(markup).toContain(text);
      const input = markup.match(/<input[^>]*id="app-upgrade-secret-mail_password"[^>]*>/)?.[0] ?? "";
      expect(input).toContain('type="password"');
      expect(input).toContain('autoComplete="new-password"');
      expect(input).toContain('aria-describedby="app-upgrade-secret-mail_password-note"');
      expect(input).toMatch(/\brequired\b/);
      expect(input).not.toMatch(/\bvalue=/);
      expect(markup).toContain('for="app-upgrade-secret-mail_password"');
    });

    it("a rollback and a plan that needs nothing show no field", () => {
      expect(html(run(openDialog("rollback").d, en, { 0: ASKING }).out)).not.toContain("app-upgrade-secret-");
      expect(html(run(openDialog("upgrade").d, en, { 0: DIFF }).out)).not.toContain(en.apps.upgrade.secretsTitle);
    });

    it("an empty field is marked as required and nothing is sent", async () => {
      const { d } = openDialog("upgrade");
      const { out, sets } = dialog(d, { 0: ASKING }, fields("").refs);
      await click(button(out, en.apps.upgrade.confirm));
      expect(sets).toContainEqual([3, { mail_password: en.apps.wizard.required }]);
      expect(keyedSend).not.toHaveBeenCalled();
    });

    it("confirm sends the typed values with the plan hash, empties the fields and keeps no value in state", async () => {
      keyedSend.mockResolvedValue(accepted);
      const { d, parentSets } = openDialog("upgrade");
      const { input, refs } = fields(TYPED);
      const { out, sets } = dialog(d, { 0: ASKING }, refs);
      await click(button(out, en.apps.upgrade.confirm));
      expect(keyedSend).toHaveBeenCalledWith(expect.any(Object), "csrf", "upgrade:running", "POST", `${BASE}/upgrade`, {
        templateVersionId: "atv_notes_3",
        planHash: ASKING.planHash,
        secrets: [{ parameterKey: "mail_password", value: TYPED }],
      });
      expect(input.value).toBe("");
      expect(JSON.stringify([sets, parentSets])).not.toContain(TYPED);
      expect(parentSets).toContainEqual([4, null]);
    });

    it.each([
      ["value_too_long", "VALIDATION_ERROR"],
      ["STACK_SECRET_MISSING", "VALIDATION_ERROR"],
      ["secret_not_needed", "VALIDATION_ERROR"],
    ])("a refusal of a value (%s) is shown next to its field, in the open dialog, with the field emptied", async (reason, code) => {
      keyedSend.mockResolvedValue({ ok: false, code, reason, field: "secrets.mail_password" });
      const { d, parentSets } = openDialog("upgrade");
      const { input, refs } = fields(TYPED);
      const { out, sets } = dialog(d, { 0: ASKING }, refs);
      await click(button(out, en.apps.upgrade.confirm));
      const text = appStackRefusalText(en, code, reason);
      expect(sets).toContainEqual([3, { mail_password: text }]);
      expect(input.value).toBe("");
      expect(parentSets).not.toContainEqual([4, null]);
      expect(parentSets.filter(([k]) => k === 2)).toEqual([[2, null]]);
      const markup = html(dialog(d, { 0: ASKING, 3: { mail_password: text } }).out);
      expect(markup).toMatch(/<input[^>]*id="app-upgrade-secret-mail_password"[^>]*aria-invalid="true"/);
      expect(markup).toContain(text);
    });

    it.each(locales)("a value the update does not need has its own sentence (%s)", (_l, m) => {
      expect(appStackRefusalText(m, "VALIDATION_ERROR", "secret_not_needed")).toBe(m.apps.reasons.secret_not_needed);
      expect(m.apps.reasons.secret_not_needed).not.toBe(m.apps.reasons.STACK_PARAMETER_INVALID);
    });
  });

  it("plan_changed keeps the dialog open, says so and asks the plan again", async () => {
    keyedSend.mockResolvedValue({ ok: false, code: "VALIDATION_ERROR", reason: "plan_changed" });
    const fetchMock = vi.fn(async () => respond(200, { data: DIFF }));
    vi.stubGlobal("fetch", fetchMock);
    const parent = callHooks(AppStackActions, actionProps("running"), en, { 4: "upgrade" });
    const { out, sets } = run(planDialog(parent.out), en, { 0: DIFF, 2: true });
    await click(button(out, en.apps.upgrade.confirm));
    expect(sets).toContainEqual([1, en.apps.reasons.plan_changed]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(parent.sets).not.toContainEqual([4, null]);
    expect(parent.sets.filter(([k]) => k === 2)).toEqual([[2, null]]);
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("AppStackDelete", () => {
  const props = (hasData = true, status: AppStackStatus = "running") => ({ orgId: ORG, stackId: "stk_a1", csrfToken: "csrf", stackName: "team-notes", hasData, status });
  const submit = async (tree: unknown) => {
    const form = els(tree).find((e) => e.type === "form")!;
    await (form.props.onSubmit as (e: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} });
  };

  it("canConfirmDelete: exact, case-sensitive, untrimmed, never while busy", () => {
    expect(canConfirmDelete("team-notes", "team-notes", false)).toBe(true);
    for (const typed of ["", "Team-notes", " team-notes", "team-notes ", "team-note"]) expect(canConfirmDelete(typed, "team-notes", false), typed).toBe(false);
    expect(canConfirmDelete("team-notes", "team-notes", true)).toBe(false);
  });

  it.each(locales)("opens from a destructive button that names the action (%s)", (_l, m) => {
    const { out, sets } = callHooks(AppStackDelete, props(), m);
    const open = button(out, m.apps.delete.open)!;
    expect(open.props.variant).toBe("destructive");
    void click(open);
    expect(sets).toContainEqual([0, true]);
  });

  it("the delete button is enabled exactly when appStackEnqueueTarget allows a delete", () => {
    for (const status of APP_STACK_STATUSES) {
      const open = button(callHooks(AppStackDelete, props(true, status)).out, en.apps.delete.open)!;
      expect(open.props.disabled, status).toBe(appStackEnqueueTarget("stack.delete", status) === null);
    }
    expect(button(callHooks(AppStackDelete, props(true, "deleting")).out, en.apps.delete.open)!.props.disabled).toBe(true);
  });

  it.each(locales)("asks the typed name and a separate, unticked data checkbox with its keep note (%s)", (_l, m) => {
    const t = m.apps.delete;
    const { out } = callHooks(AppStackDelete, props(), m, { 0: true });
    const markup = html(out);
    expect(markup).toContain("<strong>team-notes</strong>");
    expect(markup).toContain(`for="app-delete-name"`);
    expect(markup).toContain(format(t.typeName, { name: "team-notes" }));
    expect(markup.match(/<input[^>]*id="app-delete-name"[^>]*>/)![0]).toMatch(/autocomplete="off"/i);
    expect(markup).toContain(`for="app-delete-data"`);
    const box = markup.match(/<input[^>]*id="app-delete-data"[^>]*>/)![0];
    expect(box).toContain('type="checkbox"');
    expect(box).not.toContain("checked");
    expect(box).toContain('aria-describedby="app-delete-data-note"');
    expect(markup).toContain(`id="app-delete-data-note"`);
    expect(markup).toContain(t.keepNote);
    expect(markup).not.toContain(t.destroyWarning);
    const confirm = els(out).find((e) => e.type === Button && e.props.type === "submit")!;
    expect(textOf(confirm)).toBe(t.confirm);
    expect(confirm.props.disabled).toBe(true);
    expect(confirm.props.variant).toBe("destructive");
  });

  it.each(locales)("ticking the data box adds a warning sentence with an icon and renames the confirm (%s)", (_l, m) => {
    const t = m.apps.delete;
    const { out } = callHooks(AppStackDelete, props(), m, { 0: true, 1: "team-notes", 2: true });
    const markup = html(out);
    expect(markup).toContain(t.destroyWarning);
    expect(markup).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(button(out, t.confirmWithData)!.props.disabled).toBe(false);
  });

  it("without stored data there is no data checkbox", () => {
    const markup = html(callHooks(AppStackDelete, props(false), en, { 0: true }).out);
    expect(markup).not.toContain("app-delete-data");
    expect(markup).not.toContain(en.apps.delete.destroyData);
  });

  it("sends {confirmName, destroyData:false} by default, then goes to /apps", async () => {
    keyedSend.mockResolvedValue(accepted);
    const { out } = callHooks(AppStackDelete, props(), en, { 0: true, 1: "team-notes" });
    await submit(out);
    expect(keyedSend).toHaveBeenCalledWith(expect.any(Object), "csrf", "delete", "DELETE", BASE, { confirmName: "team-notes", destroyData: false });
    expect(router.push).toHaveBeenCalledWith("/apps");
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("sends destroyData:true only after the box is ticked", async () => {
    keyedSend.mockResolvedValue(accepted);
    const { out } = callHooks(AppStackDelete, props(), en, { 0: true, 1: "team-notes", 2: true });
    await submit(out);
    expect(keyedSend.mock.calls[0]![5]).toEqual({ confirmName: "team-notes", destroyData: true });
  });

  it("sends nothing until the exact name is typed", async () => {
    const { out } = callHooks(AppStackDelete, props(), en, { 0: true, 1: "Team-notes" });
    await submit(out);
    expect(keyedSend).not.toHaveBeenCalled();
  });

  it.each(locales)("a refusal stays in the dialog as an alert (%s)", async (_l, m) => {
    keyedSend.mockResolvedValue({ ok: false, code: "VALIDATION_ERROR", reason: "confirmation_mismatch" });
    const { out, sets } = callHooks(AppStackDelete, props(), m, { 0: true, 1: "team-notes" });
    await submit(out);
    expect(sets).toContainEqual([4, m.apps.reasons.confirmation_mismatch]);
    expect(router.push).not.toHaveBeenCalled();
    const shown = html(callHooks(AppStackDelete, props(), m, { 0: true, 4: m.apps.reasons.confirmation_mismatch }).out);
    expect(shown).toMatch(new RegExp(`role="alert"[^>]*>[\\s\\S]*${m.apps.reasons.confirmation_mismatch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it("refuses to close while the request is out", () => {
    const { out, sets } = callHooks(AppStackDelete, props(), en, { 0: true, 3: true });
    const dialog = els(out).find((e) => e.type === Dialog)!;
    (dialog.props.onOpenChange as (o: boolean) => void)(false);
    expect(sets).not.toContainEqual([0, false]);
  });
});

describe("useOperationPoll", () => {
  const op = (status: OperationDto["status"], over: Partial<OperationDto> = {}): OperationDto => ({
    id: "op_1",
    organizationId: ORG,
    kind: "stack.deploy",
    status,
    resourceType: "stack",
    resourceId: "stk_a1",
    requestedByUserId: "usr_1",
    errorCode: null,
    errorMessage: null,
    submittedAt: NOW,
    startedAt: NOW,
    completedAt: null,
    updatedAt: NOW,
    steps: [],
    ...over,
  });
  const start = () => {
    const r = callHooks(() => useOperationPoll(ORG, "op_1"), {});
    expect(r.effects).toHaveLength(1);
    const stop = r.effects[0]!() as () => void;
    expect(r.sets).toEqual([
      [0, null],
      [1, "polling"],
      [2, false],
    ]); // a new operation id starts clean
    r.sets.length = 0;
    return { ...r, stop };
  };
  beforeEach(() => vi.useFakeTimers());

  it("polls every 2 s after each answer, through the operations route", async () => {
    expect(APP_STACK_POLL_MS).toBe(2_000);
    const fetchMock = vi.fn(async () => respond(200, { data: op("processing") }));
    vi.stubGlobal("fetch", fetchMock);
    const { stop } = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/bff/orgs/org_a1/operations/op_1", { cache: "no-store" });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never overlaps: no new poll while an answer is out", async () => {
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops at a terminal status with one refresh", async () => {
    const answers = [op("processing"), op("succeeded")];
    const fetchMock = vi.fn(async () => respond(200, { data: answers.shift() ?? op("succeeded") }));
    vi.stubGlobal("fetch", fetchMock);
    const { sets } = start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sets).toContainEqual([0, op("succeeded")]);
    expect(sets).toContainEqual([1, "done"]);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("an unknown outcome is not terminal: it keeps polling without a refresh", async () => {
    const fetchMock = vi.fn(async () => respond(200, { data: op("unknown") }));
    vi.stubGlobal("fetch", fetchMock);
    const { sets } = start();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sets).not.toContainEqual([1, "done"]);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("401 stops with signedOut", async () => {
    const fetchMock = vi.fn(async () => respond(401, { error: { code: "UNAUTHORIZED" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { sets } = start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sets).toContainEqual([1, "signedOut"]);
  });

  it("a failed read or a lost reply flags pollError and keeps going; a good answer clears it", async () => {
    const answers = [Promise.resolve(respond(500, null)), Promise.reject(new Error("offline")), Promise.resolve(respond(200, { data: op("processing") }))];
    answers[1]!.catch(() => {});
    const fetchMock = vi.fn(() => answers.shift() ?? new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const { sets } = start();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sets.filter(([k]) => k === 2)).toEqual([
      [2, true],
      [2, true],
      [2, false],
    ]);
  });

  it(`gives up after ${APP_STACK_POLL_LIMIT} polls (10 min) with slow`, async () => {
    expect(APP_STACK_POLL_LIMIT).toBe(300);
    const fetchMock = vi.fn(async () => respond(200, { data: op("processing") }));
    vi.stubGlobal("fetch", fetchMock);
    const { sets } = start();
    await vi.advanceTimersByTimeAsync(APP_STACK_POLL_MS * APP_STACK_POLL_LIMIT + 10_000);
    expect(fetchMock).toHaveBeenCalledTimes(APP_STACK_POLL_LIMIT);
    expect(sets).toContainEqual([1, "slow"]);
  });
});

describe("AppStackProgress", () => {
  const steps = [
    { id: "st1", key: "validate", label: "Check the request", status: "succeeded", message: "ok", startedAt: NOW, completedAt: NOW },
    { id: "st2", key: "pull", label: "Pull images", status: "running", message: null, startedAt: NOW, completedAt: null },
    { id: "st3", key: "mystery", label: "Mystery step", status: "pending", message: null, startedAt: null, completedAt: null },
  ] as OperationDto["steps"];
  const operation = (status: OperationDto["status"], kind: OperationDto["kind"] = "stack.upgrade") =>
    ({ id: "op_1", kind, status, steps, errorMessage: "Engine said no" }) as OperationDto;
  const render = (m: Messages, state: Record<number, unknown>) =>
    html(callHooks(AppStackProgress, { orgId: ORG, operationId: "op_1" }, m, state).out);

  it.each(locales)("names the steps from the catalog with a status word, never the API's label (%s)", (_l, m) => {
    const markup = render(m, { 0: operation("processing") });
    expect(markup).toContain(m.apps.progress.title.upgrade);
    expect(markup).toContain(m.apps.steps.validate);
    expect(markup).toContain(m.apps.steps.pull);
    expect(markup).toContain(m.apps.steps.settle);
    for (const w of [m.apps.stepStatus.succeeded, m.apps.stepStatus.running, m.apps.stepStatus.pending]) expect(markup).toContain(w);
    expect(markup).toMatch(/<ol[^>]*aria-live="polite"/);
    expect(markup).toMatch(/<li[^>]*aria-current="step"[^>]*>[\s\S]*?<\/li>/);
    expect(markup.match(/<li[^>]*aria-current="step"[^>]*>[\s\S]*?<\/li>/)![0]).toContain(m.apps.steps.pull);
    for (const english of ["Check the request", "Pull images", "Mystery step", "Engine said no"]) expect(markup).not.toContain(english);
  });

  it.each(locales)("an unknown outcome reads «to be verified», never failed (%s)", (_l, m) => {
    const markup = render(m, { 0: operation("unknown") });
    expect(markup).toContain(m.apps.progress.unknown);
    expect(markup).not.toContain(m.apps.progress.failed);
    expect(markup).not.toContain('role="alert"');
    expect(itMsgs.apps.progress.unknown).toMatch(/^Esito da verificare/);
  });

  it.each(locales)("terminal texts: succeeded is a status, failed and cancelled are alerts (%s)", (_l, m) => {
    expect(render(m, { 0: operation("succeeded"), 1: "done" })).toMatch(new RegExp(`role="status"[^>]*>${m.apps.progress.succeeded}`));
    for (const s of ["failed", "cancelled"] as const) {
      const markup = render(m, { 0: operation(s), 1: "done" });
      expect(markup).toContain('role="alert"');
      expect(markup).toContain(m.apps.progress.failed);
    }
  });

  it.each(locales)("a backup and a restore have their own title, step words and failure line (%s)", (_l, m) => {
    const own = [
      { id: "b1", key: "stop", label: "Stop", status: "succeeded", message: null, startedAt: NOW, completedAt: NOW },
      { id: "b2", key: "copy", label: "Copy", status: "running", message: null, startedAt: NOW, completedAt: null },
      { id: "b3", key: "restore", label: "Restore", status: "pending", message: null, startedAt: null, completedAt: null },
      { id: "b4", key: "expire", label: "Expire", status: "pending", message: null, startedAt: null, completedAt: null },
    ] as OperationDto["steps"];
    const of = (kind: OperationDto["kind"], status: OperationDto["status"]) => ({ ...operation(status, kind), steps: own }) as OperationDto;
    const t = m.apps.progress;
    const running = render(m, { 0: of("stack.backup", "processing") });
    expect(running).toContain(`>${t.title.backup}<`);
    for (const w of [m.apps.steps.stop, m.apps.backups.steps.copy, m.apps.backups.steps.restore, m.apps.backups.steps.expire]) expect(running).toContain(w);
    for (const english of ["Copy<", "Restore<", "Expire<"]) expect(running).not.toContain(`>${english}`);
    expect(render(m, { 0: of("stack.restore", "processing") })).toContain(`>${t.title.restore}<`);
    expect(render(m, { 0: of("stack.prune", "processing") })).toContain(`>${t.title.prune}<`);

    const backup = render(m, { 0: of("stack.backup", "failed"), 1: "done" });
    expect(backup).toContain('role="alert"');
    expect(backup).toContain(t.backupFailed);
    expect(backup).not.toContain(t.failed);
    expect(backup).not.toContain(t.restoreFailed);
    for (const s of ["failed", "cancelled"] as const) {
      const restore = render(m, { 0: of("stack.restore", s), 1: "done" });
      expect(restore).toContain('role="alert"');
      expect(restore).toContain(t.restoreFailed);
      expect(restore).not.toContain(t.failed);
      expect(restore).not.toContain(t.backupFailed);
    }
    expect(new Set([t.failed, t.backupFailed, t.restoreFailed]).size).toBe(3);
  });

  it.each(locales)("says a backup or a restore can take a while only while it is followed, and only for those two (%s)", (_l, m) => {
    const note = m.apps.progress.longNote;
    for (const kind of ["stack.backup", "stack.restore"] as const) {
      expect(render(m, { 0: operation("processing", kind) }), kind).toContain(note);
      expect(render(m, { 0: operation("succeeded", kind), 1: "done" }), kind).not.toContain(note);
      expect(render(m, { 0: operation("processing", kind), 1: "slow" }), kind).not.toContain(note);
    }
    for (const kind of ["stack.upgrade", "stack.deploy", "stack.prune"] as const) expect(render(m, { 0: operation("processing", kind) }), kind).not.toContain(note);
    expect(render(m, { 0: null })).not.toContain(note);
  });

  it.each(locales)("poll error, slow and signed-out lines; an unknown kind falls back to the install title (%s)", (_l, m) => {
    expect(render(m, { 0: null, 2: true })).toContain(m.apps.progress.pollError);
    expect(render(m, { 0: null })).toContain(m.apps.progress.title.deploy);
    expect(render(m, { 0: operation("processing"), 1: "slow" })).toContain(m.apps.progress.slow);
    const out = render(m, { 0: null, 1: "signedOut" });
    expect(out).toContain(m.apps.progress.signedOut);
    expect(out).toContain('href="/login"');
  });
});
