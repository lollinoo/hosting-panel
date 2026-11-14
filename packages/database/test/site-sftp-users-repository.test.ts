import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseClient,
  createSiteTransactional,
  deleteSiteSftpUser,
  deleteSiteSftpUsersForSite,
  ensureWordpressTemplate,
  getSiteSftpUser,
  hostAllocations,
  hosts,
  insertSiteSftpUser,
  listSftpDesiredState,
  listSiteSftpUsers,
  organizations,
  platformInstallations,
  serviceInstances,
  updateSiteSftpUserPassword,
  WORDPRESS_TEMPLATE_ID,
  type DatabaseClient,
} from "../src/index.js";

const HASH_A =
  "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1";
const HASH_B =
  "$6$othersalt$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz2";

describe("@hosting-panel/database — 0008 site_sftp_users repository", () => {
  let client: DatabaseClient;
  const db = () => client.db;

  let site1Id: string;
  let site2Id: string;
  let siteNoSvcId: string;
  let siteOtherOrgId: string;

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await ensureWordpressTemplate(db());
    await db().insert(platformInstallations).values({ id: "pin_sftp", name: "P" });
    await db().insert(hosts).values({
      id: "hst_sftp",
      platformInstallationId: "pin_sftp",
      name: "h",
      hostname: "h-sftp.local",
      ipv4Address: "10.0.0.10",
      totalCpuMilli: 4000,
      totalMemoryBytes: "4000000000",
      totalStorageBytes: "100000000000",
    });

    for (const org of ["org_sftp_1", "org_sftp_2"]) {
      await db().insert(organizations).values({
        id: org,
        platformInstallationId: "pin_sftp",
        name: org,
        slug: org,
      });
      await db().insert(hostAllocations).values({
        id: `al_${org}`,
        hostId: "hst_sftp",
        organizationId: org,
      });
    }

    ({
      site: { id: site1Id },
    } = await createSiteTransactional(db(), {
      organizationId: "org_sftp_1",
      hostAllocationId: "al_org_sftp_1",
      name: "Site 1",
      slug: "site-1",
      phpVersion: "8.4",
    }));
    ({
      site: { id: site2Id },
    } = await createSiteTransactional(db(), {
      organizationId: "org_sftp_1",
      hostAllocationId: "al_org_sftp_1",
      name: "Site 2",
      slug: "site-2",
      phpVersion: "8.4",
    }));
    ({
      site: { id: siteNoSvcId },
    } = await createSiteTransactional(db(), {
      organizationId: "org_sftp_1",
      hostAllocationId: "al_org_sftp_1",
      name: "Site No Service",
      slug: "site-no-svc",
      phpVersion: "8.4",
    }));
    ({
      site: { id: siteOtherOrgId },
    } = await createSiteTransactional(db(), {
      organizationId: "org_sftp_2",
      hostAllocationId: "al_org_sftp_2",
      name: "Site Other Org",
      slug: "site-other-org",
      phpVersion: "8.4",
    }));

    const tEarly = new Date("2026-11-01T10:00:00.000Z");
    const tLate = new Date("2026-11-02T10:00:00.000Z");

    // Site 1 has two services: svc_1_early must be chosen (earliest createdAt), even though svc_1_late sorts alphabetically before svc_1_early? Let's test id tie-breaker on Site 2 and timestamp on Site 1!
    await db().insert(serviceInstances).values([
      {
        id: "svc_1_b_late",
        siteId: site1Id,
        organizationId: "org_sftp_1",
        serviceTemplateId: WORDPRESS_TEMPLATE_ID,
        name: "wp-late",
        createdAt: tLate,
      },
      {
        id: "svc_1_z_early",
        siteId: site1Id,
        organizationId: "org_sftp_1",
        serviceTemplateId: WORDPRESS_TEMPLATE_ID,
        name: "wp-early",
        createdAt: tEarly,
      },
      {
        id: "svc_2_b",
        siteId: site2Id,
        organizationId: "org_sftp_1",
        serviceTemplateId: WORDPRESS_TEMPLATE_ID,
        name: "wp-2b",
        createdAt: tEarly,
      },
      {
        id: "svc_2_a",
        siteId: site2Id,
        organizationId: "org_sftp_1",
        serviceTemplateId: WORDPRESS_TEMPLATE_ID,
        name: "wp-2a",
        createdAt: tEarly,
      },
      {
        id: "svc_other_org",
        siteId: siteOtherOrgId,
        organizationId: "org_sftp_2",
        serviceTemplateId: WORDPRESS_TEMPLATE_ID,
        name: "wp-other",
        createdAt: tEarly,
      },
    ]);
  });

  afterAll(async () => {
    await client.close();
  });

  it("inserts, lists without passwordHash, gets with passwordHash, and updates password", async () => {
    const t0 = new Date("2026-11-10T12:00:00.000Z");
    const insertedB = await insertSiteSftpUser(db(), {
      id: "sftp_u_b",
      organizationId: "org_sftp_1",
      siteId: site1Id,
      username: "s11111111_zeta",
      passwordHash: HASH_A,
      createdAt: t0,
      passwordChangedAt: t0,
    });
    const insertedA = await insertSiteSftpUser(db(), {
      id: "sftp_u_a",
      organizationId: "org_sftp_1",
      siteId: site1Id,
      username: "s11111111_alpha",
      passwordHash: HASH_A,
      createdAt: t0,
      passwordChangedAt: t0,
    });

    expect(insertedA).toEqual({
      id: "sftp_u_a",
      organizationId: "org_sftp_1",
      siteId: site1Id,
      username: "s11111111_alpha",
      createdAt: t0,
      passwordChangedAt: t0,
    });
    expect("passwordHash" in insertedA).toBe(false);
    expect("passwordHash" in insertedB).toBe(false);

    const listed = await listSiteSftpUsers(db(), {
      organizationId: "org_sftp_1",
      siteId: site1Id,
    });
    expect(listed.map((r) => r.username)).toEqual(["s11111111_alpha", "s11111111_zeta"]);
    for (const row of listed) {
      expect("passwordHash" in row).toBe(false);
      expect(Object.keys(row)).not.toContain("passwordHash");
    }

    // Wrong organization returns empty list
    expect(
      await listSiteSftpUsers(db(), { organizationId: "org_sftp_2", siteId: site1Id }),
    ).toEqual([]);

    const secret = await getSiteSftpUser(db(), {
      organizationId: "org_sftp_1",
      siteId: site1Id,
      userId: "sftp_u_a",
    });
    expect(secret).toEqual({
      ...insertedA,
      passwordHash: HASH_A,
    });

    // Cross-site / cross-org get returns null
    expect(
      await getSiteSftpUser(db(), {
        organizationId: "org_sftp_1",
        siteId: site2Id,
        userId: "sftp_u_a",
      }),
    ).toBeNull();
    expect(
      await getSiteSftpUser(db(), {
        organizationId: "org_sftp_2",
        siteId: site1Id,
        userId: "sftp_u_a",
      }),
    ).toBeNull();

    const t1 = new Date("2026-11-11T09:30:00.000Z");
    expect(
      await updateSiteSftpUserPassword(db(), {
        organizationId: "org_sftp_1",
        siteId: site1Id,
        userId: "sftp_u_a",
        passwordHash: HASH_B,
        passwordChangedAt: t1,
      }),
    ).toBe(true);
    expect(
      await updateSiteSftpUserPassword(db(), {
        organizationId: "org_sftp_1",
        siteId: site2Id,
        userId: "sftp_u_a",
        passwordHash: HASH_B,
        passwordChangedAt: t1,
      }),
    ).toBe(false);

    const updatedSecret = await getSiteSftpUser(db(), {
      organizationId: "org_sftp_1",
      siteId: site1Id,
      userId: "sftp_u_a",
    });
    expect(updatedSecret?.passwordHash).toBe(HASH_B);
    expect(updatedSecret?.passwordChangedAt).toEqual(t1);
  });

  it("computes desired state joined to each site's first service instance and supports excludeSiteId", async () => {
    await insertSiteSftpUser(db(), {
      id: "sftp_u_s2",
      organizationId: "org_sftp_1",
      siteId: site2Id,
      username: "s22222222_dev",
      passwordHash: HASH_A,
    });
    await insertSiteSftpUser(db(), {
      id: "sftp_u_nosvc",
      organizationId: "org_sftp_1",
      siteId: siteNoSvcId,
      username: "s33333333_nosvc",
      passwordHash: HASH_A,
    });
    await insertSiteSftpUser(db(), {
      id: "sftp_u_other",
      organizationId: "org_sftp_2",
      siteId: siteOtherOrgId,
      username: "s44444444_other",
      passwordHash: HASH_B,
    });

    const all = await listSftpDesiredState(db());
    expect(all).toEqual([
      {
        username: "s11111111_alpha",
        passwordHash: HASH_B,
        siteId: site1Id,
        serviceInstanceId: "svc_1_z_early",
      },
      {
        username: "s11111111_zeta",
        passwordHash: HASH_A,
        siteId: site1Id,
        serviceInstanceId: "svc_1_z_early",
      },
      {
        username: "s22222222_dev",
        passwordHash: HASH_A,
        siteId: site2Id,
        serviceInstanceId: "svc_2_a",
      },
      {
        username: "s44444444_other",
        passwordHash: HASH_B,
        siteId: siteOtherOrgId,
        serviceInstanceId: "svc_other_org",
      },
    ]);

    const excluded = await listSftpDesiredState(db(), { excludeSiteId: site1Id });
    expect(excluded).toEqual([
      {
        username: "s22222222_dev",
        passwordHash: HASH_A,
        siteId: site2Id,
        serviceInstanceId: "svc_2_a",
      },
      {
        username: "s44444444_other",
        passwordHash: HASH_B,
        siteId: siteOtherOrgId,
        serviceInstanceId: "svc_other_org",
      },
    ]);
  });

  it("deletes single users and all users for a site", async () => {
    expect(
      await deleteSiteSftpUser(db(), {
        organizationId: "org_sftp_1",
        siteId: site2Id,
        userId: "sftp_u_a",
      }),
    ).toBe(false);
    expect(
      await deleteSiteSftpUser(db(), {
        organizationId: "org_sftp_1",
        siteId: site1Id,
        userId: "sftp_u_a",
      }),
    ).toBe(true);
    expect(
      await deleteSiteSftpUser(db(), {
        organizationId: "org_sftp_1",
        siteId: site1Id,
        userId: "sftp_u_a",
      }),
    ).toBe(false);

    expect(
      await deleteSiteSftpUsersForSite(db(), {
        organizationId: "org_sftp_1",
        siteId: site1Id,
      }),
    ).toBe(1);
    expect(
      await listSiteSftpUsers(db(), {
        organizationId: "org_sftp_1",
        siteId: site1Id,
      }),
    ).toEqual([]);
    // Site 2 and other org users remain
    expect(
      await listSiteSftpUsers(db(), {
        organizationId: "org_sftp_1",
        siteId: site2Id,
      }),
    ).toHaveLength(1);
  });
});
