import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  NOTIFICATION_GIVE_UP_AFTER_MS,
  NOTIFICATION_GROUP_OF,
  NOTIFICATION_KEEP_DELIVERIES_MS,
  NOTIFICATION_MAX_EVENTS,
  NOTIFICATION_RETRY_AFTER_MS,
  NOTIFICATION_SENDS_PER_PASS,
  audienceHearsKind,
  closedNotificationEvent,
  notificationAlertKey,
  notificationEventFromAlert,
  type AdminAlertDto,
  type NotificationEvent,
  type NotificationLocale,
} from "@hosting-panel/contracts";
import {
  createNotificationDelivery,
  deleteNotificationChannelAlerts,
  expireNotificationDeliveries,
  inArray,
  listDueNotificationDeliveries,
  listEnabledNotificationChannels,
  listNotificationChannelAlerts,
  listNotificationOwners,
  pruneNotificationDeliveries,
  putNotificationChannelAlert,
  recordNotificationDelivery,
  sites,
  type DatabaseClient,
  type DatabaseExecutor,
  type NotificationChannelRecord,
} from "@hosting-panel/database";
import { AdminHealthService, type AlertObservation } from "../health/admin-health.service.js";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";
import { NotificationSenderService, notificationAudienceOf } from "./notification-sender.service.js";

/** Most owners of one customer a mail goes to. */
export const NOTIFICATION_MAX_OWNERS = 20;

/** Stable for one alert while it stays open, and the same in the event that closes it. */
export const notificationEventId = (alertKey: string): string => createHash("sha256").update(alertKey).digest("hex").slice(0, 24);

/** Who the mail of a channel goes to now, each with the language of their messages. */
export async function notificationMailRecipients(
  db: DatabaseExecutor,
  channel: NotificationChannelRecord,
): Promise<Array<{ email: string; locale: NotificationLocale }>> {
  if (channel.organizationId === null) return (channel.recipients ?? []).map((email) => ({ email, locale: channel.locale }));
  return listNotificationOwners(db, channel.organizationId, NOTIFICATION_MAX_OWNERS);
}

/**
 * The pass of the notifications (ADR-0040 N4, N8): compares the open alerts with what every channel that is on was
 * already told, writes one message per channel for what changed, and sends the messages that are due.
 */
