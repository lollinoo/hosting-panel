import fs from "node:fs";
import path from "node:path";
import * as React from "react";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppTemplateParameter, CustomerAppTemplateDto } from "@hosting-panel/contracts";

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
import type { Messages } from "@/i18n";
import { I18nProvider } from "@/i18n/provider";
import AppWizardPage from "@/app/apps/new/[templateId]/page";
import { appStackRefusalText } from "@/components/app-stacks/app-stack-view";
import { AppWizard, buildAppParameterEntries, buildDomainEntries, missingSecretKeys, wizardErrorView } from "@/components/app-stacks/app-wizard";

const NOW = "2026-11-22T10:00:00.000Z";
const ORG = "org_a1";
const PLANTED = "S3cr3t-planted";
const t = en.apps.wizard;

const PARAMS: AppTemplateParameter[] = [
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
      { hostname: "notes.example.test", componentKey: "admin", port: 9000 },
      { hostname: "b.example.test", componentKey: "web", port: 8080 },
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
    expect(out).toContain(en.apps.detail.backupUnavailable);
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
      domains: [{ hostname: "notes.example.test", componentKey: "web", port: 8080 }],
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

  it("keeps the create key after a lost reply or a 5xx, renews it after a 4xx", async () => {
    const keys = { current: {} as Record<string, string> };
    answer({ [BASE]: ["network", refusal(503, "UPSTREAM_UNAVAILABLE"), refusal(409, "ALREADY_EXISTS", [{ field: "name", reason: "name_taken" }]), accepted(202)] });
    const run = async () => {
      const { tree, sets } = wizard({ ...ready, 0: "install", 3: [], 6: "x" }, { 1: keys }, NO_SECRETS);
      await click(tree, t.retry);
      return sets;
    };
    expect(await run()).toContainEqual([6, en.errors.generic]);
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
