// QA-W3: realistic customer flows of two harmless fixture applications (web + cache; worker + storage)
// through the catalog, the install wizard and the application page. Spec acceptance rows A3, A15-A19, B4.
import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStackBackupsDto, AppStackDetailDto, AppStackPlanDiffDto, AppTemplateParameter, CustomerAppTemplateDto } from "@hosting-panel/contracts";

const loc = vi.hoisted(() => ({ value: "en" as "en" | "it" }));
const mockData = vi.hoisted(() => ({ getCustomerContext: vi.fn() }));
const fetchUpstream = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("@/app/sites/data", () => mockData);
vi.mock("@/lib/server-session", () => ({ getServerSession: async () => ({ accessToken: "tok", csrfToken: "csrf" }) }));
vi.mock("@/lib/upstream", () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => loc.value }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => router,
  useParams: () => ({}),
  usePathname: () => "/apps",
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
import { Dialog } from "@/components/ui/dialog";
import { format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";
import NewAppPage from "@/app/apps/new/page";
import AppWizardPage from "@/app/apps/new/[templateId]/page";
import AppStackPage from "@/app/apps/[stackId]/page";
import { AppStackActions } from "@/components/app-stacks/app-stack-actions";
import { AppStackDelete } from "@/components/app-stacks/app-stack-delete";
import { AppWizard } from "@/components/app-stacks/app-wizard";

const NOW = "2026-11-22T10:00:00.000Z";
const ORG = "org_a1";
const MIB = 2 ** 20;
const PLANTED = "S3cr3t-planted";
const BASE = `/api/bff/orgs/${ORG}/app-stacks`;
const locales = [
  ["en", en],
  ["it", itMsgs],
] as const;

// ---- fixtures: two harmless applications ------------------------------------------------------------------------------
const WEB_PARAMS: AppTemplateParameter[] = [
  { key: "site_title", label: "Board title", type: "string", default: "My board", customer: true },
  { key: "admin_password", label: "Admin password", type: "secret", required: true, customer: true },
  { key: "cache_size", label: "Hidden cache size", type: "size", default: "64m", customer: false },
];
const WEB_APP: CustomerAppTemplateDto = {
  id: "atpl_webcache",
  name: "Board",
  description: "A small web board with a cache.",
  category: "content",
  versionId: "atv_webcache_1",
  versionNumber: 1,
  componentCount: 2,
  cpuMilli: 500,
  memoryBytes: String(256 * MIB),
  volumeCount: 0,
  hasIngress: true,
  parameters: WEB_PARAMS,
  ingress: [{ componentKey: "web", port: 8080 }],
  components: [
    { key: "cache", cpuMilli: 250, memoryBytes: String(128 * MIB) },
    { key: "web", cpuMilli: 250, memoryBytes: String(128 * MIB) },
  ],
};
const WORKER_PARAMS: AppTemplateParameter[] = [
  { key: "queue_name", label: "Queue name", type: "string", default: "jobs", customer: true },
  { key: "concurrency", label: "Parallel jobs", type: "integer", min: 1, max: 8, default: 2, customer: true },
  { key: "shard_hint", label: "Hidden shard hint", type: "enum", options: ["a", "b"], default: "a", customer: false },
];
const WORKER_APP: CustomerAppTemplateDto = {
  id: "atpl_workerstore",
  name: "Worker",
  description: "A background worker with its own storage.",
  category: "tools",
  versionId: "atv_workerstore_3",
  versionNumber: 3,
  componentCount: 2,
  cpuMilli: 1000,
  memoryBytes: String(512 * MIB),
  volumeCount: 1,
  hasIngress: false,
  parameters: WORKER_PARAMS,
  ingress: [],
  components: [
    { key: "storage", cpuMilli: 500, memoryBytes: String(256 * MIB) },
    { key: "worker", cpuMilli: 500, memoryBytes: String(256 * MIB) },
  ],
};
type Fixture = { app: CustomerAppTemplateDto; hidden: { key: string; label: string; typed: string }; first: { key: string; typed: string; sent: unknown } };
const FIXTURES: readonly Fixture[] = [
  { app: WEB_APP, hidden: { key: "cache_size", label: "Hidden cache size", typed: "1g" }, first: { key: "site_title", typed: "Team board", sent: "Team board" } },
  { app: WORKER_APP, hidden: { key: "shard_hint", label: "Hidden shard hint", typed: "b" }, first: { key: "concurrency", typed: "4", sent: 4 } },
];
const secretKeys = (app: CustomerAppTemplateDto) => app.parameters.filter((p) => p.type === "secret").map((p) => p.key);

const webStack = (over: Partial<AppStackDetailDto> = {}): AppStackDetailDto => ({
  id: "stk_web",
  name: "team-board",
  status: "degraded",
  templateId: WEB_APP.id,
  templateName: WEB_APP.name,
  templateVersionNumber: 1,
  componentCount: 2,
  unhealthyCount: 1,
  primaryHostname: "board.example.test",
  updatedAt: NOW,
  templateVersionId: WEB_APP.versionId,
  createdAt: NOW,
  activeOperationId: null,
  platformWork: null,
  revisionNumber: 1,
  components: [
    { key: "web", health: "healthy", healthObservedAt: NOW, dependsOn: ["cache"], ingress: true, cpuMilli: 250, memoryBytes: String(128 * MIB) },
    { key: "cache", health: "unhealthy", healthObservedAt: NOW, dependsOn: [], ingress: false, cpuMilli: 250, memoryBytes: String(128 * MIB) },
  ],
  parameters: [{ key: "site_title", label: "Board title", value: "Team board" }],
  secretParameters: [{ key: "admin_password", label: "Admin password", required: true, isSet: true, version: 1, setAt: NOW }],
  volumes: [],
  ingress: [{ componentKey: "web", port: 8080 }],
  cpuMilli: 500,
  memoryBytes: String(256 * MIB),
  upgrade: null,
  rollback: null,
  ...over,
});
const workerStack = (over: Partial<AppStackDetailDto> = {}): AppStackDetailDto => ({
  ...webStack(),
  id: "stk_wrk",
  name: "night-jobs",
  status: "unknown",
  templateId: WORKER_APP.id,
  templateName: WORKER_APP.name,
  templateVersionNumber: 3,
  templateVersionId: WORKER_APP.versionId,
  unhealthyCount: 0,
  primaryHostname: null,
  components: [
    { key: "worker", health: "unknown", healthObservedAt: null, dependsOn: ["storage"], ingress: false, cpuMilli: 500, memoryBytes: String(256 * MIB) },
    { key: "storage", health: "unknown", healthObservedAt: null, dependsOn: [], ingress: false, cpuMilli: 500, memoryBytes: String(256 * MIB) },
  ],
  parameters: [{ key: "queue_name", label: "Queue name", value: "jobs" }],
  secretParameters: [],
  volumes: [{ key: "data", status: "present", retentionPolicy: "retain" }],
  ingress: [],
  ...over,
});

// ---- helpers ----------------------------------------------------------------------------------------------------------
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const html = (node: ReactNode, m: Messages = en) =>
  decode(renderToStaticMarkup(createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: node })));
