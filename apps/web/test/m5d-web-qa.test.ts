// M5d QA (qa-web): black-box checks of the Firewall and Updates pages, ConfirmAction, the host services and their eleven BFF routes.
import fs from "node:fs";
import path from "node:path";
import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminHealthDtoSchema,
  ComponentApplyAcceptedDtoSchema,
  FIREWALL_BLOCK_REFUSALS,
  FIREWALL_PORT_NAMES,
  FIREWALL_SAFE_PORTS,
  FIREWALL_STATIC_RULES,
  FirewallDtoSchema,
  HOST_JOB_RESULTS,
  HOST_JOURNAL_SOURCES,
  HOST_SERVICES,
  HostJobAcceptedDtoSchema,
  HostServiceRestartAcceptedDtoSchema,
  OsPackagesDtoSchema,
  PANEL_CHECK_STATES,
  PANEL_COMPONENTS,
  PANEL_CONTAINERS,
  SiteImageUpdateAcceptedDtoSchema,
  UpdatesDtoSchema,
  type AdminHealthDto,
  type FirewallDto,
  type OsPackagesDto,
  type UpdatesDto,
} from "@hosting-panel/contracts";
import { format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getSessionFromRequest = vi.fn();
const getServerSession = vi.fn();
const router = vi.hoisted(() => ({ push: () => {}, refresh: (() => {}) as () => void }));
const lang = vi.hoisted(() => ({ locale: "en" as "en" | "it" }));

vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...a: unknown[]) => fetchUpstream(...a),
}));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: (...a: unknown[]) => getSessionFromRequest(...a),
  getServerSession: (...a: unknown[]) => getServerSession(...a),
}));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => lang.locale }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  useRouter: () => router,
  usePathname: () => "/admin/firewall",
}));

import AdminFirewallPage from "@/app/admin/firewall/page";
import AdminUpdatesPage from "@/app/admin/updates/page";
import AdminHealthPage from "@/app/admin/health/page";
import AdminLayout from "@/app/admin/layout";
import * as openMod from "@/app/api/admin/firewall/ports/[name]/open/route";
import * as closeMod from "@/app/api/admin/firewall/ports/[name]/close/route";
import * as blocksMod from "@/app/api/admin/firewall/blocks/route";
import * as unblockMod from "@/app/api/admin/firewall/blocks/[blockId]/route";
import * as serviceMod from "@/app/api/admin/host-services/[service]/restart/route";
import * as checkMod from "@/app/api/admin/updates/panel/check/route";
import * as panelMod from "@/app/api/admin/updates/panel/apply/route";
import * as componentMod from "@/app/api/admin/updates/components/[component]/apply/route";
import * as imageMod from "@/app/api/admin/sites/[siteId]/image-update/route";
import * as refreshMod from "@/app/api/admin/os-packages/refresh/route";
import * as upgradeMod from "@/app/api/admin/os-packages/upgrade/route";
import * as logsMod from "@/app/api/admin/logs/[component]/route";
import { ConfirmAction } from "@/components/admin/confirm-action";
import { FirewallBlocks } from "@/components/admin/firewall-blocks";
import { FirewallPorts, FirewallStateBadge } from "@/components/admin/firewall-ports";
import { SiteLogs } from "@/components/customer/site-logs";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { firewallErrorText } from "@/lib/admin-firewall";
import { followRestart, RESTART_POLL_MS } from "@/lib/admin-restart";
import { JOB_FOLLOW_MS, updatesErrorText } from "@/lib/admin-updates";

const ROOT = path.join(__dirname, "../../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const T = "2026-11-17T06:00:00.000Z";
const BLOCK = `fwb_${"0123456789abcdef".repeat(2)}`;
const SENTINEL = "SENTINEL-qa-5d";
const XSS = `<img src=x onerror=alert(1)>"><script>alert(1)</script>&amp;`;
const XSS_TEXT = "&lt;img src=x onerror=alert(1)&gt;\"&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;amp;";
const LANGS: Array<[string, Messages]> = [["en", en], ["it", itMsgs]];

const html = (m: Messages, child: ReactNode) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: child }))
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"');

// Calls a client component once with a stand-in hook dispatcher, so its handlers can be run without a DOM.
const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
function callHooks<P>(C: (p: P) => ReactNode, props: P, m: Messages = en, state: Record<number, unknown> = {}, refs: Record<number, unknown> = {}) {
  let s = 0;
  let r = 0;
  const sets: Array<[number, unknown]> = [];
  const effects: Array<() => void> = [];
  const ctx = { locale: m === en ? "en" : "it", messages: m };
  const prev = internals.H;
  internals.H = {
    useState: (v: unknown) => {
      const k = s++;
      return [k in state ? state[k] : typeof v === "function" ? (v as () => unknown)() : v, (x: unknown) => void sets.push([k, x])];
    },
    useRef: (v: unknown) => {
      const k = r++;
      return k in refs ? refs[k] : { current: v };
    },
    useCallback: (f: unknown) => f,
    useMemo: (f: () => unknown) => f(),
    useEffect: (f: () => void) => void effects.push(f),
    useLayoutEffect: () => {},
    useContext: () => ctx,
    use: () => ctx,
    useId: () => "qa-id",
  };
  try {
    return { tree: C(props), sets, effects };
  } finally {
    internals.H = prev;
  }
}
type El = ReactElement<Record<string, unknown>>;
const els = (node: unknown): El[] => {
  if (Array.isArray(node)) return node.flatMap(els);
  if (!isValidElement(node)) return [];
  return [node as El, ...els((node.props as Record<string, unknown>).children)];
};
const textOf = (node: unknown): string =>
  typeof node === "string" || typeof node === "number" ? String(node)
    : Array.isArray(node) ? node.map(textOf).join("")
    : isValidElement(node) ? textOf((node.props as Record<string, unknown>).children) : "";
const leaves = (o: unknown): string[] => (typeof o === "string" ? [o] : o && typeof o === "object" ? Object.values(o).flatMap(leaves) : []);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** True when the text is one catalog sentence, its placeholders filled. */
const isCatalogSentence = (m: Messages, s: string) =>
  leaves(m).some((l) => new RegExp(`^${escapeRe(l).replace(/\\\{\w+\\\}/g, ".+")}$`, "s").test(s));

const fetchMock = vi.fn();
const answer = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const err = (code: string, details: unknown[] = []) => ({ error: { code, message: SENTINEL, requestId: "r", retryable: false, details } });

