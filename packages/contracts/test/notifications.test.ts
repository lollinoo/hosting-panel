import { describe, expect, it } from "vitest";
import {
  ALERT_KINDS,
  AdminAlertDtoSchema,
  CUSTOMER_NOTIFICATION_KINDS,
  NOTIFICATION_GROUPS,
  NOTIFICATION_GROUPS_OF_AUDIENCE,
  NOTIFICATION_GROUP_OF,
  NOTIFICATION_LOCALES,
  NOTIFICATION_MAX_RECIPIENTS,
  NOTIFICATION_NAME_MAX,
  NOTIFICATION_TEXT_MAX,
  NotificationEventSchema,
  NotificationMailIpcRequestSchema,
  NotificationSettingsDtoSchema,
  NotificationWebhookBodySchema,
  NotificationWebhookUrlSchema,
  PERMISSION_KEYS,
  PanelMailIpcRequestSchema,
  PRESET_ROLE_PERMISSIONS,
  SaveCustomerEmailChannelSchema,
  SaveServerEmailChannelSchema,
  SaveTelegramChannelSchema,
  SaveWebhookChannelSchema,
  audienceHearsKind,
  cleanNotificationText,
  closedNotificationEvent,
  findForbiddenPublicDtoKeys,
  findPlaintextSecretKeys,
  isMutatingPermission,
  notificationAlertKey,
  notificationEventFromAlert,
  notificationLine,
  renderNotification,
  type AdminAlertDto,
  type NotificationEvent,
  type NotificationSettingsDto,
} from "../src/index.js";

const AT = "2026-11-23T10:00:00.000Z";
const EXPIRY = "2026-12-01T00:00:00.000Z";
const ID = "0123456789abcdef01234567";
const TARGET = `bkt_${"a".repeat(32)}`;
const SITE = { siteId: "site_1", siteName: "Shop" };

/** One alert of every kind, in the order of ALERT_KINDS. */
const ALERTS: AdminAlertDto[] = [
  { kind: "disk_high", severity: "critical", subject: "panel_data", since: null, details: { paths: ["panel_data", "root"], usedPercent: 93 } },
  { kind: "certificate_expiring", severity: "warning", subject: "shop.example.test", since: null, details: { ...SITE, hostname: "shop.example.test", expiresAt: EXPIRY, problem: null } },
  { kind: "certificate_not_issued", severity: "warning", subject: "shop.example.test", since: null, details: { ...SITE, hostname: "shop.example.test", problem: null } },
  { kind: "panel_certificate_expiring", severity: "warning", subject: "panel.example.test", since: null, details: { hostname: "panel.example.test", expiresAt: EXPIRY } },
  { kind: "manual_certificate_expiring", severity: "critical", subject: "crt_1", since: null, details: { ...SITE, certificateId: "crt_1", certificateName: "Wildcard 2026", notAfter: EXPIRY, tier: "critical" } },
  { kind: "backup_failed", severity: "warning", subject: "site_1", since: AT, details: { ...SITE, failedAt: AT } },
  { kind: "panel_backup_failed", severity: "warning", subject: "panel", since: AT, details: { failedAt: AT } },
  { kind: "backup_storage_test_failed", severity: "warning", subject: TARGET, since: AT, details: { testedAt: AT, targetId: TARGET, targetKind: "s3", problem: null } },
  { kind: "backup_target_space_low", severity: "warning", subject: TARGET, since: AT, details: { targetId: TARGET, targetKind: "local", availableBytes: 1, totalBytes: 100, testedAt: AT } },
  { kind: "backup_site_without_target", severity: "warning", subject: "site_1", since: null, details: { ...SITE } },
  { kind: "backup_partial", severity: "warning", subject: "site_1", since: AT, details: { ...SITE, backupId: "bkp_1", at: AT } },
  { kind: "component_down", severity: "critical", subject: "executor", since: null, details: { component: "executor", state: "down", reason: "not_reporting" } },
  { kind: "site_container_down", severity: "critical", subject: "site_1", since: AT, details: { ...SITE, observed: "stopped" } },
  { kind: "restore_undo_incomplete", severity: "critical", subject: "site_1", since: null, details: { ...SITE, backupId: "bkp_1", failedAt: null } },
  { kind: "restore_stuck", severity: "warning", subject: "op_1", since: AT, details: { operationId: "op_1", siteId: null, siteName: null, startedAt: AT } },
  { kind: "operation_unknown", severity: "warning", subject: "op_2", since: AT, details: { operationId: "op_2", kind: "site.deploy", ...SITE } },
  { kind: "operation_stuck", severity: "warning", subject: "op_3", since: AT, details: { operationId: "op_3", kind: "site.backups.create", siteId: null, siteName: null } },
];

