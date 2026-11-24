import { z } from "zod";
import {
  ALERT_KINDS, ALERT_SEVERITIES, HOST_DISK_PATHS, PANEL_COMPONENTS, type AdminAlertDto, type AlertKind,
} from "./admin-health.js";
import { OPERATION_KINDS } from "./operations.js";

/**
 * Notifications (ADR-0040): the panel tells the server administrator and each customer when an alert of the Stato
 * page opens and when it closes. This file holds what the API, the executor and the pages share: the channels,
 * the groups, the event a message is made of, and the settings a page reads and writes.
 */

export const NOTIFICATION_CHANNEL_KINDS = ["email", "webhook", "telegram"] as const;
export type NotificationChannelKind = (typeof NOTIFICATION_CHANNEL_KINDS)[number];
export const NotificationChannelKindSchema = z.enum(NOTIFICATION_CHANNEL_KINDS);

/** Who a message is written for: the server administrator, or a customer (their own sites, their own words). */
export const NOTIFICATION_AUDIENCES = ["server", "customer"] as const;
export type NotificationAudience = (typeof NOTIFICATION_AUDIENCES)[number];

export const NOTIFICATION_GROUPS = ["availability", "backups", "certificates", "server"] as const;
export type NotificationGroup = (typeof NOTIFICATION_GROUPS)[number];

/** The group of every alert kind: a new alert kind does not compile until it has one. */
export const NOTIFICATION_GROUP_OF: Readonly<Record<AlertKind, NotificationGroup>> = {
  component_down: "availability", site_container_down: "availability",
  backup_failed: "backups", backup_partial: "backups", panel_backup_failed: "backups", backup_storage_test_failed: "backups",
  backup_target_space_low: "backups", backup_site_without_target: "backups", restore_undo_incomplete: "backups", restore_stuck: "backups",
  certificate_expiring: "certificates", certificate_not_issued: "certificates", panel_certificate_expiring: "certificates",
  manual_certificate_expiring: "certificates",
  disk_high: "server", operation_unknown: "server", operation_stuck: "server",
};

/** The alert kinds a customer is told of, and only for their own sites; the rest is the administrator's work. */
export const CUSTOMER_NOTIFICATION_KINDS = [
  "site_container_down", "backup_failed", "backup_partial", "restore_undo_incomplete",
  "certificate_expiring", "certificate_not_issued", "manual_certificate_expiring",
] as const satisfies readonly AlertKind[];
export type CustomerNotificationKind = (typeof CUSTOMER_NOTIFICATION_KINDS)[number];

export const NOTIFICATION_GROUPS_OF_AUDIENCE: Readonly<Record<NotificationAudience, readonly NotificationGroup[]>> = {
  server: NOTIFICATION_GROUPS,
  customer: ["availability", "backups", "certificates"],
};

const CUSTOMER_KIND_SET: ReadonlySet<string> = new Set(CUSTOMER_NOTIFICATION_KINDS);

/** Whether an audience is ever told of an alert kind. */
export const audienceHearsKind = (audience: NotificationAudience, kind: AlertKind): boolean =>
  audience === "server" || CUSTOMER_KIND_SET.has(kind);

// ---- the event ----

export const NOTIFICATION_NAME_MAX = 80;
export const NOTIFICATION_HOST_MAX = 253;
/** Most events one message carries; what does not fit is counted in `omitted`. */
export const NOTIFICATION_MAX_EVENTS = 50;

// Control and format characters (bidirectional controls and zero-width characters among them), lone surrogates
// and the line and paragraph separators: none may reach a mail or a chat.
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const UNSAFE_TEXT_ALL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

/**
 * A name typed by a user, made safe for a message: control characters become spaces, runs of spaces collapse,
 * and the result is cut to `max` characters. Returns null when nothing is left.
 */
export function cleanNotificationText(value: string | null | undefined, max: number = NOTIFICATION_NAME_MAX): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(UNSAFE_TEXT_ALL, " ").replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

