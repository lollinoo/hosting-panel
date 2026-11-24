import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import type {
  AlertKind,
  AlertSeverity,
  NotificationChannelKind,
  NotificationDeliveryStatus,
  NotificationEvent,
  NotificationGroup,
  NotificationLocale,
  NotificationProblem,
} from "@hosting-panel/contracts";
import type { DatabaseExecutor } from "./client.js";
import {
  membershipRoles,
  memberships,
  notificationChannelAlerts,
  notificationChannels,
  notificationDeliveries,
  users,
} from "./schema.js";
import { decryptSecretAesGcm, encryptSecretAesGcm } from "./secrets-crypto.js";

// Notifications (ADR-0040). `organizationId: null` is the server's scope everywhere in this file.

const newId = (prefix: string): string => `${prefix}_${randomBytes(12).toString("hex")}`;
/** The id of a message, known before the row exists: a webhook's body carries it. */
export const newNotificationDeliveryId = (): string => newId("ndl");

/** What only the sender reads: the address of a webhook with its signing key, or a bot token. Never part of a record. */
export type NotificationChannelConfig =
  | { readonly kind: "webhook"; readonly url: string; readonly signingKey: string | null }
  | { readonly kind: "telegram"; readonly botToken: string };

/** The envelope is bound to its scope and to its kind: copied onto another channel it does not open. */
export const notificationChannelSecretAad = (organizationId: string | null, kind: NotificationChannelConfig["kind"]) =>
  ({
    organizationId: organizationId ?? "platform",
    siteId: null,
    secretKey: kind === "webhook" ? "HP_NOTIFICATION_WEBHOOK" : "HP_NOTIFICATION_TELEGRAM",
  }) as const;

/** A channel as a page may see it: no address, no key, no bot token. */
export interface NotificationChannelRecord {
  readonly id: string;
  readonly organizationId: string | null;
  readonly kind: NotificationChannelKind;
  readonly enabled: boolean;
  readonly groups: NotificationGroup[];
  /** The typed addresses of the server's email; null for every other channel. */
  readonly recipients: string[] | null;
  /** The host name of a webhook's address. */
  readonly host: string | null;
  readonly chat: string | null;
  readonly signed: boolean;
  readonly locale: NotificationLocale;
  readonly lastTestedAt: Date | null;
  readonly updatedAt: Date;
}

type ChannelRow = typeof notificationChannels.$inferSelect;

const toChannel = (row: ChannelRow): NotificationChannelRecord => ({
  id: row.id,
  organizationId: row.organizationId,
  kind: row.kind,
  enabled: row.enabled,
  groups: row.groups,
  recipients: row.recipients,
  host: row.displayHost,
  chat: row.chat,
  signed: row.signed,
  locale: row.locale,
  lastTestedAt: row.lastTestedAt,
  updatedAt: row.updatedAt,
});

const inScope = (organizationId: string | null) =>
  organizationId === null ? isNull(notificationChannels.organizationId) : eq(notificationChannels.organizationId, organizationId);

export async function listNotificationChannels(db: DatabaseExecutor, organizationId: string | null): Promise<NotificationChannelRecord[]> {
  const rows = await db.select().from(notificationChannels).where(inScope(organizationId)).orderBy(asc(notificationChannels.kind));
  return rows.map(toChannel);
}

export async function getNotificationChannel(
  db: DatabaseExecutor,
  organizationId: string | null,
  kind: NotificationChannelKind,
): Promise<NotificationChannelRecord | null> {
  const [row] = await db.select().from(notificationChannels).where(and(inScope(organizationId), eq(notificationChannels.kind, kind)));
  return row ? toChannel(row) : null;
}

/** The channel as it is now, held until the caller's transaction ends: a save or a removal of it waits. null: it is gone. */
export async function lockNotificationChannel(tx: DatabaseExecutor, channelId: string): Promise<NotificationChannelRecord | null> {
  const [row] = await tx.select().from(notificationChannels).where(eq(notificationChannels.id, channelId)).for("update");
  return row ? toChannel(row) : null;
}

/** Every channel that is on, of every scope: what one pass works through. */
export async function listEnabledNotificationChannels(db: DatabaseExecutor): Promise<NotificationChannelRecord[]> {
  const rows = await db.select().from(notificationChannels).where(eq(notificationChannels.enabled, true)).orderBy(asc(notificationChannels.id));
  return rows.map(toChannel);
}