const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
const fail = (status: number, code: string) => ({ ok: false, status, error: { error: { code } } });

const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
/** Calls a client component once with stand-in hooks; `state` presets useState slots and `refs` useRef slots, by call order. */
function callHooks<P>(C: (p: P) => ReactNode, props: P, state: Record<number, unknown> = {}, refs: Record<number, unknown> = {}, m: Messages = en) {
  let s = 0;
  let r = 0;
  const sets: Array<[number, unknown]> = [];
  const ctx = { locale: m === en ? "en" : "it", messages: m };
  const prev = internals.H;
  internals.H = {
    useState: (v: unknown) => {
      const k = s++;
      return [k in state ? state[k] : v, (x: unknown) => void sets.push([k, x])];
    },
    useRef: (v: unknown) => {
      const k = r++;
      return k in refs ? refs[k] : { current: v };
    },
    useEffect: () => {},
    useContext: () => ctx,
  };
  try {
    const out = C(props);
    return { out, tree: out, sets };
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
const click = (e: El | undefined) => {
  if (!e) throw new Error("no such button");
  return (e.props.onClick as () => Promise<void> | void)();
};

const wizard = (app: CustomerAppTemplateDto, state: Record<number, unknown> = {}, refs: Record<number, unknown> = {}, m: Messages = en) =>
  callHooks(AppWizard, { orgId: ORG, csrfToken: "csrf", entry: app }, state, refs, m);
const secretsRef = (values: Record<string, string>) => ({ current: new Map(Object.entries(values)) });

type Answer = { status: number; body: unknown } | "network";
const fetchMock = vi.fn();
/** Each URL answers with the next of its queue. */
function answer(byUrl: Record<string, Answer[]>) {
  fetchMock.mockImplementation(async (url: string) => {
    const a = byUrl[url]?.shift();
    if (!a) throw new Error(`unexpected ${url}`);
    if (a === "network") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json" } });
  });
}
const calls = () =>
  fetchMock.mock.calls.map((c) => {
    const init = c[1] as RequestInit;
    return { url: c[0] as string, method: init.method, headers: init.headers as Record<string, string>, raw: init.body as string };
  });
const accepted = (status: number, stackId = "stk_new") => ({ status, body: { data: { stackId, operationId: status === 202 ? "op_1" : null }, links: {} } });
const secretSaved = (key: string) => ({ status: 200, body: { data: { key, isSet: true, version: 1, setAt: NOW } } });
const refusal = (status: number, code: string, details: { field?: string; reason?: string }[] = []) => ({ status, body: { error: { code, message: "x", details } } });

beforeEach(() => {
  vi.clearAllMocks();
  loc.value = "en";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  mockData.getCustomerContext.mockResolvedValue({
    session: { csrfToken: "csrf", user: { name: "Someone" } },
    orgId: ORG,
    loadError: false,
    capabilities: { applicationStacksAvailable: true },
    support: null,
  });
});
afterEach(() => vi.unstubAllGlobals());

// ---- catalog -> wizard ----------------------------------------------------------------------------------------------------
describe("catalog to wizard: both fixtures", () => {
  it("the catalog offers each fixture and its Choose link opens that fixture's wizard, which asks only customer settings", async () => {
    const summaries = FIXTURES.map(({ app }) => {
      const { parameters: _p, ingress: _i, components: _c, ...summary } = app;
      return summary;
    });
    fetchUpstream.mockResolvedValue(ok({ templates: summaries, categories: ["content", "tools"] }));
    const catalog = html(await NewAppPage());
    for (const { app, hidden } of FIXTURES) {
      const link = catalog.match(new RegExp(`<a[^>]*href="/apps/new/${app.id}"[^>]*>`));
      expect(link, app.id).not.toBeNull();
      fetchUpstream.mockReset();
      fetchUpstream.mockResolvedValue(ok(app));
      const page = html(await AppWizardPage({ params: Promise.resolve({ templateId: app.id }) }));
      expect(fetchUpstream.mock.calls.map(([p]) => p)).toEqual([`v1/organizations/${ORG}/app-templates/${app.id}`]);
      for (const p of app.parameters.filter((x) => x.customer)) expect(page).toMatch(new RegExp(`<label[^>]*for="app-param-${p.key}"`));
      expect(page).not.toContain(`app-param-${hidden.key}`);
      expect(page).not.toContain(hidden.label);
    }
    expect(catalog).toContain(`/apps/new/${WEB_APP.id}`);
    expect(catalog).toContain(`/apps/new/${WORKER_APP.id}`);
  });

  it.each(locales)("A3: a customer:false setting is on no step of the wizard, in any language (%s)", (_l, m) => {
    for (const { app, hidden } of FIXTURES) {
      const values = secretsRef(Object.fromEntries(secretKeys(app).map((k) => [k, PLANTED])));
      for (const step of ["configure", "domains", "review", "install"]) {
        const state = { 0: step, 1: "x-app", 2: { [hidden.key]: hidden.typed }, 3: secretKeys(app) };
        const out = html(wizard(app, state, { 0: values }, m).tree, m);
        expect(out, `${app.id} ${step}`).not.toContain(hidden.label);
        expect(out, `${app.id} ${step}`).not.toContain(`app-param-${hidden.key}`);
        expect(out, `${app.id} ${step}`).not.toContain(PLANTED);
      }
    }
  });

  it("a fixture without web addresses says so on the Domains step; the web one offers an address field", () => {
    expect(html(wizard(WORKER_APP, { 0: "domains" }).tree)).toContain(en.apps.wizard.noDomains);
    const web = html(wizard(WEB_APP, { 0: "domains", 4: [{ hostname: "", target: 0 }] }).tree);
    expect(web).toContain('id="app-domain-0"');
    expect(web).not.toContain(en.apps.wizard.noDomains);
  });
});

// ---- A3 ------------------------------------------------------------------------------------------------------------------
describe("A3: a refused customer:false value", () => {
  it.each(FIXTURES)("a typed hidden value is never sent; a 400 on parameters.<key> goes back to Configure with the error on that field ($app.id)", async ({ app, hidden }) => {
    const reasons = ["STACK_PARAMETER_INVALID", "PARAM_VALUE_NOT_CUSTOMER"];
    for (const reason of reasons) {
      fetchMock.mockReset();
      answer({ [BASE]: [refusal(400, "VALIDATION_ERROR", [{ field: `parameters.${hidden.key}`, reason }])] });
      const state = { 0: "review", 1: "x-app", 2: { [hidden.key]: hidden.typed }, 3: [] as string[] };
      const noSecrets = { ...app, parameters: app.parameters.filter((p) => p.type !== "secret") };
      const { tree, sets } = wizard(noSecrets, state);
      await click(els(tree).find((e) => typeof e.props.onClick === "function" && textOf(e) === en.apps.wizard.install));
      const sent = calls();
      expect(sent, reason).toHaveLength(1);
      expect(JSON.parse(sent[0]!.raw).parameters, reason).not.toContainEqual(expect.objectContaining({ key: hidden.key }));
      const errors = sets.filter(([k]) => k === 5).at(-1)?.[1] as Record<string, string> | undefined;
      expect(Object.keys(errors ?? {}), reason).toEqual([`param:${hidden.key}`]);
      expect(sets, reason).toContainEqual([0, "configure"]);
      expect(sets, reason).toContainEqual([7, false]);
      const banner = sets.find(([k, v]) => k === 6 && typeof v === "string" && v !== "")?.[1] as string;
      expect(banner, reason).toBeTruthy();
      expect(banner, reason).not.toMatch(/PARAM_VALUE|STACK_|VALIDATION_ERROR/);
      expect(router.push).not.toHaveBeenCalled();
    }
  });

  it("a refusal on a visible field shows the sentence on that field and keeps the other typed values", () => {
    const sentence = en.apps.reasons.STACK_PARAMETER_INVALID;
    const out = html(wizard(WORKER_APP, { 0: "configure", 1: "x-app", 2: { concurrency: "99", queue_name: "mine" }, 5: { "param:concurrency": sentence } }).tree);
    expect(out).toMatch(/id="app-param-concurrency"[^>]*aria-invalid="true"/);
    expect(out).toMatch(new RegExp(`id="app-param-concurrency-note"[^>]*>${sentence}<`));
    expect(out).toContain('value="mine"');
    expect(out).toContain('value="99"');
  });
});

// ---- A16 -----------------------------------------------------------------------------------------------------------------
describe("A16: retries and Idempotency-Key", () => {
  it.each(FIXTURES)("create after a lost reply or a 5xx replays the same key and the same body; a 4xx renews it ($app.id)", async ({ app, first }) => {
    const keys = { current: {} as Record<string, string> };
    const noSecrets = { ...app, parameters: app.parameters.filter((p) => p.type !== "secret") };
    answer({ [BASE]: ["network", refusal(503, "UPSTREAM_UNAVAILABLE"), refusal(400, "VALIDATION_ERROR", [{ field: "name", reason: "name_taken" }]), accepted(202)] });
    const attempt = () => {
      const { tree } = wizard(noSecrets, { 0: "install", 1: "x-app", 2: { [first.key]: first.typed }, 3: [], 6: "x" }, { 1: keys });
      return click(els(tree).find((e) => typeof e.props.onClick === "function" && textOf(e) === en.apps.wizard.retry));
    };
    for (let i = 0; i < 4; i++) await attempt();
    const sent = calls();
    expect(sent).toHaveLength(4);
    expect(sent[1]!.headers["Idempotency-Key"]).toBe(sent[0]!.headers["Idempotency-Key"]);
    expect(sent[2]!.headers["Idempotency-Key"]).toBe(sent[0]!.headers["Idempotency-Key"]);
    expect(sent[3]!.headers["Idempotency-Key"]).not.toBe(sent[0]!.headers["Idempotency-Key"]);
    expect(sent[1]!.raw).toBe(sent[0]!.raw);
    expect(JSON.parse(sent[0]!.raw).parameters).toEqual([{ key: first.key, value: first.sent }]);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith("/apps/stk_new");
  });

  it("a private value lost on the way keeps its own key; each private value and the deploy have a distinct key", async () => {
    const keys = { current: {} as Record<string, string> };
    const values = secretsRef({ admin_password: PLANTED });
    answer({
      [BASE]: [accepted(201)],
      [`${BASE}/stk_new/secrets`]: ["network", secretSaved("admin_password")],
      [`${BASE}/stk_new/deploy`]: [accepted(202)],
    });
    const state = { 0: "review", 1: "x-app", 2: {}, 3: ["admin_password"] };
    const first = wizard(WEB_APP, state, { 0: values, 1: keys });
    await click(els(first.tree).find((e) => typeof e.props.onClick === "function" && textOf(e) === en.apps.wizard.install));
    expect(first.sets).toContainEqual([8, "stk_new"]);
    expect(first.sets).toContainEqual([6, en.apps.wizard.secretFailed]);
    const retry = wizard(WEB_APP, { ...state, 0: "install", 6: en.apps.wizard.secretFailed, 8: "stk_new" }, { 0: values, 1: keys });
    await click(els(retry.tree).find((e) => typeof e.props.onClick === "function" && textOf(e) === en.apps.wizard.retry));
    const sent = calls();
    expect(sent.map((c) => c.url)).toEqual([BASE, `${BASE}/stk_new/secrets`, `${BASE}/stk_new/secrets`, `${BASE}/stk_new/deploy`]);
    expect(sent[2]!.headers["Idempotency-Key"]).toBe(sent[1]!.headers["Idempotency-Key"]);
    expect(new Set(sent.filter((_, i) => i !== 2).map((c) => c.headers["Idempotency-Key"])).size).toBe(3);
    for (const c of sent) {
      expect(c.url).not.toContain(PLANTED);
      expect(c.headers["Idempotency-Key"]).not.toContain(PLANTED);
    }
    expect(sent[0]!.raw).not.toContain(PLANTED);
    expect(sent[3]!.raw).not.toContain(PLANTED);
    expect(values.current.size).toBe(0);
    expect(router.push).toHaveBeenCalledWith("/apps/stk_new");
  });
});

// ---- detail: A15, A17, B4 -------------------------------------------------------------------------------------------------
describe("application page", () => {
  const UP = (id: string) => `v1/organizations/${ORG}/app-stacks/${id}`;
  const serve = (stack: AppStackDetailDto, backups?: AppStackBackupsDto) =>
    fetchUpstream.mockImplementation(async (p: string) => {
      if (p === UP(stack.id)) return ok(stack);
      if (p === `${UP(stack.id)}/deployments?limit=20`) return ok([]);
      if (p === `${UP(stack.id)}/domains`) return ok([]);
      if (backups && p === `${UP(stack.id)}/backups`) return ok(backups);
      return fail(404, "NOT_FOUND");
    });
  const page = async (stack: AppStackDetailDto, m: Messages = en, backups?: AppStackBackupsDto) => {
    loc.value = m === en ? "en" : "it";
    serve(stack, backups);
    return html(await AppStackPage({ params: Promise.resolve({ stackId: stack.id }) }), m);
  };

  it.each(locales)("A15: a degraded web + cache application names the unhealthy component and says what it is, in words (%s)", async (_l, m) => {
    const h = await page(webStack(), m);
    expect(h).toContain(m.apps.status.degraded);
    expect(h).toContain(format(m.apps.components.summary, { healthy: 1, total: 2 }));
    expect(h).toMatch(new RegExp(`cache</span><div[^>]*>${m.apps.health.unhealthy}<`));
    expect(h).toMatch(new RegExp(`web</span><div[^>]*>${m.apps.health.healthy}<`));
    expect(h).not.toContain(m.apps.status.failed);
  });

  it("A15: a failed stack reads failed, a running one names no unhealthy component", async () => {
    const failed = await page(webStack({ status: "failed" }));
    expect(failed).toContain(en.apps.status.failed);
    expect(failed).not.toContain(en.apps.status.degraded);
    const running = await page(
      webStack({ status: "running", unhealthyCount: 0, components: webStack().components.map((c) => ({ ...c, health: "healthy" as const })) }),
    );
    expect(running).toContain(en.apps.status.running);
    expect(running).not.toContain(en.apps.health.unhealthy);
    expect(running).toContain(format(en.apps.components.summary, { healthy: 2, total: 2 }));
  });

  it.each(locales)("A17: an unknown worker + storage application reads «%s» wording, never the failed wording, and nothing is repeated automatically", async (_l, m) => {
    const h = await page(workerStack(), m);
    expect(h).toContain(m.apps.status.unknown);
    expect(h).toContain(m.apps.detail.unknownBody);
    expect(h).not.toContain(m.apps.status.failed);
    expect(h).not.toContain(m.apps.status.degraded);
    expect(h).not.toContain(m.apps.history.status.failed);
    for (const c of workerStack().components) expect(h).toContain(c.key);
    expect(h).toContain(m.apps.health.unknown);
  });

  it("A17: the Italian unknown state says «Esito da verificare» and never «Non riuscita»", async () => {
    const h = await page(workerStack(), itMsgs);
    expect(h).toContain("Esito da verificare");
    expect(h).not.toContain("Non riuscita");
  });

  it.each(locales)("B4: a backup is offered only where there is data to save, by a button and never by a link (%s)", async (_l, m) => {
    // web + cache keeps no data: one sentence says so and there is no control
    const web = await page(webStack({ status: "running" }), m, { backups: [], unavailableReason: "no_data", goBackTo: null });
    expect(web.split(m.apps.backups.unavailable.no_data)).toHaveLength(2);
    expect(web).not.toContain(`>${m.apps.backups.create}<`);
    expect(web).not.toMatch(/<(button|a|input)[^>]*(backup|restore)/i);
    // worker + storage keeps data: the button and the empty list
    const worker = await page(workerStack({ status: "running" }), m, { backups: [], unavailableReason: null, goBackTo: null });
    expect(worker.split(`>${m.apps.backups.create}</button>`)).toHaveLength(2);
    expect(worker).toContain(m.apps.backups.none);
    expect(worker).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>[^<]*backup/i);
    for (const h of [web, worker]) {
      expect(h).not.toMatch(/href="[^"]*backup/i);
      expect(h).not.toMatch(/\/backups?\b/);
    }
  });

  it("B4: the wizard review says a backup is made by hand from the application's page and offers no backup choice", () => {
    for (const { app } of FIXTURES) {
      const out = html(wizard(app, { 0: "review", 1: "x-app" }).tree);
      expect(out).toContain(en.apps.wizard.backupNote);
      expect(out).not.toMatch(/<(button|input)[^>]*backup/i);
    }
  });
});

