import { z } from "zod";

export const DNS_PROVIDERS = ["cloudflare", "digitalocean", "gandiv5", "hetzner", "httpreq", "ionos", "ovh"] as const;
export type DnsProvider = (typeof DNS_PROVIDERS)[number];

export interface DnsProviderField {
  name: string;
  required: boolean;
}

// lego v5.6.0 primary env names (Traefik v3.7.19); each is also read as <NAME>_FILE.
export const DNS_PROVIDER_FIELDS: Record<DnsProvider, readonly DnsProviderField[]> = {
  cloudflare: [{ name: "CLOUDFLARE_DNS_API_TOKEN", required: true }],
  digitalocean: [{ name: "DO_AUTH_TOKEN", required: true }],
  gandiv5: [{ name: "GANDIV5_PERSONAL_ACCESS_TOKEN", required: true }],
  hetzner: [{ name: "HETZNER_API_TOKEN", required: true }],
  httpreq: [
    { name: "HTTPREQ_ENDPOINT", required: true },
    { name: "HTTPREQ_USERNAME", required: false },
    { name: "HTTPREQ_PASSWORD", required: false },
  ],
  ionos: [{ name: "IONOS_API_KEY", required: true }],
  ovh: [
    { name: "OVH_ENDPOINT", required: true },
    { name: "OVH_APPLICATION_KEY", required: true },
    { name: "OVH_APPLICATION_SECRET", required: true },
    { name: "OVH_CONSUMER_KEY", required: true },
  ],
};

export const OVH_ENDPOINTS = ["ovh-eu", "ovh-ca", "ovh-us"] as const;

export type DnsFieldMessage =
  | "field_required"
  | "field_unknown"
  | "value_invalid"
  | "endpoint_invalid"
  | "ovh_endpoint_invalid"
  | "credentials_pair";

function valueMessage(name: string, value: string): DnsFieldMessage | null {
  if (name === "HTTPREQ_ENDPOINT") {
    // Printable ASCII only: no space, control or non-ASCII character in the URL.
    return /^https?:\/\/[\x21-\x7e]{1,2040}$/.test(value) ? null : "endpoint_invalid";
  }
  if (name === "OVH_ENDPOINT") {
    return (OVH_ENDPOINTS as readonly string[]).includes(value) ? null : "ovh_endpoint_invalid";
  }
  // eslint-disable-next-line no-control-regex
  const ok = value.length >= 1 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value) && value === value.trim();
  return ok ? null : "value_invalid";
}

// Messages are i18n keys and never carry the value.
export function dnsCredentialIssues(
  provider: DnsProvider,
  credentials: Readonly<Record<string, string>>,
  requireAll: boolean,
): { field: string; message: DnsFieldMessage }[] {
  const fields = DNS_PROVIDER_FIELDS[provider];
  const issues: { field: string; message: DnsFieldMessage }[] = [];
  for (const [field, value] of Object.entries(credentials)) {
    const message = fields.some((f) => f.name === field) ? valueMessage(field, value) : "field_unknown";
    if (message) issues.push({ field, message });
  }
  if (requireAll) {
    for (const f of fields) {
      if (f.required && !Object.hasOwn(credentials, f.name)) issues.push({ field: f.name, message: "field_required" });
    }
  }
  // The pair is judged on the full set: a partial input may rotate one half of a stored pair.
  if (requireAll && provider === "httpreq") {
    const hasUser = Object.hasOwn(credentials, "HTTPREQ_USERNAME");
    if (hasUser !== Object.hasOwn(credentials, "HTTPREQ_PASSWORD")) {
      issues.push({ field: hasUser ? "HTTPREQ_PASSWORD" : "HTTPREQ_USERNAME", message: "credentials_pair" });
    }
  }
  return issues;
}

export function refineDnsCredentials(requireAll: boolean) {
  return (input: { provider: DnsProvider; credentials: Record<string, string> }, ctx: z.RefinementCtx): void => {
    for (const { field, message } of dnsCredentialIssues(input.provider, input.credentials, requireAll)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["credentials", field], message });
    }
  };
}

export const DnsProviderSettingsInputSchema = z
  .object({
    provider: z.enum(DNS_PROVIDERS),
    credentials: z.record(z.string().max(64), z.string().max(2048)).default({}),
  })
  .superRefine(refineDnsCredentials(false));
export type DnsProviderSettingsInput = z.infer<typeof DnsProviderSettingsInputSchema>;

export const DnsProviderSettingsDtoSchema = z.object({
  provider: z.enum(DNS_PROVIDERS).nullable(),
  fieldsSet: z.array(z.string()),
  updatedAt: z.string().nullable(),
  applied: z.boolean(),
  ready: z.boolean().nullable(),
});
export type DnsProviderSettingsDto = z.infer<typeof DnsProviderSettingsDtoSchema>;