beforeEach(() => {
  fetchUpstream.mockReset().mockResolvedValue({ ok: true, status: 200, data: { data: {} } });
  getSessionFromRequest.mockReset().mockResolvedValue({ accessToken: "tok-sentinel", csrfToken: "csrf" });
  getServerSession.mockReset().mockResolvedValue({ accessToken: "tok-sentinel", csrfToken: "csrf", user: { id: "u1", isServerAdmin: true, mustChangePassword: false } });
  fetchMock.mockReset();
  router.refresh = vi.fn();
  lang.locale = "en";
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- fixtures
const fw = (over: Partial<FirewallDto> = {}): FirewallDto => ({
  baseRules: "current",
  readAt: T,
  hostId: "host_a1",
  staticRules: FIREWALL_STATIC_RULES.map((r) => ({ key: r.key, ports: [...r.ports] })),
  ports: FIREWALL_PORT_NAMES.map((name) => ({ name, port: FIREWALL_SAFE_PORTS[name], open: name === "nrpe" || name === "http_alt", inForce: true })),
  blocks: [
    { id: BLOCK, address: "203.0.113.0/24", family: "ipv4", note: XSS, createdAt: T, inForce: true },
    { id: `fwb_${"f".repeat(32)}`, address: "198.51.100.7", family: "ipv4", note: null, createdAt: T, inForce: true },
    { id: `fwb_${"a".repeat(32)}`, address: "2001:db8::/32", family: "ipv6", note: null, createdAt: T, inForce: true },
  ],
  ...over,
}) as FirewallDto;
const updates = (over: Partial<UpdatesDto["panel"]> = {}, rest: Partial<UpdatesDto> = {}): UpdatesDto => ({
  panel: { installedVersion: "1.4.0", check: { state: "newer", latestVersion: "1.5.0", checkedAt: T }, running: null, last: null, ...over },
  components: PANEL_CONTAINERS.map((component) => ({ component, expected: true, imageCurrent: component === "sftp" || component === "ingress_proxy" ? false : true, runningOperationId: null })),
  sites: [
    { siteId: "s1", siteName: "wp-a.example.test", organizationName: "Example Org", phpVersion: "8.3", stopped: false },
    { siteId: "s2", siteName: "wp-b.example.test", organizationName: null, phpVersion: "8.4", stopped: false },
  ],
  sitesTotal: 2,
  ...rest,
}) as UpdatesDto;
const pkgs = (over: Partial<OsPackagesDto> = {}): OsPackagesDto => ({
  packages: [
    { name: "libexample1", installedVersion: "1.0-1", newVersion: "1.0-2", origin: "security" },
    { name: "toolexample", installedVersion: "2.0", newVersion: "2.1", origin: "distribution" },
  ],
  rebootRequired: false,
  canUpgrade: true,
  listsReadAt: T,
  running: null,
  ...over,
}) as OsPackagesDto;
const healthDto = (hostServices: AdminHealthDto["hostServices"]): AdminHealthDto => ({
  generatedAt: T,
  components: PANEL_COMPONENTS.map((component) => ({ component, state: "ok", reason: null, observedAt: T })),
  siteContainers: [],
  disks: [],
  hostServices,
}) as AdminHealthDto;
/** The server reads of the pages, by upstream path. */
const serve = (byPath: Record<string, unknown>) =>
  fetchUpstream.mockImplementation(async (p: string) =>
    p in byPath && byPath[p] !== null
      ? { ok: true, status: 200, data: { data: byPath[p] } }
      : p in byPath ? { ok: false, status: 503, error: err("HOST_AGENT_UNAVAILABLE") } : { ok: true, status: 200, data: { data: [] } });
async function firewallPage(d: FirewallDto | null, m: Messages = en) {
  lang.locale = m === en ? "en" : "it";
  serve({ "v1/admin/firewall": d });
  return (await AdminFirewallPage()) as ReactNode;
}
async function updatesPage(u: UpdatesDto | null, p: OsPackagesDto | null, m: Messages = en) {
  lang.locale = m === en ? "en" : "it";
  serve({ "v1/admin/updates": u, "v1/admin/os-packages": p });
  return (await AdminUpdatesPage()) as ReactNode;
}

// ---------------------------------------------------------------- the eleven routes and the journal route
type Route = { name: string; mod: Record<string, unknown>; method: "POST" | "DELETE" | "GET"; param?: string; good?: string; upstream: string; file: string };
const ROUTES: Route[] = [
  { name: "port open", mod: openMod, method: "POST", param: "name", good: "http_alt", upstream: "v1/admin/firewall/ports/http_alt/open", file: "firewall/ports/[name]/open" },
  { name: "port close", mod: closeMod, method: "POST", param: "name", good: "nrpe", upstream: "v1/admin/firewall/ports/nrpe/close", file: "firewall/ports/[name]/close" },
  { name: "block", mod: blocksMod, method: "POST", upstream: "v1/admin/firewall/blocks", file: "firewall/blocks" },
  { name: "unblock", mod: unblockMod, method: "DELETE", param: "blockId", good: BLOCK, upstream: `v1/admin/firewall/blocks/${BLOCK}`, file: "firewall/blocks/[blockId]" },
  { name: "service restart", mod: serviceMod, method: "POST", param: "service", good: "executor", upstream: "v1/admin/host-services/executor/restart", file: "host-services/[service]/restart" },
  { name: "panel check", mod: checkMod, method: "POST", upstream: "v1/admin/updates/panel/check", file: "updates/panel/check" },
  { name: "panel apply", mod: panelMod, method: "POST", upstream: "v1/admin/updates/panel/apply", file: "updates/panel/apply" },
  { name: "component apply", mod: componentMod, method: "POST", param: "component", good: "sftp", upstream: "v1/admin/updates/components/sftp/apply", file: "updates/components/[component]/apply" },
  { name: "site image update", mod: imageMod, method: "POST", param: "siteId", good: "site_a1", upstream: "v1/admin/sites/site_a1/image-update", file: "sites/[siteId]/image-update" },
  { name: "packages refresh", mod: refreshMod, method: "POST", upstream: "v1/admin/os-packages/refresh", file: "os-packages/refresh" },
  { name: "packages upgrade", mod: upgradeMod, method: "POST", upstream: "v1/admin/os-packages/upgrade", file: "os-packages/upgrade" },
];
const LOGS: Route = { name: "journal", mod: logsMod, method: "GET", param: "component", good: "hp-panel-update", upstream: "v1/admin/logs/hp-panel-update?tail=50", file: "logs/[component]" };
async function call(r: Route, o: { value?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const headers: Record<string, string> = { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Content-Type": "application/json", "Idempotency-Key": "key-1", ...o.headers };
  for (const [k, v] of Object.entries(headers)) if (v === "") delete headers[k];
  const req = new Request("http://localhost:3000/api/x?tail=50", { method: r.method, headers, body: r.method === "GET" ? undefined : JSON.stringify(o.body ?? { reason: "r" }) });
  const handler = r.mod[r.method] as (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
  return handler(req, { params: Promise.resolve(r.param ? { [r.param]: o.value ?? r.good! } : {}) });
}

describe("1. the screen and the routes fit together", () => {
  const WEB = "apps/web/src";
  // [method, address as written in the source, source file]; ${...} parts are the route folder's parameter.
  const CLIENT: Array<[string, string, string]> = [
    ["POST", "`/api/admin/firewall/ports/${name}/${action}`", "components/admin/firewall-ports.tsx"],
    ["POST", '"/api/admin/firewall/blocks"', "components/admin/firewall-blocks.tsx"],
    ["DELETE", "`/api/admin/firewall/blocks/${b.id}`", "components/admin/firewall-blocks.tsx"],
    ["POST", "`/api/bff/hosts/${fw.hostId}/security`", "app/admin/firewall/page.tsx"],
    ["POST", '"/api/admin/updates/panel/check"', "app/admin/updates/page.tsx"],
    ["POST", '"/api/admin/updates/panel/apply"', "app/admin/updates/page.tsx"],
    ["POST", "`/api/admin/updates/components/${c.component}/apply`", "app/admin/updates/page.tsx"],
    ["POST", "`/api/admin/sites/${s.siteId}/image-update`", "app/admin/updates/page.tsx"],
    ["POST", '"/api/admin/os-packages/refresh"', "app/admin/updates/page.tsx"],
    ["POST", '"/api/admin/os-packages/upgrade"', "app/admin/updates/page.tsx"],
    ["GET", '"/api/admin/logs/hp-panel-update?tail=50"', "app/admin/updates/page.tsx"],
    ["POST", "`/api/admin/host-services/${target.service}/restart`", "lib/admin-restart.ts"],
  ];
  const routeFile = (addr: string) => {
    const a = addr.slice(1, -1).split("?")[0]!;
    const folder = a
      .replace("${name}/${action}", "[name]/open")
      .replace("${b.id}", "[blockId]").replace("${fw.hostId}", "[hostId]").replace("${c.component}", "[component]")
      .replace("${s.siteId}", "[siteId]").replace("${target.service}", "[service]").replace("hp-panel-update", "[component]");
    return `${WEB}/app${folder}/route.ts`;
  };

  it("every address the M5d screens request has a route file that exports that method and no other", () => {
    for (const [method, addr, file] of CLIENT) {
      expect(read(`${WEB}/${file}`), `${addr} in ${file}`).toContain(addr);
      const files = addr.includes("${action}") ? [routeFile(addr), routeFile(addr).replace("/open/", "/close/")] : [routeFile(addr)];
      for (const f of files) {
        const exported = [...read(f).matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\(/g)].map((x) => x[1]);
        expect(exported, f).toEqual([method]);
      }
    }
    // The DELETE and POST of the blocks are the two methods of two different files.
    expect(read(`${WEB}/components/admin/firewall-blocks.tsx`)).toMatch(/url=\{`\/api\/admin\/firewall\/blocks\/\$\{b\.id\}`\} method="DELETE"/);
    // No other admin or BFF address is written in the M5d sources.
    const sources = ["components/admin/firewall-ports.tsx", "components/admin/firewall-blocks.tsx", "components/admin/confirm-action.tsx", "app/admin/firewall/page.tsx", "app/admin/updates/page.tsx", "lib/admin-firewall.ts", "lib/admin-updates.ts"];
    const found = sources.flatMap((f) => read(`${WEB}/${f}`).match(/[`"]\/api\/[^`"]*[`"]/g) ?? []);
    expect(new Set(found)).toEqual(new Set(CLIENT.filter(([, , f]) => sources.includes(f)).map(([, a]) => a)));
  });

  /** Every (method, path, status) a controller declares, from its source text. */
  const HTTP: Record<string, number> = { OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204 };
  const controller = (f: string) => {
    const code = read(`apps/api/src/controllers/${f}`);
    const prefix = code.match(/@Controller\("([^"]*)"\)/)![1]!;
    return [...code.matchAll(/@(Get|Post|Delete)\("([^"]*)"\)\s*(?:@HttpCode\((?:HttpStatus\.(\w+)|(\d+))\))?/g)].map((x) => ({
      key: `${x[1]!.toUpperCase()} ${[prefix, x[2]].filter(Boolean).join("/").replace(/:(\w+)/g, "{$1}")}`,
      status: x[3] ? HTTP[x[3]]! : x[4] ? Number(x[4]) : x[1] === "Post" ? 201 : 200,
    }));
  };
  const SERVED = [...controller("admin-firewall.controller.ts"), ...controller("admin-host.controller.ts"), ...controller("admin-updates.controller.ts"), ...controller("admin-logs.controller.ts"), ...controller("hosts.controller.ts")];
  // [route file, upstream as forwarded, success status the client expects]
  const FORWARDS: Array<[string, string, number]> = [
    ["firewall/ports/[name]/open", "POST v1/admin/firewall/ports/{name}/open", 200],
    ["firewall/ports/[name]/close", "POST v1/admin/firewall/ports/{name}/close", 200],
    ["firewall/blocks", "POST v1/admin/firewall/blocks", 201],
    ["firewall/blocks/[blockId]", "DELETE v1/admin/firewall/blocks/{blockId}", 200],
    ["host-services/[service]/restart", "POST v1/admin/host-services/{service}/restart", 202],
    ["updates/panel/check", "POST v1/admin/updates/panel/check", 200],
    ["updates/panel/apply", "POST v1/admin/updates/panel/apply", 202],
    ["updates/components/[component]/apply", "POST v1/admin/updates/components/{component}/apply", 202],
    ["sites/[siteId]/image-update", "POST v1/admin/sites/{siteId}/image-update", 202],
    ["os-packages/refresh", "POST v1/admin/os-packages/refresh", 202],
    ["os-packages/upgrade", "POST v1/admin/os-packages/upgrade", 202],
  ];

  it("each of the 11 routes forwards to the path and method a controller serves, with the success status the screen treats as done", async () => {
    for (const [file, fwd] of FORWARDS) {
      const code = read(`${WEB}/app/api/admin/${file}/route.ts`);
      const m = code.match(/forwardIdempotent\(\s*req,\s*\{[^}]*\},\s*[`"]([^`"]+)[`"],\s*"([A-Z]+)"/)!;
      expect(m, file).not.toBeNull();
      expect(`${m[2]} ${m[1]!.replace(/\$\{(\w+)\}/g, "{$1}")}`, file).toBe(fwd);
    }
    for (const [file, fwd, status] of FORWARDS) {
      expect(SERVED.find((s) => s.key === fwd), `${fwd} (${file}) in a controller`).toEqual({ key: fwd, status });
      // The BFF hands the controller's success status back, and keyedSend counts any 2xx as done.
      const r = ROUTES.find((x) => x.file === file)!;
      fetchUpstream.mockResolvedValueOnce({ ok: true, status, data: { data: { operationId: "op_1" } } });
      const res = await call(r);
      expect(res.status, file).toBe(status);
      expect(await res.json(), file).toEqual({ data: { operationId: "op_1" } });
    }
    expect(SERVED.find((s) => s.key === "POST v1/hosts/{hostId}/security")).toEqual({ key: "POST v1/hosts/{hostId}/security", status: 202 });
    expect(read(`${WEB}/app/api/bff/hosts/[hostId]/security/route.ts`)).toContain("fetchUpstream(`v1/hosts/${hostId}/security`");
    expect(SERVED.find((s) => s.key === "GET v1/admin/logs/{component}")).toBeDefined();
    expect(read(`${WEB}/app/api/admin/logs/[component]/route.ts`)).toContain("`v1/admin/logs/${component}?tail=${clampTail(req)}`, \"GET\"");
  });

  /** Walks a schema to a dotted field, through nullable, optional and arrays. */
  const field = (schema: unknown, dotted: string) => {
    let s = schema as Record<string, unknown>;
    for (const k of dotted.split(".")) {
      for (;;) {
        if (typeof s.unwrap === "function") s = (s.unwrap as () => Record<string, unknown>)();
        else if (s.element) s = s.element as Record<string, unknown>;
        else break;
      }
      const shape = s.shape as Record<string, unknown> | undefined;
      if (!shape || !(k in shape)) return false;
      s = shape[k] as Record<string, unknown>;
    }
    return true;
  };

  it("the fields the pages read exist in the contract, and every accepted answer carries the operation the screen follows", () => {
    const FIREWALL = ["baseRules", "hostId", "staticRules.key", "staticRules.ports", "ports.name", "ports.port", "ports.open", "ports.inForce", "blocks.id", "blocks.address", "blocks.note", "blocks.createdAt", "blocks.inForce"];
    const UPDATES = ["panel.installedVersion", "panel.check.state", "panel.check.latestVersion", "panel.check.checkedAt", "panel.running.operationId", "panel.last.result", "panel.last.endedAt",
      "components.component", "components.expected", "components.imageCurrent", "components.runningOperationId",
      "sites.siteId", "sites.siteName", "sites.organizationName", "sites.phpVersion", "sites.stopped", "sitesTotal"];
    const PACKAGES = ["packages.name", "packages.installedVersion", "packages.newVersion", "packages.origin", "rebootRequired", "canUpgrade", "listsReadAt", "running.job", "running.operationId"];
    const HEALTH = ["hostServices.service", "hostServices.active", "hostServices.activeState", "hostServices.since", "hostServices.restarts"];
    for (const f of FIREWALL) expect(field(FirewallDtoSchema, f), f).toBe(true);
    for (const f of UPDATES) expect(field(UpdatesDtoSchema, f), f).toBe(true);
    for (const f of PACKAGES) expect(field(OsPackagesDtoSchema, f), f).toBe(true);
    for (const f of HEALTH) expect(field(AdminHealthDtoSchema, f), f).toBe(true);
    expect(field(FirewallDtoSchema, "blocks.imageName")).toBe(false);
    for (const s of [HostServiceRestartAcceptedDtoSchema, ComponentApplyAcceptedDtoSchema, SiteImageUpdateAcceptedDtoSchema, HostJobAcceptedDtoSchema]) expect(field(s, "operationId")).toBe(true);
    // ConfirmAction follows data.operationId of the answer.
    expect(read(`${WEB}/components/admin/confirm-action.tsx`)).toContain("(sent.data as { data?: { operationId?: string | null } } | null)?.data?.operationId");
  });
});

// ---------------------------------------------------------------- 2.
describe("2. nothing from the address or the browser reaches upstream unchecked", () => {
  const bad: Record<string, string[]> = {
    name: ["ssh", "http", "https", "panel", "web", "HTTP_ALT", "http_alt ", "../http_alt", "%2e%2e", "__proto__", "constructor", "toString", "8080", "22", ""],
    service: ["hp-api", "API", "Api", "api ", "../api", "%2e%2e", "database", "docker_engine", "sftp", "host-agent", "__proto__", "constructor", ""],
    component: ["api", "web", "database", "executor", "host_agent", "docker_engine", "SFTP", "sftp ", "../sftp", "%2e%2e", "__proto__", "constructor", ""],
    siteId: ["a.b", "../x", "%2e%2e", "a/b", "x".repeat(129), "", "s 1", "<script>"],
    blockId: ["../x", "%2e%2e", "a/b", "x".repeat(129), "", `fwb_${"0123456789ABCDEF".repeat(2)}`, `FWB_${"0".repeat(32)}`, `fwb_${"0".repeat(33)}`, `fwb_${"0".repeat(31)}`, `fwb_${"g".repeat(32)}`],
  };
  const PARAMS = ROUTES.filter((r) => r.param);

  it.each(PARAMS.map((r) => [r.name, r] as const))("%s: a parameter outside its closed form is 400 and nothing is forwarded", async (_n, r) => {
    for (const v of bad[r.param!]!) {
      fetchUpstream.mockClear();
      expect((await call(r, { value: v })).status, `${r.param}=${v}`).toBe(400);
      expect(fetchUpstream, `${r.param}=${v}`).not.toHaveBeenCalled();
    }
  });

  it("the journal route: a source near a real one is 400 and nothing is forwarded; the seven journals pass", async () => {
    for (const v of ["hp-api2", "hp_api", "hp-api/..", "HP-API", "hp-api ", "../hp-api", "%2e%2e", "hp-panel", "hp-os", "hp-api.service", "hp-api%00", ""]) {
      fetchUpstream.mockClear();
      expect((await call(LOGS, { value: v })).status, v).toBe(400);
      expect(fetchUpstream, v).not.toHaveBeenCalled();
    }
    for (const s of HOST_JOURNAL_SOURCES) {
      fetchUpstream.mockClear();
      await call(LOGS, { value: s });
      expect(fetchUpstream.mock.calls[0]![0]).toBe(`v1/admin/logs/${s}?tail=50`);
    }
  });

  it.each([...ROUTES, LOGS].map((r) => [r.name, r] as const))("%s: 401 without a session and nothing is forwarded", async (_n, r) => {
    getSessionFromRequest.mockResolvedValue(null);
    expect((await call(r)).status).toBe(401);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it.each(ROUTES.map((r) => [r.name, r] as const))("%s: 403 without the CSRF token, with a wrong one or from another origin", async (_n, r) => {
    for (const headers of [{ "X-CSRF-Token": "" }, { "X-CSRF-Token": "wrong" }, { Origin: "http://evil.example.test" }, { Origin: "null" }] as Array<Record<string, string>>) {
      expect((await call(r, { headers })).status, JSON.stringify(headers)).toBe(403);
    }
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it.each(ROUTES.map((r) => [r.name, r] as const))("%s: forwards once, only to its own path and method, and never a browser-sent client address", async (_n, r) => {
    await call(r, { headers: { "X-HP-Client-Address": "198.51.100.66", "x-hp-client-address": "198.51.100.66" } });
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    const [p, init] = fetchUpstream.mock.calls[0] as [string, { method: string; headers?: Record<string, string> }];
    expect(p).toBe(r.upstream);
    expect(init.method).toBe(r.method);
    expect(JSON.stringify(fetchUpstream.mock.calls[0])).not.toContain("198.51.100.66");
  });

  it("the block route sets the client address only from an x-real-ip that is one whole address, and over the browser's", async () => {
    const sent = async (headers: Record<string, string>) => {
      fetchUpstream.mockClear();
      await call(ROUTES[2]!, { headers, body: { address: "192.0.2.10", note: null } });
      return (fetchUpstream.mock.calls[0]![1] as { headers?: Record<string, string> }).headers?.["X-HP-Client-Address"];
    };
    expect(await sent({ "x-real-ip": "203.0.113.7", "X-HP-Client-Address": "198.51.100.66" })).toBe("203.0.113.7");
    expect(await sent({ "x-real-ip": "2001:db8::7" })).toBe("2001:db8::7");
    for (const v of ["203.0.113.7, 198.51.100.66", "203.0.113.7:443", "[2001:db8::7]", "203.0.113.0/24", "example.test"]) {
      expect(await sent({ "x-real-ip": v, "X-HP-Client-Address": "198.51.100.66" }), v).toBeUndefined();
    }
    for (const r of ROUTES.filter((x) => x.name !== "block")) {
      fetchUpstream.mockClear();
      await call(r, { headers: { "x-real-ip": "203.0.113.7" } });
      expect(JSON.stringify(fetchUpstream.mock.calls[0]), r.name).not.toContain("203.0.113.7");
    }
  });

  it.each(ROUTES.map((r) => [r.name, r] as const))("%s: an upstream refusal keeps its status, code and reason", async (_n, r) => {
    for (const [status, code, reason] of [[409, "RESOURCE_LOCKED", "host_job_running"], [400, "VALIDATION_ERROR", "own_address"], [422, "NOT_SUPPORTED", undefined], [503, "HOST_AGENT_UNAVAILABLE", undefined]] as const) {
      const e = err(code, reason ? [{ field: "f", reason }] : []);
      fetchUpstream.mockResolvedValueOnce({ ok: false, status, error: e });
      const res = await call(r);
      expect(res.status).toBe(status);
      const body = (await res.json()) as { error: { code: string; details: Array<{ reason?: string }> } };
      expect(body.error.code).toBe(code);
      expect(body.error.details[0]?.reason).toBe(reason);
    }
  });
});

// ---------------------------------------------------------------- 3.
describe("3. hostile data is shown as text", () => {
  const noMarkup = (h: string) => {
    expect(h).not.toMatch(/<img|<script/i);
    expect(h).toContain(XSS_TEXT);
  };

  it("a block note on the Firewall page", async () => {
    for (const [, m] of LANGS) noMarkup(html(m, await firewallPage(fw(), m)));
  });

  it("a package name, a version, a site and its owner on the Updates page", async () => {
    const u = updates({ installedVersion: XSS, check: { state: "newer", latestVersion: XSS, checkedAt: T } },
      { sites: [{ siteId: "s1", siteName: XSS, organizationName: XSS, phpVersion: "8.3", stopped: false }], sitesTotal: 1 });
    const p = pkgs({ packages: [
      { name: XSS, installedVersion: XSS, newVersion: XSS, origin: "security" },
      { name: XSS, installedVersion: "1", newVersion: "2", origin: "other" },
    ] });
    const h = html(en, await updatesPage(u, p));
    noMarkup(h);
    expect(h.split(XSS_TEXT).length - 1).toBeGreaterThanOrEqual(7);
  });

  it("a journal line in the one-panel viewer, and a service's state on Health", async () => {
    const { tree } = callHooks(SiteLogs, { url: "/api/admin/logs/hp-panel-update?tail=50", admin: true, journal: true }, en,
      { 0: [{ stream: "stdout", at: null, text: XSS }], 1: null, 2: false });
    noMarkup(html(en, tree));
    serve({ "v1/admin/health": healthDto(HOST_SERVICES.map((service) => ({ service, active: false, activeState: XSS.slice(0, 32), since: null, restarts: 0 }))) });
    const h = html(en, await AdminHealthPage());
    expect(h).not.toMatch(/<img|<script/i);
    expect(h).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("no M5d source in apps/web/src uses dangerouslySetInnerHTML", () => {
    const files = ["components/admin/firewall-ports.tsx", "components/admin/firewall-blocks.tsx", "components/admin/confirm-action.tsx", "components/admin/restart-dialog.tsx",
      "components/customer/site-logs.tsx", "components/layout/sidebar-nav.tsx", "app/admin/firewall/page.tsx", "app/admin/updates/page.tsx", "app/admin/health/page.tsx", "app/admin/logs/page.tsx",
      "lib/admin-firewall.ts", "lib/admin-updates.ts", "lib/admin-restart.ts", "lib/admin-address.ts"];
    for (const f of files) expect(read(`apps/web/src/${f}`), f).not.toContain("dangerouslySetInnerHTML");
  });

  it("no page shows an image name (R198 1.5): the contract carries none and the Updates page writes none", async () => {
    const row = Object.keys((UpdatesDtoSchema.shape.components as unknown as { element: { shape: object } }).element.shape).sort();
    expect(row).toEqual(["component", "expected", "imageCurrent", "runningOperationId"]);
    const h = html(en, await updatesPage(updates(), pkgs())) + html(itMsgs, await updatesPage(updates(), pkgs(), itMsgs));
    expect(h).not.toMatch(/[a-z0-9.-]+\/[a-z0-9._/-]+:[a-z0-9._-]+|@sha256|ghcr\.io|docker\.io|<code/i);
    expect(read("apps/web/src/app/admin/updates/page.tsx")).not.toMatch(/colImage|\.image\b|imageRef/);
  });

  it("a refusal is always a sentence of the catalog, never the server's text or a code", () => {
    const codes = ["VALIDATION_ERROR", "NOT_FOUND", "NOT_SUPPORTED", "FIREWALL_BASE_RULES_NOT_CURRENT", "HOST_AGENT_UNAVAILABLE", "RESOURCE_LOCKED", "HOST_POLICY_DENIED",
      "PANEL_CONTAINER_ABSENT", "HOST_JOB_FAILED", "FORBIDDEN", "SENTINEL_CODE", ""];
    const reasons = [undefined, SENTINEL, ...FIREWALL_BLOCK_REFUSALS, "note_invalid", "unknown_port", "host_job_running", "site_work_running", "already_current", "stopped"];
    for (const [, m] of LANGS) {
      for (const code of codes) {
        for (const reason of reasons) {
          for (const text of [firewallErrorText(m, code, reason), updatesErrorText(m, code, reason)]) {
            expect(isCatalogSentence(m, text), `${code}/${reason}: ${text}`).toBe(true);
            expect(text).not.toContain(SENTINEL);
            if (code) expect(text).not.toContain(code);
          }
        }
      }
    }
  });

  it("the three senders show the catalog's sentence of a refusal, never its message", async () => {
    fetchMock.mockImplementation(async () => answer(409, err("SENTINEL_CODE", [{ field: "f", reason: SENTINEL, message: SENTINEL }])));
    const runs: Array<[string, () => Promise<Array<[number, unknown]>>, number]> = [
      ["ConfirmAction", async () => {
        const { tree, sets } = callHooks(ConfirmAction, { csrfToken: "csrf", name: "n", url: "/api/admin/os-packages/refresh", label: "L", errors: "updates" as const });
        (els(tree).find((e) => e.type === Button)!.props.onClick as () => void)();
        await vi.waitFor(() => expect(sets.some(([k]) => k === 2 && sets.length > 3)).toBe(true));
        return sets;
      }, 2],
      ["FirewallPorts", async () => {
        const { tree, sets } = callHooks(FirewallPorts, { ports: fw().ports, csrfToken: "csrf", disabled: false });
        (els(tree).filter((e) => e.props.role === "switch").find((e) => e.props["aria-checked"] === false)!.props.onClick as () => void)();
        await vi.waitFor(() => expect(sets.filter(([k]) => k === 2)).toHaveLength(2));
        return sets;
      }, 2],
      ["FirewallBlocks", async () => {
        const { tree, sets } = callHooks(FirewallBlocks, { blocks: [], csrfToken: "csrf", disabled: false }, en, { 0: "192.0.2.10", 2: true });
        (els(tree).find((e) => e.type === Button && e.props.variant === "destructive" && textOf(e) === en.admin.firewall.blocks.confirm && e.props.type === "button")!.props.onClick as () => void)();
        await vi.waitFor(() => expect(sets.some(([k]) => k === 4)).toBe(true));
        return sets;
      }, 4],
    ];
    for (const [name, run, idx] of runs) {
      const sets = await run();
      const shown = sets.filter(([k, v]) => k === idx && v !== null).map(([, v]) => (typeof v === "string" ? v : (v as { text: string }).text));
      expect(shown, name).toHaveLength(1);
      expect(isCatalogSentence(en, shown[0]!), name).toBe(true);
      expect(shown[0], name).not.toContain(SENTINEL);
      expect(shown[0], name).not.toContain("SENTINEL_CODE");
    }
  });
});

// ---------------------------------------------------------------- 4.
describe("4. no self-lockout, and the page tells the truth", () => {
  it("closing a port asks first and sends nothing; opening sends at once; the dialog names the port", async () => {
    fetchMock.mockImplementation(async () => answer(200, { data: {} }));
    const ports = fw().ports;
    const open = ports.find((p) => p.open)!;
    const closed = ports.find((p) => !p.open)!;
    for (const [, m] of LANGS) {
      fetchMock.mockClear();
      const { tree, sets } = callHooks(FirewallPorts, { ports, csrfToken: "csrf", disabled: false }, m);
      const sw = (p: typeof open) => els(tree).find((e) => e.props.role === "switch" && e.props["aria-label"] === format(m.admin.firewall.portsCard.switchLabel, { port: p.port }))!;
      (sw(open).props.onClick as () => void)();
      expect(sets).toContainEqual([1, open]);
      expect(fetchMock).not.toHaveBeenCalled();
      (sw(closed).props.onClick as () => void)();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(fetchMock.mock.calls[0]![0]).toBe(`/api/admin/firewall/ports/${closed.name}/open`);

      fetchMock.mockClear();
      const asked = callHooks(FirewallPorts, { ports, csrfToken: "csrf", disabled: false }, m, { 1: open }).tree;
      expect(textOf(els(asked).find((e) => e.type === DialogTitle))).toBe(format(m.admin.firewall.portsCard.closeTitle, { port: open.port }));
      expect(textOf(els(asked).find((e) => e.type === DialogTitle))).toContain(String(open.port));
      (els(asked).find((e) => e.type === Button && textOf(e) === m.admin.firewall.portsCard.closeConfirm)!.props.onClick as () => void)();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(fetchMock.mock.calls[0]![0]).toBe(`/api/admin/firewall/ports/${open.name}/close`);
    }
  });

  it("the block dialog names the address and says what a block costs (R198 1.8); the form alone sends nothing", async () => {
    const cost = { en: "The server and the sites stop getting answers from 203.0.113.7 too.", it: "Anche il server e i siti smettono di ricevere risposte da 203.0.113.7." };
    for (const [l, m] of LANGS) {
      const { tree } = callHooks(FirewallBlocks, { blocks: [], csrfToken: "csrf", disabled: false }, m, { 0: " 203.0.113.7 ", 2: true });
      expect(textOf(els(tree).find((e) => e.type === DialogTitle))).toContain("203.0.113.7");
      const body = textOf(els(tree).find((e) => e.type === DialogDescription));
      expect(body).toContain("203.0.113.7");
      expect(body.endsWith(cost[l as "en" | "it"]), body).toBe(true);
      const filled = callHooks(FirewallBlocks, { blocks: [], csrfToken: "csrf", disabled: false }, m, { 0: "203.0.113.7" });
      (els(filled.tree).find((e) => e.type === "form")!.props.onSubmit as (e: unknown) => void)({ preventDefault() {} });
      expect(filled.sets).toContainEqual([2, true]);
      const empty = callHooks(FirewallBlocks, { blocks: [], csrfToken: "csrf", disabled: false }, m, { 0: "   " });
      (els(empty.tree).find((e) => e.type === "form")!.props.onSubmit as (e: unknown) => void)({ preventDefault() {} });
      expect(empty.sets).not.toContainEqual([2, true]);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("base rules absent or outdated: every change control is disabled and the page says what to do, with the button that does it", async () => {
    for (const state of ["absent", "outdated"] as const) {
      for (const [, m] of LANGS) {
        const tree = await firewallPage(fw({ baseRules: state }), m);
        const t = m.admin.firewall;
        expect(html(m, tree)).toContain(t.base[state]);
        expect(t.base[state]).toMatch(/appl/i);
        const ports = els(tree).find((e) => e.type === FirewallPorts)!;
        const blocks = els(tree).find((e) => e.type === FirewallBlocks)!;
        expect(ports.props.disabled).toBe(true);
        expect(blocks.props.disabled).toBe(true);
        // Inside the components: switches, the form and every Unblock are disabled.
        expect(els(callHooks(FirewallPorts, ports.props as never, m).tree).filter((e) => e.props.role === "switch").every((e) => e.props.disabled === true)).toBe(true);
        const b = els(callHooks(FirewallBlocks, blocks.props as never, m).tree);
        expect(b.filter((e) => e.type === Input || (e.type === Button && e.props.type === "submit")).every((e) => e.props.disabled === true)).toBe(true);
        expect(b.filter((e) => e.type === ConfirmAction).every((e) => e.props.disabled === true)).toBe(true);
        const apply = els(tree).filter((e) => e.type === ConfirmAction);
        expect(apply.map((e) => e.props.label)).toEqual([t.base.apply]);
        expect(apply[0]!.props.url).toBe("/api/bff/hosts/host_a1/security");
        expect(apply[0]!.props.body).toEqual({ policyRef: "apply_dedicated_nftables_22_80_443" });
      }
    }
  });

  it("base rules absent on a server without a host row: the sentence asks to apply them, so the page must offer a way", async () => {
    const tree = await firewallPage(fw({ baseRules: "absent", hostId: null } as Partial<FirewallDto>));
    const h = html(en, tree);
    // R201 1.8: no host row, so no button; the page says its own sentence instead of asking to apply the rules.
    expect(h).toContain(en.admin.firewall.base.unregistered);
    expect(els(tree).filter((e) => e.type === ConfirmAction).length > 0 || /ssh|readme|install/i.test(en.admin.firewall.base.unregistered)).toBe(true);
  });

  it("stored, not in force, for a port and for a block: the words on the entry and Apply again", async () => {
    for (const which of ["port", "block"] as const) {
      const d = fw();
      if (which === "port") d.ports[0]!.inForce = false;
      else d.blocks[1]!.inForce = false;
      for (const [, m] of LANGS) {
        const tree = await firewallPage(d, m);
        expect(html(m, tree)).toContain(m.admin.firewall.notInForce.banner);
        expect(els(tree).filter((e) => e.type === ConfirmAction).map((e) => e.props.label)).toEqual([m.admin.firewall.notInForce.again]);
        expect(html(m, createElement(FirewallStateBadge, { inForce: false }))).toContain(m.admin.firewall.state.notInForce);
      }
    }
  });

  it("disabled and a failed read: their one sentence, no control and no empty list", async () => {
    for (const [, m] of LANGS) {
      for (const d of [fw({ baseRules: "disabled" }), null]) {
        const h = html(m, await firewallPage(d, m));
        expect(h).toContain(d ? m.admin.firewall.base.disabled : m.admin.firewall.loadFailed);
        expect(h).not.toMatch(/<button|<input|<form/);
        expect(h).not.toContain(m.admin.firewall.blocks.empty);
      }
    }
  });

  it("R202: the base rules' sentences name 22, 80 and 443 and warn about SSH on another port; unmanaged says how to hand over", () => {
    const warn = { en: /SSH on this server listens on another port, do not apply/, it: /SSH su questo server ascolta su un'altra porta, non applicar/ };
    for (const [l, m] of LANGS) {
      const b = m.admin.firewall.base;
      for (const s of [b.absent, b.applyBody]) {
        expect(s).toMatch(/\b22 \(SSH\), 80 (and|e) 443\b/);
        expect(s).toMatch(warn[l as "en" | "it"]);
        expect(s).toMatch(/\b2222\b/); // R203 3.4: site SFTP does not pass the base rules
      }
      expect(b.applyBody).toMatch(l === "en" ? /everything else incoming is closed, except site SFTP on port 2222/ : /tutto il resto in ingresso si chiude, tranne l'SFTP dei siti sulla porta 2222/);
      expect(b.unmanaged).toMatch(/--skip-firewall\b[\s\S]*\b22\b[\s\S]*--skip-firewall/);
      // R203 2.3: the hand-over keeps the installed version and restarts the panel.
      expect(b.unmanaged).toMatch(l === "en" ? /--version[\s\S]*panel restarts/ : /--version[\s\S]*pannello si riavvia/);
      // R203 3.1: the error reaches only a page out of date, on unmanaged too.
      expect(m.admin.firewall.errors.notCurrent).toMatch(l === "en" ? /Reload the page[^.]*\.$/ : /Ricarica la pagina[^.]*\.$/);
      expect(m.admin.firewall.errors.notCurrent).not.toMatch(/Apply the base rules|Applica le regole di base/);
      expect(m.admin.firewall.static.panel).toMatch(/container/);
      expect(m.admin.firewall.notInForce.banner).toMatch(l === "en" ? /unblock it first, and only then choose Apply again/ : /prima sbloccalo e solo dopo scegli Applica di nuovo/);
      expect(m.admin.updates.panel.updateFacts).toMatch(l === "en" ? /restart once more/ : /si riavviano un'altra volta/);
    }
  });

  it("R202: a sentence of Firewall or Updates that names a command says it is typed on the server, over SSH", () => {
    for (const [l, m] of LANGS) {
      const cmds = [m.admin.firewall, m.admin.updates].flatMap(leaves).filter((s) => /\b(systemctl|journalctl)\b/.test(s));
      expect(cmds.length).toBeGreaterThanOrEqual(7);
      for (const s of cmds) expect(s, s).toMatch(l === "en" ? /on the server, over SSH: (systemctl|journalctl)/ : /sul server, via SSH: (systemctl|journalctl)/);
    }
  });

  it("no sentence of the Firewall, Updates or services texts says nftables, chain, set or table", () => {
    const groups = (m: Messages) => [m.admin.firewall, m.admin.updates, m.admin.health.services];
    for (const s of groups(en).flatMap(leaves)) expect(s).not.toMatch(/\bnftables\b|\bnft\b|\bchains?\b|\bsets?\b|\btables?\b/i);
    for (const s of groups(itMsgs).flatMap(leaves)) expect(s).not.toMatch(/\bnftables\b|\bnft\b|\bcaten[ae]\b|\btabell[ae]\b/i);
  });
});

// ---------------------------------------------------------------- 5.
describe("5. every action that takes time ends in words", () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  // R202 3: a 401 of the operations route only means the session ended (the API's signing key is a file; an API away answers 502/504).
  it("a follow that gets 401 stops at the first one and ends signed out", async () => {
    for (const ms of [JOB_FOLLOW_MS, 180_000]) {
      const c = clock();
      const fetch = vi.fn(async () => answer(401, err("UNAUTHENTICATED")));
      expect(await followRestart("op_1", { fetch: fetch as never, ...c }, ms)).toBe("signedOut");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(c.now()).toBe(RESTART_POLL_MS);
    }
  });

  it("reads that fail for 25 minutes are not a failure; a terminal end is; a cancelled one counts as failed", async () => {
    for (const [end, want] of [["succeeded", "succeeded"], ["failed", "failed"], ["cancelled", "failed"]] as const) {
      const c = clock();
      const fetch = vi.fn(async () => {
        if (c.now() < 25 * 60_000) {
          const n = fetch.mock.calls.length % 3;
          if (n === 0) throw new Error("network");
          return n === 1 ? answer(502) : answer(200, { data: { status: "running" } });
        }
        return answer(200, { data: { status: end } });
      });
      expect(await followRestart("op_1", { fetch: fetch as never, ...c }, JOB_FOLLOW_MS)).toBe(want);
      expect(c.now()).toBeGreaterThanOrEqual(25 * 60_000);
    }
  });

  const runConfirm = async (follow: { reload?: boolean }, opStatus: number, opBody: unknown) => {
    vi.useFakeTimers();
    fetchMock.mockClear();
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { reload } });
    fetchMock.mockImplementation(async (url: string) => (url.startsWith("/api/admin/operations/") ? answer(opStatus, opBody) : answer(202, { data: { operationId: "op_9" } })));
    const f = { ms: JOB_FOLLOW_MS, running: "R", done: "D", failed: "F", unknown: "U", ...follow };
    const { tree, sets } = callHooks(ConfirmAction, { csrfToken: "csrf", name: "n", url: "/api/admin/updates/panel/apply", label: "L", errors: "updates" as const, follow: f });
    (els(tree).find((e) => e.type === Button)!.props.onClick as () => void)();
    await vi.advanceTimersByTimeAsync(JOB_FOLLOW_MS + 4 * RESTART_POLL_MS);
    return { reload, sets, calls: fetchMock.mock.calls.map((c) => c[0] as string) };
  };

  it("the panel's own update reloads the page at a known end, and not at its deadline", async () => {
    for (const status of ["succeeded", "failed"]) {
      const r = await runConfirm({ reload: true }, 200, { data: { status } });
      expect(r.reload, status).toHaveBeenCalledTimes(1);
      expect(r.sets).toContainEqual([3, status]);
      expect(r.calls.filter((u) => u === "/api/admin/operations/op_9")).toHaveLength(1);
      vi.useRealTimers();
    }
    const r = await runConfirm({ reload: true }, 401, err("UNAUTHENTICATED"));
    expect(r.reload).not.toHaveBeenCalled();
    expect(r.sets).toContainEqual([3, "signedOut"]);
    expect(r.calls.filter((u) => u === "/api/admin/operations/op_9")).toHaveLength(1);
    vi.useRealTimers();
    for (const [errors, want] of [["firewall", en.admin.firewall.errors.session], ["updates", en.admin.updates.errors.session]] as const) {
      const f = { ms: 1, running: "R", done: "D", failed: "F", unknown: "U" };
      const { tree } = callHooks(ConfirmAction, { csrfToken: "c", name: "n", url: "/x", label: "L", errors, follow: f }, en, { 3: "signedOut" });
      expect(textOf(tree)).toContain(want);
    }
  });

  it("the other follows refresh and never reload; the Updates page asks a reload only of the panel's update", async () => {
    const r = await runConfirm({}, 200, { data: { status: "succeeded" } });
    expect(r.reload).not.toHaveBeenCalled();
    expect(router.refresh).toHaveBeenCalled();
    vi.useRealTimers();
    const tree = await updatesPage(updates(), pkgs({ running: null }));
    const reloads = els(tree).filter((e) => e.type === ConfirmAction && (e.props.follow as { reload?: boolean } | undefined)?.reload).map((e) => e.props.url);
    expect(reloads).toEqual(["/api/admin/updates/panel/apply"]);
  });

  it("a job running when the page opens is followed again: the panel, a part, a package job; the site update has nothing to resume", async () => {
    const u = updates({ running: { operationId: "op_p" } }, {
      components: PANEL_CONTAINERS.map((component) => ({ component, expected: true, imageCurrent: true, runningOperationId: component === "shared_database" ? "op_c" : null })),
    });
    for (const job of ["os_refresh", "os_upgrade"] as const) {
      const tree = await updatesPage(u, pkgs({ running: { operationId: `op_${job}`, job } }));
      const running = Object.fromEntries(els(tree).filter((e) => e.type === ConfirmAction && e.props.runningOperationId).map((e) => [e.props.url, e.props.runningOperationId]));
      expect(running).toEqual({
        "/api/admin/updates/panel/apply": "op_p",
        "/api/admin/updates/components/shared_database/apply": "op_c",
        [`/api/admin/os-packages/${job === "os_refresh" ? "refresh" : "upgrade"}`]: `op_${job}`,
      });
      // The other package button waits while one job runs (R200 3).
      const other = els(tree).find((e) => e.type === ConfirmAction && e.props.url === `/api/admin/os-packages/${job === "os_refresh" ? "upgrade" : "refresh"}`);
      expect(other?.props.disabled ?? true).toBe(true);
    }
    expect(Object.keys((UpdatesDtoSchema.shape.sites as unknown as { element: { shape: object } }).element.shape)).not.toContain("runningOperationId");
  });

  it("Update appears only when a newer release was found; while one runs it stays, disabled and saying it runs (R200 3)", async () => {
    for (const state of PANEL_CHECK_STATES) {
      const tree = await updatesPage(updates({ check: { state, latestVersion: state === "newer" ? "1.5.0" : null, checkedAt: T } }), pkgs());
      expect(els(tree).some((e) => e.type === ConfirmAction && e.props.url === "/api/admin/updates/panel/apply"), state).toBe(state === "newer");
    }
    const tree = await updatesPage(updates({ running: { operationId: "op_p" } }), pkgs());
    const el = els(tree).find((e) => e.type === ConfirmAction && e.props.url === "/api/admin/updates/panel/apply")!;
    const { tree: t2 } = callHooks(ConfirmAction, el.props as never);
    expect(els(t2).find((e) => e.type === Button)!.props.disabled).toBe(true);
    expect(html(en, t2)).toContain(`<p role="status" class="text-xs text-muted-foreground">${en.admin.updates.panel.running}</p>`);
    expect(els(tree).find((e) => e.type === ConfirmAction && e.props.url === "/api/admin/updates/panel/check")!.props.disabled).toBe(true);
  });

  it("Install security updates only when the server can install them and one security update exists, or while that job runs", async () => {
    const sec = { name: "libexample1", installedVersion: "1", newVersion: "2", origin: "security" as const };
    const plain = { name: "toolexample", installedVersion: "1", newVersion: "2", origin: "distribution" as const };
    for (const canUpgrade of [true, false]) {
      for (const packages of [[sec, plain], [plain], []]) {
        for (const running of [null, { operationId: "op_r", job: "os_refresh" as const }, { operationId: "op_u", job: "os_upgrade" as const }]) {
          const tree = await updatesPage(updates(), pkgs({ canUpgrade, packages, running }));
          const shown = els(tree).some((e) => e.type === ConfirmAction && e.props.url === "/api/admin/os-packages/upgrade");
          expect(shown, JSON.stringify({ canUpgrade, n: packages.length, running })).toBe((canUpgrade && packages.includes(sec)) || running?.job === "os_upgrade");
        }
      }
    }
  });

  it("each panel-update result and each check state has a filled sentence in both languages", () => {
    for (const [, m] of LANGS) {
      for (const s of PANEL_CHECK_STATES) expect(format(m.admin.updates.panel.states[s], { latest: "1.5.0", time: "x" })).toMatch(/^[^{}]{10,}$/);
      for (const r of HOST_JOB_RESULTS) {
        const key = r === "succeeded" ? "updated" : r;
        expect(format(m.admin.updates.panel.results[key as keyof typeof m.admin.updates.panel.results], { time: "x" }), r).toMatch(/^[^{}]{10,}$/);
      }
    }
  });
});

// ---------------------------------------------------------------- 6.
describe("6. every sentence is understood by someone who has never seen a server", () => {
  const pick = (m: Messages) => ({
    firewall: m.admin.firewall,
    updates: m.admin.updates,
    services: m.admin.health.services,
    restart: { warn: { api: m.admin.health.restart.warn.api, web: m.admin.health.restart.warn.web, executor: m.admin.health.restart.warn.executor, host_agent: m.admin.health.restart.warn.host_agent },
      siteWork: m.admin.health.restart.siteWork, hostJob: m.admin.health.restart.hostJob },
    logs: { services: m.admin.logs.services, hostGroup: m.admin.logs.hostGroup, units: m.admin.logs.units, journal: m.admin.logs.viewer.journal, journalUnavailable: m.admin.logs.viewer.journalUnavailable },
    nav: { firewall: m.admin.nav.firewall, updates: m.admin.nav.updates },
  });
  const flat = (o: unknown, p = ""): Array<[string, string]> =>
    typeof o === "string" ? [[p, o]] : Object.entries(o as object).flatMap(([k, v]) => flat(v, p ? `${p}.${k}` : k));
  const E = new Map(flat(pick(en)));
  const I = new Map(flat(pick(itMsgs)));
  const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();

  it("the same keys and the same placeholders in both catalogs", () => {
    expect([...I.keys()].sort()).toEqual([...E.keys()].sort());
    for (const [k, v] of E) expect(holes(I.get(k)!), k).toEqual(holes(v));
    expect(E.size).toBeGreaterThan(150);
  });

  it("filled, no sentence keeps a brace, a key name or undefined", () => {
    for (const [, map] of [["en", E], ["it", I]] as const) {
      for (const [k, v] of map) {
        const filled = format(v, Object.fromEntries(holes(v).map((h) => [h!, "x1"])));
        expect(filled, k).not.toMatch(/[{}]|\bundefined\b|\bnull\b|\bNaN\b|admin\.|\b\w+\.\w+\.\w+\b(?<!\d)/);
        expect(filled.trim(), k).not.toBe("");
      }
    }
  });

  it("the Italian text differs from the English one except for the words that are the same in both", () => {
    const same = [...E].filter(([k, v]) => I.get(k) === v).map(([k, v]) => `${k}=${v}`).sort();
    // Firewall and Container are the words Italian uses too.
    expect(same).toEqual(["firewall.title=Firewall", "nav.firewall=Firewall", "updates.components.colComponent=Container"]);
    // Every identical pair is a name, a number or a unit, never a sentence.
    for (const s of same) expect(s.split("=")[1]!.split(" ").length, s).toBeLessThanOrEqual(3);
  });

  const enNext = /\b(try|enter|check|use|wait|close|reload|sign in|apply|unblock|start|choose|type|write|remove|ask|restart|run|see|follow|update|install|give)\b/i;
  const itNext = /(riprova|inserisci|controlla|usa|aspetta|chiud|ricarica|accedi|applica|sblocca|avvia|scegli|scrivi|rimuovi|chiedi|riavvia|esegui|vedi|segui|aggiorna|installa|indica|prova)/i;

  it("every refusal names what to do next", () => {
    const refusals = (m: Messages) => [
      ...Object.entries(m.admin.firewall.refusals).map(([k, v]) => [`firewall.refusals.${k}`, v] as const),
      ...Object.entries(m.admin.firewall.errors).map(([k, v]) => [`firewall.errors.${k}`, v] as const),
      ["restart.siteWork", m.admin.health.restart.siteWork] as const,
      ["restart.hostJob", m.admin.health.restart.hostJob] as const,
      ["updates.panel.locked", m.admin.updates.panel.locked] as const,
    ];
    const missing = [
      ...refusals(en).filter(([, v]) => !enNext.test(v)).map(([k, v]) => `en ${k}: ${v}`),
      ...refusals(itMsgs).filter(([, v]) => !itNext.test(v)).map(([k, v]) => `it ${k}: ${v}`),
    ];
    expect(missing.join("\n")).toBe("");
  });

  it("the Updates page says a true sentence for each refusal its API gives (not a site's, not a field's, not 'contact support')", () => {
    // [code, reason, the action that gets it] from the routes as built (team channel, host and updates routes are in).
    const cases: Array<[string, string | undefined, string]> = [
      ["RESOURCE_LOCKED", "site_work_running", "panel apply"],
      ["RESOURCE_LOCKED", undefined, "component apply (same lock as Restart)"],
      ["RESOURCE_LOCKED", undefined, "site image update (site busy)"],
      ["VALIDATION_ERROR", "already_current", "site image update"],
      ["VALIDATION_ERROR", "stopped", "site image update"],
      ["PANEL_CONTAINER_ABSENT", undefined, "component apply"],
      ["NOT_SUPPORTED", undefined, "any job, agent disabled"],
      ["HOST_AGENT_UNAVAILABLE", undefined, "any job, agent down"],
    ];
    const wrong: string[] = [];
    for (const [l, m] of LANGS) {
      const untrue = new Set([m.errors.VALIDATION_ERROR, m.errors.generic]);
      for (const [code, reason, where] of cases) {
        const text = updatesErrorText(m, code, reason);
        const siteSentence = where.startsWith("site") ? null : m.errors.RESOURCE_LOCKED;
        if (untrue.has(text) || text === siteSentence) wrong.push(`${l} ${where} ${code}/${reason ?? "-"}: ${text}`);
      }
      const fwDown = firewallErrorText(m, "HOST_AGENT_UNAVAILABLE");
      if (untrue.has(fwDown)) wrong.push(`${l} firewall change HOST_AGENT_UNAVAILABLE: ${fwDown}`);
    }
    expect(wrong.join("\n")).toBe("");
  });
});

// ---------------------------------------------------------------- 7.
describe("7. accessibility in the markup", () => {
  it("switches: role switch, aria-checked and a name that says which port, unique per port", () => {
    for (const [, m] of LANGS) {
      const sw = els(callHooks(FirewallPorts, { ports: fw().ports, csrfToken: "csrf", disabled: false }, m).tree).filter((e) => e.props.role === "switch");
      expect(sw).toHaveLength(FIREWALL_PORT_NAMES.length);
      expect(new Set(sw.map((e) => e.props["aria-label"])).size).toBe(sw.length);
      for (const [i, name] of FIREWALL_PORT_NAMES.entries()) {
        expect(sw[i]!.props["aria-label"]).toContain(String(FIREWALL_SAFE_PORTS[name]));
        expect(typeof sw[i]!.props["aria-checked"]).toBe("boolean");
        expect(textOf(sw[i])).toBe(sw[i]!.props["aria-checked"] ? m.admin.firewall.portsCard.open : m.admin.firewall.portsCard.closed);
      }
    }
  });

  it("the state of a port, a block, a service and a part is said in words", async () => {
    for (const [, m] of LANGS) {
      const words = [true, false, null].map((v) => html(m, createElement(FirewallStateBadge, { inForce: v })).replace(/<[^>]+>/g, ""));
      expect(new Set(words).size).toBe(3);
      for (const w of words) expect(w.length).toBeGreaterThan(2);
      const t = m.admin.updates.components;
      const h = html(m, await updatesPage(updates({}, { components: PANEL_CONTAINERS.map((component, i) => ({ component, expected: i !== 0, imageCurrent: [true, false, null][i % 3]!, runningOperationId: null })) }), pkgs(), m));
      for (const s of [t.current, t.behind, t.unknown, m.admin.health.states.not_in_use]) expect(h).toContain(`>${s}<`);
    }
  });

  it("dialogs have a name; their close and Cancel are held while a request runs, and released after", () => {
    const busy = { current: true };
    const idle = { current: false };
    const cases: Array<[string, (refs: Record<number, unknown>, busyState: boolean) => ReturnType<typeof callHooks>]> = [
      ["ConfirmAction", (refs, b) => callHooks(ConfirmAction, { csrfToken: "c", name: "n", url: "/u", label: "L", errors: "updates" as const, dialog: { title: "T", body: "B", confirm: "C" } }, en, { 0: true, 1: b }, refs)],
      ["FirewallPorts", (refs, b) => callHooks(FirewallPorts, { ports: fw().ports, csrfToken: "c", disabled: false }, en, { 0: b ? "nrpe" : null, 1: fw().ports[5] }, refs)],
      ["FirewallBlocks", (refs, b) => callHooks(FirewallBlocks, { blocks: [], csrfToken: "c", disabled: false }, en, { 0: "192.0.2.1", 2: true, 3: b }, refs)],
    ];
    for (const [name, run] of cases) {
      const held = run({ 1: busy }, true);
      expect(textOf(els(held.tree).find((e) => e.type === DialogTitle)).length, name).toBeGreaterThan(0);
      (els(held.tree).find((e) => e.type === Dialog)!.props.onOpenChange as (o: boolean) => void)(false);
      expect(held.sets, name).toEqual([]);
      expect(els(held.tree).find((e) => e.type === Button && textOf(e) === en.common.cancel)!.props.disabled, name).toBe(true);
      const free = run({ 1: idle }, false);
      (els(free.tree).find((e) => e.type === Dialog)!.props.onOpenChange as (o: boolean) => void)(false);
      expect(free.sets.length, name).toBe(1);
    }
  });

  it("the block form's fields have labels that point at them", () => {
    const tree = els(callHooks(FirewallBlocks, { blocks: [], csrfToken: "c", disabled: false }).tree);
    const ids = tree.filter((e) => e.type === Input).map((e) => e.props.id);
    expect(ids).toEqual(["firewall-block-address", "firewall-block-note"]);
    expect(tree.filter((e) => e.type === Label).map((e) => e.props.htmlFor)).toEqual(ids);
  });

  it("a refusal is role=alert and the follow of an action is role=status", () => {
    const base = { csrfToken: "c", name: "n", url: "/u", label: "L", errors: "updates" as const, follow: { ms: 1, running: "RUN", done: "DONE", failed: "FAIL", unknown: "UNK" } };
    expect(html(en, callHooks(ConfirmAction, base, en, { 2: "REFUSED" }).tree)).toContain('<p role="alert" class="text-xs text-destructive">REFUSED</p>');
    for (const [phase, s] of [["running", "RUN"], ["succeeded", "DONE"], ["failed", "FAIL"], ["unknown", "UNK"]]) {
      expect(html(en, callHooks(ConfirmAction, base, en, { 3: phase }).tree)).toContain(`<p role="status" class="text-xs text-muted-foreground">${s}</p>`);
    }
    const ports = callHooks(FirewallPorts, { ports: fw().ports, csrfToken: "c", disabled: false }, en, { 2: { name: "nrpe", text: "REFUSED" } }).tree;
    expect(els(ports).find((e) => textOf(e) === "REFUSED")!.props.role).toBe("alert");
    const blocks = html(en, callHooks(FirewallBlocks, { blocks: [], csrfToken: "c", disabled: false }, en, { 4: "REFUSED" }).tree);
    expect(blocks).toMatch(/role="alert"[^>]*>(<[^>]+>)*REFUSED/);
  });

  it("every table has header cells", async () => {
    const pages = [html(en, await firewallPage(fw())), html(en, await updatesPage(updates(), pkgs({ packages: [...pkgs().packages, { name: "otherexample", installedVersion: "1", newVersion: "2", origin: "other" }] })))];
    for (const h of pages) {
      const tables = h.split("<table").slice(1);
      expect(tables.length).toBeGreaterThanOrEqual(1);
      for (const t of tables) expect(t.slice(0, t.indexOf("</table>"))).toMatch(/<thead[\s\S]*<th/);
    }
  });

  it("every button on the Firewall and Updates pages has a name that says what it acts on: no two buttons share one", async () => {
    const names = (tree: ReactNode, m: Messages) => {
      const out: string[] = [];
      const walk = (n: unknown) => {
        for (const e of els(n)) {
          if (e.type === ConfirmAction) out.push(String(e.props.ariaLabel ?? e.props.label));
          if (e.type === FirewallPorts) for (const s of els(callHooks(FirewallPorts, e.props as never, m).tree).filter((x) => x.props.role === "switch")) out.push(String(s.props["aria-label"]));
          if (e.type === FirewallBlocks) {
            const b = els(callHooks(FirewallBlocks, e.props as never, m).tree);
            for (const x of b.filter((y) => y.type === Button && y.props.type === "submit")) out.push(textOf(x));
            for (const x of b.filter((y) => y.type === ConfirmAction)) out.push(String(x.props.ariaLabel ?? x.props.label));
          }
          if (e.type === SiteLogs) out.push(m.admin.logs.viewer.refresh);
        }
      };
      walk(tree);
      return out;
    };
    for (const [, m] of LANGS) {
      const f = names(await firewallPage(fw(), m), m);
      expect(f.filter((n) => n.includes("203.0.113.0/24") || n.includes("198.51.100.7") || n.includes("2001:db8::/32"))).toHaveLength(3);
      const u = names(await updatesPage(updates(), pkgs(), m), m);
      for (const list of [f, u]) {
        const dup = list.filter((n, i) => list.indexOf(n) !== i);
        expect(dup, list.join(" | ")).toEqual([]);
      }
    }
  });
});

// ---------------------------------------------------------------- 8.
describe("8. the customer's side did not change", () => {
  const files = (dir: string): string[] => {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) return [];
    return fs.readdirSync(full, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
  };

  it("no Firewall or Updates link, no service restart and no host route on a customer page", () => {
    const customer = ["app/sites", "app/account", "app/login", "components/customer", "components/account", "components/shared", "components/layout"]
      .flatMap((d) => files(`apps/web/src/${d}`)).filter((f) => !f.endsWith("sidebar-nav.tsx"));
    expect(customer.length).toBeGreaterThan(20);
    for (const f of customer) expect(read(f), f).not.toMatch(/\/admin\/firewall|\/admin\/updates|host-services|os-packages|image-update|\bConfirmAction\b|hp-panel-update/);
    // The admin sidebar is mounted only by the admin layout.
    const mounts = files("apps/web/src/app").filter((f) => read(f).includes("<SidebarNav"));
    expect(mounts).toEqual(["apps/web/src/app/admin/layout.tsx"]);
  });

  it("a customer who types the address of a new page is sent away by the admin layout", async () => {
    getServerSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf", user: { id: "u2", isServerAdmin: false, mustChangePassword: false, name: "n", email: "customer@example.test" } });
    await expect(AdminLayout({ children: createElement("p", null, "firewall") })).rejects.toThrow("REDIRECT:/");
    expect(fetchUpstream).not.toHaveBeenCalled();
    for (const page of ["firewall", "updates"]) expect(fs.existsSync(path.join(ROOT, `apps/web/src/app/admin/${page}/page.tsx`))).toBe(true);
  });

  it("the customer's site-logs viewer renders as before: two panels, the customer texts, no journal sentence", async () => {
    for (const [, m] of LANGS) {
      const { tree } = callHooks(SiteLogs, { url: "/api/bff/orgs/o1/managed-sites/s1/logs" }, m, { 0: [{ stream: "stdout", at: null, text: "GET /" }, { stream: "stderr", at: null, text: "warn" }], 1: null, 2: false });
      const h = html(m, tree);
      for (const s of [m.site.logs.visits, m.site.logs.errors, m.site.logs.refresh]) expect(h).toContain(s);
      expect(h).not.toContain(m.admin.logs.viewer.journal);
      fetchMock.mockResolvedValue(answer(503, err("HOST_AGENT_UNAVAILABLE")));
      const { tree: t2, sets } = callHooks(SiteLogs, { url: "/api/bff/orgs/o1/managed-sites/s1/logs" }, m);
      await (els(t2).find((e) => e.type === Button)!.props.onClick as () => Promise<void>)();
      expect(sets).toContainEqual([1, m.site.logs.unavailable]);
    }
  });

  it("the shipped vocabulary test reads every customer section whole, so it reads any key M5d could have added there", () => {
    const t = read("apps/web/test/ui-copy.test.ts");
    expect(t).toContain('const adminOnly: Record<string, string> = { admin: "every page under /admin (app/admin)" };');
    expect(t).toContain('const sections = ["common", "login", "account", "shell", "site", "apps", "notifications", "notFound", "errors"] as const;');
    expect(t).toContain("JSON.stringify(en[s]), JSON.stringify(itMsgs[s])");
    expect(t).toMatch(/const jargon = \/\\b\(container\|docker\|image\|volume\|network\|service/);
    expect(t).toContain("revision");
    expect(t).toContain("contenitore|contenitori|immagine|immagini|volumi");
    expect(t).toContain('"components/customer"');
  });
});

// ---------------------------------------------------------------- 1, last case: the API description (written after docs posted openapi is in).
describe("1. the routes are described in docs/api/openapi.yaml", () => {
  const openapi = read("docs/api/openapi.yaml");
  /** The block of one path in openapi.yaml, split by method. */
  const pathBlock = (p: string): Record<string, string> => {
    const start = openapi.indexOf(`\n  ${p}:\n`);
    if (start < 0) return {};
    const rest = openapi.slice(start + 1);
    const end = rest.slice(1).search(/\n {2}\S|\n\S/);
    const block = end < 0 ? rest : rest.slice(0, end + 1);
    const out: Record<string, string> = {};
    const parts = block.split(/\n {4}(get|post|put|patch|delete):\n/);
    for (let i = 1; i < parts.length; i += 2) out[parts[i]!.toUpperCase()] = parts[i + 1]!;
    return out;
  };
  const DESCRIBED: Array<[string, string, number]> = [
    ["GET", "/v1/admin/firewall", 200],
    ["POST", "/v1/admin/firewall/ports/{name}/open", 200],
    ["POST", "/v1/admin/firewall/ports/{name}/close", 200],
    ["POST", "/v1/admin/firewall/blocks", 201],
    ["DELETE", "/v1/admin/firewall/blocks/{blockId}", 200],
    ["POST", "/v1/admin/host-services/{service}/restart", 202],
    ["GET", "/v1/admin/updates", 200],
    ["POST", "/v1/admin/updates/panel/check", 200],
    ["POST", "/v1/admin/updates/panel/apply", 202],
    ["POST", "/v1/admin/updates/components/{component}/apply", 202],
    ["POST", "/v1/admin/sites/{siteId}/image-update", 202],
    ["GET", "/v1/admin/os-packages", 200],
    ["POST", "/v1/admin/os-packages/refresh", 202],
    ["POST", "/v1/admin/os-packages/upgrade", 202],
    ["GET", "/v1/admin/logs/{component}", 200],
    ["POST", "/v1/hosts/{hostId}/security", 202],
  ];

  it("each path the BFF forwards to and each page reads is there with its method and only its success status", () => {
    for (const [method, p, status] of DESCRIBED) {
      const doc = pathBlock(p)[method];
      expect(doc, `${method} ${p}`).toBeDefined();
      const ok = [...doc!.matchAll(/^ {8}"(\d{3})":/gm)].map((x) => Number(x[1])).filter((s) => s < 300);
      expect(ok, `${method} ${p}`).toEqual([status]);
    }
  });

  it("the refusals the screens turn into words are described where the API gives them", () => {
    const codes = (method: string, p: string) => [...pathBlock(p)[method]!.matchAll(/^ {8}"(\d{3})":/gm)].map((x) => Number(x[1]));
    for (const p of ["/v1/admin/firewall/ports/{name}/open", "/v1/admin/firewall/blocks"]) expect(codes("POST", p), p).toEqual(expect.arrayContaining([400, 409, 422]));
    for (const p of ["/v1/admin/updates/panel/apply", "/v1/admin/updates/components/{component}/apply", "/v1/admin/sites/{siteId}/image-update", "/v1/admin/host-services/{service}/restart"]) {
      expect(codes("POST", p), p).toEqual(expect.arrayContaining([409, 422]));
    }
    expect(openapi).toContain("FIREWALL_BASE_RULES_NOT_CURRENT");
    expect(openapi).toContain("HOST_JOB_FAILED");
  });
});
