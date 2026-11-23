import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStackBackupsDto, AppStackDeploymentDto, AppStackDetailDto, AppStackDomainDto } from "@hosting-panel/contracts";

const loc = vi.hoisted(() => ({ value: "en" as "en" | "it" }));
const mockData = vi.hoisted(() => ({ getCustomerContext: vi.fn() }));
const fetchUpstream = vi.hoisted(() => vi.fn());
const keyedSend = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("@/app/sites/data", () => mockData);
vi.mock("@/lib/server-session", () => ({ getServerSession: async () => ({ accessToken: "tok", csrfToken: "csrf" }) }));
vi.mock("@/lib/upstream", () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }));
vi.mock("@/lib/keyed-send", () => ({ keyedSend: (...a: unknown[]) => keyedSend(...a) }));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => loc.value }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => router,
  usePathname: () => "/apps/stk_a1",
}));
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
import { format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";
import AppStackPage from "@/app/apps/[stackId]/page";
import {
  AppStackComponents,
  AppStackData,
  AppStackHistory,
  AppStackResources,
  AppStackSettings,
} from "@/components/app-stacks/app-stack-sections";
import { AppStackSecrets } from "@/components/app-stacks/app-stack-secrets";
import { APP_STACK_LOG_TAIL, AppStackLogs } from "@/components/app-stacks/app-stack-logs";
import { AppStackDomains } from "@/components/app-stacks/app-stack-domains";

const NOW = "2026-11-22T10:00:00.000Z";
const ORG = "org_a1";
const BASE = "/api/bff/orgs/org_a1/app-stacks/stk_a1";
const UP = "v1/organizations/org_a1/app-stacks/stk_a1";
const PLANTED = "S3cr3t-planted";
const visit = { organizationId: ORG, organizationName: "Customer A", expiresAt: NOW };
const context = (over: Record<string, unknown> = {}) => ({
  session: { csrfToken: "csrf", user: { name: "Someone" } },
  orgId: ORG,
  loadError: false,
  capabilities: { applicationStacksAvailable: true },
  support: null,
  ...over,
});

const MIB = 2 ** 20;
const DETAIL: AppStackDetailDto = {
  id: "stk_a1",
  name: "team-notes",
  status: "degraded",
  templateId: "atpl_notes",
  templateName: "Notes",
  templateVersionNumber: 2,
  componentCount: 2,
  unhealthyCount: 1,
  primaryHostname: "notes.example.test",
  updatedAt: NOW,
  templateVersionId: "atv_notes_2",
  createdAt: NOW,
  activeOperationId: null,
  platformWork: null,
  revisionNumber: 3,
  components: [
    { key: "web", health: "healthy", healthObservedAt: NOW, dependsOn: ["cache"], ingress: true, cpuMilli: 500, memoryBytes: String(256 * MIB) },
    { key: "cache", health: "unhealthy", healthObservedAt: null, dependsOn: [], ingress: false, cpuMilli: 250, memoryBytes: String(128 * MIB) },
  ],
  parameters: [
    { key: "SITE_TITLE", label: "Site title", value: "Team notes" },
    { key: "MAX_USERS", label: "Max users", value: 25 },
  ],
  secretParameters: [
    { key: "ADMIN_PASSWORD", label: "Admin password", required: true, isSet: true, version: 2, setAt: NOW, value: PLANTED } as never,
    { key: "MAIL_KEY", label: "Mail key", required: false, isSet: false, version: null, setAt: null },
  ],
  volumes: [{ key: "notes", status: "present", retentionPolicy: "retain" }],
  ingress: [{ componentKey: "web", port: 8080 }],
  cpuMilli: 750,
  memoryBytes: String(384 * MIB),
  upgrade: null,
  rollback: null,
};
const DEPLOYMENTS: AppStackDeploymentDto[] = [
  { id: "sdep_2", operationId: "op_2", kind: "stack.upgrade", revisionNumber: 3, status: "failed", problem: "STACK_HEALTH_TIMEOUT", startedAt: NOW, endedAt: NOW },
  { id: "sdep_1", operationId: "op_1", kind: "stack.deploy", revisionNumber: 1, status: "succeeded", problem: null, startedAt: NOW, endedAt: null },
];
const DOMAIN: AppStackDomainDto = {
  id: "sdom_1",
  hostname: "notes.example.test",
  componentKey: "web",
  port: 8080,
  status: "active",
  certificateStatus: "active",
  certificateProblem: null,
  certificateExpiresAt: "2027-02-20T10:00:00.000Z",
  checkedAt: NOW,
};
const BACKUPS: AppStackBackupsDto = {
  backups: [
    {
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
    },
  ],
  unavailableReason: null,
  goBackTo: null,
};

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const html = (node: ReactNode, m: Messages = en) =>
  decode(renderToStaticMarkup(createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: node })));
