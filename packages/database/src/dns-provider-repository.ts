import { count, eq } from "drizzle-orm";
import type { DnsProvider } from "@hosting-panel/contracts";
import type { DatabaseExecutor } from "./client.js";
import { dnsProviderSettings, domains } from "./schema.js";
import { decryptSecretAesGcm, encryptSecretAesGcm } from "./secrets-crypto.js";

export const DNS_PROVIDER_SECRET_AAD = {
  organizationId: "platform",
  siteId: null,
  secretKey: "HP_ACME_DNS_CREDENTIALS",
} as const;

const ROW_ID = "default";

export interface DnsProviderSettings {
  provider: DnsProvider;
  credentials: Record<string, string>;
  updatedAt: Date;
  updatedByUserId: string | null;
}

type Row = typeof dnsProviderSettings.$inferSelect;

async function readRow(db: DatabaseExecutor): Promise<Row | null> {
  const [row] = await db.select().from(dnsProviderSettings).where(eq(dnsProviderSettings.id, ROW_ID));
  return row ?? null;
}

export async function getDnsProviderSettings(
  db: DatabaseExecutor,
  masterKey: string,
): Promise<DnsProviderSettings | null> {
  const row = await readRow(db);
  if (!row) return null;
  const plaintext = decryptSecretAesGcm({
    ...DNS_PROVIDER_SECRET_AAD,
    ciphertextBase64: row.credentialsCiphertextBase64,
    ivBase64: row.credentialsIvBase64,
    authTagBase64: row.credentialsAuthTagBase64,
    masterKey,
  });
  return {
    provider: row.provider,
    credentials: JSON.parse(plaintext) as Record<string, string>,
    updatedAt: row.updatedAt,
    updatedByUserId: row.updatedByUserId,
  };
}

/** Never decrypts. The ciphertext is for the apply fingerprint only and must not reach a DTO. */
export async function getDnsProviderSettingsPublic(db: DatabaseExecutor): Promise<{
  provider: DnsProvider;
  fieldsSet: string[];
  updatedAt: Date;
  updatedByUserId: string | null;
  ciphertextBase64: string;
} | null> {
  const row = await readRow(db);
  if (!row) return null;
  return {
    provider: row.provider,
    fieldsSet: row.credentialNames,
    updatedAt: row.updatedAt,
    updatedByUserId: row.updatedByUserId,
    ciphertextBase64: row.credentialsCiphertextBase64,
  };
}

/** Stores the full credential set; the caller merges any kept values first. */
export async function upsertDnsProviderSettings(
  tx: DatabaseExecutor,
  masterKey: string,
  input: { provider: DnsProvider; credentials: Record<string, string>; actorId: string | null },
): Promise<void> {
  const names = Object.keys(input.credentials).sort();
  if (names.length === 0) throw new Error("DNS provider credentials are required");
  const sorted = Object.fromEntries(names.map((name) => [name, input.credentials[name]]));
  const env = encryptSecretAesGcm({ ...DNS_PROVIDER_SECRET_AAD, plaintext: JSON.stringify(sorted), masterKey });
  const fields = {
    provider: input.provider,
    credentialNames: names,
    credentialsCiphertextBase64: env.ciphertextBase64,
    credentialsIvBase64: env.ivBase64,
    credentialsAuthTagBase64: env.authTagBase64,
    credentialsKeyVersion: env.keyVersion,
    updatedByUserId: input.actorId,
    updatedAt: new Date(),
  };
  await tx
    .insert(dnsProviderSettings)
    .values({ id: ROW_ID, ...fields })
    .onConflictDoUpdate({ target: dnsProviderSettings.id, set: fields });
}

export async function deleteDnsProviderSettings(tx: DatabaseExecutor): Promise<boolean> {
  const rows = await tx
    .delete(dnsProviderSettings)
    .where(eq(dnsProviderSettings.id, ROW_ID))
    .returning({ id: dnsProviderSettings.id });
  return rows.length > 0;
}

export async function countDnsChallengeDomains(db: DatabaseExecutor): Promise<number> {
  const [row] = await db.select({ n: count() }).from(domains).where(eq(domains.certChallenge, "dns-01"));
  return row?.n ?? 0;
}
