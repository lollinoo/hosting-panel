import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findForbiddenPublicDtoKeys } from "@hosting-panel/contracts";
import {
  archiveBackupTarget,
  auditEvents,
  backupSettings,
  createDatabaseClient,
  createSiteTransactional,
  eq,
  getBackupTargetRow,
  getPolicy,
  hostAllocations,
  hosts,
  insertLocalTarget,
  insertS3Target,
  organizations,
  platformInstallations,
  updateBackupTarget,
  upsertBackupSettings,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { AuthzContextService } from "../src/auth/authz-context.service.js";
import { AdminBackupPoliciesController } from "../src/controllers/admin-backup-policies.controller.js";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import { BackupPoliciesService, MAX_COPIES } from "../src/backups/backup-policies.service.js";
import type { SiteBackupActor } from "../src/backups/site-backups.service.js";

const KEY = Buffer.alloc(32, 7);
const ADMIN_ID = "usr_policy_admin";
const OWNER_ID = "usr_policy_owner";
const CANARY = "canary-policy-s3-secret-DO-NOT-LEAK";

const req = { ip: "203.0.113.9", headers: { "user-agent": "policy-test" } } as unknown as FastifyRequest;
const actorOf = (userId: string): SiteBackupActor =>
  ({ auth: { user: { id: userId } }, req }) as unknown as SiteBackupActor;

/** The API exception filter maps a ZodError to VALIDATION_ERROR (as for every other body schema). */
const rejection = async (promise: Promise<unknown>): Promise<{ code: string; message: string }> => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ZodError) {
      return { code: "VALIDATION_ERROR", message: "schema" };
    }
    expect(err).toBeInstanceOf(ControlPlaneError);
    return err as ControlPlaneError;
  }
  throw new Error("expected a rejection");
};