const eventOf = (kind: AdminAlertDto["kind"], state: "opened" | "closed" = "opened"): NotificationEvent =>
  notificationEventFromAlert(ALERTS.find((a) => a.kind === kind)!, ID, state);

// Every character that must never reach a mail or a chat message.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

describe("notification groups and audiences", () => {
  it("give every alert kind one group", () => {
    expect(Object.keys(NOTIFICATION_GROUP_OF).sort()).toEqual([...ALERT_KINDS].sort());
    for (const kind of ALERT_KINDS) expect(NOTIFICATION_GROUPS, kind).toContain(NOTIFICATION_GROUP_OF[kind]);
    for (const group of NOTIFICATION_GROUPS) expect(Object.values(NOTIFICATION_GROUP_OF), group).toContain(group);
  });

  it("tell a customer only of the alerts about a site, in the customer's groups", () => {
    expect(CUSTOMER_NOTIFICATION_KINDS).toEqual([
      "site_container_down", "backup_failed", "backup_partial", "restore_undo_incomplete",
      "certificate_expiring", "certificate_not_issued", "manual_certificate_expiring",
    ]);
    expect(NOTIFICATION_GROUPS_OF_AUDIENCE.customer).toEqual(["availability", "backups", "certificates"]);
    expect(NOTIFICATION_GROUPS_OF_AUDIENCE.server).toEqual(NOTIFICATION_GROUPS);
    for (const kind of ALERT_KINDS) {
      expect(audienceHearsKind("server", kind), kind).toBe(true);
      expect(audienceHearsKind("customer", kind), kind).toBe((CUSTOMER_NOTIFICATION_KINDS as readonly string[]).includes(kind));
    }
    for (const kind of CUSTOMER_NOTIFICATION_KINDS) {
      expect(NOTIFICATION_GROUPS_OF_AUDIENCE.customer, kind).toContain(NOTIFICATION_GROUP_OF[kind]);
    }
    for (const kind of ["disk_high", "component_down", "panel_backup_failed", "backup_storage_test_failed", "operation_stuck"] as const) {
      expect(audienceHearsKind("customer", kind), kind).toBe(false);
    }
  });
});

describe("notification permissions", () => {
  it("are two keys of the customer's owner only, and reading is not a change", () => {
    expect(PERMISSION_KEYS).toContain("notification.read");
    expect(PERMISSION_KEYS).toContain("notification.manage");
    const holders = (key: "notification.read" | "notification.manage") =>
      Object.entries(PRESET_ROLE_PERMISSIONS).filter(([, keys]) => keys.includes(key)).map(([role]) => role);
    expect(holders("notification.read")).toEqual(["customer_owner"]);
    expect(holders("notification.manage")).toEqual(["customer_owner"]);
    expect(isMutatingPermission("notification.read")).toBe(false);
    expect(isMutatingPermission("notification.manage")).toBe(true);
  });
});