/** Decrypts. For the sender only: the result must not reach a DTO, an audit row, an operation or a log. */
export async function readNotificationChannelConfig(
  db: DatabaseExecutor,
  masterKey: string,
  channelId: string,
): Promise<NotificationChannelConfig | null> {
  const [row] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, channelId));
  if (!row || row.kind === "email" || !row.configCiphertextBase64 || !row.configIvBase64 || !row.configAuthTagBase64) return null;
  const parsed: unknown = JSON.parse(
    decryptSecretAesGcm({
      ...notificationChannelSecretAad(row.organizationId, row.kind),
      ciphertextBase64: row.configCiphertextBase64,
      ivBase64: row.configIvBase64,
      authTagBase64: row.configAuthTagBase64,
      masterKey,
    }),
  );
  const fields = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  if (row.kind === "webhook") {
    const { url, signingKey } = fields;
    if (typeof url !== "string" || (signingKey !== null && typeof signingKey !== "string")) throw new Error("Stored webhook config is malformed");
    return { kind: "webhook", url, signingKey };
  }
  if (typeof fields.botToken !== "string") throw new Error("Stored Telegram config is malformed");
  return { kind: "telegram", botToken: fields.botToken };
}

export interface SaveNotificationChannelInput {
  readonly organizationId: string | null;
  readonly kind: NotificationChannelKind;
  readonly enabled: boolean;
  readonly groups: readonly NotificationGroup[];
  readonly recipients: readonly string[] | null;
  readonly chat: string | null;
  /** The language of who saves: the one of the messages that have no panel user as recipient. */
  readonly locale: NotificationLocale;
  /** The secret part, whole. Null keeps what is stored, and is the only value for email. */
  readonly config: NotificationChannelConfig | null;
  readonly actorId: string | null;
  readonly now: Date;
}

function sealed(organizationId: string | null, config: NotificationChannelConfig, masterKey: string) {
  const plaintext = JSON.stringify(
    config.kind === "webhook" ? { url: config.url, signingKey: config.signingKey } : { botToken: config.botToken },
  );
  const env = encryptSecretAesGcm({ ...notificationChannelSecretAad(organizationId, config.kind), plaintext, masterKey });
  return {
    configCiphertextBase64: env.ciphertextBase64,
    configIvBase64: env.ivBase64,
    configAuthTagBase64: env.authTagBase64,
    configKeyVersion: env.keyVersion,
    // What a page shows is written together with the envelope, so the two never disagree.
    displayHost: config.kind === "webhook" ? new URL(config.url).hostname : null,
    signed: config.kind === "webhook" && config.signingKey !== null,
  };
}

/** Creates the channel of this kind in this scope, or changes the one that exists. */
export async function saveNotificationChannel(
  tx: DatabaseExecutor,
  masterKey: string,
  input: SaveNotificationChannelInput,
): Promise<NotificationChannelRecord> {
  if (input.config !== null && input.config.kind !== input.kind) throw new Error("The config belongs to another kind of channel");
  const fields = {
    enabled: input.enabled,
    groups: [...input.groups],
    recipients: input.recipients === null ? null : [...input.recipients],
    chat: input.chat,
    locale: input.locale,
    updatedByUserId: input.actorId,
    updatedAt: input.now,
  };
  const secret = input.config === null ? {} : sealed(input.organizationId, input.config, masterKey);
  if (input.kind === "email" || input.config !== null) {
    // Insert first: two saves at once cannot both create the channel (the unique indexes), and the loser updates.
    const [created] = await tx
      .insert(notificationChannels)
      .values({ id: newId("nch"), organizationId: input.organizationId, kind: input.kind, ...fields, ...secret, createdAt: input.now })
      .onConflictDoNothing()
      .returning();
    if (created) return toChannel(created);
  }
  const [updated] = await tx
    .update(notificationChannels)
    .set({ ...fields, ...secret })
    .where(and(inScope(input.organizationId), eq(notificationChannels.kind, input.kind)))
    .returning();
  if (!updated) throw new Error("The channel has no stored config to keep");
  return toChannel(updated);
}

/** Removes the channel with what it was told and its messages. */
export async function deleteNotificationChannel(
  tx: DatabaseExecutor,
  organizationId: string | null,
  kind: NotificationChannelKind,
): Promise<boolean> {
  const rows = await tx
    .delete(notificationChannels)
    .where(and(inScope(organizationId), eq(notificationChannels.kind, kind)))
    .returning({ id: notificationChannels.id });
  return rows.length > 0;
}