const safeText = (max: number) =>
  z.string().min(1).refine((v) => Array.from(v).length <= max, `At most ${String(max)} characters.`)
    .refine((v) => !UNSAFE_TEXT.test(v), "Control characters are not allowed.");

export const NOTIFICATION_EVENT_STATES = ["opened", "closed"] as const;
export type NotificationEventState = (typeof NOTIFICATION_EVENT_STATES)[number];

/**
 * One alert that opened or closed. A closed, flat record: the mail, the chat message and the webhook body are all
 * made from it, and nothing else typed by a user reaches them.
 */
export const NotificationEventSchema = z.object({
  /** Stable for one alert: the event that closes it carries the id of the one that opened it. */
  id: z.string().regex(/^[0-9a-f]{24}$/),
  kind: z.enum(ALERT_KINDS),
  state: z.enum(NOTIFICATION_EVENT_STATES),
  severity: z.enum(ALERT_SEVERITIES),
  site: safeText(NOTIFICATION_NAME_MAX).nullable(),
  host: safeText(NOTIFICATION_HOST_MAX).nullable(),
  /** The name of an imported certificate. */
  name: safeText(NOTIFICATION_NAME_MAX).nullable(),
  component: z.enum(PANEL_COMPONENTS).nullable(),
  disks: z.array(z.enum(HOST_DISK_PATHS)).min(1).max(HOST_DISK_PATHS.length).nullable(),
  percent: z.number().int().min(0).max(100).nullable(),
  date: z.string().datetime({ offset: true }).nullable(),
  operation: z.enum(OPERATION_KINDS).nullable(),
}).strict();
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;

/** The key one alert keeps while it stays open: its kind and its subject. */
export const notificationAlertKey = (alert: Pick<AdminAlertDto, "kind" | "subject">): string => `${alert.kind}:${alert.subject}`;

const EMPTY = { site: null, host: null, name: null, component: null, disks: null, percent: null, date: null, operation: null } as const;

/** The event of an alert as it is now. `id` is derived by the caller from the alert's key. */
export function notificationEventFromAlert(alert: AdminAlertDto, id: string, state: NotificationEventState): NotificationEvent {
  const head = { id, kind: alert.kind, state, severity: alert.severity, ...EMPTY };
  const site = (name: string | null) => cleanNotificationText(name);
  const host = (name: string) => cleanNotificationText(name, NOTIFICATION_HOST_MAX);
  switch (alert.kind) {
    case "disk_high":
      return { ...head, disks: [...alert.details.paths], percent: alert.details.usedPercent };
    case "certificate_expiring":
      return { ...head, site: site(alert.details.siteName), host: host(alert.details.hostname), date: alert.details.expiresAt };
    case "certificate_not_issued":
      return { ...head, site: site(alert.details.siteName), host: host(alert.details.hostname) };
    case "panel_certificate_expiring":
      return { ...head, host: host(alert.details.hostname), date: alert.details.expiresAt };
    case "manual_certificate_expiring":
      return { ...head, site: site(alert.details.siteName), name: cleanNotificationText(alert.details.certificateName), date: alert.details.notAfter };
    case "backup_failed":
      return { ...head, site: site(alert.details.siteName), date: alert.details.failedAt };
    case "panel_backup_failed":
      return { ...head, date: alert.details.failedAt };
    case "backup_storage_test_failed":
    case "backup_target_space_low":
      return { ...head, date: alert.details.testedAt };
    case "backup_site_without_target":
      return { ...head, site: site(alert.details.siteName) };
    case "backup_partial":
      return { ...head, site: site(alert.details.siteName), date: alert.details.at };
    case "component_down":
      return { ...head, component: alert.details.component };
    case "site_container_down":
      return { ...head, site: site(alert.details.siteName) };
    case "restore_undo_incomplete":
      return { ...head, site: site(alert.details.siteName), date: alert.details.failedAt };
    case "restore_stuck":
      return { ...head, site: site(alert.details.siteName), date: alert.details.startedAt };
    case "operation_unknown":
    case "operation_stuck":
      return { ...head, site: site(alert.details.siteName), operation: alert.details.kind };
  }
}

