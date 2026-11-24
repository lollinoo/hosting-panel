import { Inject, Injectable } from "@nestjs/common";
import {
  NOTIFICATION_GROUPS_OF_AUDIENCE,
  NOTIFICATION_KEEP_DELIVERIES_MS,
  NOTIFICATION_TEST_EVERY_MS,
  NotificationChannelKindSchema,
  SaveCustomerEmailChannelSchema,
  SaveServerEmailChannelSchema,
  SaveTelegramChannelSchema,
  SaveWebhookChannelSchema,
  type NotificationChannelKind,
  type NotificationGroup,
  type NotificationSettingsDto,
  type NotificationTestResultDto,
} from "@hosting-panel/contracts";
import {
  cancelNotificationDeliveries,
  claimNotificationChannelTest,
  createNotificationDelivery,
  deleteNotificationChannel,
  deleteNotificationChannelAlerts,
  eq,
  getNotificationChannel,
  listNotificationChannels,
  listNotificationDeliveries,
  newNotificationDeliveryId,
  readNotificationChannelConfig,
  saveNotificationChannel,
  users,
  type DatabaseClient,
  type DatabaseExecutor,
  type NotificationChannelConfig,
  type NotificationChannelRecord,
} from "@hosting-panel/database";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { MailRelayService } from "../mail/mail-relay.service.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  NOTIFICATION_OUTBOUND_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import { notificationMailRecipients } from "./notification-dispatch.service.js";
import { NotificationSenderService, type NotificationSendResult } from "./notification-sender.service.js";
import type { OutboundHttpPort } from "./outbound-http.js";

/** Who asks, in which scope (`organizationId: null` is the server's), and how the change is written in the audit log. */
export interface NotificationRequestContext {
  readonly organizationId: string | null;
  readonly userId: string;
  /** Details never hold an address, a key or a bot token. */
  readonly audit: (tx: DatabaseExecutor, event: { readonly action: string; readonly details: Record<string, unknown> }) => Promise<void>;
}

export const NOTIFICATION_DELIVERIES_SHOWN = 20;
/** The target type of the audit rows and of the refusals. */
export const NOTIFICATION_CHANNEL_TARGET = "notification_channel";

const invalid = (field: string, message: string): ControlPlaneError =>
  new ControlPlaneError("VALIDATION_ERROR", message, { details: [{ field, message }] });
const noChannel = (): ControlPlaneError => new ControlPlaneError("NOT_FOUND", "notification_channel_not_found");

/** The kind a route names in its path; anything else is a channel that does not exist. */
export function notificationChannelOf(segment: string): NotificationChannelKind {
  const kind = NotificationChannelKindSchema.safeParse(segment);
  if (!kind.success) throw noChannel();
  return kind.data;
}

