import {
  SaveCustomerEmailChannelSchema,
  SaveServerEmailChannelSchema,
  SaveTelegramChannelSchema,
  SaveWebhookChannelSchema,
} from "@hosting-panel/contracts";
import type { NotificationAudience, NotificationChannelKind, NotificationGroup } from "@hosting-panel/contracts";

export const NOTIFICATION_FIELDS = ["groups", "recipients", "url", "signingKey", "botToken", "chat"] as const;
export type NotificationField = (typeof NOTIFICATION_FIELDS)[number];
export type NotificationFieldErrors = Partial<Record<NotificationField, string>>;

/** What the form of one channel holds. `url`, `signingKey` and `botToken` are write-only: the API never gives them back. */
export interface NotificationFormValues {
  enabled: boolean;
  groups: readonly NotificationGroup[];
  /** Addresses as typed: one per line, or split by a comma or a semicolon. */
  recipients: string;
  url: string;
  signingKey: string;
  dropKey: boolean;
  botToken: string;
  chat: string;
}

/**
 * The body of a save (ADR-0040 N11). A write-only field left empty is left out, and the API keeps what it has;
 * `signingKey: null` removes the stored key. The groups go in the order the scope lists them.
 */
export function notificationChannelInput(
  kind: NotificationChannelKind,
  audience: NotificationAudience,
  available: readonly NotificationGroup[],
  v: NotificationFormValues,
): Record<string, unknown> {
  const common = { enabled: v.enabled, groups: available.filter((g) => v.groups.includes(g)) };
  if (kind === "email") {
    return audience === "server" ? { ...common, recipients: v.recipients.split(/[\s,;]+/).filter(Boolean) } : common;
  }
  if (kind === "webhook") {
    const key = v.dropKey ? { signingKey: null } : v.signingKey ? { signingKey: v.signingKey } : {};
    return { ...common, ...(v.url.trim() ? { url: v.url.trim() } : {}), ...key };
  }
  return { ...common, chat: v.chat.trim(), ...(v.botToken.trim() ? { botToken: v.botToken.trim() } : {}) };
}

/**
 * The form's own check before the call, with the rules the API applies. Each value is a key of the catalog's
 * `notifications.field`: the name of the field, or the API's word for a value that is missing. A webhook saved
 * for the first time needs its address, a Telegram channel its bot token. `other` says the body is wrong in a
 * way no field explains.
 */
export function notificationInputErrors(
  kind: NotificationChannelKind,
  audience: NotificationAudience,
  firstTime: boolean,
  input: Record<string, unknown>,
): { fields: NotificationFieldErrors; other: boolean } {
  const shape =
    kind === "email"
      ? audience === "server"
        ? SaveServerEmailChannelSchema
        : SaveCustomerEmailChannelSchema
      : kind === "webhook"
        ? SaveWebhookChannelSchema
        : SaveTelegramChannelSchema;
  const fields: NotificationFieldErrors = {};
  let other = false;
  const parsed = shape.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = NOTIFICATION_FIELDS.find((f) => f === issue.path[0]);
      if (field) fields[field] ??= field;
      else other = true;
    }
  }
  if (firstTime && kind === "webhook" && !("url" in input)) fields.url = "address_required";
  if (firstTime && kind === "telegram" && !("botToken" in input)) fields.botToken = "bot_token_required";
  return { fields, other };
}
