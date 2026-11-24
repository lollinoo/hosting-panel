import { randomUUID } from "node:crypto";
import {
  NotificationSettingsDtoSchema,
  NotificationWebhookBodySchema,
  notificationEventFromAlert,
  type AdminAlertDto,
  type NotificationEvent,
} from "@hosting-panel/contracts";
import {
  auditEvents,
  createDatabaseClient,
  createNotificationDelivery,
  eq,
  hostAllocations,
  membershipRoles,
  memberships,
  notificationChannelAlerts,
  notificationChannels,
  notificationDeliveries,
  observedStates,
  operations,
  organizations,
  platformInstallations,
  recordObservedStateReconciliationTransactional,
  serviceInstances,
  sites,
  upsertHostAgentHeartbeat,
  users,
  hosts,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { AdminHealthService, type AlertObservation } from "../src/health/admin-health.service.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { NOTIFICATION_SIGNATURE_HEADER, notificationSignature } from "../src/notifications/notification-sender.service.js";
import {
  createOutboundHttp,
  recordedServerAddresses,
  type OutboundHttpPort,
  type OutboundProblem,
  type OutboundResult,
} from "../src/notifications/outbound-http.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 9);
const PW = "sentinel-password-0001";
const SETUP = { installationName: "Notify Test", hostHostname: "panel.example.test", hostIpv4: "10.0.0.1" };
const RELAY = { host: "smtp.example.test", port: 587, username: "relay", password: "sentinel-relay-pass", senderDomain: "mail.example.test" };
const MIN = 60_000;
const T0 = new Date("2026-11-23T10:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);
const ADMIN_HOOK = "https://hooks.example.test/in/SENTINELPATH?k=SENTINELQUERY";
const CUSTOMER_HOOK = "https://customer-hooks.example.test/in/CUSTOMERPATH";
const OTHER_HOOK = "https://other-hooks.example.test/in/OTHERPATH";
const SIGNING_KEY = "sentinel-signing-key-0001";
const BOT_TOKEN = `123456789:${"A".repeat(35)}`;
const TELEGRAM_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
const CHAT = "-1001234567890";
const SERVER_GROUPS = ["availability", "backups", "certificates", "server"];
const CUSTOMER_GROUPS = ["availability", "backups", "certificates"];
const ADMIN_BASE = "/v1/admin/notifications";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Stands in for the calls to the outside: it keeps what it was asked to send and answers what the test says. */
class FakeOutbound implements OutboundHttpPort {
  public readonly calls: Array<{ url: string; raw: string; body: Json; headers: Record<string, string> }> = [];
  public readonly refused = new Map<string, OutboundProblem>();
  public answer: OutboundResult = { problem: null, httpStatus: 200 };
  /** Runs once, during the next send: what a person changes while a send takes its seconds. */
  public duringSend: ((url: string) => Promise<void>) | null = null;

  public async check(url: string): Promise<OutboundProblem | null> {
    return this.refused.get(url) ?? null;
  }

  public async postJson(url: string, raw: string, headers: Readonly<Record<string, string>> = {}): Promise<OutboundResult> {
    this.calls.push({ url, raw, body: JSON.parse(raw) as Json, headers: { ...headers } });
    const change = this.duringSend;
    this.duringSend = null;
    await change?.(url);
    return this.answer;
  }

  public to(url: string) {
    return this.calls.filter((c) => c.url === url);
  }
}

const disk = (usedPercent = 95): AdminAlertDto => ({
  kind: "disk_high", severity: "critical", subject: "root", since: null, details: { paths: ["root"], usedPercent },
});
const componentDown = (component: "sftp" | "phpmyadmin" = "sftp"): AdminAlertDto => ({
  kind: "component_down", severity: "critical", subject: component, since: null, details: { component, state: "down", reason: "stopped" },
});
const backupFailed = (siteId: string, siteName = `Site ${siteId}`): AdminAlertDto => ({
  kind: "backup_failed", severity: "warning", subject: siteId, since: null, details: { siteId, siteName, failedAt: T0.toISOString() },
});
const siteDown = (siteId: string, siteName: string): AdminAlertDto => ({
  kind: "site_container_down", severity: "critical", subject: siteId, since: null, details: { siteId, siteName, observed: "stopped" },
});
const manualCertificate = (severity: "warning" | "critical"): AdminAlertDto => ({
  kind: "manual_certificate_expiring", severity, subject: "cert_1", since: null,
  details: { siteId: null, siteName: null, certificateId: "cert_1", certificateName: "Wildcard", notAfter: at(60 * 24 * 5).toISOString(), tier: severity },
});

describe("notifications (ADR-0040)", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let outbound: FakeOutbound;
  let adminToken: string;
  let seen: { alerts: AdminAlertDto[]; unseen: Set<string> };
  let looks: number;
  /** Runs once inside the next look: what a person changes while a pass is under way. */
  let duringLook: (() => Promise<void>) | null;

  async function login(email: string, password: string, totpSecret?: string): Promise<string> {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}) }),
    });
    return ((await res.json()) as Json).data.accessToken as string;
  }

  async function call(method: string, path: string, as: string | null, body?: unknown): Promise<{ status: number; body: Json; raw: string }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { ...(as ? { Authorization: `Bearer ${as}` } : {}), "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  }

  /** `stub: false` keeps the real look at the alerts; otherwise a pass sees what `seen` holds. `real` builds the port. */
  async function start(opts: { stub?: boolean; real?: (db: DatabaseClient) => OutboundHttpPort } = {}): Promise<void> {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    sim = new InMemoryDockerSimulatorAdapter();
    outbound = new FakeOutbound();
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: sim,
      hostAgent: new InMemoryHostSimulatorAdapter(),
      notificationOutbound: opts.real ? opts.real(dbClient) : outbound,
      notificationsIntervalMs: null,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    adminToken = await login("admin@example.test", PW, admin.totpSecretBase32);
    seen = { alerts: [], unseen: new Set() };
    looks = 0;
    duringLook = null;
    if (opts.stub !== false) {
      vi.spyOn(app.nestApp.get(AdminHealthService), "observe").mockImplementation(async (): Promise<AlertObservation> => {
        looks += 1;
        const change = duringLook;
        duringLook = null;
        await change?.();
        return { alerts: [...seen.alerts], unseen: new Set(seen.unseen) };
      });
    }
  }

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await app.close();
    await dbClient.close();
  });

  async function createCustomer(name: string, email: string): Promise<{ orgId: string; token: string; base: string }> {
    const created = await call("POST", "/v1/admin/customer-account", adminToken, { organizationName: name, ownerEmail: email, ownerName: name });
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, email);
    const orgId = created.body.data.organizationId as string;
    return { orgId, token: await login(email, created.body.data.temporaryPassword as string), base: `/v1/organizations/${orgId}/notifications` };
  }

  /** The panel makes one customer per server; a second one is written by hand, with its owner. */
  async function secondCustomer(name: string, email: string): Promise<{ orgId: string; token: string; base: string }> {
    const [installation] = await dbClient.db.select({ id: platformInstallations.id }).from(platformInstallations);
    const orgId = `org_${randomUUID()}`;
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    await dbClient.db.insert(organizations).values({ id: orgId, platformInstallationId: installation!.id, name, slug: `org-${randomUUID().slice(0, 8)}` });
    await dbClient.db.insert(users).values({ id: userId, email, name, passwordHash: await hashPassword(PW) });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: orgId, userId });
    await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId, roleId: "role_customer_owner" });
    return { orgId, token: await login(email, PW), base: `/v1/organizations/${orgId}/notifications` };
  }

  async function createSite(ownerOrganizationId: string | null, name: string, domain: string): Promise<{ siteId: string; serviceId: string }> {
    const res = await call("POST", "/v1/admin/sites", adminToken, {
      name, domain, title: name, adminUser: "admin", adminEmail: "admin@example.test", adminPassword: "sentinel-Pass-123456", ownerOrganizationId,
    });
    expect(res.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const siteId = res.body.data.siteId as string;
    const [svc] = await dbClient.db.select({ id: serviceInstances.id }).from(serviceInstances).where(eq(serviceInstances.siteId, siteId));
    return { siteId, serviceId: svc!.id };
  }

  async function configureRelay(): Promise<void> {
    expect((await call("PATCH", "/v1/admin/mail-relay", adminToken, RELAY)).status).toBe(200);
    await app.mailRelay.ensureApplied();
  }

  const save = (base: string, token: string, channel: string, body: unknown) => call("PUT", `${base}/channels/${channel}`, token, body);
  async function adminWebhook(extra: Json = {}): Promise<void> {
    const res = await save(ADMIN_BASE, adminToken, "webhook", { enabled: true, groups: SERVER_GROUPS, url: ADMIN_HOOK, ...extra });
    expect(res.status).toBe(200);
  }
  const tick = (when: Date) => app.notifications.tick(when);
  const deliveries = () => dbClient.db.select().from(notificationDeliveries).orderBy(notificationDeliveries.createdAt, notificationDeliveries.id);
  const told = () => dbClient.db.select().from(notificationChannelAlerts);
  const audits = (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  const eventsOf = (c: { body: Json }) => (c.body["events"] as NotificationEvent[]).map((e) => [e.kind, e.state]);
  const notificationMails = () => sim.notificationMails;

  describe("the pass", () => {
    it("with no channel on it reads the channels and stops there", async () => {
      await start();
      seen.alerts = [disk()];
      await tick(at(0));
      await tick(at(2));
      expect(looks).toBe(0);
      // A channel that is saved but off changes nothing.
      await adminWebhook({ enabled: false });
      await tick(at(4));
      await tick(at(6));
      expect(looks).toBe(0);
      expect(outbound.calls).toEqual([]);
      expect(await told()).toEqual([]);
      expect(await deliveries()).toEqual([]);
    });

    it("tells an alert at the second pass that sees it, once, and its end at the first pass that no longer sees it", async () => {
      await start();
      await adminWebhook();
      seen.alerts = [disk()];
      await tick(at(0));
      expect(outbound.calls).toEqual([]);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(at(2));
      await tick(at(2));
      expect(outbound.calls).toHaveLength(1);
      const opened = NotificationWebhookBodySchema.parse(outbound.calls[0]!.body);
      expect(opened).toMatchObject({ version: 1, audience: "server", test: false, omitted: 0, sentAt: at(2).toISOString() });
      expect(opened.events).toHaveLength(1);
      expect(opened.events[0]).toMatchObject({ kind: "disk_high", state: "opened", severity: "critical", percent: 95 });
      expect(opened.text).toContain("https://panel.example.test/admin/health");
      expect(outbound.calls[0]!.url).toBe(ADMIN_HOOK);
      expect(outbound.calls[0]!.headers).toEqual({});

      await tick(at(4));
      expect(outbound.calls).toHaveLength(1);

      seen.alerts = [];
      await tick(at(6));
      expect(outbound.calls).toHaveLength(2);
      const closed = NotificationWebhookBodySchema.parse(outbound.calls[1]!.body);
      expect(closed.events.map((e) => [e.kind, e.state, e.id])).toEqual([["disk_high", "closed", opened.events[0]!.id]]);
      expect(closed.id).not.toBe(opened.id);
      await tick(at(8));
      expect(outbound.calls).toHaveLength(2);

      expect((await deliveries()).map((d) => [d.id, d.status, d.openedCount, d.closedCount, d.attempts, d.test])).toEqual([
        [opened.id, "sent", 1, 0, 1, false],
        [closed.id, "sent", 0, 1, 1, false],
      ]);
      expect(await told()).toEqual([]);
    });

    it("says nothing of an alert that opens and closes between two passes", async () => {
      await start();
      await adminWebhook();
      seen.alerts = [disk()];
      await tick(at(0));
      expect(await told()).toHaveLength(1);
      seen.alerts = [];
      await tick(at(2));
      await tick(at(4));
      expect(outbound.calls).toEqual([]);
      expect(await told()).toEqual([]);
      expect(await deliveries()).toEqual([]);
    });

    it("puts the alerts that open together in one message, and counts the ones beyond fifty", async () => {
      await start();
      await adminWebhook();
      seen.alerts = Array.from({ length: 60 }, (_, i) => backupFailed(`site_${String(i).padStart(2, "0")}`));
      await tick(at(0));
      await tick(at(2));
      expect(outbound.calls).toHaveLength(1);
      const body = NotificationWebhookBodySchema.parse(outbound.calls[0]!.body);
      expect(body.events).toHaveLength(50);
      expect(body.omitted).toBe(10);
      // The row counts every one of them, also the ones the message does not carry.
      expect((await deliveries()).map((d) => [d.openedCount + d.closedCount, d.omitted])).toEqual([[50, 10]]);

      seen.alerts = [disk()];
      await tick(at(4));
      await tick(at(6));
      // The sixty ends are one message, the new alert waits its second pass and is another.
      expect(outbound.calls).toHaveLength(3);
      expect(new Set(eventsOf(outbound.calls[1]!).map(([, state]) => state))).toEqual(new Set(["closed"]));
      expect(outbound.calls[1]!.body["omitted"]).toBe(10);
      expect(eventsOf(outbound.calls[2]!)).toEqual([["disk_high", "opened"]]);
    });

    it("neither closes nor forgets what the look could not see", async () => {
      await start();
      await adminWebhook();
      seen.alerts = [componentDown("sftp"), disk()];
      await tick(at(0));
      await tick(at(2));
      expect(outbound.calls).toHaveLength(1);

      // The executor does not answer: one subject of a kind, and a whole kind.
      seen.alerts = [];
      seen.unseen = new Set(["component_down:sftp", "disk_high"]);
      await tick(at(4));
      await tick(at(6));
      expect(outbound.calls).toHaveLength(1);
      expect((await told()).map((r) => r.alertKey).sort()).toEqual(["component_down:sftp", "disk_high:root"]);

      // It answers again, and both are over.
      seen.unseen = new Set();
      await tick(at(8));
      expect(outbound.calls).toHaveLength(2);
      expect(eventsOf(outbound.calls[1]!).sort()).toEqual([["component_down", "closed"], ["disk_high", "closed"]]);
    });

    it("keeps everything as it is when the look itself fails, and still sends what waits", async () => {
      await start();
      await adminWebhook();
      seen.alerts = [disk()];
      await tick(at(0));
      outbound.answer = { problem: "server_error", httpStatus: 502 };
      await tick(at(2));
      expect(outbound.calls).toHaveLength(1);
      vi.spyOn(app.nestApp.get(AdminHealthService), "observe").mockRejectedValue(new Error("database is away"));
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      outbound.answer = { problem: null, httpStatus: 204 };
      await tick(at(4));
      expect(outbound.calls).toHaveLength(2);
      expect((await deliveries()).map((d) => [d.status, d.attempts, d.httpStatus])).toEqual([["sent", 2, 204]]);
      expect((await told()).map((r) => [r.alertKey, r.announcedAt !== null])).toEqual([["disk_high:root", true]]);
    });

    it("tells again a warning that becomes critical, and not one that goes back down", async () => {
      await start();
      await adminWebhook();
      seen.alerts = [manualCertificate("warning")];
      await tick(at(0));
      await tick(at(2));
      seen.alerts = [manualCertificate("critical")];
      await tick(at(4));
      seen.alerts = [manualCertificate("warning")];
      await tick(at(6));
      seen.alerts = [manualCertificate("critical")];
      await tick(at(8));
      expect(outbound.calls.map((c) => (c.body["events"] as NotificationEvent[]).map((e) => [e.state, e.severity]))).toEqual([
        [["opened", "warning"]],
        [["opened", "critical"]],
        [["opened", "critical"]],
      ]);
    });

    it("tells a customer's channel only of that customer's sites, and only the kinds a customer hears", async () => {
      await start();
      const mario = await createCustomer("Hotel Mario", "mario@hotel.example.test");
      const anna = await secondCustomer("Studio Anna", "anna@studio.example.test");
      const mine = await createSite(mario.orgId, "Sito Mario", "mario.example.test");
      // A site of the other customer: made by the administrator, then handed over row by row.
      const theirs = await createSite(null, "Sito Anna", "anna.example.test");
      const [host] = await dbClient.db.select({ id: hosts.id }).from(hosts);
      const allocationId = `alloc_${randomUUID()}`;
      await dbClient.db.insert(hostAllocations).values({ id: allocationId, hostId: host!.id, organizationId: anna.orgId, status: "active", hostingMode: "dedicated", dedicatedScope: true });
      await dbClient.db.update(sites).set({ organizationId: anna.orgId, hostAllocationId: allocationId }).where(eq(sites.id, theirs.siteId));
      await adminWebhook();
      expect((await save(mario.base, mario.token, "webhook", { enabled: true, groups: CUSTOMER_GROUPS, url: CUSTOMER_HOOK })).status).toBe(200);
      expect((await save(anna.base, anna.token, "webhook", { enabled: true, groups: ["availability"], url: OTHER_HOOK })).status).toBe(200);

      seen.alerts = [
        siteDown(mine.siteId, "Sito Mario"),
        siteDown(theirs.siteId, "Sito Anna"),
        backupFailed(mine.siteId, "Sito Mario"),
        backupFailed(theirs.siteId, "Sito Anna"),
        // Kinds for the administrator only, also when they name the customer's own site.
        { kind: "backup_site_without_target", severity: "warning", subject: mine.siteId, since: null, details: { siteId: mine.siteId, siteName: "Sito Mario" } } as AdminAlertDto,
        disk(),
        // A certificate that is of no site is of no customer.
        manualCertificate("warning"),
      ];
      await tick(at(0));
      await tick(at(2));

      const customer = outbound.to(CUSTOMER_HOOK);
      expect(customer).toHaveLength(1);
      const body = NotificationWebhookBodySchema.parse(customer[0]!.body);
      expect(body.audience).toBe("customer");
      expect(body.events.map((e) => [e.kind, e.site]).sort()).toEqual([["backup_failed", "Sito Mario"], ["site_container_down", "Sito Mario"]]);
      expect(customer[0]!.raw).not.toContain("Sito Anna");
      expect(customer[0]!.raw).not.toContain(theirs.siteId);
      expect(body.text).toContain("https://panel.example.test/sites");
      expect(body.text).not.toContain("/admin");

      // The other customer hears of their own site, and only in the group they turned on.
      const other = outbound.to(OTHER_HOOK);
      expect(other).toHaveLength(1);
      expect((other[0]!.body["events"] as NotificationEvent[]).map((e) => [e.kind, e.site])).toEqual([["site_container_down", "Sito Anna"]]);
      expect(other[0]!.raw).not.toContain("Sito Mario");

      const server = outbound.to(ADMIN_HOOK);
      expect(server).toHaveLength(1);
      expect(NotificationWebhookBodySchema.parse(server[0]!.body).events).toHaveLength(7);
    });

    it("forgets without a word the alerts of a group that is turned off", async () => {
      await start();
      await adminWebhook({ groups: ["server", "backups"] });
      seen.alerts = [disk(), backupFailed("site_a")];
      await tick(at(0));
      await tick(at(2));
      expect(outbound.calls).toHaveLength(1);
      await adminWebhook({ groups: ["server"] });
      await tick(at(4));
      expect(outbound.calls).toHaveLength(1);
      expect((await told()).map((r) => r.alertKey)).toEqual(["disk_high:root"]);
      // Turned on again while the alert is open: it is new to the channel.
      await adminWebhook({ groups: ["server", "backups"] });
      await tick(at(6));
      await tick(at(8));
      expect(outbound.calls).toHaveLength(2);
      expect(eventsOf(outbound.calls[1]!)).toEqual([["backup_failed", "opened"]]);
    });

    it("turning a channel off forgets what it was told and cancels what waits; turned on again, the open alerts are new", async () => {
      await start();
      await adminWebhook();
      seen.alerts = [disk()];
      outbound.answer = { problem: "server_error", httpStatus: 500 };
      await tick(at(0));
      await tick(at(2));
      expect((await deliveries()).map((d) => d.status)).toEqual(["pending"]);

      await adminWebhook({ enabled: false });
      expect(await told()).toEqual([]);
      expect((await deliveries()).map((d) => [d.status, d.problem, d.nextAttemptAt])).toEqual([["failed", "channel_changed", null]]);
      outbound.answer = { problem: null, httpStatus: 200 };
      await tick(at(4));
      expect(outbound.calls).toHaveLength(1);

      await adminWebhook();
      await tick(at(6));
      await tick(at(8));
      expect(outbound.calls).toHaveLength(2);
      expect(eventsOf(outbound.calls[1]!)).toEqual([["disk_high", "opened"]]);
    });

    it("a group turned off while a pass looks at the alerts is not told by that pass", async () => {
      await start();
      await adminWebhook({ groups: ["server", "backups"] });
      seen.alerts = [backupFailed("site_a")];
      await tick(at(0));
      duringLook = () => adminWebhook({ groups: ["server"] });
      await tick(at(2));
      expect(outbound.calls).toEqual([]);
      expect(await deliveries()).toEqual([]);
      expect(await told()).toEqual([]);
    });

    it("a channel turned off while a pass looks keeps nothing from that pass; turned on again, the open alerts are new", async () => {
      await start();
      await adminWebhook();
      seen.alerts = [disk()];
      await tick(at(0));
      await tick(at(2));
      expect(outbound.calls).toHaveLength(1);
      duringLook = () => adminWebhook({ enabled: false });
      await tick(at(4));
      expect(await told()).toEqual([]);
      expect((await deliveries()).map((d) => d.status)).toEqual(["sent"]);

      await adminWebhook();
      await tick(at(6));
      expect(outbound.calls).toHaveLength(1);
      await tick(at(8));
      expect(outbound.calls).toHaveLength(2);
      expect(eventsOf(outbound.calls[1]!)).toEqual([["disk_high", "opened"]]);
    });

    it("a channel removed while a pass looks is skipped, and the other channels are told and sent to by that pass", async () => {
      await start();
      await adminWebhook();
      expect((await save(ADMIN_BASE, adminToken, "telegram", { enabled: true, groups: SERVER_GROUPS, botToken: BOT_TOKEN, chat: CHAT })).status).toBe(200);
      seen.alerts = [disk()];
      await tick(at(0));
      duringLook = async () => {
        expect((await call("DELETE", `${ADMIN_BASE}/channels/webhook`, adminToken)).status).toBe(200);
      };
      await tick(at(2));
      expect(outbound.calls.map((c) => c.url)).toEqual([TELEGRAM_URL]);
      expect(outbound.calls[0]!.body["text"]).toContain("95");
      expect((await told()).map((r) => r.alertKey)).toEqual(["disk_high:root"]);
    });

    it("a channel whose comparison fails does not cost the other channels their pass, and is told at the next one", async () => {
      await start();
      await adminWebhook();
      expect((await save(ADMIN_BASE, adminToken, "telegram", { enabled: true, groups: SERVER_GROUPS, botToken: BOT_TOKEN, chat: CHAT })).status).toBe(200);
      seen.alerts = [disk()];
      await tick(at(0));
      // The comparison of the first channel of the pass fails; which one it is depends on the ids.
      vi.spyOn(dbClient.db, "transaction").mockRejectedValueOnce(new Error("connection lost"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await tick(at(2));
      expect(outbound.calls).toHaveLength(1);
      // Only that it happened: nothing of the channel or of the error.
      expect(warn.mock.calls).toEqual([[JSON.stringify({ event: "notification_channel_failed" })]]);
      await tick(at(4));
      expect(outbound.calls.map((c) => c.url).sort()).toEqual([ADMIN_HOOK, TELEGRAM_URL].sort());
      expect(eventsOf(outbound.to(ADMIN_HOOK)[0]!)).toEqual([["disk_high", "opened"]]);
      expect(outbound.to(TELEGRAM_URL)[0]!.body["text"]).toContain("95");
    });

    it("a channel turned off while an earlier message of the pass is being sent gets nothing from that pass", async () => {
      await start();
      await adminWebhook();
      expect((await save(ADMIN_BASE, adminToken, "telegram", { enabled: true, groups: SERVER_GROUPS, botToken: BOT_TOKEN, chat: CHAT })).status).toBe(200);
      seen.alerts = [disk()];
      await tick(at(0));
      // Which message goes first depends on the ids: the other channel is turned off while it goes.
      outbound.duringSend = async (url) => {
        const off = url === ADMIN_HOOK ? "telegram" : "webhook";
        const body = off === "webhook" ? { enabled: false, groups: SERVER_GROUPS } : { enabled: false, groups: SERVER_GROUPS, chat: CHAT };
        expect((await save(ADMIN_BASE, adminToken, off, body)).status).toBe(200);
      };
      await tick(at(2));
      expect(outbound.calls).toHaveLength(1);
      expect((await deliveries()).map((d) => [d.status, d.problem]).sort()).toEqual([["failed", "channel_changed"], ["sent", null]]);
    });

    it("a retry whose group was turned off meanwhile is not sent", async () => {
      await start();
      await adminWebhook({ groups: ["server", "backups"] });
      seen.alerts = [backupFailed("site_a")];
      outbound.answer = { problem: "server_error", httpStatus: 503 };
      await tick(at(0));
      await tick(at(2));
      expect((await deliveries()).map((d) => [d.status, d.nextAttemptAt?.toISOString() ?? null])).toEqual([["pending", at(4).toISOString()]]);
      await adminWebhook({ groups: ["server"] });
      outbound.answer = { problem: null, httpStatus: 200 };
      await tick(at(4));
      expect(outbound.calls).toHaveLength(1);
      expect((await deliveries()).map((d) => [d.status, d.attempts, d.problem])).toEqual([["failed", 1, "channel_changed"]]);
    });

    it("tries a message again after two, ten and thirty minutes, then it is not delivered", async () => {
      await start();
      await adminWebhook();
      seen.alerts = [disk()];
      outbound.answer = { problem: "server_error", httpStatus: 503 };
      await tick(at(0));
      await tick(at(2));
      const state = async () => (await deliveries()).map((d) => [d.status, d.attempts, d.problem, d.httpStatus, d.nextAttemptAt?.toISOString() ?? null]);
      expect(await state()).toEqual([["pending", 1, "server_error", 503, at(4).toISOString()]]);
      // Not due yet.
      await tick(at(3));
      expect(outbound.calls).toHaveLength(1);
      await tick(at(4));
      expect(await state()).toEqual([["pending", 2, "server_error", 503, at(12).toISOString()]]);
      await tick(at(12));
      outbound.answer = { problem: "rejected", httpStatus: 410 };
      expect(await state()).toEqual([["pending", 3, "server_error", 503, at(32).toISOString()]]);
      await tick(at(32));
      expect(await state()).toEqual([["failed", 4, "rejected", 410, null]]);
      expect(outbound.calls).toHaveLength(4);
      // The same message every time: who receives it recognises it by its id.
      expect(new Set(outbound.calls.map((c) => c.body["id"])).size).toBe(1);
      await tick(at(34));
      expect(outbound.calls).toHaveLength(4);

      const page = await call("GET", ADMIN_BASE, adminToken);
      expect(page.body.data.deliveries).toHaveLength(1);
      expect(page.body.data.deliveries[0]).toMatchObject({ channel: "webhook", status: "failed", problem: "rejected", httpStatus: 410, attempts: 4, test: false, opened: 1, closed: 0 });
    });

    it("a message that goes at a later try is sent, and one still waiting after an hour is not delivered", async () => {
      await start();
      await adminWebhook();
      seen.alerts = [disk()];
      outbound.answer = { problem: "unreachable", httpStatus: null };
      await tick(at(0));
      await tick(at(2));
      outbound.answer = { problem: null, httpStatus: 200 };
      await tick(at(4));
      expect((await deliveries()).map((d) => [d.status, d.attempts, d.problem])).toEqual([["sent", 2, null]]);

      // The panel was down for more than an hour with a message waiting.
      outbound.answer = { problem: "unreachable", httpStatus: null };
      seen.alerts = [];
      await tick(at(6));
      expect(outbound.calls).toHaveLength(3);
      outbound.answer = { problem: null, httpStatus: 200 };
      await tick(at(70));
      expect(outbound.calls).toHaveLength(3);
      expect((await deliveries()).map((d) => [d.status, d.problem])).toEqual([["sent", null], ["failed", "expired"]]);
    });

    it("sends no more than twenty messages in a pass", async () => {
      await start();
      await adminWebhook();
      const [channel] = await dbClient.db.select({ id: notificationChannels.id }).from(notificationChannels);
      const event = { ...(await import("@hosting-panel/contracts")).notificationEventFromAlert(disk(), "a".repeat(24), "opened") };
      for (let i = 0; i < 25; i += 1) {
        await createNotificationDelivery(dbClient.db, { channelId: channel!.id, events: [event], omitted: 0, test: false, recipient: null, locale: "it", now: at(0) });
      }
      await tick(at(1));
      expect(outbound.calls).toHaveLength(20);
      await tick(at(3));
      expect(outbound.calls).toHaveLength(25);
      expect(new Set((await deliveries()).map((d) => d.status))).toEqual(new Set(["sent"]));
    });

    it("signs each webhook message with the time it leaves, not the time its pass began", async () => {
      await start();
      await adminWebhook({ signingKey: SIGNING_KEY });
      const [channel] = await dbClient.db.select({ id: notificationChannels.id }).from(notificationChannels);
      const event = notificationEventFromAlert(disk(), "a".repeat(24), "opened");
      for (let i = 0; i < 2; i += 1) {
        await createNotificationDelivery(dbClient.db, { channelId: channel!.id, events: [event], omitted: 0, test: false, recipient: null, locale: "it", now: at(0) });
      }
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(at(1));
      // The first send of the pass takes ninety seconds.
      outbound.duringSend = async () => {
        vi.setSystemTime(at(1).getTime() + 90_000);
      };
      await tick(at(1));

      expect(outbound.calls).toHaveLength(2);
      const seconds = outbound.calls.map((c) => Number(/^t=(\d+),v1=[0-9a-f]{64}$/.exec(c.headers[NOTIFICATION_SIGNATURE_HEADER]!)![1]));
      expect(seconds).toEqual([at(1).getTime() / 1000, at(1).getTime() / 1000 + 90]);
      outbound.calls.forEach((c, i) => expect(c.headers[NOTIFICATION_SIGNATURE_HEADER]).toBe(notificationSignature(SIGNING_KEY, seconds[i]!, c.raw)));
      expect(outbound.calls.map((c) => c.body["sentAt"])).toEqual([at(1).toISOString(), new Date(at(1).getTime() + 90_000).toISOString()]);
    });

    it("mails every address of the server and every owner of the customer, each in their language", async () => {
      await start();
      await configureRelay();
      const mario = await createCustomer("Hotel Mario", "mario@hotel.example.test");
      const site = await createSite(mario.orgId, "Sito Mario", "mario.example.test");
      await dbClient.db.update(users).set({ locale: "en" }).where(eq(users.email, "mario@hotel.example.test"));
      expect((await save(ADMIN_BASE, adminToken, "email", { enabled: true, groups: SERVER_GROUPS, recipients: ["ops@example.test", "Second@Example.test"] })).status).toBe(200);
      expect((await save(mario.base, mario.token, "email", { enabled: true, groups: CUSTOMER_GROUPS })).status).toBe(200);
      seen.alerts = [siteDown(site.siteId, "Sito Mario")];
      await tick(at(0));
      await tick(at(2));

      const mails = notificationMails();
      expect(mails.map((m) => [m.to, m.locale, m.audience, m.link, m.test]).sort()).toEqual([
        ["mario@hotel.example.test", "en", "customer", "https://panel.example.test/sites", false],
        ["ops@example.test", "it", "server", "https://panel.example.test/admin/health", false],
        ["second@example.test", "it", "server", "https://panel.example.test/admin/health", false],
      ]);
      for (const mail of mails) expect(mail.events.map((e) => [e.kind, e.state, e.site])).toEqual([["site_container_down", "opened", "Sito Mario"]]);
      expect((await deliveries()).map((d) => [d.recipient, d.status]).sort()).toEqual([
        ["mario@hotel.example.test", "sent"], ["ops@example.test", "sent"], ["second@example.test", "sent"],
      ]);
      expect(outbound.calls).toEqual([]);
    });

    it("keeps a mail waiting while sending is not set up, and drops the one whose address was taken off the list", async () => {
      await start();
      expect((await save(ADMIN_BASE, adminToken, "email", { enabled: true, groups: SERVER_GROUPS, recipients: ["ops@example.test", "gone@example.test"] })).status).toBe(200);
      seen.alerts = [disk()];
      await tick(at(0));
      await tick(at(2));
      expect((await deliveries()).map((d) => [d.recipient, d.status, d.problem]).sort()).toEqual([
        ["gone@example.test", "pending", "mail_not_configured"], ["ops@example.test", "pending", "mail_not_configured"],
      ]);
      expect((await call("GET", ADMIN_BASE, adminToken)).body.data.mailReady).toBe(false);

      expect((await save(ADMIN_BASE, adminToken, "email", { enabled: true, groups: SERVER_GROUPS, recipients: ["ops@example.test"] })).status).toBe(200);
      await configureRelay();
      expect((await call("GET", ADMIN_BASE, adminToken)).body.data.mailReady).toBe(true);
      await tick(at(4));
      expect(notificationMails().map((m) => m.to)).toEqual(["ops@example.test"]);
      expect((await deliveries()).map((d) => [d.recipient, d.status, d.problem]).sort()).toEqual([
        ["gone@example.test", "failed", "channel_changed"], ["ops@example.test", "sent", null],
      ]);
    });

    it("with the real look: a full disk reaches the server's channel, a stopped site also its customer", async () => {
      await start({ stub: false });
      const mario = await createCustomer("Hotel Mario", "mario@hotel.example.test");
      const { siteId, serviceId } = await createSite(mario.orgId, "Sito Mario", "mario.example.test");
      await adminWebhook();
      expect((await save(mario.base, mario.token, "webhook", { enabled: true, groups: CUSTOMER_GROUPS, url: CUSTOMER_HOOK })).status).toBe(200);

      const [host] = await dbClient.db.select({ id: hosts.id }).from(hosts);
      await upsertHostAgentHeartbeat(dbClient.db, {
        hostId: host!.id, component: "host_agent", status: "online", version: "1",
        telemetrySnapshot: { disks: [{ paths: ["root"], usedBytes: "93", totalBytes: "100" }] },
      });
      const look = () => recordObservedStateReconciliationTransactional(dbClient.db, {
        serviceInstanceId: serviceId, observedStatus: "stopped", outOfBandModified: false, rawState: {}, observedAt: new Date(),
      });
      await look();
      await dbClient.db.update(observedStates)
        .set({ rawState: { notRunningSince: new Date(Date.now() - 6 * MIN).toISOString() } })
        .where(eq(observedStates.serviceInstanceId, serviceId));
      await look();

      await app.notifications.tick();
      expect(outbound.calls).toEqual([]);
      await app.notifications.tick();
      expect(eventsOf(outbound.to(ADMIN_HOOK)[0]!).sort()).toEqual([["disk_high", "opened"], ["site_container_down", "opened"]]);
      const customer = outbound.to(CUSTOMER_HOOK);
      expect(customer).toHaveLength(1);
      expect((customer[0]!.body["events"] as NotificationEvent[]).map((e) => [e.kind, e.state, e.site])).toEqual([["site_container_down", "opened", "Sito Mario"]]);
      expect(customer[0]!.raw).not.toContain(siteId);
    });

    it("with the real look: a stuck backup of an application reaches the server's channel by its operation, not the customer's", async () => {
      await start({ stub: false });
      const mario = await createCustomer("Hotel Mario", "mario@hotel.example.test");
      await adminWebhook();
      expect((await save(mario.base, mario.token, "webhook", { enabled: true, groups: CUSTOMER_GROUPS, url: CUSTOMER_HOOK })).status).toBe(200);
      // ADR-0038 adds no alert kind: an application's backup is an operation, told by the operation alerts.
      const past = new Date(Date.now() - 10 * MIN);
      await dbClient.db.insert(operations).values({
        id: `op_${randomUUID()}`, organizationId: mario.orgId, kind: "stack.backup", status: "processing",
        resourceType: "stack", resourceId: "stk_mario", leaseExpiresAt: past, startedAt: past, updatedAt: past,
      });

      await app.notifications.tick();
      await app.notifications.tick();
      const server = outbound.to(ADMIN_HOOK);
      expect(server).toHaveLength(1);
      const body = NotificationWebhookBodySchema.parse(server[0]!.body);
      expect(body.events.filter((e) => e.kind === "operation_stuck").map((e) => [e.state, e.operation, e.site])).toEqual([["opened", "stack.backup", null]]);
      expect(body.text).toContain("stack.backup");
      expect(outbound.to(CUSTOMER_HOOK)).toEqual([]);
    });
  });

  describe("the settings", () => {
    it("answers 401 without a session, 403 to a customer on the server's settings and 404 on another customer's, before it looks at the body", async () => {
      await start();
      const mario = await createCustomer("Hotel Mario", "mario@hotel.example.test");
      const anna = await secondCustomer("Studio Anna", "anna@studio.example.test");
      const routes: Array<[string, string]> = [["GET", ""], ["PUT", "/channels/webhook"], ["DELETE", "/channels/webhook"], ["POST", "/channels/webhook/test"]];
      for (const [method, tail] of routes) {
        const body = method === "PUT" ? "{not json" : undefined;
        expect([method, (await call(method, `${ADMIN_BASE}${tail}`, null, body)).status]).toEqual([method, 401]);
        expect([method, (await call(method, `${mario.base}${tail}`, null, body)).status]).toEqual([method, 401]);
        const asCustomer = await call(method, `${ADMIN_BASE}${tail}`, mario.token, body);
        expect([method, asCustomer.status, asCustomer.body.error?.code]).toEqual([method, 403, "PERMISSION_DENIED"]);
        const other = await call(method, `${anna.base}${tail}`, mario.token, body);
        expect([method, other.status, other.body.error?.code]).toEqual([method, 404, "NOT_FOUND"]);
      }
      // A channel that does not exist is a 404 for whoever may ask; a body that cannot be read is a 400.
      expect((await save(mario.base, mario.token, "sms", { enabled: true, groups: CUSTOMER_GROUPS })).status).toBe(404);
      expect((await call("POST", `${ADMIN_BASE}/channels/sms/test`, adminToken)).status).toBe(404);
      const unreadable = await call("PUT", `${mario.base}/channels/webhook`, mario.token, "{not json");
      expect([unreadable.status, unreadable.body.error?.code]).toEqual([400, "VALIDATION_ERROR"]);
      expect(await dbClient.db.select().from(notificationChannels)).toEqual([]);
    });

    it("refuses a collaborator of the account on the four routes: the two keys are the owner's", async () => {
      await start();
      const mario = await createCustomer("Hotel Mario", "mario@hotel.example.test");
      const userId = `usr_${randomUUID()}`;
      const membershipId = `mem_${randomUUID()}`;
      await dbClient.db.insert(users).values({ id: userId, email: "luca@hotel.example.test", name: "Luca", passwordHash: await hashPassword(PW) });
      await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: mario.orgId, userId });
      await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId, roleId: "role_customer_collaborator" });
      const luca = await login("luca@hotel.example.test", PW);
      expect(luca).toEqual(expect.any(String));
      const routes: Array<[string, string, unknown]> = [
        ["GET", "", undefined],
        ["PUT", "/channels/webhook", { enabled: true, groups: CUSTOMER_GROUPS, url: CUSTOMER_HOOK }],
        ["DELETE", "/channels/webhook", undefined],
        ["POST", "/channels/webhook/test", undefined],
      ];
      for (const [method, tail, body] of routes) {
        const res = await call(method, `${mario.base}${tail}`, luca, body);
        expect([method, res.status, res.body.error?.code]).toEqual([method, 403, "PERMISSION_DENIED"]);
      }
      expect(await dbClient.db.select().from(notificationChannels)).toEqual([]);
      expect(await deliveries()).toEqual([]);
      expect(outbound.calls).toEqual([]);
      // The owner of the same account is let in.
      expect((await call("GET", mario.base, mario.token)).status).toBe(200);
    });

    it("never gives back the address of a webhook, its key or a bot token: a page shows the host and the chat", async () => {
      await start();
      const first = await call("GET", ADMIN_BASE, adminToken);
      expect(NotificationSettingsDtoSchema.parse(first.body.data)).toEqual({
        audience: "server", mailReady: false, groups: SERVER_GROUPS, channels: { email: null, webhook: null, telegram: null }, deliveries: [],
      });

      const hook = await save(ADMIN_BASE, adminToken, "webhook", { enabled: true, groups: ["server"], url: ADMIN_HOOK, signingKey: SIGNING_KEY });
      const bot = await save(ADMIN_BASE, adminToken, "telegram", { enabled: true, groups: ["backups"], botToken: BOT_TOKEN, chat: CHAT });
      expect([hook.status, bot.status]).toEqual([200, 200]);
      const data = NotificationSettingsDtoSchema.parse(bot.body.data);
      expect(data.channels.webhook).toMatchObject({ enabled: true, groups: ["server"], host: "hooks.example.test", signed: true, lastTestedAt: null });
      expect(data.channels.telegram).toMatchObject({ enabled: true, groups: ["backups"], chat: CHAT, lastTestedAt: null });

      outbound.answer = { problem: "rejected", httpStatus: 401 };
      await call("POST", `${ADMIN_BASE}/channels/webhook/test`, adminToken);
      await call("POST", `${ADMIN_BASE}/channels/telegram/test`, adminToken);
      const page = await call("GET", ADMIN_BASE, adminToken);
      const rows = [
        ...(await dbClient.db.select().from(notificationChannels)),
        ...(await dbClient.db.select().from(notificationDeliveries)),
        ...(await dbClient.db.select().from(auditEvents)).filter((a) => a.action.startsWith("notification.")),
      ];
      expect(rows.length).toBeGreaterThanOrEqual(8);
      for (const text of [hook.raw, bot.raw, page.raw, JSON.stringify(rows)]) {
        for (const hidden of ["SENTINELPATH", "SENTINELQUERY", SIGNING_KEY, BOT_TOKEN, BOT_TOKEN.split(":")[1]!]) expect(text).not.toContain(hidden);
      }
      expect((await audits("notification.channel.update")).map((a) => a.details)).toEqual([
        expect.objectContaining({ channel: "webhook", enabled: true, groups: ["server"], outcome: "succeeded" }),
        expect.objectContaining({ channel: "telegram", enabled: true, groups: ["backups"], outcome: "succeeded" }),
      ]);
    });

    it("signs a webhook so that the receiver can check it, and keeps the address and the key that a save leaves out", async () => {
      await start();
      await adminWebhook({ signingKey: SIGNING_KEY });
      vi.useFakeTimers({ toFake: ["Date"] });
      const send = async (): Promise<{ url: string; raw: string; headers: Record<string, string> }> => {
        vi.setSystemTime(Date.now() + 31_000);
        const res = await call("POST", `${ADMIN_BASE}/channels/webhook/test`, adminToken);
        expect(res.body.data).toEqual({ outcome: "sent", problem: null, httpStatus: 200 });
        return outbound.calls.at(-1)!;
      };
      const verify = (sent: { raw: string; headers: Record<string, string> }, key: string) => {
        const header = sent.headers[NOTIFICATION_SIGNATURE_HEADER]!;
        const seconds = Number(/^t=(\d+),v1=[0-9a-f]{64}$/.exec(header)![1]);
        expect(Math.abs(seconds - Date.now() / 1000)).toBeLessThan(5);
        expect(header).toBe(notificationSignature(key, seconds, sent.raw));
      };

      const signed = await send();
      expect(signed.url).toBe(ADMIN_HOOK);
      verify(signed, SIGNING_KEY);
      expect(NotificationWebhookBodySchema.parse(JSON.parse(signed.raw))).toMatchObject({ test: true, events: [], omitted: 0, audience: "server" });

      // Saved again with neither: both stay.
      await adminWebhook({ url: undefined, groups: ["server"] });
      const kept = await send();
      expect(kept.url).toBe(ADMIN_HOOK);
      verify(kept, SIGNING_KEY);

      // A new address alone keeps the key; a new key alone keeps the address.
      await adminWebhook({ url: CUSTOMER_HOOK });
      const moved = await send();
      expect(moved.url).toBe(CUSTOMER_HOOK);
      verify(moved, SIGNING_KEY);
      await adminWebhook({ url: undefined, signingKey: "another-signing-key-0002" });
      const rekeyed = await send();
      expect(rekeyed.url).toBe(CUSTOMER_HOOK);
      verify(rekeyed, "another-signing-key-0002");

      // null takes the key away.
      await adminWebhook({ url: undefined, signingKey: null });
      expect((await send()).headers).toEqual({});
      expect((await call("GET", ADMIN_BASE, adminToken)).body.data.channels.webhook).toMatchObject({ host: "customer-hooks.example.test", signed: false });
    });

    it("refuses at save an address the panel may not call or cannot find, and a first save with no address or no token", async () => {
      await start();
      outbound.refused.set("https://inside.example.test/hook", "address_not_allowed");
      outbound.refused.set("https://nowhere.example.test/hook", "unreachable");
      const refused = async (channel: string, body: Json, field: string, message: string) => {
        const res = await save(ADMIN_BASE, adminToken, channel, { enabled: true, groups: ["server"], ...body });
        expect([res.status, res.body.error?.code, res.body.error?.details]).toEqual([400, "VALIDATION_ERROR", [{ field, message }]]);
      };
      await refused("webhook", { url: "https://inside.example.test/hook" }, "url", "address_not_allowed");
      await refused("webhook", { url: "https://nowhere.example.test/hook" }, "url", "address_unreachable");
      await refused("webhook", {}, "url", "address_required");
      await refused("webhook", { signingKey: SIGNING_KEY }, "url", "address_required");
      await refused("telegram", { chat: CHAT }, "botToken", "bot_token_required");
      for (const url of ["http://hooks.example.test/in", "https://10.0.0.5/in", "https://user:pw@hooks.example.test/in", "https://localhost/in"]) {
        expect([url, (await save(ADMIN_BASE, adminToken, "webhook", { enabled: true, groups: ["server"], url })).status]).toEqual([url, 400]);
      }
      expect((await save(ADMIN_BASE, adminToken, "telegram", { enabled: true, groups: ["server"], botToken: "not-a-token", chat: CHAT })).status).toBe(400);
      expect(await dbClient.db.select().from(notificationChannels)).toEqual([]);
      expect(await audits("notification.channel.update")).toEqual([]);

      // A channel that exists is not changed by a refused save.
      await adminWebhook();
      await refused("webhook", { url: "https://inside.example.test/hook" }, "url", "address_not_allowed");
      expect((await call("GET", ADMIN_BASE, adminToken)).body.data.channels.webhook.host).toBe("hooks.example.test");
    });

    it("refuses an address that leads to this server's recorded address, on no interface, at save, at the test and at the pass", async () => {
      // The real module on the panel's host row; documentation addresses stand for public ones.
      const table: Record<string, { a: string[]; aaaa: string[] }> = {
        "self.example.test": { a: ["203.0.113.10"], aaaa: [] },
        "self6.example.test": { a: [], aaaa: ["2001:db8::10"] },
        "both.example.test": { a: ["198.51.100.20", "203.0.113.10"], aaaa: [] },
        "elsewhere.example.test": { a: ["198.51.100.20"], aaaa: [] },
      };
      const dns = { lookup: async (name: string) => table[name] ?? { a: [], aaaa: [] } };
      await start({ real: (db) => createOutboundHttp(dns, () => recordedServerAddresses(db.db), { treatAsPublic: () => true, localAddresses: () => [] }) });
      // Behind address translation the installer records the public address by hand; the row may write it in long form.
      await dbClient.db.update(hosts).set({ ipv4Address: "203.0.113.10", ipv6Address: "2001:DB8:0:0:0:0:0:10" });
      for (const url of ["https://self.example.test/hook", "https://self6.example.test/hook", "https://both.example.test/hook"]) {
        const res = await save(ADMIN_BASE, adminToken, "webhook", { enabled: true, groups: ["server"], url });
        // The refusal a private address gets, and no address in it.
        expect([url, res.status, res.body.error?.code, res.body.error?.details]).toEqual([url, 400, "VALIDATION_ERROR", [{ field: "url", message: "address_not_allowed" }]]);
        for (const address of ["203.0.113", "2001:db8", "2001:DB8", "198.51.100"]) expect(res.raw).not.toContain(address);
      }
      expect(await dbClient.db.select().from(notificationChannels)).toEqual([]);

      // Saved while it is someone else's; then a rerun of the installer records it for this server.
      expect((await save(ADMIN_BASE, adminToken, "webhook", { enabled: true, groups: SERVER_GROUPS, url: "https://elsewhere.example.test/hook" })).status).toBe(200);
      await dbClient.db.update(hosts).set({ ipv4Address: "198.51.100.20" });
      const tried = await call("POST", `${ADMIN_BASE}/channels/webhook/test`, adminToken);
      expect([tried.status, tried.body.data]).toEqual([200, { outcome: "failed", problem: "address_not_allowed", httpStatus: null }]);
      seen.alerts = [disk()];
      await tick(at(0));
      await tick(at(2));
      const rows = await deliveries();
      expect(rows.filter((d) => d.test).map((d) => [d.status, d.problem])).toEqual([["failed", "address_not_allowed"]]);
      expect(rows.filter((d) => !d.test).map((d) => [d.status, d.problem, d.nextAttemptAt?.toISOString()])).toEqual([["pending", "address_not_allowed", at(4).toISOString()]]);
    });

    it("sends a Telegram message as plain text to the bot's own address, with no preview", async () => {
      await start();
      expect((await save(ADMIN_BASE, adminToken, "telegram", { enabled: true, groups: SERVER_GROUPS, botToken: BOT_TOKEN, chat: CHAT })).status).toBe(200);
      seen.alerts = [disk(97)];
      await tick(at(0));
      await tick(at(2));
      expect(outbound.calls).toHaveLength(1);
      const sent = outbound.calls[0]!;
      expect(sent.url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
      expect(sent.headers).toEqual({});
      expect(Object.keys(sent.body).sort()).toEqual(["chat_id", "link_preview_options", "text"]);
      expect(sent.body).toMatchObject({ chat_id: CHAT, link_preview_options: { is_disabled: true } });
      expect(sent.body["text"]).toContain("97");
      expect(sent.body["text"]).toContain("https://panel.example.test/admin/health");
      // The token is kept when a save leaves it out.
      expect((await save(ADMIN_BASE, adminToken, "telegram", { enabled: true, groups: ["server"], chat: "@hosting_alerts" })).status).toBe(200);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 31_000);
      await call("POST", `${ADMIN_BASE}/channels/telegram/test`, adminToken);
      expect(outbound.calls.at(-1)).toMatchObject({ url: `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, body: { chat_id: "@hosting_alerts" } });
    });

    it("sends the test message at once, says whether it went, keeps its outcome, and not more than one every thirty seconds", async () => {
      await start();
      const none = await call("POST", `${ADMIN_BASE}/channels/webhook/test`, adminToken);
      expect([none.status, none.body.error?.code]).toEqual([404, "NOT_FOUND"]);
      // A channel that is off can be tried before it is turned on.
      await adminWebhook({ enabled: false });
      vi.useFakeTimers({ toFake: ["Date"] });
      const sentAt = Date.now();

      const first = await call("POST", `${ADMIN_BASE}/channels/webhook/test`, adminToken);
      expect([first.status, first.body.data]).toEqual([200, { outcome: "sent", problem: null, httpStatus: 200 }]);
      expect(outbound.calls).toHaveLength(1);
      const soon = await call("POST", `${ADMIN_BASE}/channels/webhook/test`, adminToken);
      expect([soon.status, soon.body.error?.code]).toEqual([429, "RATE_LIMITED"]);
      expect(outbound.calls).toHaveLength(1);

      vi.setSystemTime(sentAt + 31_000);
      outbound.answer = { problem: "redirect", httpStatus: 302 };
      const later = await call("POST", `${ADMIN_BASE}/channels/webhook/test`, adminToken);
      expect([later.status, later.body.data]).toEqual([200, { outcome: "failed", problem: "redirect", httpStatus: 302 }]);

      const page = NotificationSettingsDtoSchema.parse((await call("GET", ADMIN_BASE, adminToken)).body.data);
      expect(page.channels.webhook?.lastTestedAt).toBe(new Date(sentAt + 31_000).toISOString());
      expect(page.deliveries.map((d) => [d.channel, d.test, d.status, d.problem, d.httpStatus, d.attempts])).toEqual([
        ["webhook", true, "failed", "redirect", 302, 1],
        ["webhook", true, "sent", null, 200, 1],
      ]);
      expect((await audits("notification.channel.test")).map((a) => a.details)).toEqual([
        expect.objectContaining({ channel: "webhook", outcome: "sent", problem: null }),
        expect.objectContaining({ channel: "webhook", outcome: "failed", problem: "redirect" }),
      ]);
      // A test is never tried again by a pass.
      await app.notifications.tick(new Date(sentAt + 5 * MIN));
      expect(outbound.calls).toHaveLength(2);
    });

    it("gives a customer the mail of the owners and the customer's groups only; the server's mail needs its addresses", async () => {
      await start();
      const mario = await createCustomer("Hotel Mario", "mario@hotel.example.test");
      const first = NotificationSettingsDtoSchema.parse((await call("GET", mario.base, mario.token)).body.data);
      expect(first).toMatchObject({ audience: "customer", mailReady: false, groups: CUSTOMER_GROUPS, channels: { email: null, webhook: null, telegram: null } });

      const bad = async (base: string, token: string, body: Json) => (await save(base, token, "email", body)).status;
      expect(await bad(mario.base, mario.token, { enabled: true, groups: ["availability"], recipients: ["x@example.test"] })).toBe(400);
      expect(await bad(mario.base, mario.token, { enabled: true, groups: ["server"] })).toBe(400);
      expect(await bad(mario.base, mario.token, { enabled: true, groups: [] })).toBe(400);
      expect(await bad(ADMIN_BASE, adminToken, { enabled: true, groups: ["server"] })).toBe(400);
      expect(await bad(ADMIN_BASE, adminToken, { enabled: true, groups: ["server"], recipients: [] })).toBe(400);
      expect(await bad(ADMIN_BASE, adminToken, { enabled: true, groups: ["server"], recipients: ["not an address"] })).toBe(400);
      expect(await dbClient.db.select().from(notificationChannels)).toEqual([]);

      const saved = await save(mario.base, mario.token, "email", { enabled: true, groups: ["availability", "backups"] });
      expect(saved.status).toBe(200);
      expect(saved.body.data.channels.email).toMatchObject({ enabled: true, groups: ["availability", "backups"], recipients: null });
      // The test mail goes to the owner; without sending set up the answer says so.
      const tried = await call("POST", `${mario.base}/channels/email/test`, mario.token);
      expect([tried.status, tried.body.data]).toEqual([200, { outcome: "failed", problem: "mail_not_configured", httpStatus: null }]);
      // The administrator's page does not show the customer's channel, nor the customer's page the server's.
      expect((await save(ADMIN_BASE, adminToken, "email", { enabled: false, groups: ["server"], recipients: ["ops@example.test"] })).status).toBe(200);
      expect((await call("GET", ADMIN_BASE, adminToken)).body.data.channels.email).toMatchObject({ enabled: false, recipients: ["ops@example.test"] });
      const mine = (await call("GET", mario.base, mario.token)).body.data;
      expect(mine.channels.email).toMatchObject({ enabled: true, recipients: null });
      expect(mine.deliveries.map((d: Json) => [d.channel, d.test, d.status])).toEqual([["email", true, "failed"]]);
      expect((await call("GET", ADMIN_BASE, adminToken)).body.data.deliveries).toEqual([]);
    });

    it("removes a channel with what it was told and what it sent", async () => {
      await start();
      await adminWebhook();
      seen.alerts = [disk()];
      await tick(at(0));
      await tick(at(2));
      expect(await deliveries()).toHaveLength(1);
      const removed = await call("DELETE", `${ADMIN_BASE}/channels/webhook`, adminToken);
      expect([removed.status, removed.body.data.channels.webhook, removed.body.data.deliveries]).toEqual([200, null, []]);
      expect(await told()).toEqual([]);
      expect(await deliveries()).toEqual([]);
      expect((await audits("notification.channel.delete")).map((a) => a.details)).toEqual([expect.objectContaining({ channel: "webhook" })]);
      expect((await call("DELETE", `${ADMIN_BASE}/channels/webhook`, adminToken)).status).toBe(404);
      await tick(at(4));
      expect(looks).toBe(2);
    });
  });
});
