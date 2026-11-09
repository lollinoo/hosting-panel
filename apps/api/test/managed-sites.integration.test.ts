import { randomUUID } from "node:crypto";
import {
  auditEvents,
  createDatabaseClient,
  domains,
  encryptedSecrets,
  eq,
  hostAllocations,
  moveSiteToOrganizationTransactional,
  markExpiredOperationsUnknownTransactional,
  membershipRoles,
  memberships,
  operationSteps,
  operations,
  organizations,
  outboxEvents,
  serviceInstances,
  siteDatabases,
  sites,
  stackRevisions,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { siteDatabaseIdentifier } from "../src/runtime/site-provisioner.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const CANARY = "canary-Pass-123456";
const SITE = {
  name: "Hotel Bella",
  domain: "hotel.it",
  title: "Hotel Bella Vista",
  adminUser: "admin",
  adminEmail: "admin@hotel.it",
  adminPassword: CANARY,
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("managed WordPress sites API", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let token: string;
  let adminToken: string;
  let orgId: string;

  async function login(email: string, password: string, totpSecret?: string): Promise<string> {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
      }),
    });
    return ((await res.json()) as Json).data.accessToken as string;
  }

  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    as: string = token,
  ): Promise<{ status: number; body: Json; raw: string }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  }

  const org = (p: string) => `/v1/organizations/${orgId}${p}`;
  const create = (body: unknown = SITE, key: string = randomUUID()) =>
    call("POST", org("/managed-sites"), body, { "Idempotency-Key": key });
  const getOp = async (opId: string) => (await call("GET", org(`/operations/${opId}`))).body.data as Json;
  const run = () => app.outboxWorker.processPendingOnce();
  const webService = async (siteId: string) =>
    (await dbClient.db.select().from(serviceInstances).where(eq(serviceInstances.siteId, siteId)))[0]!;
  const siteSpecs = (siteId: string) => sim.deployedSpecs.filter((s) => s.siteId === siteId);

  async function createAndRun(body: unknown = SITE) {
    const res = await create(body);
    expect(res.status).toBe(202);
    await run();
    return res.body.data as { siteId: string; operationId: string };
  }

  const key = () => ({ "Idempotency-Key": randomUUID() });
  const siteUrl = (siteId: string, tail = "") => org(`/managed-sites/${siteId}${tail}`);

  async function addCollaborator(): Promise<string> {
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({
      id: userId,
      email: "collab@hotel.it",
      name: "Collab",
      passwordHash: await hashPassword(PW),
    });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: orgId, userId });
    await dbClient.db
      .insert(membershipRoles)
      .values({ id: `mrl_${randomUUID()}`, membershipId, roleId: "role_customer_collaborator" });
    return login("collab@hotel.it", PW);
  }

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@x.it", name: "Admin", password: PW });
    sim = new InMemoryDockerSimulatorAdapter();
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: sim,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    adminToken = await login("admin@x.it", PW, admin.totpSecretBase32);
    const created = await call(
      "POST",
      "/v1/admin/customer-account",
      { organizationName: "Hotel Mario", ownerEmail: "mario@hotel.it", ownerName: "Mario" },
      {},
      adminToken,
    );
    expect(created.status).toBe(201);
    orgId = created.body.data.organizationId as string;
    token = await login("mario@hotel.it", created.body.data.temporaryPassword as string);
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  it("creates a WordPress site and provisions it end to end", async () => {
    const res = await create();
    expect(res.status).toBe(202);
    const { siteId, operationId } = res.body.data as { siteId: string; operationId: string };
    expect(res.body.links.operation).toBe(`/v1/organizations/${orgId}/operations/${operationId}`);

    await run();

    const op = await getOp(operationId);
    expect(op.status).toBe("succeeded");
    expect(op.steps.map((s: Json) => s.key).sort()).toEqual(
      ["create_database", "deploy_site", "finish", "install_wordpress", "publish_site"],
    );
    expect(op.steps.every((s: Json) => s.status === "succeeded")).toBe(true);
    expect(sim.jobs.map((j) => j.kind)).toEqual(["db.provision", "wordpress.install"]);

    const specs = siteSpecs(siteId);
    expect(specs).toHaveLength(2);
    expect(specs[0]!.domains).toEqual([]);
    expect(specs[1]!.domains).toEqual(["hotel.it"]);
    expect(specs[1]!.image).toBe("wordpress:7.1.4-php8.4-apache");
    for (const spec of specs) {
      expect(Object.keys(spec.env).filter((k) => k.startsWith("WORDPRESS_"))).toEqual([]);
    }

    const site = await call("GET", org(`/sites/${siteId}`));
    expect(site.body.data.status).toBe("ready");
    expect(site.body.data.phpVersion).toBe("8.4");
    const managed = await call("GET", org(`/managed-sites/${siteId}`));
    expect(managed.status).toBe(200);
    expect(managed.body.data.primaryDomain).toBe("hotel.it");
    expect(managed.body.data.status).toBe("ready");

    const secrets = await dbClient.db.select().from(encryptedSecrets).where(eq(encryptedSecrets.siteId, siteId));
    expect(secrets.map((s) => s.secretKey)).toEqual(["SITE_DB_PASSWORD"]);
    const audits = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "site.provision.succeeded"));
    expect(audits).toHaveLength(1);
  });

  it("the WordPress container gets exactly the four certified capabilities", async () => {
    const { siteId } = await createAndRun();
    const svc = await webService(siteId);
    const inspect = sim.getSimulatedContainerInspect(svc.id);
    expect([...(inspect?.HostConfig?.CapAdd ?? [])].sort()).toEqual(["CHOWN", "NET_BIND_SERVICE", "SETGID", "SETUID"]);
  });

  it("a new WordPress site is deployed with siteMail", async () => {
    const { siteId } = await createAndRun();
    expect(sim.deployedSpecs.at(-1)).toMatchObject({ siteId, siteMail: true });
    const svc = await webService(siteId);
    const [rev] = await dbClient.db.select().from(stackRevisions).where(eq(stackRevisions.id, svc.currentRevisionId!));
    expect(rev?.declarativeConfig).toMatchObject({ siteMail: true });
  });

  it("the site is not routed until WordPress is installed", async () => {
    sim.failNextJob("wordpress.install", 1);
    const { siteId, operationId } = await createAndRun();
    expect((await getOp(operationId)).status).toBe("failed");
    const [dom] = await dbClient.db.select().from(domains).where(eq(domains.siteId, siteId));
    expect(dom!.status).toBe("pending");
    const specs = siteSpecs(siteId);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.domains).toEqual([]);
    const [site] = await dbClient.db.select().from(sites).where(eq(sites.id, siteId));
    expect(site!.status).toBe("degraded");
  });

  it("the site page reports a failed setup as degraded, so the customer gets Try again", async () => {
    sim.failNextJob("wordpress.install", 1);
    const { siteId } = await createAndRun();
    const site = await call("GET", org(`/sites/${siteId}`));
    expect(site.body.data.status).toBe("degraded");
  });

  it("a provisioned site has no secret refs and is deployed without secrets", async () => {
    const { siteId } = await createAndRun();
    const svc = await webService(siteId);
    const revs = await dbClient.db.select().from(stackRevisions).where(eq(stackRevisions.serviceInstanceId, svc.id));
    expect(revs.map((r) => r.secretRefs)).toEqual([{}]);
    const specs = siteSpecs(siteId);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.every((s) => s.resolvedSecrets === undefined)).toBe(true);
  });

  it("repeating a create with the same Idempotency-Key returns the original 202", async () => {
    const key = randomUUID();
    const first = await create(SITE, key);
    const second = await create(SITE, key);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.data).toEqual(first.body.data);
    expect(await dbClient.db.select().from(sites)).toHaveLength(1);
  });

  it("a concurrent create with the same Idempotency-Key replays, not DOMAIN_CONFLICT", async () => {
    const key = randomUUID();
    const original = dbClient.db.transaction.bind(dbClient.db);
    let winner: Promise<Awaited<ReturnType<typeof create>>> | undefined;
    // The twin request commits between this one's replay check and its own transaction.
    vi.spyOn(dbClient.db, "transaction").mockImplementation((async (...args: Parameters<typeof original>) => {
      if (!winner) {
        winner = create(SITE, key);
        await winner;
      }
      return original(...args);
    }) as typeof original);
    const loser = await create(SITE, key);
    const first = await winner!;
    expect(first.status).toBe(202);
    expect(loser.status).toBe(202);
    expect(loser.body.data).toEqual(first.body.data);
    expect(await dbClient.db.select().from(sites)).toHaveLength(1);
  });

  it("a step running past 60 s keeps its lease", async () => {
    let statusDuringStep: string | undefined;
    sim.onJob = async (req) => {
      if (req.kind !== "db.provision") return;
      await markExpiredOperationsUnknownTransactional(dbClient.db, new Date(Date.now() + 61_000));
      const [op] = await dbClient.db.select().from(operations).where(eq(operations.kind, "site.provision"));
      statusDuringStep = op!.status;
    };
    const { operationId } = await createAndRun();
    expect(statusDuringStep).toBe("processing");
    expect((await getOp(operationId)).status).toBe("succeeded");
  });

  it("customer cannot overwrite platform secrets", async () => {
    const { siteId } = await createAndRun();
    const post = (body: unknown) => call("POST", org("/secrets"), body, { "Idempotency-Key": randomUUID() });
    expect((await post({ secretKey: "SITE_DB_PASSWORD", value: "x", siteId })).status).toBe(400);
    expect((await post({ secretKey: "HP_X", value: "x" })).status).toBe(400);
    expect((await post({ secretKey: "WP_ADMIN_PASSWORD_INITIAL", value: "x" })).status).toBe(400);
    const [platformSecret] = await dbClient.db.select().from(encryptedSecrets).where(eq(encryptedSecrets.siteId, siteId));
    expect((await call("DELETE", org(`/secrets/${platformSecret!.id}`))).status).toBe(400);
    expect(await dbClient.db.select().from(encryptedSecrets).where(eq(encryptedSecrets.id, platformSecret!.id))).toHaveLength(1);
  });

  it("generic service routes refuse a managed site", async () => {
    const { siteId } = await createAndRun();
    const svc = await webService(siteId);
    const headers = () => ({ "Idempotency-Key": randomUUID() });
    const rev = await call("POST", org(`/services/${svc.id}/revisions`), { declarativeConfig: { image: "nginx:latest" } }, headers());
    expect(rev.status).toBe(400);
    expect(rev.body.error.message).toBe("Manage this site from its page");
    const life = await call("POST", org(`/services/${svc.id}/lifecycle`), { action: "deploy" }, headers());
    expect(life.status).toBe(400);
    expect(life.body.error.message).toBe("Manage this site from its page");
    const added = await call(
      "POST",
      org(`/sites/${siteId}/services`),
      { serviceTemplateId: "tpl_site_wordpress", name: "extra", configuration: {} },
      headers(),
    );
    expect(added.status).toBe(400);
  });

  it("failure output stays out of customer-visible fields", async () => {
    const leak = "ERROR 1045 (28000): Access denied for user";
    sim.failNextJob("wordpress.install", 1, leak);
    const { operationId } = await createAndRun();
    const res = await call("GET", org(`/operations/${operationId}`));
    expect(res.body.data.status).toBe("failed");
    expect(res.body.data.errorMessage).toBe("Site setup did not finish");
    expect(res.raw).not.toContain("ERROR 1045");
    const [failed] = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "site.provision.failed"));
    expect(failed!.details).toMatchObject({ step: "install_wordpress", exitCode: 1 });
    expect(JSON.stringify(failed!.details)).toContain("ERROR 1045 (28000)");
  });

  it("rejects a domain used by another site or by the panel", async () => {
    expect((await create()).status).toBe(202);
    for (const domain of ["hotel.it", "panel.test", "Hotel.IT."]) {
      const res = await create({ ...SITE, domain });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("DOMAIN_CONFLICT");
    }
  });

  it("no secret reaches the outbox, the operation DTO or the audit log", async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    let opRaw: string;
    try {
      const { operationId } = await createAndRun();
      opRaw = (await call("GET", org(`/operations/${operationId}`))).raw;
    } finally {
      spy.mockRestore();
    }
    expect(opRaw).not.toContain(CANARY);
    expect(written.join("")).not.toContain(CANARY);
    const dump = JSON.stringify([
      await dbClient.db.select({ p: outboxEvents.payload }).from(outboxEvents),
      await dbClient.db.select({ m: operationSteps.message }).from(operationSteps),
      await dbClient.db.select({ e: operations.errorMessage }).from(operations),
      await dbClient.db.select({ d: auditEvents.details }).from(auditEvents),
    ]);
    expect(dump).not.toContain(CANARY);
  });

  it("retry after a failed install reuses the database", async () => {
    sim.failNextJob("wordpress.install", 1);
    const { siteId, operationId } = await createAndRun();
    expect((await getOp(operationId)).status).toBe("failed");

    const retry = await call("POST", org(`/managed-sites/${siteId}/actions`), { action: "retry" }, { "Idempotency-Key": randomUUID() });
    expect(retry.status).toBe(202);
    await run();
    expect((await getOp(retry.body.data.operationId as string)).status).toBe("succeeded");

    expect(await dbClient.db.select().from(siteDatabases).where(eq(siteDatabases.siteId, siteId))).toHaveLength(1);
    const dbJobs = sim.jobs.filter((j) => j.kind === "db.provision");
    expect(dbJobs).toHaveLength(2);
    expect(dbJobs[0]!.resolvedSecrets!["HP_DB_PASSWORD"]).toMatch(/^[0-9a-f]{64}$/);
    expect(dbJobs[1]!.resolvedSecrets!["HP_DB_PASSWORD"]).toBe(dbJobs[0]!.resolvedSecrets!["HP_DB_PASSWORD"]);
    expect(sim.jobs.filter((j) => j.kind === "wordpress.install")).toHaveLength(2);
  });

  it("retry after a failed publish skips the install job", async () => {
    sim.onJob = async (req) => {
      if (req.kind === "wordpress.install") sim.failNextDeploy();
    };
    const { siteId, operationId } = await createAndRun();
    expect((await getOp(operationId)).status).toBe("failed");
    sim.onJob = undefined;

    const retry = await call("POST", org(`/managed-sites/${siteId}/actions`), { action: "retry" }, { "Idempotency-Key": randomUUID() });
    expect(retry.status).toBe(202);
    await run();
    expect((await getOp(retry.body.data.operationId as string)).status).toBe("succeeded");
    expect(sim.jobs.filter((j) => j.kind === "wordpress.install")).toHaveLength(1);
    const secrets = await dbClient.db.select().from(encryptedSecrets).where(eq(encryptedSecrets.siteId, siteId));
    expect(secrets.map((s) => s.secretKey)).toEqual(["SITE_DB_PASSWORD"]);
  });

  it("retry is refused when there is nothing to retry", async () => {
    const { siteId } = await createAndRun();
    const res = await call("POST", org(`/managed-sites/${siteId}/actions`), { action: "retry" }, { "Idempotency-Key": randomUUID() });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("There is nothing to retry.");
  });

  it("interrupted site.provision converges to failed, not replayed", async () => {
    const res = await create();
    const { siteId, operationId } = res.body.data as { siteId: string; operationId: string };
    await dbClient.db
      .update(operations)
      .set({ status: "processing", leaseExpiresAt: new Date(Date.now() - 5_000) })
      .where(eq(operations.id, operationId));
    await dbClient.db.update(outboxEvents).set({ status: "published" }).where(eq(outboxEvents.aggregateId, siteId));
    const deploySpy = vi.spyOn(sim, "deployService");

    const recovery = await app.outboxWorker.recoverUnknownOperations();
    expect(recovery.convergedFailed).toBe(1);
    expect((await getOp(operationId)).status).toBe("failed");
    const [site] = await dbClient.db.select().from(sites).where(eq(sites.id, siteId));
    expect(site!.status).toBe("degraded");
    expect(sim.jobs).toEqual([]);
    expect(deploySpy).not.toHaveBeenCalled();
  });

  it("customer without site.create gets 403", async () => {
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({
      id: userId,
      email: "collab@hotel.it",
      name: "Collab",
      passwordHash: await hashPassword(PW),
    });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: orgId, userId });
    await dbClient.db
      .insert(membershipRoles)
      .values({ id: `mrl_${randomUUID()}`, membershipId, roleId: "role_customer_collaborator" });
    const collabToken = await login("collab@hotel.it", PW);
    const res = await call("POST", org("/managed-sites"), SITE, { "Idempotency-Key": randomUUID() }, collabToken);
    expect(res.status).toBe(403);
    expect(await dbClient.db.select().from(sites)).toHaveLength(0);
  });
  it("a collaborator without permission gets 403 before 400 on actions", async () => {
    const { siteId } = await createAndRun();
    const collabToken = await addCollaborator();
    const res = await call("POST", siteUrl(siteId, "/actions"), { action: "nonsense" }, key(), collabToken);
    expect(res.status).toBe(403);
  });

  it("a create that loses the domain race gets 409 DOMAIN_CONFLICT, not 500", async () => {
    expect((await create({ ...SITE, name: "Other", domain: "other.it" })).status).toBe(202);
    // The rival commits between the pre-check and the create transaction.
    const original = dbClient.db.transaction.bind(dbClient.db);
    vi.spyOn(dbClient.db, "transaction").mockImplementationOnce(((fn: never, cfg?: never) =>
      dbClient.db
        .update(domains)
        .set({ hostname: SITE.domain })
        .where(eq(domains.hostname, "other.it"))
        .then(() => original(fn, cfg))) as never);
    const res = await create(SITE);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DOMAIN_CONFLICT");
    expect(await dbClient.db.select().from(sites)).toHaveLength(1);
  });

  it("stop then start sets desired status and enqueues the matching operation", async () => {
    const { siteId } = await createAndRun();
    const svc = await webService(siteId);

    const stop = await call("POST", siteUrl(siteId, "/actions"), { action: "stop" }, key());
    expect(stop.status).toBe(202);
    const stopOp = await getOp(stop.body.data.operationId);
    expect(stopOp.kind).toBe("service.stop");
    expect((await webService(siteId)).desiredStatus).toBe("stopped");
    await run();
    expect((await getOp(stop.body.data.operationId)).status).toBe("succeeded");
    expect(sim.getSimulatedContainerInspect(svc.id)?.State?.Running).toBe(false);

    const start = await call("POST", siteUrl(siteId, "/actions"), { action: "start" }, key());
    expect(start.status).toBe(202);
    expect((await getOp(start.body.data.operationId)).kind).toBe("service.restart");
    expect((await webService(siteId)).desiredStatus).toBe("running");
    await run();
    expect((await getOp(start.body.data.operationId)).status).toBe("succeeded");

    const [lock] = await dbClient.db.select().from(operations).where(eq(operations.id, start.body.data.operationId));
    expect(lock!.lockKey).toBe(`site:${siteId}`);
  });

  it("changing PHP version creates a revision with the new image and redeploys", async () => {
    const { siteId } = await createAndRun();
    const svc = await webService(siteId);
    const res = await call("PATCH", siteUrl(siteId, "/runtime"), { phpVersion: "8.5" }, key());
    expect(res.status).toBe(202);
    await run();
    expect((await getOp(res.body.data.operationId)).status).toBe("succeeded");

    const revs = await dbClient.db.select().from(stackRevisions).where(eq(stackRevisions.serviceInstanceId, svc.id));
    expect(revs).toHaveLength(2);
    const latest = revs.sort((a, b) => a.revisionNumber - b.revisionNumber)[1]!;
    expect((latest.declarativeConfig as Json)["image"]).toBe("wordpress:7.1.4-php8.5-apache");
    expect((latest.declarativeConfig as Json)["volumeMounts"]).toEqual(
      (revs.find((r) => r.id !== latest.id)!.declarativeConfig as Json)["volumeMounts"],
    );
    expect(siteSpecs(siteId).at(-1)!.image).toBe("wordpress:7.1.4-php8.5-apache");
    expect((await call("GET", siteUrl(siteId))).body.data.phpVersion).toBe("8.5");
  });

  it("a service.deploy keeps its lease past 60 s", async () => {
    const { siteId } = await createAndRun();
    let statusDuringDeploy: string | undefined;
    sim.onDeploy = async () => {
      await markExpiredOperationsUnknownTransactional(dbClient.db, new Date(Date.now() + 61_000));
      const [op] = await dbClient.db.select().from(operations).where(eq(operations.kind, "service.deploy"));
      statusDuringDeploy = op!.status;
    };
    const res = await call("PATCH", siteUrl(siteId, "/runtime"), { phpVersion: "8.3" }, key());
    await run();
    expect(statusDuringDeploy).toBe("processing");
    expect((await getOp(res.body.data.operationId)).status).toBe("succeeded");
  });

  it("delete requires the exact site name", async () => {
    const { siteId } = await createAndRun();
    const res = await call("DELETE", siteUrl(siteId), { confirmName: "hotel" }, key());
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe("confirmName");
    expect(await dbClient.db.select().from(sites)).toHaveLength(1);
    expect((await call("DELETE", siteUrl(siteId), { confirmName: " Hotel Bella " }, key())).status).toBe(202);
  });

  it("delete while provisioning returns RESOURCE_LOCKED", async () => {
    const created = await create();
    const { siteId } = created.body.data as { siteId: string };
    const res = await call("DELETE", siteUrl(siteId), { confirmName: SITE.name }, key());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("RESOURCE_LOCKED");
  });

  it("delete drops the site database and keeps the other site serving", async () => {
    const a = await createAndRun();
    const b = await createAndRun({ ...SITE, name: "Bar Sport", domain: "bar.it" });
    const [dbA] = await dbClient.db.select().from(siteDatabases).where(eq(siteDatabases.siteId, a.siteId));
    expect(dbA!.dbName).toBe(siteDatabaseIdentifier(a.siteId));
    const purge = vi.spyOn(sim, "purgeSite");
    sim.jobs.length = 0;

    const res = await call("DELETE", siteUrl(a.siteId), { confirmName: SITE.name }, key());
    expect(res.status).toBe(202);
    expect((await call("GET", siteUrl(a.siteId))).body.data.status).toBe("maintenance");
    await run();
    expect((await getOp(res.body.data.operationId)).status).toBe("succeeded");

    expect(sim.jobs.map((j) => [j.kind, j.siteId, j.params["dbName"], j.params["dbUser"]])).toEqual([
      ["db.drop", a.siteId, dbA!.dbName, dbA!.dbUser],
    ]);
    expect(purge.mock.calls).toEqual([[a.siteId]]);
    expect((await call("GET", siteUrl(a.siteId))).status).toBe(404);
    expect(await dbClient.db.select().from(serviceInstances).where(eq(serviceInstances.siteId, a.siteId))).toHaveLength(0);
    expect(await dbClient.db.select().from(domains).where(eq(domains.siteId, a.siteId))).toHaveLength(0);
    expect(await dbClient.db.select().from(encryptedSecrets).where(eq(encryptedSecrets.siteId, a.siteId))).toHaveLength(0);
    expect(await dbClient.db.select().from(siteDatabases).where(eq(siteDatabases.siteId, a.siteId))).toHaveLength(0);

    expect((await call("GET", siteUrl(b.siteId))).body.data.status).toBe("ready");
    expect(await dbClient.db.select().from(siteDatabases).where(eq(siteDatabases.siteId, b.siteId))).toHaveLength(1);
    expect(await dbClient.db.select().from(stackRevisions).where(eq(stackRevisions.serviceInstanceId, (await webService(b.siteId)).id))).toHaveLength(1);
    const audits = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "site.delete.succeeded"));
    expect(audits).toHaveLength(1);
  });

  it("a failed database drop keeps the site serving and delete can be requested again", async () => {
    const { siteId } = await createAndRun();
    const svc = await webService(siteId);
    sim.failNextJob("db.drop", 1);
    const first = await call("DELETE", siteUrl(siteId), { confirmName: SITE.name }, key());
    await run();
    expect((await getOp(first.body.data.operationId)).status).toBe("failed");
    expect(sim.getSimulatedContainerInspect(svc.id)?.State?.Running).toBe(true);
    expect((await webService(siteId)).id).toBe(svc.id);
    expect(await dbClient.db.select().from(siteDatabases).where(eq(siteDatabases.siteId, siteId))).toHaveLength(1);
    expect((await call("GET", siteUrl(siteId))).body.data.status).toBe("degraded");

    const second = await call("DELETE", siteUrl(siteId), { confirmName: SITE.name }, key());
    expect(second.status).toBe(202);
    await run();
    expect((await getOp(second.body.data.operationId)).status).toBe("succeeded");
    expect((await call("GET", siteUrl(siteId))).status).toBe(404);
  });

  it("logs return demuxed lines and clamp tail", async () => {
    const { siteId } = await createAndRun();
    const svc = await webService(siteId);
    const lines = Array.from({ length: 600 }, (_, i) => ({
      at: "2026-11-08T10:00:00.000Z",
      stream: i % 2 ? ("stderr" as const) : ("stdout" as const),
      text: `line ${String(i)}`,
    }));
    sim.setServiceLogs(svc.id, lines);
    const spy = vi.spyOn(sim, "getServiceLogs");

    const two = await call("GET", siteUrl(siteId, "/logs?tail=2"));
    expect(two.status).toBe(200);
    expect(two.body.data).toEqual(lines.slice(-2));
    expect((await call("GET", siteUrl(siteId, "/logs?tail=99999"))).body.data).toHaveLength(500);
    await call("GET", siteUrl(siteId, "/logs?tail=0"));
    await call("GET", siteUrl(siteId, "/logs"));
    expect(spy.mock.calls.map((c) => c[1])).toEqual([2, 500, 1, 200]);
  });

  it("logs answer 503 when the executor does not support them", async () => {
    const { siteId } = await createAndRun();
    vi.spyOn(sim, "getServiceLogs").mockRejectedValue(Object.assign(new Error("off"), { code: "NOT_SUPPORTED" }));
    const res = await call("GET", siteUrl(siteId, "/logs"));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
  });

  it("customer cannot act on a site of another organization", async () => {
    const foreign = (await createAndRun()).siteId;
    const [mine] = await dbClient.db.select().from(organizations).where(eq(organizations.id, orgId));
    const otherOrg = `org_${randomUUID()}`;
    await dbClient.db
      .insert(organizations)
      .values({ id: otherOrg, platformInstallationId: mine!.platformInstallationId, name: "Bar Sport", slug: "bar-sport" });
    const [alloc] = await dbClient.db.select().from(hostAllocations).where(eq(hostAllocations.organizationId, orgId));
    const otherAlloc = `alloc_${randomUUID()}`;
    await dbClient.db
      .insert(hostAllocations)
      .values({ id: otherAlloc, hostId: alloc!.hostId, organizationId: otherOrg, status: "active" });
    await moveSiteToOrganizationTransactional(dbClient.db, {
      siteId: foreign,
      fromOrganizationId: orgId,
      toOrganizationId: otherOrg,
      toHostAllocationId: otherAlloc,
      masterKey: KEY.toString("hex"),
    });
    const opsBefore = (await dbClient.db.select().from(operations)).length;

    const attempts = [
      call("POST", siteUrl(foreign, "/actions"), { action: "stop" }, key()),
      call("PATCH", siteUrl(foreign, "/runtime"), { phpVersion: "8.5" }, key()),
      call("DELETE", siteUrl(foreign), { confirmName: "Bar" }, key()),
      call("GET", siteUrl(foreign, "/logs")),
    ];
    expect((await Promise.all(attempts)).map((r) => r.status)).toEqual([404, 404, 404, 404]);
    expect(await dbClient.db.select().from(operations)).toHaveLength(opsBefore);
  });

  it("a delete that fails after the database drop can be requested again and removes everything", async () => {
    const { siteId } = await createAndRun();
    vi.spyOn(sim, "purgeSite").mockRejectedValueOnce(new Error("boom"));
    const first = await call("DELETE", siteUrl(siteId), { confirmName: SITE.name }, key());
    await run();
    expect((await getOp(first.body.data.operationId)).status).toBe("failed");
    expect((await call("GET", siteUrl(siteId))).body.data.status).toBe("degraded");

    const second = await call("DELETE", siteUrl(siteId), { confirmName: SITE.name }, key());
    expect(second.status).toBe(202);
    await run();
    expect((await getOp(second.body.data.operationId)).status).toBe("succeeded");
    expect(sim.jobs.filter((j) => j.kind === "db.drop")).toHaveLength(2);
    expect((await call("GET", siteUrl(siteId))).status).toBe(404);
    expect(await dbClient.db.select().from(serviceInstances).where(eq(serviceInstances.siteId, siteId))).toHaveLength(0);
  });

  it("customer-visible step and error texts never use internal words", async () => {
    const { siteId } = await createAndRun();
    const act = (action: string) => call("POST", siteUrl(siteId, "/actions"), { action }, key());
    await act("stop");
    await run();
    await act("start");
    await run();
    await act("restart");
    await run();
    await call("PATCH", siteUrl(siteId, "/runtime"), { phpVersion: "8.5" }, key());
    await run();
    sim.failNextDeploy();
    await call("PATCH", siteUrl(siteId, "/runtime"), { phpVersion: "8.3" }, key());
    await run();
    await call("DELETE", siteUrl(siteId), { confirmName: SITE.name }, key());
    await run();

    const ops = await dbClient.db.select().from(operations);
    expect(ops.map((o) => o.kind).sort()).toEqual(
      ["service.deploy", "service.deploy", "service.restart", "service.restart", "service.stop", "site.delete", "site.provision"],
    );
    expect(ops.filter((o) => o.status === "failed").length).toBe(1);
    const steps = await dbClient.db.select().from(operationSteps);
    const texts = [...steps.flatMap((x) => [x.label, x.message ?? ""]), ...ops.map((o) => o.errorMessage ?? "")];
    const forbidden = /\b(containers?|images?|docker|volumes?|networks?|revisions?|services?|templates?|mariadb|jobs?|organi[sz]ations?)\b/i;
    expect(texts.filter((t) => forbidden.test(t))).toEqual([]);
  });

  it("deleting a revision directly is still refused", async () => {
    const { siteId } = await createAndRun();
    await expect(
      dbClient.db.delete(stackRevisions).where(eq(stackRevisions.serviceInstanceId, (await webService(siteId)).id)),
    ).rejects.toThrow();
  });
});
