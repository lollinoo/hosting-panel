// HCP-SPEC-004 adversarial contract tests (QA, independent of the engineers' own suites): smuggled keys, PEM shape
// edge cases, exact-millisecond expiry boundaries, SAN cover corner cases, redaction cost, dispatch target union,
// id patterns, error code status table and the run-time import graph of the root index. Every PEM below is a fake
// block: the shape check never decodes, so no key material exists in this file.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BACKUP_COPY_JOB_ID_PATTERN,
  BACKUP_TARGET_ID_PATTERN,
  BackupDispatchTargetSchema,
  BackupsIpcRequestSchema,
  CreateBackupTargetInputSchema,
  ERROR_CODES,
  ERROR_CODE_HTTP_STATUS,
  ErrorCodeSchema,
  DEFAULT_RETRYABLE_ERROR_CODES,
  ImportTlsCertificateRequestSchema,
  TLS_MAX_INTERMEDIATES,
  TLS_PEM_MAX_BYTES,
  UpdateBackupTargetInputSchema,
  AdminActivateTlsVersionRequestSchema,
  AdminSetDomainTlsRequestSchema,
  BackupPolicyDtoSchema,
  BackupTargetChoiceDtoSchema,
  CreateTlsCertificateVersionRequestSchema,
  SetDomainTlsRequestSchema,
  SetSiteBackupPolicyInputSchema,
  SiteBackupCopyDtoSchema,
  SiteBackupPolicyDtoSchema,
  SiteDomainTlsDtoSchema,
  TlsCertificateAlertDtoSchema,
  TlsCertificateDtoSchema,
  TlsCertificateVersionDtoSchema,
  certificateExpiryTier,
  checkPemShape,
  findPemValues,
  redactSensitiveString,
  redactSensitiveValue,
  sanCoversHostname,
} from "../src/index.js";

// ---------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------

const DAY = 86_400_000;
const block = (label: string, body = "MIIBfakefakefake", eol = "\n"): string =>
  `-----BEGIN ${label}-----${eol}${body}${eol}-----END ${label}-----`;
const CERT = block("CERTIFICATE");
const KEY = block("PRIVATE KEY");
const GOOD = { name: "Shop", leafPem: CERT, chainPem: "", privateKeyPem: KEY };
const byteLength = (text: string): number => new TextEncoder().encode(text).length;

const TARGET_A = `bkt_${"a".repeat(32)}`;
const TARGET_B = `bkt_${"b".repeat(32)}`;
const JOB_ID = `op_${"c".repeat(32)}`;
const NOW_ISO = "2026-11-21T10:00:00.000Z";
const CERT_ID = `cti_${"a".repeat(32)}`;
const VERSION_ID = `ctv_${"b".repeat(32)}`;

