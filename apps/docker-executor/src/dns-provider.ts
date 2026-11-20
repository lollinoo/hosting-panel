import {
  DNS_PROVIDERS,
  DNS_PROVIDER_FIELDS,
  DnsProviderApplyRequestSchema,
  type DnsProvider,
  type DnsProviderApplyRequest,
} from "@hosting-panel/contracts";
import { ExecutorCodedError } from "./traefik-config.js";

export const DEFAULT_ACME_DNS_SECRET_DIR = "/run/hosting-panel/acme-dns" as const;
export const ACME_DNS_SECRET_MOUNT = "/run/secrets/hp-acme-dns" as const;
export const DNS_PROVIDER_STATE_FILE = "dns-provider.json" as const;
export const DNS_RESOLVER_NAME = "le-dns" as const;

/** What survives an executor restart: the provider and the env names it uses, never the values. */
export interface DnsProviderState {
  readonly provider: DnsProvider;
  /** Sorted env names. */
  readonly fields: readonly string[];
}

export function assertDnsProviderApplyRequest(req: unknown): DnsProviderApplyRequest {
  const parsed = DnsProviderApplyRequestSchema.safeParse(req);
  // Never echo the issues: they may quote credential values.
  if (!parsed.success) throw new ExecutorCodedError("Invalid DNS provider settings", "VALIDATION_ERROR");
  return parsed.data;
}

export function dnsProviderState(req: DnsProviderApplyRequest): DnsProviderState {
  return { provider: req.provider, fields: Object.keys(req.credentials).sort() };
}

export function parseDnsProviderState(text: string): DnsProviderState | null {
  try {
    const v = JSON.parse(text) as { provider?: unknown; fields?: unknown } | null;
    const provider = v?.provider as DnsProvider;
    if (!DNS_PROVIDERS.includes(provider) || !Array.isArray(v?.fields)) return null;
    const known = DNS_PROVIDER_FIELDS[provider];
    const fields = v.fields as unknown[];
    if (!fields.every((f) => known.some((k) => k.name === f))) return null;
    if (!known.every((k) => !k.required || fields.includes(k.name))) return null;
    return { provider, fields: [...new Set(fields as string[])].sort() };
  } catch {
    return null;
  }
}

/** Every field is a file under the read-only mount: no value ever reaches the container's Env. */
export function dnsProviderFileEnv(state: DnsProviderState): string[] {
  return [...state.fields].sort().map((name) => `${name}_FILE=${ACME_DNS_SECRET_MOUNT}/${name}`);
}