describe("notification events", () => {
  it("are made from an alert of every kind", () => {
    expect(ALERTS.map((a) => a.kind)).toEqual([...ALERT_KINDS]);
    for (const alert of ALERTS) {
      expect(AdminAlertDtoSchema.parse(alert), alert.kind).toEqual(alert);
      const event = notificationEventFromAlert(alert, ID, "opened");
      expect(NotificationEventSchema.parse(event), alert.kind).toEqual(event);
      expect(event).toMatchObject({ id: ID, kind: alert.kind, state: "opened", severity: alert.severity });
      expect(closedNotificationEvent(event)).toEqual({ ...event, state: "closed" });
    }
  });

  it("keep only the bounded facts of an alert", () => {
    expect(eventOf("disk_high")).toEqual({
      id: ID, kind: "disk_high", state: "opened", severity: "critical",
      site: null, host: null, name: null, component: null, disks: ["panel_data", "root"], percent: 93, date: null, operation: null,
    });
    expect(eventOf("certificate_expiring")).toMatchObject({ site: "Shop", host: "shop.example.test", date: EXPIRY });
    expect(eventOf("manual_certificate_expiring")).toMatchObject({ site: "Shop", name: "Wildcard 2026", date: EXPIRY });
    expect(eventOf("component_down")).toMatchObject({ component: "executor", site: null });
    expect(eventOf("operation_unknown")).toMatchObject({ site: "Shop", operation: "site.deploy" });
    // Nothing of a backup destination or of an operation's id reaches an event.
    expect(JSON.stringify(ALERTS.map((a) => notificationEventFromAlert(a, ID, "opened")))).not.toMatch(/bkt_|bkp_|op_\d|crt_1|site_1/);
  });

  it("name an alert by its kind and subject", () => {
    expect(notificationAlertKey({ kind: "site_container_down", subject: "site_1" })).toBe("site_container_down:site_1");
  });

  it("clean the names a user typed", () => {
    expect(cleanNotificationText("  Shop\r\nBcc: x@example.test‮ ")).toBe("Shop Bcc: x@example.test");
    expect(cleanNotificationText("a\u0000b c d​e⁦f\ud800g")).toBe("a b c d e f g");
    expect(cleanNotificationText("\u0007‏ \n")).toBeNull();
    expect(cleanNotificationText("")).toBeNull();
    expect(cleanNotificationText(null)).toBeNull();
    const long = cleanNotificationText("x".repeat(200))!;
    expect(Array.from(long)).toHaveLength(NOTIFICATION_NAME_MAX);
    expect(long.endsWith("…")).toBe(true);
    // Counted in characters, not in UTF-16 units: an emoji is never cut in half.
    const emoji = cleanNotificationText("😀".repeat(200))!;
    expect(Array.from(emoji)).toHaveLength(NOTIFICATION_NAME_MAX);
    expect(UNSAFE.test(emoji)).toBe(false);
  });

  it("carry no control character even when the name of a site holds one", () => {
    const hostile = "Shop\r\nSubject: hello\u0000 ‮evil" + "y".repeat(300);
    const alert: AdminAlertDto = { kind: "site_container_down", severity: "critical", subject: "site_1", since: null, details: { siteId: "site_1", siteName: hostile, observed: "stopped" } };
    const event = notificationEventFromAlert(alert, ID, "opened");
    expect(NotificationEventSchema.safeParse(event).success).toBe(true);
    expect(UNSAFE.test(event.site!)).toBe(false);
    expect(Array.from(event.site!).length).toBeLessThanOrEqual(NOTIFICATION_NAME_MAX);
    for (const locale of NOTIFICATION_LOCALES) {
      const { subject, text } = renderNotification({ locale, audience: "customer", events: [event], omitted: 0, test: false, link: null });
      expect(subject).not.toContain("Shop");
      expect(text.split("\n")).toHaveLength(2);
      expect(UNSAFE.test(text.replace(/\n/g, ""))).toBe(false);
    }
  });

  it.each([
    ["a line break in a name", { site: "Shop\nBcc: x@example.test" }],
    ["a bidirectional control in a name", { site: "Shop‮" }],
    ["a name longer than the limit", { site: "x".repeat(NOTIFICATION_NAME_MAX + 1) }],
    ["an empty name", { site: "" }],
    ["an id that is not 24 hex digits", { id: "abc" }],
    ["an unknown kind", { kind: "something_else" }],
    ["an unknown component", { component: "kernel" }],
    ["a percentage above 100", { percent: 101 }],
    ["a date that is not an instant", { date: "tomorrow" }],
    ["an extra key", { message: "free text" }],
  ])("refuse %s", (_name, patch) => {
    expect(NotificationEventSchema.safeParse({ ...eventOf("site_container_down"), ...patch }).success).toBe(false);
  });
});

