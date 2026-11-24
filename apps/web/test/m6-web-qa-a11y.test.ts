// QA-W4 (HCP-SPEC-005 M6): accessibility and Italian/English wording of every new application component,
// checked on the rendered markup. Node only: `renderToStaticMarkup` plus a local `callHooks` that presets state.
import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_STACK_COMPONENT_HEALTH,
  APP_STACK_STATUSES,
  CERT_STATUSES,
  DOMAIN_STATUSES,
  type AdminAppTemplateDetailDto,
  type AdminAppTemplateSummaryDto,
  type AdminAppTemplateUsageDto,
  type AppStackDeploymentDto,
  type AppStackDetailDto,
  type AppStackDomainDto,
  type AppStackPlanDiffDto,
  type AppStackSummaryDto,
  type AppTemplateValidationDto,
  type CustomerAppTemplateDto,
  type CustomerAppTemplateSummaryDto,
  type OperationDto,
} from "@hosting-panel/contracts";

const loc = vi.hoisted(() => ({ value: "en" as "en" | "it", pathname: "/apps/stk_a1" }));
const mockData = vi.hoisted(() => ({ getCustomerContext: vi.fn() }));
const fetchUpstream = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("@/app/sites/data", () => mockData);
vi.mock("@/lib/server-session", () => ({ getServerSession: async () => ({ accessToken: "tok", csrfToken: "csrf" }) }));
vi.mock("@/lib/upstream", () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }));
vi.mock("@/lib/keyed-send", () => ({ keyedSend: vi.fn() }));
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
  usePathname: () => loc.pathname,
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

import { format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";
import AppStackPage from "@/app/apps/[stackId]/page";
import { AppTemplateDetail } from "@/components/admin/app-template-detail";
import { AppTemplateEditor, type AppEditorTarget } from "@/components/admin/app-template-editor";
import { TemplateCatalog } from "@/components/admin/template-catalog";
import { AppCatalog } from "@/components/app-stacks/app-catalog";
import { AppStackActions } from "@/components/app-stacks/app-stack-actions";
import { AppStackDelete } from "@/components/app-stacks/app-stack-delete";
import { AppStackDomains } from "@/components/app-stacks/app-stack-domains";
import { AppStackList } from "@/components/app-stacks/app-stack-list";
import { AppStackLogs } from "@/components/app-stacks/app-stack-logs";
import { AppStackProgress } from "@/components/app-stacks/app-stack-progress";
import { AppStackSecrets } from "@/components/app-stacks/app-stack-secrets";
import { AppStackComponents, AppStackData, AppStackHistory, AppStackResources, AppStackSettings } from "@/components/app-stacks/app-stack-sections";
import { HealthBadge, StackStatusBadge } from "@/components/app-stacks/app-stack-status";
import { AppsUnavailable } from "@/components/app-stacks/apps-unavailable";
import { AppWizard } from "@/components/app-stacks/app-wizard";
import { WIZARD_STEPS, WizardSteps } from "@/components/app-stacks/wizard-steps";

const NOW = "2026-11-22T10:00:00.000Z";
const ORG = "org_a1";
const UP = "v1/organizations/org_a1/app-stacks/stk_a1";
const MIB = 2 ** 20;
const LOCALES = [
  ["it", itMsgs],
  ["en", en],
] as const;
const localeOf = (m: Messages) => (m === en ? "en" : "it");

// ------------------------------------------------------------------------------------------------ rendering helpers

// `&quot;` stays escaped so attribute values can be parsed with a plain `"…"` pattern.
const html = (node: ReactNode, m: Messages = en) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: localeOf(m), messages: m, children: node })).replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
/** Calls a client component once with stand-in hooks; `state` presets useState slots by call order. */
function callHooks<P>(C: (p: P) => ReactNode, props: P, m: Messages, state: Record<number, unknown> = {}) {
  let s = 0;
  const ctx = { locale: localeOf(m), messages: m };
  const prev = internals.H;
  internals.H = {
    useState: (v: unknown) => {
      const k = s++;
      return [k in state ? state[k] : v, () => undefined];
    },
    useRef: (v: unknown) => ({ current: v }),
    useEffect: () => undefined,
    useContext: () => ctx,
  };
  try {
    return C(props);
  } finally {
    internals.H = prev;
  }
}
/** The markup of a client component with preset state. */
const withState = <P>(C: (p: P) => ReactNode, props: P, m: Messages, state: Record<number, unknown> = {}) => html(callHooks(C, props, m, state), m);

type El = ReactElement<Record<string, unknown>>;
const els = (node: unknown): El[] => {
  if (Array.isArray(node)) return node.flatMap(els);
  if (!isValidElement(node)) return [];
  return [node as El, ...els((node as El).props.children)];
};