@Injectable()
export class NotificationDispatchService {
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #running: Promise<void> | null = null;

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(AdminHealthService) private readonly health: AdminHealthService,
    @Inject(NotificationSenderService) private readonly sender: NotificationSenderService,
  ) {}

  public startBackgroundLoop(intervalMs: number | null): void {
    if (this.#stopped || this.#timer || !intervalMs || intervalMs <= 0) return;
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    this.#timer.unref();
  }

  /** One pass. A pass that is still running is joined, not doubled. Never rejects. */
  public tick(now: Date = new Date()): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#running ??= this.#pass(now)
      .catch(() => {
        // The next pass starts from what is stored; of the failure only that it happened is logged.
        console.warn(JSON.stringify({ event: "notification_pass_failed" }));
      })
      .finally(() => (this.#running = null));
    return this.#running;
  }

  /** Resolves when the running pass, if any, has finished. */
  public async idle(): Promise<void> {
    await this.#running;
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#running;
  }

  async #pass(now: Date): Promise<void> {
    const db = this.dbClient.db;
    // With no channel on, this one read is all a pass does.
    const channels = await listEnabledNotificationChannels(db);
    if (channels.length === 0) return;

    let seen: AlertObservation | null = null;
    try {
      seen = await this.health.observe(now);
    } catch {
      // No look, no change: nothing opens and nothing closes. The messages that wait still go.
      console.warn(JSON.stringify({ event: "notification_observe_failed" }));
    }
    if (seen !== null) {
      const owners = await this.#siteOwners(seen.alerts);
      for (const channel of channels) await this.#compare(channel, seen, owners, now);
    }

    await expireNotificationDeliveries(db, new Date(now.getTime() - NOTIFICATION_GIVE_UP_AFTER_MS), now);
    for (const { delivery, channel } of await listDueNotificationDeliveries(db, now, NOTIFICATION_SENDS_PER_PASS)) {
      if (this.#stopped) return;
      // The channel as it is now: a message never goes where its channel no longer points.
      const stillWanted =
        channel.enabled &&
        (channel.kind !== "email" || (await notificationMailRecipients(db, channel)).some((r) => r.email === delivery.recipient));
      if (!stillWanted) {
        await recordNotificationDelivery(db, delivery.id, { status: "dropped", problem: "channel_changed" }, now);
        continue;
      }
      const result = await this.sender.send(channel, delivery, now);
      if (result.problem === null) {
        await recordNotificationDelivery(db, delivery.id, { status: "sent", httpStatus: result.httpStatus }, now);
        continue;
      }
      const nextAttemptAt = NOTIFICATION_RETRY_AFTER_MS.map((ms) => new Date(delivery.createdAt.getTime() + ms)).find((at) => at > now);
      await recordNotificationDelivery(
        db,
        delivery.id,
        nextAttemptAt
          ? { status: "retry", problem: result.problem, httpStatus: result.httpStatus, nextAttemptAt }
          : { status: "failed", problem: result.problem, httpStatus: result.httpStatus },
        now,
      );
    }
    await pruneNotificationDeliveries(db, new Date(now.getTime() - NOTIFICATION_KEEP_DELIVERIES_MS));
  }

  /** The customer of every site an alert names. */
  async #siteOwners(alerts: readonly AdminAlertDto[]): Promise<Map<string, string>> {
    const ids = [...new Set(alerts.map(siteOf).filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const rows = await this.dbClient.db.select({ id: sites.id, organizationId: sites.organizationId }).from(sites).where(inArray(sites.id, ids));
    return new Map(rows.map((row) => [row.id, row.organizationId]));
  }

  /** What one channel is told by this pass, written together with the message that tells it. */
  async #compare(channel: NotificationChannelRecord, seen: AlertObservation, owners: ReadonlyMap<string, string>, now: Date): Promise<void> {
    const audience = notificationAudienceOf(channel);
    const groups = new Set(channel.groups);
    const hears = (kind: AdminAlertDto["kind"]): boolean => audienceHearsKind(audience, kind) && groups.has(NOTIFICATION_GROUP_OF[kind]);
    const open = new Map<string, AdminAlertDto>();
    for (const alert of seen.alerts) {
      if (!hears(alert.kind)) continue;
      // A customer hears of their own sites only.
      if (channel.organizationId !== null && owners.get(siteOf(alert) ?? "") !== channel.organizationId) continue;
      open.set(notificationAlertKey(alert), alert);
    }

    await this.dbClient.db.transaction(async (tx) => {
      const told = await listNotificationChannelAlerts(tx, channel.id);
      const known = new Map(told.map((row) => [row.alertKey, row]));
      const opened: NotificationEvent[] = [];
      const closed: NotificationEvent[] = [];
      const forgotten: string[] = [];

      for (const [alertKey, alert] of open) {
        const row = known.get(alertKey);
        const event = notificationEventFromAlert(alert, notificationEventId(alertKey), "opened");
        const fresh = { alertKey, kind: alert.kind, severity: alert.severity, event };
        if (!row) {
          // Seen for the first time: told by the next pass, if it is still there.
          await putNotificationChannelAlert(tx, channel.id, { ...fresh, firstSeenAt: now, announcedAt: null });
        } else if (row.announcedAt === null || (row.severity === "warning" && alert.severity === "critical")) {
          opened.push(event);
          await putNotificationChannelAlert(tx, channel.id, { ...fresh, firstSeenAt: row.firstSeenAt, announcedAt: now });
        } else if (row.severity !== alert.severity) {
          // Less serious than it was told: noted, so that a later rise is told again.
          await putNotificationChannelAlert(tx, channel.id, { ...row, severity: alert.severity });
        }
      }
      for (const row of told) {
        if (open.has(row.alertKey)) continue;
        if (!hears(row.kind)) {
          // Its group was turned off: nothing is said.
          forgotten.push(row.alertKey);
        } else if (seen.unseen.has(row.alertKey) || seen.unseen.has(row.kind)) {
          // Whoever reports it did not answer: it is not there, and it is not over.
        } else {
          forgotten.push(row.alertKey);
          if (row.announcedAt !== null) closed.push(closedNotificationEvent(row.event));
        }
      }
      await deleteNotificationChannelAlerts(tx, channel.id, forgotten);

      const events = [...opened, ...closed];
      if (events.length === 0) return;
      const carried = events.slice(0, NOTIFICATION_MAX_EVENTS);
      const message = { channelId: channel.id, events: carried, omitted: events.length - carried.length, test: false, now };
      if (channel.kind !== "email") {
        await createNotificationDelivery(tx, { ...message, recipient: null, locale: channel.locale });
        return;
      }
      // One mail per address: each has its own outcome and its own language.
      for (const to of await notificationMailRecipients(tx, channel)) {
        await createNotificationDelivery(tx, { ...message, recipient: to.email, locale: to.locale });
      }
    });
  }
}

function siteOf(alert: AdminAlertDto): string | null {
  const details = alert.details as { siteId?: unknown };
  return typeof details.siteId === "string" ? details.siteId : null;
}
