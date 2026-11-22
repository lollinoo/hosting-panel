// Immutable secret versions of a stack (AES-256-GCM, AAD "<org>:*:app:<stack>:<parameter>:<version>"); only metadata
// leaves this module, except the just-in-time hand-off to the executor. Lock order: stack row FOR NO KEY UPDATE.

import { randomUUID } from "node:crypto";
import { APP_ID_PREFIXES, APP_STACK_SECRET_CONTENT_MAX_CHARS, APP_TEMPLATE_PARAMETER_KEY_PATTERN } from "@hosting-panel/contracts";
import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { DatabaseExecutor, HostingPanelDatabase } from "./client.js";
import { appStacks, appStackSecrets } from "./schema.js";
import { decryptSecretAesGcm, encryptSecretAesGcm, type SecretAesGcmAadContext } from "./secrets-crypto.js";

/** What a secret looks like to everybody outside the executor hand-off: no value, no ciphertext. */
export interface AppStackSecretMetadata {
  readonly parameterKey: string;
  readonly version: number;
  readonly rotatedAt: Date;
}

export type AppStackSecretErrorCode = "NOT_FOUND" | "VALIDATION_ERROR" | "SECRET_MISSING" | "RATE_LIMITED";

/** New versions per stack (all keys) in a rolling hour: every version is immutable and kept while the stack lives. */
export const APP_STACK_SECRET_VERSIONS_PER_HOUR = 10;

