import { randomUUID } from "node:crypto";
import type {
  ErrorCode,
  TlsKeyType,
  TlsVersionProblem,
  TlsVersionStatus,
} from "@hosting-panel/contracts";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DatabaseExecutor, HostingPanelDatabase } from "./client.js";
import { domains, tlsCertificates, tlsCertificateVersions, tlsPublishState } from "./schema.js";
import {
  decryptSecretAesGcm,
  encryptSecretAesGcm,
  type SecretAesGcmAadContext,
} from "./secrets-crypto.js";

// HCP-SPEC-004 manual TLS certificates (migration 0021, ADR-0031). The API validates the material before it
// reaches this module; nothing here parses a certificate. The private key is stored only as an AES-256-GCM
// envelope whose AAD binds organization, certificate and version, and no read helper returns key material
// except `readTlsVersionKey`, which exists for the hand-over to the executor.

const PUBLISH_STATE_ID = "default";
const IDEMPOTENCY_INDEX = "uq_tls_certificate_versions_org_idempotency";
const FINGERPRINT_INDEX = "uq_tls_certificate_versions_org_fingerprint";

/** Repository failure carrying a public error code; `existing` names the holder of a duplicate fingerprint. */
export class TlsRepositoryError extends Error {
  readonly code: ErrorCode;
  readonly existing?: { readonly certificateId: string; readonly versionId: string };

  constructor(code: ErrorCode, message: string, existing?: { certificateId: string; versionId: string }) {
    super(message);
    this.name = "TlsRepositoryError";
    this.code = code;
    if (existing) this.existing = existing;
  }
}

/** AAD of a version's key: `<organization>:*:tls:<certificate>:<version>`. */
export const tlsKeyAad = (
  organizationId: string,
  certificateId: string,
  versionId: string,
): SecretAesGcmAadContext => ({
  organizationId,
  siteId: null,
  secretKey: `tls:${certificateId}:${versionId}`,
});

export interface NewTlsVersion {
  readonly leafPem: string;
  readonly chainPem: string;
  readonly privateKeyPem: string;
  readonly subject: string;
  readonly issuer: string;
  readonly serialNumber: string;
  readonly fingerprintSha256: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly sanDns: readonly string[];
  readonly keyType: TlsKeyType;
  readonly keyBits: number;
}

export interface TlsVersionRecord {
  readonly id: string;
  readonly certificateId: string;
  readonly organizationId: string;
  readonly versionNumber: number;
  readonly subject: string;
  readonly issuer: string;
  readonly serialNumber: string;
  readonly fingerprintSha256: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly sanDns: string[];
  readonly keyType: TlsKeyType;
  readonly keyBits: number;
  readonly status: TlsVersionStatus;
  readonly publishGeneration: number;
  readonly lastErrorCode: TlsVersionProblem | null;
  readonly lastCheckedAt: Date | null;
  readonly activatedAt: Date | null;
  readonly createdByUserId: string | null;
  readonly createdAt: Date;
}

export interface TlsCertificateRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly createdForSiteId: string | null;
  readonly activeVersionId: string | null;
  readonly createdByUserId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly versions: TlsVersionRecord[];
}

// Explicit column list: key, ciphertext, PEM and idempotency columns are never selected by the read helpers.
const versionColumns = {
  id: tlsCertificateVersions.id,
  certificateId: tlsCertificateVersions.certificateId,
  organizationId: tlsCertificateVersions.organizationId,
  versionNumber: tlsCertificateVersions.versionNumber,
  subject: tlsCertificateVersions.subject,
  issuer: tlsCertificateVersions.issuer,
  serialNumber: tlsCertificateVersions.serialNumber,
  fingerprintSha256: tlsCertificateVersions.fingerprintSha256,
  notBefore: tlsCertificateVersions.notBefore,
  notAfter: tlsCertificateVersions.notAfter,
  sanDns: tlsCertificateVersions.sanDns,
  keyType: tlsCertificateVersions.keyType,
  keyBits: tlsCertificateVersions.keyBits,
  status: tlsCertificateVersions.status,
  publishGeneration: tlsCertificateVersions.publishGeneration,
  lastErrorCode: tlsCertificateVersions.lastErrorCode,
  lastCheckedAt: tlsCertificateVersions.lastCheckedAt,
  activatedAt: tlsCertificateVersions.activatedAt,
  createdByUserId: tlsCertificateVersions.createdByUserId,
  createdAt: tlsCertificateVersions.createdAt,
} as const;

function generatePrefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

/** Constraint name of a PostgreSQL error with the given SQLSTATE (drivers nest it in `cause`), else null. */
function pgConstraintViolation(err: unknown, sqlState: string): string | null {
  for (let current: unknown = err, depth = 0; current && typeof current === "object" && depth < 4; depth += 1) {
    const e = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (e.code === sqlState) {
      if (typeof e.constraint === "string") return e.constraint;
      const named = typeof e.message === "string" ? /constraint "([^"]+)"/.exec(e.message) : null;
      return named?.[1] ?? "";
    }
    current = e.cause;
  }
  return null;
}

interface KeyHolder {
  readonly id: string;
  readonly certificateId: string;
  readonly requestHash: string | null;
}

async function findVersionByKey(
  ex: DatabaseExecutor,
  organizationId: string,
  idempotencyKey: string,
): Promise<KeyHolder | undefined> {
  const [row] = await ex
    .select({
      id: tlsCertificateVersions.id,
      certificateId: tlsCertificateVersions.certificateId,
      requestHash: tlsCertificateVersions.requestHash,
    })
    .from(tlsCertificateVersions)
    .where(
      and(
        eq(tlsCertificateVersions.organizationId, organizationId),
        eq(tlsCertificateVersions.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return row;
}

/** A holder of the key is a replay when the request hash (and certificate, when given) match; otherwise a conflict. */
function replayOrConflict(holder: KeyHolder, requestHash?: string, certificateId?: string): KeyHolder {
  if (
    (requestHash !== undefined && holder.requestHash !== requestHash) ||
    (certificateId !== undefined && holder.certificateId !== certificateId)
  ) {
    throw new TlsRepositoryError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different request.");
  }
  return holder;
}

interface RecoveryScope {
  readonly organizationId: string;
  readonly fingerprintSha256: string;
  readonly idempotencyKey?: string;
  readonly requestHash?: string;
  readonly certificateId?: string;
}

/**
 * A unique index refused the insert (a concurrent writer won between the check and the write): the failed
 * transaction is already rolled back, so resolve the outcome from committed state. Returns the replayed holder,
 * throws ALREADY_EXISTS for a duplicate fingerprint, and rethrows anything else.
 */
async function recoverFromUniqueViolation(
  db: HostingPanelDatabase,
  err: unknown,
  scope: RecoveryScope,
): Promise<KeyHolder> {
  const constraint = pgConstraintViolation(err, "23505");
  if (constraint !== IDEMPOTENCY_INDEX && constraint !== FINGERPRINT_INDEX) throw err;
  if (scope.idempotencyKey !== undefined) {
    const holder = await findVersionByKey(db, scope.organizationId, scope.idempotencyKey);
    if (holder) return replayOrConflict(holder, scope.requestHash, scope.certificateId);
  }
  if (constraint === FINGERPRINT_INDEX) {
    const [existing] = await db
      .select({ id: tlsCertificateVersions.id, certificateId: tlsCertificateVersions.certificateId })
      .from(tlsCertificateVersions)
      .where(
        and(
          eq(tlsCertificateVersions.organizationId, scope.organizationId),
          eq(tlsCertificateVersions.fingerprintSha256, scope.fingerprintSha256),
        ),
      )
      .limit(1);
    if (existing) {
      throw new TlsRepositoryError("ALREADY_EXISTS", "This certificate is already imported.", {
        certificateId: existing.certificateId,
        versionId: existing.id,
      });
    }
  }
  throw err;
}

interface VersionRowInput {
  readonly versionId: string;
  readonly certificateId: string;
  readonly organizationId: string;
  readonly versionNumber: number;
  readonly version: NewTlsVersion;
  readonly masterKey: string | Buffer | Uint8Array;
  readonly createdByUserId: string | null;
  readonly idempotencyKey?: string;
  readonly requestHash?: string;
}

async function insertVersionRow(tx: DatabaseExecutor, i: VersionRowInput): Promise<void> {
  const envelope = encryptSecretAesGcm({
    ...tlsKeyAad(i.organizationId, i.certificateId, i.versionId),
    plaintext: i.version.privateKeyPem,
    masterKey: i.masterKey,
  });
  await tx.insert(tlsCertificateVersions).values({
    id: i.versionId,
    certificateId: i.certificateId,
    organizationId: i.organizationId,
    versionNumber: i.versionNumber,
    leafPem: i.version.leafPem,
    chainPem: i.version.chainPem,
    keyCiphertextBase64: envelope.ciphertextBase64,
    keyIvBase64: envelope.ivBase64,
    keyAuthTagBase64: envelope.authTagBase64,
    keyVersion: envelope.keyVersion,
    subject: i.version.subject,
    issuer: i.version.issuer,
    serialNumber: i.version.serialNumber,
    fingerprintSha256: i.version.fingerprintSha256,
    notBefore: i.version.notBefore,
    notAfter: i.version.notAfter,
    sanDns: [...i.version.sanDns],
    keyType: i.version.keyType,
    keyBits: i.version.keyBits,
    idempotencyKey: i.idempotencyKey ?? null,
    requestHash: i.requestHash ?? null,
    createdByUserId: i.createdByUserId,
  });
}

export interface InsertTlsCertificateWithVersionInput {
  readonly organizationId: string;
  readonly name: string;
  readonly createdForSiteId: string | null;
  readonly createdByUserId: string | null;
  readonly version: NewTlsVersion;
  readonly masterKey: string | Buffer | Uint8Array;
  readonly idempotencyKey?: string;
  readonly requestHash?: string;
}

/**
 * Creates a certificate with its version 1 (`pending`) in one transaction. The same (organization, idempotency
 * key) with the same request hash replays the stored result; another hash is IDEMPOTENCY_CONFLICT; a fingerprint
 * already imported in the organization is ALREADY_EXISTS (`error.existing` names it).
 */
export async function insertTlsCertificateWithVersion(
  db: HostingPanelDatabase,
  i: InsertTlsCertificateWithVersionInput,
): Promise<{ certificateId: string; versionId: string; replayed: boolean }> {
  const replay = (holder: KeyHolder) => ({ certificateId: holder.certificateId, versionId: holder.id, replayed: true });
  try {
    return await db.transaction(async (tx) => {
      if (i.idempotencyKey !== undefined) {
        const holder = await findVersionByKey(tx, i.organizationId, i.idempotencyKey);
        if (holder) return replay(replayOrConflict(holder, i.requestHash));
      }
      const certificateId = generatePrefixedId("cti");
      const versionId = generatePrefixedId("ctv");
      await tx.insert(tlsCertificates).values({
        id: certificateId,
        organizationId: i.organizationId,
        name: i.name,
        createdForSiteId: i.createdForSiteId,
        createdByUserId: i.createdByUserId,
      });
      await insertVersionRow(tx, {
        versionId,
        certificateId,
        organizationId: i.organizationId,
        versionNumber: 1,
        version: i.version,
        masterKey: i.masterKey,
        createdByUserId: i.createdByUserId,
        ...(i.idempotencyKey === undefined ? {} : { idempotencyKey: i.idempotencyKey }),
        ...(i.requestHash === undefined ? {} : { requestHash: i.requestHash }),
      });
      return { certificateId, versionId, replayed: false };
    });
  } catch (err) {
    return replay(
      await recoverFromUniqueViolation(db, err, {
        organizationId: i.organizationId,
        fingerprintSha256: i.version.fingerprintSha256,
        ...(i.idempotencyKey === undefined ? {} : { idempotencyKey: i.idempotencyKey }),
        ...(i.requestHash === undefined ? {} : { requestHash: i.requestHash }),
      }),
    );
  }
}

export interface InsertTlsCertificateVersionInput {
  readonly organizationId: string;
  readonly certificateId: string;
  readonly createdByUserId: string | null;
  readonly version: NewTlsVersion;
  readonly masterKey: string | Buffer | Uint8Array;
  readonly idempotencyKey?: string;
  readonly requestHash?: string;
}

/**
 * Adds the next version (`pending`) to an existing certificate. The certificate row is locked `FOR UPDATE`, so
 * concurrent callers get distinct, contiguous numbers. A certificate of another organization is NOT_FOUND; the
 * idempotency and duplicate-fingerprint rules are those of `insertTlsCertificateWithVersion`.
 */
export async function insertTlsCertificateVersion(
  db: HostingPanelDatabase,
  i: InsertTlsCertificateVersionInput,
): Promise<{ versionId: string; versionNumber: number; replayed: boolean }> {
  let outcome: { replay: KeyHolder } | { created: { versionId: string; versionNumber: number } };
  try {
    outcome = await db.transaction(async (tx) => {
      const [certificate] = await tx
        .select({ id: tlsCertificates.id })
        .from(tlsCertificates)
        .where(and(eq(tlsCertificates.id, i.certificateId), eq(tlsCertificates.organizationId, i.organizationId)))
        .for("update");
      if (!certificate) {
        throw new TlsRepositoryError("NOT_FOUND", "TLS certificate not found.");
      }
      if (i.idempotencyKey !== undefined) {
        const holder = await findVersionByKey(tx, i.organizationId, i.idempotencyKey);
        if (holder) return { replay: replayOrConflict(holder, i.requestHash, i.certificateId) };
      }
      const [latest] = await tx
        .select({ max: sql<number>`coalesce(max(${tlsCertificateVersions.versionNumber}), 0)` })
        .from(tlsCertificateVersions)
        .where(eq(tlsCertificateVersions.certificateId, i.certificateId));
      const versionNumber = Number(latest?.max ?? 0) + 1;
      const versionId = generatePrefixedId("ctv");
      await insertVersionRow(tx, {
        versionId,
        certificateId: i.certificateId,
        organizationId: i.organizationId,
        versionNumber,
        version: i.version,
        masterKey: i.masterKey,
        createdByUserId: i.createdByUserId,
        ...(i.idempotencyKey === undefined ? {} : { idempotencyKey: i.idempotencyKey }),
        ...(i.requestHash === undefined ? {} : { requestHash: i.requestHash }),
      });
      await tx.update(tlsCertificates).set({ updatedAt: new Date() }).where(eq(tlsCertificates.id, i.certificateId));
      return { created: { versionId, versionNumber } };
    });
  } catch (err) {
    outcome = {
      replay: await recoverFromUniqueViolation(db, err, {
        organizationId: i.organizationId,
        fingerprintSha256: i.version.fingerprintSha256,
        certificateId: i.certificateId,
        ...(i.idempotencyKey === undefined ? {} : { idempotencyKey: i.idempotencyKey }),
        ...(i.requestHash === undefined ? {} : { requestHash: i.requestHash }),
      }),
    };
  }
  if ("created" in outcome) return { ...outcome.created, replayed: false };
  const [stored] = await db
    .select({ versionNumber: tlsCertificateVersions.versionNumber })
    .from(tlsCertificateVersions)
    .where(eq(tlsCertificateVersions.id, outcome.replay.id));
  return { versionId: outcome.replay.id, versionNumber: stored?.versionNumber ?? 0, replayed: true };
}

/** One certificate of the organization with its versions (oldest first); null when absent or of another tenant. */
export async function getTlsCertificate(
  ex: DatabaseExecutor,
  organizationId: string,
  certificateId: string,
): Promise<TlsCertificateRecord | null> {
  const [certificate] = await ex
    .select()
    .from(tlsCertificates)
    .where(and(eq(tlsCertificates.id, certificateId), eq(tlsCertificates.organizationId, organizationId)))
    .limit(1);
  if (!certificate) return null;
  const versions = await ex
    .select(versionColumns)
    .from(tlsCertificateVersions)
    .where(eq(tlsCertificateVersions.certificateId, certificateId))
    .orderBy(asc(tlsCertificateVersions.versionNumber));
  return { ...certificate, versions };
}

/** Every certificate of the organization (oldest first) with its versions; two queries, no N+1. */
export async function listTlsCertificatesForOrganization(
  ex: DatabaseExecutor,
  organizationId: string,
): Promise<TlsCertificateRecord[]> {
  const certificates = await ex
    .select()
    .from(tlsCertificates)
    .where(eq(tlsCertificates.organizationId, organizationId))
    .orderBy(asc(tlsCertificates.createdAt), asc(tlsCertificates.id));
  if (certificates.length === 0) return [];
  const versions = await ex
    .select(versionColumns)
    .from(tlsCertificateVersions)
    .where(
      inArray(
        tlsCertificateVersions.certificateId,
        certificates.map((c) => c.id),
      ),
    )
    .orderBy(asc(tlsCertificateVersions.certificateId), asc(tlsCertificateVersions.versionNumber));
  return certificates.map((certificate) => ({
    ...certificate,
    versions: versions.filter((v) => v.certificateId === certificate.id),
  }));
}

/**
 * Decrypts the key of one version for the hand-over to the executor. The AAD comes from the row's own ids, so an
 * envelope copied onto another row (or a wrong master key) fails authentication instead of yielding a key.
 */
export async function readTlsVersionKey(
  ex: DatabaseExecutor,
  input: { readonly versionId: string; readonly masterKey: string | Buffer | Uint8Array },
): Promise<{ organizationId: string; certificateId: string; fullchainPem: string; privateKeyPem: string }> {
  const [row] = await ex
    .select({
      organizationId: tlsCertificateVersions.organizationId,
      certificateId: tlsCertificateVersions.certificateId,
      leafPem: tlsCertificateVersions.leafPem,
      chainPem: tlsCertificateVersions.chainPem,
      keyCiphertextBase64: tlsCertificateVersions.keyCiphertextBase64,
      keyIvBase64: tlsCertificateVersions.keyIvBase64,
      keyAuthTagBase64: tlsCertificateVersions.keyAuthTagBase64,
    })
    .from(tlsCertificateVersions)
    .where(eq(tlsCertificateVersions.id, input.versionId))
    .limit(1);
  if (!row) {
    throw new TlsRepositoryError("NOT_FOUND", "TLS certificate version not found.");
  }
  const privateKeyPem = decryptSecretAesGcm({
    ...tlsKeyAad(row.organizationId, row.certificateId, input.versionId),
    ciphertextBase64: row.keyCiphertextBase64,
    ivBase64: row.keyIvBase64,
    authTagBase64: row.keyAuthTagBase64,
    masterKey: input.masterKey,
  });
  const chain = row.chainPem.trim();
  return {
    organizationId: row.organizationId,
    certificateId: row.certificateId,
    fullchainPem: chain.length > 0 ? `${row.leafPem.trimEnd()}\n${chain}\n` : `${row.leafPem.trimEnd()}\n`,
    privateKeyPem,
  };
}

/**
 * Hard-deletes a certificate and, by cascade, every version row with its key ciphertext (T10). Refused with
 * CERTIFICATE_IN_USE while any version is assigned to a domain: checked under the certificate and version row locks,
 * so the refusal never aborts the caller's transaction (the composite FK stays the last backstop).
 * Run it inside the caller's transaction; returns the ids and fingerprints the caller audits and garbage-collects.
 */
export async function deleteTlsCertificate(
  tx: DatabaseExecutor,
  input: { readonly organizationId?: string; readonly certificateId: string },
): Promise<{ versionIds: string[]; fingerprints: string[] }> {
  const [certificate] = await tx
    .select({ id: tlsCertificates.id })
    .from(tlsCertificates)
    .where(
      and(
        eq(tlsCertificates.id, input.certificateId),
        input.organizationId === undefined ? undefined : eq(tlsCertificates.organizationId, input.organizationId),
      ),
    )
    .for("update");
  if (!certificate) {
    throw new TlsRepositoryError("NOT_FOUND", "TLS certificate not found.");
  }
  const versions = await tx
    .select({ id: tlsCertificateVersions.id, fingerprintSha256: tlsCertificateVersions.fingerprintSha256 })
    .from(tlsCertificateVersions)
    .where(eq(tlsCertificateVersions.certificateId, input.certificateId))
    .orderBy(asc(tlsCertificateVersions.versionNumber))
    // FOR UPDATE conflicts with the FOR KEY SHARE that assigning a domain takes: a racing assignment either committed
    // before this point (the check below sees it) or waits and fails after the delete, so the DELETE below cannot hit
    // the foreign key and abort the caller's transaction.
    .for("update");
  const inUse = new TlsRepositoryError("CERTIFICATE_IN_USE", "The certificate is assigned to a domain.");
  if (versions.length > 0) {
    const [assigned] = await tx
      .select({ id: domains.id })
      .from(domains)
      .where(
        inArray(
          domains.manualCertificateVersionId,
          versions.map((v) => v.id),
        ),
      )
      .limit(1);
    if (assigned) throw inUse;
  }
  try {
    await tx.delete(tlsCertificates).where(eq(tlsCertificates.id, input.certificateId));
  } catch (err) {
    // Unreachable while the locks above hold; the transaction is already aborted if it ever happens.
    if (pgConstraintViolation(err, "23503") !== null) throw inUse;
    throw err;
  }
  return { versionIds: versions.map((v) => v.id), fingerprints: versions.map((v) => v.fingerprintSha256) };
}

/** Locks the singleton manifest-generation row (`FOR UPDATE`) to serialise publishes server-wide. */
export async function lockTlsPublishState(
  tx: DatabaseExecutor,
): Promise<{ desiredGeneration: number; confirmedGeneration: number }> {
  const [row] = await tx
    .select({
      desiredGeneration: tlsPublishState.desiredGeneration,
      confirmedGeneration: tlsPublishState.confirmedGeneration,
    })
    .from(tlsPublishState)
    .where(eq(tlsPublishState.id, PUBLISH_STATE_ID))
    .for("update");
  if (!row) {
    throw new Error("tls_publish_state singleton row is missing (migration 0021 not applied)");
  }
  return row;
}

/** Increments the desired manifest generation (the UPDATE row lock serialises callers) and returns the new value. */
export async function bumpTlsDesiredGeneration(tx: DatabaseExecutor): Promise<number> {
  const [row] = await tx
    .update(tlsPublishState)
    .set({ desiredGeneration: sql`${tlsPublishState.desiredGeneration} + 1`, updatedAt: new Date() })
    .where(eq(tlsPublishState.id, PUBLISH_STATE_ID))
    .returning({ desiredGeneration: tlsPublishState.desiredGeneration });
  if (!row) {
    throw new Error("tls_publish_state singleton row is missing (migration 0021 not applied)");
  }
  return row.desiredGeneration;
}