/** True when a test message may go now: one every `everyMs` for a channel, taken in one statement. */
export async function claimNotificationChannelTest(tx: DatabaseExecutor, channelId: string, now: Date, everyMs: number): Promise<boolean> {
  const rows = await tx
    .update(notificationChannels)
    .set({ lastTestedAt: now })
    .where(
      and(
        eq(notificationChannels.id, channelId),
        or(isNull(notificationChannels.lastTestedAt), lte(notificationChannels.lastTestedAt, new Date(now.getTime() - everyMs))),
      ),
    )
    .returning({ id: notificationChannels.id });
  return rows.length > 0;
}

// ---- what a channel was told ----

export interface NotificationChannelAlertRecord {
  readonly alertKey: string;
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  /** The alert as it was when the channel last heard of it. */
  readonly event: NotificationEvent;
  readonly firstSeenAt: Date;
  /** Null: seen by one pass, not told yet. */
  readonly announcedAt: Date | null;
}

export async function listNotificationChannelAlerts(db: DatabaseExecutor, channelId: string): Promise<NotificationChannelAlertRecord[]> {
  const rows = await db
    .select()
    .from(notificationChannelAlerts)
    .where(eq(notificationChannelAlerts.channelId, channelId))
    .orderBy(asc(notificationChannelAlerts.firstSeenAt), asc(notificationChannelAlerts.alertKey));
  return rows.map((row) => ({
    alertKey: row.alertKey,
    kind: row.kind,
    severity: row.severity,
    event: row.event,
    firstSeenAt: row.firstSeenAt,
    announcedAt: row.announcedAt,
  }));
}

/** Writes the row of one alert; an alert already there keeps the time it was first seen. */
export async function putNotificationChannelAlert(tx: DatabaseExecutor, channelId: string, alert: NotificationChannelAlertRecord): Promise<void> {
  const told = { kind: alert.kind, severity: alert.severity, event: alert.event, announcedAt: alert.announcedAt };
  await tx
    .insert(notificationChannelAlerts)
    .values({ channelId, alertKey: alert.alertKey, firstSeenAt: alert.firstSeenAt, ...told })
    .onConflictDoUpdate({ target: [notificationChannelAlerts.channelId, notificationChannelAlerts.alertKey], set: told });
}

/** Forgets the given alerts of a channel, or all of them with `null`. Nothing is said about them. */
export async function deleteNotificationChannelAlerts(tx: DatabaseExecutor, channelId: string, alertKeys: readonly string[] | null): Promise<number> {
  if (alertKeys !== null && alertKeys.length === 0) return 0;
  const rows = await tx
    .delete(notificationChannelAlerts)
    .where(
      alertKeys === null
        ? eq(notificationChannelAlerts.channelId, channelId)
        : and(eq(notificationChannelAlerts.channelId, channelId), inArray(notificationChannelAlerts.alertKey, [...alertKeys])),
    )
    .returning({ alertKey: notificationChannelAlerts.alertKey });
  return rows.length;
}

// ---- messages ----

export interface NotificationDeliveryRecord {
  readonly id: string;
  readonly channelId: string;
  readonly events: NotificationEvent[];
  readonly omitted: number;
  readonly opened: number;
  readonly closed: number;
  readonly test: boolean;
  /** The address of a mail; null for the other channels. */
  readonly recipient: string | null;
  readonly locale: NotificationLocale;
  readonly status: NotificationDeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly problem: NotificationProblem | null;
  readonly httpStatus: number | null;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
}

type DeliveryRow = typeof notificationDeliveries.$inferSelect;

const toDelivery = ({ openedCount, closedCount, ...row }: DeliveryRow): NotificationDeliveryRecord => ({
  ...row,
  opened: openedCount,
  closed: closedCount,
});

/** How one message ended, when it is stored already finished. */
export type NotificationDeliveryEnd =
  | { readonly status: "sent"; readonly httpStatus: number | null }
  | { readonly status: "failed"; readonly problem: NotificationProblem; readonly httpStatus: number | null };

export interface NewNotificationDelivery {
  /** Chosen by the caller when the message goes out before its row is written. */
  readonly id?: string;
  readonly channelId: string;
  readonly events: readonly NotificationEvent[];
  readonly omitted: number;
  readonly test: boolean;
  readonly recipient: string | null;
  readonly locale: NotificationLocale;
  readonly now: Date;
  /** Left out: the message waits for its first attempt, due now. Given: one attempt was made and this is how it ended. */
  readonly end?: NotificationDeliveryEnd;
}

