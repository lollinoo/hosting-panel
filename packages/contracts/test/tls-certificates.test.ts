import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findForbiddenPublicDtoKeys } from "../src/resources.js";
import { CERT_CHALLENGES } from "../src/site-domains.js";
import {
  ActivateTlsVersionRequestSchema,
  AdminActivateTlsVersionRequestSchema,
  AdminSetDomainTlsRequestSchema,
  AdminTlsInventoryItemDtoSchema,
  AdminTlsInventoryQuerySchema,
  CERTIFICATE_ALERT_TIERS,
  CERTIFICATE_EXPIRY_TIERS,
  CERTIFICATE_PROBLEM_REASONS,
  CreateTlsCertificateVersionRequestSchema,
  ImportTlsCertificateRequestSchema,
  PEM_SHAPE_FIELDS,
  PEM_SHAPE_REASONS,
  SetDomainTlsRequestSchema,
  SiteDomainTlsDtoSchema,
  TLS_CERTIFICATE_ID_PATTERN,
  TLS_CERTIFICATE_WARNINGS,
  TLS_CERT_MODES,
  TLS_DOMAIN_STATES,
  TLS_FINGERPRINT_PATTERN,
  TLS_INVENTORY_FILTERS,
  TLS_INVENTORY_STATUSES,
  TLS_KEY_TYPES,
  TLS_MAX_INTERMEDIATES,
  TLS_PEM_MAX_BYTES,
  TLS_VALIDITY_MARGIN_MS,
  TLS_VERSION_ID_PATTERN,
  TLS_VERSION_PROBLEMS,
  TLS_VERSION_STATUSES,
  TlsCertificateAlertDtoSchema,
  TlsCertificateDtoSchema,
  TlsCertificateVersionDtoSchema,
  certificateExpiryTier,
  checkPemShape,
  sanCoversHostname,
} from "../src/tls-certificates.js";

const DAY = 86_400_000;
const NOW = new Date("2026-06-15T12:00:00.000Z");
const at = (ms: number): Date => new Date(NOW.getTime() + ms);