describe("notification texts", () => {
  it("have a line for every kind, audience and language", () => {
    for (const locale of NOTIFICATION_LOCALES) {
      for (const audience of ["server", "customer"] as const) {
        for (const kind of ALERT_KINDS) {
          for (const state of ["opened", "closed"] as const) {
            const line = notificationLine(locale, audience, eventOf(kind, state));
            expect(line.length, `${locale} ${audience} ${kind}`).toBeGreaterThan(5);
            expect(line, `${locale} ${audience} ${kind}`).not.toMatch(/undefined|null|\{|\}|\n/);
          }
        }
      }
    }
  });

  it("say what is wrong, with the fact that matters while it is open", () => {
    expect(notificationLine("it", "server", eventOf("disk_high"))).toBe("[critico] Disco quasi pieno: dati del pannello, sistema (pieno al 93%)");
    expect(notificationLine("en", "server", eventOf("disk_high"))).toBe("[critical] Disk almost full: panel data, system (93% full)");
    expect(notificationLine("it", "server", eventOf("disk_high", "closed"))).toBe("Disco quasi pieno: dati del pannello, sistema");
    expect(notificationLine("it", "server", eventOf("certificate_expiring"))).toBe(
      "Certificato in scadenza e non ancora rinnovato: shop.example.test, sito Shop (scade il 1 dicembre 2026)",
    );
    expect(notificationLine("en", "server", eventOf("manual_certificate_expiring"))).toBe(
      "[critical] Imported certificate about to expire: Wildcard 2026 (valid until 1 December 2026)",
    );
    expect(notificationLine("it", "server", eventOf("component_down"))).toBe("[critico] Componente del pannello non in funzione: Esecutore (hp-docker-executor)");
    expect(notificationLine("it", "server", eventOf("operation_unknown"))).toBe("Operazione in uno stato indeterminato: site.deploy su Shop");
    expect(notificationLine("en", "server", eventOf("operation_stuck"))).toBe("Operation stuck: site.backups.create");
    expect(notificationLine("it", "server", eventOf("panel_backup_failed"))).toBe("Backup del pannello non riuscito");
  });

  it("speak to a customer in the customer's words", () => {
    expect(notificationLine("it", "customer", eventOf("site_container_down"))).toBe("Sito non in funzione: Shop");
    expect(notificationLine("it", "customer", eventOf("certificate_expiring"))).toBe("Certificato in scadenza: shop.example.test, sito Shop (scade il 1 dicembre 2026)");
    expect(notificationLine("en", "customer", eventOf("backup_partial"))).toBe("Backup only partly done: Shop");
    for (const locale of NOTIFICATION_LOCALES) {
      for (const kind of CUSTOMER_NOTIFICATION_KINDS) {
        for (const state of ["opened", "closed"] as const) {
          const line = notificationLine(locale, "customer", eventOf(kind, state));
          expect(line, `${locale} ${kind}`).not.toMatch(/docker|container|proxy|traefik|hp[-_]|executor|esecutore|\[/i);
        }
      }
    }
  });

  it("write the test message", () => {
    expect(renderNotification({ locale: "it", audience: "server", events: [], omitted: 0, test: true, link: "https://panel.example.test/admin/health" })).toEqual({
      subject: "Pannello di hosting: messaggio di prova",
      text: "Questo è un messaggio di prova del pannello di hosting. Se lo leggi, le notifiche su questo canale funzionano.\n\nApri il pannello: https://panel.example.test/admin/health",
    });
    expect(renderNotification({ locale: "en", audience: "customer", events: [], omitted: 0, test: true, link: null })).toEqual({
      subject: "Hosting panel: test message",
      text: "This is a test message from the hosting panel. If you can read it, notifications on this channel work.",
    });
  });

  it("put what opened and what closed in one message, with a subject of counts only", () => {
    const events = [eventOf("site_container_down"), eventOf("backup_failed"), eventOf("certificate_not_issued", "closed")];
    expect(renderNotification({ locale: "it", audience: "customer", events, omitted: 0, test: false, link: "https://panel.example.test/" })).toEqual({
      subject: "Pannello di hosting: 2 nuovi avvisi, 1 non più aperto",
      text: [
        "Nuovi avvisi:",
        "- Sito non in funzione: Shop",
        "- Backup non riuscito: Shop",
        "",
        "Non più aperti:",
        "- Certificato non ancora emesso: shop.example.test, sito Shop",
        "",
        "Apri il pannello: https://panel.example.test/",
      ].join("\n"),
    });
    expect(renderNotification({ locale: "en", audience: "server", events, omitted: 0, test: false, link: null }).subject).toBe("Hosting panel: 2 new alerts, 1 no longer open");
    expect(renderNotification({ locale: "it", audience: "server", events: [events[0]!], omitted: 0, test: false, link: null }).subject).toBe("Pannello di hosting: 1 nuovo avviso");
    expect(renderNotification({ locale: "it", audience: "server", events: [events[2]!], omitted: 0, test: false, link: null }).subject).toBe("Pannello di hosting: 1 avviso non più aperto");
    expect(renderNotification({ locale: "en", audience: "server", events: [events[2]!, events[2]!], omitted: 0, test: false, link: null }).subject).toBe("Hosting panel: 2 alerts no longer open");
  });

  it("stay under the length a chat message may have and count what was left out", () => {
    const name = "n".repeat(NOTIFICATION_NAME_MAX);
    const events = Array.from({ length: 50 }, (): NotificationEvent => ({ ...eventOf("site_container_down"), site: name }));
    for (const locale of NOTIFICATION_LOCALES) {
      const { text } = renderNotification({ locale, audience: "server", events, omitted: 7, test: false, link: "https://panel.example.test/admin/health" });
      expect(text.length).toBeLessThanOrEqual(NOTIFICATION_TEXT_MAX);
      const told = text.split("\n").filter((l) => l.startsWith("- ")).length;
      expect(told).toBeGreaterThan(10);
      expect(told).toBeLessThan(50);
      const left = /(\d+)/.exec(text.split("\n").find((l) => l.startsWith("…"))!)![1];
      expect(Number(left)).toBe(50 - told + 7);
      expect(text.endsWith("https://panel.example.test/admin/health")).toBe(true);
    }
    const few = renderNotification({ locale: "it", audience: "server", events: events.slice(0, 2), omitted: 3, test: false, link: null });
    expect(few.text.split("\n").at(-1)).toBe("… e altri 3: sono tutti nel pannello.");
  });
});

describe("notification settings", () => {
  const groups = ["availability", "backups"];

  it.each([
    "https://hooks.example.com/services/T000/B000/abcDEF123?x=1",
    "https://example.com:8443/hook",
    "https://a.b.example.co.uk/",
  ])("take the webhook address %s", (url) => {
    expect(NotificationWebhookUrlSchema.safeParse(url).success).toBe(true);
  });

  it.each([
    ["plain http", "http://hooks.example.com/x"],
    ["another scheme", "ftp://hooks.example.com/x"],
    ["an IPv4 address", "https://127.0.0.1/hook"],
    ["an IPv4 address written as a number", "https://2130706433/hook"],
    ["an IPv4 address written in hexadecimal", "https://0x7f.0.0.1/hook"],
    ["an IPv6 address", "https://[::1]/hook"],
    ["a name without a dot", "https://localhost/hook"],
    ["a name that ends with a number", "https://example.123/hook"],
    ["a user name and a password", "https://user:pw@hooks.example.com/x"],
    ["a user name", "https://user@hooks.example.com/x"],
    ["a fragment", "https://hooks.example.com/x#part"],
    ["a space", "https://hooks.example.com/a b"],
    ["a line break", "https://hooks.example.com/a\nb"],
    ["a character outside ASCII", "https://hooks.example.com/è"],
    ["no address", ""],
    ["an address that is too long", `https://hooks.example.com/${"a".repeat(1024)}`],
    ["something that is not an address", "hooks.example.com/x"],
  ])("refuse a webhook address with %s", (_name, url) => {
    expect(NotificationWebhookUrlSchema.safeParse(url).success).toBe(false);
  });

  it("take the email of the server with one to five addresses, each once", () => {
    const parsed = SaveServerEmailChannelSchema.parse({ enabled: true, groups, recipients: [" Admin@Example.Test "] });
    expect(parsed.recipients).toEqual(["admin@example.test"]);
    const many = Array.from({ length: NOTIFICATION_MAX_RECIPIENTS + 1 }, (_, i) => `a${String(i)}@example.test`);
    expect(SaveServerEmailChannelSchema.safeParse({ enabled: true, groups, recipients: many }).success).toBe(false);
    expect(SaveServerEmailChannelSchema.safeParse({ enabled: true, groups, recipients: many.slice(0, NOTIFICATION_MAX_RECIPIENTS) }).success).toBe(true);
    for (const recipients of [[], ["a@example.test", "A@example.test"], ["not an address"], ["a@example.test\nBcc: b@example.test"]]) {
      expect(SaveServerEmailChannelSchema.safeParse({ enabled: true, groups, recipients }).success, JSON.stringify(recipients)).toBe(false);
    }
    expect(SaveServerEmailChannelSchema.safeParse({ enabled: true, groups: [], recipients: ["a@example.test"] }).success).toBe(false);
    expect(SaveServerEmailChannelSchema.safeParse({ enabled: true, groups: ["backups", "backups"], recipients: ["a@example.test"] }).success).toBe(false);
    expect(SaveServerEmailChannelSchema.safeParse({ enabled: true, groups: ["everything"], recipients: ["a@example.test"] }).success).toBe(false);
  });

  it("give a customer no address to type", () => {
    expect(SaveCustomerEmailChannelSchema.safeParse({ enabled: true, groups }).success).toBe(true);
    expect(SaveCustomerEmailChannelSchema.safeParse({ enabled: true, groups, recipients: ["a@example.test"] }).success).toBe(false);
  });

  it("take a webhook with or without its address and signing key", () => {
    expect(SaveWebhookChannelSchema.safeParse({ enabled: true, groups }).success).toBe(true);
    expect(SaveWebhookChannelSchema.safeParse({ enabled: true, groups, url: "https://hooks.example.com/x", signingKey: "k".repeat(16) }).success).toBe(true);
    expect(SaveWebhookChannelSchema.safeParse({ enabled: true, groups, signingKey: null }).success).toBe(true);
    for (const signingKey of ["short", "k".repeat(129), `${"k".repeat(16)} `, `${"k".repeat(16)}\n`]) {
      expect(SaveWebhookChannelSchema.safeParse({ enabled: true, groups, signingKey }).success, JSON.stringify(signingKey)).toBe(false);
    }
    expect(SaveWebhookChannelSchema.safeParse({ enabled: true, groups, url: "https://10.0.0.1/x" }).success).toBe(false);
    expect(SaveWebhookChannelSchema.safeParse({ enabled: true, groups, headers: { a: "b" } }).success).toBe(false);
  });

  it("take a Telegram bot and a chat", () => {
    const botToken = `123456789:${"A".repeat(35)}`;
    for (const chat of ["12345", "-1001234567890", "@my_channel"]) {
      expect(SaveTelegramChannelSchema.safeParse({ enabled: true, groups, botToken, chat }).success, chat).toBe(true);
    }
    expect(SaveTelegramChannelSchema.safeParse({ enabled: true, groups, chat: "12345" }).success).toBe(true);
    for (const chat of ["", "my channel", "@ab", "12345/../x", "@name\n"]) {
      expect(SaveTelegramChannelSchema.safeParse({ enabled: true, groups, botToken, chat }).success, JSON.stringify(chat)).toBe(false);
    }
    for (const bad of ["123:abc", `123456789:${"A".repeat(35)}/getMe`, `123456789:${"A".repeat(35)}?x`, ` ${botToken}`]) {
      expect(SaveTelegramChannelSchema.safeParse({ enabled: true, groups, botToken: bad, chat: "12345" }).success, bad).toBe(false);
    }
  });

  it("show the settings without the address of a webhook, its key or the bot's token", () => {
    const channel = { enabled: true, groups: ["availability"], updatedAt: AT, lastTestedAt: null };
    const dto: NotificationSettingsDto = {
      audience: "server",
      mailReady: true,
      groups: [...NOTIFICATION_GROUPS],
      channels: {
        email: { ...channel, recipients: ["admin@example.test"] },
        webhook: { ...channel, host: "hooks.example.com", signed: true },
        telegram: { ...channel, chat: "@my_channel" },
      },
      deliveries: [
        { id: "ndl_0123456789abcdef01234567", channel: "webhook", createdAt: AT, finishedAt: AT, status: "failed", problem: "rejected", httpStatus: 404, attempts: 4, test: false, opened: 2, closed: 0, recipient: null },
      ],
    } as NotificationSettingsDto;
    expect(NotificationSettingsDtoSchema.parse(dto)).toEqual(dto);
    expect(findForbiddenPublicDtoKeys(dto)).toEqual([]);
    expect(findPlaintextSecretKeys(dto)).toEqual([]);
    for (const extra of [{ url: "https://hooks.example.com/x" }, { signingKey: "k".repeat(16) }, { botToken: "1:a" }]) {
      const withExtra = { ...dto, channels: { ...dto.channels, webhook: { ...dto.channels.webhook, ...extra }, telegram: { ...dto.channels.telegram, ...extra } } };
      expect(NotificationSettingsDtoSchema.safeParse(withExtra).success, Object.keys(extra)[0]).toBe(false);
    }
    const empty = { ...dto, audience: "customer", channels: { email: { ...channel, recipients: null }, webhook: null, telegram: null }, deliveries: [] };
    expect(NotificationSettingsDtoSchema.safeParse(empty).success).toBe(true);
  });

  it("describe the body a webhook receives", () => {
    const events = [eventOf("site_container_down"), eventOf("backup_failed", "closed")];
    const { subject, text } = renderNotification({ locale: "en", audience: "customer", events, omitted: 0, test: false, link: null });
    const body = { version: 1, id: "ndl_0123456789abcdef01234567", sentAt: AT, audience: "customer", test: false, subject, text, events, omitted: 0 };
    expect(NotificationWebhookBodySchema.parse(body)).toEqual(body);
    expect(NotificationWebhookBodySchema.safeParse({ ...body, version: 2 }).success).toBe(false);
    expect(NotificationWebhookBodySchema.safeParse({ ...body, organizationId: "org_1" }).success).toBe(false);
    expect(findForbiddenPublicDtoKeys(body)).toEqual([]);
  });
});

describe("notification mail request", () => {
  const mail = {
    kind: "notification",
    to: "owner@example.test",
    from: "noreply@mail.example.test",
    locale: "it",
    audience: "customer",
    events: [eventOf("site_container_down"), eventOf("backup_failed", "closed")],
    omitted: 0,
    test: false,
    link: "https://panel.example.test/",
  };

  it("carries events, an audience and a link, next to the password reset", () => {
    expect(PanelMailIpcRequestSchema.parse(mail)).toEqual(mail);
    expect(NotificationMailIpcRequestSchema.parse({ ...mail, link: null })).toEqual({ ...mail, link: null });
    expect(PanelMailIpcRequestSchema.safeParse({ ...mail, test: true, events: [] }).success).toBe(true);
    const reset = { kind: "password_reset", to: mail.to, from: mail.from, locale: "en", link: "https://panel.example.test/reset-password#abc" };
    expect(PanelMailIpcRequestSchema.parse(reset)).toEqual(reset);
  });

  it.each([
    ["a subject", { subject: "Hello" }],
    ["a text", { text: "Hello" }],
    ["no event when it is not a test", { events: [] }],
    ["more events than the limit", { events: Array.from({ length: 51 }, () => eventOf("site_container_down")) }],
    ["an event with a line break in a name", { events: [{ ...eventOf("site_container_down"), site: "Shop\nBcc: x@example.test" }] }],
    ["an event with a key of its own", { events: [{ ...eventOf("site_container_down"), message: "free text" }] }],
    ["an http link", { link: "http://panel.example.test/" }],
    ["a link with a line break", { link: "https://panel.example.test/\nBcc: x@example.test" }],
    ["an unknown audience", { audience: "everyone" }],
    ["an unknown language", { locale: "de" }],
    ["a recipient with a line break", { to: "owner@example.test\nBcc: x@example.test" }],
    ["a negative count of events left out", { omitted: -1 }],
  ])("refuses %s", (_name, patch) => {
    expect(PanelMailIpcRequestSchema.safeParse({ ...mail, ...patch }).success).toBe(false);
  });

  it("gives a password reset no events and a notification no free link", () => {
    const reset = { kind: "password_reset", to: mail.to, from: mail.from, locale: "en", link: "https://panel.example.test/reset-password#abc" };
    expect(PanelMailIpcRequestSchema.safeParse({ ...reset, events: mail.events }).success).toBe(false);
    expect(PanelMailIpcRequestSchema.safeParse({ ...reset, link: null }).success).toBe(false);
    expect(PanelMailIpcRequestSchema.safeParse({ ...mail, kind: "welcome" }).success).toBe(false);
  });
});
