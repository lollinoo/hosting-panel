import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildSecretAesGcmAad,
  createDatabaseClient,
  createSiteTransactional,
  decryptSecretAesGcm,
  domains,
  eq,
  hostAllocations,
  hosts,
  organizations,
  platformInstallations,
  sql,
  tlsCertificates,
  tlsCertificateVersions,
  tlsPublishState,
  users,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "../src/index.js";
import {
  bumpTlsDesiredGeneration,
  deleteTlsCertificate,
  getTlsCertificate,
  insertTlsCertificateVersion,
  insertTlsCertificateWithVersion,
  listTlsCertificatesForOrganization,
  lockTlsPublishState,
  readTlsVersionKey,
  tlsKeyAad,
  type NewTlsVersion,
} from "../src/tls-certificates-repository.js";

// HCP-SPEC-004 TLS-01/02/11: repository of imported TLS certificates (migration 0021).
const MASTER_KEY = "c".repeat(64);
const OTHER_KEY = "d".repeat(64);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

// The only fields a version record may expose: no PEM, key, ciphertext, key version or idempotency data.
const VERSION_RECORD_KEYS = [
  "activatedAt",
  "certificateId",
  "createdAt",
  "createdByUserId",
  "fingerprintSha256",
  "id",
  "issuer",
  "keyBits",
  "keyType",
  "lastCheckedAt",
  "lastErrorCode",
  "notAfter",
  "notBefore",
  "organizationId",
  "publishGeneration",
  "sanDns",
  "serialNumber",
  "status",
  "subject",
  "versionNumber",
];

// Fake material: the repository stores what the API already validated, it never parses a certificate.
const keyPem = (n: number) => `-----BEGIN PRIVATE KEY-----\nKEYMATERIAL${String(n)}\n-----END PRIVATE KEY-----\n`;

const newVersion = (n: number, extra: Partial<NewTlsVersion> = {}): NewTlsVersion => ({
  leafPem: `-----BEGIN CERTIFICATE-----\nLEAF${String(n)}\n-----END CERTIFICATE-----\n`,
  chainPem: `-----BEGIN CERTIFICATE-----\nCHAIN${String(n)}\n-----END CERTIFICATE-----\n`,
  privateKeyPem: keyPem(n),
  subject: `CN=host${String(n)}.example`,
  issuer: "CN=Test CA",
  serialNumber: n.toString(16).padStart(4, "0"),
  fingerprintSha256: n.toString(16).padStart(64, "0"),
  notBefore: new Date("2026-11-01T00:00:00.000Z"),
  notAfter: new Date("2027-11-01T00:00:00.000Z"),
  sanDns: [`host${String(n)}.example`, `*.host${String(n)}.example`],
  keyType: "ec",
  keyBits: 256,
  ...extra,
});