interface Tag {
  name: string;
  attrs: Record<string, string>;
}
const tagsOf = (h: string): Tag[] =>
  [...h.matchAll(/<([a-z][a-z0-9]*)\b((?:[^>"]|"[^"]*")*)>/g)].map((x) => ({
    name: x[1]!,
    attrs: Object.fromEntries([...x[2]!.matchAll(/([a-zA-Z:-]+)(?:="([^"]*)")?/g)].map((a) => [a[1]!.toLowerCase(), a[2] ?? ""])),
  }));
const strip = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const inner = (h: string, tag: string) => [...h.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g"))].map((x) => strip(x[1]!));
const FORM_TAGS = new Set(["input", "select", "textarea"]);
const controls = (h: string) => tagsOf(h).filter((t) => FORM_TAGS.has(t.name) && t.attrs.type !== "hidden");
const idsOf = (h: string) => tagsOf(h).flatMap((t) => (t.attrs.id ? [t.attrs.id] : []));
const labelTargets = (h: string) => tagsOf(h).flatMap((t) => (t.name === "label" && t.attrs.for ? [t.attrs.for] : []));
const textNodes = (h: string): string[] => {
  const attrText = tagsOf(h).flatMap((t) => ["aria-label", "title", "placeholder"].flatMap((a) => (t.attrs[a] ? [t.attrs[a]!] : [])));
  return [...h.split(/<[^>]*>/).map((s) => s.trim()), ...attrText].filter(Boolean);
};
/** Elements carrying a role, with their text. */
const withRole = (h: string, role: string) => [...h.matchAll(new RegExp(`<([a-z0-9]+)\\b[^>]*\\srole="${role}"[^>]*>([\\s\\S]*?)</\\1>`, "g"))].map((x) => strip(x[2]!));

/** The accessibility rules that hold for any markup of the new UI (spec §15, arch-web §7). */
function expectAccessible(h: string, what: string) {
  const ids = idsOf(h);
  expect(new Set(ids).size, `${what}: duplicate ids`).toBe(ids.length);
  const labelled = new Set(labelTargets(h));
  for (const c of controls(h)) {
    expect(c.attrs.id, `${what}: a <${c.name}> without id`).toBeTruthy();
    expect(labelled.has(c.attrs.id!), `${what}: no <label for="${c.attrs.id}">`).toBe(true);
  }
  for (const target of labelled) expect(ids, `${what}: <label for="${target}"> points nowhere`).toContain(target);
  for (const t of tagsOf(h)) {
    for (const ref of (t.attrs["aria-describedby"] ?? "").split(/\s+/).filter(Boolean)) expect(ids, `${what}: aria-describedby="${ref}"`).toContain(ref);
    if (t.name === "svg") expect(t.attrs["aria-hidden"], `${what}: an icon without aria-hidden`).toBe("true");
    if (t.name === "input" && t.attrs.type === "password") {
      expect(t.attrs.autocomplete, `${what}: password autocomplete`).toBe("new-password");
      expect(t.attrs.spellcheck, `${what}: password spellcheck`).toBe("false");
      expect(t.attrs.value, `${what}: a value on a password field`).toBeUndefined();
    }
  }
  for (const text of inner(h, "button")) expect(text, `${what}: a <button> without text`).not.toBe("");
  for (const text of inner(h, "a")) expect(text, `${what}: a link without text`).not.toBe("");
  for (const text of inner(h, "label")) expect(text, `${what}: an empty <label>`).not.toBe("");
  for (const level of ["h1", "h2", "h3"]) for (const text of inner(h, level)) expect(text, `${what}: an empty <${level}>`).not.toBe("");
  for (const t of tagsOf(h)) if (t.name === "time") expect(Date.parse(t.attrs.datetime ?? ""), `${what}: <time> without a valid dateTime`).not.toBeNaN();
  for (const text of withRole(h, "alert")) expect(text, `${what}: an empty alert`).not.toBe("");
  // an invalid field is flagged for assistive technology and says why in visible text
  for (const c of controls(h).filter((x) => x.attrs["aria-invalid"] === "true")) expect(c.attrs["aria-describedby"], `${what}: ${c.attrs.id} invalid but undescribed`).toBeTruthy();
}

// ------------------------------------------------------------------------------------------------ fixtures

const context = (over: Record<string, unknown> = {}) => ({
  session: { csrfToken: "csrf", user: { name: "Someone" } },
  orgId: ORG,
  loadError: false,
  capabilities: { applicationStacksAvailable: true },
  support: null,
  ...over,
});
const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });

const STACK: AppStackSummaryDto = {
  id: "stk_a1",
  name: "team-notes",
  status: "degraded",
  templateId: "atpl_notes",
  templateName: "Notes",
  templateVersionNumber: 2,
  installed: null,
  componentCount: 2,
  unhealthyCount: 1,
  primaryHostname: "notes.example.test",
  updatedAt: NOW,
};
const STACKS: AppStackSummaryDto[] = [
  STACK,
  { ...STACK, id: "stk_a2", name: "scratch", status: "draft", unhealthyCount: 0, primaryHostname: null },
];
const DETAIL: AppStackDetailDto = {
  ...STACK,
  templateVersionId: "atv_notes_2",
  createdAt: NOW,
  activeOperationId: null,
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
    { key: "ADMIN_PASSWORD", label: "Admin password", required: true, isSet: true, version: 2, setAt: NOW },
    { key: "MAIL_KEY", label: "Mail key", required: false, isSet: false, version: null, setAt: null },
  ],
  volumes: [{ key: "notes", status: "present", retentionPolicy: "retain" }],
  ingress: [
    { componentKey: "web", port: 8080 },
    { componentKey: "admin", port: 9000 },
  ],
  cpuMilli: 750,
  memoryBytes: String(384 * MIB),
  upgrade: { templateVersionId: "atv_notes_3", versionNumber: 3 },
  rollback: { revisionId: "srev_a1", revisionNumber: 2, templateVersionNumber: 1 },
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
const DOMAINS: AppStackDomainDto[] = [DOMAIN, { ...DOMAIN, id: "sdom_2", hostname: "wiki.example.test", status: "pending", certificateStatus: "requested", certificateExpiresAt: null }];

const PARAMS: CustomerAppTemplateDto["parameters"] = [
  { key: "title", label: "Board title", type: "string", default: "My notes", customer: true },
  { key: "port", label: "Listen port", type: "integer", min: 1024, max: 65535, default: 8080, customer: true },
  { key: "mode", label: "Mode", type: "enum", options: ["small", "large"], default: "small", customer: true },
  { key: "public", label: "Public board", type: "boolean", default: false, customer: true },
  { key: "admin_password", label: "Admin password", type: "secret", required: true, customer: true },
  { key: "api_token", label: "API token", type: "secret", required: false, customer: true },
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
  memoryBytes: String(256 * MIB),
  volumeCount: 1,
  hasIngress: true,
  parameters: PARAMS,
  ingress: [
    { componentKey: "web", port: 8080 },
    { componentKey: "admin", port: 9000 },
  ],
  components: [
    { key: "admin", cpuMilli: 250, memoryBytes: String(128 * MIB) },
    { key: "web", cpuMilli: 250, memoryBytes: String(128 * MIB) },
  ],
};
const NOTES: CustomerAppTemplateSummaryDto = {
  id: "atpl_notes",
  name: "Notes",
  description: "Shared notes for the team.",
  category: "content",
  versionId: "atv_notes_2",
  versionNumber: 2,
  componentCount: 2,
  cpuMilli: 500,
  memoryBytes: String(256 * MIB),
  volumeCount: 1,
  hasIngress: true,
};
const WORKER: CustomerAppTemplateSummaryDto = {
  ...NOTES,
  id: "atpl_worker",
  name: "Worker",
  description: null,
  category: "odd-kind",
  versionId: "atv_worker_1",
  versionNumber: 1,
  componentCount: 1,
  cpuMilli: 2000,
  memoryBytes: String(1.5 * 2 ** 30),
  volumeCount: 0,
  hasIngress: false,
};
const DIFF: AppStackPlanDiffDto = {
  planHash: "a".repeat(64),
  fromRevisionId: "srev_a1",
  fromVersionNumber: 2,
  toTemplateVersionId: "atv_notes_3",
  toVersionNumber: 3,
  newRevision: true,
  components: [
    { key: "web", change: "updated", restart: true },
    { key: "cache", change: "added", restart: false },
  ],
  volumes: [{ key: "notes", change: "removed" }],
  parameters: [{ key: "SITE_TITLE", change: "unchanged" }],
  ingress: [{ componentKey: "web", port: 8080, change: "unchanged" }],
  downtime: true,
  dataRisk: true,
};
const STEPS = [
  { id: "st1", key: "validate", label: "Check the request", status: "succeeded", message: "ok", startedAt: NOW, completedAt: NOW },
  { id: "st2", key: "pull", label: "Pull images", status: "running", message: null, startedAt: NOW, completedAt: null },
  { id: "st3", key: "mystery", label: "Mystery step", status: "pending", message: null, startedAt: null, completedAt: null },
] as OperationDto["steps"];
const operation = (status: OperationDto["status"], kind: OperationDto["kind"] = "stack.upgrade") =>
  ({ id: "op_1", kind, status, steps: STEPS, errorMessage: "Engine said no" }) as OperationDto;

const summary = (over: Partial<AdminAppTemplateSummaryDto> & { id: string }): AdminAppTemplateSummaryDto =>
  ({
    slug: "notes",
    name: "Notes",
    category: "productivity",
    description: null,
    builtIn: false,
    enabled: true,
    archivedAt: null,
    defaultVersionId: "atv_notes_2",
    defaultVersionNumber: 2,
    installations: 3,
    componentCount: 2,
    hasIngress: true,
    hasVolumes: true,
    updatedAt: NOW,
    state: "published",
    ...over,
  }) as AdminAppTemplateSummaryDto;
const TEMPLATES: AdminAppTemplateSummaryDto[] = [
  summary({ id: "atpl_notes" }),
  summary({ id: "atpl_cache", name: "Http cache", builtIn: true, hasVolumes: false, category: "web" }),
  summary({ id: "atpl_draft", name: "Alpha", category: "mystery", enabled: false, defaultVersionId: null, defaultVersionNumber: null, state: "draft" }),
  summary({ id: "atpl_old", name: "Aardvark", enabled: false, archivedAt: NOW, state: "archived" }),
];
const tdetail = (base: AdminAppTemplateSummaryDto): AdminAppTemplateDetailDto =>
  ({
    ...base,
    createdAt: NOW,
    versions: [
      { id: base.defaultVersionId ?? "atv_head_2", versionNumber: 2, specHash: "a".repeat(64), createdAt: NOW, installations: 2 },
      { id: "atv_prev_1", versionNumber: 1, specHash: "b".repeat(64), createdAt: "2026-11-01T09:30:00.000Z", installations: 1 },
    ],
  }) as AdminAppTemplateDetailDto;
const USAGE: AdminAppTemplateUsageDto = {
  templateId: "atpl_notes",
  stacks: [{ id: "stk_a", name: "team-board", organizationId: "org_acme", organizationName: "Acme Srl", versionNumber: 2, status: "running" }],
  truncated: true,
};
const VALID = {
  valid: true,
  issues: [],
  parameters: [
    { key: "title", label: "Title", type: "string", default: "Notes", customer: true },
    { key: "db_password", label: "Database password", type: "secret", required: true, customer: true },
  ],
  preview: { components: [], volumes: [], ingress: [] },
} as unknown as AppTemplateValidationDto;
const INVALID = {
  valid: false,
  issues: [{ path: "services.web", code: "IMAGE_DIGEST_REQUIRED", reason: "STACK_IMAGE_NOT_ALLOWED", message: "msg", line: 3, column: 5 }],
  parameters: [],
  preview: null,
} as unknown as AppTemplateValidationDto;
const SOURCE = "# HCP-STACK/v1\nservices:\n  web:\n    expose:\n      - 8080\n";
const CREATE: AppEditorTarget = { kind: "create" };
const VERSION: AppEditorTarget = { kind: "version", templateId: "atpl_notes", archived: false };
const ARCHIVED: AppEditorTarget = { kind: "version", templateId: "atpl_notes", archived: true };

// ------------------------------------------------------------------------------------------------ scenarios

type Render = (m: Messages) => string;
interface Scenario {
  name: string;
  render: Render;
  /** Ids that must be on the page, each with its label. */
  ids?: string[];
  /** How many role="alert" elements the markup has. */
  alerts?: number;
}

const actionProps = { orgId: ORG, stackId: "stk_a1", csrfToken: "csrf", status: "running" as const, upgrade: DETAIL.upgrade, rollback: DETAIL.rollback };
const planDialog = (m: Messages, plan: "upgrade" | "rollback", diffState: Record<number, unknown>) => {
  const tree = callHooks(AppStackActions, actionProps, m, { 4: plan });
  const dialog = els(tree).find((e) => typeof e.type === "function" && (e.type as { name?: string }).name === "PlanDialog");
  if (!dialog) throw new Error("no plan dialog in the tree");
  return html(callHooks(dialog.type as (p: unknown) => ReactNode, dialog.props, m, diffState), m);
};
const wizard = (m: Messages, state: Record<number, unknown>, entry: CustomerAppTemplateDto = ENTRY) =>
  withState(AppWizard, { orgId: ORG, csrfToken: "csrf", entry }, m, state);
const deleteProps = { orgId: ORG, stackId: "stk_a1", csrfToken: "csrf", stackName: "team-notes", hasData: true };
const secretsProps = { orgId: ORG, stackId: "stk_a1", csrfToken: "csrf", secrets: DETAIL.secretParameters };
const domainsProps = { orgId: ORG, stackId: "stk_a1", csrfToken: "csrf", initial: DOMAINS, ingress: DETAIL.ingress };
const editor = (m: Messages, target: AppEditorTarget, state: Record<number, unknown> = {}) =>
  withState(AppTemplateEditor, { csrfToken: "csrf", initialSource: SOURCE, target }, m, state);
const adminDetail = (m: Messages, tpl: AdminAppTemplateDetailDto, usage: AdminAppTemplateUsageDto | null, state: Record<number, unknown> = {}) =>
  withState(AppTemplateDetail, { template: tpl, usage, csrfToken: "csrf" }, m, state);

const SCENARIOS: Scenario[] = [
  // ---- customer shell, list, catalog
  { name: "apps unavailable (flag off)", render: (m) => html(createElement(AppsUnavailable, { m, reason: "off" }), m) },
  { name: "apps unavailable (support visit)", render: (m) => html(createElement(AppsUnavailable, { m, reason: "support" }), m) },
  { name: "application list", render: (m) => html(createElement(AppStackList, { stacks: STACKS, m, locale: localeOf(m) }), m) },
  { name: "application list, empty", render: (m) => html(createElement(AppStackList, { stacks: [], m, locale: localeOf(m) }), m) },
  { name: "catalog", render: (m) => withState(AppCatalog, { entries: [NOTES, WORKER], categories: ["content", "odd-kind"] }, m) },
  { name: "catalog, one filter on", render: (m) => withState(AppCatalog, { entries: [NOTES, WORKER], categories: ["content", "odd-kind"] }, m, { 0: "content" }) },
  { name: "catalog, empty", render: (m) => withState(AppCatalog, { entries: [], categories: [] }, m) },
  // ---- wizard
  { name: "wizard · configure", ids: ["app-name", "app-param-title", "app-param-port", "app-param-mode", "app-param-public", "app-param-admin_password", "app-param-api_token"], render: (m) => wizard(m, {}) },
  {
    name: "wizard · configure with errors",
    ids: ["app-name", "app-param-admin_password"],
    alerts: 1,
    render: (m) =>
      wizard(m, { 5: { name: m.apps.wizard.required, "param:admin_password": m.apps.wizard.required, "param:port": "No" }, 6: m.apps.wizard.required }),
  },
  {
    name: "wizard · configure with a typed secret",
    ids: ["app-param-admin_password"],
    render: (m) => wizard(m, { 1: "my-notes", 3: ["admin_password"] }),
  },
  {
    name: "wizard · domains",
    ids: ["app-domain-0", "app-domain-0-target", "app-domain-1", "app-domain-1-target"],
    render: (m) =>
      wizard(m, {
        0: "domains",
        4: [
          { hostname: "notes.example.test", target: 0 },
          { hostname: "", target: 1 },
        ],
      }),
  },
  {
    name: "wizard · domains with a located error",
    ids: ["app-domain-0"],
    alerts: 1,
    render: (m) => wizard(m, { 0: "domains", 4: [{ hostname: "bad host", target: 0 }], 5: { "domain:0": m.apps.reasons.status ?? "x" }, 6: m.apps.wizard.required }),
  },
  { name: "wizard · domains, no web address", render: (m) => wizard(m, { 0: "domains" }, { ...ENTRY, ingress: [] }) },
  { name: "wizard · review", render: (m) => wizard(m, { 0: "review", 1: "my-notes", 3: ["admin_password"], 4: [{ hostname: "Notes.Example.test", target: 1 }] }) },
  { name: "wizard · installing", render: (m) => wizard(m, { 0: "install", 1: "my-notes", 7: true }) },
  { name: "wizard · install failed after the stack exists", alerts: 1, render: (m) => wizard(m, { 0: "install", 1: "my-notes", 6: m.apps.wizard.secretFailed, 8: "stk_a1" }) },
  ...WIZARD_STEPS.map((step) => ({ name: `wizard steps · ${step}`, render: (m: Messages) => withState(WizardSteps, { current: step }, m) })),
  // ---- detail page parts
  { name: "actions", render: (m) => withState(AppStackActions, actionProps, m) },
  { name: "actions, draft", render: (m) => withState(AppStackActions, { ...actionProps, status: "draft" as const, upgrade: null, rollback: null }, m) },
  { name: "actions, accepted notice", render: (m) => withState(AppStackActions, actionProps, m, { 1: m.apps.actions.accepted }) },
  { name: "actions, refused", alerts: 1, render: (m) => withState(AppStackActions, actionProps, m, { 2: m.apps.reasons.plan_changed }) },
  { name: "actions · stop dialog", render: (m) => withState(AppStackActions, actionProps, m, { 3: true }) },
  { name: "actions · upgrade dialog loading", render: (m) => planDialog(m, "upgrade", {}) },
  { name: "actions · upgrade dialog with the plan", ids: ["app-plan-ack"], render: (m) => planDialog(m, "upgrade", { 0: DIFF }) },
  { name: "actions · rollback dialog with the plan", ids: ["app-plan-ack"], render: (m) => planDialog(m, "rollback", { 0: { ...DIFF, downtime: false, volumes: [] } }) },
  { name: "actions · rollback dialog refused", alerts: 1, render: (m) => planDialog(m, "rollback", { 1: m.apps.reasons.plan_changed }) },
  { name: "delete, closed", render: (m) => withState(AppStackDelete, deleteProps, m) },
  { name: "delete · dialog", ids: ["app-delete-name", "app-delete-data"], render: (m) => withState(AppStackDelete, deleteProps, m, { 0: true }) },
  { name: "delete · dialog with the data box ticked", ids: ["app-delete-name", "app-delete-data"], render: (m) => withState(AppStackDelete, deleteProps, m, { 0: true, 1: "team-notes", 2: true }) },
  { name: "delete · dialog refused", ids: ["app-delete-name"], alerts: 1, render: (m) => withState(AppStackDelete, { ...deleteProps, hasData: false }, m, { 0: true, 4: m.apps.reasons.plan_changed }) },
  { name: "secrets", render: (m) => withState(AppStackSecrets, secretsProps, m) },
  { name: "secrets · replace dialog", ids: ["app-secret-value"], render: (m) => withState(AppStackSecrets, secretsProps, m, { 0: "ADMIN_PASSWORD" }) },
  { name: "secrets · replace dialog with errors", ids: ["app-secret-value"], alerts: 2, render: (m) => withState(AppStackSecrets, secretsProps, m, { 0: "MAIL_KEY", 2: m.apps.wizard.required, 3: m.apps.reasons.plan_changed }) },
  { name: "secrets · replaced notice", render: (m) => withState(AppStackSecrets, secretsProps, m, { 4: m.apps.secrets.replaced }) },
  { name: "logs", ids: ["app-logs-component"], render: (m) => withState(AppStackLogs, { orgId: ORG, stackId: "stk_a1", componentKeys: ["web", "cache"] }, m) },
  {
    name: "logs · lines",
    ids: ["app-logs-component"],
    render: (m) =>
      withState(AppStackLogs, { orgId: ORG, stackId: "stk_a1", componentKeys: ["web", "cache"] }, m, {
        1: [
          { at: NOW, stream: "stdout", text: "started" },
          { at: null, stream: "stderr", text: "<script>alert(1)</script>" },
        ],
      }),
  },
  { name: "logs · unavailable", ids: ["app-logs-component"], alerts: 1, render: (m) => withState(AppStackLogs, { orgId: ORG, stackId: "stk_a1", componentKeys: ["web"] }, m, { 2: m.apps.logs.unavailable }) },
  { name: "logs · loading", ids: ["app-logs-component"], render: (m) => withState(AppStackLogs, { orgId: ORG, stackId: "stk_a1", componentKeys: ["web"] }, m, { 3: true }) },
  { name: "domains", ids: ["app-domain-hostname", "app-domain-target"], render: (m) => withState(AppStackDomains, domainsProps, m) },
  { name: "domains · single address", ids: ["app-domain-hostname"], render: (m) => withState(AppStackDomains, { ...domainsProps, ingress: [DETAIL.ingress[0]!] }, m) },
  { name: "domains · refused", ids: ["app-domain-hostname"], alerts: 1, render: (m) => withState(AppStackDomains, domainsProps, m, { 4: m.apps.reasons.plan_changed }) },
  { name: "domains · remove dialog", render: (m) => withState(AppStackDomains, domainsProps, m, { 5: "sdom_1" }) },
  { name: "domains · none", ids: ["app-domain-hostname"], render: (m) => withState(AppStackDomains, { ...domainsProps, initial: [] }, m) },
  { name: "domains · unreadable", render: (m) => withState(AppStackDomains, { ...domainsProps, initial: null }, m) },
  { name: "progress · running", render: (m) => withState(AppStackProgress, { orgId: ORG, operationId: "op_1" }, m, { 0: operation("processing") }) },
  { name: "progress · succeeded", render: (m) => withState(AppStackProgress, { orgId: ORG, operationId: "op_1" }, m, { 0: operation("succeeded"), 1: "done" }) },
  { name: "progress · failed", alerts: 1, render: (m) => withState(AppStackProgress, { orgId: ORG, operationId: "op_1" }, m, { 0: operation("failed"), 1: "done" }) },
  { name: "progress · unknown", render: (m) => withState(AppStackProgress, { orgId: ORG, operationId: "op_1" }, m, { 0: operation("unknown"), 1: "done" }) },
  { name: "progress · slow and poll error", render: (m) => withState(AppStackProgress, { orgId: ORG, operationId: "op_1" }, m, { 0: operation("processing"), 2: true }) },
  { name: "progress · signed out", render: (m) => withState(AppStackProgress, { orgId: ORG, operationId: "op_1" }, m, { 1: "signedOut" }) },
  { name: "sections · components", render: (m) => html(createElement(AppStackComponents, { components: DETAIL.components, m, locale: localeOf(m) }), m) },
  { name: "sections · settings", render: (m) => html(createElement(AppStackSettings, { parameters: DETAIL.parameters, m }), m) },
  { name: "sections · data", render: (m) => html(createElement(AppStackData, { volumes: DETAIL.volumes, m }), m) },
  { name: "sections · resources", render: (m) => html(createElement(AppStackResources, { cpuMilli: 750, memoryBytes: DETAIL.memoryBytes, components: DETAIL.components, m }), m) },
  { name: "sections · history", render: (m) => html(createElement(AppStackHistory, { deployments: DEPLOYMENTS, m, locale: localeOf(m) }), m) },
  // ---- admin
  { name: "admin · template list", render: (m) => html(createElement(TemplateCatalog, { sites: [], apps: TEMPLATES, m }), m) },
  { name: "admin · template list, empty", render: (m) => html(createElement(TemplateCatalog, { sites: [], apps: [], m }), m) },
  { name: "admin · template detail", ids: ["app-template-enabled"], render: (m) => adminDetail(m, tdetail(TEMPLATES[0]!), USAGE) },
  { name: "admin · built-in template detail", ids: ["app-template-enabled"], render: (m) => adminDetail(m, tdetail(TEMPLATES[1]!), { ...USAGE, stacks: [], truncated: false }) },
  { name: "admin · archived template detail", ids: ["app-template-enabled"], render: (m) => adminDetail(m, tdetail(TEMPLATES[3]!), null) },
  { name: "admin · template detail, archive dialog", ids: ["app-template-enabled"], render: (m) => adminDetail(m, tdetail(TEMPLATES[0]!), USAGE, { 2: true }) },
  { name: "admin · template detail, saved notice", ids: ["app-template-enabled"], render: (m) => adminDetail(m, tdetail(TEMPLATES[0]!), USAGE, { 1: { ok: true, text: m.admin.appTemplates.detail.saved } }) },
  { name: "admin · template detail, refused", ids: ["app-template-enabled"], alerts: 2, render: (m) => adminDetail(m, tdetail(TEMPLATES[0]!), null, { 1: { ok: false, text: m.admin.appTemplates.reasons.slug_taken } }) },
  { name: "admin · editor, create", ids: ["app-template-slug", "app-template-source"], render: (m) => editor(m, CREATE) },
  { name: "admin · editor, create with a bad slug", ids: ["app-template-slug", "app-template-source"], render: (m) => editor(m, CREATE, { 5: "-x" }) },
  { name: "admin · editor, slug taken", ids: ["app-template-slug", "app-template-source"], alerts: 1, render: (m) => editor(m, CREATE, { 2: m.admin.appTemplates.reasons.slug_taken, 5: "notes" }) },
  { name: "admin · editor, new version", ids: ["app-template-source", "app-template-make-default"], render: (m) => editor(m, VERSION) },
  { name: "admin · editor, archived", ids: ["app-template-source"], render: (m) => editor(m, ARCHIVED) },
  { name: "admin · editor, valid", ids: ["app-template-source"], render: (m) => editor(m, VERSION, { 1: VALID }) },
  { name: "admin · editor, invalid", ids: ["app-template-source"], alerts: 1, render: (m) => editor(m, VERSION, { 1: INVALID }) },
  { name: "admin · editor, refused", ids: ["app-template-source"], alerts: 1, render: (m) => editor(m, VERSION, { 2: m.errors.generic }) },
  { name: "admin · editor, syntax error", ids: ["app-template-source"], render: (m) => editor(m, VERSION, { 0: "services:\n  web:\n image: x\n  bad" }) },
];

beforeEach(() => {
  vi.clearAllMocks();
  loc.value = "en";
  loc.pathname = "/apps/stk_a1";
  mockData.getCustomerContext.mockResolvedValue(context());
});

// ------------------------------------------------------------------------------------------------ rules

describe("the checker itself", () => {
  const bad = (h: string) => () => expectAccessible(h, "bad");
  it.each([
    ["an input without a label", '<input id="a" type="text"/>'],
    ["a label that points nowhere", '<label for="zz">x</label>'],
    ["an input without an id", '<label for="a">x</label><input type="text"/>'],
    ["a button without text", '<button type="button"><svg aria-hidden="true"></svg></button>'],
    ["a link without text", '<a href="/x"></a>'],
    ["an icon without aria-hidden", "<svg></svg>"],
    ["a dangling aria-describedby", '<p id="a" aria-describedby="nope">x</p>'],
    ["a time without dateTime", "<time>today</time>"],
    ["a password field with autocomplete on", '<label for="p">x</label><input id="p" type="password" autoComplete="current-password" spellCheck="false"/>'],
    ["an invalid field without a description", '<label for="p">x</label><input id="p" type="text" aria-invalid="true"/>'],
    ["an empty alert", '<div role="alert"></div>'],
    ["a duplicate id", '<p id="a">x</p><p id="a">y</p>'],
  ])("refuses %s", (_name, markup) => {
    expect(bad(markup)).toThrow();
  });

  it("accepts a well-formed field", () => {
    expect(bad('<label for="a">Name</label><input id="a" type="text" aria-describedby="n" aria-invalid="true"/><p id="n">Required</p>')).not.toThrow();
  });
});

describe("accessibility rules on every component, in Italian and English", () => {
  it("the scenario table covers every new component", () => {
    const rendered = SCENARIOS.map((s) => s.name).join("|");
    for (const part of [
      "unavailable", "application list", "catalog", "wizard · configure", "wizard · domains", "wizard · review", "wizard steps", "actions", "delete", "secrets",
      "logs", "domains", "progress", "sections · components", "sections · history", "admin · template list", "admin · template detail", "admin · editor",
    ])
      expect(rendered, part).toContain(part);
  });

  describe.each(LOCALES)("%s", (_l, m) => {
    it.each(SCENARIOS.map((s) => [s.name, s] as const))("%s", (_name, s) => {
      const h = s.render(m);
      expect(h.length).toBeGreaterThan(0);
      expectAccessible(h, s.name);
      const ids = idsOf(h);
      const labelled = labelTargets(h);
      for (const id of s.ids ?? []) {
        expect(ids, `${id} on the page`).toContain(id);
        expect(labelled, `<label for="${id}">`).toContain(id);
      }
      if (s.alerts !== undefined) expect(withRole(h, "alert").length, "role=alert elements").toBe(s.alerts);
    });
  });

  it("an `id` of arch-web §7.1 the page never renders is a gap in the scenarios, not in the UI", () => {
    const wanted = [
      "app-template-source", "app-template-enabled", "app-name", "app-param-title", "app-domain-0", "app-logs-component", "app-secret-value",
      "app-delete-name", "app-delete-data",
    ];
    const seen = new Set(SCENARIOS.flatMap((s) => s.ids ?? []));
    for (const id of wanted) expect(seen.has(id), id).toBe(true);
  });
});

describe("live regions", () => {
  it.each(LOCALES)("%s · notices are status, failures are alerts, never the other way round", (_l, m) => {
    const notice = withState(AppStackActions, actionProps, m, { 1: m.apps.actions.accepted });
    expect(withRole(notice, "status")).toContain(m.apps.actions.accepted);
    expect(withRole(notice, "alert")).toEqual([]);

    const refused = withState(AppStackActions, actionProps, m, { 2: m.apps.reasons.plan_changed });
    expect(withRole(refused, "alert")).toContain(m.apps.reasons.plan_changed);
    expect(withRole(refused, "status")).not.toContain(m.apps.reasons.plan_changed);

    const done = withState(AppStackProgress, { orgId: ORG, operationId: "op_1" }, m, { 0: operation("succeeded"), 1: "done" });
    expect(withRole(done, "status")).toContain(m.apps.progress.succeeded);
    expect(withRole(done, "alert")).toEqual([]);
    const failed = withState(AppStackProgress, { orgId: ORG, operationId: "op_1" }, m, { 0: operation("failed"), 1: "done" });
    expect(withRole(failed, "alert")).toEqual([m.apps.progress.failed]);
    const unknown = withState(AppStackProgress, { orgId: ORG, operationId: "op_1" }, m, { 0: operation("unknown"), 1: "done" });
    expect(withRole(unknown, "alert")).toEqual([]);
    expect(withRole(unknown, "status")).toContain(m.apps.progress.unknown);

    const saved = adminDetail(m, tdetail(TEMPLATES[0]!), USAGE, { 1: { ok: true, text: m.admin.appTemplates.detail.saved } });
    expect(withRole(saved, "status")).toContain(m.admin.appTemplates.detail.saved);
    expect(withRole(saved, "alert")).toEqual([]);
    const unavailable = html(createElement(AppsUnavailable, { m, reason: "off" }), m);
    expect(withRole(unavailable, "status").join(" ")).toContain(m.apps.unavailable.off);
    expect(withRole(unavailable, "alert")).toEqual([]);
    const valid = editor(m, VERSION, { 1: VALID });
    expect(withRole(valid, "status")).toContain(m.admin.appTemplates.editor.valid);
    const invalid = editor(m, VERSION, { 1: INVALID });
    expect(withRole(invalid, "alert").join(" ")).toContain(m.admin.appTemplates.editor.invalid);
    expect(withRole(invalid, "alert").join(" ")).toContain("IMAGE_DIGEST_REQUIRED");
  });

  it.each(LOCALES)("%s · the progress list is polite and marks the running step", (_l, m) => {
    const h = withState(AppStackProgress, { orgId: ORG, operationId: "op_1" }, m, { 0: operation("processing") });
    const list = tagsOf(h).find((t) => t.name === "ol");
    expect(list?.attrs["aria-live"]).toBe("polite");
    const current = tagsOf(h).filter((t) => t.attrs["aria-current"]);
    expect(current).toHaveLength(1);
    expect(current[0]!.attrs["aria-current"]).toBe("step");
    // each step has a word for its state, not only an icon
    for (const word of [m.apps.stepStatus.succeeded, m.apps.stepStatus.running, m.apps.stepStatus.pending]) expect(h).toContain(word);
    // the API's own label is never shown
    expect(h).not.toContain("Check the request");
  });

  it.each(LOCALES)("%s · the action result region is polite", (_l, m) => {
    const h = withState(AppStackActions, actionProps, m, { 1: m.apps.actions.accepted });
    expect(tagsOf(h).some((t) => t.name === "div" && t.attrs["aria-live"] === "polite")).toBe(true);
    const wiz = wizard(m, { 0: "install", 7: true });
    expect(tagsOf(wiz).some((t) => t.name === "p" && t.attrs["aria-live"] === "polite")).toBe(true);
    expect(wiz).toContain(m.apps.wizard.installing);
  });
});

describe("wizard", () => {
  it.each(LOCALES)("%s · aria-current=step marks exactly the current step, and ✓ plus a word marks the done ones", (_l, m) => {
    WIZARD_STEPS.forEach((step, at) => {
      const h = withState(WizardSteps, { current: step }, m);
      const list = tagsOf(h).find((t) => t.name === "ol");
      expect(list?.attrs["aria-label"], step).toBe(m.apps.wizard.stepsLabel);
      const current = [...h.matchAll(/<li\b[^>]*aria-current="step"[^>]*>([\s\S]*?)<\/li>/g)];
      expect(current, step).toHaveLength(1);
      expect(strip(current[0]![1]!)).toContain(m.apps.wizard.step[step]);
      expect(tagsOf(h).filter((t) => t.attrs["aria-current"] && t.attrs["aria-current"] !== "step")).toEqual([]);
      expect(h.split("✓").length - 1, `${step}: ✓ marks`).toBe(at);
      expect(h.split(`>${m.apps.wizard.done}<`).length - 1, `${step}: sr-only word`).toBe(at);
      // all five steps are named
      for (const s of WIZARD_STEPS) expect(h).toContain(m.apps.wizard.step[s]);
    });
  });

  it.each(LOCALES)("%s · every step body is a section named by an h2", (_l, m) => {
    for (const state of [{}, { 0: "domains" }, { 0: "review", 1: "x" }, { 0: "install" }]) {
      const h = wizard(m, state);
      const section = tagsOf(h).find((t) => t.name === "section");
      expect(section?.attrs["aria-labelledby"]).toBeTruthy();
      expect(tagsOf(h).filter((t) => t.name === "h2").map((t) => t.attrs.id)).toContain(section!.attrs["aria-labelledby"]);
      expect(inner(h, "h2")).toHaveLength(1);
    }
  });

  it.each(LOCALES)("%s · secret fields are password inputs without a value or a reveal button; help is tied with aria-describedby", (_l, m) => {
    for (const state of [{}, { 1: "n", 3: ["admin_password", "api_token"] }]) {
      const h = wizard(m, state);
      const secrets = controls(h).filter((c) => c.attrs.id === "app-param-admin_password" || c.attrs.id === "app-param-api_token");
      expect(secrets).toHaveLength(2);
      for (const c of secrets) {
        expect(c.attrs.type).toBe("password");
        expect(c.attrs.autocomplete).toBe("new-password");
        expect(c.attrs.spellcheck).toBe("false");
        expect(c.attrs["aria-describedby"]).toBe(`${c.attrs.id}-note`);
      }
      expect(inner(h, "button").filter((t) => /mostra|show|reveal|visible/i.test(t))).toEqual([]);
    }
    const typed = wizard(m, { 1: "n", 3: ["admin_password"] });
    expect(typed).toContain(m.apps.wizard.secretKept);
  });

  it.each(LOCALES)("%s · a refused field is aria-invalid with visible text and the page has one alert", (_l, m) => {
    const h = wizard(m, { 5: { name: "Bad name", "param:port": "Bad port" }, 6: "Check the form" });
    const invalid = controls(h).filter((c) => c.attrs["aria-invalid"] === "true");
    expect(invalid.map((c) => c.attrs.id).sort()).toEqual(["app-name", "app-param-port"]);
    expect(h).toContain("Bad name");
    expect(h).toContain("Bad port");
    expect(withRole(h, "alert")).toEqual(["Check the form"]);
    // a field without an error is not flagged
    expect(controls(wizard(m, {})).filter((c) => c.attrs["aria-invalid"])).toEqual([]);
  });

  it.each(LOCALES)("%s · a created stack that failed to finish offers a link inside the alert", (_l, m) => {
    const h = wizard(m, { 0: "install", 6: m.apps.wizard.secretFailed, 8: "stk_a1" });
    const alert = [...h.matchAll(/<div\b[^>]*role="alert"[^>]*>([\s\S]*?)<\/div>/g)][0]![1]!;
    expect(alert).toContain(m.apps.wizard.secretFailed);
    expect(alert).toContain('href="/apps/stk_a1"');
    expect(strip(alert)).toContain(m.apps.wizard.openApp);
  });
});

describe("catalog", () => {
  it.each(LOCALES)("%s · the filter is a labelled group of aria-pressed buttons, exactly one pressed", (_l, m) => {
    for (const [state, pressed] of [
      [{}, m.apps.catalog.all],
      [{ 0: "content" }, m.apps.category.content],
      [{ 0: "odd-kind" }, "odd-kind"],
    ] as const) {
      const h = withState(AppCatalog, { entries: [NOTES, WORKER], categories: ["content", "odd-kind"] }, m, state);
      const group = tagsOf(h).find((t) => t.attrs.role === "group");
      expect(group?.attrs["aria-label"]).toBe(m.apps.catalog.filterLabel);
      const buttons = [...h.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter((b) => /aria-pressed=/.test(b[1]!));
      expect(buttons).toHaveLength(3);
      const on = buttons.filter((b) => /aria-pressed="true"/.test(b[1]!));
      expect(on.map((b) => strip(b[2]!))).toEqual([pressed]);
      expect(buttons.filter((b) => /aria-pressed="false"/.test(b[1]!))).toHaveLength(2);
      expect(tagsOf(h).some((t) => t.attrs.role === "tablist" || t.attrs.role === "tab")).toBe(false);
    }
  });

  it.each(LOCALES)("%s · each card link names the application it installs", (_l, m) => {
    const h = withState(AppCatalog, { entries: [NOTES, WORKER], categories: [] }, m);
    const named = tagsOf(h).filter((t) => t.name === "a" && t.attrs.href?.startsWith("/apps/new/"));
    expect(named.map((t) => t.attrs["aria-label"])).toEqual([format(m.apps.catalog.chooseNamed, { name: "Notes" }), format(m.apps.catalog.chooseNamed, { name: "Worker" })]);
    // the visible text is a part of the accessible name (WCAG 2.5.3)
    for (const t of named) expect(t.attrs["aria-label"]).toContain(m.apps.catalog.choose);
  });
});

describe("destructive actions name the action in words", () => {
  const GENERIC = /^(ok|yes|no|sì|si|confirm|conferma|continue|continua|sure|fatto|done)$/i;
  const footerButtons = (h: string) => [...h.matchAll(/<footer\b[^>]*>([\s\S]*?)<\/footer>/g)].flatMap((f) => inner(f[1]!, "button"));
  const destructive = (h: string) =>
    [...h.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter((b) => /bg-destructive/.test(b[1]!) && /type="(button|submit)"/.test(b[1]!)).map((b) => strip(b[2]!));

  it.each(LOCALES)("%s · stop, delete, archive, remove, upgrade and rollback confirm buttons", (_l, m) => {
    const cases: [string, string, string[]][] = [
      ["stop", withState(AppStackActions, actionProps, m, { 3: true }), [m.apps.actions.stopConfirm]],
      ["delete", withState(AppStackDelete, deleteProps, m, { 0: true }), [m.apps.delete.confirm]],
      ["delete with data", withState(AppStackDelete, deleteProps, m, { 0: true, 2: true }), [m.apps.delete.confirmWithData]],
      ["domain remove", withState(AppStackDomains, domainsProps, m, { 5: "sdom_1" }), [m.apps.domains.remove]],
      ["archive", adminDetail(m, tdetail(TEMPLATES[0]!), USAGE, { 2: true }), [m.admin.appTemplates.detail.archiveConfirm]],
    ];
    for (const [name, h, expected] of cases) {
      const buttons = footerButtons(h);
      for (const word of expected) expect(buttons, name).toContain(word);
      for (const b of buttons) expect(b, `${name}: generic button text`).not.toMatch(GENERIC);
      expect(destructive(h).filter((t) => expected.includes(t)), name).not.toEqual([]);
      // the confirm button is not the same word as cancel
      expect(new Set(buttons).size, `${name}: two buttons say the same`).toBe(buttons.length);
    }
    for (const mode of ["upgrade", "rollback"] as const) {
      const h = planDialog(m, mode, { 0: DIFF });
      expect(footerButtons(h)).toContain(m.apps[mode].confirm);
      expect(m.apps[mode].confirm).not.toMatch(GENERIC);
    }
  });

  it.each(LOCALES)("%s · the typed name is required, and data destruction is a separate box that starts unticked", (_l, m) => {
    const h = withState(AppStackDelete, deleteProps, m, { 0: true });
    const box = controls(h).find((c) => c.attrs.id === "app-delete-data")!;
    expect(box.attrs.type).toBe("checkbox");
    expect(box.attrs.checked).toBeUndefined();
    expect(box.attrs["aria-describedby"]).toBe("app-delete-data-note");
    expect(h).toContain(m.apps.delete.keepNote);
    expect(withRole(h, "status")).toEqual([]); // no destruction warning while unticked
    // the confirm button is disabled until the exact name is typed
    expect([...h.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find((b) => strip(b[2]!) === m.apps.delete.confirm && /type="submit"/.test(b[1]!))![1]).toMatch(/\sdisabled=""/);
    const typed = withState(AppStackDelete, deleteProps, m, { 0: true, 1: "team-notes" });
    expect([...typed.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find((b) => strip(b[2]!) === m.apps.delete.confirm && /type="submit"/.test(b[1]!))![1]).not.toMatch(/\sdisabled=""/);
    // ticking it adds a sentence (not only a colour) with a hidden icon
    const ticked = withState(AppStackDelete, deleteProps, m, { 0: true, 1: "team-notes", 2: true });
    expect(controls(ticked).find((c) => c.attrs.id === "app-delete-data")!.attrs.checked).toBe("");
    expect(withRole(ticked, "status")).toEqual([m.apps.delete.destroyWarning]);
    expect(ticked).toMatch(/<svg[^>]*aria-hidden="true"/);
    // an application without data shows no data box at all
    expect(ids(withState(AppStackDelete, { ...deleteProps, hasData: false }, m, { 0: true }))).not.toContain("app-delete-data");
  });

  it.each(LOCALES)("%s · the plan dialogs gate the confirm button behind the acknowledgement when data is at risk", (_l, m) => {
    for (const mode of ["upgrade", "rollback"] as const) {
      const risk = planDialog(m, mode, { 0: DIFF });
      const confirmTag = (h: string) => [...h.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find((b) => strip(b[2]!) === m.apps[mode].confirm)![1]!;
      expect(confirmTag(risk)).toMatch(/\sdisabled=""/);
      const ack = controls(risk).find((c) => c.attrs.id === "app-plan-ack")!;
      expect(ack.attrs.type).toBe("checkbox");
      expect(ack.attrs.checked).toBeUndefined();
      expect(inner(risk, "label")).toContain(m.apps.rollback.ack);
      expect(confirmTag(planDialog(m, mode, { 0: DIFF, 2: true }))).not.toMatch(/\sdisabled=""/);
      const safe = planDialog(m, mode, { 0: { ...DIFF, dataRisk: false } });
      expect(ids(safe)).not.toContain("app-plan-ack");
      expect(confirmTag(safe)).not.toMatch(/\sdisabled=""/);
      // change words, the data warning sentence and the removed-data sentence all show
      for (const word of [m.apps.upgrade.change.updated, m.apps.upgrade.change.added, m.apps.upgrade.change.removed]) expect(risk).toContain(word);
      expect(risk).toContain(m.apps.upgrade.dataWarning);
      expect(risk).toContain(m.apps.upgrade.dataRemoved);
      expect(risk).toContain(m.apps.upgrade.downtime);
      // the loading dialog says so with a status, and confirm cannot be pressed
      const loading = planDialog(m, mode, {});
      expect(withRole(loading, "status")).toEqual([m.apps.upgrade.loading]);
      expect(confirmTag(loading)).toMatch(/\sdisabled=""/);
    }
  });
});

const ids = idsOf;

describe("words, not colours", () => {
  it.each(LOCALES)("%s · every stack status badge is a distinct word from the catalog", (_l, m) => {
    const words = APP_STACK_STATUSES.map((s) => {
      const h = html(createElement(StackStatusBadge, { status: s, m }), m);
      expect(strip(h), s).toBe(m.apps.status[s]);
      expect(strip(h), s).toMatch(/\p{L}{3,}/u);
      return strip(h);
    });
    expect(new Set(words).size).toBe(APP_STACK_STATUSES.length);
  });

  it.each(LOCALES)("%s · every component health badge is a distinct word from the catalog", (_l, m) => {
    const words = APP_STACK_COMPONENT_HEALTH.map((s) => {
      const h = html(createElement(HealthBadge, { health: s, m }), m);
      expect(strip(h), s).toBe(m.apps.health[s]);
      expect(strip(h), s).toMatch(/\p{L}{3,}/u);
      return strip(h);
    });
    expect(new Set(words).size).toBe(APP_STACK_COMPONENT_HEALTH.length);
  });

  it.each(LOCALES)("%s · domain and certificate states, template states, secret state and unhealthy components are worded", (_l, m) => {
    for (const status of DOMAIN_STATUSES)
      for (const certificateStatus of CERT_STATUSES) {
        const h = withState(AppStackDomains, { ...domainsProps, initial: [{ ...DOMAIN, status, certificateStatus }] }, m);
        expect(h, `${status}/${certificateStatus}`).toContain(`>${m.apps.domains.status[status]}<`);
        expect(h, `${status}/${certificateStatus}`).toContain(`>${m.apps.domains.certificate[certificateStatus]}<`);
      }
    const list = html(createElement(TemplateCatalog, { sites: [], apps: TEMPLATES, m }), m);
    for (const state of ["published", "draft", "archived"] as const) expect(list).toContain(`>${m.admin.appTemplates.state[state]}<`);
    const secrets = withState(AppStackSecrets, secretsProps, m);
    expect(secrets).toContain(`>${m.apps.secrets.set}<`);
    expect(secrets).toContain(`>${m.apps.secrets.unset}<`);
    const stacks = html(createElement(AppStackList, { stacks: STACKS, m, locale: localeOf(m) }), m);
    expect(stacks).toContain(format(m.apps.list.unhealthy, { n: 1 }));
    expect(stacks).toContain(`>${m.apps.status.degraded}<`);
    expect(stacks).toContain(`>${m.apps.status.draft}<`);
    const components = html(createElement(AppStackComponents, { components: DETAIL.components, m, locale: localeOf(m) }), m);
    expect(components).toContain(`>${m.apps.health.unhealthy}<`);
    expect(components).toContain(`>${m.apps.health.healthy}<`);
    expect(components).toContain(m.apps.components.neverChecked);
    const admin = adminDetail(m, tdetail(TEMPLATES[0]!), USAGE);
    expect(admin).toContain(`>${m.admin.appTemplates.stackStatus.running}<`);
  });

  it.each(LOCALES)("%s · the stack detail page puts the status in words and keeps a heading per section", async (_l, m) => {
    loc.value = localeOf(m);
    fetchUpstream.mockImplementation(async (p: string) =>
      ({ [UP]: ok(DETAIL), [`${UP}/deployments?limit=20`]: ok(DEPLOYMENTS), [`${UP}/domains`]: ok(DOMAINS) })[p] ?? { ok: false, status: 404, error: { error: { code: "NOT_FOUND" } } },
    );
    const h = html(await AppStackPage({ params: Promise.resolve({ stackId: "stk_a1" }) }), m);
    expectAccessible(h, "detail page");
    expect(inner(h, "h1")).toEqual(["team-notes"].map((n) => n));
    expect(inner(h, "h2")).toEqual(
      ["components", "logs", "settings", "domains", "data", "resources", "history", "danger"].map((k) => (m.apps.detail.section as Record<string, string>)[k]),
    );
    // every section is a region named by its own heading
    const sections = tagsOf(h).filter((t) => t.name === "section");
    const headings = new Set(tagsOf(h).filter((t) => t.name === "h1" || t.name === "h2").map((t) => t.attrs.id));
    expect(sections.length).toBe(9);
    for (const s of sections) expect(headings.has(s.attrs["aria-labelledby"]!), s.attrs["aria-labelledby"]).toBe(true);
    expect(h).toContain(`>${m.apps.status.degraded}<`);
    for (const t of tagsOf(h).filter((x) => x.name === "time")) expect(t.attrs.datetime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(tagsOf(h).filter((x) => x.name === "time").length).toBeGreaterThanOrEqual(5);
  });

  it.each(LOCALES)("%s · the draft and unknown states explain themselves in a status region", async (_l, m) => {
    loc.value = localeOf(m);
    for (const [status, text] of [
      ["unknown", m.apps.detail.unknownBody],
      ["draft", m.apps.detail.draftBody],
    ] as const) {
      fetchUpstream.mockImplementation(async (p: string) => (p === UP ? ok({ ...DETAIL, status, revisionNumber: null }) : ok(p.endsWith("/domains") ? [] : [])));
      const h = html(await AppStackPage({ params: Promise.resolve({ stackId: "stk_a1" }) }), m);
      expect(withRole(h, "status").join(" "), status).toContain(text);
      expect(withRole(h, "alert"), status).toEqual([]);
    }
  });
});

describe("dates", () => {
  it.each(LOCALES)("%s · every date is a <time> whose dateTime is the ISO value and whose text follows the locale", (_l, m) => {
    const cases: [string, string][] = [
      ["list", html(createElement(AppStackList, { stacks: STACKS, m, locale: localeOf(m) }), m)],
      ["history", html(createElement(AppStackHistory, { deployments: DEPLOYMENTS, m, locale: localeOf(m) }), m)],
      ["components", html(createElement(AppStackComponents, { components: DETAIL.components, m, locale: localeOf(m) }), m)],
      ["secrets", withState(AppStackSecrets, secretsProps, m)],
      ["domains", withState(AppStackDomains, domainsProps, m)],
      ["logs", withState(AppStackLogs, { orgId: ORG, stackId: "stk_a1", componentKeys: ["web"] }, m, { 1: [{ at: NOW, stream: "stdout", text: "x" }] })],
      ["admin detail", adminDetail(m, tdetail(TEMPLATES[0]!), USAGE)],
    ];
    for (const [name, h] of cases) {
      const times = [...h.matchAll(/<time\b[^>]*dateTime="([^"]*)"[^>]*>([\s\S]*?)<\/time>/gi)];
      expect(times.length, name).toBeGreaterThan(0);
      for (const [, iso, text] of times) {
        expect(Number.isNaN(Date.parse(iso!)), `${name}: ${iso}`).toBe(false);
        expect(strip(text!), name).toMatch(/\d/);
      }
    }
    // the same instant reads differently in the two languages
    const it_ = html(createElement(AppStackList, { stacks: [STACK], m: itMsgs, locale: "it" }), itMsgs).match(/<time[^>]*>([^<]*)<\/time>/)![1];
    const en_ = html(createElement(AppStackList, { stacks: [STACK], m: en, locale: "en" }), en).match(/<time[^>]*>([^<]*)<\/time>/)![1];
    expect(it_).not.toBe(en_);
  });
});

describe("admin pages", () => {
  it.each(LOCALES)("%s · the enable switch is a labelled role=switch with a hint", (_l, m) => {
    const h = adminDetail(m, tdetail(TEMPLATES[0]!), USAGE);
    const sw = controls(h).find((c) => c.attrs.id === "app-template-enabled")!;
    expect(sw.attrs.role).toBe("switch");
    expect(sw.attrs["aria-describedby"]).toBe("app-template-enabled-hint");
    expect(inner(h, "label")).toContain(m.admin.appTemplates.detail.enabled);
    expect(h).toContain(m.admin.appTemplates.detail.enabledHint);
    // a built-in template has no archive button; an archived or default-less one cannot be switched
    expect(inner(adminDetail(m, tdetail(TEMPLATES[1]!), USAGE), "button")).not.toContain(m.admin.appTemplates.detail.archive);
    expect(inner(h, "button")).toContain(m.admin.appTemplates.detail.archive);
    expect(controls(adminDetail(m, tdetail(TEMPLATES[3]!), USAGE)).find((c) => c.attrs.id === "app-template-enabled")!.attrs.disabled).toBe("");
  });

  it.each(LOCALES)("%s · the editor's text area is labelled, described, and flags the lines it marks", (_l, m) => {
    const h = editor(m, VERSION, { 1: INVALID });
    const area = tagsOf(h).find((t) => t.name === "textarea")!;
    expect(area.attrs.id).toBe("app-template-source");
    expect(area.attrs["aria-label"]).toBe(m.admin.appTemplates.editor.source);
    expect(area.attrs["aria-invalid"]).toBe("true");
    expect(area.attrs["aria-describedby"]).toBe("app-template-source-hint app-template-source-status");
    expect(withRole(h, "status")).toContain(m.admin.appTemplates.editor.syntaxOk);
    // an archived version cannot be edited, and says so in a status
    const archived = editor(m, ARCHIVED);
    expect(tagsOf(archived).find((t) => t.name === "textarea")!.attrs.readonly).toBe("");
    expect(withRole(archived, "status")).toContain(m.admin.appTemplates.editor.archived);
    // a slug that is taken is reported once, tied to the field
    const taken = editor(m, CREATE, { 2: m.admin.appTemplates.reasons.slug_taken, 5: "notes" });
    expect(tagsOf(taken).find((t) => t.attrs.id === "app-template-slug")!.attrs["aria-describedby"]).toBe("app-template-slug-hint app-template-slug-error");
    expect(withRole(taken, "alert")).toEqual([m.admin.appTemplates.reasons.slug_taken]);
  });

  it.each(LOCALES)("%s · the preview is plain text in a <pre>, never markup", (_l, m) => {
    const evil = { ...VALID, preview: { note: "<img src=x onerror=alert(1)>" } } as unknown as AppTemplateValidationDto;
    const h = editor(m, VERSION, { 1: evil });
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;img");
  });
});

describe("gates", () => {
  it.each(LOCALES)("%s · the unavailable notice is a status with a way back, and names why", (_l, m) => {
    for (const reason of ["off", "support"] as const) {
      const h = html(createElement(AppsUnavailable, { m, reason }), m);
      expect(withRole(h, "status").join(" ")).toContain(m.apps.unavailable[reason]);
      expect(tagsOf(h).filter((t) => t.name === "a").map((t) => t.attrs.href)).toEqual(["/apps"]);
      expect(inner(h, "a")).toEqual([m.apps.unavailable.back]);
    }
    expect(m.apps.unavailable.off).not.toBe(m.apps.unavailable.support);
  });
});

// ------------------------------------------------------------------------------------------------ i18n

type Tree = { [k: string]: string | Tree };
const leaves = (t: Tree, prefix = ""): [string, string][] =>
  Object.entries(t).flatMap(([k, v]) => (typeof v === "string" ? [[`${prefix}${k}`, v] as [string, string]] : leaves(v, `${prefix}${k}.`)));
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]!).sort();

describe("Italian and English", () => {
  const sections: [string, (m: Messages) => Tree][] = [
    ["apps", (m) => m.apps as unknown as Tree],
    ["admin.appTemplates", (m) => m.admin.appTemplates as unknown as Tree],
  ];

  it.each(sections)("%s has the same leaves, no empty one and the same placeholders in both languages", (_name, pick) => {
    const it_ = new Map(leaves(pick(itMsgs)));
    const en_ = new Map(leaves(pick(en)));
    expect(it_.size).toBe(en_.size);
    expect([...it_.keys()].sort()).toEqual([...en_.keys()].sort());
    expect(it_.size).toBeGreaterThan(100);
    for (const [k, v] of it_) {
      expect(v.trim(), `it ${k}`).not.toBe("");
      expect(en_.get(k)!.trim(), `en ${k}`).not.toBe("");
      expect(placeholders(v), k).toEqual(placeholders(en_.get(k)!));
    }
  });

  it("most Italian sentences differ from the English ones (the catalog is translated, not copied)", () => {
    for (const [, pick] of sections) {
      const it_ = new Map(leaves(pick(itMsgs)));
      // the YAML starter is a code sample, the same in both languages
      const same = leaves(pick(en)).filter(([k, v]) => v.length > 25 && it_.get(k) === v && k !== "editor.starter");
      expect(same.map(([k]) => k)).toEqual([]);
    }
  });

  // Same props, same markup in both languages ⇒ some text is hard-coded. What may match: fixture data and units.
  const FIXTURE = new Set([
    "Notes", "Worker", "Http cache", "Alpha", "Aardvark", "team-notes", "scratch", "notes.example.test", "wiki.example.test", "web", "cache", "admin", "notes", "stdout",
    "stderr", "started", "Site title", "Team notes", "Max users", "Admin password", "Mail key", "Board title", "Listen port", "Mode", "Public board", "API token",
    "SITE_TITLE", "MAX_USERS", "ADMIN_PASSWORD", "MAIL_KEY", "title", "port", "mode", "small", "large", "stk_a1", "my-notes", "team-board", "Acme Srl", "atpl_notes",
    "Title", "Database password", "db_password", "secret", "string", "msg", "services.web", "IMAGE_DIGEST_REQUIRED", "odd-kind", "Check the form", "Bad name", "Bad port",
    "bad host", "x", "No", "Shared notes for the team.", "mystery", "this line is not aligned with its siblings", "notes.example.test:8080", "Notes.Example.test", "https", "HTTP", "Docker",
  ]);
  const bothLanguagesAlike = new Set(
    [...sections].flatMap(([, pick]) => {
      const it_ = new Map(leaves(pick(itMsgs)));
      return leaves(pick(en)).filter(([k, v]) => it_.get(k) === v).map(([, v]) => v);
    }),
  );
  const allowed = (node: string) => {
    // log lines (escaped), the template source and the parser's own message are data, not panel wording
    if (node.startsWith("&lt;") || node.startsWith("# HCP-STACK") || node.startsWith("services:")) return true;
    const bare = node.replace(/\b(vCPU|MiB|GiB)\b/g, "").replace(/\{[^}]*\}/g, "");
    if (!/\p{L}{3,}/u.test(bare)) return true;
    if (FIXTURE.has(node) || bothLanguagesAlike.has(node)) return true;
    // a fixture name inside a longer sentence ("Notes · version 2" has no shared words besides the name)
    const rest = [...FIXTURE].reduce((s, f) => s.split(f).join(" "), node);
    return !/\p{L}{3,}/u.test(rest.replace(/\b(vCPU|MiB|GiB)\b/g, ""));
  };

  it.each(SCENARIOS.map((s) => [s.name, s] as const))("%s: no text is the same in both languages unless it is data", (_name, s) => {
    const itNodes = new Set(textNodes(s.render(itMsgs)));
    const enNodes = new Set(textNodes(s.render(en)));
    const shared = [...itNodes].filter((n) => enNodes.has(n) && !allowed(n));
    expect(shared).toEqual([]);
    // and the two markups are different documents
    // a scenario that only shows data (settings values) has no wording to translate
    if (!/settings/.test(s.name)) expect(s.render(itMsgs)).not.toBe(s.render(en));
  });

  it("the stack detail page differs between the languages everywhere a sentence appears", async () => {
    const page = async (m: Messages) => {
      loc.value = localeOf(m);
      fetchUpstream.mockImplementation(async (p: string) =>
        ({ [UP]: ok(DETAIL), [`${UP}/deployments?limit=20`]: ok(DEPLOYMENTS), [`${UP}/domains`]: ok(DOMAINS) })[p] ?? { ok: false, status: 404, error: { error: { code: "NOT_FOUND" } } },
      );
      return html(await AppStackPage({ params: Promise.resolve({ stackId: "stk_a1" }) }), m);
    };
    const [itHtml, enHtml] = [await page(itMsgs), await page(en)];
    expect(itHtml).not.toBe(enHtml);
    const shared = textNodes(itHtml).filter((n) => textNodes(enHtml).includes(n) && !allowed(n));
    expect(shared).toEqual([]);
    expect(itHtml).not.toContain(en.apps.detail.section.components);
    expect(enHtml).not.toContain(itMsgs.apps.detail.section.components);
  });

  it.each(LOCALES)("%s · refusal sentences are in the page language", (_l, m) => {
    const h = withState(AppStackActions, actionProps, m, { 2: m.apps.reasons.plan_changed });
    expect(h).toContain(m.apps.reasons.plan_changed);
    const other = m === en ? itMsgs : en;
    expect(h).not.toContain(other.apps.reasons.plan_changed);
  });
});