/** The same alert, said closed: what it was when it opened, since a closed alert is no longer there to read. */
export const closedNotificationEvent = (opened: NotificationEvent): NotificationEvent => ({ ...opened, state: "closed" });

// ---- outcome of a message ----

export const NOTIFICATION_DELIVERY_STATUSES = ["pending", "sent", "failed"] as const;
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

/** Why a message did not go; a closed list, never the other side's words. */
export const NOTIFICATION_PROBLEMS = [
  "mail_not_configured", // the mail relay is not set up or not applied
  "mail_refused", // the relay did not take the message
  "address_not_allowed", // not https to a DNS name, or the name resolves to an address the panel never calls
  "unreachable", // the name does not resolve, no connection, a TLS failure or no answer in time
  "redirect", // the other side answered with a redirect, which is not followed
  "rejected", // the other side answered 4xx
  "server_error", // the other side answered 5xx
  "expired", // retried until it was too old to be worth sending
  "channel_changed", // the channel was changed, turned off or removed before the message went
] as const;
export type NotificationProblem = (typeof NOTIFICATION_PROBLEMS)[number];

/** When a message that did not go is tried again, counted from its creation; after the last one it is not delivered. */
export const NOTIFICATION_RETRY_AFTER_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000] as const;
export const NOTIFICATION_GIVE_UP_AFTER_MS = 60 * 60_000;
export const NOTIFICATION_KEEP_DELIVERIES_MS = 30 * 24 * 60 * 60_000;
export const NOTIFICATION_PASS_INTERVAL_MS = 2 * 60_000;
/** Most messages one pass sends. */
export const NOTIFICATION_SENDS_PER_PASS = 20;
export const NOTIFICATION_TEST_EVERY_MS = 30_000;

// ---- settings ----

export const NOTIFICATION_MAX_RECIPIENTS = 5;
const GroupsSchema = z.array(z.enum(NOTIFICATION_GROUPS)).min(1).max(NOTIFICATION_GROUPS.length)
  .refine((g) => new Set(g).size === g.length, "A group is listed twice.");

const RecipientsSchema = z.array(z.string().trim().toLowerCase().email().max(254)).min(1).max(NOTIFICATION_MAX_RECIPIENTS)
  .refine((r) => new Set(r).size === r.length, "An address is listed twice.");

export const NOTIFICATION_WEBHOOK_URL_MAX = 1024;
export const NOTIFICATION_SIGNING_KEY_PATTERN = /^[\x21-\x7e]{16,128}$/;
export const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{6,12}:[A-Za-z0-9_-]{30,50}$/;
export const TELEGRAM_CHAT_PATTERN = /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

/** The address of a webhook as typed: https, a DNS name, no credentials. Where it resolves is checked by the API. */
export const NotificationWebhookUrlSchema = z.string().min(1).max(NOTIFICATION_WEBHOOK_URL_MAX).refine((value) => {
  if (!/^[\x21-\x7e]+$/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") return false;
  const host = url.hostname;
  // A DNS name with a dot: no IPv4 or IPv6 literal, no single-label name.
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host);
}, "The address must be an https:// address with a domain name, without user name or password.");

const common = { enabled: z.boolean(), groups: GroupsSchema };

/** Email of the server administrator: the addresses are typed. */
export const SaveServerEmailChannelSchema = z.object({ ...common, recipients: RecipientsSchema }).strict();
/** Email of a customer: it goes to the customer's owners, so there is no address to type. */
export const SaveCustomerEmailChannelSchema = z.object({ ...common }).strict();
/** A field left out keeps what is stored; `signingKey: null` removes the key. The address is required the first time. */
export const SaveWebhookChannelSchema = z.object({
  ...common,
  url: NotificationWebhookUrlSchema.optional(),
  signingKey: z.string().regex(NOTIFICATION_SIGNING_KEY_PATTERN).nullable().optional(),
}).strict();
/** `botToken` left out keeps the stored one; it is required the first time. */
export const SaveTelegramChannelSchema = z.object({
  ...common,
  botToken: z.string().regex(TELEGRAM_BOT_TOKEN_PATTERN).optional(),
  chat: z.string().regex(TELEGRAM_CHAT_PATTERN),
}).strict();

