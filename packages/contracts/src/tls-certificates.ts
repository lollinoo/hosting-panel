// Manual TLS certificates (ADR-0031): enums, request/response contracts and the pure checks shared by the API and the
// web. Browser-safe on purpose: zod only at run time (site-domains.ts imports this module, so a value import back would
// be a cycle), no node: builtin, no X.509 parsing (that lives in apps/api).
import { z } from "zod";
import type { CertChallenge } from "./site-domains.js";

// ---------------------------------------------------------------------------------------------------------------
// Enumerations, limits, patterns
// ---------------------------------------------------------------------------------------------------------------

/** How a domain gets its certificate: ACME (Let's Encrypt) or an imported (manual) one. */
export const TLS_CERT_MODES = ["acme", "manual"] as const;
export type TlsCertMode = (typeof TLS_CERT_MODES)[number];

export const TLS_VERSION_STATUSES = ["pending", "applying", "active", "inactive", "failed"] as const;
export type TlsVersionStatus = (typeof TLS_VERSION_STATUSES)[number];

/** Known values of a version/domain `problem` (a lowercase slug, mirrored by the database CHECK). */
export const TLS_VERSION_PROBLEMS = [
  "apply_failed",
  "sni_mismatch",
  "interrupted",
  "acme_eviction_required",
  "manual_overlap",
  "captures_host",
] as const;
export type TlsVersionProblem = (typeof TLS_VERSION_PROBLEMS)[number];

export const TLS_KEY_TYPES = ["rsa", "ec"] as const;
export type TlsKeyType = (typeof TLS_KEY_TYPES)[number];

/** Observed state of a manual certificate on a domain; null while the domain uses ACME. */
export const TLS_DOMAIN_STATES = ["applying", "active", "failed"] as const;
export type TlsDomainState = (typeof TLS_DOMAIN_STATES)[number];

export const TLS_INVENTORY_FILTERS = ["all", "manual", "automatic", "expiring", "expired"] as const;
export type TlsInventoryFilter = (typeof TLS_INVENTORY_FILTERS)[number];

/** Status of an inventory row: a manual row shows its version status, an automatic one the domain's. */
export const TLS_INVENTORY_STATUSES = [...TLS_VERSION_STATUSES, "none", "requested"] as const;
export type TlsInventoryStatus = (typeof TLS_INVENTORY_STATUSES)[number];

export const TLS_CERTIFICATE_WARNINGS = ["expiring", "expired", "covers_unassigned_domains"] as const;
export type TlsCertificateWarning = (typeof TLS_CERTIFICATE_WARNINGS)[number];

/** Total size of leafPem + chainPem + privateKeyPem, in UTF-8 bytes. */
export const TLS_PEM_MAX_BYTES = 512 * 1024;
export const TLS_MAX_INTERMEDIATES = 20;
/** A certificate that expires sooner than this is refused on import and on assignment. */
export const TLS_VALIDITY_MARGIN_MS = 86_400_000;

export const TLS_CERTIFICATE_ID_PATTERN = /^cti_[0-9a-f]{32}$/;
export const TLS_VERSION_ID_PATTERN = /^ctv_[0-9a-f]{32}$/;
export const TLS_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------------------------------------------
// Expiry tier (UTC, one function for the API alerts and the web pages)
// ---------------------------------------------------------------------------------------------------------------

export const CERTIFICATE_EXPIRY_TIERS = ["ok", "notice", "warning", "critical", "expired"] as const;
export type CertificateExpiryTier = (typeof CERTIFICATE_EXPIRY_TIERS)[number];

/** Host alerts carry only these tiers: the 30-day `notice` is shown on the certificate pages alone. */
export const CERTIFICATE_ALERT_TIERS = ["warning", "critical", "expired"] as const;
export type CertificateAlertTier = (typeof CERTIFICATE_ALERT_TIERS)[number];

const DAY_MS = 86_400_000;

/**
 * expired when `notAfter <= now`, critical within 7 days, warning within 14, notice within 30, ok beyond. `daysLeft`
 * is the floor of the remaining days (negative once expired). An unparsable date fails closed as expired.
 */
