import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  countDnsChallengeDomains,
  createDatabaseClient,
  decryptSecretAesGcm,
  deleteDnsProviderSettings,
  DNS_PROVIDER_SECRET_AAD,
  domains,
  eq,
  getDnsProviderSettings,
  getDnsProviderSettingsPublic,
  resolveMigrationsDirectory,
  seedPhase1Dataset,
  sql,
  upsertDnsProviderSettings,
  type DatabaseClient,
} from "../src/index.js";

const KEY = "a".repeat(64);
const CANARY = "canary-Dns:token #1";
const credentials = { OVH_ENDPOINT: "ovh-eu", OVH_APPLICATION_KEY: CANARY, OVH_APPLICATION_SECRET: "s", OVH_CONSUMER_KEY: "c" };

describe("@hosting-panel/database — 0020 dns provider settings and domain challenge", () => {
  let client: DatabaseClient;
  const db = () => client.db;

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await seedPhase1Dataset(client.db);
  });
  afterAll(async () => {
    await client.close();
  });

  it("delete returns false when there is nothing to delete", async () => {
    expect(await deleteDnsProviderSettings(db())).toBe(false);
    expect(await getDnsProviderSettings(db(), KEY)).toBeNull();
    expect(await getDnsProviderSettingsPublic(db())).toBeNull();
  });

  it("empty credentials throw", async () => {
    await expect(upsertDnsProviderSettings(db(), KEY, { provider: "cloudflare", credentials: {}, actorId: null })).rejects.toThrow();
  });

  it("settings round-trip through encryption and the row holds no plaintext", async () => {
    await upsertDnsProviderSettings(db(), KEY, { provider: "ovh", credentials, actorId: null });
    const got = await getDnsProviderSettings(db(), KEY);
    expect(got).toMatchObject({ provider: "ovh", credentials, updatedByUserId: null });
    expect(got?.updatedAt).toBeInstanceOf(Date);
    const raw = await db().execute(sql`SELECT row_to_json(d)::text AS j FROM dns_provider_settings d`);
    expect(JSON.stringify(raw.rows)).not.toContain(CANARY);
    expect(JSON.stringify(raw.rows)).not.toContain("ovh-eu");
  });

  it("the public read never decrypts and lists the field names", async () => {
    const pub = await getDnsProviderSettingsPublic(db());
    expect(pub).not.toHaveProperty("credentials");
    expect(pub?.provider).toBe("ovh");
    expect(pub?.fieldsSet).toEqual(["OVH_APPLICATION_KEY", "OVH_APPLICATION_SECRET", "OVH_CONSUMER_KEY", "OVH_ENDPOINT"]);
    expect(pub?.ciphertextBase64).toBeTruthy();
    expect(JSON.stringify(pub)).not.toContain(CANARY);
  });

  it("an upsert replaces the provider and the field names", async () => {
    await upsertDnsProviderSettings(db(), KEY, { provider: "cloudflare", credentials: { CLOUDFLARE_DNS_API_TOKEN: CANARY }, actorId: null });
    expect((await getDnsProviderSettingsPublic(db()))?.fieldsSet).toEqual(["CLOUDFLARE_DNS_API_TOKEN"]);
    expect((await getDnsProviderSettings(db(), KEY))?.credentials).toEqual({ CLOUDFLARE_DNS_API_TOKEN: CANARY });
    const count = await db().execute(sql`SELECT count(*)::int AS n FROM dns_provider_settings`);
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });

  it("a second row is impossible", async () => {
    await expect(
      db().execute(sql`INSERT INTO dns_provider_settings (id, provider, credentials_ciphertext_base64, credentials_iv_base64, credentials_auth_tag_base64) VALUES ('other','ovh','c','i','t')`),
    ).rejects.toThrow();
  });

  it("the envelope does not decrypt under another AAD", async () => {
    const pub = await db().execute(sql`SELECT credentials_ciphertext_base64 c, credentials_iv_base64 i, credentials_auth_tag_base64 t FROM dns_provider_settings`);
    const r = pub.rows[0] as { c: string; i: string; t: string };
    const env = { ciphertextBase64: r.c, ivBase64: r.i, authTagBase64: r.t, masterKey: KEY };
    expect(JSON.parse(decryptSecretAesGcm({ ...env, ...DNS_PROVIDER_SECRET_AAD }))).toEqual({ CLOUDFLARE_DNS_API_TOKEN: CANARY });
    expect(() => decryptSecretAesGcm({ ...env, ...DNS_PROVIDER_SECRET_AAD, secretKey: "HP_MAIL_RELAY_PASSWORD" })).toThrow();
    expect(await deleteDnsProviderSettings(db())).toBe(true);
  });

  it("migration 0020 gives existing domains http-01 and accepts dns_provider", async () => {
    // Migrate a fresh database up to 0019, add a domain, then run 0020 on the populated table.
    const dir = resolveMigrationsDirectory();
    const pg = new PGlite();
    try {
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
        if (file >= "0020") break;
        await pg.exec(readFileSync(path.join(dir, file), "utf8"));
      }
      await pg.exec(`
        INSERT INTO platform_installations (id, name) VALUES ('pi', 'pi');
        INSERT INTO hosts (id, platform_installation_id, name, hostname, ipv4_address, total_cpu_milli, total_memory_bytes, total_storage_bytes)
          VALUES ('h', 'pi', 'h', 'h.example', '192.0.2.1', 1000, '1', '1');
        INSERT INTO organizations (id, platform_installation_id, name, slug) VALUES ('o', 'pi', 'o', 'o');
        INSERT INTO host_allocations (id, host_id, organization_id) VALUES ('a', 'h', 'o');
        INSERT INTO sites (id, organization_id, host_allocation_id, name, slug) VALUES ('s', 'o', 'a', 's', 's');
        INSERT INTO domains (id, site_id, organization_id, hostname, cert_status, cert_problem) VALUES ('d', 's', 'o', 'd.example', 'failed', 'other');
      `);
      await expect(pg.exec("UPDATE domains SET cert_problem = 'dns_provider' WHERE id = 'd'")).rejects.toThrow();
      await pg.exec(readFileSync(path.join(dir, "0020_dns_challenge.sql"), "utf8"));
      expect((await pg.query("SELECT cert_challenge, cert_problem FROM domains")).rows).toEqual([{ cert_challenge: "http-01", cert_problem: "other" }]);
      await pg.exec("UPDATE domains SET cert_problem = 'dns_provider' WHERE id = 'd'");
      await expect(pg.exec("UPDATE domains SET cert_problem = 'bogus' WHERE id = 'd'")).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });

  it("cert_challenge refuses other values", async () => {
    const [first] = await db().select({ id: domains.id }).from(domains).limit(1);
    await expect(db().execute(sql`UPDATE domains SET cert_challenge = 'tls-alpn-01' WHERE id = ${first!.id}`)).rejects.toThrow();
    await expect(db().execute(sql`UPDATE domains SET cert_challenge = NULL WHERE id = ${first!.id}`)).rejects.toThrow();
  });

  it("countDnsChallengeDomains counts only dns-01 rows", async () => {
    expect(await countDnsChallengeDomains(db())).toBe(0);
    const rows = await db().select({ id: domains.id }).from(domains).limit(2);
    expect(rows.length).toBe(2);
    await db().update(domains).set({ certChallenge: "dns-01" }).where(eq(domains.id, rows[0]!.id));
    expect(await countDnsChallengeDomains(db())).toBe(1);
    await db().update(domains).set({ certChallenge: "dns-01" }).where(eq(domains.id, rows[1]!.id));
    expect(await countDnsChallengeDomains(db())).toBe(2);
    await db().update(domains).set({ certChallenge: "http-01" });
    expect(await countDnsChallengeDomains(db())).toBe(0);
  });
});