// Fake PEM blocks: the shape check never decodes the body, so no real key material exists in this file.
const block = (label: string, body = "MIIBfakefakefake"): string => `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
const CERT = block("CERTIFICATE");
const KEY = block("PRIVATE KEY");
const GOOD = { name: "Shop", leafPem: `${CERT}\n`, chainPem: "", privateKeyPem: `${KEY}\n` };

const CERT_ID = `cti_${"a".repeat(32)}`;
const VERSION_ID = `ctv_${"b".repeat(32)}`;
const FINGERPRINT = "c".repeat(64);

describe("tls constants", () => {
  it("pins the enumerations, limits and id patterns", () => {
    expect(TLS_CERT_MODES).toEqual(["acme", "manual"]);
    expect(TLS_VERSION_STATUSES).toEqual(["pending", "applying", "active", "inactive", "failed"]);
    expect(TLS_VERSION_PROBLEMS).toEqual([
      "apply_failed",
      "sni_mismatch",
      "interrupted",
      "acme_eviction_required",
      "manual_overlap",
      "captures_host",
    ]);
    expect(TLS_KEY_TYPES).toEqual(["rsa", "ec"]);
    expect(TLS_DOMAIN_STATES).toEqual(["applying", "active", "failed"]);
    expect(TLS_INVENTORY_STATUSES).toEqual(["pending", "applying", "active", "inactive", "failed", "none", "requested"]);
    expect(TLS_INVENTORY_FILTERS).toEqual(["all", "manual", "automatic", "expiring", "expired"]);
    expect(TLS_CERTIFICATE_WARNINGS).toEqual(["expiring", "expired", "covers_unassigned_domains"]);
    expect(CERTIFICATE_EXPIRY_TIERS).toEqual(["ok", "notice", "warning", "critical", "expired"]);
    expect(CERTIFICATE_ALERT_TIERS).toEqual(["warning", "critical", "expired"]);
    expect(PEM_SHAPE_FIELDS).toEqual(["name", "leafPem", "chainPem", "privateKeyPem"]);
    expect(TLS_PEM_MAX_BYTES).toBe(524_288);
    expect(TLS_MAX_INTERMEDIATES).toBe(20);
    expect(TLS_VALIDITY_MARGIN_MS).toBe(DAY);
  });

  it("id and fingerprint patterns are anchored", () => {
    expect(TLS_CERTIFICATE_ID_PATTERN.test(CERT_ID)).toBe(true);
    expect(TLS_VERSION_ID_PATTERN.test(VERSION_ID)).toBe(true);
    expect(TLS_FINGERPRINT_PATTERN.test(FINGERPRINT)).toBe(true);
    for (const bad of [`${CERT_ID}0`, `x${CERT_ID}`, `cti_${"A".repeat(32)}`, `ctv_${"a".repeat(32)}`, `cti_${"a".repeat(31)}`]) {
      expect(TLS_CERTIFICATE_ID_PATTERN.test(bad), bad).toBe(false);
    }
    for (const bad of [`${VERSION_ID}\n`, `cti_${"b".repeat(32)}`, `ctv_${"b".repeat(33)}`]) {
      expect(TLS_VERSION_ID_PATTERN.test(bad), bad).toBe(false);
    }
    for (const bad of ["c".repeat(63), "c".repeat(65), "C".repeat(64), `${"c".repeat(63)}\n`]) {
      expect(TLS_FINGERPRINT_PATTERN.test(bad), bad).toBe(false);
    }
  });
});

describe("certificateExpiryTier", () => {
  it.each([
    [31 * DAY, "ok", 31],
    [30 * DAY + 1, "ok", 30],
    [30 * DAY, "notice", 30],
    [14 * DAY + 1, "notice", 14],
    [14 * DAY, "warning", 14],
    [7 * DAY + 1, "warning", 7],
    [7 * DAY, "critical", 7],
    [1, "critical", 0],
    [0, "expired", 0],
    [-1, "expired", -1],
    [-DAY, "expired", -1],
    [-DAY - 1, "expired", -2],
  ] as const)("notAfter = now + %d ms is %s with %d days left", (offset, tier, daysLeft) => {
    expect(certificateExpiryTier(at(offset), NOW)).toEqual({ tier, daysLeft });
  });

  it("accepts an ISO string and ignores the local time zone", () => {
    expect(certificateExpiryTier("2026-06-29T12:00:00.000Z", NOW)).toEqual({ tier: "warning", daysLeft: 14 });
    expect(certificateExpiryTier("2026-06-29T14:00:00+02:00", NOW)).toEqual({ tier: "warning", daysLeft: 14 });
  });

  it("fails closed on an unparsable date", () => {
    expect(certificateExpiryTier("not a date", NOW)).toEqual({ tier: "expired", daysLeft: 0 });
  });
});

describe("sanCoversHostname", () => {
  it("matches an exact name, ignoring case", () => {
    expect(sanCoversHostname("shop.example.com", "shop.example.com")).toBe(true);
    expect(sanCoversHostname("Shop.Example.COM", "shop.example.com")).toBe(true);
    expect(sanCoversHostname("shop.example.com", "SHOP.EXAMPLE.COM")).toBe(true);
    expect(sanCoversHostname("shop.example.com", "www.example.com")).toBe(false);
    expect(sanCoversHostname("shop.example.com", "shop.example.com.")).toBe(false);
  });

  it("a wildcard covers exactly one extra label", () => {
    expect(sanCoversHostname("*.example.com", "shop.example.com")).toBe(true);
    expect(sanCoversHostname("*.example.com", "SHOP.example.com")).toBe(true);
    expect(sanCoversHostname("*.Example.com", "shop.example.com")).toBe(true);
    expect(sanCoversHostname("*.example.com", "a-b.example.com")).toBe(true);
  });

  it("a wildcard never covers the apex, a deeper name or an empty label", () => {
    expect(sanCoversHostname("*.example.com", "example.com")).toBe(false);
    expect(sanCoversHostname("*.example.com", "x.y.example.com")).toBe(false);
    expect(sanCoversHostname("*.example.com", ".example.com")).toBe(false);
    expect(sanCoversHostname("*.example.com", "badexample.com")).toBe(false);
    expect(sanCoversHostname("*.example.com", "shop.example.com.")).toBe(false);
    expect(sanCoversHostname("*.example.com", "shop.example.org")).toBe(false);
    expect(sanCoversHostname("*.example.com", "")).toBe(false);
  });

  it("never trims: a name or a SAN with whitespace covers nothing", () => {
    expect(sanCoversHostname("*.example.com", " www.example.com")).toBe(false);
    expect(sanCoversHostname("*.example.com", "www.example.com ")).toBe(false);
    expect(sanCoversHostname("*.example.com", "a b.example.com")).toBe(false);
    expect(sanCoversHostname("*.example.com", "\twww.example.com")).toBe(false);
    expect(sanCoversHostname("* .example.com", "x.example.com")).toBe(false);
    expect(sanCoversHostname(" www.example.com", " www.example.com")).toBe(false);
    expect(sanCoversHostname("www.example.com ", "www.example.com ")).toBe(false);
  });

  it("a wildcard never covers an IPv4 or IPv6 literal", () => {
    expect(sanCoversHostname("*.0.2.1", "192.0.2.1")).toBe(false);
    expect(sanCoversHostname("*.2.1", "10.0.2.1")).toBe(false);
    expect(sanCoversHostname("*.db8::1", "2001.db8::1")).toBe(false);
    expect(sanCoversHostname("*.2001:db8::1", "2001:db8::1")).toBe(false);
    expect(sanCoversHostname("*.example.com", "::1")).toBe(false);
    expect(sanCoversHostname("*.example.com", "a:b.example.com")).toBe(false);
    // a name that merely starts with digits is a host name
    expect(sanCoversHostname("*.example.com", "192.example.com")).toBe(true);
  });

  it("never matches a partial wildcard, a wildcard of a bare TLD or a nested wildcard", () => {
    expect(sanCoversHostname("f*.example.com", "foo.example.com")).toBe(false);
    expect(sanCoversHostname("*o.example.com", "foo.example.com")).toBe(false);
    expect(sanCoversHostname("shop*.example.com", "shop.example.com")).toBe(false);
    expect(sanCoversHostname("*.com", "example.com")).toBe(false);
    expect(sanCoversHostname("*.*.example.com", "a.b.example.com")).toBe(false);
    expect(sanCoversHostname("*", "example.com")).toBe(false);
    expect(sanCoversHostname("*.example.com", "*.example.com")).toBe(false);
    expect(sanCoversHostname("*.example.com", "a*.example.com")).toBe(false);
  });
});

describe("checkPemShape", () => {
  const reasons = (input: Parameters<typeof checkPemShape>[0]) => checkPemShape(input);

  it("accepts a well formed submission, with or without a name and a chain", () => {
    expect(reasons(GOOD)).toEqual([]);
    expect(reasons({ leafPem: CERT, privateKeyPem: KEY })).toEqual([]);
    expect(reasons({ ...GOOD, chainPem: `${block("CERTIFICATE")}\r\n${block("CERTIFICATE")}\r\n` })).toEqual([]);
    expect(reasons({ ...GOOD, leafPem: `\n  ${CERT}\r\n\r\n`.replaceAll("\n", "\r\n") })).toEqual([]);
    expect(reasons({ ...GOOD, chainPem: Array.from({ length: TLS_MAX_INTERMEDIATES }, () => CERT).join("\n") })).toEqual([]);
    for (const label of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY"]) {
      expect(reasons({ ...GOOD, privateKeyPem: block(label) }), label).toEqual([]);
    }
  });

  it("reports required for a missing or blank name, leaf and key, but not for the chain", () => {
    expect(reasons({ name: "", leafPem: "", chainPem: "", privateKeyPem: "" })).toEqual([
      { field: "name", reason: "required" },
      { field: "leafPem", reason: "required" },
      { field: "privateKeyPem", reason: "required" },
    ]);
    expect(reasons({ name: "  \t ", leafPem: " \n ", privateKeyPem: "\r\n" })).toEqual([
      { field: "name", reason: "required" },
      { field: "leafPem", reason: "required" },
      { field: "privateKeyPem", reason: "required" },
    ]);
    // A version form has no name: an undefined name is not checked, an undefined leaf/key is missing.
    expect(reasons({})).toEqual([
      { field: "leafPem", reason: "required" },
      { field: "privateKeyPem", reason: "required" },
    ]);
  });

  it("reports invalid_name for a name over 128 characters or with control characters", () => {
    expect(reasons({ ...GOOD, name: "n".repeat(128) })).toEqual([]);
    expect(reasons({ ...GOOD, name: `  ${"n".repeat(128)}  ` })).toEqual([]);
    for (const name of ["n".repeat(129), "a\u0000b", "a\nb", "a\tb", "a\u007fb", "a\u0085b", "a\u009fb"]) {
      expect(reasons({ ...GOOD, name }), JSON.stringify(name)).toEqual([{ field: "name", reason: "invalid_name" }]);
    }
  });

  it("measures the three PEM fields together in UTF-8 bytes", () => {
    const filler = (bytes: number) => "x".repeat(bytes);
    const used = CERT.length + KEY.length;
    const atLimit = { ...GOOD, leafPem: CERT, privateKeyPem: KEY, chainPem: filler(TLS_PEM_MAX_BYTES - used) };
    expect(reasons(atLimit).map((i) => i.reason)).not.toContain("too_large");
    expect(reasons({ ...atLimit, chainPem: filler(TLS_PEM_MAX_BYTES - used + 1) })).toEqual([
      { field: "chainPem", reason: "too_large" },
    ]);
    // 262 145 two-byte characters are 524 290 bytes but far fewer than 524 288 characters.
    expect(reasons({ ...GOOD, chainPem: "é".repeat(262_145) })).toEqual([{ field: "chainPem", reason: "too_large" }]);
    expect(reasons({ ...GOOD, chainPem: "é".repeat(262_144 - used) }).map((i) => i.reason)).not.toContain("too_large");
    // The largest field is blamed, and nothing else is reported next to it: not even a bad name.
    expect(reasons({ name: "", leafPem: filler(TLS_PEM_MAX_BYTES), privateKeyPem: KEY })).toEqual([
      { field: "leafPem", reason: "too_large" },
    ]);
    expect(reasons({ name: "a".repeat(129), leafPem: filler(TLS_PEM_MAX_BYTES), privateKeyPem: KEY })).toEqual([
      { field: "leafPem", reason: "too_large" },
    ]);
  });

  it("reports nul_byte for a NUL inside a PEM text", () => {
    expect(reasons({ ...GOOD, leafPem: block("CERTIFICATE", "MII\u0000fake") })).toEqual([{ field: "leafPem", reason: "nul_byte" }]);
    expect(reasons({ ...GOOD, chainPem: `${CERT}\n\u0000` })).toEqual([{ field: "chainPem", reason: "nul_byte" }]);
    expect(reasons({ ...GOOD, privateKeyPem: block("PRIVATE KEY", "\u0000MII") })).toEqual([
      { field: "privateKeyPem", reason: "nul_byte" },
    ]);
  });

  it("reports not_pem for text outside the BEGIN/END blocks or a broken block", () => {
    const cases: [string, string][] = [
      ["plain text", "hello world"],
      ["text after the block", `${CERT}\nextra`],
      ["text before the block", `see below\n${CERT}`],
      ["unterminated block", "-----BEGIN CERTIFICATE-----\nMIIBfake"],
      ["mismatched END label", "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END PRIVATE KEY-----"],
      ["nested marker in the body", `-----BEGIN CERTIFICATE-----\n${CERT}\n-----END CERTIFICATE-----`],
      ["bad label", "-----BEGIN cert-----\nMIIBfake\n-----END cert-----"],
      ["unicode text", "certificato è qui"],
    ];
    for (const [label, leafPem] of cases) {
      expect(reasons({ ...GOOD, leafPem }), label).toEqual([{ field: "leafPem", reason: "not_pem" }]);
    }
    expect(reasons({ ...GOOD, chainPem: "junk" })).toEqual([{ field: "chainPem", reason: "not_pem" }]);
    expect(reasons({ ...GOOD, privateKeyPem: `${KEY}\njunk` })).toEqual([{ field: "privateKeyPem", reason: "not_pem" }]);
  });

  it("reports wrong_block_type for a block of another type", () => {
    expect(reasons({ ...GOOD, leafPem: KEY })).toEqual([{ field: "leafPem", reason: "wrong_block_type" }]);
    expect(reasons({ ...GOOD, leafPem: block("X509 CRL") })).toEqual([{ field: "leafPem", reason: "wrong_block_type" }]);
    expect(reasons({ ...GOOD, leafPem: `${CERT}\n${KEY}` })).toEqual([{ field: "leafPem", reason: "wrong_block_type" }]);
    expect(reasons({ ...GOOD, chainPem: KEY })).toEqual([{ field: "chainPem", reason: "wrong_block_type" }]);
    expect(reasons({ ...GOOD, privateKeyPem: CERT })).toEqual([{ field: "privateKeyPem", reason: "wrong_block_type" }]);
    expect(reasons({ ...GOOD, privateKeyPem: block("PUBLIC KEY") })).toEqual([{ field: "privateKeyPem", reason: "wrong_block_type" }]);
    expect(reasons({ ...GOOD, privateKeyPem: block("OPENSSH PRIVATE KEY") })).toEqual([
      { field: "privateKeyPem", reason: "wrong_block_type" },
    ]);
  });

  it("reports multiple_blocks for a bundle in the leaf or two keys", () => {
    expect(reasons({ ...GOOD, leafPem: `${CERT}\n${CERT}` })).toEqual([{ field: "leafPem", reason: "multiple_blocks" }]);
    expect(reasons({ ...GOOD, privateKeyPem: `${KEY}\n${block("RSA PRIVATE KEY")}` })).toEqual([
      { field: "privateKeyPem", reason: "multiple_blocks" },
    ]);
  });

  it("reports too_many_intermediates above 20 certificates in the chain", () => {
    const chain = (count: number) => Array.from({ length: count }, () => CERT).join("\n");
    expect(reasons({ ...GOOD, chainPem: chain(TLS_MAX_INTERMEDIATES + 1) })).toEqual([
      { field: "chainPem", reason: "too_many_intermediates" },
    ]);
  });

  it("reports encrypted_key for a PKCS#8 encrypted key or a legacy encrypted header", () => {
    expect(reasons({ ...GOOD, privateKeyPem: block("ENCRYPTED PRIVATE KEY") })).toEqual([
      { field: "privateKeyPem", reason: "encrypted_key" },
    ]);
    const legacy = block("RSA PRIVATE KEY", "Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,0123456789ABCDEF\n\nMIIBfake");
    expect(reasons({ ...GOOD, privateKeyPem: legacy })).toEqual([{ field: "privateKeyPem", reason: "encrypted_key" }]);
  });

  it("reports format_unsupported for binary content such as PKCS#12 or DER", () => {
    const pfx = "0\u0082\u0006 \u0002\u0001\u0003\u0000\u0001\u0002";
    const der = "0\u0082\u0003\u0001��\u0002\u0001";
    expect(reasons({ ...GOOD, leafPem: pfx })).toEqual([{ field: "leafPem", reason: "format_unsupported" }]);
    expect(reasons({ ...GOOD, leafPem: der })).toEqual([{ field: "leafPem", reason: "format_unsupported" }]);
    expect(reasons({ ...GOOD, privateKeyPem: pfx })).toEqual([{ field: "privateKeyPem", reason: "format_unsupported" }]);
    expect(reasons({ ...GOOD, chainPem: der })).toEqual([{ field: "chainPem", reason: "format_unsupported" }]);
  });

  it("reports every failing field, in field order, one reason per field", () => {
    expect(
      reasons({ name: "", leafPem: `${CERT}\n${CERT}`, chainPem: KEY, privateKeyPem: block("ENCRYPTED PRIVATE KEY") }),
    ).toEqual([
      { field: "name", reason: "required" },
      { field: "leafPem", reason: "multiple_blocks" },
      { field: "chainPem", reason: "wrong_block_type" },
      { field: "privateKeyPem", reason: "encrypted_key" },
    ]);
  });

  it("scans a 512 KiB text full of unterminated markers in linear time", () => {
    const hostile = "-----BEGIN CERTIFICATE-----".repeat(Math.floor((TLS_PEM_MAX_BYTES - 1000) / 27));
    expect(reasons({ ...GOOD, leafPem: hostile })).toEqual([{ field: "leafPem", reason: "not_pem" }]);
  });

  it("never echoes a submitted value", () => {
    const secret = "TOPSECRETVALUE";
    const found = reasons({ name: "", leafPem: secret, chainPem: secret, privateKeyPem: block("ENCRYPTED PRIVATE KEY", secret) });
    expect(JSON.stringify(found)).not.toContain(secret);
    expect(found.every((i) => Object.keys(i).sort().join() === "field,reason")).toBe(true);
  });

  it("every PEM_SHAPE_REASONS value is produced by some input and nothing else is", () => {
    const produced = new Set<string>();
    const feed = (input: Parameters<typeof checkPemShape>[0]) => {
      for (const issue of checkPemShape(input)) produced.add(issue.reason);
    };
    feed({ name: "", leafPem: "", privateKeyPem: "" }); // required
    feed({ ...GOOD, chainPem: "x".repeat(TLS_PEM_MAX_BYTES) }); // too_large
    feed({ ...GOOD, leafPem: "\u0000" + CERT }); // nul_byte
    feed({ ...GOOD, leafPem: "junk" }); // not_pem
    feed({ ...GOOD, leafPem: KEY }); // wrong_block_type
    feed({ ...GOOD, leafPem: `${CERT}${CERT}` }); // multiple_blocks
    feed({ ...GOOD, chainPem: Array.from({ length: 21 }, () => CERT).join("\n") }); // too_many_intermediates
    feed({ ...GOOD, privateKeyPem: block("ENCRYPTED PRIVATE KEY") }); // encrypted_key
    feed({ ...GOOD, leafPem: "0\u0082\u0001" }); // format_unsupported
    feed({ ...GOOD, name: "a\u0000" }); // invalid_name
    expect([...produced].sort()).toEqual([...PEM_SHAPE_REASONS].sort());
  });
});

describe("PEM_SHAPE_REASONS and CERTIFICATE_PROBLEM_REASONS", () => {
  it("pins the shape reasons", () => {
    expect(PEM_SHAPE_REASONS).toEqual([
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
    ]);
  });

  it("the problem reasons extend the shape reasons with the validation and assignment reasons", () => {
    expect(CERTIFICATE_PROBLEM_REASONS.slice(0, PEM_SHAPE_REASONS.length)).toEqual([...PEM_SHAPE_REASONS]);
    expect(new Set(CERTIFICATE_PROBLEM_REASONS).size).toBe(CERTIFICATE_PROBLEM_REASONS.length);
    for (const reason of CERTIFICATE_PROBLEM_REASONS) {
      expect(reason, reason).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    }
    for (const reason of [
      // validator (arch-tls-api D1 + A1)
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
      // assignment and apply (arch-tls-api D6 + A3 + A5)
      "not_covered",
      "domain_not_active",
      "duplicate_certificate",
      "manual_overlap",
      "captures_host",
      "acme_certificate_conflict",
      "not_served",
      "proxy_start_restored",
    ]) {
      expect(CERTIFICATE_PROBLEM_REASONS, reason).toContain(reason);
    }
  });
});

describe("tls requests", () => {
  const importBody = { name: "Shop", format: "pem", leafPem: CERT, chainPem: CERT, privateKeyPem: KEY };

  it("parses an import and defaults the chain to an empty string", () => {
    expect(ImportTlsCertificateRequestSchema.parse(importBody)).toEqual(importBody);
    const { chainPem: _chain, ...noChain } = importBody;
    expect(ImportTlsCertificateRequestSchema.parse(noChain)).toEqual({ ...noChain, chainPem: "" });
  });

  it("trims the name and bounds it to 1..128 without control characters", () => {
    expect(ImportTlsCertificateRequestSchema.parse({ ...importBody, name: "  Shop  " }).name).toBe("Shop");
    expect(ImportTlsCertificateRequestSchema.parse({ ...importBody, name: "n".repeat(128) }).name).toHaveLength(128);
    for (const name of ["", "   ", "n".repeat(129), "a\u0000b", "a\nb", "a\u0085b", 5]) {
      expect(ImportTlsCertificateRequestSchema.safeParse({ ...importBody, name }).success, JSON.stringify(name)).toBe(false);
    }
  });

  it("accepts the PEM format only, and bounds each PEM text", () => {
    for (const format of ["pfx", "p12", "PEM", "", undefined]) {
      expect(ImportTlsCertificateRequestSchema.safeParse({ ...importBody, format }).success, String(format)).toBe(false);
    }
    expect(ImportTlsCertificateRequestSchema.safeParse({ ...importBody, leafPem: "x".repeat(TLS_PEM_MAX_BYTES) }).success).toBe(true);
    for (const key of ["leafPem", "chainPem", "privateKeyPem"]) {
      expect(ImportTlsCertificateRequestSchema.safeParse({ ...importBody, [key]: "x".repeat(TLS_PEM_MAX_BYTES + 1) }).success, key).toBe(false);
    }
    expect(ImportTlsCertificateRequestSchema.safeParse({ ...importBody, leafPem: "" }).success).toBe(false);
    expect(ImportTlsCertificateRequestSchema.safeParse({ ...importBody, privateKeyPem: "" }).success).toBe(false);
    expect(ImportTlsCertificateRequestSchema.safeParse({ ...importBody, privateKeyPem: undefined }).success).toBe(false);
  });

  it("is strict: no extra key, no key in other words", () => {
    for (const extra of [{ extra: 1 }, { privateKey: KEY }, { keyPem: KEY }, { passphrase: "x" }, { organizationId: "org" }]) {
      expect(ImportTlsCertificateRequestSchema.safeParse({ ...importBody, ...extra }).success, Object.keys(extra)[0]).toBe(false);
    }
  });

  it("a new version has the import fields without the name, and is strict", () => {
    const { name: _name, ...versionBody } = importBody;
    expect(CreateTlsCertificateVersionRequestSchema.parse(versionBody)).toEqual(versionBody);
    expect(CreateTlsCertificateVersionRequestSchema.parse({ ...versionBody, chainPem: undefined }).chainPem).toBe("");
    expect(CreateTlsCertificateVersionRequestSchema.safeParse(importBody).success).toBe(false);
    expect(CreateTlsCertificateVersionRequestSchema.safeParse({ ...versionBody, format: "pfx" }).success).toBe(false);
    expect(CreateTlsCertificateVersionRequestSchema.safeParse({ ...versionBody, extra: 1 }).success).toBe(false);
  });

  it("activation refuses a repeated domain id, for the customer and the admin request", () => {
    for (const schema of [ActivateTlsVersionRequestSchema, AdminActivateTlsVersionRequestSchema]) {
      expect(schema.safeParse({ domainIds: ["dom_1", "dom_1"] }).success).toBe(false);
      expect(schema.safeParse({ domainIds: ["dom_1", "dom_2", "dom_1"] }).success).toBe(false);
      expect(schema.safeParse({ domainIds: ["dom_1", "dom_2"] }).success).toBe(true);
      expect(schema.safeParse({ domainIds: ["dom_1", "DOM_1"] }).success).toBe(true);
    }
  });

  it("activation takes an optional list of 1..64 domain ids and nothing else", () => {
    expect(ActivateTlsVersionRequestSchema.parse({})).toEqual({});
    expect(ActivateTlsVersionRequestSchema.parse({ domainIds: ["dom_1"] })).toEqual({ domainIds: ["dom_1"] });
    expect(ActivateTlsVersionRequestSchema.safeParse({ domainIds: Array.from({ length: 64 }, (_, i) => `dom_${i}`) }).success).toBe(true);
    for (const bad of [
      { domainIds: [] },
      { domainIds: Array.from({ length: 65 }, (_, i) => `dom_${i}`) },
      { domainIds: [""] },
      { domainIds: ["d".repeat(129)] },
      { domainIds: [1] },
      { domainIds: "dom_1" },
      { versionId: VERSION_ID },
      { evictAcme: true },
      { confirmHostname: "example.com" },
    ]) {
      expect(ActivateTlsVersionRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("a customer domain request is acme or manual with a version id, strictly", () => {
    expect(SetDomainTlsRequestSchema.parse({ mode: "acme" })).toEqual({ mode: "acme" });
    expect(SetDomainTlsRequestSchema.parse({ mode: "manual", versionId: VERSION_ID })).toEqual({ mode: "manual", versionId: VERSION_ID });
    for (const bad of [
      {},
      { mode: "manual" },
      { mode: "manual", versionId: CERT_ID },
      { mode: "manual", versionId: "x" },
      { mode: "manual", certificateId: CERT_ID },
      { mode: "acme", versionId: VERSION_ID },
      { mode: "acme", challenge: "dns-01" },
      { mode: "manual", versionId: VERSION_ID, challenge: "dns-01" },
      { mode: "manual", versionId: VERSION_ID, evictAcme: true, confirmHostname: "example.com" },
      { mode: "pfx", versionId: VERSION_ID },
    ]) {
      expect(SetDomainTlsRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("an admin domain request adds the challenge to the acme branch, accepting exactly the domain challenges", () => {
    expect(AdminSetDomainTlsRequestSchema.parse({ mode: "acme" })).toEqual({ mode: "acme" });
    for (const challenge of CERT_CHALLENGES) {
      expect(AdminSetDomainTlsRequestSchema.parse({ mode: "acme", challenge })).toEqual({ mode: "acme", challenge });
    }
    expect(AdminSetDomainTlsRequestSchema.safeParse({ mode: "acme", challenge: "tls-alpn-01" }).success).toBe(false);
    expect(AdminSetDomainTlsRequestSchema.safeParse({ mode: "manual", versionId: VERSION_ID, challenge: "dns-01" }).success).toBe(false);
    expect(AdminSetDomainTlsRequestSchema.safeParse({ mode: "acme", challenge: "dns-01", extra: 1 }).success).toBe(false);
    expect(AdminSetDomainTlsRequestSchema.safeParse({ mode: "manual" }).success).toBe(false);
  });

  it("only an admin may ask to evict the automatic certificate, and must confirm the hostname", () => {
    const manual = { mode: "manual", versionId: VERSION_ID } as const;
    expect(AdminSetDomainTlsRequestSchema.parse(manual)).toEqual(manual);
    const evict = { ...manual, evictAcme: true, confirmHostname: "shop.example.com" };
    expect(AdminSetDomainTlsRequestSchema.parse(evict)).toEqual(evict);
    for (const bad of [
      { ...manual, evictAcme: true },
      { ...manual, confirmHostname: "shop.example.com" },
      { ...manual, evictAcme: false, confirmHostname: "shop.example.com" },
      { ...manual, evictAcme: "true", confirmHostname: "shop.example.com" },
      { ...manual, evictAcme: true, confirmHostname: "" },
      { ...manual, evictAcme: true, confirmHostname: "h".repeat(254) },
    ]) {
      expect(AdminSetDomainTlsRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }

    expect(AdminActivateTlsVersionRequestSchema.parse({})).toEqual({});
    expect(AdminActivateTlsVersionRequestSchema.parse({ domainIds: ["dom_1"], evictAcme: true, confirmHostname: "shop.example.com" })).toEqual({
      domainIds: ["dom_1"],
      evictAcme: true,
      confirmHostname: "shop.example.com",
    });
    for (const bad of [{ evictAcme: true }, { confirmHostname: "shop.example.com" }, { domainIds: [] }, { extra: 1 }]) {
      expect(AdminActivateTlsVersionRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("the inventory query defaults to all and bounds q to 253 characters", () => {
    expect(AdminTlsInventoryQuerySchema.parse({})).toEqual({ filter: "all" });
    for (const filter of TLS_INVENTORY_FILTERS) {
      expect(AdminTlsInventoryQuerySchema.parse({ filter, q: "shop" })).toEqual({ filter, q: "shop" });
    }
    expect(AdminTlsInventoryQuerySchema.parse({ q: "  shop  " }).q).toBe("shop");
    expect(AdminTlsInventoryQuerySchema.safeParse({ q: "q".repeat(253) }).success).toBe(true);
    for (const bad of [{ filter: "none" }, { q: "q".repeat(254) }, { sort: "notAfter" }, { filter: 1 }]) {
      expect(AdminTlsInventoryQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("tls DTOs", () => {
  const version = {
    id: VERSION_ID,
    versionNumber: 1,
    status: "active",
    subject: "CN=shop.example.com",
    issuer: "CN=Example CA",
    sanDns: ["shop.example.com", "*.shop.example.com"],
    wildcard: true,
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: "2027-01-01T00:00:00.000Z",
    serialNumber: "0A1B2C",
    fingerprintSha256: FINGERPRINT,
    keyType: "ec",
    keyBits: 256,
    createdAt: "2026-01-02T00:00:00.000Z",
    activatedAt: "2026-01-03T00:00:00.000Z",
    problem: null,
  };
  const certificate = {
    id: CERT_ID,
    name: "Shop",
    source: "manual",
    createdForSiteId: "site_1",
    activeVersionId: VERSION_ID,
    versions: [version],
    coveredDomains: [{ domainId: "dom_1", hostname: "shop.example.com", assigned: true, versionId: VERSION_ID }],
    assignedDomains: [{ domainId: "dom_1", siteId: "site_1", siteName: "Shop", hostname: "shop.example.com", versionId: VERSION_ID }],
    expiry: { tier: "ok", daysLeft: 200 },
    warnings: ["covers_unassigned_domains"],
    updatedAt: "2026-01-03T00:00:00.000Z",
  };
  const inventoryItem = {
    source: "manual",
    certificateId: CERT_ID,
    name: "Shop",
    organizationId: "org_1",
    organizationName: "Acme",
    siteId: "site_1",
    siteName: "Shop",
    hostnames: ["shop.example.com"],
    issuer: "CN=Example CA",
    wildcard: false,
    notAfter: "2027-01-01T00:00:00.000Z",
    status: "active",
    tier: "ok",
  };
  const domainTls = { mode: "manual", certificateId: CERT_ID, versionId: VERSION_ID, state: "active", problem: null };
  const alert = {
    certificateId: CERT_ID,
    certificateName: "Shop",
    versionId: VERSION_ID,
    organizationId: "org_1",
    siteId: "site_1",
    siteName: "Shop",
    hostnames: ["shop.example.com"],
    notAfter: "2026-06-20T00:00:00.000Z",
    tier: "critical",
    daysLeft: 4,
  };

  it("parses a version, a certificate, an inventory item, an alert and a domain block", () => {
    expect(TlsCertificateVersionDtoSchema.parse(version)).toEqual(version);
    expect(TlsCertificateDtoSchema.parse(certificate)).toEqual(certificate);
    expect(AdminTlsInventoryItemDtoSchema.parse(inventoryItem)).toEqual(inventoryItem);
    expect(TlsCertificateAlertDtoSchema.parse(alert)).toEqual(alert);
    expect(SiteDomainTlsDtoSchema.parse(domainTls)).toEqual(domainTls);
  });

  it("parses the nullable variants", () => {
    expect(TlsCertificateVersionDtoSchema.parse({ ...version, status: "failed", activatedAt: null, problem: "apply_failed" }).problem).toBe("apply_failed");
    expect(TlsCertificateDtoSchema.parse({ ...certificate, createdForSiteId: null, activeVersionId: null, expiry: null, versions: [], warnings: [] }).expiry).toBeNull();
    expect(
      AdminTlsInventoryItemDtoSchema.parse({
        ...inventoryItem,
        source: "acme",
        certificateId: null,
        name: null,
        siteId: null,
        siteName: null,
        issuer: null,
        notAfter: null,
        status: "requested",
        tier: null,
      }).tier,
    ).toBeNull();
  });

  it("parses an automatic domain and every domain state", () => {
    expect(SiteDomainTlsDtoSchema.parse({ mode: "acme", certificateId: null, versionId: null, state: null, problem: null }).mode).toBe("acme");
    for (const state of TLS_DOMAIN_STATES) {
      expect(SiteDomainTlsDtoSchema.safeParse({ ...domainTls, state }).success, state).toBe(true);
    }
    expect(SiteDomainTlsDtoSchema.safeParse({ ...domainTls, problem: "apply_failed" }).success).toBe(true);
  });

  it("closes every enumeration", () => {
    for (const bad of [{ status: "removed" }, { keyType: "ed25519" }, { keyBits: 0 }, { versionNumber: 0 }, { fingerprintSha256: "abc" }, { problem: "Apply Failed" }, { problem: "x".repeat(65) }, { sanDns: "shop.example.com" }]) {
      expect(TlsCertificateVersionDtoSchema.safeParse({ ...version, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    for (const bad of [{ source: "acme" }, { expiry: { tier: "soon", daysLeft: 1 } }, { warnings: ["nope"] }, { id: "" }]) {
      expect(TlsCertificateDtoSchema.safeParse({ ...certificate, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    for (const bad of [{ source: "other" }, { status: "revoked" }, { tier: "soon" }, { certificateId: "" }]) {
      expect(AdminTlsInventoryItemDtoSchema.safeParse({ ...inventoryItem, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    // The 30-day tier is for the certificate pages only: a host alert never carries it.
    for (const tier of ["ok", "notice"]) {
      expect(TlsCertificateAlertDtoSchema.safeParse({ ...alert, tier }).success, tier).toBe(false);
    }
    for (const tier of CERTIFICATE_ALERT_TIERS) {
      expect(TlsCertificateAlertDtoSchema.safeParse({ ...alert, tier }).success, tier).toBe(true);
    }
    for (const bad of [{ mode: "pfx" }, { state: "pending" }, { problem: "UPPER" }, { certificateId: "" }]) {
      expect(SiteDomainTlsDtoSchema.safeParse({ ...domainTls, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("rejects any extra key, so no PEM or ciphertext can ride along", () => {
    for (const extra of [{ privateKeyPem: KEY }, { leafPem: CERT }, { keyPem: KEY }, { ciphertext: "x" }, { privateKey: KEY }]) {
      expect(TlsCertificateVersionDtoSchema.safeParse({ ...version, ...extra }).success, Object.keys(extra)[0]).toBe(false);
      expect(TlsCertificateDtoSchema.safeParse({ ...certificate, ...extra }).success, Object.keys(extra)[0]).toBe(false);
      expect(AdminTlsInventoryItemDtoSchema.safeParse({ ...inventoryItem, ...extra }).success, Object.keys(extra)[0]).toBe(false);
      expect(TlsCertificateAlertDtoSchema.safeParse({ ...alert, ...extra }).success, Object.keys(extra)[0]).toBe(false);
      expect(SiteDomainTlsDtoSchema.safeParse({ ...domainTls, ...extra }).success, Object.keys(extra)[0]).toBe(false);
    }
    expect(TlsCertificateDtoSchema.safeParse({ ...certificate, versions: [{ ...version, privateKeyPem: KEY }] }).success).toBe(false);
    expect(TlsCertificateDtoSchema.safeParse({ ...certificate, coveredDomains: [{ ...certificate.coveredDomains[0], extra: 1 }] }).success).toBe(false);
  });

  it("no DTO key is one the public-DTO boundary blocks", () => {
    for (const dto of [version, certificate, inventoryItem, alert, domainTls]) {
      expect(findForbiddenPublicDtoKeys(dto)).toEqual([]);
    }
  });
});

describe("module hygiene", () => {
  const source = readFileSync(new URL("../src/tls-certificates.ts", import.meta.url), "utf8");

  it("is browser safe: no node builtin, no Buffer, no process, no require", () => {
    expect(source).not.toMatch(/["']node:/);
    expect(source).not.toMatch(/\bBuffer\b/);
    expect(source).not.toMatch(/\bprocess\./);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });

  it("imports only zod at run time (site-domains.ts imports this module, so a value import back would be a cycle)", () => {
    const runtimeImports = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gms)].map((m) => m[1]);
    expect(runtimeImports).toEqual(["zod"]);
    const anyImports = [...source.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gms)].map((m) => m[1]);
    for (const specifier of anyImports) {
      expect(specifier === "zod" || specifier?.startsWith("./"), specifier).toBe(true);
    }
  });
});