describe("backup policies service and admin routes", () => {
  let client: DatabaseClient;
  let service: BackupPoliciesService;
  let siteA: { id: string; organizationId: string };
  let siteB: { id: string; organizationId: string };
  let s3Selectable: string;
  let s3Private: string;
  let local: string;

  const db = () => client.db;
  const audits = async (action: string) =>
    (await db().select().from(auditEvents)).filter((row) => row.action === action);

  async function makeSite(org: string, slug: string): Promise<{ id: string; organizationId: string }> {
    await db().insert(organizations).values({ id: `org_${org}`, platformInstallationId: "pin_pol", name: org, slug: org });
    await db().insert(hostAllocations).values({ id: `alloc_${org}`, hostId: "hst_pol", organizationId: `org_${org}`, status: "active" });
    const created = await createSiteTransactional(db(), {
      organizationId: `org_${org}`,
      hostAllocationId: `alloc_${org}`,
      name: `Site ${org}`,
      slug,
      phpVersion: "8.4",
      siteType: "wordpress",
    });
    return { id: created.site.id, organizationId: `org_${org}` };
  }

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    service = new BackupPoliciesService(client);
    await db().insert(platformInstallations).values({ id: "pin_pol", name: "Platform" });
    await db().insert(hosts).values({
      id: "hst_pol",
      platformInstallationId: "pin_pol",
      name: "pol-host",
      hostname: "pol-host.local",
      ipv4Address: "10.0.0.41",
      totalCpuMilli: 4000,
      totalMemoryBytes: "4000000000",
      totalStorageBytes: "100000000000",
    });
    for (const [id, email] of [
      [ADMIN_ID, "admin-policy@x.it"],
      [OWNER_ID, "owner-policy@x.it"],
    ] as const) {
      await db().insert(users).values({ id, email, name: id, passwordHash: "x" });
    }
    siteA = await makeSite("pola", "pol-a");
    siteB = await makeSite("polb", "pol-b");

    const s3 = {
      endpoint: "https://s3.policy.example",
      region: "eu-west-1",
      bucket: "policy-secret-bucket",
      prefix: "",
      accessKeyId: "AKIAPOLICY",
      secretAccessKey: CANARY,
      actorId: ADMIN_ID,
    };
    s3Selectable = (await insertS3Target(db(), KEY, { ...s3, name: "Policy Offsite Name", customerSelectable: true })).id;
    s3Private = (
      await insertS3Target(db(), KEY, { ...s3, name: "Private", bucket: "private-bucket", customerSelectable: false })
    ).id;
    local = (await insertLocalTarget(db(), { name: "Policy Local", customerSelectable: true, actorId: ADMIN_ID })).id;
  });

  afterAll(async () => {
    await client.close();
  });

  describe("administrator policies", () => {
    it("reads the seeded default and panel policies (the panel has no hour)", async () => {
      expect(await service.get("default_site")).toMatchObject({
        scope: "default_site",
        siteId: null,
        scheduleHourUtc: 2,
        retentionDays: 14,
        targets: [],
      });
      expect(await service.get("panel")).toMatchObject({ scope: "panel", scheduleHourUtc: null, targets: [] });
    });

    it("allows up to two copies per policy (SPEC 6.1 'fino a 2 copie')", () => {
      expect(MAX_COPIES).toBe(2);
    });

    it("updates hour, retention and destination, in priority order, and audits it without secrets", async () => {
      const dto = await service.update(
        "default_site",
        { scheduleHourUtc: 4, retentionDays: 30, targetIds: [s3Selectable] },
        ADMIN_ID,
      );
      expect(dto).toMatchObject({
        scheduleHourUtc: 4,
        retentionDays: 30,
        targets: [{ targetId: s3Selectable, kind: "s3", priority: 1, required: true }],
      });
      expect(await service.get("default_site")).toEqual(dto);

      const [row] = await audits("admin.backup_policy.update");
      expect(row).toMatchObject({ actorId: ADMIN_ID, targetType: "backup_policy" });
      expect(row!.details).toMatchObject({ scope: "default_site", scheduleHourUtc: 4, retentionDays: 30 });
      expect(JSON.stringify(row)).not.toContain(CANARY);
    });

    it("mirrors the default schedule into backup_settings while that row exists, and not the panel's", async () => {
      await upsertBackupSettings(db(), KEY, {
        endpoint: "https://s3.legacy.example",
        region: "eu-west-1",
        bucket: "legacy",
        prefix: "",
        accessKeyId: "AKIALEGACY",
        secretAccessKey: "legacy-secret",
        scheduleHourUtc: 1,
        retentionDays: 7,
        updatedByUserId: null,
      });
      await service.update("default_site", { scheduleHourUtc: 5, retentionDays: 21 }, ADMIN_ID);
      const [mirror] = await db().select().from(backupSettings);
      expect(mirror).toMatchObject({ scheduleHourUtc: 5, retentionDays: 21 });

      await service.update("panel", { retentionDays: 9 }, ADMIN_ID);
      const [after] = await db().select().from(backupSettings);
      expect(after).toMatchObject({ scheduleHourUtc: 5, retentionDays: 21 });
      expect((await service.get("panel")).retentionDays).toBe(9);
    });

    it("refuses an hour on the panel policy and leaves it unchanged", async () => {
      const err = await rejection(service.update("panel", { scheduleHourUtc: 3 }, ADMIN_ID));
      expect(err.code).toBe("VALIDATION_ERROR");
      expect((await service.get("panel")).scheduleHourUtc).toBeNull();
    });

    it("sets the panel destination and can clear a destination with an empty list", async () => {
      expect((await service.update("panel", { targetIds: [local] }, ADMIN_ID)).targets).toMatchObject([
        { targetId: local, kind: "local", priority: 1 },
      ]);
      expect((await service.update("panel", { targetIds: [] }, ADMIN_ID)).targets).toEqual([]);
    });

    it("accepts two destinations with priorities 1 and 2 (SPEC 6.1 'fino a 2 copie')", async () => {
      const dto = await service.update("default_site", { targetIds: [s3Selectable, local] }, ADMIN_ID);
      expect(dto.targets).toMatchObject([
        { targetId: s3Selectable, kind: "s3", priority: 1, required: true },
        { targetId: local, kind: "local", priority: 2, required: true },
      ]);
      expect(await service.get("default_site")).toEqual(dto);
      await service.update("default_site", { targetIds: [s3Selectable] }, ADMIN_ID);
    });

    it("refuses a third copy (SPEC 6.1 'fino a 2 copie'), duplicates, unknown, disabled and archived destinations", async () => {
      const before = await service.get("default_site");
      const tooMany = await rejection(
        service.update("default_site", { targetIds: [s3Selectable, local, s3Private] }, ADMIN_ID),
      );
      expect(tooMany.code).toBe("VALIDATION_ERROR"); // the contract caps targetIds at 2 before the service runs
      expect((await rejection(service.update("default_site", { targetIds: [local, local] }, ADMIN_ID))).code).toBe(
        "VALIDATION_ERROR",
      );
      expect(
        (await rejection(service.update("default_site", { targetIds: ["bkt_" + "0".repeat(32)] }, ADMIN_ID))).message,
      ).toBe("target_unavailable");

      await updateBackupTarget(db(), s3Private, { enabled: false }, KEY);
      expect((await rejection(service.update("default_site", { targetIds: [s3Private] }, ADMIN_ID))).message).toBe(
        "target_unavailable",
      );
      const gone = (await insertS3Target(db(), KEY, {
        name: "Gone",
        endpoint: "https://s3.gone.example",
        region: "eu-west-1",
        bucket: "gone",
        prefix: "",
        accessKeyId: "AKIAGONE",
        secretAccessKey: "gone-secret",
        customerSelectable: true,
        actorId: ADMIN_ID,
      })).id;
      await archiveBackupTarget(db(), gone);
      expect((await rejection(service.update("default_site", { targetIds: [gone] }, ADMIN_ID))).message).toBe(
        "target_unavailable",
      );
      expect(await service.get("default_site")).toEqual(before);
      await updateBackupTarget(db(), s3Private, { enabled: true }, KEY);
    });

    it("refuses unknown keys and out-of-range values", async () => {
      for (const body of [{ extra: 1 }, { scheduleHourUtc: 24 }, { retentionDays: 0 }, { targetIds: "x" }]) {
        expect((await rejection(service.update("default_site", body, ADMIN_ID))).code).toBe("VALIDATION_ERROR");
      }
    });
  });

  describe("owner policy of a site", () => {
    const keysOf = (value: unknown): string[] => Object.keys(value as object).sort();

    it("inherits the default and offers only selectable destinations, as id and kind", async () => {
      const policy = await service.getSitePolicy(siteA);
      expect(policy.inherited).toBe(true);
      expect(policy.targetIds).toEqual([s3Selectable]);
      expect(policy.choices.map((c) => c.id).sort()).toEqual([s3Selectable, local].sort());
      expect(policy.choices.every((c) => keysOf(c).join() === "id,kind")).toBe(true);
      expect(policy.choices.map((c) => c.id)).not.toContain(s3Private);

      const wire = JSON.stringify(policy);
      for (const secret of ["policy.example", "policy-secret-bucket", "Policy Offsite Name", "Policy Local", "AKIA", "endpoint", "root"]) {
        expect(wire).not.toContain(secret);
      }
      expect(findForbiddenPublicDtoKeys(policy)).toEqual([]);
    });

    it("chooses a destination, audits it with the organisation, and does not touch other sites", async () => {
      const dto = await service.updateSitePolicy(siteA, { targetIds: [local] }, actorOf(OWNER_ID));
      expect(dto).toMatchObject({ inherited: false, targetIds: [local] });
      expect(await service.getSitePolicy(siteA)).toEqual(dto);
      expect((await service.getSitePolicy(siteB)).inherited).toBe(true);

      const rows = (await audits("site.backups.policy.update")).filter((r) => r.targetId === siteA.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorId: OWNER_ID, organizationId: siteA.organizationId, targetType: "site" });
      expect(rows[0]!.details).toMatchObject({ inherited: false, targets: [{ targetId: local, targetKind: "local" }] });
    });

    it("returns to the default with null", async () => {
      const dto = await service.updateSitePolicy(siteA, { targetIds: null }, actorOf(OWNER_ID));
      expect(dto).toMatchObject({ inherited: true, targetIds: [s3Selectable] });
    });

    it("answers 404 for unknown, private, disabled and archived destinations alike, without changing the policy", async () => {
      await updateBackupTarget(db(), local, { enabled: false }, KEY);
      for (const id of ["bkt_" + "1".repeat(32), s3Private, local]) {
        const err = await rejection(service.updateSitePolicy(siteA, { targetIds: [id] }, actorOf(OWNER_ID)));
        expect(err.code).toBe("NOT_FOUND");
        expect(err.message).toBe("Backup destination not found");
      }
      await updateBackupTarget(db(), local, { enabled: true }, KEY);
      expect((await service.getSitePolicy(siteA)).inherited).toBe(true);
      expect(await getBackupTargetRow(db(), s3Private)).not.toBeNull();
    });

    it("accepts two destinations for a site, in order (SPEC 6.1 'fino a 2 copie')", async () => {
      const dto = await service.updateSitePolicy(siteA, { targetIds: [local, s3Selectable] }, actorOf(OWNER_ID));
      expect(dto).toMatchObject({ inherited: false, targetIds: [local, s3Selectable] });
      expect(await BackupPoliciesService.effectiveTargets(db(), siteA.id)).toMatchObject([
        { targetId: local, priority: 1 },
        { targetId: s3Selectable, priority: 2 },
      ]);
      await service.updateSitePolicy(siteA, { targetIds: null }, actorOf(OWNER_ID));
    });

    it("refuses a third destination (SPEC 6.1 'fino a 2 copie') and malformed bodies", async () => {
      const err = await rejection(
        service.updateSitePolicy(siteA, { targetIds: [local, s3Selectable, s3Private] }, actorOf(OWNER_ID)),
      );
      expect(err.code).toBe("VALIDATION_ERROR"); // the contract caps targetIds at 2 before the service runs
      for (const body of [{}, { targetIds: [] }, { targetIds: null, extra: 1 }, { targetIds: [1] }]) {
        expect((await rejection(service.updateSitePolicy(siteA, body, actorOf(OWNER_ID)))).code).toBe("VALIDATION_ERROR");
      }
    });

    it("keeps a choice the administrator stopped offering until the target is disabled", async () => {
      await service.updateSitePolicy(siteA, { targetIds: [local] }, actorOf(OWNER_ID));
      await updateBackupTarget(db(), local, { customerSelectable: false }, KEY);
      expect((await BackupPoliciesService.effectiveTargets(db(), siteA.id)).map((t) => t.targetId)).toEqual([local]);
      expect((await service.getSitePolicy(siteA)).choices.map((c) => c.id)).toEqual([s3Selectable]);
      await updateBackupTarget(db(), local, { customerSelectable: true }, KEY);
      await service.updateSitePolicy(siteA, { targetIds: null }, actorOf(OWNER_ID));
    });
  });

  describe("effective targets and the single 'configured' rule", () => {
    it("follows the site's own policy, else the default, in priority order", async () => {
      expect((await BackupPoliciesService.effectiveTargets(db(), siteB.id)).map((t) => t.targetId)).toEqual([s3Selectable]);
      await service.updateSitePolicy(siteB, { targetIds: [local] }, actorOf(OWNER_ID));
      expect(await BackupPoliciesService.effectiveTargets(db(), siteB.id)).toEqual([
        { targetId: local, kind: "local", priority: 1, required: true },
      ]);
      await service.updateSitePolicy(siteB, { targetIds: null }, actorOf(OWNER_ID));
    });

    it("is configured only on linux-systemd with at least one usable target", async () => {
      expect(await BackupPoliciesService.isSiteBackupConfigured(db(), "linux-systemd", siteA.id)).toBe(true);
      expect(await BackupPoliciesService.isSiteBackupConfigured(db(), "local-simulator", siteA.id)).toBe(false);

      await updateBackupTarget(db(), s3Selectable, { enabled: false }, KEY);
      expect(await BackupPoliciesService.effectiveTargets(db(), siteA.id)).toEqual([]);
      expect(await BackupPoliciesService.isSiteBackupConfigured(db(), "linux-systemd", siteA.id)).toBe(false);
      await updateBackupTarget(db(), s3Selectable, { enabled: true }, KEY);
      expect(await BackupPoliciesService.isSiteBackupConfigured(db(), "linux-systemd", siteA.id)).toBe(true);
    });

    it("counts a local-only install as configured (no S3 needed)", async () => {
      await service.update("default_site", { targetIds: [local] }, ADMIN_ID);
      await db().delete(backupSettings).where(eq(backupSettings.id, "default"));
      expect(await BackupPoliciesService.isSiteBackupConfigured(db(), "linux-systemd", siteB.id)).toBe(true);
      expect((await getPolicy(db(), "default_site")).targets.map((t) => t.kind)).toEqual(["local"]);
    });
  });

  describe("AdminBackupPoliciesController", () => {
    const calls: string[] = [];
    const authz = (denied: boolean) =>
      ({
        authenticateRequest: async () => ({ user: { id: ADMIN_ID } }),
        requirePlatformPermission: async () => {
          calls.push("permission");
          if (denied) throw new ControlPlaneError("PERMISSION_DENIED", "denied");
        },
      }) as unknown as AuthzContextService;

    it("checks the administrator before the scope or the body", async () => {
      const controller = new AdminBackupPoliciesController(service, authz(true));
      calls.length = 0;
      expect((await rejection(controller.get(req, "bogus"))).code).toBe("PERMISSION_DENIED");
      expect((await rejection(controller.update(req, "default", { targetIds: [local] }))).code).toBe("PERMISSION_DENIED");
      expect(calls).toEqual(["permission", "permission"]);
    });

    it("serves default and panel and answers 404 for any other scope", async () => {
      const controller = new AdminBackupPoliciesController(service, authz(false));
      expect((await controller.get(req, "default")).data.scope).toBe("default_site");
      expect((await controller.get(req, "panel")).data.scope).toBe("panel");
      expect((await controller.update(req, "panel", { retentionDays: 11 })).data.retentionDays).toBe(11);
      for (const scope of ["site", "default_site", "constructor", "__proto__", "Default"]) {
        expect((await rejection(controller.get(req, scope))).code).toBe("NOT_FOUND");
        expect((await rejection(controller.update(req, scope, {}))).code).toBe("NOT_FOUND");
      }
    });
  });
});