// ---- A18 -----------------------------------------------------------------------------------------------------------------
describe("A18: delete keeps the data by default", () => {
  const props = (name: string, hasData: boolean) => ({ orgId: ORG, stackId: "stk_x", csrfToken: "csrf", stackName: name, hasData });
  const submit = (tree: unknown) => (els(tree).find((e) => e.type === "form")!.props.onSubmit as (e: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} });

  it.each([
    ["night-jobs", true],
    ["team-board", false],
  ] as const)("%s: the real request is DELETE {confirmName, destroyData:false}, with the keep-data copy when it stores data", async (name, hasData) => {
    answer({ [`${BASE}/stk_x`]: [{ status: 202, body: { data: { stackId: "stk_x", operationId: "op_d" }, links: {} } }] });
    const { out } = callHooks(AppStackDelete, props(name, hasData), { 0: true, 1: name });
    const h = html(out);
    expect(h.includes(en.apps.delete.keepNote)).toBe(hasData);
    if (hasData) expect(h.match(/<input[^>]*id="app-delete-data"[^>]*>/)![0]).not.toContain("checked");
    await submit(out);
    const [sent] = calls();
    expect(sent!.method).toBe("DELETE");
    expect(sent!.url).toBe(`${BASE}/stk_x`);
    expect(JSON.parse(sent!.raw)).toEqual({ confirmName: name, destroyData: false });
    expect(router.push).toHaveBeenCalledWith("/apps");
  });

  it("a wrong name sends nothing; the data is destroyed only with the box ticked and the name typed", async () => {
    answer({ [`${BASE}/stk_x`]: [{ status: 202, body: { data: { stackId: "stk_x", operationId: "op_d" }, links: {} } }] });
    await submit(callHooks(AppStackDelete, props("night-jobs", true), { 0: true, 1: "night-job", 2: true }).out);
    expect(calls()).toHaveLength(0);
    await submit(callHooks(AppStackDelete, props("night-jobs", true), { 0: true, 1: "night-jobs", 2: true }).out);
    expect(JSON.parse(calls()[0]!.raw)).toEqual({ confirmName: "night-jobs", destroyData: true });
  });

  it("the page tells the delete dialog about stored data from the volumes: yes for worker + storage, no for web + cache", async () => {
    for (const [stack, hasData] of [
      [workerStack(), true],
      [webStack(), false],
    ] as const) {
      fetchUpstream.mockImplementation(async (p: string) => (p === `v1/organizations/${ORG}/app-stacks/${stack.id}` ? ok(stack) : p.endsWith("/domains") || p.includes("/deployments") ? ok([]) : fail(404, "NOT_FOUND")));
      const tree = await AppStackPage({ params: Promise.resolve({ stackId: stack.id }) });
      const del = els(tree).find((e) => e.type === AppStackDelete)!;
      expect(del.props.hasData, stack.id).toBe(hasData);
      expect(del.props.stackName, stack.id).toBe(stack.name);
    }
  });
});