export async function createNotificationDelivery(tx: DatabaseExecutor, input: NewNotificationDelivery): Promise<NotificationDeliveryRecord> {
  const end = input.end;
  const [row] = await tx
    .insert(notificationDeliveries)
    .values({
      id: input.id ?? newNotificationDeliveryId(),
      channelId: input.channelId,
      events: [...input.events],
      omitted: input.omitted,
      openedCount: input.events.filter((e) => e.state === "opened").length,
      closedCount: input.events.filter((e) => e.state === "closed").length,
      test: input.test,
      recipient: input.recipient,
      locale: input.locale,
      createdAt: input.now,
      ...(end === undefined
        ? { status: "pending" as const, nextAttemptAt: input.now }
        : {
            status: end.status,
            attempts: 1,
            problem: end.status === "failed" ? end.problem : null,
            httpStatus: end.httpStatus,
            finishedAt: input.now,
          }),
    })
    .returning();
  if (!row) throw new Error("The message was not stored");
  return toDelivery(row);
}

/** The waiting messages whose attempt is due, oldest first, each with its channel as it is now. */
export async function listDueNotificationDeliveries(
  db: DatabaseExecutor,
  now: Date,
  limit: number,
): Promise<Array<{ delivery: NotificationDeliveryRecord; channel: NotificationChannelRecord }>> {
  const rows = await db
    .select({ delivery: notificationDeliveries, channel: notificationChannels })
    .from(notificationDeliveries)
    .innerJoin(notificationChannels, eq(notificationChannels.id, notificationDeliveries.channelId))
    .where(and(eq(notificationDeliveries.status, "pending"), lte(notificationDeliveries.nextAttemptAt, now)))
    .orderBy(asc(notificationDeliveries.nextAttemptAt), asc(notificationDeliveries.id))
    .limit(limit);
  return rows.map((row) => ({ delivery: toDelivery(row.delivery), channel: toChannel(row.channel) }));
}

/** One message, only while it is still waiting, with its channel as it is now. null: no longer waiting, or gone. */
export async function getWaitingNotificationDelivery(
  db: DatabaseExecutor,
  deliveryId: string,
): Promise<{ delivery: NotificationDeliveryRecord; channel: NotificationChannelRecord } | null> {
  const [row] = await db
    .select({ delivery: notificationDeliveries, channel: notificationChannels })
    .from(notificationDeliveries)
    .innerJoin(notificationChannels, eq(notificationChannels.id, notificationDeliveries.channelId))
    .where(and(eq(notificationDeliveries.id, deliveryId), eq(notificationDeliveries.status, "pending")));
  return row ? { delivery: toDelivery(row.delivery), channel: toChannel(row.channel) } : null;
}

/** What became of a waiting message. `retry`: an attempt failed and another one follows. */
export type NotificationDeliveryOutcome =
  | NotificationDeliveryEnd
  /** Given up without an attempt: too old, or its channel changed. */
  | { readonly status: "dropped"; readonly problem: NotificationProblem }
  | { readonly status: "retry"; readonly problem: NotificationProblem; readonly httpStatus: number | null; readonly nextAttemptAt: Date };

/** Writes the outcome of a message that is still waiting; false when it no longer was. */
export async function recordNotificationDelivery(
  tx: DatabaseExecutor,
  deliveryId: string,
  outcome: NotificationDeliveryOutcome,
  now: Date,
): Promise<boolean> {
  const attempted = { attempts: sql`${notificationDeliveries.attempts} + 1` };
  const change =
    outcome.status === "retry"
      ? { ...attempted, problem: outcome.problem, httpStatus: outcome.httpStatus, nextAttemptAt: outcome.nextAttemptAt }
      : outcome.status === "dropped"
        ? { status: "failed" as const, problem: outcome.problem, httpStatus: null, nextAttemptAt: null, finishedAt: now }
        : {
            ...attempted,
            status: outcome.status,
            problem: outcome.status === "failed" ? outcome.problem : null,
            httpStatus: outcome.httpStatus,
            nextAttemptAt: null,
            finishedAt: now,
          };
  const rows = await tx
    .update(notificationDeliveries)
    .set(change)
    .where(and(eq(notificationDeliveries.id, deliveryId), eq(notificationDeliveries.status, "pending")))
    .returning({ id: notificationDeliveries.id });
  return rows.length > 0;
}

