import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOTIFICATION_CHANNEL_KINDS,
  NOTIFICATION_DELIVERY_STATUSES,
  NOTIFICATION_GROUPS_OF_AUDIENCE,
  NOTIFICATION_PROBLEMS,
  findForbiddenPublicDtoKeys,
  type NotificationSettingsDto,
} from "@hosting-panel/contracts";

const fetchUpstream = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({
  accessToken: "tok",
  csrfToken: "csrf",
  activeConsole: "customer",
  user: { name: "Someone", isServerAdmin: false, mustChangePassword: false },
}));

vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...a: unknown[]) => fetchUpstream(...a),
}));
vi.mock("@/lib/server-session", () => ({
  getServerSession: async () => session,
  getSessionFromRequest: async () => session,
}));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => "en" }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => "/admin/notifications",
}));
// The menu's items render only when it is open: render them inline to read the account menu.
vi.mock("@/components/ui/dropdown-menu", async () => {
  const { createElement: h, Fragment } = await import("react");
  const pass = ({ children }: { children?: ReactNode }) => h(Fragment, null, children);
  return {
    DropdownMenu: pass,
    DropdownMenuTrigger: pass,
    DropdownMenuContent: ({ children }: { children?: ReactNode }) => h("div", { "data-menu": "" }, children),
    DropdownMenuItem: pass,
    DropdownMenuLabel: pass,
    DropdownMenuSeparator: () => null,
  };
});

import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { errorMessage, format } from "@/i18n";
import { I18nProvider } from "@/i18n/provider";
import { GET as adminGet } from "@/app/api/admin/notifications/route";
import { PUT as adminPut, DELETE as adminDelete } from "@/app/api/admin/notifications/channels/[channel]/route";
import { POST as adminTest } from "@/app/api/admin/notifications/channels/[channel]/test/route";
import { GET as orgGet } from "@/app/api/bff/orgs/[orgId]/notifications/route";
import { PUT as orgPut, DELETE as orgDelete } from "@/app/api/bff/orgs/[orgId]/notifications/channels/[channel]/route";
import { POST as orgTest } from "@/app/api/bff/orgs/[orgId]/notifications/channels/[channel]/test/route";
import AdminNotificationsPage from "@/app/admin/notifications/page";
import AccountNotificationsPage from "@/app/account/notifications/page";
import { CustomerTopBar } from "@/components/customer/top-bar";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { NotificationSettings } from "@/components/shared/notification-settings";
import { NOTIFICATION_FIELDS, notificationChannelInput, notificationInputErrors, type NotificationFormValues } from "@/lib/notification-form";

const NOW = "2026-11-23T10:00:00.000Z";
const ORG = "org_a1";
const ADMIN = "v1/admin/notifications";
const OF_ORG = `v1/organizations/${ORG}/notifications`;
const SIGNING_KEY = "k".repeat(24);
const BOT_TOKEN = `123456789:${"A".repeat(35)}`;