const S3_TARGET = {
  endpoint: "https://s3.example.com:9000",
  region: "eu-south-1",
  bucket: "hosting-backups",
  prefix: "prod/panel-a",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

/** Keys a caller might try to slip through a strict schema to reach a secret or a host path. */
const SMUGGLED_KEYS = [
  "privateKey",
  "privateKeyPem",
  "private_key",
  "password",
  "passphrase",
  "secret",
  "secretAccessKey",
  "ciphertext",
  "encryptedKey",
  "path",
  "root",
  "localRoot",
  "local_root",
  "hostPath",
  "directory",
  "credentials",
  "token",
] as const;

// ---------------------------------------------------------------------------------------------------------------
// Strict schemas refuse smuggled keys
// ---------------------------------------------------------------------------------------------------------------

describe("strict schemas refuse smuggled keys", () => {
  const MIN_VERSION = {
    id: VERSION_ID,
    versionNumber: 1,
    status: "active",
    subject: "example.com",
    issuer: "Example CA",
    sanDns: ["example.com"],
    wildcard: false,
    notBefore: NOW_ISO,
    notAfter: NOW_ISO,
    serialNumber: "01",
    fingerprintSha256: "c".repeat(64),
    keyType: "ec",
    keyBits: 256,
    createdAt: NOW_ISO,
    activatedAt: null,
    problem: null,
  };
  const MIN_CERT = {
    id: CERT_ID,
    name: "Shop",
    source: "manual",
    createdForSiteId: null,
    activeVersionId: VERSION_ID,
    versions: [MIN_VERSION],
    coveredDomains: [{ domainId: "d1", hostname: "example.com", assigned: true, versionId: VERSION_ID }],
    assignedDomains: [{ domainId: "d1", siteId: "s1", siteName: "Shop", hostname: "example.com", versionId: VERSION_ID }],
    expiry: { tier: "ok", daysLeft: 90 },
    warnings: [],
    updatedAt: NOW_ISO,
  };
  const COPY = {
    targetId: TARGET_A,
    kind: "local",
    status: "succeeded",
    sizeBytes: 10,
    problem: null,
    startedAt: NOW_ISO,
    finishedAt: NOW_ISO,
  };
  const CUSTOMER_CASES: ReadonlyArray<[string, { safeParse(v: unknown): { success: boolean } }, Record<string, unknown>]> = [
    ["TlsCertificateVersionDto", TlsCertificateVersionDtoSchema, MIN_VERSION],
    ["TlsCertificateDto", TlsCertificateDtoSchema, MIN_CERT],
    [
      "TlsCertificateAlertDto",
      TlsCertificateAlertDtoSchema,
      {
        certificateId: CERT_ID,
        certificateName: "Shop",
        versionId: VERSION_ID,
        organizationId: "o1",
        siteId: null,
        siteName: null,
        hostnames: [],
        notAfter: NOW_ISO,
        tier: "warning",
        daysLeft: 3,
      },
    ],
    [
      "SiteDomainTlsDto",
      SiteDomainTlsDtoSchema,
      { mode: "manual", certificateId: CERT_ID, versionId: VERSION_ID, state: "active", problem: null },
    ],
    ["BackupTargetChoiceDto", BackupTargetChoiceDtoSchema, { id: TARGET_A, kind: "local" }],
    ["SiteBackupCopyDto", SiteBackupCopyDtoSchema, COPY],
    [
      "SiteBackupPolicyDto",
      SiteBackupPolicyDtoSchema,
      { targetIds: [TARGET_A], inherited: false, choices: [{ id: TARGET_A, kind: "local" }] },
    ],
  ];

  it.each(CUSTOMER_CASES)("%s: the sample parses, and any smuggled key at the top level is refused", (_name, schema, sample) => {
    expect(schema.safeParse(sample).success).toBe(true);
    for (const key of SMUGGLED_KEYS) {
      expect(schema.safeParse({ ...sample, [key]: "x" }).success, key).toBe(false);
      // Even an empty or null value is an extra key: a DTO shape is closed, not "blocklisted when non-empty".
      expect(schema.safeParse({ ...sample, [key]: null }).success, `${key}=null`).toBe(false);
    }
  });

  it("nested objects are closed too: a key inside versions[], coveredDomains[], assignedDomains[], expiry or choices[]", () => {
    for (const key of SMUGGLED_KEYS) {
      const nest = (field: string, value: unknown): Record<string, unknown> => ({ ...MIN_CERT, [field]: value });
      expect(
        TlsCertificateDtoSchema.safeParse(nest("versions", [{ ...MIN_VERSION, [key]: "x" }])).success,
        `versions.${key}`,
      ).toBe(false);
      expect(
        TlsCertificateDtoSchema.safeParse(nest("coveredDomains", [{ ...MIN_CERT.coveredDomains[0], [key]: "x" }])).success,
        `coveredDomains.${key}`,
      ).toBe(false);
      expect(
        TlsCertificateDtoSchema.safeParse(nest("assignedDomains", [{ ...MIN_CERT.assignedDomains[0], [key]: "x" }])).success,
        `assignedDomains.${key}`,
      ).toBe(false);
      expect(
        TlsCertificateDtoSchema.safeParse(nest("expiry", { ...MIN_CERT.expiry, [key]: "x" })).success,
        `expiry.${key}`,
      ).toBe(false);
      expect(
        SiteBackupPolicyDtoSchema.safeParse({
          targetIds: [TARGET_A],
          inherited: false,
          choices: [{ id: TARGET_A, kind: "s3", [key]: "x" }],
        }).success,
        `choices.${key}`,
      ).toBe(false);
    }
  });

  it("customer backup DTOs carry no name, endpoint, bucket, prefix or snapshot id even when the value is harmless", () => {
    for (const key of ["name", "endpoint", "bucket", "prefix", "region", "accessKeyId", "snapshotId", "location"]) {
      expect(BackupTargetChoiceDtoSchema.safeParse({ id: TARGET_A, kind: "s3", [key]: "x" }).success, key).toBe(false);
      expect(SiteBackupCopyDtoSchema.safeParse({ ...COPY, [key]: "x" }).success, `copy.${key}`).toBe(false);
    }
  });

  it("a local target input never takes a path, in any spelling, nor an S3 field", () => {
    const local = { kind: "local", name: "This server" };
    expect(CreateBackupTargetInputSchema.safeParse(local).success).toBe(true);
    for (const key of [...SMUGGLED_KEYS, "repository", "mount", "dir", "folder", "endpoint", "bucket", "accessKeyId", "ROOT", "Path"]) {
      expect(CreateBackupTargetInputSchema.safeParse({ ...local, [key]: "/etc" }).success, key).toBe(false);
    }
    // path-like values hidden in the allowed fields stay plain strings (the server never opens them as paths)
    const parsed = CreateBackupTargetInputSchema.parse({ ...local, name: "../../etc" });
    expect(Object.keys(parsed).sort()).toEqual(["customerSelectable", "enabled", "kind", "name"]);
  });

  it("an update input refuses kind, id and every local path key", () => {
    expect(UpdateBackupTargetInputSchema.safeParse({ name: "x" }).success).toBe(true);
    for (const key of ["kind", "id", "root", "localRoot", "path", "hostPath", "directory", "legacy", "createdAt", "archivedAt"]) {
      expect(UpdateBackupTargetInputSchema.safeParse({ name: "x", [key]: "x" }).success, key).toBe(false);
    }
    expect(UpdateBackupTargetInputSchema.safeParse({ archived: false }).success).toBe(false);
    expect(UpdateBackupTargetInputSchema.safeParse({ name: "x", retentionDays: 0 }).success).toBe(false);
  });

  it("a JSON own key named __proto__ is an unknown key, not a silent drop, on strict inputs", () => {
    const attack = '{"__proto__":{"path":"/etc"},';
    for (const [schema, body] of [
      [CreateBackupTargetInputSchema, `${attack}"kind":"local","name":"x"}`],
      [ImportTlsCertificateRequestSchema, `${attack}"name":"x","format":"pem","leafPem":"a","privateKeyPem":"b"}`],
      [SetDomainTlsRequestSchema, `${attack}"mode":"acme"}`],
      [SetSiteBackupPolicyInputSchema, `${attack}"targetIds":null}`],
    ] as const) {
      expect(schema.safeParse(JSON.parse(body)).success).toBe(false);
    }
  });

  it("TLS requests refuse an alternative key format, a password and file paths", () => {
    const base = { name: "Shop", format: "pem", leafPem: CERT, privateKeyPem: KEY };
    expect(ImportTlsCertificateRequestSchema.safeParse(base).success).toBe(true);
    for (const key of ["password", "passphrase", "leafPath", "keyPath", "path", "privateKey", "pfx", "p12", "pkcs12", "url"]) {
      expect(ImportTlsCertificateRequestSchema.safeParse({ ...base, [key]: "x" }).success, key).toBe(false);
      expect(CreateTlsCertificateVersionRequestSchema.safeParse({ ...base, name: undefined, [key]: "x" }).success, key).toBe(
        false,
      );
    }
    for (const format of ["pkcs12", "PEM", "der", "", null]) {
      expect(ImportTlsCertificateRequestSchema.safeParse({ ...base, format }).success, String(format)).toBe(false);
    }
  });

  it("the eviction fields exist only on the admin schemas, and travel together", () => {
    const manual = { mode: "manual", versionId: VERSION_ID };
    expect(SetDomainTlsRequestSchema.safeParse({ ...manual, evictAcme: true, confirmHostname: "a.example.com" }).success).toBe(
      false,
    );
    expect(AdminSetDomainTlsRequestSchema.safeParse({ ...manual, evictAcme: true }).success).toBe(false);
    expect(AdminSetDomainTlsRequestSchema.safeParse({ ...manual, confirmHostname: "a.example.com" }).success).toBe(false);
    expect(AdminSetDomainTlsRequestSchema.safeParse({ ...manual, evictAcme: false, confirmHostname: "a" }).success).toBe(false);
    expect(
      AdminSetDomainTlsRequestSchema.safeParse({ mode: "acme", evictAcme: true, confirmHostname: "a.example.com" }).success,
    ).toBe(false);
    expect(AdminActivateTlsVersionRequestSchema.safeParse({ evictAcme: true, confirmHostname: "" }).success).toBe(false);
    expect(
      AdminActivateTlsVersionRequestSchema.safeParse({ evictAcme: true, confirmHostname: "a.example.com" }).success,
    ).toBe(true);
  });

  it("the per-field PEM bound is exact: 512 KiB passes the schema, one more byte does not", () => {
    const at = (leafPem: string): boolean =>
      ImportTlsCertificateRequestSchema.safeParse({ name: "x", format: "pem", leafPem, privateKeyPem: "k" }).success;
    expect(at("a".repeat(TLS_PEM_MAX_BYTES))).toBe(true);
    expect(at("a".repeat(TLS_PEM_MAX_BYTES + 1))).toBe(false);
    expect(at("")).toBe(false);
  });

  it("backup policy DTO and site policy input refuse smuggled keys", () => {
    for (const key of SMUGGLED_KEYS) {
      expect(SetSiteBackupPolicyInputSchema.safeParse({ targetIds: [TARGET_A], [key]: "x" }).success, key).toBe(false);
      expect(
        BackupPolicyDtoSchema.safeParse({
          scope: "panel",
          siteId: null,
          scheduleHourUtc: null,
          retentionDays: 7,
          targets: [{ targetId: TARGET_A, kind: "local", priority: 1, required: true, [key]: "x" }],
          updatedAt: NOW_ISO,
        }).success,
        `targets.${key}`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// checkPemShape
// ---------------------------------------------------------------------------------------------------------------

describe("checkPemShape adversarial inputs", () => {
  const issues = (over: Partial<typeof GOOD>): ReturnType<typeof checkPemShape> => checkPemShape({ ...GOOD, ...over });

  it("accepts CRLF line endings, a trailing newline and leading blank lines", () => {
    expect(issues({ leafPem: block("CERTIFICATE", "MIIBfake\r\nfakefake", "\r\n") })).toEqual([]);
    expect(issues({ leafPem: `\n\n${CERT}\n\n`, privateKeyPem: `\r\n${KEY}\r\n` })).toEqual([]);
  });

  it("refuses text before, after or between blocks", () => {
    expect(issues({ leafPem: `junk\n${CERT}` })).toEqual([{ field: "leafPem", reason: "not_pem" }]);
    expect(issues({ leafPem: `${CERT}\njunk` })).toEqual([{ field: "leafPem", reason: "not_pem" }]);
    expect(issues({ chainPem: `${CERT}\nbetween\n${CERT}` })).toEqual([{ field: "chainPem", reason: "not_pem" }]);
    expect(issues({ privateKeyPem: `${KEY} ` + "x" })).toEqual([{ field: "privateKeyPem", reason: "not_pem" }]);
  });

  it("puts a NUL anywhere in the report as nul_byte (or format_unsupported when there is no block at all), never as ok", () => {
    for (const leafPem of [`${CERT}\u0000`, `\u0000${CERT}`, block("CERTIFICATE", "MIIB\u0000fake")]) {
      expect(issues({ leafPem })).toEqual([{ field: "leafPem", reason: "nul_byte" }]);
    }
    expect(issues({ privateKeyPem: `${KEY}\u0000` })).toEqual([{ field: "privateKeyPem", reason: "nul_byte" }]);
    expect(issues({ chainPem: `${CERT}\u0000${CERT}` })).toEqual([{ field: "chainPem", reason: "nul_byte" }]);
    const bare = issues({ leafPem: "\u0000" });
    expect(bare).toHaveLength(1);
    expect(["nul_byte", "format_unsupported"]).toContain(bare[0]?.reason);
  });

  it("refuses malformed delimiters: lower case label, END of another type, missing END, dashes in the body", () => {
    const refused = (leafPem: string): unknown => issues({ leafPem });
    const notPem = [{ field: "leafPem", reason: "not_pem" }];
    expect(refused("-----BEGIN certificate-----\nMII\n-----END certificate-----")).toEqual(notPem);
    expect(refused("-----BEGIN CERTIFICATE-----\nMII\n-----END PRIVATE KEY-----")).toEqual(notPem);
    expect(refused("-----BEGIN CERTIFICATE-----\nMII")).toEqual(notPem);
    expect(refused("-----BEGIN CERTIFICATE-----\nMII\n-----END CERTIFICATE----")).toEqual(notPem);
    expect(refused("-----BEGIN CERTIFICATE\nMII\n-----END CERTIFICATE-----")).toEqual(notPem);
    expect(refused("-----BEGIN -----\nMII\n-----END -----")).toEqual(notPem);
    expect(refused(`-----BEGIN ${"A".repeat(41)}-----\nMII\n-----END ${"A".repeat(41)}-----`)).toEqual(notPem);
    expect(refused("-----BEGIN CERTIFICATE-----\nMII-----\nfake\n-----END CERTIFICATE-----")).toEqual(notPem);
    expect(refused("-----BEGIN CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nMII\n-----END CERTIFICATE-----")).toEqual(notPem);
  });

  it("does not decode: a block with a garbage base64 body is a shape match, left to the API validator", () => {
    expect(issues({ leafPem: block("CERTIFICATE", "!!!not base64!!!") })).toEqual([]);
    expect(issues({ leafPem: block("CERTIFICATE", "") })).toEqual([]);
  });

  it("key field: two keys, key + certificate, encrypted keys and non-key blocks each map to one reason", () => {
    const key = (privateKeyPem: string): unknown => issues({ privateKeyPem });
    expect(key(`${KEY}\n${KEY}`)).toEqual([{ field: "privateKeyPem", reason: "multiple_blocks" }]);
    expect(key(`${KEY}\n${block("RSA PRIVATE KEY")}`)).toEqual([{ field: "privateKeyPem", reason: "multiple_blocks" }]);
    expect(key(`${KEY}\n${CERT}`)).toEqual([{ field: "privateKeyPem", reason: "wrong_block_type" }]);
    expect(key(block("ENCRYPTED PRIVATE KEY"))).toEqual([{ field: "privateKeyPem", reason: "encrypted_key" }]);
    // the encrypted marker wins over a second block, so the user is told what to fix first
    expect(key(`${block("ENCRYPTED PRIVATE KEY")}\n${KEY}`)).toEqual([{ field: "privateKeyPem", reason: "encrypted_key" }]);
    expect(key(block("RSA PRIVATE KEY", "Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00\n\nQUJD"))).toEqual([
      { field: "privateKeyPem", reason: "encrypted_key" },
    ]);
    expect(key(block("RSA PRIVATE KEY", "Proc-Type:   4,   ENCRYPTED\n\nQUJD"))).toEqual([
      { field: "privateKeyPem", reason: "encrypted_key" },
    ]);
    for (const label of ["PUBLIC KEY", "CERTIFICATE", "OPENSSH PRIVATE KEY", "DSA PRIVATE KEY", "PRIVATE KEY BLOCK", "CERTIFICATE REQUEST"]) {
      expect(key(block(label)), label).toEqual([{ field: "privateKeyPem", reason: "wrong_block_type" }]);
    }
    expect(key("")).toEqual([{ field: "privateKeyPem", reason: "required" }]);
    expect(key("   \n\t ")).toEqual([{ field: "privateKeyPem", reason: "required" }]);
  });

  it("leaf field: a key, a trusted/x509 variant or a bundle never passes", () => {
    const leaf = (leafPem: string): unknown => issues({ leafPem });
    expect(leaf(KEY)).toEqual([{ field: "leafPem", reason: "wrong_block_type" }]);
    expect(leaf(block("TRUSTED CERTIFICATE"))).toEqual([{ field: "leafPem", reason: "wrong_block_type" }]);
    expect(leaf(block("X509 CERTIFICATE"))).toEqual([{ field: "leafPem", reason: "wrong_block_type" }]);
    expect(leaf(`${CERT}\n${CERT}`)).toEqual([{ field: "leafPem", reason: "multiple_blocks" }]);
    expect(leaf("")).toEqual([{ field: "leafPem", reason: "required" }]);
    expect(leaf(" \r\n ")).toEqual([{ field: "leafPem", reason: "required" }]);
  });

  it("chain: exactly 20 certificates pass, 21 are too many, a key in the chain is the wrong type", () => {
    const chain = (count: number): string => Array.from({ length: count }, () => CERT).join("\n");
    expect(TLS_MAX_INTERMEDIATES).toBe(20);
    expect(issues({ chainPem: chain(20) })).toEqual([]);
    expect(issues({ chainPem: chain(21) })).toEqual([{ field: "chainPem", reason: "too_many_intermediates" }]);
    expect(issues({ chainPem: chain(1) })).toEqual([]);
    expect(issues({ chainPem: `${chain(2)}\n${KEY}` })).toEqual([{ field: "chainPem", reason: "wrong_block_type" }]);
    expect(issues({ chainPem: "\n\n" })).toEqual([]);
  });

  it("the empty submission reports the leaf and the key as required, in order, and nothing else", () => {
    expect(checkPemShape({})).toEqual([
      { field: "leafPem", reason: "required" },
      { field: "privateKeyPem", reason: "required" },
    ]);
    expect(checkPemShape({ name: "", leafPem: "", chainPem: "", privateKeyPem: "" })).toEqual([
      { field: "name", reason: "required" },
      { field: "leafPem", reason: "required" },
      { field: "privateKeyPem", reason: "required" },
    ]);
  });

  it("measures the 512 KiB limit exactly on the sum of the three texts: limit passes, limit+1 is too_large", () => {
    const padded = (extra: number, utf8Char = ""): string => {
      // leaf padded so leaf + chain("") + key is exactly TLS_PEM_MAX_BYTES + extra bytes
      const fixed = byteLength(KEY) + byteLength(block("CERTIFICATE", "")) + byteLength(utf8Char);
      const body = "A".repeat(TLS_PEM_MAX_BYTES + extra - fixed) + utf8Char;
      return block("CERTIFICATE", body);
    };
    const exact = padded(0);
    expect(byteLength(exact) + byteLength(KEY)).toBe(TLS_PEM_MAX_BYTES);
    expect(issues({ leafPem: exact })).toEqual([]);
    const over = padded(1);
    expect(byteLength(over) + byteLength(KEY)).toBe(TLS_PEM_MAX_BYTES + 1);
    expect(issues({ leafPem: over })).toEqual([{ field: "leafPem", reason: "too_large" }]);
    // bytes, not characters: a 2-byte character on the limit pushes it over although the string is short of the limit
    const wide = padded(1, "é");
    expect(wide.length + KEY.length).toBeLessThanOrEqual(TLS_PEM_MAX_BYTES);
    expect(byteLength(wide) + byteLength(KEY)).toBe(TLS_PEM_MAX_BYTES + 1);
    expect(issues({ leafPem: wide })).toEqual([{ field: "leafPem", reason: "too_large" }]);
  });

  it("splits the budget across fields (leaf + chain + key), reporting too_large only on the largest and nothing else", () => {
    const big = block("CERTIFICATE", "A".repeat(TLS_PEM_MAX_BYTES / 2));
    expect(issues({ leafPem: big, chainPem: big })).toEqual([{ field: "leafPem", reason: "too_large" }]);
    const bigKey = block("PRIVATE KEY", "A".repeat(TLS_PEM_MAX_BYTES));
    // too_large short-circuits the PEM fields: a junk leaf is not reported next to it
    expect(checkPemShape({ name: "Shop", leafPem: "junk", chainPem: "", privateKeyPem: bigKey })).toEqual([
      { field: "privateKeyPem", reason: "too_large" },
    ]);
  });

  it("name: exact 128 passes after trimming, 129 and any control or C1 character are invalid", () => {
    const name = (value: string): unknown => checkPemShape({ ...GOOD, name: value });
    expect(name(` ${"a".repeat(128)} `)).toEqual([]);
    expect(name("a".repeat(129))).toEqual([{ field: "name", reason: "invalid_name" }]);
    for (const bad of ["a\tb", "a\nb", "a\u0000b", "a\u007fb", "a\u0085b", "a\u009fb"]) {
      expect(name(bad), JSON.stringify(bad)).toEqual([{ field: "name", reason: "invalid_name" }]);
    }
    expect(name(" \t ")).toEqual([{ field: "name", reason: "required" }]);
  });

  it("scans 5000 tiny blocks and 2 MB-ish unterminated labels in well under a second (no quadratic scan)", () => {
    const many = Array.from({ length: 5000 }, () => block("CERTIFICATE", "A")).join("\n");
    const hugeLabel = `-----BEGIN ${"A".repeat(400_000)}`;
    const dashes = "-----".repeat(100_000);
    const started = performance.now();
    expect(issues({ chainPem: many })).toEqual([{ field: "chainPem", reason: "too_many_intermediates" }]);
    expect(issues({ leafPem: hugeLabel })).toEqual([{ field: "leafPem", reason: "not_pem" }]);
    expect(issues({ leafPem: dashes })).toEqual([{ field: "leafPem", reason: "not_pem" }]);
    expect(issues({ privateKeyPem: `${KEY}${"\n".repeat(400_000)}` })).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// certificateExpiryTier
// ---------------------------------------------------------------------------------------------------------------

describe("certificateExpiryTier exact boundaries in UTC", () => {
  // now is placed one hour before a Europe/Rome and America/New_York DST change, so 30 local days differ from 30 UTC days.
  const NOW_DST = new Date("2026-03-28T23:00:00.000Z");
  const NOW_PLAIN = new Date("2026-06-15T12:00:00.000Z");
  const CASES: ReadonlyArray<readonly [number, string, number]> = [
    [30 * DAY + 1, "ok", 30],
    [30 * DAY, "notice", 30],
    [30 * DAY - 1, "notice", 29],
    [14 * DAY + 1, "notice", 14],
    [14 * DAY, "warning", 14],
    [14 * DAY - 1, "warning", 13],
    [7 * DAY + 1, "warning", 7],
    [7 * DAY, "critical", 7],
    [7 * DAY - 1, "critical", 6],
    [DAY, "critical", 1],
    [DAY - 1, "critical", 0],
    [1, "critical", 0],
    [0, "expired", 0],
    [-1, "expired", -1],
  ];

  it.each([NOW_DST, NOW_PLAIN])("holds to the millisecond from %s, as a Date and as an ISO string", (now) => {
    for (const [offset, tier, daysLeft] of CASES) {
      const notAfter = new Date(now.getTime() + offset);
      expect(certificateExpiryTier(notAfter, now), `Date ${offset}`).toEqual({ tier, daysLeft });
      expect(certificateExpiryTier(notAfter.toISOString(), now), `ISO ${offset}`).toEqual({ tier, daysLeft });
    }
  });

  it("gives the same answer whatever the process time zone is", () => {
    const original = process.env.TZ;
    try {
      const answers = ["UTC", "Europe/Rome", "America/New_York", "Pacific/Auckland", "Asia/Kolkata"].map((tz) => {
        process.env.TZ = tz;
        return CASES.map(([offset]) => certificateExpiryTier(new Date(NOW_DST.getTime() + offset), NOW_DST));
      });
      for (const answer of answers) {
        expect(answer).toEqual(answers[0]);
      }
      expect(answers[0]?.map((a) => a.tier)).toEqual(CASES.map(([, tier]) => tier));
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("an offset in the ISO string denotes the same instant as its UTC form", () => {
    const notAfter = new Date(NOW_PLAIN.getTime() + 7 * DAY);
    const plus = "2026-06-22T14:00:00.000+02:00";
    const minus = "2026-06-22T07:00:00.000-05:00";
    expect(new Date(plus).getTime()).toBe(notAfter.getTime());
    expect(certificateExpiryTier(plus, NOW_PLAIN)).toEqual({ tier: "critical", daysLeft: 7 });
    expect(certificateExpiryTier(minus, NOW_PLAIN)).toEqual({ tier: "critical", daysLeft: 7 });
  });

  it("fails closed as expired for an empty, garbage or invalid date and an invalid now", () => {
    for (const bad of ["", "garbage", "2026-13-45T00:00:00Z", new Date(Number.NaN)]) {
      expect(certificateExpiryTier(bad, NOW_PLAIN).tier, String(bad)).toBe("expired");
    }
    expect(certificateExpiryTier(NOW_PLAIN, new Date(Number.NaN)).tier).toBe("expired");
  });

  it("handles years-away and far-past dates without leaving the tier set", () => {
    expect(certificateExpiryTier("9999-12-31T23:59:59.999Z", NOW_PLAIN).tier).toBe("ok");
    expect(certificateExpiryTier("1970-01-01T00:00:00.000Z", NOW_PLAIN)).toMatchObject({ tier: "expired" });
    expect(certificateExpiryTier("1970-01-01T00:00:00.000Z", NOW_PLAIN).daysLeft).toBeLessThan(-20_000);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// sanCoversHostname
// ---------------------------------------------------------------------------------------------------------------

describe("sanCoversHostname corner cases", () => {
  it.each([
    ["*.EXAMPLE.com", "WWW.Example.COM", true],
    ["WWW.EXAMPLE.COM", "www.example.com", true],
    ["*.example.com", "www.example.com", true],
    // apex vs wildcard, in both directions
    ["*.example.com", "example.com", false],
    ["example.com", "www.example.com", false],
    ["www.example.com", "example.com", false],
    // multi level
    ["*.example.com", "a.b.example.com", false],
    ["*.b.example.com", "a.b.example.com", true],
    ["*.b.example.com", "b.example.com", false],
    ["*.example.com", "a.example.com.evil.net", false],
    ["*.example.com", "evilexample.com", false],
    ["*.example.com", "x.evilexample.com", false],
    // empty labels
    ["*.example.com", ".example.com", false],
    ["*.example.com", "a..example.com", false],
    ["*.example.com", "..example.com", false],
    // trailing dot is not normalized: an FQDN-dotted hostname is not covered (fail closed)
    ["*.example.com", "www.example.com.", false],
    ["www.example.com.", "www.example.com", false],
    ["www.example.com", "www.example.com.", false],
    // whitespace is never trimmed
    ["*.example.com", "www.example.com ", false],
    ["*.example.com", "www.example.com\n", false],
    ["*.example.com", " www.example.com", false],
    ["*.example.com", "a b.example.com", false],
    [" www.example.com", " www.example.com", false],
    // punycode labels are plain labels; Unicode labels are not converted
    ["*.xn--e1afmkfd.xn--p1ai", "www.xn--e1afmkfd.xn--p1ai", true],
    ["*.xn--mnchen-3ya.de", "XN--A.xn--mnchen-3ya.de", true],
    ["xn--mnchen-3ya.example.com", "münchen.example.com", false],
    ["*.münchen.example.com", "www.xn--mnchen-3ya.example.com", false],
    // nested, partial, middle and bare wildcards cover nothing
    ["*.*.example.com", "a.b.example.com", false],
    ["*.*.com", "a.b.com", false],
    ["*.a*.example.com", "x.ab.example.com", false],
    ["a*.example.com", "abc.example.com", false],
    ["*a.example.com", "xa.example.com", false],
    ["w*w.example.com", "www.example.com", false],
    ["www.*.com", "www.a.com", false],
    ["www.example.*", "www.example.com", false],
    ["*", "com", false],
    ["*", "example.com", false],
    ["*", "*", false],
    ["*.", "a", false],
    ["*.", "a.", false],
    ["*.com", "example.com", false],
    ["**.example.com", "a.example.com", false],
    // a hostname that itself holds a wildcard is never covered, even by the identical SAN
    ["*.example.com", "*.example.com", false],
    ["*.example.com", "a.*.example.com", false],
    ["www.*.example.com", "www.*.example.com", false],
    // empty
    ["", "", false],
    ["", "a", false],
    ["*.example.com", "", false],
    ["example.com", "", false],
  ] as const)("san %j covers %j: %s", (san, hostname, expected) => {
    expect(sanCoversHostname(san, hostname)).toBe(expected);
  });

  it("an IP literal is covered only by the identical literal in this contract (domains are never IPs)", () => {
    expect(sanCoversHostname("192.0.2.1", "192.0.2.1")).toBe(true);
    expect(sanCoversHostname("192.0.2.1", "192.0.2.2")).toBe(false);
    expect(sanCoversHostname("[2001:db8::1]", "2001:db8::1")).toBe(false);
    expect(sanCoversHostname("2001:db8::1", "2001:db8::1")).toBe(true);
    expect(sanCoversHostname("*.2001:db8::1", "2001:db8::1")).toBe(false);
    // a wildcard never covers an IP literal, whatever its tail looks like
    expect(sanCoversHostname("*.0.2.1", "192.0.2.1")).toBe(false);
    expect(sanCoversHostname("*.example.com", "::1")).toBe(false);
  });

  it("is symmetric-safe: swapping a wildcard SAN and a hostname never makes a name cover a wildcard", () => {
    for (const [wild, name] of [
      ["*.example.com", "www.example.com"],
      ["*.example.com", "a.example.com"],
    ] as const) {
      expect(sanCoversHostname(wild, name)).toBe(true);
      expect(sanCoversHostname(name, wild)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------------------------------

describe("PEM redaction adversarial inputs", () => {
  const FAKE_BODY = "TUlJRUZBS0VGQUtFRkFLRUZBS0U";
  const FAKE_KEY = block("PRIVATE KEY", FAKE_BODY);
  const FAKE_CERT = block("CERTIFICATE", FAKE_BODY);

  it("redacts every block of a bundle, and each of them in findPemValues paths", () => {
    const bundle = [FAKE_CERT, FAKE_CERT, FAKE_KEY].join("\n");
    expect(redactSensitiveString(bundle)).toBe("[REDACTED_PEM]\n[REDACTED_PEM]\n[REDACTED_PEM]");
    expect(redactSensitiveString(`a ${FAKE_KEY} b ${FAKE_CERT} c`)).toBe("a [REDACTED_PEM] b [REDACTED_PEM] c");
    expect(findPemValues({ a: [bundle, "plain"], b: { c: FAKE_KEY, d: 1, e: null }, f: undefined })).toEqual(["a[0]", "b.c"]);
  });

  it("redacts a PEM inside an escaped JSON string (literal backslash-n), keeping the JSON around it", () => {
    const json = JSON.stringify({ before: 1, error: `bad ${FAKE_KEY} tail`, after: true });
    expect(json).toContain("\\n");
    expect(json).not.toContain("\n");
    const out = redactSensitiveString(json);
    expect(out).not.toContain(FAKE_BODY);
    expect(out).not.toContain("BEGIN");
    expect(JSON.parse(out)).toEqual({ before: 1, error: "bad [REDACTED_PEM] tail", after: true });
  });

  it("a PEM written with escaped CRLF or double escaped newlines is redacted too", () => {
    const flat = JSON.stringify(JSON.stringify({ k: block("PRIVATE KEY", FAKE_BODY, "\r\n") }));
    const out = redactSensitiveString(flat);
    expect(out).not.toContain(FAKE_BODY);
    expect(out).toContain("[REDACTED_PEM]");
  });

  it("a block cut before its END line is redacted up to the end of the string (nothing of the body survives)", () => {
    const cut = `{"k":"-----BEGIN PRIVATE KEY-----\\n${FAKE_BODY}\\n${FAKE_BODY}`;
    const out = redactSensitiveString(cut);
    expect(out).toBe('{"k":"[REDACTED_PEM]');
    expect(redactSensitiveString("x -----BEGIN RSA PRIVATE KEY-----")).toBe("x [REDACTED_PEM]");
  });

  it("a label with a dot, lowercase letters or 64 characters is redacted; a 65-character label is not a block", () => {
    expect(redactSensitiveString(block("X9.42 DH PRIVATE KEY", FAKE_BODY))).toBe("[REDACTED_PEM]");
    expect(redactSensitiveString(`a ${block("private key", FAKE_BODY)} b`)).toBe("a [REDACTED_PEM] b");
    expect(redactSensitiveString(block("A".repeat(64), FAKE_BODY))).toBe("[REDACTED_PEM]");
    expect(redactSensitiveString(`-----BEGIN ${"A".repeat(65)}-----`)).toBe(`-----BEGIN ${"A".repeat(65)}-----`);
    // findPemValues still flags the marker, so the outbox and audit guards are unaffected by the label class
    expect(findPemValues(`-----BEGIN ${"A".repeat(65)}-----`)).toEqual([""]);
  });

  it("an END line of a different type still closes the block, and text after it is kept", () => {
    expect(redactSensitiveString(`-----BEGIN CERTIFICATE-----\n${FAKE_BODY}\n-----END PRIVATE KEY----- ok`)).toBe(
      "[REDACTED_PEM] ok",
    );
  });

  it("two truncated blocks collapse into a single redaction, never leaking the second body", () => {
    const out = redactSensitiveString(`-----BEGIN CERTIFICATE-----\nAAA\n-----BEGIN PRIVATE KEY-----\n${FAKE_BODY}`);
    expect(out).toBe("[REDACTED_PEM]");
  });

  it("findPemValues sees a marker anywhere, even in keys of arrays of arrays, and ignores non-strings", () => {
    const value = { rows: [[1, [FAKE_CERT]], [{ x: `prefix ${FAKE_KEY}` }]], num: 5, flag: false, nil: null };
    expect(findPemValues(value)).toEqual(["rows[0][1][0]", "rows[1][0].x"]);
    expect(findPemValues("-----BEGIN")).toEqual([""]);
    expect(findPemValues("begin private key")).toEqual([]);
    expect(findPemValues(5)).toEqual([]);
    expect(findPemValues(null)).toEqual([]);
  });

  it("redactSensitiveValue never returns a PEM at any depth and keeps non-PEM siblings", () => {
    const value = { a: { b: [{ c: `x ${FAKE_KEY}` }] }, keep: "plain", n: 3 };
    const out = redactSensitiveValue(value);
    expect(findPemValues(out)).toEqual([]);
    expect(out).toEqual({ a: { b: [{ c: "x [REDACTED_PEM]" }] }, keep: "plain", n: 3 });
    expect(JSON.stringify(out)).not.toContain(FAKE_BODY);
  });

  describe("linear time on 2 MB inputs (under 200 ms each)", () => {
    const TWO_MB = 2 * 1024 * 1024;
    const timed = (fn: () => unknown): number => {
      const started = performance.now();
      fn();
      return performance.now() - started;
    };
    const repeat = (unit: string): string => unit.repeat(Math.ceil(TWO_MB / unit.length));

    const INPUTS: ReadonlyArray<readonly [string, () => string]> = [
      ["one huge truncated key", () => `-----BEGIN PRIVATE KEY-----\n${"A".repeat(TWO_MB)}`],
      ["one huge complete key", () => `-----BEGIN PRIVATE KEY-----\n${"A".repeat(TWO_MB)}\n-----END PRIVATE KEY-----`],
      ["many complete blocks", () => repeat("-----BEGIN A-----\nxx\n-----END A-----\n")],
      ["many unterminated markers", () => repeat("-----BEGIN A-----\nxx\n")],
      ["BEGIN with no label closing", () => `-----BEGIN ${"A".repeat(TWO_MB)}`],
      ["BEGIN followed by spaces", () => `-----BEGIN ${" ".repeat(TWO_MB)}`],
      ["BEGIN repeated without dashes after the label", () => repeat("-----BEGIN AB ")],
      ["BEGIN with a 64-character label never closed", () => repeat(`-----BEGIN ${"a.".repeat(32)}`)],
      ["BEGIN with a 65-character label never closed", () => repeat(`-----BEGIN ${"a".repeat(65)}`)],
      ["BEGIN with a label and dashes, no END", () => repeat("-----BEGIN x9.42 dh-----\n")],
      ["dashes only", () => "-".repeat(TWO_MB)],
      ["BEGIN lookalikes", () => repeat("-----BEGI -----BEGIN-----")],
      ["Bearer then spaces", () => `Bearer${" ".repeat(TWO_MB)}`],
      ["Bearer repeated with no token", () => repeat("Bearer \n")],
      ["Bearer with a huge token", () => `Bearer ${"a".repeat(TWO_MB)}`],
      ["plain text", () => repeat("hello world, nothing secret here. ")],
    ];

    it.each(INPUTS)("redactSensitiveString: %s", (_name, make) => {
      const input = make();
      expect(input.length).toBeGreaterThanOrEqual(TWO_MB);
      redactSensitiveString("warm up -----BEGIN A-----\nx\n-----END A----- Bearer abc");
      expect(timed(() => redactSensitiveString(input))).toBeLessThan(200);
    });

    it("redactSensitiveValue and findPemValues over a 2 MB string and a 20k-element array", () => {
      const huge = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(TWO_MB)}`;
      const wide = Array.from({ length: 20_000 }, (_, i) => ({ i, text: `row ${String(i)}` }));
      expect(timed(() => redactSensitiveValue({ huge }))).toBeLessThan(200);
      expect(timed(() => findPemValues({ huge, wide }))).toBeLessThan(200);
      expect(timed(() => redactSensitiveValue(wide))).toBeLessThan(200);
      expect(findPemValues({ huge, wide })).toEqual(["huge"]);
    });

    it("the output of a 2 MB complete key shrinks to the placeholder", () => {
      expect(redactSensitiveString(`-----BEGIN PRIVATE KEY-----\n${"A".repeat(TWO_MB)}\n-----END PRIVATE KEY-----`)).toBe(
        "[REDACTED_PEM]",
      );
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Backup dispatch target, ids and job ids
// ---------------------------------------------------------------------------------------------------------------

describe("BackupDispatchTargetSchema is an exclusive union", () => {
  const LOCAL = { kind: "local", targetId: TARGET_A };

  it("accepts exactly the frozen S3 object or the local one", () => {
    expect(BackupDispatchTargetSchema.safeParse(S3_TARGET).success).toBe(true);
    expect(BackupDispatchTargetSchema.safeParse(LOCAL).success).toBe(true);
  });

  it("refuses an S3 target that carries kind (s3 or local), a path, or any local field", () => {
    for (const extra of [
      { kind: "s3" },
      { kind: "local" },
      { kind: "S3" },
      { kind: undefined, path: "/srv/backups" },
      { path: "/srv/backups" },
      { root: "/srv" },
      { localRoot: "/srv" },
      { hostPath: "/srv" },
      { targetId: TARGET_A },
      { kind: "local", targetId: TARGET_A },
    ]) {
      expect(BackupDispatchTargetSchema.safeParse({ ...S3_TARGET, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("refuses a local target with any path key, an S3 field, or a bad / missing id", () => {
    for (const key of ["path", "root", "localRoot", "hostPath", "directory", "repository", "mount", "endpoint", "bucket", "prefix"]) {
      expect(BackupDispatchTargetSchema.safeParse({ ...LOCAL, [key]: "/srv" }).success, key).toBe(false);
    }
    expect(BackupDispatchTargetSchema.safeParse({ ...LOCAL, secretAccessKey: "x" }).success).toBe(false);
    for (const bad of [undefined, null, "", "/etc/passwd", `${TARGET_A}\n`, TARGET_A.toUpperCase(), `${TARGET_A}/../x`, 5]) {
      expect(BackupDispatchTargetSchema.safeParse({ kind: "local", targetId: bad }).success, String(bad)).toBe(false);
    }
    expect(BackupDispatchTargetSchema.safeParse({ kind: "local" }).success).toBe(false);
    expect(BackupDispatchTargetSchema.safeParse({ targetId: TARGET_A }).success).toBe(false);
    expect(BackupDispatchTargetSchema.safeParse({ kind: "s3", targetId: TARGET_A }).success).toBe(false);
  });

  it("refuses non-objects and the S3 object missing its secret", () => {
    for (const bad of [null, undefined, "local", [], [LOCAL], 0]) {
      expect(BackupDispatchTargetSchema.safeParse(bad).success).toBe(false);
    }
    const { secretAccessKey: _omitted, ...withoutSecret } = S3_TARGET;
    expect(BackupDispatchTargetSchema.safeParse(withoutSecret).success).toBe(false);
  });

  it("the IPC test action accepts a local target as exactly {kind, targetId} and still refuses any path", () => {
    const ok = BackupsIpcRequestSchema.safeParse({ action: "test", target: LOCAL });
    expect(ok.success).toBe(true);
    if (ok.success && ok.data.action === "test") expect(ok.data.target).toEqual({ kind: "local", targetId: TARGET_A });
    for (const key of ["path", "root", "localRoot", "hostPath", "directory"]) {
      expect(BackupsIpcRequestSchema.safeParse({ action: "test", target: { ...LOCAL, [key]: "/srv" } }).success, key).toBe(false);
    }
    expect(BackupsIpcRequestSchema.safeParse({ action: "test", target: { ...S3_TARGET, kind: "s3" } }).success).toBe(false);
    expect(BackupsIpcRequestSchema.safeParse({ action: "test", target: S3_TARGET }).success).toBe(true);
  });
});

describe("backup id patterns", () => {
  it("BACKUP_TARGET_ID_PATTERN is anchored and only lower-case hex (no unicode digits, no spaces, no regex flags)", () => {
    expect(BACKUP_TARGET_ID_PATTERN.flags).toBe("");
    for (const bad of [
      `bkt_${"٣".repeat(32)}`,
      `bkt_${"ａ".repeat(32)}`,
      ` ${TARGET_A}`,
      `${TARGET_A} `,
      `${TARGET_A}\r`,
      `${TARGET_A}\u0000`,
      `\n${TARGET_A}`,
      `BKT_${"a".repeat(32)}`,
      `bkt-${"a".repeat(32)}`,
      `bkt_${"a".repeat(32)}${"a"}`,
      `${TARGET_A}${TARGET_B}`,
      `bkt_${"a".repeat(16)}-${"a".repeat(15)}`,
    ]) {
      expect(BACKUP_TARGET_ID_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(BACKUP_TARGET_ID_PATTERN.test(`bkt_${"0123456789abcdef".repeat(2)}`)).toBe(true);
  });

  it("BACKUP_COPY_JOB_ID_PATTERN takes op_x and op_x-t2 only", () => {
    expect(BACKUP_COPY_JOB_ID_PATTERN.flags).toBe("");
    expect(BACKUP_COPY_JOB_ID_PATTERN.test(`op_${"0123456789abcdef".repeat(2)}-t2`)).toBe(true);
    for (const bad of [
      `${JOB_ID}-T2`,
      `${JOB_ID}-t`,
      `${JOB_ID}-t0`,
      `${JOB_ID}-t02`,
      `${JOB_ID}-t2 `,
      `${JOB_ID}-t2\n`,
      `${JOB_ID}-t2\u0000`,
      `${JOB_ID}_t2`,
      `${JOB_ID}t2`,
      `${JOB_ID}-`,
      `${JOB_ID}-t٢`,
      `${JOB_ID}-t2-forget`,
      `${JOB_ID}${JOB_ID}`,
      `OP_${"c".repeat(32)}`,
      `op_${"c".repeat(33)}`,
      `op_${"c".repeat(32)}/../x`,
      `${TARGET_A}-t2`,
      "",
      "-t2",
      "op_-t2",
    ]) {
      expect(BACKUP_COPY_JOB_ID_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------------------------------------------

describe("error codes", () => {
  const NEW_CODES = [
    "CERTIFICATE_INVALID",
    "CERTIFICATE_KEY_MISMATCH",
    "CERTIFICATE_CHAIN_INVALID",
    "CERTIFICATE_NOT_YET_VALID",
    "CERTIFICATE_EXPIRED",
    "CERTIFICATE_HOSTNAME_MISMATCH",
    "CERTIFICATE_IN_USE",
    "CERTIFICATE_APPLY_FAILED",
    "CERTIFICATE_SNI_MISMATCH",
    "CERTIFICATE_UPLOAD_TOO_LARGE",
    "CERTIFICATE_FORMAT_UNSUPPORTED",
    "BACKUP_TARGET_IN_USE",
  ] as const;

  it("every ERROR_CODES entry (old and new) has an integer 4xx/5xx HTTP status, and the table has no stray key", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const code of ERROR_CODES) {
      const status = ERROR_CODE_HTTP_STATUS[code];
      expect(Number.isInteger(status), code).toBe(true);
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
    }
    expect(Object.keys(ERROR_CODE_HTTP_STATUS).sort()).toEqual([...ERROR_CODES].sort());
    expect(Object.isFrozen(ERROR_CODE_HTTP_STATUS)).toBe(true);
  });

  it("the twelve new codes are present, parse through ErrorCodeSchema and keep their pinned status", () => {
    const expected: Record<(typeof NEW_CODES)[number], number> = {
      CERTIFICATE_INVALID: 422,
      CERTIFICATE_KEY_MISMATCH: 422,
      CERTIFICATE_CHAIN_INVALID: 422,
      CERTIFICATE_NOT_YET_VALID: 422,
      CERTIFICATE_EXPIRED: 422,
      CERTIFICATE_HOSTNAME_MISMATCH: 422,
      CERTIFICATE_IN_USE: 409,
      CERTIFICATE_APPLY_FAILED: 502,
      CERTIFICATE_SNI_MISMATCH: 409,
      CERTIFICATE_UPLOAD_TOO_LARGE: 413,
      CERTIFICATE_FORMAT_UNSUPPORTED: 422,
      BACKUP_TARGET_IN_USE: 409,
    };
    for (const code of NEW_CODES) {
      expect(ERROR_CODES, code).toContain(code);
      expect(ErrorCodeSchema.safeParse(code).success, code).toBe(true);
      expect(ERROR_CODE_HTTP_STATUS[code], code).toBe(expected[code]);
    }
    expect(ErrorCodeSchema.safeParse("CERTIFICATE_UNKNOWN").success).toBe(false);
    expect(ErrorCodeSchema.safeParse("certificate_invalid").success).toBe(false);
  });

  it("only a transient code is retryable by default: a refused certificate or a target in use never is", () => {
    for (const code of DEFAULT_RETRYABLE_ERROR_CODES) {
      expect(ERROR_CODES).toContain(code);
    }
    for (const code of NEW_CODES) {
      expect(DEFAULT_RETRYABLE_ERROR_CODES as readonly string[], code).not.toContain(code);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Import graph of the root index
// ---------------------------------------------------------------------------------------------------------------

describe("run-time import graph of dist/index.js", () => {
  const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
  // Written before HCP-SPEC-004: the server-side HMAC/signing helpers and the checksum helper. The set is closed on
  // purpose, so a node: import added to any other module reachable from the root index fails here.
  const LEGACY_NODE_IMPORTERS = ["ipc-auth.js", "site-databases.js"];
  const HCP004_MODULES = ["tls-certificates.js", "backup-targets.js", "errors.js", "permissions.js", "operations.js", "resources.js"];

  interface Graph {
    reached: Map<string, { relative: string[]; bare: string[] }>;
  }

  const importsOf = (source: string): string[] =>
    [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g)].map(
      (m) => (m[1] ?? m[2]) as string,
    );

  const walk = (): Graph => {
    const reached = new Map<string, { relative: string[]; bare: string[] }>();
    const queue = ["index.js"];
    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (reached.has(file)) continue;
      const path = resolve(DIST, file);
      const source = readFileSync(path, "utf8");
      const specifiers = importsOf(source);
      const relative = specifiers.filter((s) => s.startsWith("."));
      const bare = specifiers.filter((s) => !s.startsWith("."));
      reached.set(file, { relative, bare });
      for (const spec of relative) {
        queue.push(resolve(dirname(path), spec).slice(DIST.length + 1));
      }
      // dynamic imports and require() hide edges the regex above cannot see: refuse them outright
      expect(source, `${file} uses a dynamic import`).not.toMatch(/\bimport\s*\(/);
      expect(source, `${file} uses require()`).not.toMatch(/\brequire\s*\(/);
    }
    return { reached };
  };

  it("dist is built and the walk reaches the new modules", () => {
    expect(existsSync(resolve(DIST, "index.js"))).toBe(true);
    const { reached } = walk();
    for (const module of HCP004_MODULES) {
      expect(reached.has(module), module).toBe(true);
    }
    expect(reached.size).toBeGreaterThan(15);
  });

  it("the HCP-SPEC-004 modules import no node: builtin and nothing bare except zod", () => {
    const { reached } = walk();
    for (const module of ["tls-certificates.js", "backup-targets.js", "errors.js", "permissions.js", "operations.js", "resources.js"]) {
      const edges = reached.get(module);
      expect(edges?.bare.filter((s) => s !== "zod"), module).toEqual([]);
    }
  });

  it("no module reachable from the root index has a node: import beyond the two legacy ones", () => {
    const { reached } = walk();
    const withNode = [...reached.entries()]
      .filter(([, edges]) => edges.bare.some((s) => s.startsWith("node:")))
      .map(([file]) => file)
      .sort();
    expect(withNode).toEqual(LEGACY_NODE_IMPORTERS);
  });

  it("every bare specifier in the graph is zod or a node:crypto import", () => {
    const { reached } = walk();
    const specifiers = new Set([...reached.values()].flatMap((edges) => edges.bare));
    expect([...specifiers].sort()).toEqual(["node:crypto", "zod"]);
  });

  it("the new modules do not import each other in a cycle through the root index", () => {
    const { reached } = walk();
    for (const module of ["tls-certificates.js", "backup-targets.js", "backups.js", "ipc-schemas.js"]) {
      expect(reached.get(module)?.relative.filter((s) => s === "./index.js"), module).toEqual([]);
    }
    // backups.js must not import backup-targets.js (circular at load time), as the engineers recorded
    expect(reached.get("backups.js")?.relative).not.toContain("./backup-targets.js");
  });
});