/** The notification settings of one scope: read, save a channel, remove it, send a test message (ADR-0040 N10). */
@Injectable()
export class NotificationSettingsService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(MailRelayService) private readonly mailRelay: MailRelayService,
    @Inject(NotificationSenderService) private readonly sender: NotificationSenderService,
    @Inject(NOTIFICATION_OUTBOUND_TOKEN) private readonly outbound: OutboundHttpPort,
  ) {}

  public async get(organizationId: string | null): Promise<NotificationSettingsDto> {
    const db = this.dbClient.db;
    const audience = organizationId === null ? "server" : "customer";
    const channels = await listNotificationChannels(db, organizationId);
    const deliveries = await listNotificationDeliveries(db, organizationId, {
      since: new Date(Date.now() - NOTIFICATION_KEEP_DELIVERIES_MS),
      limit: NOTIFICATION_DELIVERIES_SHOWN,
    });
    const of = (kind: NotificationChannelKind) => channels.find((c) => c.kind === kind) ?? null;
    const shown = (c: NotificationChannelRecord) => ({
      enabled: c.enabled,
      groups: c.groups,
      updatedAt: c.updatedAt.toISOString(),
      lastTestedAt: c.lastTestedAt?.toISOString() ?? null,
    });
    const [email, webhook, telegram] = [of("email"), of("webhook"), of("telegram")];
    return {
      audience,
      mailReady: (await this.mailRelay.customerView()).configured,
      groups: [...NOTIFICATION_GROUPS_OF_AUDIENCE[audience]],
      channels: {
        email: email && { ...shown(email), recipients: email.recipients },
        webhook: webhook && { ...shown(webhook), host: webhook.host ?? "", signed: webhook.signed },
        telegram: telegram && { ...shown(telegram), chat: telegram.chat ?? "" },
      },
      deliveries: deliveries.map((d) => ({
        ...d,
        createdAt: d.createdAt.toISOString(),
        finishedAt: d.finishedAt?.toISOString() ?? null,
      })),
    };
  }

  /** Creates or changes the channel of one kind. A secret field left out keeps what is stored. */
  public async save(ctx: NotificationRequestContext, kind: NotificationChannelKind, raw: unknown): Promise<NotificationSettingsDto> {
    const db = this.dbClient.db;
    const { organizationId } = ctx;
    const audience = organizationId === null ? "server" : "customer";
    const existing = await getNotificationChannel(db, organizationId, kind);
    let recipients: string[] | null = null;
    let chat: string | null = null;
    let config: NotificationChannelConfig | null = null;
    let enabled: boolean;
    let groups: NotificationGroup[];

    if (kind === "email") {
      if (audience === "server") {
        const input = SaveServerEmailChannelSchema.parse(raw ?? {});
        ({ enabled, groups, recipients } = input);
      } else {
        ({ enabled, groups } = SaveCustomerEmailChannelSchema.parse(raw ?? {}));
      }
    } else if (kind === "webhook") {
      const input = SaveWebhookChannelSchema.parse(raw ?? {});
      ({ enabled, groups } = input);
      if (input.url !== undefined || input.signingKey !== undefined) {
        const stored = existing ? await readNotificationChannelConfig(db, this.#masterKey(), existing.id) : null;
        const before = stored?.kind === "webhook" ? stored : null;
        const url = input.url ?? before?.url;
        if (url === undefined) throw invalid("url", "address_required");
        config = { kind, url, signingKey: input.signingKey !== undefined ? input.signingKey : (before?.signingKey ?? null) };
      } else if (!existing) {
        throw invalid("url", "address_required");
      }
      // A new address is checked before it is stored, and again at every send.
      if (input.url !== undefined) {
        const problem = await this.outbound.check(input.url);
        if (problem !== null) throw invalid("url", problem === "address_not_allowed" ? "address_not_allowed" : "address_unreachable");
      }
    } else {
      const input = SaveTelegramChannelSchema.parse(raw ?? {});
      ({ enabled, groups, chat } = input);
      if (input.botToken !== undefined) config = { kind, botToken: input.botToken };
      else if (!existing) throw invalid("botToken", "bot_token_required");
    }
    const allowed = NOTIFICATION_GROUPS_OF_AUDIENCE[audience];
    if (groups.some((g) => !allowed.includes(g))) throw invalid("groups", "group_not_available");

    // The messages with no panel user as recipient speak the language of whoever saved the channel.
    const [actor] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, ctx.userId)).limit(1);
    const locale = actor?.locale ?? "it";
    const now = new Date();
    await db.transaction(async (tx) => {
      const saved = await saveNotificationChannel(tx, this.#masterKey(), {
        organizationId, kind, enabled, groups, recipients, chat, config, locale, actorId: ctx.userId, now,
      });
      if (!saved.enabled) {
        // Turned off: it forgets what it was told and what it still had to send. Nothing is said.
        await deleteNotificationChannelAlerts(tx, saved.id, null);
        await cancelNotificationDeliveries(tx, saved.id, now);
      } else if (saved.recipients !== null) {
        // The mails that wait for an address taken off the list do not go.
        await cancelNotificationDeliveries(tx, saved.id, now, saved.recipients);
      }
      await ctx.audit(tx, { action: "notification.channel.update", details: { channel: kind, enabled, groups } });
    });
    return this.get(organizationId);
  }

  public async remove(ctx: NotificationRequestContext, kind: NotificationChannelKind): Promise<NotificationSettingsDto> {
    await this.dbClient.db.transaction(async (tx) => {
      if (!(await deleteNotificationChannel(tx, ctx.organizationId, kind))) throw noChannel();
      await ctx.audit(tx, { action: "notification.channel.delete", details: { channel: kind } });
    });
    return this.get(ctx.organizationId);
  }

  /** Sends a test message now, on the channel as it is saved, and says whether it went. */
  public async test(ctx: NotificationRequestContext, kind: NotificationChannelKind): Promise<NotificationTestResultDto> {
    const db = this.dbClient.db;
    const channel = await getNotificationChannel(db, ctx.organizationId, kind);
    if (!channel) throw noChannel();
    const to = kind === "email" ? await notificationMailRecipients(db, channel) : [{ email: null, locale: channel.locale }];
    if (to.length === 0) throw new ControlPlaneError("NOT_SUPPORTED", "notification_no_recipient");
    const now = new Date();
    if (!(await claimNotificationChannelTest(db, channel.id, now, NOTIFICATION_TEST_EVERY_MS))) {
      throw new ControlPlaneError("RATE_LIMITED", "notification_test_too_soon", { retryable: true });
    }
    let first: NotificationSendResult = { problem: null, httpStatus: null };
    let failures = 0;
    for (const recipient of to) {
      const message = { id: newNotificationDeliveryId(), events: [], omitted: 0, test: true, recipient: recipient.email, locale: recipient.locale };
      const result = await this.sender.send(channel, message, now);
      await createNotificationDelivery(db, {
        ...message,
        channelId: channel.id,
        now,
        end:
          result.problem === null
            ? { status: "sent", httpStatus: result.httpStatus }
            : { status: "failed", problem: result.problem, httpStatus: result.httpStatus },
      });
      if (result.problem !== null) failures += 1;
      // Of several mails, the answer reports the first that did not go.
      if (first.problem === null) first = result;
    }
    const outcome = failures === 0 ? "sent" : "failed";
    await ctx.audit(db, { action: "notification.channel.test", details: { channel: kind, outcome, problem: first.problem } });
    return { outcome, problem: first.problem, httpStatus: first.httpStatus };
  }

  #masterKey(): string {
    return this.config.secretsMasterKey.toString("hex");
  }
}
