import fs from "node:fs";
import path from "node:path";
import * as React from "react";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_STACK_PROCESS_MARKS, APP_STACK_SECRET_ENV_LIMITS, type AppTemplateParameter, type CustomerAppTemplateDto } from "@hosting-panel/contracts";

const mockData = vi.hoisted(() => ({ getCustomerContext: vi.fn() }));
const fetchUpstream = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("@/app/sites/data", () => mockData);
vi.mock("@/lib/server-session", () => ({ getServerSession: async () => ({ accessToken: "tok", csrfToken: "csrf" }) }));
vi.mock("@/lib/upstream", () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => "en" }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => router,
  useParams: () => ({}),
  usePathname: () => "/apps/new/atpl_notes",
}));

import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { format, type Messages } from "@/i18n";
import { I18nProvider } from "@/i18n/provider";
import AppWizardPage from "@/app/apps/new/[templateId]/page";
import { appStackRefusalText } from "@/components/app-stacks/app-stack-view";
import { AppWizard, buildAppParameterEntries, buildDomainEntries, missingSecretKeys, wizardErrorView } from "@/components/app-stacks/app-wizard";

const NOW = "2026-11-22T10:00:00.000Z";
const ORG = "org_a1";
const PLANTED = "S3cr3t-planted";
const t = en.apps.wizard;

const PARAMS: CustomerAppTemplateDto["parameters"] = [
  { key: "title", label: "Board title", type: "string", default: "My notes", customer: true },
  { key: "port", label: "Listen port", type: "integer", min: 1024, max: 65535, default: 8080, customer: true },
  { key: "mode", label: "Mode", type: "enum", options: ["small", "large"], default: "small", customer: true },
  { key: "public", label: "Public board", type: "boolean", default: false, customer: true },
  { key: "admin_password", label: "Admin password", type: "secret", required: true, customer: true },
  { key: "api_token", label: "API token", type: "secret", required: false, customer: true },
  { key: "cache_size", label: "Cache size hidden", type: "size", default: "64m", customer: false },
];
const ENTRY: CustomerAppTemplateDto = {
  id: "atpl_notes",
  name: "Notes",
  description: "Shared notes for the team.",
  category: "content",
  versionId: "atv_notes_2",
  versionNumber: 2,
  componentCount: 2,
  cpuMilli: 500,
  memoryBytes: String(256 * 2 ** 20),
  volumeCount: 1,
  hasIngress: true,
  parameters: PARAMS,
  ingress: [
    { componentKey: "web", port: 8080 },
    { componentKey: "admin", port: 9000 },
  ],
  components: [
    { key: "admin", cpuMilli: 250, memoryBytes: String(128 * 2 ** 20) },
    { key: "web", cpuMilli: 250, memoryBytes: String(128 * 2 ** 20) },
  ],
};
const NO_SECRETS: CustomerAppTemplateDto = { ...ENTRY, parameters: PARAMS.filter((p) => p.type !== "secret") };

const html = (node: ReactNode, m: Messages = en) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: node }))
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

// Calls a client component once with stand-in hooks; `state` presets useState slots and `refs` useRef slots, by call order.
const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
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
    return { tree: C(props), sets };
  } finally {
    internals.H = prev;
  }
}
type El = ReactElement<Record<string, unknown>>;
const els = (node: unknown): El[] => {
  if (Array.isArray(node)) return node.flatMap(els);
  if (!React.isValidElement(node)) return [];
  return [node as El, ...els((node.props as Record<string, unknown>).children)];
};
const textOf = (node: unknown): string =>
  typeof node === "string" || typeof node === "number"
    ? String(node)
    : Array.isArray(node)
      ? node.map(textOf).join("")
      : React.isValidElement(node)
        ? textOf((node.props as Record<string, unknown>).children)
        : "";
const click = (tree: ReactNode, label: string) => {
  const button = els(tree).find((e) => typeof e.props.onClick === "function" && textOf(e) === label);
  if (!button) throw new Error(`no button ${label}`);
  return (button.props.onClick as () => Promise<void> | void)();
};
const props = (entry: CustomerAppTemplateDto = ENTRY) => ({ orgId: ORG, csrfToken: "csrf", entry });
const wizard = (state: Record<number, unknown> = {}, refs: Record<number, unknown> = {}, entry = ENTRY, m: Messages = en) =>
  callHooks(AppWizard, props(entry), state, refs, m);
const secretsRef = (values: Record<string, string>) => ({ current: new Map(Object.entries(values)) });

