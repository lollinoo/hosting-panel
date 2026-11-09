import { z } from "zod";
import { SiteDomainSchema, normalizeSiteDomain } from "./site-runtime.js";

const EntityIdSchema = z.string().min(1).max(128);

export const DNS_STATUSES = [
  "unchecked",
  "ok",
  "not_found",
  "points_elsewhere",
  "ipv6_conflict",
  "lookup_failed",
] as const;
export type DnsStatus = (typeof DNS_STATUSES)[number];

export const CERT_STATUSES = ["none", "requested", "active", "failed"] as const;
export type CertStatus = (typeof CERT_STATUSES)[number];

export const CERT_PROBLEMS = [
  "rate_limited",
  "port_80_blocked",
  "not_pointing",
  "caa_blocked",
  "other",
] as const;
export type CertProblem = (typeof CERT_PROBLEMS)[number];

export const MAX_SITE_DOMAINS = 10;

export function wwwPartner(hostname: string): string | null {
  const partner = hostname.startsWith("www.")
    ? hostname.slice(4)
    : hostname.includes(".")
      ? `www.${hostname}`
      : null;
  return partner !== null && normalizeSiteDomain(partner) === partner ? partner : null;
}

export function suggestWwwPair(hostname: string): boolean {
  return hostname.split(".").length === 2 || hostname.startsWith("www.");
}

export function isSiteOrigin(value: string): boolean {
  const m = /^https?:\/\/([^/\s]+)$/.exec(value);
  return m !== null && normalizeSiteDomain(m[1]!) === m[1];
}

export const AddSiteDomainInputSchema = z.object({
  hostname: SiteDomainSchema,
  includeWww: z.boolean().default(false),
});
export type AddSiteDomainInput = z.infer<typeof AddSiteDomainInputSchema>;

export const SiteDomainDtoSchema = z.object({
  id: EntityIdSchema,
  hostname: z.string(),
  isPrimary: z.boolean(),
  routed: z.boolean(),
  dns: z.object({
    status: z.enum(DNS_STATUSES),
    checkedAt: z.string().nullable(),
    nextCheckAt: z.string(),
    observedA: z.array(z.string()),
    observedAaaa: z.array(z.string()),
  }),
  certificate: z.object({
    status: z.enum(CERT_STATUSES),
    problem: z.enum(CERT_PROBLEMS).nullable(),
    expiresAt: z.string().nullable(),
    retryAt: z.string().nullable(),
    trusted: z.boolean(),
  }),
});
export type SiteDomainDto = z.infer<typeof SiteDomainDtoSchema>;

export const SiteDomainsDtoSchema = z.object({
  serverIpv4: z.string(),
  routesPending: z.boolean(),
  domains: z.array(SiteDomainDtoSchema),
});
export type SiteDomainsDto = z.infer<typeof SiteDomainsDtoSchema>;

export const CertificateAlertDtoSchema = z.object({
  kind: z.enum(["expiring", "not_issued", "panel_expiring"]),
  siteId: z.string().nullable(),
  siteName: z.string().nullable(),
  hostname: z.string(),
  expiresAt: z.string().nullable(),
  problem: z.enum(CERT_PROBLEMS).nullable(),
});
export type CertificateAlertDto = z.infer<typeof CertificateAlertDtoSchema>;