const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
const fail = (status: number, code: string) => ({ ok: false, status, error: { error: { code } } });
const answer = (byPath: Record<string, unknown>) =>
  fetchUpstream.mockImplementation(async (p: string) => byPath[p] ?? fail(404, "NOT_FOUND"));
const reads = () => fetchUpstream.mock.calls.map(([p]) => String(p));
const page = async () => html(await AppStackPage({ params: Promise.resolve({ stackId: "stk_a1" }) }), loc.value === "en" ? en : itMsgs);
const respond = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
/** Calls a client component once with stand-in hooks; `state` presets useState slots by index. */
function callHooks<P>(C: (p: P) => ReactNode, props: P, m: Messages = en, state: Record<number, unknown> = {}) {
  let s = 0;
  const sets: Array<[number, unknown]> = [];
  const effects: Array<() => unknown> = [];
  const ctx = { locale: m === en ? "en" : "it", messages: m };
  const prev = internals.H;
  internals.H = {
    useState: (v: unknown) => {
      const k = s++;
      return [k in state ? state[k] : v, (x: unknown) => void sets.push([k, x])];
    },
    useRef: (v: unknown) => ({ current: v }),
    useEffect: (f: () => unknown) => void effects.push(f),
    useContext: () => ctx,
  };
  try {
    return { out: C(props), sets, effects };
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
const submit = (tree: unknown) => (els(tree).find((e) => e.type === "form")!.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault() {} });
const h2s = (h: string) => [...h.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((x) => x[1]);

beforeEach(() => {
  vi.clearAllMocks();
  loc.value = "en";
  mockData.getCustomerContext.mockResolvedValue(context());
  answer({ [UP]: ok(DETAIL), [`${UP}/deployments?limit=20`]: ok(DEPLOYMENTS), [`${UP}/domains`]: ok([DOMAIN]), [`${UP}/backups`]: ok(BACKUPS) });
});
afterEach(() => vi.unstubAllGlobals());

describe("detail page", () => {
  it("a foreign or deleted application is the not-found page; 500 → load error; NOT_SUPPORTED → notice", async () => {
    answer({});
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(reads()).toEqual([UP]);

    answer({ [UP]: fail(500, "INTERNAL") });
    expect(await page()).toContain(en.shell.loadErrorTitle);
    answer({ [UP]: fail(422, "NOT_SUPPORTED") });
    expect(await page()).toContain(en.apps.unavailable.off);
  });

  it("with the flag off, in a support visit or without an organisation it reads no application", async () => {
    for (const [over, text] of [
      [{ capabilities: {} }, en.apps.unavailable.off],
      [{ support: visit }, en.apps.unavailable.support],
      [{ orgId: null }, en.shell.loadErrorTitle],
    ] as const) {
      mockData.getCustomerContext.mockResolvedValue(context(over));
      expect(await page()).toContain(text);
    }
    expect(reads()).toEqual([]);
  });

  it("a failed session read is the load error, not the «off» notice, and reads no application", async () => {
    mockData.getCustomerContext.mockResolvedValue(context({ loadError: true, orgId: null, capabilities: null }));
    const h = await page();
    expect(h).toContain(en.shell.loadErrorTitle);
    expect(h).not.toContain(en.apps.unavailable.title);
    expect(reads()).toEqual([]);
  });

  it("an id that is not one path segment is not found and nothing is read", async () => {
    for (const stackId of ["..", ".", "a/b", "stk_a1%2F.."]) {
      await expect(AppStackPage({ params: Promise.resolve({ stackId }) }), stackId).rejects.toThrow("NEXT_NOT_FOUND");
    }
    expect(reads()).toEqual([]);
  });

  it("the delete button is offered only while a delete may be queued", async () => {
    const open = new RegExp(`<button[^>]*\\sdisabled=""[^>]*>${en.apps.delete.open}<`);
    expect(await page()).not.toMatch(open);
    answer({ [UP]: ok({ ...DETAIL, status: "deleting" }), [`${UP}/deployments?limit=20`]: ok([]), [`${UP}/domains`]: ok([]) });
    expect(await page()).toMatch(open);
  });

  it("reads the application, its history, its addresses and its backups and renders every section in order", async () => {
    const h = await page();
    expect(reads()).toEqual([UP, `${UP}/deployments?limit=20`, `${UP}/domains`, `${UP}/backups`]);
    expect(h).toMatch(/<h1[^>]*>team-notes<\/h1>/);
    expect(h).toContain(en.apps.status.degraded);
    expect(h).toContain(format(en.apps.detail.versionLine, { name: "Notes", n: 2 }));
    expect(h).toContain(format(en.apps.detail.releaseLine, { n: 3 }));
    const s = en.apps.detail.section;
    expect(h2s(h)).toEqual([s.components, s.logs, s.settings, s.domains, s.data, s.backups, s.resources, s.history, s.danger]);
    for (const id of [...h.matchAll(/aria-labelledby="([^"]+)"/g)].map((x) => x[1])) expect(h).toContain(`id="${id}"`);
    // the backups section: its explanation once, the button, one row with a restore button, no address of a route
    expect(h.split(en.apps.backups.intro)).toHaveLength(2);
    expect(h).toContain(`>${en.apps.backups.create}</button>`);
    expect(h).toContain(`>${en.apps.backups.restore}</button>`);
    expect(h).toContain(en.apps.backups.kind.manual);
    expect(h).toContain(en.apps.delete.open);
    expect(h).toContain("notes.example.test");
    expect(h).toContain(en.apps.history.kind.upgrade);
    expect(h).not.toContain(PLANTED);
    expect(h).not.toMatch(/\/ports|\/backups|\/git/);
    expect(h).not.toContain(en.apps.status.unknown);
  });

  it("a degraded application names the unhealthy component in words, row by row", async () => {
    const h = await page();
    expect(h).toContain(format(en.apps.components.summary, { healthy: 1, total: 2 }));
    expect(h).toMatch(new RegExp(`web</span><div[^>]*>${en.apps.health.healthy}<`));
    expect(h).toMatch(new RegExp(`cache</span><div[^>]*>${en.apps.health.unhealthy}<`));
  });

  it("unknown reads «Esito da verificare» and never «Non riuscita»; a draft explains what to do", async () => {
    loc.value = "it";
    answer({ [UP]: ok({ ...DETAIL, status: "unknown" }), [`${UP}/deployments?limit=20`]: ok([]), [`${UP}/domains`]: ok([]) });
    const h = await page();
    expect(h).toContain("Esito da verificare");
    expect(h).toContain(itMsgs.apps.detail.unknownBody);
    expect(h).not.toContain(itMsgs.apps.status.failed);
    expect(h).not.toContain(itMsgs.apps.detail.draftBody);

    answer({ [UP]: ok({ ...DETAIL, status: "draft", revisionNumber: null }), [`${UP}/deployments?limit=20`]: ok([]), [`${UP}/domains`]: ok([]) });
    const d = await page();
    expect(d).toContain(itMsgs.apps.detail.draftBody);
    expect(d).toContain(itMsgs.apps.actions.install);
    expect(d).not.toContain(itMsgs.apps.detail.releaseLine.replace(" {n}", ""));
  });

  it("a failed history, address or backup read shows the section error and the page still renders", async () => {
    answer({ [UP]: ok(DETAIL) });
    const h = await page();
    expect(h.split(en.apps.detail.sectionError)).toHaveLength(4);
    expect(h).not.toContain(en.apps.backups.create);
    expect(h).toContain(en.apps.detail.section.danger);
  });

  it("an operation in progress is followed on the page", async () => {
    answer({ [UP]: ok({ ...DETAIL, status: "deploying", activeOperationId: "op_7" }), [`${UP}/deployments?limit=20`]: ok([]), [`${UP}/domains`]: ok([]) });
    expect(await page()).toContain(en.apps.progress.title.deploy);
    expect(await page()).not.toContain(en.apps.detail.platformWork.backups_cleanup);
  });

  it.each([
    ["en", en],
    ["it", itMsgs],
  ] as const)("%s: work of the platform on the application says what it is, with nothing to follow", async (locale, m) => {
    loc.value = locale;
    answer({ [UP]: ok({ ...DETAIL, platformWork: "backups_cleanup" }), [`${UP}/deployments?limit=20`]: ok([]), [`${UP}/domains`]: ok([]) });
    const h = await page();
    expect(h.split(m.apps.detail.platformWork.backups_cleanup)).toHaveLength(2);
    expect(h).not.toContain(m.apps.progress.title.prune);
    expect(h).not.toMatch(/op_|stack\.prune|org_platform/);
  });
});

describe("sections", () => {
  it("components: health exactly as given, last check, dependencies, web, resources", () => {
    const unknown = [{ ...DETAIL.components[0]!, health: "unknown" as const }];
    expect(html(AppStackComponents({ components: unknown, m: itMsgs, locale: "it" }), itMsgs)).toContain("Non verificato");
    const h = html(AppStackComponents({ components: DETAIL.components, m: en, locale: "en" }));
    expect(h).toContain(`<time dateTime="${NOW}">`);
    expect(h).toContain(format(en.apps.components.lastCheck, { time: "" }).trim());
    expect(h).toContain(en.apps.components.neverChecked);
    expect(h).toContain(format(en.apps.components.dependsOn, { list: "cache" }));
    expect(h).toContain(en.apps.components.noDependencies);
    expect(h.split(en.apps.components.web)).toHaveLength(2);
    expect(h).toContain(format(en.apps.components.resources, { cpu: "0.5 vCPU", memory: "256 MiB" }));
  });

  it("settings show the public values only; none → the empty line", () => {
    const h = html(AppStackSettings({ parameters: DETAIL.parameters, m: en }));
    expect(h).toMatch(/<dt[^>]*>Site title<\/dt><dd[^>]*>Team notes<\/dd>/);
    expect(h).toMatch(/<dt[^>]*>Max users<\/dt><dd[^>]*>25<\/dd>/);
    expect(html(AppStackSettings({ parameters: [], m: en }))).toContain(en.apps.settings.none);
  });

  it("data: a word per status and the keep note; none → the empty line", () => {
    const h = html(AppStackData({ volumes: DETAIL.volumes, m: en }));
    expect(h).toContain("notes");
    expect(h).toContain(en.apps.data.status.present);
    expect(h).toContain(en.apps.data.keptNote);
    const none = html(AppStackData({ volumes: [], m: en }));
    for (const t of [en.apps.data.none, en.apps.data.keptNote]) expect(none).toContain(t);
  });

  it("resources: the total and one line per component", () => {
    const h = html(AppStackResources({ cpuMilli: 750, memoryBytes: String(384 * MIB), components: DETAIL.components, m: en }));
    expect(h).toContain(format(en.apps.resources.total, { cpu: "0.75 vCPU", memory: "384 MiB" }));
    expect(h).toContain(format(en.apps.components.resources, { cpu: "0.25 vCPU", memory: "128 MiB" }));
  });

  it("history: kind, status, release and the reason in words; null → section error; empty → the empty line", () => {
    const h = html(AppStackHistory({ deployments: DEPLOYMENTS, m: en, locale: "en" }));
    for (const t of [
      en.apps.history.kind.upgrade,
      en.apps.history.status.failed,
      format(en.apps.detail.releaseLine, { n: 3 }),
      en.apps.reasons.STACK_HEALTH_TIMEOUT,
      en.apps.history.kind.deploy,
      en.apps.history.status.succeeded,
    ])
      expect(h).toContain(t);
    expect(h).not.toContain("STACK_HEALTH_TIMEOUT");
    expect(html(AppStackHistory({ deployments: null, m: en, locale: "en" }))).toContain(en.apps.detail.sectionError);
    expect(html(AppStackHistory({ deployments: [], m: en, locale: "en" }))).toContain(en.apps.history.empty);
  });

  it.each([
    ["en", en],
    ["it", itMsgs],
  ] as const)("history: an outcome to be verified never reads as failed; the generic failure line is for a failed entry only (%s)", (locale, m) => {
    const base = DEPLOYMENTS[1]!;
    const unknown: AppStackDeploymentDto[] = [
      { ...base, id: "sdep_3", status: "unknown", problem: "OPERATION_AMBIGUOUS" },
      { ...base, id: "sdep_4", status: "unknown", problem: "OPERATION_INTERRUPTED" },
    ];
    const h = html(AppStackHistory({ deployments: unknown, m, locale }), m);
    expect(h).toContain(m.apps.history.status.unknown);
    expect(h).toContain(m.apps.codes.OPERATION_AMBIGUOUS);
    expect(h).not.toContain(m.apps.history.problemGeneric);
    expect(h).not.toContain("text-destructive");
    const failed = html(AppStackHistory({ deployments: [{ ...unknown[1]!, status: "failed" }], m, locale }), m);
    expect(failed).toMatch(new RegExp(`class="text-destructive">${m.apps.history.problemGeneric}<`));
  });
});

describe("private values", () => {
  const props = { orgId: ORG, stackId: "stk_a1", csrfToken: "csrf", secrets: DETAIL.secretParameters };

  it("rows say set or not set, offer Replace or Set, and never render a value", () => {
    const h = html(createElement(AppStackSecrets, props));
    expect(h).toContain(en.apps.secrets.title);
    for (const t of [en.apps.secrets.set, en.apps.secrets.unset, en.apps.secrets.replace, en.apps.secrets.setNow, en.apps.secrets.required])
      expect(h).toContain(t);
    expect(h).toContain(`aria-label="${format(en.apps.secrets.replaceNamed, { label: "Admin password" })}"`);
    expect(h).toContain(`<time dateTime="${NOW}">`);
    expect(h).not.toContain(PLANTED);
    expect(h).not.toMatch(/type="password"/);
  });

  it("the replace dialog is a write-only password field with its label and help", () => {
    const { out } = callHooks(AppStackSecrets, props, en, { 0: "ADMIN_PASSWORD" });
    const h = html(out);
    const input = h.match(/<input[^>]*id="app-secret-value"[^>]*>/)![0];
    for (const a of [/type="password"/, /autocomplete="new-password"/i, /spellcheck="false"/i, /aria-describedby="app-secret-value-note"/])
      expect(input).toMatch(a);
    expect(input).not.toMatch(/\svalue=/);
    expect(input).toMatch(/maxLength="16384"/i);
    expect(h).toMatch(/<label[^>]*for="app-secret-value"/);
    expect(h).toContain(format(en.apps.secrets.newValue, { label: "Admin password" }));
    expect(h).toContain(`id="app-secret-value-note"`);
    expect(h).toContain(en.apps.secrets.writeOnly);
    expect(h).not.toContain(PLANTED);
  });

  it("submit reads the field, sends {parameterKey, value} to the secrets route and empties the field after the call", async () => {
    const { out, sets } = callHooks(AppStackSecrets, props, en, { 0: "ADMIN_PASSWORD" });
    const ref = byId(out, "app-secret-value")!.props.ref as { current: { value: string } | null };
    ref.current = { value: "n3w-V4lue" };
    keyedSend.mockImplementation(async () => {
      expect(ref.current!.value).toBe("n3w-V4lue");
      return { ok: true, data: { data: { key: "ADMIN_PASSWORD", isSet: true, version: 3, setAt: NOW, value: PLANTED } } };
    });
    await submit(out);
    expect(keyedSend).toHaveBeenCalledWith(expect.any(Object), "csrf", "secret:ADMIN_PASSWORD", "POST", `${BASE}/secrets`, {
      parameterKey: "ADMIN_PASSWORD",
      value: "n3w-V4lue",
    });
    expect(ref.current!.value).toBe("");
    expect(sets).toContainEqual([0, null]);
    expect(sets).toContainEqual([4, en.apps.secrets.replaced]);
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(JSON.stringify(sets)).not.toMatch(/n3w-V4lue|S3cr3t/);
  });

  it("an empty field is a field error and sends nothing", async () => {
    const { out, sets } = callHooks(AppStackSecrets, props, en, { 0: "ADMIN_PASSWORD" });
    (byId(out, "app-secret-value")!.props.ref as { current: unknown }).current = { value: "" };
    await submit(out);
    expect(keyedSend).not.toHaveBeenCalled();
    expect(sets).toContainEqual([2, en.apps.wizard.required]);
    const shown = html(callHooks(AppStackSecrets, props, en, { 0: "ADMIN_PASSWORD", 2: en.apps.wizard.required }).out);
    expect(shown).toMatch(/<input[^>]*aria-invalid="true"/);
    expect(shown).toContain(en.apps.wizard.required);
  });

  it("a status refusal says the status in words and the field is still emptied", async () => {
    const { out, sets } = callHooks(AppStackSecrets, props, itMsgs, { 0: "ADMIN_PASSWORD" });
    const ref = byId(out, "app-secret-value")!.props.ref as { current: { value: string } };
    ref.current = { value: "n3w-V4lue" };
    keyedSend.mockResolvedValue({ ok: false, code: "RESOURCE_LOCKED", reason: "stopped" });
    await submit(out);
    expect(ref.current.value).toBe("");
    expect(sets).toContainEqual([3, "Non è possibile ora: l'applicazione è nello stato «Ferma»."]);
    expect(sets).not.toContainEqual([0, null]);
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("logs", () => {
  const props = { orgId: ORG, stackId: "stk_a1", componentKeys: ["web", "cache"] };
  const lines = [
    { at: NOW, stream: "stdout" as const, text: "older line" },
    { at: null, stream: "stderr" as const, text: "<script>alert(1)</script>" },
  ];

  it("loads the chosen component's newest lines first through the logs route", async () => {
    const fetchMock = vi.fn(async () => respond(200, { data: { componentKey: "web", lines } }));
    vi.stubGlobal("fetch", fetchMock);
    const { out, sets } = callHooks(AppStackLogs, props);
    await (buttons(out, en.apps.logs.load)[0]!.props.onClick as () => Promise<void>)();
    expect(APP_STACK_LOG_TAIL).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/components/web/logs?tail=200`, { cache: "no-store" });
    expect(sets).toContainEqual([1, [lines[1], lines[0]]]);
  });

  it.each([
    [503, en.apps.logs.unavailable],
    [404, en.apps.logs.notFound],
    [429, en.apps.logs.busy],
    [500, en.apps.logs.error],
  ])("an answer %i reads as its own sentence", async (status, text) => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(status, { error: { code: "X" } })));
    const { out, sets } = callHooks(AppStackLogs, props);
    await (buttons(out, en.apps.logs.load)[0]!.props.onClick as () => Promise<void>)();
    expect(sets).toContainEqual([2, text]);
  });

  it("renders each line as text with its stream word; the component select is labelled", () => {
    const h = html(callHooks(AppStackLogs, props, en, { 1: lines }).out);
    expect(h).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(h).not.toContain("<script>");
    expect(h).toContain(`<span>${en.apps.logs.stream.stderr}</span>`);
    expect(h).toContain(`<time dateTime="${NOW}">`);
    expect(h).toMatch(/<label[^>]*for="app-logs-component"/);
    expect(h).toMatch(/<select[^>]*id="app-logs-component"/);
    expect(h).toContain(en.apps.logs.refresh);
    expect(html(callHooks(AppStackLogs, props, en, { 1: [] }).out)).toContain(en.apps.logs.empty);
  });

  it("choosing another component asks for its lines again", () => {
    const { out, sets } = callHooks(AppStackLogs, props, en, { 1: lines });
    (byId(out, "app-logs-component")!.props.onChange as (e: unknown) => void)({ target: { value: "cache" } });
    expect(sets).toEqual([
      [0, "cache"],
      [1, null],
      [2, null],
    ]);
  });
});

describe("web addresses", () => {
  const INGRESS = [
    { componentKey: "web", port: 8080 },
    { componentKey: "admin", port: 9000 },
  ];
  const props = (over: Record<string, unknown> = {}) => ({ orgId: ORG, stackId: "stk_a1", csrfToken: "csrf", initial: [DOMAIN], ingress: INGRESS, ...over });
  const SECOND: AppStackDomainDto = { ...DOMAIN, id: "sdom_2", hostname: "notes2.example.test", componentKey: "admin", port: 9000, status: "pending", certificateStatus: "requested", certificateExpiresAt: null };

  it("rows show the address, its target, its status and certificate in words; the add form has its labels and hint", () => {
    const h = html(callHooks(AppStackDomains, props()).out);
    for (const t of [
      "notes.example.test",
      format(en.apps.wizard.target, { component: "web", port: 8080 }),
      en.apps.domains.status.active,
      en.apps.domains.certificate.active,
      en.apps.domains.hint,
    ])
      expect(h).toContain(t);
    expect(h).toContain(format(en.apps.domains.expires, { date: "" }).trim());
    expect(h).toContain(`<time dateTime="${DOMAIN.certificateExpiresAt}"`);
    expect(h).toMatch(/<label[^>]*for="app-domain-hostname"/);
    expect(h).toMatch(/<label[^>]*for="app-domain-target"/);
    const one = html(callHooks(AppStackDomains, props({ ingress: INGRESS.slice(0, 1) })).out);
    expect(one).not.toContain(format(en.apps.wizard.target, { component: "web", port: 8080 }));
    expect(one).not.toContain("app-domain-target");
  });

  it("null → section error; no address → the empty line; no web component or 8 addresses → no add form", () => {
    expect(html(callHooks(AppStackDomains, props({ initial: null })).out)).toContain(en.apps.detail.sectionError);
    expect(html(callHooks(AppStackDomains, props({ initial: [] })).out)).toContain(en.apps.domains.none);
    expect(html(callHooks(AppStackDomains, props({ ingress: [] })).out)).not.toContain("app-domain-hostname");
    const eight = Array.from({ length: 8 }, (_, i) => ({ ...DOMAIN, id: `sdom_${i}`, hostname: `n${i}.example.test` }));
    expect(html(callHooks(AppStackDomains, props({ initial: eight })).out)).not.toContain("app-domain-hostname");
  });

  it("add sends the trimmed lower-cased address and its target; the answered list replaces the rows", async () => {
    const { out, sets } = callHooks(AppStackDomains, props(), en, { 1: "  Notes2.Example.TEST ", 2: 1 });
    keyedSend.mockResolvedValue({ ok: true, data: { data: [DOMAIN, SECOND] } });
    await submit(out);
    expect(keyedSend).toHaveBeenCalledWith(expect.any(Object), "csrf", "add", "POST", `${BASE}/domains`, {
      hostname: "notes2.example.test",
      componentKey: "admin",
      port: 9000,
    });
    expect(sets).toContainEqual([0, [DOMAIN, SECOND]]);
    expect(sets).toContainEqual([1, ""]);
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it("a refresh of the page brings fresh rows: statuses are not kept from the first answer", () => {
    const fresh = { ...SECOND, status: "active", certificateStatus: "active" } as const;
    const { sets, effects } = callHooks(AppStackDomains, props({ initial: [DOMAIN, fresh] }), en, { 0: [DOMAIN, SECOND] });
    for (const f of effects) f();
    expect(sets).toContainEqual([0, [DOMAIN, fresh]]);
    const failed = callHooks(AppStackDomains, props({ initial: null }), en, { 0: [DOMAIN] });
    for (const f of failed.effects) f();
    expect(failed.sets).toEqual([]);
  });

  it("an address in use reads as DOMAIN_CONFLICT", async () => {
    const { out, sets } = callHooks(AppStackDomains, props(), en, { 1: "taken.example.test" });
    keyedSend.mockResolvedValue({ ok: false, code: "DOMAIN_CONFLICT" });
    await submit(out);
    expect(sets).toContainEqual([4, en.apps.codes.DOMAIN_CONFLICT]);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("remove asks first, then deletes the address and shows the answered list", async () => {
    const { out, sets } = callHooks(AppStackDomains, props(), en, { 5: "sdom_1" });
    const h = html(out);
    expect(h).toContain(en.apps.domains.removeTitle);
    expect(h).toContain(format(en.apps.domains.removeBody, { hostname: "notes.example.test" }));
    keyedSend.mockResolvedValue({ ok: true, data: { data: [] } });
    const confirm = buttons(out, en.apps.domains.remove).find((b) => b.props.variant === "destructive");
    await (confirm!.props.onClick as () => Promise<void>)();
    expect(keyedSend).toHaveBeenCalledWith(expect.any(Object), "csrf", "remove:sdom_1", "DELETE", `${BASE}/domains/sdom_1`, {});
    expect(sets).toContainEqual([0, []]);
    expect(sets).toContainEqual([5, null]);
  });
});