export function certificateExpiryTier(
  notAfter: string | Date,
  now: Date,
): { tier: CertificateExpiryTier; daysLeft: number } {
  const ms = new Date(notAfter).getTime() - now.getTime();
  if (Number.isNaN(ms)) {
    return { tier: "expired", daysLeft: 0 };
  }
  const daysLeft = Math.floor(ms / DAY_MS);
  if (ms <= 0) return { tier: "expired", daysLeft };
  if (ms <= 7 * DAY_MS) return { tier: "critical", daysLeft };
  if (ms <= 14 * DAY_MS) return { tier: "warning", daysLeft };
  if (ms <= 30 * DAY_MS) return { tier: "notice", daysLeft };
  return { tier: "ok", daysLeft };
}

// ---------------------------------------------------------------------------------------------------------------
// SAN cover
// ---------------------------------------------------------------------------------------------------------------

const WHITESPACE = /\s/;
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Does one DNS SAN cover a hostname? Case-insensitive; an exact name, or `*.` plus exactly one extra label. A wildcard
 * never covers the apex, a deeper name or an IPv4/IPv6 literal, and a partial (`f*.x.com`), nested or bare-TLD
 * (`*.com`) wildcard covers nothing. Nothing is trimmed: a name or SAN with whitespace covers nothing. Mirrors the
 * validator's `checkHost(..., { subject: "never", partialWildcards: false })`.
 */
export function sanCoversHostname(san: string, hostname: string): boolean {
  const name = hostname.toLowerCase();
  const pattern = san.toLowerCase();
  if (name === "" || name.includes("*") || WHITESPACE.test(name) || WHITESPACE.test(pattern)) return false;
  if (!pattern.startsWith("*.")) return pattern === name;
  if (name.includes(":") || IPV4_LITERAL.test(name)) return false;
  const base = pattern.slice(1); // ".example.com"
  const rest = base.slice(1);
  if (rest.includes("*") || !rest.includes(".") || !name.endsWith(base)) return false;
  const label = name.slice(0, name.length - base.length);
  return label !== "" && !label.includes(".");
}

// ---------------------------------------------------------------------------------------------------------------
// PEM shape (cheap structural checks, no decoding: the API validator does the X.509 work)
// ---------------------------------------------------------------------------------------------------------------

export const PEM_SHAPE_FIELDS = ["name", "leafPem", "chainPem", "privateKeyPem"] as const;
export type PemShapeField = (typeof PEM_SHAPE_FIELDS)[number];

export const PEM_SHAPE_REASONS = [
  "required",
  "too_large",
  "nul_byte",
  "not_pem",
  "wrong_block_type",
  "multiple_blocks",
  "too_many_intermediates",
  "encrypted_key",
  "format_unsupported",
  "invalid_name",
] as const;
export type PemShapeReason = (typeof PEM_SHAPE_REASONS)[number];

/**
 * Every `details[].reason` of a CERTIFICATE_* error: the shape reasons above (the API reports the same strings) plus
 * the validation, assignment and apply reasons. The web catalog is keyed by this list.
 */
export const CERTIFICATE_PROBLEM_REASONS = [
  ...PEM_SHAPE_REASONS,
  // validation of the material
  "parse_failed",
  "key_parse_failed",
  "key_algorithm",
  "key_mismatch",
  "leaf_is_ca",
  "eku_not_server_auth",
  "not_yet_valid",
  "expired",
  "expires_within_24h",
  "no_dns_san",
  "too_many_sans",
  "unsupported_wildcard",
  "san_invalid",
  "cn_not_in_san",
  "ip_san_unsupported",
  "untrusted_or_incomplete",
  "chain_expired",
  "bad_signature",
  "verify_timeout",
  "chain_invalid",
  // assignment and apply
  "not_covered",
  "domain_not_active",
  "duplicate_certificate",
  "manual_overlap",
  "captures_host",
  "acme_certificate_conflict",
  "not_served",
  "proxy_start_restored",
] as const;
export type CertificateProblemReason = (typeof CERTIFICATE_PROBLEM_REASONS)[number];

export interface PemShapeIssue {
  field: PemShapeField;
  reason: PemShapeReason;
}

