import { createHmac } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  renderNotification,
  type NotificationAudience,
  type NotificationEvent,
  type NotificationLocale,
  type NotificationProblem,
  type NotificationWebhookBody,
} from "@hosting-panel/contracts";
import { hosts, readNotificationChannelConfig, type DatabaseClient, type NotificationChannelRecord } from "@hosting-panel/database";
import { MailRelayService } from "../mail/mail-relay.service.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  NOTIFICATION_OUTBOUND_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import type { OutboundHttpPort } from "./outbound-http.js";

/** One message as it leaves: a mail to one address, one webhook call or one chat message (ADR-0040). */
export interface NotificationMessage {
  /** The id of the message; the body of a webhook carries it, to recognise a message sent twice. */
  readonly id: string;
  readonly events: readonly NotificationEvent[];
  readonly omitted: number;
  readonly test: boolean;
  /** The address of a mail; null for the other channels. */
  readonly recipient: string | null;
  readonly locale: NotificationLocale;
}

export interface NotificationSendResult {
  /** null: the message went. */
  readonly problem: NotificationProblem | null;
  readonly httpStatus: number | null;
}

export const TELEGRAM_API_ORIGIN = "https://api.telegram.org";
export const NOTIFICATION_SIGNATURE_HEADER = "X-Hosting-Panel-Signature";

/** `t=<seconds>,v1=<HMAC-SHA256, hex, of "<seconds>.<body>">`: the receiver computes the same over what it got. */
export function notificationSignature(signingKey: string, seconds: number, body: string): string {
  const mac = createHmac("sha256", signingKey).update(`${String(seconds)}.${body}`).digest("hex");
  return `t=${String(seconds)},v1=${mac}`;
}

export const notificationAudienceOf = (channel: Pick<NotificationChannelRecord, "organizationId">): NotificationAudience =>
  channel.organizationId === null ? "server" : "customer";

const failed = (problem: NotificationProblem): NotificationSendResult => ({ problem, httpStatus: null });

/** Sends one message through one channel. The words are written here and in the executor from events, never taken from a user. */
@Injectable()
export class NotificationSenderService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(MailRelayService) private readonly mailRelay: MailRelayService,
    @Inject(NOTIFICATION_OUTBOUND_TOKEN) private readonly outbound: OutboundHttpPort,
  ) {}

  /** Never throws. Mail goes through the relay; a webhook and Telegram go out from the outbound module. */
  public async send(channel: NotificationChannelRecord, message: NotificationMessage, now: Date): Promise<NotificationSendResult> {
    try {
      const audience = notificationAudienceOf(channel);
      const content = {
        locale: message.locale,
        audience,
        events: [...message.events],
        omitted: message.omitted,
        test: message.test,
        link: await this.#link(audience),
      };
      if (channel.kind === "email") {
        if (message.recipient === null) return failed("channel_changed");
        const outcome = await this.mailRelay.sendPanelMail({ kind: "notification", to: message.recipient, ...content });
        return outcome === "queued" ? { problem: null, httpStatus: null } : failed(outcome === "failed" ? "mail_refused" : "mail_not_configured");
      }
      const config = await readNotificationChannelConfig(this.dbClient.db, this.config.secretsMasterKey.toString("hex"), channel.id);
      if (config === null) return failed("channel_changed");
      const { subject, text } = renderNotification(content);
      if (config.kind === "webhook") {
        const body = JSON.stringify({
          version: 1,
          id: message.id,
          sentAt: now.toISOString(),
          audience,
          test: message.test,
          subject,
          text,
          events: content.events,
          omitted: message.omitted,
        } satisfies NotificationWebhookBody);
        const headers: Record<string, string> =
          config.signingKey === null
            ? {}
            : { [NOTIFICATION_SIGNATURE_HEADER]: notificationSignature(config.signingKey, Math.floor(now.getTime() / 1000), body) };
        return await this.outbound.postJson(config.url, body, headers);
      }
      return await this.outbound.postJson(
        `${TELEGRAM_API_ORIGIN}/bot${config.botToken}/sendMessage`,
        JSON.stringify({ chat_id: channel.chat, text: `${subject}\n\n${text}`, link_preview_options: { is_disabled: true } }),
      );
    } catch {
      // Only that it happened: what failed may hold an address or a key.
      console.warn(JSON.stringify({ event: "notification_send_failed", channel: channel.kind }));
      return failed("unreachable");
    }
  }

  /** Where a message sends its reader: the panel's saved host name, never a name from a request. */
  async #link(audience: NotificationAudience): Promise<string | null> {
    const [host] = await this.dbClient.db.select({ hostname: hosts.hostname }).from(hosts).limit(1);
    return host ? `https://${host.hostname}${audience === "server" ? "/admin/health" : "/sites"}` : null;
  }
}