const req = (method: string, headers: Record<string, string> = {}, body: unknown = {}) =>
  new Request("http://localhost:3000/x", {
    method,
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", ...headers },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
const admin = (channel: string) => ({ params: Promise.resolve({ channel }) });
const org = (channel: string, orgId: string = ORG) => ({ params: Promise.resolve({ orgId, channel }) });
const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
const fail = (status: number, code: string) => ({ ok: false, status, error: { error: { code } } });
const answer = (byPath: Record<string, unknown>) =>
  fetchUpstream.mockImplementation(async (path: string) => byPath[path] ?? fail(404, "NOT_FOUND"));
const reads = () => fetchUpstream.mock.calls.map(([p]) => String(p));
const html = (m: typeof en, node: ReactNode) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: node })).replace(/&#x27;/g, "'");
const count = (h: string, part: string) => h.split(part).length - 1;

const settings = (over: Partial<NotificationSettingsDto> = {}): NotificationSettingsDto => ({
  audience: "server",
  mailReady: true,
  groups: ["availability", "backups", "certificates", "server"],
  channels: {
    email: { enabled: true, groups: ["availability", "server"], updatedAt: NOW, lastTestedAt: null, recipients: ["ops@example.org", "second@example.org"] },
    webhook: { enabled: false, groups: ["backups"], updatedAt: NOW, lastTestedAt: NOW, host: "hooks.example.org", signed: true },
    telegram: { enabled: true, groups: ["certificates"], updatedAt: NOW, lastTestedAt: null, chat: "-1001234500000" },
  },
  deliveries: [
    { id: "nd_1", channel: "webhook", createdAt: NOW, finishedAt: NOW, status: "failed", problem: "server_error", httpStatus: 502, attempts: 4, test: false, opened: 2, closed: 1, recipient: null },
    { id: "nd_2", channel: "email", createdAt: NOW, finishedAt: NOW, status: "sent", problem: null, httpStatus: null, attempts: 1, test: true, opened: 0, closed: 0, recipient: "ops@example.org" },
    { id: "nd_3", channel: "telegram", createdAt: NOW, finishedAt: null, status: "pending", problem: "unreachable", httpStatus: null, attempts: 2, test: false, opened: 1, closed: 0, recipient: null },
  ],
  ...over,
});
const ofCustomer = (over: Partial<NotificationSettingsDto> = {}) =>
  settings({
    audience: "customer",
    groups: ["availability", "backups", "certificates"],
    channels: { email: { enabled: true, groups: ["availability"], updatedAt: NOW, lastTestedAt: null, recipients: null }, webhook: null, telegram: null },
    deliveries: [],
    ...over,
  });
const values = (over: Partial<NotificationFormValues> = {}): NotificationFormValues => ({
  enabled: true,
  groups: ["availability"],
  recipients: "",
  url: "",
  signingKey: "",
  dropKey: false,
  botToken: "",
  chat: "",
  ...over,
});

beforeEach(() => {
  fetchUpstream.mockReset();
  session.activeConsole = "customer";
  session.user = { name: "Someone", isServerAdmin: false, mustChangePassword: false };
});

describe("notifications BFF", () => {
  it("a write without the right CSRF token is refused and nothing reaches the API", async () => {
    const bad = { "X-CSRF-Token": "bad" };
    const answers = await Promise.all([
      adminPut(req("PUT", bad), admin("webhook")),
      adminDelete(req("DELETE", bad), admin("webhook")),
      adminTest(req("POST", bad), admin("webhook")),
      orgPut(req("PUT", bad), org("webhook")),
      orgDelete(req("DELETE", bad), org("webhook")),
      orgTest(req("POST", bad), org("webhook")),
    ]);
    expect(answers.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403]);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("the eight calls go to the API's paths with their methods, and a save carries its body", async () => {
    fetchUpstream.mockResolvedValue(ok({}));
    const body = { enabled: true, groups: ["backups"], chat: "@ops_alerts" };
    await adminGet(req("GET"));
    await adminPut(req("PUT", {}, body), admin("telegram"));
    await adminDelete(req("DELETE"), admin("email"));
    await adminTest(req("POST"), admin("webhook"));
    await orgGet(req("GET"), { params: Promise.resolve({ orgId: ORG }) });
    await orgPut(req("PUT", {}, body), org("telegram"));
    await orgDelete(req("DELETE"), org("email"));
    await orgTest(req("POST"), org("webhook"));
    expect(fetchUpstream.mock.calls.map(([p, o]) => [p, o.method])).toEqual([
      [ADMIN, "GET"],
      [`${ADMIN}/channels/telegram`, "PUT"],
      [`${ADMIN}/channels/email`, "DELETE"],
      [`${ADMIN}/channels/webhook/test`, "POST"],
      [OF_ORG, "GET"],
      [`${OF_ORG}/channels/telegram`, "PUT"],
      [`${OF_ORG}/channels/email`, "DELETE"],
      [`${OF_ORG}/channels/webhook/test`, "POST"],
    ]);
    expect(fetchUpstream.mock.calls[1]![1].body).toEqual(body);
    expect(fetchUpstream.mock.calls[5]![1].body).toEqual(body);
    for (const [, o] of fetchUpstream.mock.calls) expect(o.accessToken).toBe("tok");
  });

  it("a save waits 20 s for the address to be looked up, a test 45 s, the rest the usual time", async () => {
    fetchUpstream.mockResolvedValue(ok({}));
    await adminPut(req("PUT"), admin("webhook"));
    await orgPut(req("PUT"), org("webhook"));
    await adminTest(req("POST"), admin("webhook"));
    await orgTest(req("POST"), org("webhook"));
    await adminGet(req("GET"));
    await orgDelete(req("DELETE"), org("webhook"));
    expect(fetchUpstream.mock.calls.map(([, o]) => o.timeoutMs)).toEqual([20_000, 20_000, 45_000, 45_000, undefined, undefined]);
  });

  it("a path part that is not a plain name is refused before anything is forwarded", async () => {
    const answers = await Promise.all([
      adminPut(req("PUT"), admin("web.hook")),
      adminDelete(req("DELETE"), admin("../email")),
      adminTest(req("POST"), admin("a/b")),
      orgGet(req("GET"), { params: Promise.resolve({ orgId: "org.1" }) }),
      orgPut(req("PUT"), org("webhook", "..")),
      orgDelete(req("DELETE"), org("web hook")),
      orgTest(req("POST"), org("webhook", "a/b")),
    ]);
    expect(answers.map((r) => r.status)).toEqual([400, 400, 400, 400, 400, 400, 400]);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("the settings come back whole: none of their keys is one the BFF blanks", async () => {
    expect(findForbiddenPublicDtoKeys({ data: settings() })).toEqual([]);
    fetchUpstream.mockResolvedValue(ok(settings()));
    const res = await adminGet(req("GET"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: settings() });
  });

  it("the API's refusals pass through with their status", async () => {
    fetchUpstream.mockResolvedValue(fail(429, "RATE_LIMITED"));
    expect((await orgTest(req("POST"), org("email"))).status).toBe(429);
    fetchUpstream.mockResolvedValue(fail(404, "NOT_FOUND"));
    expect((await orgGet(req("GET"), { params: Promise.resolve({ orgId: ORG }) })).status).toBe(404);
    fetchUpstream.mockResolvedValue(fail(401, "UNAUTHENTICATED"));
    expect((await adminGet(req("GET"))).status).toBe(401);
  });
});

describe("what the form sends", () => {
  const all = NOTIFICATION_GROUPS_OF_AUDIENCE.server;

  it("the server's email carries the typed addresses, a customer's none; the groups keep the scope's order", () => {
    const typed = values({ groups: ["server", "availability"], recipients: " ops@example.org\nsecond@example.org ; third@example.org,\n" });
    expect(notificationChannelInput("email", "server", all, typed)).toEqual({
      enabled: true,
      groups: ["availability", "server"],
      recipients: ["ops@example.org", "second@example.org", "third@example.org"],
    });
    expect(notificationChannelInput("email", "customer", NOTIFICATION_GROUPS_OF_AUDIENCE.customer, typed)).toEqual({
      enabled: true,
      groups: ["availability"],
    });
  });

  it("a secret field left empty is left out, so the API keeps what it has", () => {
    expect(notificationChannelInput("webhook", "server", all, values({ enabled: false }))).toEqual({ enabled: false, groups: ["availability"] });
    expect(notificationChannelInput("telegram", "server", all, values({ chat: " @ops_alerts " }))).toEqual({
      enabled: true,
      groups: ["availability"],
      chat: "@ops_alerts",
    });
    expect(
      notificationChannelInput("webhook", "customer", all, values({ url: " https://hooks.example.org/a?k=1 ", signingKey: SIGNING_KEY })),
    ).toEqual({ enabled: true, groups: ["availability"], url: "https://hooks.example.org/a?k=1", signingKey: SIGNING_KEY });
    expect(notificationChannelInput("telegram", "customer", all, values({ chat: "-100123", botToken: ` ${BOT_TOKEN} ` }))).toEqual({
      enabled: true,
      groups: ["availability"],
      chat: "-100123",
      botToken: BOT_TOKEN,
    });
  });

  it("removing the signing key wins over a key typed in the same form", () => {
    expect(notificationChannelInput("webhook", "server", all, values({ dropKey: true, signingKey: SIGNING_KEY }))).toEqual({
      enabled: true,
      groups: ["availability"],
      signingKey: null,
    });
  });

  it("the first save of a webhook needs its address and of Telegram its bot token; a later one does not", () => {
    const hook = notificationChannelInput("webhook", "server", all, values());
    expect(notificationInputErrors("webhook", "server", true, hook)).toEqual({ fields: { url: "address_required" }, other: false });
    expect(notificationInputErrors("webhook", "server", false, hook)).toEqual({ fields: {}, other: false });
    const bot = notificationChannelInput("telegram", "server", all, values({ chat: "-100123" }));
    expect(notificationInputErrors("telegram", "server", true, bot)).toEqual({ fields: { botToken: "bot_token_required" }, other: false });
    expect(notificationInputErrors("telegram", "server", false, bot)).toEqual({ fields: {}, other: false });
  });

  it("a value of the wrong form is told on its own field, before any call", () => {
    const errorsOf = (kind: "email" | "webhook" | "telegram", v: Partial<NotificationFormValues>, audience: "server" | "customer" = "server") =>
      notificationInputErrors(kind, audience, false, notificationChannelInput(kind, audience, all, values(v)));
    expect(errorsOf("email", { recipients: "ops@example.org" })).toEqual({ fields: {}, other: false });
    expect(errorsOf("email", {}, "customer")).toEqual({ fields: {}, other: false });
    expect(errorsOf("email", { recipients: "" }).fields).toEqual({ recipients: "recipients" });
    expect(errorsOf("email", { recipients: "not an address" }).fields).toEqual({ recipients: "recipients" });
    expect(errorsOf("email", { recipients: "a@example.org a@example.org" }).fields).toEqual({ recipients: "recipients" });
    expect(errorsOf("email", { recipients: [1, 2, 3, 4, 5, 6].map((n) => `u${n}@example.org`).join("\n") }).fields).toEqual({ recipients: "recipients" });
    expect(errorsOf("email", { groups: [], recipients: "ops@example.org" }).fields).toEqual({ groups: "groups" });
    expect(errorsOf("webhook", { url: "http://hooks.example.org/a" }).fields).toEqual({ url: "url" });
    expect(errorsOf("webhook", { url: "https://user:pw@hooks.example.org/a" }).fields).toEqual({ url: "url" });
    expect(errorsOf("webhook", { signingKey: "short" }).fields).toEqual({ signingKey: "signingKey" });
    expect(errorsOf("webhook", { url: "https://hooks.example.org/a", signingKey: SIGNING_KEY })).toEqual({ fields: {}, other: false });
    expect(errorsOf("telegram", { chat: "my chat" }).fields).toEqual({ chat: "chat" });
    expect(errorsOf("telegram", { chat: "@ops_alerts", botToken: "123:abc" }).fields).toEqual({ botToken: "botToken" });
    expect(errorsOf("telegram", { chat: "@ops_alerts", botToken: BOT_TOKEN })).toEqual({ fields: {}, other: false });
  });

  it("a body wrong in a way no field explains is told as such", () => {
    expect(notificationInputErrors("email", "customer", false, { enabled: true, groups: ["availability"], recipients: [] })).toEqual({
      fields: {},
      other: true,
    });
  });

  it("every word the check or the API can give has a text, in both languages", () => {
    const fromApi = ["address_required", "address_not_allowed", "address_unreachable", "bot_token_required", "group_not_available"];
    for (const m of [en, itMsgs]) {
      for (const key of [...NOTIFICATION_FIELDS, ...fromApi]) expect(Object.keys(m.notifications.field), key).toContain(key);
    }
  });
});

describe("notification settings", () => {
  it("shows what is saved of each channel and never a stored secret", () => {
    for (const m of [en, itMsgs]) {
      const t = m.notifications;
      const h = html(m, createElement(NotificationSettings, { csrfToken: "c", initial: settings(), base: "/api/admin/notifications" }));
      for (const text of [
        "ops@example.org\nsecond@example.org",
        format(t.webhook.urlStored, { host: "hooks.example.org" }),
        format(t.webhook.keyIs, { state: t.webhook.keySet }),
        t.webhook.keyKeep,
        t.webhook.dropKey,
        format(t.telegram.tokenIs, { state: t.telegram.tokenSet }),
        t.telegram.tokenKeep,
        'value="-1001234500000"',
        t.state.on,
        t.state.off,
        t.group.server.server,
      ]) {
        expect(h, text).toContain(text);
      }
      expect(h).not.toMatch(/type="password"[^>]*value="[^"]/);
      expect(h).toMatch(/type="url"[^>]*value=""/);
      expect(count(h, `>${t.test}<`)).toBe(3);
      expect(count(h, `>${t.remove}<`)).toBe(3);
      expect(count(h, 'type="checkbox"')).toBe(4 * 3 + 3 + 1); // the groups and the switch of each channel, and "remove the key"
      expect(count(h, 'checked=""')).toBe(2 + 1 + 1 + 0 + 1 + 1); // email: two groups, on; webhook: one group, off; Telegram: one group, on
    }
  });

  it("lists the latest messages with what they told, to whom and how they ended", () => {
    for (const m of [en, itMsgs]) {
      const t = m.notifications;
      const h = html(m, createElement(NotificationSettings, { csrfToken: "c", initial: settings(), base: "/api/admin/notifications" }));
      const rows = h.slice(h.indexOf("<tbody>"), h.indexOf("</tbody>")).split("<tr").slice(1);
      expect(rows).toHaveLength(3);
      for (const text of [t.webhook.title, format(t.deliveries.events, { opened: 2, closed: 1 }), "hooks.example.org", t.deliveries.status.failed, t.problem.server_error, format(t.httpStatus, { status: 502 })]) {
        expect(rows[0], text).toContain(text);
      }
      for (const text of [t.email.title, t.deliveries.test, "ops@example.org", t.deliveries.status.sent]) expect(rows[1], text).toContain(text);
      expect(rows[1]).not.toContain(format(t.deliveries.attempts, { count: 1 }));
      for (const text of [t.telegram.title, "-1001234500000", t.deliveries.status.pending, t.problem.unreachable, format(t.deliveries.attempts, { count: 2 })]) {
        expect(rows[2], text).toContain(text);
      }
    }
  });

  it("a customer types no address for the mail, sees only their own kinds of alert and is told when mail does not leave", () => {
    for (const m of [en, itMsgs]) {
      const t = m.notifications;
      const h = html(m, createElement(NotificationSettings, { csrfToken: "c", initial: ofCustomer({ mailReady: false }), base: "/x" }));
      expect(h).not.toContain("<textarea");
      expect(h).toContain(t.email.intro.customer);
      expect(h).toContain(t.mailNotReady.customer);
      expect(h).toContain(t.group.customer.certificates);
      expect(h).not.toContain(t.group.server.server);
      expect(count(h, 'type="checkbox"')).toBe(3 * 3 + 3);
      expect(count(h, `>${t.state.none}<`)).toBe(2);
      expect(count(h, `>${t.test}<`)).toBe(1);
      expect(h).toContain(format(t.webhook.keyIs, { state: t.webhook.keyNotSet }));
      expect(h).toContain(format(t.telegram.tokenIs, { state: t.telegram.tokenNotSet }));
      expect(h).not.toContain(t.webhook.dropKey);
      expect(h).toContain(t.deliveries.empty);
      expect(html(m, createElement(NotificationSettings, { csrfToken: "c", initial: ofCustomer(), base: "/x" }))).not.toContain(t.mailNotReady.customer);
    }
  });

  it("with nothing saved every kind of alert is ticked and there is nothing to test or remove", () => {
    const t = en.notifications;
    const h = html(en, createElement(NotificationSettings, { csrfToken: "c", initial: settings({ channels: { email: null, webhook: null, telegram: null }, deliveries: [] }), base: "/x" }));
    expect(count(h, `>${t.state.none}<`)).toBe(3);
    expect(count(h, 'checked=""')).toBe(4 * 3 + 3);
    expect(h).not.toContain(`>${t.test}<`);
    expect(h).not.toContain(`>${t.remove}<`);
    expect(h).not.toContain(t.testHint);
  });
});

describe("notification pages", () => {
  it("the administrator's page reads the server's settings and says when it cannot", async () => {
    session.activeConsole = "admin";
    session.user = { name: "Root", isServerAdmin: true, mustChangePassword: false };
    answer({ [ADMIN]: ok(settings()) });
    const h = html(en, await AdminNotificationsPage());
    expect(reads()).toEqual([ADMIN]);
    for (const text of [en.notifications.title, en.admin.notifications.intro, "hooks.example.org"]) expect(h).toContain(text);

    answer({ [ADMIN]: fail(500, "INTERNAL_ERROR") });
    const broken = html(en, await AdminNotificationsPage());
    expect(broken).toContain(en.errors.generic);
    expect(broken).not.toContain(en.notifications.deliveries.title);
  });

  it("the customer's page reads the settings of the customer's own account", async () => {
    answer({ "v1/me": ok({ memberships: [{ organizationId: ORG }] }), [OF_ORG]: ok(ofCustomer()) });
    const h = html(en, await AccountNotificationsPage());
    expect(reads()).toEqual(["v1/me", OF_ORG]);
    for (const text of [en.notifications.intro, en.notifications.back, 'href="/account"', en.notifications.email.intro.customer]) {
      expect(h, text).toContain(text);
    }
    expect(h).not.toContain(en.admin.notifications.intro);
  });

  it("a member who is not an owner is told who can set the notifications, not shown an error", async () => {
    answer({ "v1/me": ok({ memberships: [{ organizationId: ORG }] }), [OF_ORG]: fail(403, "PERMISSION_DENIED") });
    const h = html(en, await AccountNotificationsPage());
    expect(h).toContain(en.notifications.notAllowed);
    expect(h).not.toContain(en.shell.loadErrorBody);
    expect(h).not.toContain(en.notifications.deliveries.title);
  });

  it("a read that fails, or an account without a customer, shows the load error", async () => {
    answer({ "v1/me": ok({ memberships: [{ organizationId: ORG }] }), [OF_ORG]: fail(500, "INTERNAL_ERROR") });
    expect(html(en, await AccountNotificationsPage())).toContain(en.shell.loadErrorBody);
    fetchUpstream.mockClear();
    answer({ "v1/me": ok({ memberships: [] }) });
    const h = html(en, await AccountNotificationsPage());
    expect(h).toContain(en.shell.loadErrorBody);
    expect(h).not.toContain(en.notifications.notAllowed);
    expect(reads()).toEqual(["v1/me"]);
  });

  it("a server administrator is sent to the server's page, a temporary password to its change first", async () => {
    session.user = { name: "Root", isServerAdmin: true, mustChangePassword: false };
    await expect(AccountNotificationsPage()).rejects.toThrow("REDIRECT /admin/notifications");
    session.user = { name: "Someone", isServerAdmin: false, mustChangePassword: false };
    session.activeConsole = "admin";
    await expect(AccountNotificationsPage()).rejects.toThrow("REDIRECT /admin/notifications");
    session.activeConsole = "customer";
    session.user = { name: "Someone", isServerAdmin: false, mustChangePassword: true };
    await expect(AccountNotificationsPage()).rejects.toThrow("REDIRECT /account/change-password");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });
});

describe("where the pages are linked", () => {
  it("the administrator's menu lists the notifications right after the mail", () => {
    for (const m of [en, itMsgs]) {
      const h = html(m, createElement(SidebarNav));
      expect(h).toContain('href="/admin/notifications"');
      expect(h).toContain(m.admin.nav.notifications);
      const hrefs = [...h.matchAll(/href="(\/admin[^"]*)"/g)].map((x) => x[1]);
      expect(hrefs.indexOf("/admin/notifications")).toBe(hrefs.indexOf("/admin/mail") + 1);
    }
  });

  it("the customer's account menu lists them after the account", () => {
    for (const m of [en, itMsgs]) {
      const h = html(m, createElement(CustomerTopBar, { userName: "Someone", csrfToken: "csrf" }));
      const menu = h.slice(h.lastIndexOf("data-menu"));
      const link = menu.match(/<a[^>]*href="\/account\/notifications"[^>]*>.*?<\/a>/)?.[0];
      expect(link).toContain(m.shell.notifications);
      expect(menu.indexOf('href="/account"')).toBeGreaterThan(-1);
      expect(menu.indexOf('href="/account/notifications"')).toBeGreaterThan(menu.indexOf('href="/account"'));
    }
  });
});

describe("notification copy", () => {
  it("every channel, group, outcome and problem of the contract has its own text in both languages", () => {
    for (const m of [en, itMsgs]) {
      const t = m.notifications;
      for (const kind of NOTIFICATION_CHANNEL_KINDS) expect(t[kind].title, kind).toBeTruthy();
      expect(Object.keys(t.group.server)).toEqual([...NOTIFICATION_GROUPS_OF_AUDIENCE.server]);
      expect(Object.keys(t.group.customer)).toEqual([...NOTIFICATION_GROUPS_OF_AUDIENCE.customer]);
      expect(Object.keys(t.deliveries.status)).toEqual([...NOTIFICATION_DELIVERY_STATUSES]);
      expect(Object.keys(t.problem)).toEqual([...NOTIFICATION_PROBLEMS]);
      expect(new Set(Object.values(t.problem)).size).toBe(NOTIFICATION_PROBLEMS.length);
      expect(new Set(Object.values(t.field)).size).toBe(Object.keys(t.field).length);
    }
    for (const key of NOTIFICATION_PROBLEMS) expect(en.notifications.problem[key], key).not.toBe(itMsgs.notifications.problem[key]);
  });

  it("the test's own refusals do not borrow the texts of another page", () => {
    for (const m of [en, itMsgs]) {
      expect(m.notifications.testTooSoon).not.toBe(errorMessage(m, "RATE_LIMITED"));
      expect(m.notifications.testNoRecipient).not.toBe(errorMessage(m, "NOT_SUPPORTED"));
    }
  });
});