// ---- A19 -----------------------------------------------------------------------------------------------------------------
describe("A19: upgrade and rollback", () => {
  const UPGRADE = { templateVersionId: "atv_webcache_2", versionNumber: 2 };
  const ROLLBACK = { revisionId: "srev_1", revisionNumber: 1, templateVersionNumber: 1 };
  const DIFF: AppStackPlanDiffDto = {
    planHash: `sha256:${"b".repeat(64)}`,
    fromRevisionId: "srev_2",
    fromVersionNumber: 1,
    toTemplateVersionId: "atv_webcache_2",
    toVersionNumber: 2,
    newRevision: true,
    components: [
      { key: "web", change: "updated", restart: true },
      { key: "cache", change: "unchanged", restart: false },
    ],
    volumes: [{ key: "data", change: "unchanged" }],
    parameters: [],
    ingress: [{ componentKey: "web", port: 8080, change: "unchanged" }],
    downtime: true,
    dataRisk: true,
  };
  const actionProps = (status: AppStackDetailDto["status"]) => ({ orgId: ORG, stackId: "stk_web", csrfToken: "csrf", status, upgrade: UPGRADE, rollback: ROLLBACK });
  const planDialog = (tree: unknown) => els(tree).find((e) => typeof e.type === "function" && e.type.name === "PlanDialog")!;
  const open = (mode: "upgrade" | "rollback", m: Messages) => {
    const parent = callHooks(AppStackActions, actionProps("running"), { 4: mode }, {}, m);
    return planDialog(parent.out);
  };
  const run = (d: El, state: Record<number, unknown>, m: Messages) => callHooks(d.type as (p: Record<string, unknown>) => ReactNode, d.props, state, {}, m);

  it.each(locales)("a running application offers both buttons and the page shows the upgrade diff in words with the data warning (%s)", (_l, m) => {
    const buttons = callHooks(AppStackActions, actionProps("running"), {}, {}, m).out;
    expect(button(buttons, format(m.apps.upgrade.open, { n: 2 }))!.props.disabled).toBe(false);
    expect(button(buttons, format(m.apps.rollback.open, { n: 1 }))!.props.disabled).toBe(false);
    const dialog = html(run(open("upgrade", m), { 0: DIFF }, m).out, m);
    expect(dialog).toContain(m.apps.upgrade.componentsTitle);
    expect(dialog).toContain(m.apps.upgrade.change.updated);
    expect(dialog).toContain(m.apps.upgrade.restarts);
    expect(dialog).toContain(m.apps.upgrade.downtime);
    expect(dialog).toContain(m.apps.upgrade.dataWarning);
    expect(dialog).toContain(m.apps.rollback.ack);
  });

  it.each(locales)("a destructive plan cannot be confirmed before the acknowledgement; ticking it enables the button (%s)", (_l, m) => {
    const d = open("rollback", m);
    expect(button(run(d, { 0: DIFF }, m).out, m.apps.rollback.confirm)!.props.disabled).toBe(true);
    expect(button(run(d, { 0: DIFF, 2: true }, m).out, m.apps.rollback.confirm)!.props.disabled).toBe(false);
    expect(button(run(d, { 0: null }, m).out, m.apps.rollback.confirm)!.props.disabled).toBe(true);
  });

  it("confirming sends the hash of the plan that was shown, once, with CSRF and a key, then refreshes", async () => {
    answer({ [`${BASE}/stk_web/upgrade`]: [{ status: 202, body: { data: { stackId: "stk_web", operationId: "op_u" }, links: {} } }] });
    await click(button(run(open("upgrade", en), { 0: DIFF, 2: true }, en).out, en.apps.upgrade.confirm));
    const sent = calls();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.headers["X-CSRF-Token"]).toBe("csrf");
    expect(sent[0]!.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(sent[0]!.raw)).toEqual({ templateVersionId: "atv_webcache_2", planHash: DIFF.planHash });
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("a stack that is stopping, deleting or deleted cannot be upgraded or rolled back", () => {
    for (const status of ["deleting", "deleted", "stopping", "queued"] as const) {
      const tree = callHooks(AppStackActions, actionProps(status)).out;
      expect(button(tree, format(en.apps.upgrade.open, { n: 2 }))!.props.disabled, status).toBe(true);
      expect(button(tree, format(en.apps.rollback.open, { n: 1 }))!.props.disabled, status).toBe(true);
    }
  });
});
