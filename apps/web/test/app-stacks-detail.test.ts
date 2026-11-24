import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UpdateAppStackDomainInputSchema,
  type AppStackBackupsDto,
  type AppStackDeploymentDto,
  type AppStackDetailDto,
  type AppStackDomainDto,
  type AppStackLinkDto,
  type AppStackLinksDto,
} from "@hosting-panel/contracts";

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
import { AppStackDomainOptions, buildDomainOptions } from "@/components/app-stacks/app-stack-domain-options";
import { AppStackLinks } from "@/components/app-stacks/app-stack-links";

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
  installed: null,
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
  pathTargets: [{ componentKey: "web", port: 8080 }],
  routesPending: false,
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
  redirectToDomainId: null,
  compression: false,
  protection: null,
  pathRoutes: [],
  removing: false,
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
const LINK: AppStackLinkDto = {
  id: "slnk_1",
  state: "active",
  createdAt: NOW,
  databaseStackId: "stk_db1",
  databaseName: "orders-db",
  databaseKind: "Database MariaDB",
  applicationStackId: "stk_a1",
  applicationName: "team-notes",
  connection: { host: "stk-db1-0123456789abcdef0123456789", port: 3306 },
};
const LINKS: AppStackLinksDto = {
  stackId: "stk_a1",
  role: "application",
  connection: null,
  links: [LINK],
  candidates: [
    { stackId: "stk_db2", name: "cache", kind: "Archivio Valkey" },
    { stackId: "stk_db3", name: "reports-db", kind: "Database PostgreSQL" },
  ],
  limit: 4,
};
const DATABASE_LINKS: AppStackLinksDto = { stackId: "stk_db1", role: "database", connection: LINK.connection, links: [LINK], candidates: [], limit: 8 };

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
  answer({
    [UP]: ok(DETAIL),
    [`${UP}/deployments?limit=20`]: ok(DEPLOYMENTS),
    [`${UP}/domains`]: ok([DOMAIN]),
    [`${UP}/backups`]: ok(BACKUPS),
    [`${UP}/links`]: ok(LINKS),
  });
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

  it("reads the application, its history, its addresses, its backups and its databases and renders every section in order", async () => {
    const h = await page();
    expect(reads()).toEqual([UP, `${UP}/deployments?limit=20`, `${UP}/domains`, `${UP}/backups`, `${UP}/links`]);
    expect(h).toMatch(/<h1[^>]*>team-notes<\/h1>/);
    expect(h).toContain(en.apps.status.degraded);
    expect(h).toContain(format(en.apps.detail.versionLine, { name: "Notes", n: 2 }));
    expect(h).toContain(format(en.apps.detail.releaseLine, { n: 3 }));
    const s = en.apps.detail.section;
    expect(h2s(h)).toEqual([s.components, s.logs, s.settings, s.links, s.domains, s.data, s.backups, s.resources, s.history, s.danger]);
    expect(h).toContain("orders-db");
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

  it("a failed history, address, backup or database read shows the section error and the page still renders", async () => {
    answer({ [UP]: ok(DETAIL) });
    const h = await page();
    expect(h.split(en.apps.detail.sectionError)).toHaveLength(5);
    expect(h2s(h)).toContain(en.apps.detail.section.links);
    expect(h).not.toContain(en.apps.backups.create);
    expect(h).toContain(en.apps.detail.section.danger);
  });

  it("an address whose saved options are not published yet says so on the page", async () => {
    const shown = [{ ...DOMAIN, protection: { username: "guest" } }];
    answer({ [UP]: ok({ ...DETAIL, routesPending: true }), [`${UP}/deployments?limit=20`]: ok([]), [`${UP}/domains`]: ok(shown) });
    expect(await page()).toContain(en.apps.domains.options.summary.pending);
    answer({ [UP]: ok(DETAIL), [`${UP}/deployments?limit=20`]: ok([]), [`${UP}/domains`]: ok(shown) });
    const published = await page();
    expect(published).toContain(en.apps.domains.options.summary.protected);
    expect(published).not.toContain(en.apps.domains.options.summary.pending);
  });

  it("a change that failed once its components were created: the page names the version installed and the one that was not", async () => {
    const failed: AppStackDetailDto = { ...DETAIL, status: "failed", installed: { revisionNumber: 1, templateVersionNumber: 1 } };
    for (const m of [en, itMsgs]) {
      loc.value = m === en ? "en" : "it";
      answer({ [UP]: ok(failed), [`${UP}/deployments?limit=20`]: ok(DEPLOYMENTS), [`${UP}/domains`]: ok([DOMAIN]) });
      const h = await page();
      expect(h).toContain(format(m.apps.detail.versionLine, { name: "Notes", n: 1 }));
      expect(h).toContain(format(m.apps.detail.releaseLine, { n: 1 }));
      expect(h).toContain(format(m.apps.detail.notInstalledLine, { version: 2, release: 3 }));
      expect(h).not.toContain(format(m.apps.detail.versionLine, { name: "Notes", n: 2 }));
    }
    // While a change runs, the page names what is installed and says nothing failed.
    loc.value = "en";
    answer({ [UP]: ok({ ...failed, status: "updating", activeOperationId: "op_8" }), [`${UP}/deployments?limit=20`]: ok([]), [`${UP}/domains`]: ok([]) });
    const busy = await page();
    expect(busy).toContain(format(en.apps.detail.versionLine, { name: "Notes", n: 1 }));
    expect(busy).not.toContain(format(en.apps.detail.notInstalledLine, { version: 2, release: 3 }));
    // With what is installed being the current version, there is nothing to say.
    answer({ [UP]: ok(DETAIL), [`${UP}/deployments?limit=20`]: ok([]), [`${UP}/domains`]: ok([]) });
    expect(await page()).not.toContain(format(en.apps.detail.notInstalledLine, { version: 2, release: 3 }));
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

  it("a value carrying a platform process mark is a field error that says why, and sends nothing (ADR-0041)", async () => {
    for (const m of [en, itMsgs]) {
      const { out, sets } = callHooks(AppStackSecrets, props, m, { 0: "ADMIN_PASSWORD" });
      const ref = byId(out, "app-secret-value")!.props.ref as { current: { value: string } | null };
      ref.current = { value: "pw HP_TASK_RUN=srun_" };
      await submit(out);
      expect(keyedSend).not.toHaveBeenCalled();
      expect(sets).toContainEqual([2, m.apps.wizard.valueReserved]);
      expect(ref.current.value).toBe("pw HP_TASK_RUN=srun_"); // kept, so the customer can correct it
    }
  });

  it("a configuration pasted as a private value keeps its PHP lines and is sent", async () => {
    const dotenv = "APP_ENV=production\nPHP_CLI_SERVER_WORKERS=4\nHP_HOME=/x\n";
    const { out, sets } = callHooks(AppStackSecrets, props, en, { 0: "ADMIN_PASSWORD" });
    (byId(out, "app-secret-value")!.props.ref as { current: unknown }).current = { value: dotenv };
    keyedSend.mockResolvedValue({ ok: true, data: { data: { key: "ADMIN_PASSWORD", isSet: true, version: 3, setAt: NOW } } });
    await submit(out);
    expect(keyedSend).toHaveBeenCalledWith(expect.any(Object), "csrf", "secret:ADMIN_PASSWORD", "POST", `${BASE}/secrets`, {
      parameterKey: "ADMIN_PASSWORD",
      value: dotenv,
    });
    expect(sets).not.toContainEqual([2, en.apps.wizard.valueReserved]);
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

  it.each([
    ["en", en],
    ["it", itMsgs],
  ] as const)("%s: a value too long for the application is an error on the field that states the limit", async (_n, m) => {
    const { out, sets } = callHooks(AppStackSecrets, props, m, { 0: "ADMIN_PASSWORD" });
    (byId(out, "app-secret-value")!.props.ref as { current: unknown }).current = { value: "x".repeat(5_000) };
    keyedSend.mockResolvedValue({ ok: false, code: "VALIDATION_ERROR", reason: "value_too_long" });
    await submit(out);
    const text = format(m.apps.reasons.value_too_long, { max: 4096 });
    expect(text).toContain("4096");
    expect(text).not.toMatch(/byte|ambiente|environment|variab/i);
    expect(sets).toContainEqual([2, text]);
    expect(sets.filter(([k, v]) => k === 3 && v !== null)).toEqual([]);
    const shown = html(callHooks(AppStackSecrets, props, m, { 0: "ADMIN_PASSWORD", 2: text }).out);
    expect(shown).toMatch(/<input[^>]*aria-invalid="true"/);
    expect(shown).toContain(text);
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
  const props = (over: Record<string, unknown> = {}) => ({
    orgId: ORG,
    stackId: "stk_a1",
    csrfToken: "csrf",
    initial: [DOMAIN],
    ingress: INGRESS,
    pathTargets: INGRESS,
    pending: false,
    ...over,
  });
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

  it("add sends the trimmed lower-cased address, its target and compression on; the answered list replaces the rows", async () => {
    const { out, sets } = callHooks(AppStackDomains, props(), en, { 1: "  Notes2.Example.TEST ", 2: 1 });
    keyedSend.mockResolvedValue({ ok: true, data: { data: [DOMAIN, SECOND] } });
    await submit(out);
    expect(keyedSend).toHaveBeenCalledWith(expect.any(Object), "csrf", "add", "POST", `${BASE}/domains`, {
      hostname: "notes2.example.test",
      componentKey: "admin",
      port: 9000,
      compression: true,
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

  it("an address being removed reads so, with no button, and leaves its place in the limit (issue #112)", () => {
    const going: AppStackDomainDto = { ...SECOND, id: "sdom_9", hostname: "old.example.test", removing: true };
    const { out } = callHooks(AppStackDomains, props({ initial: [DOMAIN, going] }));
    const h = html(out);
    expect(h).toContain("old.example.test");
    expect(h).toContain(en.apps.domains.removing);
    expect(h).toContain(en.apps.domains.removingHint);
    expect(h).not.toContain(en.apps.domains.status.pending);
    expect(buttons(out, en.apps.domains.remove).filter((b) => b.props.variant !== "destructive")).toHaveLength(1);
    expect(buttons(out, en.apps.domains.options.open)).toHaveLength(1);
    expect(html(callHooks(AppStackDomains, props()).out)).not.toContain(en.apps.domains.removing);
    const seven = Array.from({ length: 7 }, (_, i) => ({ ...DOMAIN, id: `sdom_${i}`, hostname: `n${i}.example.test` }));
    expect(html(callHooks(AppStackDomains, props({ initial: [...seven, going] })).out)).toContain("app-domain-hostname");
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

describe("databases", () => {
  const props = (over: Record<string, unknown> = {}) => ({ orgId: ORG, stackId: "stk_a1", csrfToken: "csrf", initial: LINKS, ...over });
  // The button of a row; the destructive one is the confirmation inside the dialog.
  const rowButtons = (tree: unknown) => buttons(tree, en.apps.links.disconnect).filter((b) => b.props.variant !== "destructive");
  const quota = format(en.apps.links.limitReached, { databases: 4, applications: 8 });

  it("an application lists the databases it uses, where each is reached and its state, and offers the others", () => {
    const h = html(callHooks(AppStackLinks, props()).out);
    for (const t of ["orders-db", "Database MariaDB", "stk-db1-0123456789abcdef0123456789", "3306", en.apps.links.state.active, en.apps.links.connectHint]) {
      expect(h).toContain(t);
    }
    expect(h).toContain('href="/apps/stk_db1"');
    expect(h).toMatch(/<label[^>]*for="app-link-database"/);
    expect(h).toContain(format(en.apps.links.candidate, { name: "cache", kind: "Archivio Valkey" }));
    expect(h).toContain(format(en.apps.links.candidate, { name: "reports-db", kind: "Database PostgreSQL" }));
    expect(rowButtons(callHooks(AppStackLinks, props()).out)).toHaveLength(1);
    for (const absent of [en.apps.links.addressTitle, en.apps.links.usedByTitle, en.apps.links.pendingHint, en.apps.links.limit.replace("{n}", "4")]) {
      expect(h).not.toContain(absent);
    }
    expect(h).not.toMatch(/hp_app|hp_appnet|sha256|password/i);
  });

  it("a database shows where it is reached and the applications that use it, and has no connect form", () => {
    const h = html(callHooks(AppStackLinks, props({ stackId: "stk_db1", initial: DATABASE_LINKS })).out);
    for (const t of [en.apps.links.addressTitle, "stk-db1-0123456789abcdef0123456789", "3306", en.apps.links.addressHint, en.apps.links.usedByTitle, "team-notes", en.apps.links.usedByHint]) {
      expect(h).toContain(t);
    }
    expect(h).toContain('href="/apps/stk_a1"');
    expect(h).not.toContain("app-link-database");
    expect(h).not.toContain(en.apps.links.connect);
    expect(h).not.toContain("Database MariaDB");

    const unused = html(callHooks(AppStackLinks, props({ initial: { ...DATABASE_LINKS, links: [] } })).out);
    expect(unused).toContain(en.apps.links.usedByNone);
    const closed = html(callHooks(AppStackLinks, props({ initial: { ...DATABASE_LINKS, connection: null, links: [] } })).out);
    expect(closed).toContain(en.apps.links.notLinkable);
    expect(closed).not.toContain(en.apps.links.addressHint);
  });

  it("null → section error; no link → the empty line; four links → the limit and no form; no other database → the catalog", () => {
    expect(html(callHooks(AppStackLinks, props({ initial: null })).out)).toContain(en.apps.detail.sectionError);
    expect(html(callHooks(AppStackLinks, props({ initial: { ...LINKS, links: [] } })).out)).toContain(en.apps.links.none);
    const four = Array.from({ length: 4 }, (_, i) => ({ ...LINK, id: `slnk_${i}`, databaseStackId: `stk_db${i}` }));
    const full = html(callHooks(AppStackLinks, props({ initial: { ...LINKS, links: four } })).out);
    expect(full).toContain(format(en.apps.links.limit, { n: 4 }));
    expect(full).not.toContain("app-link-database");
    const alone = html(callHooks(AppStackLinks, props({ initial: { ...LINKS, candidates: [] } })).out);
    expect(alone).toContain(en.apps.links.noCandidates);
    expect(alone).toMatch(new RegExp(`<a[^>]*href="/apps/new"[^>]*>${en.apps.links.catalog}<`));
    expect(alone).not.toContain("app-link-database");
  });

  it("a link that waits says it becomes active by itself; one being disconnected offers no button; no address reads as a dash", () => {
    const waiting = { ...LINKS, links: [{ ...LINK, state: "pending" as const }] };
    const w = html(callHooks(AppStackLinks, props({ initial: waiting })).out);
    expect(w).toContain(en.apps.links.state.pending);
    expect(w).toContain(en.apps.links.pendingHint);
    const leaving = { ...LINKS, links: [{ ...LINK, state: "removing" as const, connection: null }] };
    const { out } = callHooks(AppStackLinks, props({ initial: leaving }));
    expect(html(out)).toContain(en.apps.links.state.removing);
    expect(html(out)).toContain(`<p class="text-muted-foreground">${en.apps.links.noAddress}</p>`);
    expect(rowButtons(out)).toEqual([]);
    expect(html(callHooks(AppStackLinks, props({ initial: leaving }), itMsgs).out, itMsgs)).toContain("Scollegamento in corso");
  });

  it("connect sends the chosen database, the first one when none was chosen; the answer replaces the section", async () => {
    const next = { ...LINKS, links: [LINK, { ...LINK, id: "slnk_2", databaseStackId: "stk_db3", databaseName: "reports-db", databaseKind: "Database PostgreSQL" }], candidates: [LINKS.candidates[0]!] };
    keyedSend.mockResolvedValue({ ok: true, data: { data: next } });
    const chosen = callHooks(AppStackLinks, props(), en, { 1: "stk_db3" });
    await submit(chosen.out);
    expect(keyedSend).toHaveBeenCalledWith(expect.any(Object), "csrf", "connect:stk_db3", "POST", `${BASE}/links`, { databaseStackId: "stk_db3" });
    expect(chosen.sets).toContainEqual([0, next]);
    expect(chosen.sets).toContainEqual([1, ""]);
    expect(router.refresh).toHaveBeenCalledOnce();

    keyedSend.mockClear();
    // A choice that is no longer offered falls back to the first one, like no choice at all.
    for (const state of [{}, { 1: "stk_gone" }]) await submit(callHooks(AppStackLinks, props(), en, state).out);
    expect(keyedSend.mock.calls.map((c) => c[5])).toEqual([{ databaseStackId: "stk_db2" }, { databaseStackId: "stk_db2" }]);
  });

  it("an answer that is not the section is not shown, and nothing is sent while a call is running", async () => {
    keyedSend.mockResolvedValue({ ok: true, data: { data: { ...LINKS, role: "proxy" } } });
    const odd = callHooks(AppStackLinks, props());
    await submit(odd.out);
    expect(odd.sets.filter(([slot]) => slot === 0)).toEqual([]);
    expect(router.refresh).toHaveBeenCalledOnce();

    keyedSend.mockClear();
    await submit(callHooks(AppStackLinks, props(), en, { 2: true }).out);
    expect(keyedSend).not.toHaveBeenCalled();
  });

  it("the limit of links has its own sentence; the other refusals read as their reason", async () => {
    for (const [refusal, text] of [
      [{ code: "VALIDATION_ERROR", reason: "STACK_QUOTA_EXCEEDED" }, quota],
      [{ code: "ALREADY_EXISTS", reason: "link_exists" }, en.apps.reasons.link_exists],
      [{ code: "VALIDATION_ERROR", reason: "database_not_linkable" }, en.apps.reasons.database_not_linkable],
      [{ code: "VALIDATION_ERROR", reason: "not_a_database" }, en.apps.reasons.not_a_database],
      [{ code: "VALIDATION_ERROR", reason: "database_as_application" }, en.apps.reasons.database_as_application],
      [{ code: "RESOURCE_LOCKED", reason: "deploying" }, format(en.apps.reasons.status, { status: en.apps.status.deploying })],
    ] as const) {
      keyedSend.mockResolvedValue({ ok: false, ...refusal });
      const { out, sets } = callHooks(AppStackLinks, props());
      await submit(out);
      expect(sets, refusal.reason).toContainEqual([3, text]);
      expect(sets.filter(([slot]) => slot === 0), refusal.reason).toEqual([]);
    }
    expect(quota).not.toBe(en.apps.reasons.STACK_QUOTA_EXCEEDED);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("disconnect asks first and names both sides, then deletes the link and shows the answer", async () => {
    const closed = callHooks(AppStackLinks, props());
    (rowButtons(closed.out)[0]!.props.onClick as () => void)();
    expect(closed.sets).toEqual([[4, "slnk_1"]]);
    expect(keyedSend).not.toHaveBeenCalled();

    const { out, sets } = callHooks(AppStackLinks, props(), en, { 4: "slnk_1" });
    const h = html(out);
    expect(h).toContain(en.apps.links.disconnectTitle);
    expect(h).toContain(format(en.apps.links.disconnectBody, { application: "team-notes", database: "orders-db" }));
    const after = { ...LINKS, links: [], candidates: [{ stackId: "stk_db1", name: "orders-db", kind: "Database MariaDB" }, ...LINKS.candidates] };
    keyedSend.mockResolvedValue({ ok: true, data: { data: after } });
    const confirm = buttons(out, en.apps.links.disconnect).find((b) => b.props.variant === "destructive");
    await (confirm!.props.onClick as () => Promise<void>)();
    expect(keyedSend).toHaveBeenCalledWith(expect.any(Object), "csrf", "disconnect:slnk_1", "DELETE", `${BASE}/links/slnk_1`, {});
    expect(sets).toContainEqual([0, after]);
    expect(sets).toContainEqual([4, null]);
    expect(html(callHooks(AppStackLinks, props()).out)).not.toContain(en.apps.links.disconnectTitle);
  });

  it("a refresh of the page brings the fresh answer; a failed read keeps what is shown", () => {
    const fresh = { ...LINKS, links: [{ ...LINK, state: "active" as const }] };
    const stale = { ...LINKS, links: [{ ...LINK, state: "pending" as const }] };
    const { sets, effects } = callHooks(AppStackLinks, props({ initial: fresh }), en, { 0: stale });
    for (const f of effects) f();
    expect(sets).toContainEqual([0, fresh]);
    const failed = callHooks(AppStackLinks, props({ initial: null }), en, { 0: stale });
    for (const f of failed.effects) f();
    expect(failed.sets).toEqual([]);
  });

  it("the page names the section by what the application is: «Databases» or «Connection»", async () => {
    expect(h2s(await page())).toContain(en.apps.detail.section.links);
    answer({ [UP]: ok(DETAIL), [`${UP}/deployments?limit=20`]: ok([]), [`${UP}/domains`]: ok([]), [`${UP}/links`]: ok(DATABASE_LINKS) });
    const h = await page();
    expect(h2s(h)).toContain(en.apps.detail.section.connection);
    expect(h2s(h)).not.toContain(en.apps.detail.section.links);
    expect(h).toContain(en.apps.links.addressTitle);
  });
});

describe("address options (ADR-0037)", () => {
  const INGRESS = [
    { componentKey: "web", port: 8080 },
    { componentKey: "admin", port: 9000 },
  ];
  const SECOND: AppStackDomainDto = { ...DOMAIN, id: "sdom_2", hostname: "notes2.example.test", status: "pending", certificateStatus: "requested", certificateExpiresAt: null };
  const THIRD: AppStackDomainDto = { ...SECOND, id: "sdom_3", hostname: "old.example.test", redirectToDomainId: "sdom_2" };
  const PASSWORD = "correct horse battery";
  const PLAIN = { redirectTo: "", compression: false, protect: false, username: "", password: "", paths: [] };
  const API_PATH = { pathPrefix: "/api", target: "admin:9000", stripPrefix: true };
  const o = en.apps.domains.options;
  const props = (over: Record<string, unknown> = {}) => ({
    orgId: ORG,
    stackId: "stk_a1",
    csrfToken: "csrf",
    initial: [DOMAIN, SECOND],
    ingress: INGRESS,
    pathTargets: INGRESS,
    pending: false,
    ...over,
  });
  const dialogProps = (over: Record<string, unknown> = {}) => ({
    domain: DOMAIN,
    rows: [DOMAIN, SECOND],
    ingress: INGRESS,
    busy: false,
    error: null,
    onSave: vi.fn(),
    onClose: vi.fn(),
    ...over,
  });
  const dialogOf = (tree: unknown) => els(tree).find((e) => e.type === AppStackDomainOptions);
  const save = (tree: unknown, body: unknown) => (dialogOf(tree)!.props.onSave as (b: unknown) => Promise<void>)(body);
  const alerts = (h: string) => h.match(/role="alert"/g) ?? [];
  /** The opening tag of the field with that id, whatever the order of its attributes. */
  const tag = (h: string, id: string) => h.match(new RegExp(`<(?:input|select)\\b[^>]*\\sid="${id}"[^>]*>`))?.[0] ?? "";

  it("the form builds the four options together, and every body it builds is one the API accepts", () => {
    const built = [
      buildDomainOptions(PLAIN, false),
      buildDomainOptions({ ...PLAIN, compression: true, protect: true, username: " guest ", password: PASSWORD }, false),
      buildDomainOptions({ ...PLAIN, protect: true, username: "guest" }, true),
      buildDomainOptions({ ...PLAIN, paths: [{ ...API_PATH, pathPrefix: " /api " }, { pathPrefix: "/docs/v2", target: "web:8080", stripPrefix: false }] }, false),
      buildDomainOptions({ ...PLAIN, redirectTo: "sdom_2", compression: true, protect: true, username: "-bad", password: "x", paths: [{ ...API_PATH, pathPrefix: "api" }] }, false),
    ];
    const bodies = built.map((b) => (b.ok ? b.body : null));
    expect(bodies).toEqual([
      { redirectToDomainId: null, compression: false, protection: null, pathRoutes: [] },
      { redirectToDomainId: null, compression: true, protection: { username: "guest", password: PASSWORD }, pathRoutes: [] },
      // an empty password field keeps the one already stored: the key is left out, not sent empty
      { redirectToDomainId: null, compression: false, protection: { username: "guest" }, pathRoutes: [] },
      {
        redirectToDomainId: null,
        compression: false,
        protection: null,
        pathRoutes: [
          { pathPrefix: "/api", componentKey: "admin", port: 9000, stripPrefix: true },
          { pathPrefix: "/docs/v2", componentKey: "web", port: 8080, stripPrefix: false },
        ],
      },
      // a redirecting address sends no password and no path, whatever its hidden fields hold; compression is kept
      { redirectToDomainId: "sdom_2", compression: true, protection: null, pathRoutes: [] },
    ]);
    for (const body of bodies) expect(UpdateAppStackDomainInputSchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
    expect(Object.keys(bodies[2]!.protection!)).toEqual(["username"]);
  });

  it("names the field to correct instead of sending a body the API would refuse without saying which", () => {
    const problems = (form: Partial<Parameters<typeof buildDomainOptions>[0]>, hasPassword = false) => {
      const built = buildDomainOptions({ ...PLAIN, ...form }, hasPassword);
      return built.ok ? null : built.problems;
    };
    expect(problems({ protect: true, username: "guest" })).toEqual({ password: "passwordRequired" });
    expect(problems({ protect: true, username: "guest", password: "short" })).toEqual({ password: "password" });
    expect(problems({ protect: true, username: "guest", password: "pässword-with-accent" })).toEqual({ password: "password" });
    expect(problems({ protect: true, username: "guest", password: "x".repeat(129) })).toEqual({ password: "password" });
    expect(problems({ protect: true, username: "-guest", password: PASSWORD })).toEqual({ username: "username" });
    expect(problems({ protect: true, username: "a".repeat(33), password: PASSWORD })).toEqual({ username: "username" });
    expect(problems({ protect: true }, true)).toEqual({ username: "username" });
    for (const pathPrefix of ["", "api", "/", "/.well-known", "/api/", "/a b", `/${"a".repeat(33)}`, "/a/b/c/d/e", `/${"a".repeat(32)}/${"b".repeat(32)}`])
      expect(problems({ paths: [{ ...API_PATH, pathPrefix }] }), pathPrefix).toEqual({ "path:0": "path" });
    expect(problems({ paths: [API_PATH, { pathPrefix: "/api", target: "web:8080", stripPrefix: false }] })).toEqual({ "path:1": "pathTwice" });
    expect(problems({ protect: true, username: "?", paths: [{ ...API_PATH, pathPrefix: "x" }] })).toEqual({
      username: "username",
      password: "passwordRequired",
      "path:0": "path",
    });
    // protection not asked for: what its fields hold is not judged
    expect(problems({ protect: false, username: "-bad", password: "x" })).toBeNull();
    // what the form refuses is what the API's schema refuses
    for (const pathPrefix of ["api", "/", "/.well-known", "/api/", `/${"a".repeat(32)}/${"b".repeat(32)}`]) {
      const body = { redirectToDomainId: null, compression: false, protection: null, pathRoutes: [{ pathPrefix, componentKey: "web", port: 8080, stripPrefix: false }] };
      expect(UpdateAppStackDomainInputSchema.safeParse(body).success, pathPrefix).toBe(false);
    }
  });

  it("each row has its Options button, named after its address, and says in words what is set", () => {
    const rows = [
      { ...DOMAIN, protection: { username: "guest" }, pathRoutes: [{ pathPrefix: "/api", componentKey: "admin", port: 9000, stripPrefix: true }] },
      { ...SECOND, redirectToDomainId: "sdom_1" },
    ];
    const { out, sets } = callHooks(AppStackDomains, props({ initial: rows }));
    const h = html(out);
    for (const text of [o.summary.protected, format(o.summary.paths, { n: 1 }), format(o.summary.redirect, { hostname: "notes.example.test" })]) expect(h).toContain(text);
    for (const d of rows) expect(h).toContain(`aria-label="${format(o.title, { hostname: d.hostname })}"`);
    const plain = html(callHooks(AppStackDomains, props()).out);
    for (const text of [o.summary.protected, format(o.summary.paths, { n: 0 }), format(o.summary.redirect, { hostname: "" }).trim()]) expect(plain).not.toContain(text);

    const open = buttons(out, o.open);
    expect(open).toHaveLength(2);
    expect(dialogOf(out)).toBeUndefined();
    (open[1]!.props.onClick as () => void)();
    expect(sets).toEqual([
      [4, null],
      [7, null],
      [6, "sdom_2"],
    ]);
  });

  it("while the saved options are not published yet, every address that shows one says they are not active yet", () => {
    const rows = [
      { ...DOMAIN, protection: { username: "guest" } },
      { ...SECOND, redirectToDomainId: "sdom_1" },
      { ...DOMAIN, id: "sdom_3", hostname: "paths.example.test", pathRoutes: [{ pathPrefix: "/api", componentKey: "admin", port: 9000, stripPrefix: true }] },
      { ...DOMAIN, id: "sdom_4", hostname: "plain.example.test", compression: true },
    ];
    const pending = html(callHooks(AppStackDomains, props({ initial: rows, pending: true })).out);
    expect(pending.split(o.summary.pending)).toHaveLength(4);
    expect(html(callHooks(AppStackDomains, props({ initial: rows })).out)).not.toContain(o.summary.pending);
    expect(itMsgs.apps.domains.options.summary.pending).not.toBe(o.summary.pending);
  });

  it("the dialog is for the chosen address; a refusal is shown once, inside it", () => {
    const { out } = callHooks(AppStackDomains, props(), en, { 3: true, 4: "refused in words", 6: "sdom_2" });
    const dialog = dialogOf(out)!;
    expect(dialog.key).toBe("sdom_2");
    expect(dialog.props).toMatchObject({ domain: SECOND, rows: [DOMAIN, SECOND], ingress: INGRESS, busy: true, error: "refused in words" });
    const h = html(out);
    expect(h).toContain(`<h2>${format(o.title, { hostname: "notes2.example.test" })}</h2>`);
    expect(alerts(h)).toHaveLength(1);
    expect(h.indexOf("refused in words")).toBeGreaterThan(h.indexOf("<h2>"));
    // an address that left the list has no dialog, and the refusal is back on the page
    const gone = html(callHooks(AppStackDomains, props(), en, { 4: "refused in words", 6: "sdom_9" }).out);
    expect(gone).not.toContain("<h2>");
    expect(alerts(gone)).toHaveLength(1);
    (dialog.props.onClose as () => void)();
  });

  it("offers as path targets only those the application takes now, not every entry point of the version asked for", () => {
    const withPath = { ...DOMAIN, pathRoutes: [{ pathPrefix: "/w", componentKey: "web", port: 8080, stripPrefix: false }] };
    const { out } = callHooks(AppStackDomains, props({ initial: [withPath, SECOND], pathTargets: INGRESS.slice(0, 1) }), en, { 6: "sdom_1" });
    expect(dialogOf(out)!.props.ingress).toEqual(INGRESS.slice(0, 1));
    const h = html(out);
    expect(h).toMatch(/<option[^>]*value="web:8080"/);
    expect(h).not.toMatch(/<option[^>]*value="admin:9000"/);
    // the new address form still offers every entry point of the version asked for
    expect(byId(out, "app-domain-target")).toBeDefined();
  });

  it("offers as destinations only the other addresses that show the application; a destination cannot redirect in turn", () => {
    const rows = [DOMAIN, SECOND, THIRD];
    const h = html(callHooks(AppStackDomainOptions, dialogProps({ rows })).out);
    const select = h.match(/<select[^>]*id="app-domain-redirect"[\s\S]*?<\/select>/)![0];
    expect([...select.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((x) => x[1])).toEqual([o.redirectNone, "notes2.example.test"]);
    expect(h).toContain(o.redirectHint);

    const destination = html(callHooks(AppStackDomainOptions, dialogProps({ domain: SECOND, rows })).out);
    expect(destination).not.toContain("app-domain-redirect");
    expect(destination).toContain(o.redirectIsTarget);
    const alone = html(callHooks(AppStackDomainOptions, dialogProps({ rows: [DOMAIN] })).out);
    expect(alone).not.toContain("app-domain-redirect");
    expect(alone).toContain(o.redirectNoTarget);    // An address being removed is no destination (issue #112).
    const going = { ...SECOND, removing: true };
    const leaving = html(callHooks(AppStackDomainOptions, dialogProps({ rows: [DOMAIN, going] })).out);
    expect(leaving).not.toContain("app-domain-redirect");
    expect(leaving).toContain(o.redirectNoTarget);
  });

  it("while the address redirects, password, compression and paths are not offered", () => {
    const stored = { ...THIRD, compression: true };
    const h = html(callHooks(AppStackDomainOptions, dialogProps({ domain: stored, rows: [DOMAIN, SECOND, stored] })).out);
    expect(h).toContain(o.redirectOn);
    expect(h).toMatch(/<option[^>]*value="sdom_2"[^>]*selected=""/);
    for (const id of ["app-domain-protect", "app-domain-username", "app-domain-password", "app-domain-compression", "app-domain-path-0"]) expect(h).not.toContain(`id="${id}"`);
    expect(h).not.toContain(o.pathsAdvanced);
    const off = html(callHooks(AppStackDomainOptions, dialogProps({ domain: stored, rows: [DOMAIN, SECOND, stored] }), en, { 0: "" }).out);
    for (const id of ["app-domain-protect", "app-domain-compression"]) expect(off).toContain(`id="${id}"`);
    expect(tag(off, "app-domain-compression")).toContain('checked=""');
  });

  it("the password field is write-only: no value in the markup, and nothing but the user name of a stored protection", () => {
    const stored = { ...DOMAIN, protection: { username: "guest", passwordHash: "$apr1$planted" } } as unknown as AppStackDomainDto;
    const h = html(callHooks(AppStackDomainOptions, dialogProps({ domain: stored })).out);
    const input = tag(h, "app-domain-password");
    for (const a of [/type="password"/, /autocomplete="new-password"/i, /spellcheck="false"/i, /aria-describedby="app-domain-password-note"/]) expect(input).toMatch(a);
    expect(input).not.toMatch(/\svalue=/);
    expect(tag(h, "app-domain-username")).toContain('value="guest"');
    expect(h).toContain(o.passwordKeep);
    expect(h).not.toContain(o.passwordNew);
    expect(h).not.toContain("apr1");
    // a certificate in use: the note about an unprotected connection is not shown
    expect(h).not.toContain(o.insecure);

    const fresh = html(callHooks(AppStackDomainOptions, dialogProps({ domain: SECOND }), en, { 2: true }).out);
    expect(fresh).toContain(o.passwordNew);
    expect(fresh).toContain(o.insecure);
    expect(html(callHooks(AppStackDomainOptions, dialogProps({ domain: SECOND })).out)).not.toContain("app-domain-password");
  });

  it("paths stay under their advanced section: each has its own labelled fields, up to four", () => {
    const stored = { ...DOMAIN, pathRoutes: [{ pathPrefix: "/api", componentKey: "admin", port: 9000, stripPrefix: true }] };
    const { out, sets } = callHooks(AppStackDomainOptions, dialogProps({ domain: stored }));
    const h = html(out);
    expect(h).toMatch(/<details[^>]*open=""/);
    expect(tag(h, "app-domain-path-0")).toContain('value="/api"');
    expect(tag(h, "app-domain-path-0-strip")).toContain('checked=""');
    expect(h).toMatch(/<option[^>]*value="admin:9000"[^>]*selected=""/);
    for (const text of [format(o.path, { n: 1 }), format(o.pathTarget, { n: 1 }), format(o.pathStrip, { n: 1 }), o.pathsHint]) expect(h).toContain(text);
    expect(h).toContain(`aria-label="${format(o.pathRemove, { n: 1 })}"`);

    (buttons(out, o.pathAdd)[0]!.props.onClick as () => void)();
    expect(sets).toContainEqual([4, [API_PATH, { pathPrefix: "", target: "web:8080", stripPrefix: false }]]);
    (els(out).find((e) => e.props["aria-label"] === format(o.pathRemove, { n: 1 }))!.props.onClick as () => void)();
    expect(sets).toContainEqual([4, []]);

    const closed = html(callHooks(AppStackDomainOptions, dialogProps()).out);
    expect(closed).toContain(o.pathsAdvanced);
    expect(closed).not.toMatch(/<details[^>]*open/);
    const four = Array.from({ length: 4 }, (_, i) => ({ ...API_PATH, pathPrefix: `/p${i}` }));
    expect(html(callHooks(AppStackDomainOptions, dialogProps(), en, { 4: four }).out)).not.toContain(o.pathAdd);
    // a target the application no longer offers stays visible, as itself
    const gone = html(callHooks(AppStackDomainOptions, dialogProps(), en, { 4: [{ ...API_PATH, target: "old:7000" }] }).out);
    expect(gone).toMatch(new RegExp(`<option[^>]*value="old:7000"[^>]*>${o.pathTargetGone}</option>`));
    // an application with nothing to show on the web has no paths to offer
    expect(html(callHooks(AppStackDomainOptions, dialogProps({ ingress: [] })).out)).not.toContain(o.pathsAdvanced);
  });

  it("save hands over the options built from the form and empties the password field", async () => {
    const onSave = vi.fn();
    const { out, sets } = callHooks(AppStackDomainOptions, dialogProps({ onSave }), en, { 1: true, 2: true, 3: "guest", 4: [API_PATH] });
    const ref = byId(out, "app-domain-password")!.props.ref as { current: { value: string } | null };
    ref.current = { value: PASSWORD };
    await submit(out);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      redirectToDomainId: null,
      compression: true,
      protection: { username: "guest", password: PASSWORD },
      pathRoutes: [{ pathPrefix: "/api", componentKey: "admin", port: 9000, stripPrefix: true }],
    });
    expect(ref.current.value).toBe("");
    expect(sets).toEqual([[5, {}]]);
    // while a save is running, a second one is not sent
    const busy = callHooks(AppStackDomainOptions, dialogProps({ onSave, busy: true }));
    await submit(busy.out);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("a form with something to correct sends nothing and says where, each message tied to its field", async () => {
    const onSave = vi.fn();
    const { out, sets } = callHooks(AppStackDomainOptions, dialogProps({ onSave }), en, { 2: true, 3: "guest" });
    await submit(out);
    expect(onSave).not.toHaveBeenCalled();
    expect(sets).toEqual([[5, { password: "passwordRequired" }]]);

    const wrong = { username: "username", password: "passwordRequired", "path:0": "pathTwice" };
    const h = html(callHooks(AppStackDomainOptions, dialogProps(), en, { 2: true, 3: "-x", 4: [API_PATH], 5: wrong }).out);
    expect(alerts(h)).toHaveLength(3);
    for (const text of [o.problems.username, o.problems.passwordRequired, o.problems.pathTwice]) expect(h).toContain(text);
    for (const [id, describedBy] of [
      ["app-domain-username", "app-domain-username-problem"],
      ["app-domain-password", "app-domain-password-note app-domain-password-problem"],
      ["app-domain-path-0", "app-domain-paths-note app-domain-path-0-problem"],
    ] as const) {
      expect(tag(h, id), id).toContain('aria-invalid="true"');
      expect(tag(h, id), id).toContain(`aria-describedby="${describedBy}"`);
    }
    for (const id of ["app-domain-username-problem", "app-domain-password-problem", "app-domain-path-0-problem"]) expect(h).toContain(`id="${id}"`);
  });

  it("saving is one PATCH for that address: the answered list replaces the rows, the dialog closes and the page says so", async () => {
    const body = { redirectToDomainId: null, compression: true, protection: { username: "guest", password: PASSWORD }, pathRoutes: [] };
    const answered = [{ ...DOMAIN, compression: true, protection: { username: "guest" } }, SECOND];
    const { out, sets } = callHooks(AppStackDomains, props(), en, { 6: "sdom_1" });
    keyedSend.mockResolvedValue({ ok: true, data: { data: answered } });
    await save(out, body);
    expect(keyedSend).toHaveBeenCalledTimes(1);
    expect(keyedSend).toHaveBeenCalledWith(expect.any(Object), "csrf", "options:sdom_1", "PATCH", `${BASE}/domains/sdom_1`, body);
    for (const set of [
      [0, answered],
      [6, null],
      [7, o.saved],
    ])
      expect(sets).toContainEqual(set);
    expect(router.refresh).toHaveBeenCalledOnce();
    const h = html(callHooks(AppStackDomains, props(), en, { 7: o.saved }).out);
    expect(h).toMatch(new RegExp(`<p role="status"[^>]*>${o.saved}</p>`));
    expect(alerts(h)).toHaveLength(0);
  });

  it("the page says when the saved options take effect, as the answer says: in a few moments, or when the application starts", async () => {
    const body = { redirectToDomainId: null, compression: true, protection: null, pathRoutes: [] };
    for (const [applies, text] of [
      ["shortly", o.saved],
      ["at_start", o.savedAtStart],
    ] as const) {
      const { out, sets } = callHooks(AppStackDomains, props(), en, { 6: "sdom_1" });
      keyedSend.mockResolvedValue({ ok: true, data: { data: [DOMAIN, SECOND], applies } });
      await save(out, body);
      expect(sets.filter(([slot]) => slot === 7), applies).toEqual([[7, null], [7, text]]);
    }
    expect(o.savedAtStart).not.toBe(o.saved);
    expect(itMsgs.apps.domains.options.savedAtStart).not.toBe(itMsgs.apps.domains.options.saved);
  });

  it("an application whose web address cannot be rewritten now refuses the change, and the dialog says why", async () => {
    const body = { redirectToDomainId: null, compression: true, protection: null, pathRoutes: [] };
    const { out, sets } = callHooks(AppStackDomains, props(), en, { 6: "sdom_1" });
    keyedSend.mockResolvedValue({ ok: false, code: "RESOURCE_LOCKED", reason: "failed" });
    await save(out, body);
    expect(sets).toContainEqual([4, format(en.apps.reasons.status, { status: en.apps.status.failed })]);
    expect(sets.filter(([slot]) => slot === 6 || slot === 7)).toEqual([[7, null]]);
  });

  it("a refusal keeps the dialog open and reads in words; while a request runs no second one is sent", async () => {
    const body = { redirectToDomainId: "sdom_2", compression: false, protection: null, pathRoutes: [] };
    for (const reason of ["redirect_target", "redirect_chain", "password_required", "unknown_ingress"] as const) {
      const { out, sets } = callHooks(AppStackDomains, props(), en, { 6: "sdom_1" });
      keyedSend.mockResolvedValue({ ok: false, code: "VALIDATION_ERROR", reason });
      await save(out, body);
      expect(sets, reason).toContainEqual([4, en.apps.reasons[reason]]);
      expect(sets.filter(([slot]) => slot === 6 || slot === 7), reason).toEqual([[7, null]]);
    }
    // each reason has its own sentence, not the generic one of its code
    for (const reason of ["redirect_target", "redirect_chain", "password_required"] as const) expect(en.apps.reasons[reason]).not.toBe(en.errors.VALIDATION_ERROR);
    expect(router.refresh).not.toHaveBeenCalled();

    keyedSend.mockClear();
    await save(callHooks(AppStackDomains, props(), en, { 3: true, 6: "sdom_1" }).out, body);
    expect(keyedSend).not.toHaveBeenCalled();
  });

  it("Italian has its own words for every option, none of them the proxy's", () => {
    const words = JSON.stringify([itMsgs.apps.domains.options, en.apps.domains.options, itMsgs.apps.reasons, en.apps.reasons]);
    for (const jargon of [/middleware/i, /router/i, /traefik/i, /proxy/i, /basic ?auth/i, /gzip/i, /htpasswd/i, /apr1/i]) expect(words).not.toMatch(jargon);
    const h = html(callHooks(AppStackDomainOptions, dialogProps({ domain: { ...DOMAIN, protection: { username: "guest" } } }), itMsgs).out, itMsgs);
    for (const text of ["Reindirizza a", "Proteggi con password", "Comprimi le risposte", "Percorsi"]) expect(h).toContain(text);
  });
});
