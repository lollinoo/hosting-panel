import {
  SITE_DATABASES_MAX,
  SITE_DATABASE_USERS_MAX,
  siteDatabasePrefix,
} from "@hosting-panel/contracts";
import { describe, expect, it } from "vitest";
import {
  ExecutorCodedError,
  InMemoryDockerSimulatorAdapter,
  SimulatedSiteDatabases,
} from "../src/index.js";

const SITE_A = "site_sim_alpha";
const SITE_B = "site_sim_beta";
const P_A = siteDatabasePrefix(SITE_A);
const P_B = siteDatabasePrefix(SITE_B);
const HASH = "*2470C0C06DEE42FD1618BB99005ADCA2EC9D1E19";
const HASH_2 = "*00A51F3F48415C7D4E8908980D443C29C69B60C9";

describe("SimulatedSiteDatabases", () => {
  it("provision seeds the site's own database and user and drop removes only those two and their grants", async () => {
    const sim = new SimulatedSiteDatabases();
    expect(await sim.handle({ siteId: SITE_A, op: "list" })).toEqual({
      databases: [],
      users: [],
    });

    sim.provision(SITE_A);
    expect(await sim.handle({ siteId: SITE_A, op: "list" })).toEqual({
      databases: [{ name: P_A, primary: true, sizeBytes: 0 }],
      users: [{ name: P_A, primary: true, databases: [P_A] }],
    });

    // Provision is idempotent when called again and db.drop leaves extra databases/users intact until dropAll.
    await sim.handle({ siteId: SITE_A, op: "createDatabase", database: `${P_A}_shop` });
    await sim.handle({ siteId: SITE_A, op: "createUser", user: `${P_A}_app`, passwordHash: HASH });
    await sim.handle({ siteId: SITE_A, op: "grant", user: `${P_A}_app`, database: P_A });
    await sim.handle({ siteId: SITE_A, op: "grant", user: `${P_A}_app`, database: `${P_A}_shop` });
    sim.provision(SITE_A);
    expect(await sim.handle({ siteId: SITE_A, op: "list" })).toEqual({
      databases: [
        { name: P_A, primary: true, sizeBytes: 0 },
        { name: `${P_A}_shop`, primary: false, sizeBytes: 0 },
      ],
      users: [
        { name: P_A, primary: true, databases: [P_A] },
        { name: `${P_A}_app`, primary: false, databases: [P_A, `${P_A}_shop`] },
      ],
    });

    sim.drop(SITE_A);
    expect(await sim.handle({ siteId: SITE_A, op: "list" })).toEqual({
      databases: [{ name: `${P_A}_shop`, primary: false, sizeBytes: 0 }],
      users: [{ name: `${P_A}_app`, primary: false, databases: [`${P_A}_shop`] }],
    });

    await sim.handle({ siteId: SITE_A, op: "dropAll" });
    expect(await sim.handle({ siteId: SITE_A, op: "list" })).toEqual({
      databases: [],
      users: [],
    });
  });

  it("matches the runner across the full database, user, grant, and revoke lifecycle", async () => {
    const sim = new SimulatedSiteDatabases();
    sim.provision(SITE_A);

    await expect(
      sim.handle({ siteId: SITE_A, op: "createDatabase", database: `${P_A}_shop` }),
    ).resolves.toEqual({});
    await expect(
      sim.handle({ siteId: SITE_A, op: "createUser", user: `${P_A}_app`, passwordHash: HASH }),
    ).resolves.toEqual({});
    await expect(
      sim.handle({ siteId: SITE_A, op: "grant", user: `${P_A}_app`, database: `${P_A}_shop` }),
    ).resolves.toEqual({});
    await expect(
      sim.handle({ siteId: SITE_A, op: "grant", user: `${P_A}_app`, database: P_A }),
    ).resolves.toEqual({});
    // Idempotent grant
    await expect(
      sim.handle({ siteId: SITE_A, op: "grant", user: `${P_A}_app`, database: `${P_A}_shop` }),
    ).resolves.toEqual({});

    expect(await sim.handle({ siteId: SITE_A, op: "list" })).toEqual({
      databases: [
        { name: P_A, primary: true, sizeBytes: 0 },
        { name: `${P_A}_shop`, primary: false, sizeBytes: 0 },
      ],
      users: [
        { name: P_A, primary: true, databases: [P_A] },
        { name: `${P_A}_app`, primary: false, databases: [P_A, `${P_A}_shop`] },
      ],
    });

    await expect(
      sim.handle({
        siteId: SITE_A,
        op: "setUserPassword",
        user: `${P_A}_app`,
        passwordHash: HASH_2,
      }),
    ).resolves.toEqual({});

    // Delete and recreate database clears prior grants
    await expect(
      sim.handle({ siteId: SITE_A, op: "deleteDatabase", database: `${P_A}_shop` }),
    ).resolves.toEqual({});
    await expect(
      sim.handle({ siteId: SITE_A, op: "createDatabase", database: `${P_A}_shop` }),
    ).resolves.toEqual({});
    expect(await sim.handle({ siteId: SITE_A, op: "list" })).toEqual({
      databases: [
        { name: P_A, primary: true, sizeBytes: 0 },
        { name: `${P_A}_shop`, primary: false, sizeBytes: 0 },
      ],
      users: [
        { name: P_A, primary: true, databases: [P_A] },
        { name: `${P_A}_app`, primary: false, databases: [P_A] },
      ],
    });

    // Revoking existing grant then revoking missing grant (no-op {})
    await expect(
      sim.handle({ siteId: SITE_A, op: "revoke", user: `${P_A}_app`, database: P_A }),
    ).resolves.toEqual({});
    await expect(
      sim.handle({ siteId: SITE_A, op: "revoke", user: `${P_A}_app`, database: P_A }),
    ).resolves.toEqual({});

    await expect(
      sim.handle({ siteId: SITE_A, op: "deleteUser", user: `${P_A}_app` }),
    ).resolves.toEqual({});
    expect(await sim.handle({ siteId: SITE_A, op: "list" })).toEqual({
      databases: [
        { name: P_A, primary: true, sizeBytes: 0 },
        { name: `${P_A}_shop`, primary: false, sizeBytes: 0 },
      ],
      users: [{ name: P_A, primary: true, databases: [P_A] }],
    });
  });

  it("refuses everything the runner refuses (validation, cross-site, already exists, quota 10/10, not found)", async () => {
    const sim = new SimulatedSiteDatabases();
    sim.provision(SITE_A);

    await expect(
      sim.handle({ siteId: SITE_A, op: "createDatabase", database: P_A }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      sim.handle({ siteId: SITE_A, op: "createUser", user: `${P_A}_u`, passwordHash: "bad" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      sim.handle({ siteId: SITE_A, op: "createDatabase", database: `${P_B}_shop` }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      sim.handle({ siteId: SITE_A, op: "deleteDatabase", database: `${P_A}_missing` }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      sim.handle({ siteId: SITE_A, op: "grant", user: `${P_A}_missing`, database: P_A }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    for (let i = 0; i < SITE_DATABASES_MAX; i += 1) {
      await sim.handle({ siteId: SITE_A, op: "createDatabase", database: `${P_A}_d${String(i)}` });
    }
    await expect(
      sim.handle({ siteId: SITE_A, op: "createDatabase", database: `${P_A}_d0` }),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    await expect(
      sim.handle({ siteId: SITE_A, op: "createDatabase", database: `${P_A}_d10` }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });

    for (let i = 0; i < SITE_DATABASE_USERS_MAX; i += 1) {
      await sim.handle({
        siteId: SITE_A,
        op: "createUser",
        user: `${P_A}_u${String(i)}`,
        passwordHash: HASH,
      });
    }
    await expect(
      sim.handle({
        siteId: SITE_A,
        op: "createUser",
        user: `${P_A}_u0`,
        passwordHash: HASH,
      }),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    await expect(
      sim.handle({
        siteId: SITE_A,
        op: "createUser",
        user: `${P_A}_u10`,
        passwordHash: HASH,
      }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("supports failNext, answers NOT_SUPPORTED for phpMyAdminSignOn, and dropAll is idempotent even for unknown sites", async () => {
    const sim = new SimulatedSiteDatabases();

    await expect(
      sim.handle({ siteId: SITE_A, op: "phpMyAdminSignOn", passwordHash: HASH }),
    ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });

    sim.failNext("RESOURCE_LOCKED");
    const err = await sim.handle({ siteId: SITE_A, op: "list" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecutorCodedError);
    expect((err as ExecutorCodedError).code).toBe("RESOURCE_LOCKED");

    // Next call succeeds once failNext was consumed.
    await expect(sim.handle({ siteId: SITE_A, op: "list" })).resolves.toEqual({
      databases: [],
      users: [],
    });

    // dropAll succeeds on unknown site and is idempotent on populated site without touching other sites.
    await expect(sim.handle({ siteId: "site_unknown", op: "dropAll" })).resolves.toEqual({});

    sim.provision(SITE_A);
    sim.provision(SITE_B);
    await sim.handle({ siteId: SITE_A, op: "createDatabase", database: `${P_A}_extra` });
    await expect(sim.handle({ siteId: SITE_A, op: "dropAll" })).resolves.toEqual({});
    await expect(sim.handle({ siteId: SITE_A, op: "dropAll" })).resolves.toEqual({});
    expect(await sim.handle({ siteId: SITE_A, op: "list" })).toEqual({
      databases: [],
      users: [],
    });
    expect(await sim.handle({ siteId: SITE_B, op: "list" })).toEqual({
      databases: [{ name: P_B, primary: true, sizeBytes: 0 }],
      users: [{ name: P_B, primary: true, databases: [P_B] }],
    });
  });

  it("integrates with InMemoryDockerSimulatorAdapter db.provision and db.drop jobs", async () => {
    const adapter = new InMemoryDockerSimulatorAdapter();
    await adapter.runSiteJob({
      jobId: "job_prov_1",
      kind: "db.provision",
      siteId: SITE_A,
      organizationId: "org_a",
      params: { dbName: P_A, dbUser: P_A },
      resolvedSecrets: { HP_DB_PASSWORD: "a".repeat(64) },
    });
    await adapter.siteDatabases({ siteId: SITE_A, op: "createDatabase", database: `${P_A}_shop` });
    await adapter.siteDatabases({
      siteId: SITE_A,
      op: "createUser",
      user: `${P_A}_app`,
      passwordHash: HASH,
    });
    expect(await adapter.siteDatabases({ siteId: SITE_A, op: "list" })).toEqual({
      databases: [
        { name: P_A, primary: true, sizeBytes: 0 },
        { name: `${P_A}_shop`, primary: false, sizeBytes: 0 },
      ],
      users: [
        { name: P_A, primary: true, databases: [P_A] },
        { name: `${P_A}_app`, primary: false, databases: [] },
      ],
    });

    await adapter.runSiteJob({
      jobId: "job_drop_1",
      kind: "db.drop",
      siteId: SITE_A,
      organizationId: "org_a",
      params: { dbName: P_A, dbUser: P_A },
    });
    expect(await adapter.siteDatabases({ siteId: SITE_A, op: "list" })).toEqual({
      databases: [{ name: `${P_A}_shop`, primary: false, sizeBytes: 0 }],
      users: [{ name: `${P_A}_app`, primary: false, databases: [] }],
    });

    await adapter.siteDatabases({ siteId: SITE_A, op: "dropAll" });
    expect(await adapter.siteDatabases({ siteId: SITE_A, op: "list" })).toEqual({
      databases: [],
      users: [],
    });
  });
});