describe("@hosting-panel/database — tls certificates repository", () => {
  let client: DatabaseClient;
  const db = () => client.db;

  const orgA = "org_tls_a";
  const orgB = "org_tls_b";
  let siteA = "";
  let siteB = "";
  let counter = 100; // unique fingerprint per test

  const nextVersion = (extra: Partial<NewTlsVersion> = {}) => newVersion((counter += 1), extra);
  const importCert = (organizationId = orgA, extra: { name?: string; key?: string; hash?: string; version?: NewTlsVersion } = {}) =>
    insertTlsCertificateWithVersion(db(), {
      organizationId,
      name: extra.name ?? "Shop certificate",
      createdForSiteId: null,
      createdByUserId: null,
      version: extra.version ?? nextVersion(),
      masterKey: MASTER_KEY,
      ...(extra.key === undefined ? {} : { idempotencyKey: extra.key }),
      ...(extra.hash === undefined ? {} : { requestHash: extra.hash }),
    });
  const countRows = async () => ({
    certificates: (await db().select().from(tlsCertificates)).length,
    versions: (await db().select().from(tlsCertificateVersions)).length,
  });

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await db().insert(platformInstallations).values({ id: "pin_tls", name: "Platform" });
    await db().insert(hosts).values({
      id: "hst_tls",
      platformInstallationId: "pin_tls",
      name: "tls-host",
      hostname: "tls-host.local",
      ipv4Address: "10.0.0.30",
      totalCpuMilli: 4000,
      totalMemoryBytes: "4000000000",
      totalStorageBytes: "100000000000",
    });
    await db().insert(users).values({ id: "usr_tls", email: "tls@example.com", name: "Tls", passwordHash: "hash" });
    for (const [orgId, alloc, slug] of [
      [orgA, "alloc_tls_a", "tls-a"],
      [orgB, "alloc_tls_b", "tls-b"],
    ] as const) {
      await db().insert(organizations).values({ id: orgId, platformInstallationId: "pin_tls", name: slug, slug });
      await db().insert(hostAllocations).values({ id: alloc, hostId: "hst_tls", organizationId: orgId, status: "active" });
    }
    siteA = (
      await createSiteTransactional(db(), {
        organizationId: orgA,
        hostAllocationId: "alloc_tls_a",
        name: "Site A",
        slug: "site-a",
        phpVersion: "8.4",
        siteType: "wordpress",
      })
    ).site.id;
    siteB = (
      await createSiteTransactional(db(), {
        organizationId: orgB,
        hostAllocationId: "alloc_tls_b",
        name: "Site B",
        slug: "site-b",
        phpVersion: "8.4",
        siteType: "wordpress",
      })
    ).site.id;
  }, 120_000);

  afterAll(async () => {
    await client.close();
  });

  describe("key envelope (AES-256-GCM, AAD <org>:*:tls:<certificate>:<version>)", () => {
    it("builds the AAD from organization, certificate and version", () => {
      const context = tlsKeyAad("org_1", "cti_1", "ctv_1");
      expect(context).toEqual({ organizationId: "org_1", siteId: null, secretKey: "tls:cti_1:ctv_1" });
      expect(buildSecretAesGcmAad(context).toString("utf8")).toBe("org_1:*:tls:cti_1:ctv_1");
    });

    it("stores the key encrypted: it opens only with the exact AAD and the right master key", async () => {
      const created = await importCert(orgA, { version: newVersion(1) });
      expect(created.certificateId).toMatch(/^cti_[0-9a-f]{32}$/);
      expect(created.versionId).toMatch(/^ctv_[0-9a-f]{32}$/);
      expect(created.replayed).toBe(false);

      const [row] = await db().select().from(tlsCertificateVersions).where(eq(tlsCertificateVersions.id, created.versionId));
      expect(row).toMatchObject({
        certificateId: created.certificateId,
        organizationId: orgA,
        versionNumber: 1,
        status: "pending",
        keyVersion: "v1",
        publishGeneration: 0,
        lastErrorCode: null,
        activatedAt: null,
        idempotencyKey: null,
        requestHash: null,
        fingerprintSha256: "0".repeat(63) + "1",
        sanDns: ["host1.example", "*.host1.example"],
        keyType: "ec",
        keyBits: 256,
      });
      expect(JSON.stringify(row)).not.toContain("KEYMATERIAL");
      expect(row?.keyCiphertextBase64).not.toContain("KEYMATERIAL");

      const envelope = {
        ciphertextBase64: row?.keyCiphertextBase64 ?? "",
        ivBase64: row?.keyIvBase64 ?? "",
        authTagBase64: row?.keyAuthTagBase64 ?? "",
      };
      const aad = tlsKeyAad(orgA, created.certificateId, created.versionId);
      expect(decryptSecretAesGcm({ ...envelope, ...aad, masterKey: MASTER_KEY })).toBe(keyPem(1));
      for (const wrong of [
        tlsKeyAad(orgB, created.certificateId, created.versionId),
        tlsKeyAad(orgA, "cti_other", created.versionId),
        tlsKeyAad(orgA, created.certificateId, "ctv_other"),
      ]) {
        expect(() => decryptSecretAesGcm({ ...envelope, ...wrong, masterKey: MASTER_KEY })).toThrow();
      }
      expect(() => decryptSecretAesGcm({ ...envelope, ...aad, masterKey: OTHER_KEY })).toThrow();
    });

    it("keeps the provenance site and the author on the certificate row", async () => {
      const created = await insertTlsCertificateWithVersion(db(), {
        organizationId: orgA,
        name: "From a site",
        createdForSiteId: siteA,
        createdByUserId: "usr_tls",
        version: nextVersion(),
        masterKey: MASTER_KEY,
      });
      const cert = await getTlsCertificate(db(), orgA, created.certificateId);
      expect(cert).toMatchObject({
        id: created.certificateId,
        organizationId: orgA,
        name: "From a site",
        createdForSiteId: siteA,
        activeVersionId: null,
        createdByUserId: "usr_tls",
      });
    });
  });

  describe("idempotency and duplicates", () => {
    it("replays the same key with the same request hash and writes nothing", async () => {
      const first = await importCert(orgA, { key: "idem-replay", hash: HASH_A });
      const before = await countRows();
      const replay = await insertTlsCertificateWithVersion(db(), {
        organizationId: orgA,
        name: "Shop certificate",
        createdForSiteId: null,
        createdByUserId: null,
        version: nextVersion(),
        masterKey: MASTER_KEY,
        idempotencyKey: "idem-replay",
        requestHash: HASH_A,
      });
      expect(replay).toEqual({ certificateId: first.certificateId, versionId: first.versionId, replayed: true });
      expect(await countRows()).toEqual(before);
    });

    it("refuses the same key with another request hash (IDEMPOTENCY_CONFLICT) and writes nothing", async () => {
      await importCert(orgA, { key: "idem-conflict", hash: HASH_A });
      const before = await countRows();
      await expect(importCert(orgA, { key: "idem-conflict", hash: HASH_B })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(await countRows()).toEqual(before);
    });

    it("scopes the key to the organization", async () => {
      const a = await importCert(orgA, { key: "idem-scope", hash: HASH_A });
      const b = await importCert(orgB, { key: "idem-scope", hash: HASH_A });
      expect(b.replayed).toBe(false);
      expect(b.certificateId).not.toBe(a.certificateId);
    });

    it("refuses a duplicate fingerprint in the organization (ALREADY_EXISTS) naming the existing ids, and leaves no orphan certificate", async () => {
      const version = nextVersion();
      const first = await importCert(orgA, { version });
      const before = await countRows();
      const error = await importCert(orgA, { name: "Same file again", version }).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: "ALREADY_EXISTS",
        existing: { certificateId: first.certificateId, versionId: first.versionId },
      });
      expect(await countRows()).toEqual(before);
      // another organization may hold the very same file
      await expect(importCert(orgB, { version })).resolves.toMatchObject({ replayed: false });
    });

    it("recovers a replay when a concurrent writer commits the same key between the check and the insert", async () => {
      const winner = await importCert(orgA, { key: "idem-race", hash: HASH_A });
      const before = await countRows();
      // The proxied transaction sees an empty result for its first read (the replay check), as a second connection would.
      const racing = new Proxy(db(), {
        get(target, prop) {
          if (prop !== "transaction") return Reflect.get(target, prop) as unknown;
          return (work: (tx: unknown) => Promise<unknown>) =>
            target.transaction((tx) => {
              let blinded = false;
              const blindTx = new Proxy(tx, {
                get(txTarget, txProp) {
                  if (txProp === "select" && !blinded) {
                    blinded = true;
                    const empty: Record<string, unknown> = {
                      from: () => empty,
                      where: () => empty,
                      limit: () => empty,
                      then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
                    };
                    return () => empty;
                  }
                  const value = Reflect.get(txTarget, txProp) as unknown;
                  return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(txTarget) : value;
                },
              });
              return work(blindTx);
            });
        },
      }) as HostingPanelDatabase;

      const result = await insertTlsCertificateWithVersion(racing, {
        organizationId: orgA,
        name: "Shop certificate",
        createdForSiteId: null,
        createdByUserId: null,
        version: nextVersion(),
        masterKey: MASTER_KEY,
        idempotencyKey: "idem-race",
        requestHash: HASH_A,
      });
      expect(result).toEqual({ certificateId: winner.certificateId, versionId: winner.versionId, replayed: true });
      expect(await countRows()).toEqual(before);
    });
  });

  describe("new versions of a certificate", () => {
    it("numbers versions max+1 on the same certificate and touches updated_at", async () => {
      const created = await importCert(orgA);
      const [before] = await db().select().from(tlsCertificates).where(eq(tlsCertificates.id, created.certificateId));
      const v2 = nextVersion();
      const second = await insertTlsCertificateVersion(db(), {
        organizationId: orgA,
        certificateId: created.certificateId,
        createdByUserId: "usr_tls",
        version: v2,
        masterKey: MASTER_KEY,
      });
      expect(second).toMatchObject({ versionNumber: 2, replayed: false });
      expect(second.versionId).toMatch(/^ctv_[0-9a-f]{32}$/);

      const [row] = await db().select().from(tlsCertificateVersions).where(eq(tlsCertificateVersions.id, second.versionId));
      expect(row).toMatchObject({ certificateId: created.certificateId, organizationId: orgA, versionNumber: 2, status: "pending", createdByUserId: "usr_tls" });
      const [after] = await db().select().from(tlsCertificates).where(eq(tlsCertificates.id, created.certificateId));
      expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(before?.updatedAt.getTime() ?? Infinity);
      // the key of the new version is bound to the new version id
      const key = await readTlsVersionKey(db(), { versionId: second.versionId, masterKey: MASTER_KEY });
      expect(key.privateKeyPem).toBe(v2.privateKeyPem);
    });

    it("hands out distinct contiguous numbers to concurrent transactions", async () => {
      const created = await importCert(orgA);
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          insertTlsCertificateVersion(db(), {
            organizationId: orgA,
            certificateId: created.certificateId,
            createdByUserId: null,
            version: nextVersion(),
            masterKey: MASTER_KEY,
          }),
        ),
      );
      expect(results.map((r) => r.versionNumber).sort((x, y) => x - y)).toEqual([2, 3, 4, 5, 6, 7]);
      expect(new Set(results.map((r) => r.versionId)).size).toBe(6);
    });

    it("answers NOT_FOUND for an unknown certificate and for another organization's certificate", async () => {
      const created = await importCert(orgA);
      const before = await countRows();
      const attempt = (organizationId: string, certificateId: string) =>
        insertTlsCertificateVersion(db(), { organizationId, certificateId, createdByUserId: null, version: nextVersion(), masterKey: MASTER_KEY });
      await expect(attempt(orgB, created.certificateId)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(attempt(orgA, "cti_00000000000000000000000000000000")).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await countRows()).toEqual(before);
    });

    it("replays the same key and hash, conflicts on another hash or another certificate", async () => {
      const created = await importCert(orgA);
      const other = await importCert(orgA);
      const base = { organizationId: orgA, createdByUserId: null, masterKey: MASTER_KEY, idempotencyKey: "idem-version" } as const;
      const first = await insertTlsCertificateVersion(db(), { ...base, certificateId: created.certificateId, version: nextVersion(), requestHash: HASH_A });
      const before = await countRows();

      const replay = await insertTlsCertificateVersion(db(), { ...base, certificateId: created.certificateId, version: nextVersion(), requestHash: HASH_A });
      expect(replay).toEqual({ versionId: first.versionId, versionNumber: first.versionNumber, replayed: true });
      await expect(
        insertTlsCertificateVersion(db(), { ...base, certificateId: created.certificateId, version: nextVersion(), requestHash: HASH_B }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      await expect(
        insertTlsCertificateVersion(db(), { ...base, certificateId: other.certificateId, version: nextVersion(), requestHash: HASH_A }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(await countRows()).toEqual(before);
    });

    it("refuses a fingerprint already held by any certificate of the organization (ALREADY_EXISTS)", async () => {
      const held = nextVersion();
      const first = await importCert(orgA, { version: held });
      const target = await importCert(orgA);
      const before = await countRows();
      const error = await insertTlsCertificateVersion(db(), {
        organizationId: orgA,
        certificateId: target.certificateId,
        createdByUserId: null,
        version: { ...nextVersion(), fingerprintSha256: held.fingerprintSha256 },
        masterKey: MASTER_KEY,
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: "ALREADY_EXISTS",
        existing: { certificateId: first.certificateId, versionId: first.versionId },
      });
      expect(await countRows()).toEqual(before);
    });
  });

  describe("reads", () => {
    it("get and list never select key, ciphertext, PEM or idempotency columns", async () => {
      const created = await importCert(orgA, { key: "idem-read", hash: HASH_A });
      await insertTlsCertificateVersion(db(), {
        organizationId: orgA,
        certificateId: created.certificateId,
        createdByUserId: null,
        version: nextVersion(),
        masterKey: MASTER_KEY,
      });
      const cert = await getTlsCertificate(db(), orgA, created.certificateId);
      expect(cert?.versions.map((v) => v.versionNumber)).toEqual([1, 2]);
      expect(cert?.versions[0]).toMatchObject({
        id: created.versionId,
        certificateId: created.certificateId,
        organizationId: orgA,
        status: "pending",
        keyType: "ec",
        keyBits: 256,
        publishGeneration: 0,
        lastErrorCode: null,
      });

      const listed = (await listTlsCertificatesForOrganization(db(), orgA)).find((c) => c.id === created.certificateId);
      expect(listed?.versions.map((v) => v.versionNumber)).toEqual([1, 2]);

      for (const value of [cert, listed]) {
        const flat = JSON.stringify(value);
        for (const forbidden of ["KEYMATERIAL", "BEGIN", "LEAF", "keyCiphertext", "keyIv", "keyAuthTag", "idempotencyKey", "requestHash", "leafPem", "chainPem"]) {
          expect(flat).not.toContain(forbidden);
        }
        for (const version of value?.versions ?? []) {
          expect(Object.keys(version).sort()).toEqual(VERSION_RECORD_KEYS);
        }
      }
    });

    it("is scoped to the organization", async () => {
      const mine = await importCert(orgA);
      expect(await getTlsCertificate(db(), orgB, mine.certificateId)).toBeNull();
      expect(await getTlsCertificate(db(), orgA, "cti_00000000000000000000000000000000")).toBeNull();
      const ofB = await importCert(orgB);
      const listedA = (await listTlsCertificatesForOrganization(db(), orgA)).map((c) => c.id);
      const listedB = (await listTlsCertificatesForOrganization(db(), orgB)).map((c) => c.id);
      expect(listedA).toContain(mine.certificateId);
      expect(listedA).not.toContain(ofB.certificateId);
      expect(listedB).toContain(ofB.certificateId);
      expect(listedB).not.toContain(mine.certificateId);
      expect(await listTlsCertificatesForOrganization(db(), "org_without_certificates")).toEqual([]);
    });

    it("readTlsVersionKey returns the full chain and the decrypted key with the row's own ids", async () => {
      const version = newVersion(7001);
      const created = await importCert(orgA, { version });
      const key = await readTlsVersionKey(db(), { versionId: created.versionId, masterKey: MASTER_KEY });
      expect(key).toEqual({
        organizationId: orgA,
        certificateId: created.certificateId,
        fullchainPem: `${version.leafPem}${version.chainPem}`,
        privateKeyPem: keyPem(7001),
      });
    });

    it("readTlsVersionKey builds the full chain from the leaf alone when there is no intermediate", async () => {
      const version = newVersion(7002, { chainPem: "" });
      const created = await importCert(orgA, { version });
      const key = await readTlsVersionKey(db(), { versionId: created.versionId, masterKey: MASTER_KEY });
      expect(key.fullchainPem).toBe(version.leafPem);
    });

    it("readTlsVersionKey fails for a missing version, a wrong master key and a row whose key was sealed for other ids", async () => {
      const created = await importCert(orgA);
      await expect(readTlsVersionKey(db(), { versionId: "ctv_00000000000000000000000000000000", masterKey: MASTER_KEY })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(readTlsVersionKey(db(), { versionId: created.versionId, masterKey: OTHER_KEY })).rejects.toThrow();

      // a row whose envelope names another version in its AAD must not open (swap/copy of ciphertext between rows)
      const [donor] = await db().select().from(tlsCertificateVersions).where(eq(tlsCertificateVersions.id, created.versionId));
      const stolen = nextVersion();
      const target = await importCert(orgA, { version: stolen });
      // the immutability trigger forbids UPDATE: insert a sibling version whose envelope is the donor's
      await db().execute(
        sql`INSERT INTO tls_certificate_versions (id, certificate_id, organization_id, version_number,
          leaf_pem, chain_pem, key_ciphertext_base64, key_iv_base64, key_auth_tag_base64, subject, issuer, serial_number,
          fingerprint_sha256, not_before, not_after, san_dns, key_type, key_bits)
          VALUES ('ctv_ffffffffffffffffffffffffffffffff', ${target.certificateId}, ${orgA}, 2, 'L', 'C',
            ${donor?.keyCiphertextBase64}, ${donor?.keyIvBase64}, ${donor?.keyAuthTagBase64}, 's', 'i', '01',
            ${"f".repeat(64)}, NOW(), NOW() + INTERVAL '1 day', '["x.example"]'::jsonb, 'ec', 256)`,
      );
      await expect(
        readTlsVersionKey(db(), { versionId: "ctv_ffffffffffffffffffffffffffffffff", masterKey: MASTER_KEY }),
      ).rejects.toThrow();
    });
  });

  describe("deleteTlsCertificate", () => {
    const assign = (domainId: string, hostname: string, siteId: string, organizationId: string, versionId: string) =>
      db().insert(domains).values({
        id: domainId,
        siteId,
        organizationId,
        hostname,
        certMode: "manual",
        manualCertificateVersionId: versionId,
      });

    it("refuses with CERTIFICATE_IN_USE while any version is assigned to a domain, and keeps everything", async () => {
      const created = await importCert(orgA);
      await insertTlsCertificateVersion(db(), {
        organizationId: orgA,
        certificateId: created.certificateId,
        createdByUserId: null,
        version: nextVersion(),
        masterKey: MASTER_KEY,
      });
      await assign("dom_tls_inuse", "in-use.example", siteA, orgA, created.versionId); // the OLD version is the used one
      const before = await countRows();

      await expect(db().transaction((tx) => deleteTlsCertificate(tx, { organizationId: orgA, certificateId: created.certificateId }))).rejects.toMatchObject({
        code: "CERTIFICATE_IN_USE",
      });
      expect(await countRows()).toEqual(before);

      // once the domain returns to automatic certificates the same certificate can go
      await db().update(domains).set({ certMode: "acme", manualCertificateVersionId: null }).where(eq(domains.id, "dom_tls_inuse"));
      await expect(db().transaction((tx) => deleteTlsCertificate(tx, { organizationId: orgA, certificateId: created.certificateId }))).resolves.toBeDefined();
    });

    it("answers CERTIFICATE_IN_USE without aborting the caller's transaction, after locking the version rows against a racing assignment", async () => {
      const created = await importCert(orgA);
      await assign("dom_tls_inuse_tx", "in-use-tx.example", siteA, orgA, created.versionId);

      await db().transaction(async (tx) => {
        await expect(deleteTlsCertificate(tx, { organizationId: orgA, certificateId: created.certificateId })).rejects.toMatchObject({
          code: "CERTIFICATE_IN_USE",
        });
        // the transaction is still usable (a denied audit can follow)
        await expect(tx.execute(sql`SELECT 1 AS ok`)).resolves.toBeDefined();
        // FOR UPDATE on the versions conflicts with the FOR KEY SHARE an assigning domain takes, so no assignment slips in
        const locked = await tx.execute(
          sql`SELECT (xmax::text = pg_current_xact_id()::xid::text) AS mine FROM tls_certificate_versions WHERE certificate_id = ${created.certificateId}`,
        );
        expect((locked.rows as Array<{ mine: boolean }>).map((r) => r.mine)).toEqual([true]);
      });
      await db().update(domains).set({ certMode: "acme", manualCertificateVersionId: null }).where(eq(domains.id, "dom_tls_inuse_tx"));
    });

    it("hard-deletes an unassigned certificate: no version row, so no key ciphertext, is left (T10)", async () => {
      const first = await importCert(orgA, { version: newVersion(8001) });
      const second = await insertTlsCertificateVersion(db(), {
        organizationId: orgA,
        certificateId: first.certificateId,
        createdByUserId: null,
        version: newVersion(8002),
        masterKey: MASTER_KEY,
      });
      // an active version points back at the certificate through fk_tls_certificates_active_version
      await db().update(tlsCertificateVersions).set({ status: "active", activatedAt: new Date() }).where(eq(tlsCertificateVersions.id, second.versionId));
      await db().update(tlsCertificates).set({ activeVersionId: second.versionId }).where(eq(tlsCertificates.id, first.certificateId));
      const unrelated = await importCert(orgA);

      const removed = await db().transaction((tx) => deleteTlsCertificate(tx, { organizationId: orgA, certificateId: first.certificateId }));
      expect(removed.versionIds).toEqual([first.versionId, second.versionId]);
      expect(removed.fingerprints).toEqual([newVersion(8001).fingerprintSha256, newVersion(8002).fingerprintSha256]);

      expect(await db().select().from(tlsCertificates).where(eq(tlsCertificates.id, first.certificateId))).toEqual([]);
      expect(await db().select().from(tlsCertificateVersions).where(eq(tlsCertificateVersions.certificateId, first.certificateId))).toEqual([]);
      expect(await getTlsCertificate(db(), orgA, first.certificateId)).toBeNull();
      await expect(readTlsVersionKey(db(), { versionId: first.versionId, masterKey: MASTER_KEY })).rejects.toMatchObject({ code: "NOT_FOUND" });
      // the other certificate and the freed fingerprint are untouched / reusable
      expect(await getTlsCertificate(db(), orgA, unrelated.certificateId)).not.toBeNull();
      await expect(importCert(orgA, { version: newVersion(8001) })).resolves.toMatchObject({ replayed: false });
    });

    it("answers NOT_FOUND for another organization, an unknown id, and does not delete across tenants", async () => {
      const created = await importCert(orgA);
      await expect(db().transaction((tx) => deleteTlsCertificate(tx, { organizationId: orgB, certificateId: created.certificateId }))).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        db().transaction((tx) => deleteTlsCertificate(tx, { certificateId: "cti_00000000000000000000000000000000" })),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await getTlsCertificate(db(), orgA, created.certificateId)).not.toBeNull();
      // without an organization (admin/cleanup path) the certificate is found by id
      await expect(db().transaction((tx) => deleteTlsCertificate(tx, { certificateId: created.certificateId }))).resolves.toMatchObject({
        versionIds: [created.versionId],
      });
    });

    it("a domain of another organization can never hold the version (composite FK), so it cannot block a delete", async () => {
      const ofB = await importCert(orgB);
      await expect(assign("dom_tls_cross", "cross.example", siteA, orgA, ofB.versionId)).rejects.toThrow();
      await assign("dom_tls_own_b", "own-b.example", siteB, orgB, ofB.versionId);
      await expect(db().transaction((tx) => deleteTlsCertificate(tx, { organizationId: orgB, certificateId: ofB.certificateId }))).rejects.toMatchObject({
        code: "CERTIFICATE_IN_USE",
      });
    });
  });

  describe("manifest generation (tls_publish_state)", () => {
    it("is seeded at 0/0 by the migration and lockTlsPublishState reads it", async () => {
      const state = await db().transaction((tx) => lockTlsPublishState(tx));
      expect(state).toEqual({ desiredGeneration: 0, confirmedGeneration: 0 });
    });

    it("bumpTlsDesiredGeneration increments and returns the new desired generation", async () => {
      expect(await db().transaction((tx) => bumpTlsDesiredGeneration(tx))).toBe(1);
      expect(await db().transaction((tx) => bumpTlsDesiredGeneration(tx))).toBe(2);
      expect(await db().transaction((tx) => lockTlsPublishState(tx))).toEqual({ desiredGeneration: 2, confirmedGeneration: 0 });
    });

    it("serialises concurrent bumps: every caller gets its own generation and none is lost", async () => {
      const results = await Promise.all(Array.from({ length: 8 }, () => db().transaction((tx) => bumpTlsDesiredGeneration(tx))));
      expect([...results].sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
      const [row] = await db().select().from(tlsPublishState);
      expect(row).toMatchObject({ id: "default", desiredGeneration: 10, confirmedGeneration: 0 });
    });

    it("never moves the confirmed generation (only the executor confirmation does)", async () => {
      await db().update(tlsPublishState).set({ confirmedGeneration: 4 }).where(eq(tlsPublishState.id, "default"));
      expect(await db().transaction((tx) => bumpTlsDesiredGeneration(tx))).toBe(11);
      expect(await db().transaction((tx) => lockTlsPublishState(tx))).toEqual({ desiredGeneration: 11, confirmedGeneration: 4 });
    });
  });
});