/** Waiting messages born before `bornBefore` are not delivered (`expired`): old news is not worth sending. */
export async function expireNotificationDeliveries(tx: DatabaseExecutor, bornBefore: Date, now: Date): Promise<number> {
  const rows = await tx
    .update(notificationDeliveries)
    .set({ status: "failed", problem: "expired", nextAttemptAt: null, finishedAt: now })
    .where(and(eq(notificationDeliveries.status, "pending"), lte(notificationDeliveries.createdAt, bornBefore)))
    .returning({ id: notificationDeliveries.id });
  return rows.length;
}

/**
 * The waiting messages of a channel that was changed or turned off are not delivered (`channel_changed`).
 * With `keepRecipients`, only the mails addressed to someone who is no longer in the list.
 */
export async function cancelNotificationDeliveries(
  tx: DatabaseExecutor,
  channelId: string,
  now: Date,
  keepRecipients: readonly string[] | null = null,
): Promise<number> {
  const waiting = and(eq(notificationDeliveries.channelId, channelId), eq(notificationDeliveries.status, "pending"));
  const rows = await tx
    .update(notificationDeliveries)
    .set({ status: "failed", problem: "channel_changed", nextAttemptAt: null, finishedAt: now })
    .where(
      keepRecipients === null || keepRecipients.length === 0
        ? waiting
        : and(waiting, notInArray(notificationDeliveries.recipient, [...keepRecipients])),
    )
    .returning({ id: notificationDeliveries.id });
  return rows.length;
}

/** A message as a page lists it: no events, only how many. */
export interface NotificationDeliveryListItem {
  readonly id: string;
  readonly channel: NotificationChannelKind;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
  readonly status: NotificationDeliveryStatus;
  readonly problem: NotificationProblem | null;
  readonly httpStatus: number | null;
  readonly attempts: number;
  readonly test: boolean;
  readonly opened: number;
  readonly closed: number;
  readonly recipient: string | null;
}

/** The latest messages of one scope, newest first, born since `since`. */
export async function listNotificationDeliveries(
  db: DatabaseExecutor,
  organizationId: string | null,
  options: { readonly since: Date; readonly limit: number },
): Promise<NotificationDeliveryListItem[]> {
  return db
    .select({
      id: notificationDeliveries.id,
      channel: notificationChannels.kind,
      createdAt: notificationDeliveries.createdAt,
      finishedAt: notificationDeliveries.finishedAt,
      status: notificationDeliveries.status,
      problem: notificationDeliveries.problem,
      httpStatus: notificationDeliveries.httpStatus,
      attempts: notificationDeliveries.attempts,
      test: notificationDeliveries.test,
      opened: notificationDeliveries.openedCount,
      closed: notificationDeliveries.closedCount,
      recipient: notificationDeliveries.recipient,
    })
    .from(notificationDeliveries)
    .innerJoin(notificationChannels, eq(notificationChannels.id, notificationDeliveries.channelId))
    .where(and(inScope(organizationId), gte(notificationDeliveries.createdAt, options.since)))
    .orderBy(desc(notificationDeliveries.createdAt), desc(notificationDeliveries.id))
    .limit(options.limit);
}

/** Removes the messages born before `bornBefore`, whatever their outcome. */
export async function pruneNotificationDeliveries(tx: DatabaseExecutor, bornBefore: Date): Promise<number> {
  const rows = await tx
    .delete(notificationDeliveries)
    .where(lt(notificationDeliveries.createdAt, bornBefore))
    .returning({ id: notificationDeliveries.id });
  return rows.length;
}

// ---- who a customer's mail goes to ----

/** The owners of a customer who can sign in, with their language: the recipients of that customer's notification mail. */
export async function listNotificationOwners(
  db: DatabaseExecutor,
  organizationId: string,
  limit: number,
): Promise<Array<{ email: string; locale: NotificationLocale }>> {
  return db
    .selectDistinct({ email: users.email, locale: users.locale })
    .from(memberships)
    .innerJoin(
      membershipRoles,
      and(eq(membershipRoles.membershipId, memberships.id), eq(membershipRoles.roleId, "role_customer_owner")),
    )
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.status, "active"), eq(users.userStatus, "active")))
    .orderBy(asc(users.email))
    .limit(limit);
}