const PEM_BEGIN = "-----BEGIN ";
const PEM_DASHES = "-----";
const PEM_LABEL = /^[A-Z0-9 ]{1,40}$/;
const PRIVATE_KEY_LABELS: readonly string[] = ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY"];
// Control characters other than tab/LF/CR, DEL, C1 and U+FFFD: what a PKCS#12 or DER file looks like as text.
// eslint-disable-next-line no-control-regex
const BINARY_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f�]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const LEGACY_ENCRYPTED_HEADER = /Proc-Type:\s*4,\s*ENCRYPTED/;
const NAME_MAX_LENGTH = 128;

interface PemBlock {
  label: string;
  body: string;
}

// One linear pass with indexOf: a regex with a back-reference would be quadratic on a text of unterminated markers.
function scanPem(text: string): { clean: boolean; blocks: PemBlock[] } {
  const blocks: PemBlock[] = [];
  let position = 0;
  for (;;) {
    const begin = text.indexOf(PEM_BEGIN, position);
    if (begin < 0) {
      return { clean: text.slice(position).trim() === "", blocks };
    }
    if (text.slice(position, begin).trim() !== "") {
      return { clean: false, blocks };
    }
    const labelStart = begin + PEM_BEGIN.length;
    const labelEnd = text.indexOf(PEM_DASHES, labelStart);
    if (labelEnd < 0) {
      return { clean: false, blocks };
    }
    const label = text.slice(labelStart, labelEnd);
    if (!PEM_LABEL.test(label)) {
      return { clean: false, blocks };
    }
    const bodyStart = labelEnd + PEM_DASHES.length;
    const endMarker = `${PEM_DASHES}END ${label}${PEM_DASHES}`;
    const end = text.indexOf(endMarker, bodyStart);
    if (end < 0) {
      return { clean: false, blocks };
    }
    const body = text.slice(bodyStart, end);
    if (body.includes(PEM_DASHES)) {
      return { clean: false, blocks };
    }
    blocks.push({ label, body });
    position = end + endMarker.length;
  }
}

function pemFieldReason(kind: "leaf" | "chain" | "key", text: string): PemShapeReason | null {
  if (!text.includes(PEM_BEGIN) && BINARY_CHARS.test(text)) {
    return "format_unsupported";
  }
  if (text.includes("\u0000")) {
    return "nul_byte";
  }
  const { clean, blocks } = scanPem(text);
  if (!clean) {
    return "not_pem";
  }
  if (kind === "key") {
    if (blocks.some((b) => b.label === "ENCRYPTED PRIVATE KEY" || LEGACY_ENCRYPTED_HEADER.test(b.body))) {
      return "encrypted_key";
    }
    if (blocks.some((b) => !PRIVATE_KEY_LABELS.includes(b.label))) {
      return "wrong_block_type";
    }
    if (blocks.length === 0) return "required";
    return blocks.length > 1 ? "multiple_blocks" : null;
  }
  if (blocks.some((b) => b.label !== "CERTIFICATE")) {
    return "wrong_block_type";
  }
  if (kind === "leaf") {
    if (blocks.length === 0) return "required";
    return blocks.length > 1 ? "multiple_blocks" : null;
  }
  return blocks.length > TLS_MAX_INTERMEDIATES ? "too_many_intermediates" : null;
}

/**
 * Structural check of an import form, field by field (one reason per field, in field order). `name` is checked only
 * when given (a new version has none); the leaf and the key are always required, the chain may be empty. Past
 * TLS_PEM_MAX_BYTES (the three PEM texts together, UTF-8) only `too_large` is reported, on the largest text. Reasons
 * are fixed words: a value is never echoed.
 */