const BASE = `/api/bff/orgs/${ORG}/app-stacks`;
/** `text`: a body that is not JSON; `cut`: the connection drops after the status line, so reading the body fails. */
type Answer = { status: number; body: unknown } | { status: number; text: string } | { status: number; cut: true } | "network";
const fetchMock = vi.fn();
/** Each URL answers with the next of its queue. */
function answer(byUrl: Record<string, Answer[]>) {
  fetchMock.mockImplementation(async (url: string) => {
    const a = byUrl[url]?.shift();
    if (!a) throw new Error(`unexpected ${url}`);
    if (a === "network") throw new TypeError("fetch failed");
    if ("text" in a) return new Response(a.text, { status: a.status, headers: { "Content-Type": "text/html" } });
    if ("cut" in a) return new Response(new ReadableStream({ start: (c) => c.error(new TypeError("terminated")) }), { status: a.status });
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json" } });
  });
}
const notJson = (status: number): Answer => ({ status, text: "<html><body>Created</body></html>" });
const cut = (status: number): Answer => ({ status, cut: true });
const calls = () =>
  fetchMock.mock.calls.map((c) => {
    const init = c[1] as RequestInit;
    return { url: c[0] as string, method: init.method, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
  });
const accepted = (status: number) => ({ status, body: { data: { stackId: "stk_a1", operationId: status === 202 ? "op_1" : null }, links: {} } });
const secretSaved = (key: string) => ({ status: 200, body: { data: { key, isSet: true, version: 1, setAt: NOW } } });
const refusal = (status: number, code: string, details: { field?: string; reason?: string }[] = []) => ({ status, body: { error: { code, message: "x", details } } });

beforeEach(() => {
  vi.clearAllMocks();
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

describe("buildAppParameterEntries", () => {
  it("sends typed public values only, in source order: blank omitted, integers converted, booleans kept, secrets and hidden settings never", () => {
    expect(buildAppParameterEntries(PARAMS, {})).toEqual([]);
    const inputs = { title: "  ", port: "9000", mode: "large", public: false, admin_password: PLANTED, api_token: PLANTED, cache_size: "1g" };
    expect(buildAppParameterEntries(PARAMS, inputs)).toEqual([
      { key: "port", value: 9000 },
      { key: "mode", value: "large" },
      { key: "public", value: false },
    ]);
    expect(buildAppParameterEntries(PARAMS, { title: "Team board", port: "-42" })).toEqual([
      { key: "title", value: "Team board" },
      { key: "port", value: -42 },
    ]);
    for (const text of ["12.5", "1e3", "12345678901"]) expect(buildAppParameterEntries(PARAMS, { port: text })).toEqual([{ key: "port", value: text }]);
  });

  it("reads own keys only: a setting named constructor or __proto__ is never taken from the prototype", () => {
    const odd: AppTemplateParameter[] = [
      { key: "constructor", label: "A", type: "string", default: "", customer: true },
      { key: "__proto__", label: "B", type: "string", default: "", customer: true },
    ];
    expect(buildAppParameterEntries(odd, {})).toEqual([]);
    expect(buildAppParameterEntries(odd, JSON.parse('{"__proto__":"x","constructor":"y"}'))).toEqual([
      { key: "constructor", value: "y" },
      { key: "__proto__", value: "x" },
    ]);
  });
});

describe("missingSecretKeys and buildDomainEntries", () => {
  it("names the required private values not typed yet", () => {
    expect(missingSecretKeys(PARAMS, new Set())).toEqual(["admin_password"]);
    expect(missingSecretKeys(PARAMS, new Set(["admin_password"]))).toEqual([]);
    expect(missingSecretKeys(PARAMS, new Set(["api_token"]))).toEqual(["admin_password"]);
  });

  it("trims and lower-cases hostnames, drops blank rows and resolves the target index", () => {
    const rows = [
      { hostname: "  Notes.Example.TEST ", target: 1 },
      { hostname: "   ", target: 0 },
      { hostname: "b.example.test", target: 0 },
    ];
    expect(buildDomainEntries(rows, ENTRY.ingress)).toEqual([
      { hostname: "notes.example.test", componentKey: "admin", port: 9000, compression: true },
      { hostname: "b.example.test", componentKey: "web", port: 8080, compression: true },
    ]);
    expect(buildDomainEntries([], ENTRY.ingress)).toEqual([]);
  });
});

describe("wizardErrorView", () => {
  it("maps located refusals to their field and step; the first located field decides the step", () => {
    const param = wizardErrorView(en, "VALIDATION_ERROR", [{ field: "parameters.port", reason: "STACK_PARAMETER_INVALID" }]);
    expect(param).toEqual({
      error: en.apps.reasons.STACK_PARAMETER_INVALID,
      fieldErrors: { "param:port": en.apps.reasons.STACK_PARAMETER_INVALID },
      step: "configure",
    });
    expect(wizardErrorView(en, "ALREADY_EXISTS", [{ field: "name", reason: "name_taken" }])).toEqual({
      error: en.apps.reasons.name_taken,
      fieldErrors: { name: en.apps.reasons.name_taken },
      step: "configure",
    });
    const domain = wizardErrorView(en, "DOMAIN_CONFLICT", [{ field: "domains.1.hostname" }, { field: "name", reason: "name_taken" }]);
    expect(domain.step).toBe("domains");
    expect(domain.fieldErrors).toEqual({ "domain:1": en.apps.codes.DOMAIN_CONFLICT, name: en.apps.reasons.name_taken });
    expect(domain.error).toBe(en.apps.codes.DOMAIN_CONFLICT);
    const unlocated = wizardErrorView(itMsgs, "VALIDATION_ERROR", [
      { field: "templateVersionId", reason: "STACK_TEMPLATE_INVALID" },
      { field: "parameters.title", reason: "STACK_PARAMETER_INVALID" },
    ]);
    expect(unlocated.error).toBe(itMsgs.apps.reasons.STACK_TEMPLATE_INVALID);
    expect(unlocated.step).toBe("configure");
    expect(Object.keys(unlocated.fieldErrors)).toEqual(["param:title"]);
    expect(wizardErrorView(en, "QUOTA_EXCEEDED", [])).toEqual({ error: en.apps.codes.QUOTA_EXCEEDED, fieldErrors: {}, step: null });
    expect(wizardErrorView(en, "", []).error).toBe(en.errors.generic);
  });

  it.each([
    ["en", en],
    ["it", itMsgs],
  ] as const)("an address held by someone else that names no row goes back to the addresses step with its sentence (%s)", (_l, m) => {
    expect(wizardErrorView(m, "DOMAIN_CONFLICT", [])).toEqual({ error: m.apps.codes.DOMAIN_CONFLICT, fieldErrors: {}, step: "domains" });
    expect(wizardErrorView(m, "CERTIFICATE_IN_USE", [{ field: "hostname" }])).toEqual({ error: m.apps.codes.CERTIFICATE_IN_USE, fieldErrors: {}, step: "domains" });
    expect(wizardErrorView(m, "DOMAIN_CONFLICT", [{ field: "name", reason: "name_taken" }]).step).toBe("configure");
  });

  it.each([
    ["en", en],
    ["it", itMsgs],
  ] as const)("a setting only the application decides reads as its own sentence on that field (%s)", (_l, m) => {
    const view = wizardErrorView(m, "VALIDATION_ERROR", [{ field: "parameters.port", reason: "PARAM_VALUE_NOT_CUSTOMER" }]);
    expect(view.fieldErrors).toEqual({ "param:port": m.apps.reasons.PARAM_VALUE_NOT_CUSTOMER });
    expect(view.error).toBe(m.apps.reasons.PARAM_VALUE_NOT_CUSTOMER);
  });
});

describe("AppWizard markup", () => {
  it("configure: a labelled field per customer setting, write-only private inputs, never a hidden setting", () => {
    const out = html(wizard().tree);
    expect(out).toMatch(/aria-current="step"[^>]*>Configure/);
    expect(out).toMatch(/<section aria-labelledby="app-step-title"[^>]*><h2 id="app-step-title"[^>]*>Configure<\/h2>/);
    for (const id of ["app-name", ...PARAMS.filter((p) => p.customer).map((p) => `app-param-${p.key}`)]) {
      expect(out).toMatch(new RegExp(`<label[^>]*for="${id}"`));
      expect(out).toMatch(new RegExp(`id="${id}"[^>]*aria-describedby="${id}-note"`));
    }
    expect(out).toMatch(/id="app-name"[^>]*maxLength="64"/);
    expect(out).not.toContain("app-param-cache_size");
    expect(out).not.toContain("Cache size hidden");
    expect(out).toMatch(/<select[^>]*id="app-param-mode"/);
    expect(out).toMatch(/<input type="number"[^>]*id="app-param-port"[^>]*min="1024"[^>]*max="65535"/);
    expect(out).toMatch(/<input type="checkbox"[^>]*id="app-param-public"/);
    expect(out).toContain("Default: 8080");
    for (const key of ["admin_password", "api_token"]) {
      const input = out.match(new RegExp(`<input[^>]*id="app-param-${key}"[^>]*>`))![0];
      expect(input).toMatch(/type="password"/);
      expect(input).toMatch(/autoComplete="new-password"/i);
      expect(input).toMatch(/spellCheck="false"/i);
      expect(input).not.toMatch(/\svalue=/);
    }
    expect(out).toContain(t.secretHint);
    expect(out).not.toContain(t.secretKept);
    for (const key of ["admin_password", "api_token"]) expect(out).toMatch(new RegExp(`<input[^>]*id="app-param-${key}"[^>]*maxLength="16384"`));
  });

  it("configure: a field error is aria-invalid with its text; a private value typed before a step back is said to be kept", () => {
    const out = html(wizard({ 2: { port: "80" }, 3: ["admin_password"], 5: { "param:port": "Port out of range", name: t.required } }).tree);
    expect(out).toMatch(/id="app-param-port"[^>]*aria-invalid="true"/);
    expect(out).toMatch(/id="app-param-port-note"[^>]*>Port out of range</);
    expect(out).toMatch(/id="app-name"[^>]*aria-invalid="true"/);
    expect(out).toContain(t.secretKept);
  });

  it("typing a private value keeps it in the reference only, never in state", () => {
    const values = secretsRef({});
    const { tree, sets } = wizard({}, { 0: values });
    const input = els(tree).find((e) => e.props.id === "app-param-admin_password")!;
    (input.props.onChange as (e: unknown) => void)({ target: { value: PLANTED } });
    expect(values.current.get("admin_password")).toBe(PLANTED);
    expect(sets).toEqual([[3, ["admin_password"]]]);
    const after = wizard({ 3: ["admin_password"] }, { 0: values });
    const again = els(after.tree).find((e) => e.props.id === "app-param-admin_password")!;
    (again.props.onChange as (e: unknown) => void)({ target: { value: "" } });
    expect(values.current.has("admin_password")).toBe(false);
    expect(after.sets).toEqual([[3, []]]);
  });

  it("Next refuses a blank name and a missing required private value, else goes to Domains", () => {
    const blocked = wizard();
    click(blocked.tree, t.next);
    expect(blocked.sets).toEqual([[5, { name: t.required, "param:admin_password": t.required }]]);
    const ok = wizard({ 1: "team-notes", 3: ["admin_password"] });
    click(ok.tree, t.next);
    expect(ok.sets).toEqual([
      [5, {}],
      [0, "domains"],
    ]);
  });

  it("Next refuses a private value or a text setting that carries a platform process mark, and says why (ADR-0041)", () => {
    const values = secretsRef({ admin_password: "pw HP_TERMINAL_SESSION=term_", api_token: "APP_ENV=production\nPHP_CLI_SERVER_WORKERS=4\n" });
    const refused = wizard({ 1: "team-notes", 2: { title: "Board xHP_TASK_RUN=srun_1" }, 3: ["admin_password", "api_token"] }, { 0: values });
    click(refused.tree, t.next);
    expect(refused.sets).toEqual([[5, { "param:title": t.valueReserved, "param:admin_password": t.valueReserved }]]);
    expect(JSON.stringify(refused.sets)).not.toContain("term_");
    // The sentence names every mark, so it stays true when the list changes.
    // A customer page names no internal word of the panel (m5b-web-qa): the sentence says what to look for, not the marks.
    for (const m of [en, itMsgs]) {
      expect(m.apps.wizard.valueReserved).toContain("«HP_»");
      for (const mark of APP_STACK_PROCESS_MARKS) expect(m.apps.wizard.valueReserved).not.toContain(mark);
    }
  });

  it("Next accepts text that only looks like a mark: PHP settings, other HP_ text", () => {
    const values = secretsRef({ admin_password: "APP_ENV=production\nPHP_CLI_SERVER_WORKERS=4\n", api_token: "SHP_X=1 HP_HOME=/x" });
    for (const title of ["Corso PHP_8", "-d PHP_INI_SCAN_DIR=/x", "ends with HP_TERMINAL_"]) {
      const ok = wizard({ 1: "team-notes", 2: { title }, 3: ["admin_password", "api_token"] }, { 0: values });
      click(ok.tree, t.next);
      expect(ok.sets, title).toEqual([
        [5, {}],
        [0, "domains"],
      ]);
    }
  });

  it("domains: labelled hostname and target per row, a named remove button, blank rows dropped on Next", () => {
    const rows = [
      { hostname: "notes.example.test", target: 1 },
      { hostname: " ", target: 0 },
    ];
    const { tree, sets } = wizard({ 0: "domains", 4: rows, 5: { "domain:0": "Taken" } });
    const out = html(tree);
    expect(out).toContain(t.domainsHint);
    expect(out).toMatch(/<label[^>]*for="app-domain-0"[^>]*>Web address 1</);
    expect(out).toMatch(/id="app-domain-0"[^>]*inputMode="url"/i);
    expect(out).toMatch(/id="app-domain-0"[^>]*aria-invalid="true"/);
    expect(out).toContain("Taken");
    expect(out).toMatch(/<label[^>]*for="app-domain-0-target"/);
    expect(out).toContain("admin on port 9000");
    expect(out).toMatch(/aria-label="Remove address 2"[^>]*>Remove</);
    click(tree, t.next);
    expect(sets).toContainEqual([4, [rows[0]]]);
    expect(sets).toContainEqual([0, "review"]);
    const single = html(wizard({ 0: "domains", 4: rows }, {}, { ...ENTRY, ingress: [ENTRY.ingress[0]!] }).tree);
    expect(single).not.toContain("app-domain-0-target");
    expect(html(wizard({ 0: "domains" }, {}, { ...ENTRY, ingress: [] }).tree)).toContain(t.noDomains);
  });

  it("Next on the addresses step checks each address like the server and names repeats; blank rows are skipped, the step stays", () => {
    const rows = [
      { hostname: "https://shop.example.com", target: 0 },
      { hostname: " ", target: 0 },
      { hostname: "Shop.example.com", target: 0 },
      { hostname: "shop.example.com.", target: 1 },
      { hostname: "shop", target: 0 },
    ];
    const { tree, sets } = wizard({ 0: "domains", 4: rows });
    click(tree, t.next);
    expect(sets).toEqual([[5, { "domain:0": t.domainInvalid, "domain:3": t.domainRepeated, "domain:4": t.domainInvalid }]]);
    const ok = wizard({ 0: "domains", 4: [{ hostname: " Shop.Example.com ", target: 0 }, { hostname: "", target: 0 }, { hostname: "bücher.example.test", target: 1 }] });
    click(ok.tree, t.next);
    expect(ok.sets).toContainEqual([5, {}]);
    expect(ok.sets).toContainEqual([0, "review"]);
  });

  it("review: values or defaults, «Set» for a typed private value, never the value itself, at any step", () => {
    const values = secretsRef({ admin_password: PLANTED });
    const state = { 1: "team-notes", 2: { port: "9000" }, 3: ["admin_password"], 4: [{ hostname: "Notes.example.test", target: 0 }] };
    const out = html(wizard({ ...state, 0: "review" }, { 0: values }).tree);
    expect(out).toContain("team-notes");
    expect(out).toContain("Notes, version 2");
    expect(out).toContain("9000");
    expect(out).toContain("Default: My notes");
    expect(out).toMatch(/Admin password<\/dt><dd[^>]*>Set</);
    expect(out).toMatch(/API token<\/dt><dd[^>]*>Not set</);
    expect(out).toContain("notes.example.test");
    expect(out).toContain("CPU 0.5 vCPU · Memory 256 MiB");
    expect(out).toContain(t.dataNote);
    expect(out).toContain(en.apps.wizard.backupNote);
    for (const step of ["configure", "domains", "review", "install"]) {
      for (const m of [en, itMsgs]) expect(html(wizard({ ...state, 0: step }, { 0: values }, ENTRY, m).tree, m)).not.toContain(PLANTED);
    }
  });
});

describe("AppWizard install", () => {
  const ready = { 0: "review", 1: " team-notes ", 2: { port: "9000" }, 3: ["admin_password", "api_token"], 4: [{ hostname: "Notes.Example.test", target: 0 }] };

  it("creates a draft without any private value, sends each one to its own route, then deploys and opens the application", async () => {
    answer({
      [BASE]: [accepted(201)],
      [`${BASE}/stk_a1/secrets`]: [secretSaved("admin_password"), secretSaved("api_token")],
      [`${BASE}/stk_a1/deploy`]: [accepted(202)],
    });
    const values = secretsRef({ admin_password: PLANTED, api_token: `${PLANTED}-2` });
    const { tree, sets } = wizard(ready, { 0: values });
    await click(tree, t.install);
    const sent = calls();
    expect(sent.map((c) => c.url)).toEqual([BASE, `${BASE}/stk_a1/secrets`, `${BASE}/stk_a1/secrets`, `${BASE}/stk_a1/deploy`]);
    expect(sent[0]!.body).toEqual({
      templateVersionId: "atv_notes_2",
      name: "team-notes",
      parameters: [{ key: "port", value: 9000 }],
      domains: [{ hostname: "notes.example.test", componentKey: "web", port: 8080, compression: true }],
      deploy: false,
    });
    expect(sent[1]!.body).toEqual({ parameterKey: "admin_password", value: PLANTED });
    expect(sent[2]!.body).toEqual({ parameterKey: "api_token", value: `${PLANTED}-2` });
    expect(sent[3]!.body).toEqual({});
    for (const [i, c] of sent.entries()) {
      expect(c.method).toBe("POST");
      expect(c.headers["X-CSRF-Token"]).toBe("csrf");
      expect(c.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(c.url).not.toContain(PLANTED);
      if (i !== 1 && i !== 2) expect(JSON.stringify(c.body)).not.toContain(PLANTED);
    }
    expect(values.current.size).toBe(0);
    expect(sets).toContainEqual([8, "stk_a1"]);
    expect(sets).toContainEqual([3, []]);
    expect(JSON.stringify(sets)).not.toContain(PLANTED);
    expect(router.push).toHaveBeenCalledWith("/apps/stk_a1");
  });

  it("without private values: one create with deploy:true, then the application page", async () => {
    answer({ [BASE]: [accepted(202)] });
    const { tree } = wizard({ ...ready, 3: [] }, {}, NO_SECRETS);
    await click(tree, t.install);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.body.deploy).toBe(true);
    expect(router.push).toHaveBeenCalledWith("/apps/stk_a1");
  });

  it("a located 400 goes back to Configure with the field error; nothing else is sent", async () => {
    answer({ [BASE]: [refusal(400, "VALIDATION_ERROR", [{ field: "parameters.port", reason: "STACK_PARAMETER_INVALID" }])] });
    const { tree, sets } = wizard(ready, { 0: secretsRef({ admin_password: PLANTED }) });
    await click(tree, t.install);
    expect(calls()).toHaveLength(1);
    expect(sets).toContainEqual([5, { "param:port": en.apps.reasons.STACK_PARAMETER_INVALID }]);
    expect(sets).toContainEqual([0, "configure"]);
    expect(sets).toContainEqual([7, false]);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("an address in use with no row named goes back to the addresses step with its sentence", async () => {
    answer({ [BASE]: [refusal(409, "DOMAIN_CONFLICT")] });
    const { tree, sets } = wizard({ ...ready, 3: [] }, {}, NO_SECRETS);
    await click(tree, t.install);
    expect(sets).toContainEqual([0, "domains"]);
    expect(sets).toContainEqual([6, en.apps.codes.DOMAIN_CONFLICT]);
    expect(sets).toContainEqual([7, false]);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("keeps the create key after a lost reply or a 5xx, renews it after a 4xx", async () => {
    const keys = { current: {} as Record<string, string> };
    answer({ [BASE]: ["network", refusal(503, "UPSTREAM_UNAVAILABLE"), refusal(409, "ALREADY_EXISTS", [{ field: "name", reason: "name_taken" }]), accepted(202)] });
    const run = async () => {
      const { tree, sets } = wizard({ ...ready, 0: "install", 3: [], 6: "x" }, { 1: keys }, NO_SECRETS);
      await click(tree, t.retry);
      return sets;
    };
    expect(await run()).toContainEqual([6, t.createUnknown]);
    await run();
    expect(await run()).toContainEqual([5, { name: en.apps.reasons.name_taken }]);
    await run();
    const used = calls().map((c) => c.headers["Idempotency-Key"]);
    expect(used[1]).toBe(used[0]);
    expect(used[2]).toBe(used[0]);
    expect(used[3]).not.toBe(used[0]);
  });

  it("a private value that fails: the draft is kept, the error links to it, and a retry skips the create", async () => {
    answer({ [BASE]: [accepted(201)], [`${BASE}/stk_a1/secrets`]: [secretSaved("admin_password"), refusal(500, "INTERNAL")] });
    const values = secretsRef({ admin_password: PLANTED, api_token: "later" });
    const first = wizard(ready, { 0: values });
    await click(first.tree, t.install);
    expect(first.sets).toContainEqual([8, "stk_a1"]);
    expect(first.sets).toContainEqual([6, t.secretFailed]);
    expect(first.sets).toContainEqual([3, ["api_token"]]);
    expect(calls().map((c) => c.url)).not.toContain(`${BASE}/stk_a1/deploy`);
    expect([...values.current.keys()]).toEqual(["api_token"]);

    const failed = { ...ready, 0: "install", 3: ["api_token"], 6: t.secretFailed, 8: "stk_a1" };
    const out = html(wizard(failed, { 0: values }).tree);
    expect(out).toMatch(new RegExp(`role="alert"[^>]*>.*${t.secretFailed}`));
    expect(out).toMatch(/<a[^>]*href="\/apps\/stk_a1"[^>]*>Open the application</);

    fetchMock.mockReset();
    answer({ [`${BASE}/stk_a1/secrets`]: [secretSaved("api_token")], [`${BASE}/stk_a1/deploy`]: [accepted(202)] });
    await click(wizard(failed, { 0: values }).tree, t.retry);
    expect(calls().map((c) => c.url)).toEqual([`${BASE}/stk_a1/secrets`, `${BASE}/stk_a1/deploy`]);
    expect(router.push).toHaveBeenCalledWith("/apps/stk_a1");
  });

  it("a refused deploy says why and links to the draft", async () => {
    answer({ [`${BASE}/stk_a1/deploy`]: [refusal(400, "VALIDATION_ERROR", [{ reason: "STACK_SECRET_MISSING" }])] });
    const { tree, sets } = wizard({ ...ready, 0: "install", 3: [], 6: "x", 8: "stk_a1" });
    await click(tree, t.retry);
    expect(sets).toContainEqual([6, appStackRefusalText(en, "VALIDATION_ERROR", "STACK_SECRET_MISSING")]);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("a draft whose version is no longer offered says to delete it and install again", async () => {
    answer({ [`${BASE}/stk_a1/deploy`]: [refusal(400, "VALIDATION_ERROR", [{ field: "templateVersionId", reason: "STACK_TEMPLATE_UNPUBLISHED" }])] });
    const { tree, sets } = wizard({ ...ready, 0: "install", 3: [], 6: "x", 8: "stk_a1" });
    await click(tree, t.retry);
    expect(sets).toContainEqual([6, en.apps.reasons.draftUnpublished]);
  });
});

/** What the customer can press or follow, in page order. */
const actions = (tree: ReactNode) => els(tree).filter((e) => typeof e.props.onClick === "function" || typeof e.props.href === "string").map(textOf);
const editable = (tree: ReactNode) => els(tree).filter((e) => typeof e.props.onChange === "function").map((e) => e.props.id);

describe("AppWizard after the application is created", () => {
  const ready = { 0: "review", 1: " team-notes ", 2: { port: "9000" }, 3: ["admin_password", "api_token"], 4: [{ hostname: "Notes.Example.test", target: 0 }] };
  const AT = `${BASE}/stk_a1`;
  const hrefOf = (tree: ReactNode, label: string) => els(tree).find((e) => typeof e.props.href === "string" && textOf(e) === label)?.props.href;

  it("a private value lost to a server error: no way back to the earlier steps, the screen shows what was sent, Retry sends only what is left", async () => {
    answer({ [BASE]: [accepted(201)], [`${AT}/secrets`]: [refusal(503, "UPSTREAM_UNAVAILABLE")] });
    const values = secretsRef({ admin_password: PLANTED, api_token: `${PLANTED}-2` });
    const first = wizard(ready, { 0: values });
    await click(first.tree, t.install);
    expect(calls().map((c) => c.url)).toEqual([BASE, `${AT}/secrets`]);
    expect(calls()[0]!.body.name).toBe("team-notes");
    const lost = appStackRefusalText(en, "UPSTREAM_UNAVAILABLE");
    expect(first.sets).toContainEqual([8, "stk_a1"]);
    expect(first.sets).toContainEqual([6, t.secretFailed]);
    expect(first.sets.filter(([k]) => k === 0)).toEqual([[0, "install"]]);

    // An open earlier step would take a changed name into the summary and never send it: whatever step the state names, none opens.
    const failed = { ...ready, 0: "install", 5: { "param:admin_password": lost }, 6: t.secretFailed, 8: "stk_a1" };
    for (const step of ["install", "review", "domains", "configure"]) {
      const { tree } = wizard({ ...failed, 0: step }, { 0: values });
      expect(actions(tree), step).toEqual([t.openApp, t.retry]);
      expect(hrefOf(tree, t.openApp), step).toBe("/apps/stk_a1");
      expect(editable(tree), step).toEqual(["app-param-admin_password", "app-param-api_token"]);
      const out = html(tree);
      expect(out, step).toMatch(/aria-current="step"[^>]*>Install/);
      expect(out, step).toContain(t.created);
      expect(out, step).toMatch(/Application name<\/dt><dd[^>]*>team-notes</);
      expect(out, step).toMatch(/Listen port<\/dt><dd[^>]*>9000</);
      expect(out, step).toMatch(/<li>notes\.example\.test · web on port 8080<\/li>/);
      expect(out, step).toMatch(new RegExp(`Admin password</dt><dd[^>]*>${t.secretPending}<`));
      expect(out, step).toMatch(/id="app-param-admin_password"[^>]*aria-invalid="true"/);
      expect(out, step).toMatch(new RegExp(`id="app-param-admin_password-note"[^>]*>${lost}<`));
      expect(out, step).toMatch(new RegExp(`id="app-param-api_token-note"[^>]*>${t.secretHint} ${t.secretKept}<`));
      expect(out, step).not.toContain(PLANTED);
    }
    expect(first.sets).toContainEqual([5, { "param:admin_password": lost }]);

    fetchMock.mockReset();
    answer({ [`${AT}/secrets`]: [secretSaved("admin_password"), secretSaved("api_token")], [`${AT}/deploy`]: [accepted(202)] });
    const retry = wizard(failed, { 0: values });
    await click(retry.tree, t.retry);
    expect(calls().map((c) => c.url)).toEqual([`${AT}/secrets`, `${AT}/secrets`, `${AT}/deploy`]);
    expect(calls().map((c) => c.body)).toEqual([{ parameterKey: "admin_password", value: PLANTED }, { parameterKey: "api_token", value: `${PLANTED}-2` }, {}]);
    expect(retry.sets).toContainEqual([9, ["admin_password", "api_token"]]);
    expect(values.current.size).toBe(0);
    expect(router.push).toHaveBeenCalledWith("/apps/stk_a1");
  });

  it("a private value refused as too long: its field states the limit, the saved one reads «Saved» and is not sent again, Retry sends the value typed again", async () => {
    const tooLong = refusal(400, "VALIDATION_ERROR", [{ field: "value", reason: "value_too_long" }]);
    answer({ [BASE]: [accepted(201)], [`${AT}/secrets`]: [secretSaved("admin_password"), tooLong] });
    const values = secretsRef({ admin_password: PLANTED, api_token: "x".repeat(5000) });
    const first = wizard(ready, { 0: values });
    await click(first.tree, t.install);
    const limit = format(en.apps.reasons.value_too_long, { max: APP_STACK_SECRET_ENV_LIMITS.secretBytes });
    expect(first.sets).toContainEqual([5, { "param:api_token": limit }]);
    expect(first.sets).toContainEqual([6, t.secretFailed]);
    expect(first.sets).toContainEqual([3, ["api_token"]]);
    expect(first.sets).toContainEqual([9, ["admin_password"]]);
    expect([...values.current.keys()]).toEqual(["api_token"]);

    const failed = { ...ready, 0: "install", 3: ["api_token"], 6: t.secretFailed, 8: "stk_a1", 9: ["admin_password"] };
    for (const m of [en, itMsgs]) {
      const text = appStackRefusalText(m, "VALIDATION_ERROR", "value_too_long");
      expect(text).toContain(String(APP_STACK_SECRET_ENV_LIMITS.secretBytes));
      const { tree } = wizard({ ...failed, 5: { "param:api_token": text }, 6: m.apps.wizard.secretFailed }, { 0: values }, ENTRY, m);
      expect(editable(tree)).toEqual(["app-param-api_token"]);
      const out = html(tree, m);
      expect(out).toMatch(new RegExp(`Admin password</dt><dd[^>]*>${m.apps.wizard.secretSaved}<`));
      expect(out).not.toContain(m.apps.wizard.required);
      expect(out).toMatch(/id="app-param-api_token"[^>]*aria-invalid="true"/);
      expect(out).toContain(`id="app-param-api_token-note" class="text-xs text-destructive">${text}<`);
    }

    const retyped = { current: new Map<string, string>() };
    const again = wizard(failed, { 0: values, 2: retyped });
    const input = els(again.tree).find((e) => e.props.id === "app-param-api_token")!;
    (input.props.onChange as (e: unknown) => void)({ target: { value: "short" } });
    expect(again.sets).toEqual([]);
    expect(retyped.current.get("api_token")).toBe("short");
    fetchMock.mockReset();
    answer({ [`${AT}/secrets`]: [secretSaved("api_token")], [`${AT}/deploy`]: [accepted(202)] });
    await click(again.tree, t.retry);
    expect(calls().map((c) => c.body)).toEqual([{ parameterKey: "api_token", value: "short" }, {}]);
    expect(values.current.size).toBe(0);
    expect(retyped.current.size).toBe(0);
    expect(router.push).toHaveBeenCalledWith("/apps/stk_a1");
  });

  it("a field left empty keeps the value typed before; typing then clearing it goes back to that value", async () => {
    const values = secretsRef({ api_token: "kept" });
    const retyped = { current: new Map<string, string>() };
    const { tree } = wizard({ ...ready, 0: "install", 3: ["api_token"], 6: t.secretFailed, 8: "stk_a1", 9: ["admin_password"] }, { 0: values, 2: retyped });
    const input = els(tree).find((e) => e.props.id === "app-param-api_token")!;
    for (const value of ["k", "ke", "k", ""]) (input.props.onChange as (e: unknown) => void)({ target: { value } });
    answer({ [`${AT}/secrets`]: [secretSaved("api_token")], [`${AT}/deploy`]: [accepted(202)] });
    await click(tree, t.retry);
    expect(calls()[0]!.body).toEqual({ parameterKey: "api_token", value: "kept" });
  });

  it("a refused install after every value is saved: nothing is sent again but the install, the page says the application exists", async () => {
    answer({ [`${AT}/deploy`]: [refusal(409, "RESOURCE_LOCKED")] });
    const { tree, sets } = wizard({ ...ready, 0: "install", 3: [], 6: "x", 8: "stk_a1", 9: ["admin_password", "api_token"] });
    expect(editable(tree)).toEqual([]);
    const out = html(tree);
    expect(out).toMatch(new RegExp(`Admin password</dt><dd[^>]*>${t.secretSaved}<`));
    expect(out).toMatch(new RegExp(`API token</dt><dd[^>]*>${t.secretSaved}<`));
    expect(out).toContain(t.created);
    await click(tree, t.retry);
    expect(calls().map((c) => c.url)).toEqual([`${AT}/deploy`]);
    expect(sets).toContainEqual([6, en.apps.codes.RESOURCE_LOCKED]);
  });

  it("the install request keeps its key after a lost reply or a 5xx and gets a new one after a refusal", async () => {
    const keys = { current: {} as Record<string, string> };
    answer({ [`${AT}/deploy`]: ["network", refusal(503, "UPSTREAM_UNAVAILABLE"), refusal(409, "RESOURCE_LOCKED"), accepted(202)] });
    for (let i = 0; i < 4; i++) {
      const { tree } = wizard({ ...ready, 0: "install", 3: [], 6: "x", 8: "stk_a1", 9: ["admin_password", "api_token"] }, { 1: keys });
      await click(tree, t.retry);
    }
    expect(calls().map((c) => c.url)).toEqual(Array(4).fill(`${AT}/deploy`));
    const used = calls().map((c) => c.headers["Idempotency-Key"]);
    expect(used[1]).toBe(used[0]);
    expect(used[2]).toBe(used[0]);
    expect(used[3]).not.toBe(used[0]);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it("while a request runs the private values left cannot be typed into: a value typed meanwhile would be sent half-typed", () => {
    const state = { ...ready, 0: "install", 6: t.secretFailed, 8: "stk_a1" };
    const tag = (out: string, key: string) => out.match(new RegExp(`<input[^>]*id="app-param-${key}"[^>]*>`))![0];
    const running = html(wizard({ ...state, 6: null, 7: true }).tree);
    const idle = html(wizard(state).tree);
    for (const key of ["admin_password", "api_token"]) {
      expect(tag(running, key)).toMatch(/\sdisabled=""/);
      expect(tag(idle, key)).not.toMatch(/\sdisabled=""/);
    }
  });
});

describe("AppWizard when the create's outcome is unknown", () => {
  const ready = { 0: "review", 1: " team-notes ", 2: { port: "9000" }, 3: ["admin_password", "api_token"], 4: [{ hostname: "Notes.Example.test", target: 0 }] };
  const AT = `${BASE}/stk_a1`;
  /** The exact text each request carried. */
  const raw = () => fetchMock.mock.calls.map((c) => (c[1] as RequestInit).body);
  const keyOf = (i: number) => calls()[i]!.headers["Idempotency-Key"];

  it.each<[string, Answer]>([
    ["a lost reply", "network"],
    ["the panel's own timeout (504)", refusal(504, "INTERNAL_ERROR")],
    ["a reply that never came back (502)", refusal(502, "OPERATION_AMBIGUOUS")],
    ["a server error (500)", refusal(500, "INTERNAL")],
    ["a 201 whose body is not JSON", notJson(201)],
    ["a 201 whose body read breaks off", cut(201)],
  ])("%s closes every step: only Retry, with the text that says the panel does not know yet", async (_what, lost) => {
    const keys = { current: {} as Record<string, string> };
    const values = secretsRef({ admin_password: PLANTED, api_token: `${PLANTED}-2` });
    answer({ [BASE]: [lost] });
    const first = wizard(ready, { 0: values, 1: keys });
    await click(first.tree, t.install);
    const sent = calls()[0]!;
    expect(first.sets).toContainEqual([10, sent.body]);
    expect(first.sets).toContainEqual([6, t.createUnknown]);
    expect(first.sets).toContainEqual([7, false]);
    expect(first.sets.filter(([k]) => k === 0)).toEqual([[0, "install"]]);
    expect(first.sets.filter(([k]) => k === 5)).toEqual([[5, {}]]);
    expect(keys.current.create).toBe(sent.headers["Idempotency-Key"]);
    expect(JSON.stringify(first.sets)).not.toContain(PLANTED);

    // Whatever step the state names, none opens: a change there would go out under the same key.
    const unsure = { ...ready, 0: "install", 6: t.createUnknown, 10: sent.body };
    for (const step of ["install", "review", "domains", "configure"]) {
      for (const m of [en, itMsgs]) {
        const { tree } = wizard({ ...unsure, 0: step, 6: m.apps.wizard.createUnknown }, { 0: values }, ENTRY, m);
        expect(actions(tree), step).toEqual([m.apps.wizard.retry]);
        expect(editable(tree), step).toEqual([]);
        const out = html(tree, m);
        expect(out, step).toMatch(new RegExp(`aria-current="step"[^>]*>${m.apps.wizard.step.install}`));
        expect(out, step).toMatch(new RegExp(`role="alert"[^>]*><p>${m.apps.wizard.createUnknown}</p>`));
        expect(out, step).toMatch(new RegExp(`${m.apps.wizard.name}</dt><dd[^>]*>team-notes<`));
        expect(out, step).not.toContain(`>${m.apps.wizard.back}<`);
        expect(out, step).not.toContain(m.apps.wizard.created);
        expect(out, step).not.toContain(PLANTED);
      }
    }
  });

  it("Retry sends the same key with the very text of the first attempt, whatever the fields hold; the replay goes on to the private values and the install", async () => {
    const keys = { current: {} as Record<string, string> };
    const values = secretsRef({ admin_password: PLANTED, api_token: `${PLANTED}-2` });
    answer({
      [BASE]: [refusal(504, "INTERNAL_ERROR"), accepted(201)],
      [`${AT}/secrets`]: [secretSaved("admin_password"), secretSaved("api_token")],
      [`${AT}/deploy`]: [accepted(202)],
    });
    const first = wizard(ready, { 0: values, 1: keys });
    await click(first.tree, t.install);
    const kept = first.sets.find(([k]) => k === 10)![1];
    const changed = { 1: "other-notes", 2: { port: "9100" }, 4: [{ hostname: "other.example.test", target: 1 }] };
    const retry = wizard({ ...ready, ...changed, 0: "install", 6: t.createUnknown, 10: kept }, { 0: values, 1: keys });
    await click(retry.tree, t.retry);
    expect(calls().map((c) => c.url)).toEqual([BASE, BASE, `${AT}/secrets`, `${AT}/secrets`, `${AT}/deploy`]);
    expect(keyOf(1)).toBe(keyOf(0));
    expect(raw()[1]).toBe(raw()[0]);
    expect(calls()[1]!.body).toMatchObject({ name: "team-notes", parameters: [{ key: "port", value: 9000 }], deploy: false });
    expect(calls().slice(2).map((c) => c.body)).toEqual([{ parameterKey: "admin_password", value: PLANTED }, { parameterKey: "api_token", value: `${PLANTED}-2` }, {}]);
    expect(retry.sets).toContainEqual([10, null]);
    expect(retry.sets).toContainEqual([8, "stk_a1"]);
    expect(values.current.size).toBe(0);
    expect(router.push).toHaveBeenCalledWith("/apps/stk_a1");
  });

  it.each<[string, Answer]>([
    ["is not JSON", notJson(201)],
    ["breaks off while it is read", cut(201)],
  ])("a 201 whose body %s is no known outcome: Retry sends the same key and the very text kept, and the replay goes on", async (_what, lost) => {
    const keys = { current: {} as Record<string, string> };
    const values = secretsRef({ admin_password: PLANTED, api_token: `${PLANTED}-2` });
    answer({
      [BASE]: [lost, accepted(201)],
      [`${AT}/secrets`]: [secretSaved("admin_password"), secretSaved("api_token")],
      [`${AT}/deploy`]: [accepted(202)],
    });
    const first = wizard(ready, { 0: values, 1: keys });
    await click(first.tree, t.install);
    const kept = first.sets.find(([k]) => k === 10)?.[1];
    expect(kept).toEqual(calls()[0]!.body);
    expect(first.sets).toContainEqual([6, t.createUnknown]);
    expect(first.sets.filter(([k]) => k === 8)).toEqual([]);
    expect(keys.current.create).toBe(keyOf(0));
    expect(router.push).not.toHaveBeenCalled();

    const retry = wizard({ ...ready, 0: "install", 1: "other-notes", 6: t.createUnknown, 10: kept }, { 0: values, 1: keys });
    expect(editable(retry.tree)).toEqual([]);
    await click(retry.tree, t.retry);
    expect(calls().map((c) => c.url)).toEqual([BASE, BASE, `${AT}/secrets`, `${AT}/secrets`, `${AT}/deploy`]);
    expect(keyOf(1)).toBe(keyOf(0));
    expect(raw()[1]).toBe(raw()[0]);
    expect(retry.sets).toContainEqual([8, "stk_a1"]);
    expect(router.push).toHaveBeenCalledWith("/apps/stk_a1");
  });

  it("without private values the replay of a create sent to install opens the application page", async () => {
    const keys = { current: {} as Record<string, string> };
    answer({ [BASE]: ["network", accepted(202)] });
    const first = wizard({ ...ready, 3: [] }, { 1: keys }, NO_SECRETS);
    await click(first.tree, t.install);
    const kept = first.sets.find(([k]) => k === 10)![1];
    expect(kept).toMatchObject({ deploy: true });
    await click(wizard({ ...ready, 0: "install", 1: "other-notes", 3: [], 6: t.createUnknown, 10: kept }, { 1: keys }, NO_SECRETS).tree, t.retry);
    expect(calls()).toHaveLength(2);
    expect(keyOf(1)).toBe(keyOf(0));
    expect(raw()[1]).toBe(raw()[0]);
    expect(router.push).toHaveBeenCalledWith("/apps/stk_a1");
  });

  it("a Retry that ends unknown again stays closed under the same key; a refusal opens the steps with its reason and the next Install uses a new key", async () => {
    const keys = { current: {} as Record<string, string> };
    const values = secretsRef({ admin_password: PLANTED });
    answer({
      [BASE]: ["network", refusal(503, "UPSTREAM_UNAVAILABLE"), refusal(409, "ALREADY_EXISTS", [{ field: "name", reason: "name_taken" }]), accepted(201)],
      [`${AT}/secrets`]: [secretSaved("admin_password")],
      [`${AT}/deploy`]: [accepted(202)],
    });
    const first = wizard({ ...ready, 3: ["admin_password"] }, { 0: values, 1: keys });
    await click(first.tree, t.install);
    const kept = first.sets.find(([k]) => k === 10)![1];
    const unsure = { ...ready, 0: "install", 3: ["admin_password"], 6: t.createUnknown, 10: kept };

    const again = wizard(unsure, { 0: values, 1: keys });
    await click(again.tree, t.retry);
    expect(again.sets).toContainEqual([10, kept]);
    expect(again.sets).toContainEqual([6, t.createUnknown]);
    expect(again.sets.filter(([k]) => k === 10)).toEqual([[10, kept]]);

    const refused = wizard(unsure, { 0: values, 1: keys });
    await click(refused.tree, t.retry);
    expect(refused.sets).toContainEqual([10, null]);
    expect(refused.sets).toContainEqual([5, { name: en.apps.reasons.name_taken }]);
    expect(refused.sets).toContainEqual([6, en.apps.reasons.name_taken]);
    expect(refused.sets).toContainEqual([0, "configure"]);
    expect(keys.current.create).toBeUndefined();
    const open = wizard({ ...unsure, 0: "configure", 5: { name: en.apps.reasons.name_taken }, 6: en.apps.reasons.name_taken, 10: null }, { 0: values, 1: keys });
    expect(editable(open.tree)).toContain("app-name");
    expect(actions(open.tree)).toEqual([t.back, t.next]);

    const renamed = wizard({ ...ready, 1: "team-notes-2", 3: ["admin_password"] }, { 0: values, 1: keys });
    await click(renamed.tree, t.install);
    expect(calls().map((c) => c.url)).toEqual([BASE, BASE, BASE, BASE, `${AT}/secrets`, `${AT}/deploy`]);
    expect(keyOf(1)).toBe(keyOf(0));
    expect(keyOf(2)).toBe(keyOf(0));
    expect(keyOf(3)).not.toBe(keyOf(0));
    expect(raw()[2]).toBe(raw()[0]);
    expect(calls()[3]!.body.name).toBe("team-notes-2");
    expect(router.push).toHaveBeenCalledWith("/apps/stk_a1");
  });
});

describe("wizard page", () => {
  const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
  const fail = (status: number, code: string) => ({ ok: false, status, error: { error: { code } } });
  const page = () => AppWizardPage({ params: Promise.resolve({ templateId: "atpl_notes" }) });

  it("reads the catalog entry of the customer's account and renders the wizard", async () => {
    fetchUpstream.mockResolvedValue(ok(ENTRY));
    const out = html(await page());
    expect(fetchUpstream.mock.calls.map(([p]) => p)).toEqual([`v1/organizations/${ORG}/app-templates/atpl_notes`]);
    expect(out).toContain('id="app-name"');
  });

  it("404 → notFound, 422 NOT_SUPPORTED → notice, other errors → load error, flag off → notice and no read", async () => {
    fetchUpstream.mockResolvedValue(fail(404, "NOT_FOUND"));
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
    fetchUpstream.mockResolvedValue(fail(422, "NOT_SUPPORTED"));
    expect(html(await page())).toContain(en.apps.unavailable.off);
    fetchUpstream.mockResolvedValue(fail(500, "INTERNAL"));
    expect(html(await page())).toContain(en.shell.loadErrorTitle);
    fetchUpstream.mockClear();
    mockData.getCustomerContext.mockResolvedValue({ session: { csrfToken: "csrf" }, orgId: ORG, loadError: false, capabilities: null, support: null });
    expect(html(await page())).toContain(en.apps.unavailable.off);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("a failed session read is the load error, not the «off» notice; an id that is not one path segment is not found; neither reads", async () => {
    mockData.getCustomerContext.mockResolvedValue({ session: { csrfToken: "csrf" }, orgId: null, loadError: true, capabilities: null, support: null });
    const h = html(await page());
    expect(h).toContain(en.shell.loadErrorTitle);
    expect(h).not.toContain(en.apps.unavailable.title);
    mockData.getCustomerContext.mockResolvedValue({ session: { csrfToken: "csrf" }, orgId: ORG, loadError: false, capabilities: { applicationStacksAvailable: true }, support: null });
    for (const templateId of ["..", ".", "a/b"])
      await expect(AppWizardPage({ params: Promise.resolve({ templateId }) }), templateId).rejects.toThrow("NEXT_NOT_FOUND");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });
});

describe("browser storage", () => {
  it("no customer application file touches localStorage, sessionStorage or cookies", () => {
    const src = path.resolve(__dirname, "../src");
    const files = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const all = ["components/app-stacks", "app/apps"].flatMap((d) => files(path.join(src, d)));
    expect(all.map((f) => path.relative(src, f))).toContain("components/app-stacks/app-wizard.tsx");
    for (const f of all) expect(fs.readFileSync(f, "utf-8"), f).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });
});
