import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseClient,
  createSiteTransactional,
  ensureWordpressTemplate,
  generateSecretsMasterKeyHex,
  getSiteSftpUser,
  hostAllocations,
  hosts,
  insertSiteSftpUser,
  listSftpDesiredState,
  listSiteSftpUsers,
  moveSiteToOrganizationTransactional,
  organizations,
  platformInstallations,
  resolveMigrationsDirectory,
  schemaMigrations,
  serviceInstances,
  sites,
  sql,
  eq,
  WORDPRESS_TEMPLATE_ID,
  type DatabaseClient,
} from "../src/index.js";

const HASH_1 =
  "$6$saltone123456789$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1";
const HASH_2 =
  "$6$salttwo123456789$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz2";
const MASTER_KEY = generateSecretsMasterKeyHex();

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const rec = err as { code?: unknown; cause?: unknown };
  if (typeof rec.code === "string") return rec.code;
  if (typeof rec.cause === "object" && rec.cause !== null) {
    const causeCode = (rec.cause as { code?: unknown }).code;
    if (typeof causeCode === "string") return causeCode;
  }
  return undefined;
}

describe("@hosting-panel/database — 0008 site_sftp_users migration & constraints", () => {
  let tmpDir: string;
  let client: DatabaseClient;
  const db = () => client.db;

  let siteAId: string;
  let siteBId: string;
  let siteMoveId: string;
  let siteNoSvcId: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "hp-sftp-db-test-"));
    const migrationsDir = resolveMigrationsDirectory();
    const pre0008Files = [
      "0001_phase1_docker_native.sql",
      "0002_phase2_runtime_and_secrets.sql",
      "0003_production_accounts.sql",
      "0004_sites_and_databases.sql",
      "0005_allow_revision_cascade_delete.sql",
      "0006_domains_dns_tls.sql",
      "0007_mail_relay.sql",
    ];

    // Migrate an isolated database only up to 0007 first.
    const pg = new PGlite(tmpDir);
    await pg.waitReady;
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    for (const filename of pre0008Files) {
      const migrationSql = await readFile(path.join(migrationsDir, filename), "utf8");
      await pg.exec("BEGIN");
      await pg.exec(migrationSql);
      await pg.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
      await pg.exec("COMMIT");
    }
    const before0008 = await pg.query<{ reg: string | null }>(
      "SELECT to_regclass('public.site_sftp_users') AS reg",
    );
    expect(before0008.rows[0]?.reg).toBeNull();
    await pg.close();

    // Now open via createDatabaseClient and apply 0008 on top of 0007.
    client = createDatabaseClient({ mode: "pglite", dataDir: tmpDir });
    const applied = await client.migrate();
    expect(applied).toContain("0008_site_sftp_users.sql");

    const recorded = await db().select().from(schemaMigrations);
    expect(recorded.map((r) => r.filename)).toEqual([
      ...pre0008Files,
      "0008_site_sftp_users.sql",
      "0009_backups.sql",
      "0010_backup_restore.sql",
      "0011_panel_backup.sql",
      "0012_wordpress_tools.sql",
      "0013_wordpress_import.sql",
      "0014_password_reset_tokens.sql",
      "0015_operations_audit_indexes.sql",
      "0016_admin_terminal_sessions.sql",
      "0017_m5d_firewall.sql",
      "0018_site_type.sql",
      "0019_operation_step_indexes.sql",
      "0020_dns_challenge.sql",
      "0021_manual_tls_certificates.sql",
      "0022_backup_targets_and_copies.sql",
      "0023_organization_site_limit.sql",
      "0024_site_templates.sql",
      "0025_app_stacks.sql",
      "0026_app_routing_options.sql",
      "0027_app_stack_backups.sql",
      "0028_app_stack_links.sql",
      "0029_notifications.sql",
      "0030_app_terminal_sessions.sql",
      "0031_app_stack_tasks.sql",
      "0032_app_stack_deployment_replaced.sql",
      "0033_app_stack_domain_removal.sql",
    ]);

    const after0008 = await db().execute(
      sql`SELECT to_regclass('public.site_sftp_users') AS reg`,
    );
    expect((after0008.rows[0] as { reg: string | null }).reg).toBe("site_sftp_users");

    await ensureWordpressTemplate(db());
    await db().insert(platformInstallations).values({ id: "pin_sftp_qa", name: "QA" });
    await db().insert(hosts).values({
      id: "hst_sftp_qa",
      platformInstallationId: "pin_sftp_qa",
      name: "qa-host",
      hostname: "qa-host.local",
      ipv4Address: "10.0.0.50",
      totalCpuMilli: 4000,
      totalMemoryBytes: "4000000000",
      totalStorageBytes: "100000000000",
    });

    for (const orgId of ["org_qa_a", "org_qa_b"]) {
      await db().insert(organizations).values({
        id: orgId,
        platformInstallationId: "pin_sftp_qa",
        name: orgId,
        slug: orgId,
      });
      await db().insert(hostAllocations).values({
        id: `al_${orgId}`,
        hostId: "hst_sftp_qa",
        organizationId: orgId,
      });
    }

    ({
      site: { id: siteAId },
    } = await createSiteTransactional(db(), {
      organizationId: "org_qa_a",
      hostAllocationId: "al_org_qa_a",
      name: "Site A",
      slug: "site-a",
      phpVersion: "8.4",
      siteType: "wordpress",
    }));
    ({
      site: { id: siteBId },
    } = await createSiteTransactional(db(), {
      organizationId: "org_qa_b",
      hostAllocationId: "al_org_qa_b",
      name: "Site B",
      slug: "site-b",
      phpVersion: "8.4",
      siteType: "wordpress",
    }));
    ({
      site: { id: siteMoveId },
    } = await createSiteTransactional(db(), {
      organizationId: "org_qa_a",
      hostAllocationId: "al_org_qa_a",
      name: "Site Move",
      slug: "site-move",
      phpVersion: "8.4",
      siteType: "wordpress",
    }));
    ({
      site: { id: siteNoSvcId },
    } = await createSiteTransactional(db(), {
      organizationId: "org_qa_a",
      hostAllocationId: "al_org_qa_a",
      name: "Site No Service",
      slug: "site-no-svc",
      phpVersion: "8.4",
      siteType: "wordpress",
    }));

    const tEarly = new Date("2026-11-01T08:00:00.000Z");
    const tLate = new Date("2026-11-02T08:00:00.000Z");

    await db().insert(serviceInstances).values([
      {
        id: "svc_a_late",
        siteId: siteAId,
        organizationId: "org_qa_a",
        serviceTemplateId: WORDPRESS_TEMPLATE_ID,
        name: "wp-a-late",
        createdAt: tLate,
      },
      {
        id: "svc_a_early",
        siteId: siteAId,
        organizationId: "org_qa_a",
        serviceTemplateId: WORDPRESS_TEMPLATE_ID,
        name: "wp-a-early",
        createdAt: tEarly,
      },
      {
        id: "svc_b_1",
        siteId: siteBId,
        organizationId: "org_qa_b",
        serviceTemplateId: WORDPRESS_TEMPLATE_ID,
        name: "wp-b-1",
        createdAt: tEarly,
      },
      {
        id: "svc_move_1",
        siteId: siteMoveId,
        organizationId: "org_qa_a",
        serviceTemplateId: WORDPRESS_TEMPLATE_ID,
        name: "wp-move-1",
        createdAt: tEarly,
      },
    ]);
  });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("CHECK constraint refuses any password_hash that does not start with $6$", async () => {
    for (const badHash of [
      "$2b$10$abcdefghijklmnopqrstuv",
      "$5$saltstring$hash",
      "$6noTrailingDollar",
      "plaintext-password",
      "",
    ]) {
      let caught: unknown;
      try {
        await insertSiteSftpUser(db(), {
          id: "u_bad_hash",
          organizationId: "org_qa_a",
          siteId: siteAId,
          username: "s11111111_bad",
          passwordHash: badHash,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(pgErrorCode(caught)).toBe("23514");
    }
  });

  it("enforces UNIQUE username globally across sites and organizations", async () => {
    await insertSiteSftpUser(db(), {
      id: "u_uniq_a",
      organizationId: "org_qa_a",
      siteId: siteAId,
      username: "s00000001_shared",
      passwordHash: HASH_1,
    });

    let caught: unknown;
    try {
      await insertSiteSftpUser(db(), {
        id: "u_uniq_b",
        organizationId: "org_qa_b",
        siteId: siteBId,
        username: "s00000001_shared",
        passwordHash: HASH_2,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(pgErrorCode(caught)).toBe("23505");
  });

  it("list/insert functions meant for DTOs return no passwordHash key", async () => {
    const inserted = await insertSiteSftpUser(db(), {
      id: "u_dto_check",
      organizationId: "org_qa_a",
      siteId: siteAId,
      username: "s11111111_alpha",
      passwordHash: HASH_1,
    });
    expect("passwordHash" in inserted).toBe(false);
    expect(Object.keys(inserted)).not.toContain("passwordHash");

    const listed = await listSiteSftpUsers(db(), {
      organizationId: "org_qa_a",
      siteId: siteAId,
    });
    expect(listed.length).toBeGreaterThanOrEqual(2);
    for (const row of listed) {
      expect("passwordHash" in row).toBe(false);
      expect(Object.keys(row)).not.toContain("passwordHash");
    }
  });

  it("listSftpDesiredState supports excludeSiteId and maintains stable deterministic ordering", async () => {
    await insertSiteSftpUser(db(), {
      id: "u_b_1",
      organizationId: "org_qa_b",
      siteId: siteBId,
      username: "s22222222_mid",
      passwordHash: HASH_2,
    });
    await insertSiteSftpUser(db(), {
      id: "u_nosvc_1",
      organizationId: "org_qa_a",
      siteId: siteNoSvcId,
      username: "s33333333_nosvc",
      passwordHash: HASH_1,
    });
    await insertSiteSftpUser(db(), {
      id: "u_a_zeta",
      organizationId: "org_qa_a",
      siteId: siteAId,
      username: "s11111111_zeta",
      passwordHash: HASH_2,
    });

    const first = await listSftpDesiredState(db());
    const second = await listSftpDesiredState(db());

    expect(first).toEqual(second);
    // Site with no service instance is omitted; site A picks earliest service (svc_a_early).
    expect(first).toEqual([
      {
        username: "s00000001_shared",
        passwordHash: HASH_1,
        siteId: siteAId,
        serviceInstanceId: "svc_a_early",
      },
      {
        username: "s11111111_alpha",
        passwordHash: HASH_1,
        siteId: siteAId,
        serviceInstanceId: "svc_a_early",
      },
      {
        username: "s11111111_zeta",
        passwordHash: HASH_2,
        siteId: siteAId,
        serviceInstanceId: "svc_a_early",
      },
      {
        username: "s22222222_mid",
        passwordHash: HASH_2,
        siteId: siteBId,
        serviceInstanceId: "svc_b_1",
      },
    ]);

    const excludedA = await listSftpDesiredState(db(), { excludeSiteId: siteAId });
    expect(excludedA).toEqual([
      {
        username: "s22222222_mid",
        passwordHash: HASH_2,
        siteId: siteBId,
        serviceInstanceId: "svc_b_1",
      },
    ]);
  });

  it("excludes users of suspended or archived organizations from listSftpDesiredState and restores them on reactivation", async () => {
    const activeAll = await listSftpDesiredState(db());
    expect(activeAll.filter((u) => u.siteId === siteAId)).toHaveLength(3);
    expect(activeAll.filter((u) => u.siteId === siteBId)).toHaveLength(1);

    await db()
      .update(organizations)
      .set({ status: "suspended" })
      .where(eq(organizations.id, "org_qa_a"));

    const whileSuspended = await listSftpDesiredState(db());
    expect(whileSuspended).toEqual([
      {
        username: "s22222222_mid",
        passwordHash: HASH_2,
        siteId: siteBId,
        serviceInstanceId: "svc_b_1",
      },
    ]);
    // DB rows stay intact while suspended.
    expect(
      await listSiteSftpUsers(db(), { organizationId: "org_qa_a", siteId: siteAId }),
    ).toHaveLength(3);

    await db()
      .update(organizations)
      .set({ status: "archived" })
      .where(eq(organizations.id, "org_qa_a"));

    const whileArchived = await listSftpDesiredState(db());
    expect(whileArchived).toEqual([
      {
        username: "s22222222_mid",
        passwordHash: HASH_2,
        siteId: siteBId,
        serviceInstanceId: "svc_b_1",
      },
    ]);
    expect(
      await listSiteSftpUsers(db(), { organizationId: "org_qa_a", siteId: siteAId }),
    ).toHaveLength(3);

    await db()
      .update(organizations)
      .set({ status: "active" })
      .where(eq(organizations.id, "org_qa_a"));

    const afterReactivation = await listSftpDesiredState(db());
    expect(afterReactivation).toEqual(activeAll);
  });

  it("deletes site SFTP users on moveSiteToOrganizationTransactional leaving other sites untouched, and cascades delete when site is deleted", async () => {
    const t0 = new Date("2026-11-10T10:00:00.000Z");
    await insertSiteSftpUser(db(), {
      id: "u_move_1",
      organizationId: "org_qa_a",
      siteId: siteMoveId,
      username: "s44444444_mover",
      passwordHash: HASH_1,
      createdAt: t0,
      passwordChangedAt: t0,
    });

    await moveSiteToOrganizationTransactional(db(), {
      siteId: siteMoveId,
      fromOrganizationId: "org_qa_a",
      toOrganizationId: "org_qa_b",
      toHostAllocationId: "al_org_qa_b",
      masterKey: MASTER_KEY,
    });

    expect(
      await listSiteSftpUsers(db(), { organizationId: "org_qa_a", siteId: siteMoveId }),
    ).toEqual([]);
    expect(
      await listSiteSftpUsers(db(), { organizationId: "org_qa_b", siteId: siteMoveId }),
    ).toEqual([]);
    expect(
      await getSiteSftpUser(db(), {
        organizationId: "org_qa_b",
        siteId: siteMoveId,
        userId: "u_move_1",
      }),
    ).toBeNull();

    const desiredAfterMove = await listSftpDesiredState(db());
    expect(desiredAfterMove.find((u) => u.siteId === siteMoveId)).toBeUndefined();
    // Other sites' SFTP users remain untouched.
    expect(
      await listSiteSftpUsers(db(), { organizationId: "org_qa_a", siteId: siteAId }),
    ).toHaveLength(3);
    expect(
      await listSiteSftpUsers(db(), { organizationId: "org_qa_b", siteId: siteBId }),
    ).toHaveLength(1);

    // Deleting a site still cascades ON DELETE CASCADE to any SFTP user rows on that site.
    await insertSiteSftpUser(db(), {
      id: "u_cascade_1",
      organizationId: "org_qa_b",
      siteId: siteMoveId,
      username: "s44444444_after",
      passwordHash: HASH_2,
    });
    await db().delete(sites).where(eq(sites.id, siteMoveId));

    expect(
      await listSiteSftpUsers(db(), { organizationId: "org_qa_b", siteId: siteMoveId }),
    ).toEqual([]);
    expect(
      await getSiteSftpUser(db(), {
        organizationId: "org_qa_b",
        siteId: siteMoveId,
        userId: "u_cascade_1",
      }),
    ).toBeNull();
    expect(
      await listSiteSftpUsers(db(), { organizationId: "org_qa_b", siteId: siteBId }),
    ).toHaveLength(1);
  });
});