export function checkPemShape(input: {
  name?: string;
  leafPem?: string;
  chainPem?: string;
  privateKeyPem?: string;
}): PemShapeIssue[] {
  const texts = [
    ["leafPem", "leaf", input.leafPem ?? ""],
    ["chainPem", "chain", input.chainPem ?? ""],
    ["privateKeyPem", "key", input.privateKeyPem ?? ""],
  ] as const;
  const encoder = new TextEncoder();
  const sizes = texts.map(([, , text]) => encoder.encode(text).length);
  if (sizes.reduce((sum, size) => sum + size, 0) > TLS_PEM_MAX_BYTES) {
    const largest = sizes.indexOf(Math.max(...sizes));
    return [{ field: texts[largest]![0], reason: "too_large" }];
  }

  const issues: PemShapeIssue[] = [];
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name === "") {
      issues.push({ field: "name", reason: "required" });
    } else if (name.length > NAME_MAX_LENGTH || CONTROL_CHARS.test(name)) {
      issues.push({ field: "name", reason: "invalid_name" });
    }
  }

  for (const [field, kind, text] of texts) {
    const reason = pemFieldReason(kind, text);
    if (reason !== null) {
      issues.push({ field, reason });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------------------------
// Requests (all strict)
// ---------------------------------------------------------------------------------------------------------------

const EntityIdSchema = z.string().min(1).max(128);
const ProblemSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const VersionIdSchema = z.string().regex(TLS_VERSION_ID_PATTERN);
const DomainChallengeSchema = z.enum(["http-01", "dns-01"] as const satisfies readonly CertChallenge[]);

const CertificateNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(NAME_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARS.test(value), { message: "Name must not contain control characters." });

// Each text is bounded here; the API bounds the three together (checkPemShape → 413).
const PEM_FIELDS = {
  format: z.literal("pem"),
  leafPem: z.string().min(1).max(TLS_PEM_MAX_BYTES),
  chainPem: z.string().max(TLS_PEM_MAX_BYTES).default(""),
  privateKeyPem: z.string().min(1).max(TLS_PEM_MAX_BYTES),
};

export const ImportTlsCertificateRequestSchema = z.object({ name: CertificateNameSchema, ...PEM_FIELDS }).strict();
export type ImportTlsCertificateRequest = z.infer<typeof ImportTlsCertificateRequestSchema>;

export const CreateTlsCertificateVersionRequestSchema = z.object(PEM_FIELDS).strict();
export type CreateTlsCertificateVersionRequest = z.infer<typeof CreateTlsCertificateVersionRequestSchema>;

const DomainIdsSchema = z
  .array(EntityIdSchema)
  .min(1)
  .max(64)
  .refine((ids) => new Set(ids).size === ids.length, { error: "domain_ids_not_distinct" })
  .optional();

/** Absent `domainIds` = every domain of the site already on the certificate. */
export const ActivateTlsVersionRequestSchema = z.object({ domainIds: DomainIdsSchema }).strict();
export type ActivateTlsVersionRequest = z.infer<typeof ActivateTlsVersionRequestSchema>;

export const SetDomainTlsRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("acme") }).strict(),
  z.object({ mode: z.literal("manual"), versionId: VersionIdSchema }).strict(),
]);
export type SetDomainTlsRequest = z.infer<typeof SetDomainTlsRequestSchema>;

// Administrator only: replacing a Let's Encrypt certificate that ties with the imported one needs a cold clean-up
// of acme.json, confirmed by typing the hostname. The two fields go together.
const EVICTION_FIELDS = {
  evictAcme: z.literal(true).optional(),
  confirmHostname: z.string().min(1).max(253).optional(),
};
const evictionIsConfirmed = (value: { evictAcme?: true; confirmHostname?: string }): boolean =>
  (value.evictAcme === true) === (value.confirmHostname !== undefined);
const EVICTION_ISSUE = { message: "evictAcme and confirmHostname go together.", path: ["confirmHostname"] };

export const AdminSetDomainTlsRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("acme"), challenge: DomainChallengeSchema.optional() }).strict(),
  z
    .object({ mode: z.literal("manual"), versionId: VersionIdSchema, ...EVICTION_FIELDS })
    .strict()
    .refine(evictionIsConfirmed, EVICTION_ISSUE),
]);
export type AdminSetDomainTlsRequest = z.infer<typeof AdminSetDomainTlsRequestSchema>;

export const AdminActivateTlsVersionRequestSchema = z
  .object({ domainIds: DomainIdsSchema, ...EVICTION_FIELDS })
  .strict()
  .refine(evictionIsConfirmed, EVICTION_ISSUE);
export type AdminActivateTlsVersionRequest = z.infer<typeof AdminActivateTlsVersionRequestSchema>;

export const AdminTlsInventoryQuerySchema = z
  .object({
    filter: z.enum(TLS_INVENTORY_FILTERS).default("all"),
    q: z.string().trim().max(253).optional(),
  })
  .strict();
export type AdminTlsInventoryQuery = z.infer<typeof AdminTlsInventoryQuerySchema>;

// ---------------------------------------------------------------------------------------------------------------
// DTOs (strict, so no PEM or ciphertext can ride along; no key named like the public-DTO blocklist)
// ---------------------------------------------------------------------------------------------------------------

