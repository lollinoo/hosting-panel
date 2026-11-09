import { eq } from "drizzle-orm";
import type { DatabaseExecutor } from "./client.js";
import { mailRelaySettings } from "./schema.js";
import { decryptSecretAesGcm, encryptSecretAesGcm } from "./secrets-crypto.js";

export const MAIL_RELAY_SECRET_AAD = {
  organizationId: "platform",
  siteId: null,
  secretKey: "HP_MAIL_RELAY_PASSWORD",
} as const;

const ROW_ID = "default";

export interface MailRelaySettings {
  host: string;
  port: number;
  username: string;
  senderDomain: string;
  password: string;
  updatedAt: Date;
  updatedByUserId: string | null;
}

type Row = typeof mailRelaySettings.$inferSelect;

async function readRow(db: DatabaseExecutor): Promise<Row | null> {
  const [row] = await db.select().from(mailRelaySettings).where(eq(mailRelaySettings.id, ROW_ID));
  return row ?? null;
}

function publicFields(row: Row) {
  return {
    host: row.host,
    port: row.port,
    username: row.username,
    senderDomain: row.senderDomain,
    updatedAt: row.updatedAt,
    updatedByUserId: row.updatedByUserId,
  };
}

export async function getMailRelaySettings(
  db: DatabaseExecutor,
  masterKey: string,
): Promise<MailRelaySettings | null> {
  const row = await readRow(db);
  if (!row) return null;
  const password = decryptSecretAesGcm({
    ...MAIL_RELAY_SECRET_AAD,
    ciphertextBase64: row.passwordCiphertextBase64,
    ivBase64: row.passwordIvBase64,
    authTagBase64: row.passwordAuthTagBase64,
    masterKey,
  });
  return { ...publicFields(row), password };
}

/** Never decrypts. The ciphertext is for the apply fingerprint only and must not reach a DTO. */
export async function getMailRelaySettingsPublic(
  db: DatabaseExecutor,
): Promise<(Omit<MailRelaySettings, "password"> & { ciphertextBase64: string }) | null> {
  const row = await readRow(db);
  return row ? { ...publicFields(row), ciphertextBase64: row.passwordCiphertextBase64 } : null;
}

export async function upsertMailRelaySettings(
  tx: DatabaseExecutor,
  masterKey: string,
  input: {
    host: string;
    port: number;
    username: string;
    senderDomain: string;
    password: string | null;
    actorId: string | null;
  },
): Promise<void> {
  const fields = {
    host: input.host,
    port: input.port,
    username: input.username,
    senderDomain: input.senderDomain,
    updatedByUserId: input.actorId,
    updatedAt: new Date(),
  };
  if (input.password === null) {
    const updated = await tx
      .update(mailRelaySettings)
      .set(fields)
      .where(eq(mailRelaySettings.id, ROW_ID))
      .returning({ id: mailRelaySettings.id });
    if (updated.length === 0) throw new Error("Mail relay password is required: no settings stored yet");
    return;
  }
  const env = encryptSecretAesGcm({ ...MAIL_RELAY_SECRET_AAD, plaintext: input.password, masterKey });
  const withSecret = {
    ...fields,
    passwordCiphertextBase64: env.ciphertextBase64,
    passwordIvBase64: env.ivBase64,
    passwordAuthTagBase64: env.authTagBase64,
    passwordKeyVersion: env.keyVersion,
  };
  await tx
    .insert(mailRelaySettings)
    .values({ id: ROW_ID, ...withSecret })
    .onConflictDoUpdate({ target: mailRelaySettings.id, set: withSecret });
}

export async function deleteMailRelaySettings(tx: DatabaseExecutor): Promise<boolean> {
  const rows = await tx.delete(mailRelaySettings).where(eq(mailRelaySettings.id, ROW_ID)).returning({ id: mailRelaySettings.id });
  return rows.length > 0;
}