export type SaveServerEmailChannelInput = z.infer<typeof SaveServerEmailChannelSchema>;
export type SaveCustomerEmailChannelInput = z.infer<typeof SaveCustomerEmailChannelSchema>;
export type SaveWebhookChannelInput = z.infer<typeof SaveWebhookChannelSchema>;
export type SaveTelegramChannelInput = z.infer<typeof SaveTelegramChannelSchema>;

const IsoDateTimeSchema = z.string().datetime({ offset: true });
const channelBase = { enabled: z.boolean(), groups: z.array(z.enum(NOTIFICATION_GROUPS)), updatedAt: IsoDateTimeSchema, lastTestedAt: IsoDateTimeSchema.nullable() };

/** `recipients` is null for a customer: the mail goes to the customer's owners. */
export const NotificationEmailChannelDtoSchema = z.object({ ...channelBase, recipients: z.array(z.string()).nullable() }).strict();
/** Of the address only the host name is shown: the rest often holds a key. */
export const NotificationWebhookChannelDtoSchema = z.object({ ...channelBase, host: z.string(), signed: z.boolean() }).strict();
export const NotificationTelegramChannelDtoSchema = z.object({ ...channelBase, chat: z.string() }).strict();

export const NotificationDeliveryDtoSchema = z.object({
  id: z.string(),
  channel: NotificationChannelKindSchema,
  createdAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.nullable(),
  status: z.enum(NOTIFICATION_DELIVERY_STATUSES),
  problem: z.enum(NOTIFICATION_PROBLEMS).nullable(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  attempts: z.number().int().nonnegative(),
  test: z.boolean(),
  opened: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
  /** The address a mail went to; null for the other channels. */
  recipient: z.string().nullable(),
}).strict();
export type NotificationDeliveryDto = z.infer<typeof NotificationDeliveryDtoSchema>;

export const NotificationSettingsDtoSchema = z.object({
  audience: z.enum(NOTIFICATION_AUDIENCES),
  /** Whether the mail relay is set up: without it the email channel can be saved but nothing goes out. */
  mailReady: z.boolean(),
  groups: z.array(z.enum(NOTIFICATION_GROUPS)),
  channels: z.object({
    email: NotificationEmailChannelDtoSchema.nullable(),
    webhook: NotificationWebhookChannelDtoSchema.nullable(),
    telegram: NotificationTelegramChannelDtoSchema.nullable(),
  }).strict(),
  deliveries: z.array(NotificationDeliveryDtoSchema),
}).strict();
export type NotificationSettingsDto = z.infer<typeof NotificationSettingsDtoSchema>;

export const NotificationTestResultDtoSchema = z.object({
  outcome: z.enum(["sent", "failed"]),
  problem: z.enum(NOTIFICATION_PROBLEMS).nullable(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
}).strict();
export type NotificationTestResultDto = z.infer<typeof NotificationTestResultDtoSchema>;

/** What a webhook receives. */
export const NotificationWebhookBodySchema = z.object({
  version: z.literal(1),
  id: z.string(),
  sentAt: IsoDateTimeSchema,
  audience: z.enum(NOTIFICATION_AUDIENCES),
  test: z.boolean(),
  subject: z.string(),
  text: z.string(),
  events: z.array(NotificationEventSchema).max(NOTIFICATION_MAX_EVENTS),
  omitted: z.number().int().nonnegative(),
}).strict();
export type NotificationWebhookBody = z.infer<typeof NotificationWebhookBodySchema>;