export const TlsCertificateVersionDtoSchema = z
  .object({
    id: EntityIdSchema,
    versionNumber: z.number().int().positive(),
    status: z.enum(TLS_VERSION_STATUSES),
    subject: z.string(),
    issuer: z.string(),
    sanDns: z.array(z.string()),
    wildcard: z.boolean(),
    notBefore: z.string(),
    notAfter: z.string(),
    serialNumber: z.string(),
    fingerprintSha256: z.string().regex(TLS_FINGERPRINT_PATTERN),
    keyType: z.enum(TLS_KEY_TYPES),
    keyBits: z.number().int().positive(),
    createdAt: z.string(),
    activatedAt: z.string().nullable(),
    problem: ProblemSchema.nullable(),
  })
  .strict();
export type TlsCertificateVersionDto = z.infer<typeof TlsCertificateVersionDtoSchema>;

export const TlsCertificateDtoSchema = z
  .object({
    id: EntityIdSchema,
    name: z.string(),
    source: z.literal("manual"),
    createdForSiteId: EntityIdSchema.nullable(),
    activeVersionId: EntityIdSchema.nullable(),
    versions: z.array(TlsCertificateVersionDtoSchema),
    coveredDomains: z.array(
      z
        .object({
          domainId: EntityIdSchema,
          hostname: z.string(),
          assigned: z.boolean(),
          versionId: EntityIdSchema.nullable(),
        })
        .strict(),
    ),
    assignedDomains: z.array(
      z
        .object({
          domainId: EntityIdSchema,
          siteId: EntityIdSchema,
          siteName: z.string(),
          hostname: z.string(),
          versionId: EntityIdSchema,
        })
        .strict(),
    ),
    expiry: z.object({ tier: z.enum(CERTIFICATE_EXPIRY_TIERS), daysLeft: z.number().int() }).strict().nullable(),
    warnings: z.array(z.enum(TLS_CERTIFICATE_WARNINGS)),
    updatedAt: z.string(),
  })
  .strict();
export type TlsCertificateDto = z.infer<typeof TlsCertificateDtoSchema>;

/** One row of the administrator's inventory: an imported certificate or an automatic (ACME) one. */
export const AdminTlsInventoryItemDtoSchema = z
  .object({
    source: z.enum(["manual", "acme"]),
    certificateId: EntityIdSchema.nullable(),
    name: z.string().nullable(),
    organizationId: EntityIdSchema,
    organizationName: z.string(),
    siteId: EntityIdSchema.nullable(),
    siteName: z.string().nullable(),
    hostnames: z.array(z.string()),
    issuer: z.string().nullable(),
    wildcard: z.boolean(),
    notAfter: z.string().nullable(),
    status: z.enum(TLS_INVENTORY_STATUSES),
    tier: z.enum(CERTIFICATE_EXPIRY_TIERS).nullable(),
  })
  .strict();
export type AdminTlsInventoryItemDto = z.infer<typeof AdminTlsInventoryItemDtoSchema>;

export const TlsCertificateAlertDtoSchema = z
  .object({
    certificateId: EntityIdSchema,
    certificateName: z.string(),
    versionId: EntityIdSchema,
    organizationId: EntityIdSchema,
    siteId: EntityIdSchema.nullable(),
    siteName: z.string().nullable(),
    hostnames: z.array(z.string()),
    notAfter: z.string(),
    tier: z.enum(CERTIFICATE_ALERT_TIERS),
    daysLeft: z.number().int(),
  })
  .strict();
export type TlsCertificateAlertDto = z.infer<typeof TlsCertificateAlertDtoSchema>;

/** The `tls` block of a site domain. Automatic rows: `{ mode: "acme", certificateId: null, versionId: null, state: null, problem: null }`. */
export const SiteDomainTlsDtoSchema = z
  .object({
    mode: z.enum(TLS_CERT_MODES),
    certificateId: EntityIdSchema.nullable(),
    versionId: EntityIdSchema.nullable(),
    state: z.enum(TLS_DOMAIN_STATES).nullable(),
    problem: ProblemSchema.nullable(),
  })
  .strict();
export type SiteDomainTlsDto = z.infer<typeof SiteDomainTlsDtoSchema>;
