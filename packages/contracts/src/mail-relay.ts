import { z } from "zod";
import { SiteDomainSchema, normalizeSiteDomain } from "./site-runtime.js";

export const MAIL_RELAY_IMAGE = "boky/postfix:5.2.1-alpine";
export const MAIL_RELAY_CONTAINER_NAME = "hp_mail_relay";
export const MAIL_RELAY_ALIAS = "hp-mail";
export const MAIL_RELAY_SMTP_PORT = 587;
export const MAIL_RELAY_PORTS = [25, 465, 587, 2525] as const;
export const MAIL_PROBLEMS = [
  "auth_failed",
  "unreachable",
  "tls_failed",
  "rejected",
  "credentials_missing",
  "other",
] as const;
export type MailProblem = (typeof MAIL_PROBLEMS)[number];

export const mailSenderAddress = (senderDomain: string): string => `noreply@${senderDomain}`;

// Messages are i18n keys and never echo the value (it may be the password).
export const MailRelayHostSchema = z.string().transform((v, ctx) => {
  const n = normalizeSiteDomain(v);
  if (n === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "host_invalid" });
    return z.NEVER;
  }
  return n;
});

export const MailSenderDomainSchema = z.string().transform((v, ctx) => {
  const r = SiteDomainSchema.safeParse(v);
  if (!r.success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sender_domain_invalid" });
    return z.NEVER;
  }
  return r.data;
});

export const MailRelayUsernameSchema = z
  .string()
  .min(1, "username_invalid")
  .max(256, "username_invalid")
  .regex(/^[^\s:]+$/, "username_invalid")
  // The value lands in a Postfix map line: refuse every control character.
  .refine((v) => ![...v].some((c) => c < " " || c === "\u007f"), "username_invalid");

export const MailRelayPasswordSchema = z
  .string()
  .min(1, "password_invalid")
  .max(256, "password_invalid")
  .regex(/^[^\r\n\0]*$/, "password_invalid")
  .refine((v) => v === v.trim(), "password_invalid");

const iso = z.string().datetime({ offset: true });
export const MailRelayPortSchema = z.union([
  z.literal(25),
  z.literal(465),
  z.literal(587),
  z.literal(2525),
]);

export const MailRelaySettingsInputSchema = z.object({
  host: MailRelayHostSchema,
  port: MailRelayPortSchema,
  username: MailRelayUsernameSchema,
  password: MailRelayPasswordSchema.optional(),
  senderDomain: MailSenderDomainSchema,
});
export type MailRelaySettingsInput = z.infer<typeof MailRelaySettingsInputSchema>;

export const MailFailureDtoSchema = z.object({
  at: iso,
  recipient: z.string().max(254),
  status: z.enum(["deferred", "bounced"]),
  problem: z.enum(MAIL_PROBLEMS),
  detail: z.string().max(300),
});
export type MailFailureDto = z.infer<typeof MailFailureDtoSchema>;

export const MailRelaySettingsDtoSchema = z.object({
  configured: z.boolean(),
  host: z.string().nullable(),
  port: z.number().int().nullable(),
  username: z.string().nullable(),
  senderDomain: z.string().nullable(),
  passwordSet: z.boolean(),
  updatedAt: z.string().nullable(),
  applied: z.boolean(),
  relayRunning: z.boolean().nullable(),
  sentLast24h: z.number().int().nullable(),
  failures: z.array(MailFailureDtoSchema),
});
export type MailRelaySettingsDto = z.infer<typeof MailRelaySettingsDtoSchema>;

export const SendTestMailInputSchema = z.object({ to: z.string().email().max(254) });

export const MailTestResultDtoSchema = z.object({
  outcome: z.enum(["sent", "deferred", "bounced", "pending"]),
  problem: z.enum(MAIL_PROBLEMS).nullable(),
  detail: z.string().max(300).nullable(),
});
export type MailTestResult = z.infer<typeof MailTestResultDtoSchema>;
