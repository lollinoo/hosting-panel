import type { NotificationEvent } from "@hosting-panel/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancelNotificationDeliveries,
  claimNotificationChannelTest,
  createDatabaseClient,
  createNotificationDelivery,
  decryptSecretAesGcm,
  deleteNotificationChannel,
  deleteNotificationChannelAlerts,
  expireNotificationDeliveries,
  getNotificationChannel,
  listDueNotificationDeliveries,
  listEnabledNotificationChannels,
  listNotificationChannelAlerts,
  listNotificationChannels,
  listNotificationDeliveries,
  listNotificationOwners,
  newNotificationDeliveryId,
  notificationChannelSecretAad,
  pruneNotificationDeliveries,
  putNotificationChannelAlert,
  readNotificationChannelConfig,
  recordNotificationDelivery,
  saveNotificationChannel,
  sql,
  type DatabaseClient,
  type SaveNotificationChannelInput,
} from "../src/index.js";

const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);
const URL_CANARY = "https://hooks.example.test/in/canary-PATH-7f3a?k=canary-QUERY";
const SIGNING_CANARY = "canary-SIGNING-key-0123456789";
const BOT_CANARY = "123456789:canary_BOT_token_AAAAAAAAAAAAAAAAAAAAAA";
const T0 = new Date("2026-11-23T10:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const base = { enabled: true, groups: ["availability", "backups"] as const, recipients: null, chat: null, locale: "it" as const, config: null, actorId: null, now: T0 };
const webhook = (organizationId: string | null, over: Partial<SaveNotificationChannelInput> = {}): SaveNotificationChannelInput => ({
  ...base,
  organizationId,
  kind: "webhook",
  config: { kind: "webhook", url: URL_CANARY, signingKey: SIGNING_CANARY },
  ...over,
});
const event = (id: string, state: "opened" | "closed" = "opened"): NotificationEvent => ({
  id,
  kind: "site_container_down",
  state,
  severity: "critical",
  site: "Shop",
  host: null,
  name: null,
  component: null,
  disks: null,
  percent: null,
  date: null,
  operation: null,
});
const E1 = event("a".repeat(24));
const E2 = event("b".repeat(24), "closed");

const SEED = `
  INSERT INTO platform_installations (id, name) VALUES ('pi','pi');
  INSERT INTO organizations (id, platform_installation_id, name, slug) VALUES ('org_a','pi','A','a'), ('org_b','pi','B','b');
  INSERT INTO users (id, email, name, locale, user_status) VALUES
    ('u_owner','owner@a.example.test','Owner','en','active'),
    ('u_owner2','second@a.example.test','Second','it','active'),
    ('u_gone','gone@a.example.test','Gone','it','suspended'),
    ('u_collab','collab@a.example.test','Collab','it','active'),
    ('u_invited','invited@a.example.test','Invited','it','active'),
    ('u_b','owner@b.example.test','B','it','active');
  INSERT INTO roles (id, name, description) VALUES ('role_customer_owner','customer_owner','o'), ('role_customer_collaborator','customer_collaborator','c')
    ON CONFLICT DO NOTHING;
  INSERT INTO memberships (id, organization_id, user_id, status) VALUES
    ('m1','org_a','u_owner','active'), ('m2','org_a','u_owner2','active'), ('m3','org_a','u_gone','active'),
    ('m4','org_a','u_collab','active'), ('m5','org_a','u_invited','invited'), ('m6','org_b','u_b','active');
  INSERT INTO membership_roles (id, membership_id, role_id) VALUES
    ('r1','m1','role_customer_owner'), ('r2','m2','role_customer_owner'), ('r3','m3','role_customer_owner'),
    ('r4','m4','role_customer_collaborator'), ('r5','m5','role_customer_owner'), ('r6','m6','role_customer_owner');
`;

describe("@hosting-panel/database — 0029 notifications", () => {
  let client: DatabaseClient;
  const db = () => client.db;
  const rawChannels = async () =>
    JSON.stringify((await db().execute(sql`SELECT row_to_json(c)::text AS j FROM notification_channels c`)).rows);

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    // One statement per call: the driver prepares each query.
    for (const statement of SEED.split(";\n")) {
      if (statement.trim() !== "") await db().execute(sql.raw(statement));
    }
  });
  afterAll(async () => {
    await client.close();
  });

  describe("channels", () => {
    it("nothing is stored at first, in any scope", async () => {
      expect(await listNotificationChannels(db(), null)).toEqual([]);
      expect(await listNotificationChannels(db(), "org_a")).toEqual([]);
      expect(await listEnabledNotificationChannels(db())).toEqual([]);
      expect(await getNotificationChannel(db(), null, "webhook")).toBeNull();
      expect(await deleteNotificationChannel(db(), null, "webhook")).toBe(false);
    });

    it("a webhook or a bot cannot be created without its config", async () => {
      await expect(saveNotificationChannel(db(), KEY, webhook(null, { config: null }))).rejects.toThrow(/no stored config/);
      await expect(
        saveNotificationChannel(db(), KEY, { ...base, organizationId: null, kind: "telegram", chat: "-1001234567890" }),
      ).rejects.toThrow(/no stored config/);
      await expect(
        saveNotificationChannel(db(), KEY, webhook(null, { config: { kind: "telegram", botToken: BOT_CANARY } })),
      ).rejects.toThrow(/another kind/);
      expect(await listNotificationChannels(db(), null)).toEqual([]);
    });

    it("a webhook round-trips through encryption, and neither the record nor the row holds its address or key", async () => {
      const saved = await saveNotificationChannel(db(), KEY, webhook(null));
      expect(saved).toMatchObject({
        organizationId: null, kind: "webhook", enabled: true, groups: ["availability", "backups"], recipients: null,
        host: "hooks.example.test", chat: null, signed: true, locale: "it", lastTestedAt: null,
      });
      expect(saved.id).toMatch(/^nch_[0-9a-f]{24}$/);
      expect(saved.updatedAt.toISOString()).toBe(T0.toISOString());
      expect(await readNotificationChannelConfig(db(), KEY, saved.id)).toEqual({ kind: "webhook", url: URL_CANARY, signingKey: SIGNING_CANARY });

      const everything = `${JSON.stringify(saved)}${JSON.stringify(await listNotificationChannels(db(), null))}${await rawChannels()}`;
      for (const canary of ["canary-PATH", "canary-QUERY", SIGNING_CANARY]) expect(everything).not.toContain(canary);
    });

    it("a save without config keeps the stored envelope and what the page shows of it", async () => {
      const before = await rawChannels();
      const saved = await saveNotificationChannel(db(), KEY, webhook(null, { config: null, enabled: false, groups: ["server"], locale: "en", now: at(1) }));
      expect(saved).toMatchObject({ enabled: false, groups: ["server"], host: "hooks.example.test", signed: true, locale: "en" });
      expect(saved.updatedAt.toISOString()).toBe(at(1).toISOString());
      expect(await readNotificationChannelConfig(db(), KEY, saved.id)).toEqual({ kind: "webhook", url: URL_CANARY, signingKey: SIGNING_CANARY });
      const ciphertext = (raw: string) => /config_ciphertext_base64\\":\\"([^\\"]+)/.exec(raw)?.[1];
      expect(ciphertext(await rawChannels())).toBe(ciphertext(before));
      expect(ciphertext(before)).toBeTruthy();
    });

    it("a new config replaces the old one, and the shown host and signed flag follow it", async () => {
      const saved = await saveNotificationChannel(
        db(), KEY, webhook(null, { enabled: true, config: { kind: "webhook", url: "https://Other.Example.test:8443/x", signingKey: null } }),
      );
      expect(saved).toMatchObject({ host: "other.example.test", signed: false, enabled: true });
      expect(await readNotificationChannelConfig(db(), KEY, saved.id)).toEqual({ kind: "webhook", url: "https://Other.Example.test:8443/x", signingKey: null });
      expect(await listNotificationChannels(db(), null)).toHaveLength(1);
    });

    it("there is one channel per kind in each scope, and the scopes do not see each other", async () => {
      const server = await getNotificationChannel(db(), null, "webhook");
      const a = await saveNotificationChannel(db(), KEY, webhook("org_a"));
      const again = await saveNotificationChannel(db(), KEY, webhook("org_a", { groups: ["certificates"] }));
      const b = await saveNotificationChannel(db(), KEY, webhook("org_b", { enabled: false }));
      expect(again.id).toBe(a.id);
      expect(new Set([server?.id, a.id, b.id]).size).toBe(3);
      expect((await listNotificationChannels(db(), "org_a")).map((c) => c.id)).toEqual([a.id]);
      expect((await getNotificationChannel(db(), "org_a", "webhook"))?.groups).toEqual(["certificates"]);
      expect((await listEnabledNotificationChannels(db())).map((c) => c.id).sort()).toEqual([server?.id, a.id].sort());

      // The database itself refuses a second row, also in the server's scope where organization_id is NULL.
      const second = (org: string | null) => db().execute(sql`
        INSERT INTO notification_channels (id, organization_id, kind, groups, display_host, config_ciphertext_base64, config_iv_base64, config_auth_tag_base64)
        VALUES (${`nch_dup_${org ?? "server"}`}, ${org}, 'webhook', '[]', 'h.example.test', 'c', 'i', 't')`);
      await expect(second(null)).rejects.toThrow();
      await expect(second("org_a")).rejects.toThrow();
    });

    it("the envelope opens only with its key, in its scope and for its kind", async () => {
      const a = await getNotificationChannel(db(), "org_a", "webhook");
      await expect(readNotificationChannelConfig(db(), OTHER_KEY, a!.id)).rejects.toThrow();
      const [row] = (await db().execute(sql`
        SELECT config_ciphertext_base64 AS c, config_iv_base64 AS i, config_auth_tag_base64 AS t FROM notification_channels WHERE id = ${a!.id}`))
        .rows as Array<{ c: string; i: string; t: string }>;
      const open = (aad: ReturnType<typeof notificationChannelSecretAad>) =>
        decryptSecretAesGcm({ ...aad, ciphertextBase64: row!.c, ivBase64: row!.i, authTagBase64: row!.t, masterKey: KEY });
      expect(open(notificationChannelSecretAad("org_a", "webhook"))).toContain(URL_CANARY);
      expect(() => open(notificationChannelSecretAad("org_b", "webhook"))).toThrow();
      expect(() => open(notificationChannelSecretAad(null, "webhook"))).toThrow();
      expect(() => open(notificationChannelSecretAad("org_a", "telegram"))).toThrow();

      // Copied onto another customer's channel it does not open there.
      await db().execute(sql`
        UPDATE notification_channels SET config_ciphertext_base64 = ${row!.c}, config_iv_base64 = ${row!.i}, config_auth_tag_base64 = ${row!.t}
        WHERE organization_id = 'org_b' AND kind = 'webhook'`);
      const b = await getNotificationChannel(db(), "org_b", "webhook");
      await expect(readNotificationChannelConfig(db(), KEY, b!.id)).rejects.toThrow();
    });

    it("a bot keeps its chat in the open and its token sealed", async () => {
      const saved = await saveNotificationChannel(db(), KEY, {
        ...base, organizationId: "org_a", kind: "telegram", chat: "-1001234567890", config: { kind: "telegram", botToken: BOT_CANARY },
      });
      expect(saved).toMatchObject({ kind: "telegram", chat: "-1001234567890", host: null, signed: false });
      expect(await readNotificationChannelConfig(db(), KEY, saved.id)).toEqual({ kind: "telegram", botToken: BOT_CANARY });
      const kept = await saveNotificationChannel(db(), KEY, { ...base, organizationId: "org_a", kind: "telegram", chat: "@my_channel" });
      expect(kept).toMatchObject({ id: saved.id, chat: "@my_channel" });
      expect(await readNotificationChannelConfig(db(), KEY, saved.id)).toEqual({ kind: "telegram", botToken: BOT_CANARY });
      expect(`${JSON.stringify(kept)}${await rawChannels()}`).not.toContain("canary_BOT");
    });

    it("email has nothing sealed; the server's has typed addresses, a customer's has none", async () => {
      const server = await saveNotificationChannel(db(), KEY, {
        ...base, organizationId: null, kind: "email", groups: ["server"], recipients: ["ops@example.test", "second@example.test"],
      });
      expect(server).toMatchObject({ kind: "email", recipients: ["ops@example.test", "second@example.test"], host: null, chat: null });
      expect(await readNotificationChannelConfig(db(), KEY, server.id)).toBeNull();
      const customer = await saveNotificationChannel(db(), KEY, { ...base, organizationId: "org_a", kind: "email" });
      expect(customer.recipients).toBeNull();
      expect(await readNotificationChannelConfig(db(), KEY, "nch_missing")).toBeNull();

      // The row cannot say otherwise.
      await expect(db().execute(sql`UPDATE notification_channels SET recipients = '["x@example.test"]' WHERE id = ${customer.id}`)).rejects.toThrow();
      await expect(db().execute(sql`UPDATE notification_channels SET config_ciphertext_base64 = 'c' WHERE id = ${customer.id}`)).rejects.toThrow();
      await expect(db().execute(sql`UPDATE notification_channels SET kind = 'sms' WHERE id = ${customer.id}`)).rejects.toThrow();
    });

    it("a test message is allowed once per interval, per channel", async () => {
      const a = (await getNotificationChannel(db(), "org_a", "email"))!;
      const server = (await getNotificationChannel(db(), null, "email"))!;
      expect(await claimNotificationChannelTest(db(), a.id, T0, 30_000)).toBe(true);
      expect(await claimNotificationChannelTest(db(), a.id, new Date(T0.getTime() + 29_999), 30_000)).toBe(false);
      expect(await claimNotificationChannelTest(db(), server.id, new Date(T0.getTime() + 1_000), 30_000)).toBe(true);
      expect(await claimNotificationChannelTest(db(), a.id, new Date(T0.getTime() + 30_000), 30_000)).toBe(true);
      expect((await getNotificationChannel(db(), "org_a", "email"))?.lastTestedAt?.toISOString()).toBe(new Date(T0.getTime() + 30_000).toISOString());
      expect(await claimNotificationChannelTest(db(), "nch_missing", T0, 30_000)).toBe(false);
    });
  });

  describe("what a channel was told", () => {
    it("keeps one row per alert, and an alert seen again keeps the time it was first seen", async () => {
      const channel = (await getNotificationChannel(db(), "org_a", "webhook"))!;
      const seen = { alertKey: "site_container_down:site_1", kind: "site_container_down", severity: "warning", event: E1, firstSeenAt: T0, announcedAt: null } as const;
      await putNotificationChannelAlert(db(), channel.id, seen);
      await putNotificationChannelAlert(db(), channel.id, { ...seen, alertKey: "backup_failed:site_1", kind: "backup_failed", firstSeenAt: at(1) });
      expect(await listNotificationChannelAlerts(db(), channel.id)).toEqual([seen, { ...seen, alertKey: "backup_failed:site_1", kind: "backup_failed", firstSeenAt: at(1) }]);

      const told = { ...seen, severity: "critical", event: { ...E1, percent: 93 }, firstSeenAt: at(5), announcedAt: at(2) } as const;
      await putNotificationChannelAlert(db(), channel.id, told);
      const [first, second] = await listNotificationChannelAlerts(db(), channel.id);
      expect(first).toEqual({ ...told, firstSeenAt: T0 });
      expect(second?.announcedAt).toBeNull();

      const other = (await getNotificationChannel(db(), null, "webhook"))!;
      expect(await listNotificationChannelAlerts(db(), other.id)).toEqual([]);
    });

    it("forgets the alerts named, or all of them", async () => {
      const channel = (await getNotificationChannel(db(), "org_a", "webhook"))!;
      expect(await deleteNotificationChannelAlerts(db(), channel.id, [])).toBe(0);
      expect(await deleteNotificationChannelAlerts(db(), channel.id, ["backup_failed:site_1", "not:there"])).toBe(1);
      expect((await listNotificationChannelAlerts(db(), channel.id)).map((a) => a.alertKey)).toEqual(["site_container_down:site_1"]);
      await putNotificationChannelAlert(db(), channel.id, { alertKey: "x:1", kind: "backup_partial", severity: "warning", event: E1, firstSeenAt: T0, announcedAt: null });
      expect(await deleteNotificationChannelAlerts(db(), channel.id, null)).toBe(2);
      expect(await listNotificationChannelAlerts(db(), channel.id)).toEqual([]);
    });
  });

  describe("messages", () => {
    let hook: string;
    let mail: string;

    it("a new message waits for its first attempt, due at once, and counts its events", async () => {
      hook = (await getNotificationChannel(db(), "org_a", "webhook"))!.id;
      mail = (await getNotificationChannel(db(), null, "email"))!.id;
      const created = await createNotificationDelivery(db(), { channelId: hook, events: [E1, E2, E1], omitted: 4, test: false, recipient: null, locale: "it", now: T0 });
      expect(created).toMatchObject({
        channelId: hook, events: [E1, E2, E1], omitted: 4, opened: 2, closed: 1, test: false, recipient: null, locale: "it",
        status: "pending", attempts: 0, problem: null, httpStatus: null, finishedAt: null,
      });
      expect(created.id).toMatch(/^ndl_[0-9a-f]{24}$/);
      expect(created.nextAttemptAt?.toISOString()).toBe(T0.toISOString());
      expect(await listDueNotificationDeliveries(db(), new Date(T0.getTime() - 1), 20)).toEqual([]);
      const due = await listDueNotificationDeliveries(db(), T0, 20);
      expect(due).toHaveLength(1);
      expect(due[0]?.delivery).toEqual(created);
      expect(due[0]?.channel).toMatchObject({ id: hook, kind: "webhook", organizationId: "org_a", host: "hooks.example.test" });
      expect(JSON.stringify(due)).not.toContain("canary-PATH");
    });

    it("a failed attempt is tried again later, and a message that went is never due again", async () => {
      const delivery = (await listDueNotificationDeliveries(db(), T0, 20))[0]!.delivery;
      expect(await recordNotificationDelivery(db(), delivery.id, { status: "retry", problem: "server_error", httpStatus: 503, nextAttemptAt: at(2) }, T0)).toBe(true);
      expect(await listDueNotificationDeliveries(db(), at(1), 20)).toEqual([]);
      const [again] = await listDueNotificationDeliveries(db(), at(2), 20);
      expect(again?.delivery).toMatchObject({ status: "pending", attempts: 1, problem: "server_error", httpStatus: 503, finishedAt: null });

      expect(await recordNotificationDelivery(db(), delivery.id, { status: "sent", httpStatus: 204 }, at(2))).toBe(true);
      expect(await listDueNotificationDeliveries(db(), at(60), 20)).toEqual([]);
      // Its outcome is written once.
      expect(await recordNotificationDelivery(db(), delivery.id, { status: "failed", problem: "rejected", httpStatus: 410 }, at(3))).toBe(false);
      const [listed] = await listNotificationDeliveries(db(), "org_a", { since: T0, limit: 20 });
      expect(listed).toEqual({
        id: delivery.id, channel: "webhook", createdAt: T0, finishedAt: at(2), status: "sent", problem: null, httpStatus: 204,
        attempts: 2, test: false, opened: 2, closed: 1, recipient: null,
      });
    });

    it("a message can be stored already finished, with the id it went out with", async () => {
      const id = newNotificationDeliveryId();
      const sent = await createNotificationDelivery(db(), {
        id, channelId: hook, events: [], omitted: 0, test: true, recipient: null, locale: "en", now: at(3), end: { status: "sent", httpStatus: 200 },
      });
      expect(sent).toMatchObject({ id, test: true, status: "sent", attempts: 1, httpStatus: 200, problem: null, nextAttemptAt: null, opened: 0, closed: 0 });
      expect(sent.finishedAt?.toISOString()).toBe(at(3).toISOString());
      const failed = await createNotificationDelivery(db(), {
        channelId: hook, events: [], omitted: 0, test: true, recipient: null, locale: "en", now: at(4),
        end: { status: "failed", problem: "address_not_allowed", httpStatus: null },
      });
      expect(failed).toMatchObject({ status: "failed", attempts: 1, problem: "address_not_allowed", httpStatus: null });
      expect(await listDueNotificationDeliveries(db(), at(600), 20)).toEqual([]);
    });

    it("the due messages come oldest first, up to the limit", async () => {
      const later = await createNotificationDelivery(db(), { channelId: mail, events: [E1], omitted: 0, test: false, recipient: "second@example.test", locale: "it", now: at(11) });
      const sooner = await createNotificationDelivery(db(), { channelId: mail, events: [E1], omitted: 0, test: false, recipient: "ops@example.test", locale: "it", now: at(10) });
      expect((await listDueNotificationDeliveries(db(), at(20), 20)).map((d) => d.delivery.id)).toEqual([sooner.id, later.id]);
      expect((await listDueNotificationDeliveries(db(), at(20), 1)).map((d) => d.delivery.id)).toEqual([sooner.id]);
      expect((await listDueNotificationDeliveries(db(), at(10), 20)).map((d) => d.delivery.id)).toEqual([sooner.id]);
    });

    it("a mail to someone taken off the list is not delivered; the others still wait", async () => {
      expect(await cancelNotificationDeliveries(db(), mail, at(12), ["ops@example.test"])).toBe(1);
      const listed = await listNotificationDeliveries(db(), null, { since: T0, limit: 20 });
      expect(listed.map((d) => [d.recipient, d.status, d.problem])).toEqual([
        ["second@example.test", "failed", "channel_changed"],
        ["ops@example.test", "pending", null],
      ]);
      expect(listed[0]?.finishedAt?.toISOString()).toBe(at(12).toISOString());
      expect(listed[0]?.attempts).toBe(0);
    });

    it("a channel turned off drops everything that waits, and nothing that ended", async () => {
      expect(await cancelNotificationDeliveries(db(), mail, at(13))).toBe(1);
      expect(await cancelNotificationDeliveries(db(), mail, at(13))).toBe(0);
      expect(await cancelNotificationDeliveries(db(), hook, at(13))).toBe(0);
      expect((await listNotificationDeliveries(db(), null, { since: T0, limit: 20 })).every((d) => d.status === "failed" && d.problem === "channel_changed")).toBe(true);
      expect((await listNotificationDeliveries(db(), "org_a", { since: T0, limit: 20 })).map((d) => d.status)).toEqual(["failed", "sent", "sent"]);
    });

    it("a message too old to be worth sending is not delivered, without an attempt", async () => {
      const old = await createNotificationDelivery(db(), { channelId: hook, events: [E1], omitted: 0, test: false, recipient: null, locale: "it", now: at(20) });
      const fresh = await createNotificationDelivery(db(), { channelId: hook, events: [E1], omitted: 0, test: false, recipient: null, locale: "it", now: at(50) });
      expect(await expireNotificationDeliveries(db(), at(20), at(80))).toBe(1);
      const listed = await listNotificationDeliveries(db(), "org_a", { since: at(20), limit: 20 });
      expect(listed.map((d) => [d.id, d.status, d.problem, d.attempts])).toEqual([
        [fresh.id, "pending", null, 0],
        [old.id, "failed", "expired", 0],
      ]);
      expect(await recordNotificationDelivery(db(), fresh.id, { status: "dropped", problem: "channel_changed" }, at(81))).toBe(true);
      const [dropped] = await listNotificationDeliveries(db(), "org_a", { since: at(50), limit: 20 });
      expect(dropped).toMatchObject({ id: fresh.id, status: "failed", problem: "channel_changed", attempts: 0, httpStatus: null });
    });

    it("the list of one scope is its own, newest first, bounded in number and in age", async () => {
      const all = await listNotificationDeliveries(db(), "org_a", { since: T0, limit: 20 });
      expect(all.map((d) => d.createdAt.getTime())).toEqual([...all.map((d) => d.createdAt.getTime())].sort((x, y) => y - x));
      expect(all).toHaveLength(5);
      expect(await listNotificationDeliveries(db(), "org_a", { since: T0, limit: 2 })).toEqual(all.slice(0, 2));
      expect(await listNotificationDeliveries(db(), "org_a", { since: at(50), limit: 20 })).toHaveLength(1);
      expect(await listNotificationDeliveries(db(), "org_b", { since: T0, limit: 20 })).toEqual([]);
      expect((await listNotificationDeliveries(db(), null, { since: T0, limit: 20 })).every((d) => d.channel === "email")).toBe(true);
    });

    it("the row refuses an outcome that contradicts its state", async () => {
      const id = (await listNotificationDeliveries(db(), "org_a", { since: at(50), limit: 1 }))[0]!.id;
      await expect(db().execute(sql`UPDATE notification_deliveries SET status = 'pending' WHERE id = ${id}`)).rejects.toThrow();
      await expect(db().execute(sql`UPDATE notification_deliveries SET problem = NULL WHERE id = ${id}`)).rejects.toThrow();
      await expect(db().execute(sql`UPDATE notification_deliveries SET status = 'sent' WHERE id = ${id}`)).rejects.toThrow();
      await expect(db().execute(sql`UPDATE notification_deliveries SET http_status = 42 WHERE id = ${id}`)).rejects.toThrow();
    });

    it("old messages are removed, whatever their outcome", async () => {
      // Three of the customer's webhook and the two mails of the server were born before; the two born later stay.
      expect(await pruneNotificationDeliveries(db(), at(20))).toBe(5);
      expect((await listNotificationDeliveries(db(), "org_a", { since: T0, limit: 20 })).map((d) => d.createdAt.toISOString())).toEqual([at(50).toISOString(), at(20).toISOString()]);
      expect(await listNotificationDeliveries(db(), null, { since: T0, limit: 20 })).toEqual([]);
    });

    it("removing a channel removes what it was told and its messages; removing a customer removes its channels", async () => {
      await putNotificationChannelAlert(db(), hook, { alertKey: "x:1", kind: "backup_partial", severity: "warning", event: E1, firstSeenAt: T0, announcedAt: null });
      expect(await deleteNotificationChannel(db(), "org_a", "webhook")).toBe(true);
      const left = async (table: "notification_channel_alerts" | "notification_deliveries") =>
        (await db().execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE channel_id = ${hook}`)).rows[0];
      expect(await left("notification_channel_alerts")).toEqual({ n: 0 });
      expect(await left("notification_deliveries")).toEqual({ n: 0 });
      expect((await listNotificationChannels(db(), "org_a")).map((c) => c.kind)).toEqual(["email", "telegram"]);

      await db().execute(sql`DELETE FROM organizations WHERE id = 'org_b'`);
      expect(await listNotificationChannels(db(), "org_b")).toEqual([]);
      expect((await listNotificationChannels(db(), null)).map((c) => c.kind)).toEqual(["email", "webhook"]);
    });
  });

  describe("who a customer's mail goes to", () => {
    it("the owners who can sign in, with their language: no collaborator, no invitation, no suspended user", async () => {
      expect(await listNotificationOwners(db(), "org_a", 10)).toEqual([
        { email: "owner@a.example.test", locale: "en" },
        { email: "second@a.example.test", locale: "it" },
      ]);
      expect(await listNotificationOwners(db(), "org_a", 1)).toEqual([{ email: "owner@a.example.test", locale: "en" }]);
      expect(await listNotificationOwners(db(), "org_missing", 10)).toEqual([]);
    });
  });
});