export class AppStackSecretError extends Error {
  constructor(
    readonly code: AppStackSecretErrorCode,
    message: string,
    /** RATE_LIMITED: until the oldest version of the window is an hour old. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AppStackSecretError";
  }
}

/** The 0025 CHECK caps ciphertext_base64 at 32768 chars, i.e. 24576 plaintext bytes. */
const VALUE_MAX_UTF8_BYTES = 24_576;
const HOUR_MS = 3_600_000;
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
const metadataColumns = {
  parameterKey: appStackSecrets.parameterKey,
  version: appStackSecrets.version,
  rotatedAt: appStackSecrets.createdAt,
};

/** Same envelope as sites (secrets-crypto.ts:48) with a stack scope: "<org>:*:app:<stack>:<parameter>:<version>". */
export function appStackSecretAad(
  organizationId: string,
  stackId: string,
  parameterKey: string,
  version: number,
): SecretAesGcmAadContext {
  return { organizationId, siteId: null, secretKey: `app:${stackId}:${parameterKey}:${String(version)}` };
}

/** Own transaction (a savepoint when nested): stores the next version of a secret of a live stack of the organization. */
export async function setAppStackSecretTransactional(
  db: HostingPanelDatabase,
  input: {
    readonly organizationId: string;
    readonly stackId: string;
    readonly parameterKey: string;
    readonly value: string;
    readonly masterKey: string | Buffer | Uint8Array;
    readonly keyVersion?: string;
  },
): Promise<AppStackSecretMetadata> {
  if (
    !APP_TEMPLATE_PARAMETER_KEY_PATTERN.test(input.parameterKey) ||
    input.value.length < 1 ||
    input.value.length > APP_STACK_SECRET_CONTENT_MAX_CHARS ||
    Buffer.byteLength(input.value, "utf8") > VALUE_MAX_UTF8_BYTES
  ) {
    throw new AppStackSecretError("VALIDATION_ERROR", "The secret parameter key or value length is invalid.");
  }
  return db.transaction(async (tx) => {
    const [stack] = await tx
      .select({ id: appStacks.id })
      .from(appStacks)
      .where(and(eq(appStacks.id, input.stackId), eq(appStacks.organizationId, input.organizationId), isNull(appStacks.deletedAt)))
      .for("no key update");
    if (!stack) throw new AppStackSecretError("NOT_FOUND", "Application stack not found.");
    const recent = await tx
      .select({ at: appStackSecrets.createdAt })
      .from(appStackSecrets)
      .where(and(eq(appStackSecrets.stackId, input.stackId), gt(appStackSecrets.createdAt, sql`now() - interval '1 hour'`)))
      .orderBy(desc(appStackSecrets.createdAt))
      .limit(APP_STACK_SECRET_VERSIONS_PER_HOUR);
    if (recent.length >= APP_STACK_SECRET_VERSIONS_PER_HOUR) {
      const freesAt = recent[recent.length - 1]!.at.getTime() + HOUR_MS;
      throw new AppStackSecretError("RATE_LIMITED", "Too many secret versions in the last hour.", Math.max(1_000, freesAt - Date.now()));
    }
    const [latest] = await tx
      .select({ max: sql<number>`coalesce(max(${appStackSecrets.version}), 0)` })
      .from(appStackSecrets)
      .where(and(eq(appStackSecrets.stackId, input.stackId), eq(appStackSecrets.parameterKey, input.parameterKey)));
    const version = Number(latest?.max ?? 0) + 1;
    const envelope = encryptSecretAesGcm({
      ...appStackSecretAad(input.organizationId, input.stackId, input.parameterKey, version),
      plaintext: input.value,
      masterKey: input.masterKey,
      keyVersion: input.keyVersion,
    });
    const [row] = await tx
      .insert(appStackSecrets)
      .values({
        id: newId(APP_ID_PREFIXES.secret),
        stackId: input.stackId,
        organizationId: input.organizationId,
        parameterKey: input.parameterKey,
        version,
        ciphertextBase64: envelope.ciphertextBase64,
        ivBase64: envelope.ivBase64,
        authTagBase64: envelope.authTagBase64,
        keyVersion: envelope.keyVersion,
      })
      .returning(metadataColumns);
    return row!;
  });
}

/** Latest version per key, ORDER BY parameter_key. */
export async function listAppStackSecretMetadata(
  db: DatabaseExecutor,
  input: { organizationId: string; stackId: string },
): Promise<AppStackSecretMetadata[]> {
  return db
    .selectDistinctOn([appStackSecrets.parameterKey], metadataColumns)
    .from(appStackSecrets)
    .where(and(eq(appStackSecrets.organizationId, input.organizationId), eq(appStackSecrets.stackId, input.stackId)))
    .orderBy(asc(appStackSecrets.parameterKey), desc(appStackSecrets.version));
}

/**
 * Just-in-time hand-off to the executor: decrypts exactly the pinned (parameterKey, version) pairs of a revision, in
 * the order given; a missing pair is SECRET_MISSING (reason STACK_SECRET_MISSING).
 */
export async function readAppStackSecretFiles(
  db: DatabaseExecutor,
  input: {
    readonly organizationId: string;
    readonly stackId: string;
    readonly masterKey: string | Buffer | Uint8Array;
    readonly refs: readonly { readonly parameterKey: string; readonly version: number }[];
  },
): Promise<readonly { readonly parameterKey: string; readonly version: number; readonly content: string }[]> {
  if (input.refs.length === 0) return [];
  const rows = await db
    .select()
    .from(appStackSecrets)
    .where(
      and(
        eq(appStackSecrets.organizationId, input.organizationId),
        eq(appStackSecrets.stackId, input.stackId),
        or(...input.refs.map((ref) => and(eq(appStackSecrets.parameterKey, ref.parameterKey), eq(appStackSecrets.version, ref.version)))),
      ),
    );
  return input.refs.map(({ parameterKey, version }) => {
    const row = rows.find((r) => r.parameterKey === parameterKey && r.version === version);
    if (!row) throw new AppStackSecretError("SECRET_MISSING", `Secret '${parameterKey}' version ${String(version)} is missing.`);
    const content = decryptSecretAesGcm({
      ...appStackSecretAad(input.organizationId, input.stackId, parameterKey, version),
      ciphertextBase64: row.ciphertextBase64,
      ivBase64: row.ivBase64,
      authTagBase64: row.authTagBase64,
      masterKey: input.masterKey,
    });
    return { parameterKey, version, content };
  });
}
