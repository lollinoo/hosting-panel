import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseClient,
  decryptSecretAesGcm,
  deleteMailRelaySettings,
  getMailRelaySettings,
  getMailRelaySettingsPublic,
  MAIL_RELAY_SECRET_AAD,
  sql,
  upsertMailRelaySettings,
  type DatabaseClient,
} from "../src/index.js";

const KEY = "a".repeat(64);
const CANARY = "canary-Relay:pw #1";
const base = { host: "smtp.example.com", port: 587, username: "user", senderDomain: "example.com", actorId: null };

describe("@hosting-panel/database — 0007 mail relay settings", () => {
  let client: DatabaseClient;
  const db = () => client.db;

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
  });
  afterAll(async () => {
    await client.close();
  });

  it("delete returns false when there is nothing to delete", async () => {
    expect(await deleteMailRelaySettings(db())).toBe(false);
    expect(await getMailRelaySettings(db(), KEY)).toBeNull();
    expect(await getMailRelaySettingsPublic(db())).toBeNull();
  });

  it("a null password with no row throws", async () => {
    await expect(upsertMailRelaySettings(db(), KEY, { ...base, password: null })).rejects.toThrow();
  });

  it("settings round-trip through encryption and the row holds no plaintext", async () => {
    await upsertMailRelaySettings(db(), KEY, { ...base, password: CANARY });
    const got = await getMailRelaySettings(db(), KEY);
    expect(got).toMatchObject({ host: base.host, port: 587, username: "user", senderDomain: "example.com", updatedByUserId: null, password: CANARY });
    const raw = await db().execute(sql`SELECT row_to_json(m)::text AS j FROM mail_relay_settings m`);
    expect(JSON.stringify(raw.rows)).not.toContain(CANARY);
    const pub = await getMailRelaySettingsPublic(db());
    expect(pub).not.toHaveProperty("password");
    expect(pub?.ciphertextBase64).toBeTruthy();
  });

  it("a null password keeps the stored envelope", async () => {
    const before = await getMailRelaySettingsPublic(db());
    await upsertMailRelaySettings(db(), KEY, { ...base, host: "smtp2.example.com", password: null });
    const after = await getMailRelaySettingsPublic(db());
    expect(after?.host).toBe("smtp2.example.com");
    expect(after?.ciphertextBase64).toBe(before?.ciphertextBase64);
    expect((await getMailRelaySettings(db(), KEY))?.password).toBe(CANARY);
  });

  it("a second row is impossible", async () => {
    await expect(
      db().execute(sql`INSERT INTO mail_relay_settings (id, host, port, username, sender_domain, password_ciphertext_base64, password_iv_base64, password_auth_tag_base64) VALUES ('other','h',587,'u','d','c','i','t')`),
    ).rejects.toThrow();
  });

  it("the envelope does not decrypt under another AAD", async () => {
    const pub = await db().execute(sql`SELECT password_ciphertext_base64 c, password_iv_base64 i, password_auth_tag_base64 t FROM mail_relay_settings`);
    const r = pub.rows[0] as { c: string; i: string; t: string };
    const env = { ciphertextBase64: r.c, ivBase64: r.i, authTagBase64: r.t, masterKey: KEY };
    expect(decryptSecretAesGcm({ ...env, ...MAIL_RELAY_SECRET_AAD })).toBe(CANARY);
    expect(() => decryptSecretAesGcm({ ...env, ...MAIL_RELAY_SECRET_AAD, secretKey: "OTHER" })).toThrow();
    expect(await deleteMailRelaySettings(db())).toBe(true);
  });
});
