import { readFileSync } from "node:fs";
import type { AppStackStatus, AppStackStatusIpcResult, ApprovedStackPlan } from "@hosting-panel/contracts";
import {
  and,
  appStackComponents,
  appStackDeployments,
  appStackDomains,
  appStackRevisions,
  appStacks,
  appTemplates,
  appTemplateVersions,
  auditEvents,
  createDatabaseClient,
  eq,
  hostAllocations,
  hosts,
  operations,
  organizations,
  outboxEvents,
  platformInstallations,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import { APP_STACK_EXECUTOR_METHODS, type CertificateStatusReport, type DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppStackObserverService } from "../src/app-stacks/app-stack-observer.service.js";
import {
  APP_STACK_OBSERVE_BATCH,
  appStackDisplayStatus,
  appStackRoutePlan,
  appStackRoutesHash,
} from "../src/app-stacks/app-stack-runtime-policy.js";
import type { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import type { DnsLookup } from "../src/sites/dns-check.js";
import { certRetryAt, nextDnsCheckAt } from "../src/sites/domain-policy.js";
import type { ControlPlaneRuntimeConfig } from "../src/tokens.js";

// RT6: the observer reads health, runs the stack DNS/ACME machine and queues a system route refresh; it never mutates a
// container and never writes app_stacks.status itself.
const NOW = new Date("2026-11-22T10:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const ORG = "org_obs";
const ALLOC = "alloc_obs";
const IPV4 = "10.0.0.71";
const PLAN = JSON.parse(
  readFileSync(new URL("../../../packages/contracts/test/fixtures/app-stack-notes-demo/plan.json", import.meta.url), "utf8"),
) as ApprovedStackPlan;

interface Seeded {
  readonly id: string;
  readonly revisionId: string;
  readonly plan: ApprovedStackPlan;
}

describe("AppStackObserverService (PGlite)", () => {
  let client: DatabaseClient;
  const db = (): HostingPanelDatabase => client.db;
  let counter = 0;
  let calls: { method: string; stackId?: string }[];
  let failing: Set<string>;
  let onStatusRead: () => void;
  let report: CertificateStatusReport;
  let reportFails: boolean;
  let answers: Map<string, { a: string[]; aaaa: string[] }>;
  let lookups: string[];
  let triggerAsync: ReturnType<typeof vi.fn>;

  const observation = (stackId: string): AppStackStatusIpcResult => {
    const base = { probe: "passed", componentHash: null, revisionId: null, startedAt: null, restartCount: 0, oomKilled: false } as const;
    return {
      stackId,
      observedAt: NOW.toISOString(),
      components: [
        { ...base, componentKey: "app", state: "running", health: "healthy", exitCode: null },
        { ...base, componentKey: "cache", state: "exited", health: "stopped", exitCode: 1 },
      ],
      networks: { internal: true, edge: true },
      volumes: ["data"],
      routes: { published: false, hostnames: [] },
    };
  };

  const executor = (): DockerExecutorPort =>
    ({
      ...Object.fromEntries(
        APP_STACK_EXECUTOR_METHODS.map((method) => [
          method,
          () => {
            calls.push({ method });
            return Promise.reject(new Error("unexpected call"));
          },
        ]),
      ),
      getAppStackStatus: (req: { stackId: string }) => {
        calls.push({ method: "getAppStackStatus", stackId: req.stackId });
        onStatusRead();
        return failing.has(req.stackId) ? Promise.reject(new Error("engine down")) : Promise.resolve(observation(req.stackId));
      },
      getCertificateStatus: () => {
        calls.push({ method: "getCertificateStatus" });
        return reportFails ? Promise.reject(new Error("proxy down")) : Promise.resolve(report);
      },
    }) as unknown as DockerExecutorPort;

  const dns: DnsLookup = {
    lookup: (hostname) => {
      lookups.push(hostname);
      return Promise.resolve(answers.get(hostname) ?? { a: [IPV4], aaaa: [] });
    },
  };

  const observer = (config: Partial<ControlPlaneRuntimeConfig> = {}) =>
    new AppStackObserverService(
      client,
      executor(),
      dns,
      { runtimeBackend: "local-simulator", domainReconcileIntervalMs: null, ...config } as ControlPlaneRuntimeConfig,
      { triggerAsync } as unknown as OutboxWorkerService,
    );

  const statusReads = () => calls.filter((c) => c.method === "getAppStackStatus").map((c) => c.stackId);
  const mutatingCalls = () => calls.filter((c) => c.method !== "getAppStackStatus" && c.method !== "getCertificateStatus");

  async function seedStack(input: {
    status: AppStackStatus;
    observedAt?: Date | null;
    applied?: boolean;
    desiredDiffers?: boolean;
    routesHash?: string | null;
    domains?: readonly Partial<typeof appStackDomains.$inferInsert>[];
  }): Promise<Seeded> {
    counter += 1;
    const id = `stk_obs_${String(counter).padStart(3, "0")}`;
    const revisionId = `astr_obs_${String(counter)}`;
    const plan: ApprovedStackPlan = { ...PLAN, stackId: id, organizationId: ORG, hostAllocationId: ALLOC, templateVersionId: "atv_obs1", revisionId };
    await db()
      .insert(appStacks)
      .values({
        id,
        organizationId: ORG,
        hostAllocationId: ALLOC,
        templateId: "atpl_obs",
        templateVersionId: "atv_obs1",
        name: `Stack ${String(counter)}`,
        status: input.status,
        appliedRoutesHash: input.routesHash ?? null,
        deletedAt: input.status === "deleted" ? NOW : null,
      });
    const revision = (rid: string, n: number) => ({
      id: rid,
      stackId: id,
      organizationId: ORG,
      revisionNumber: n,
      templateVersionId: "atv_obs1",
      plan: { ...plan, revisionId: rid },
      planHash: plan.planHash,
      componentCount: 2,
      cpuMilli: 1500,
      memoryBytes: 805_306_368,
    });
    await db().insert(appStackRevisions).values(revision(revisionId, 1));
    if (input.desiredDiffers) await db().insert(appStackRevisions).values(revision(`${revisionId}_b`, 2));
    const applied = input.applied === false ? null : revisionId;
    await db()
      .update(appStacks)
      .set({ appliedRevisionId: applied, desiredRevisionId: input.desiredDiffers ? `${revisionId}_b` : revisionId })
      .where(eq(appStacks.id, id));
    const observedAt = input.observedAt === undefined ? at(-1) : input.observedAt;
    for (const componentKey of ["app", "cache"]) {
      await db()
        .insert(appStackComponents)
        .values({ stackId: id, organizationId: ORG, componentKey, health: "healthy", healthObservedAt: observedAt, appliedRevisionId: applied });
    }
    for (const [i, domain] of (input.domains ?? []).entries()) {
      await db()
        .insert(appStackDomains)
        .values({
          id: `sdom_obs_${String(counter)}_${String(i)}`,
          stackId: id,
          organizationId: ORG,
          componentKey: "app",
          internalPort: 8080,
          hostname: `h${String(counter)}-${String(i)}.example.com`,
          dnsNextCheckAt: at(60),
          ...domain,
        });
    }
    return { id, revisionId, plan };
  }

  async function insertOperation(
    stackId: string,
    status: "unknown" | "failed" | "succeeded",
    completedAt: Date | null,
    kind: "stack.deploy" | "stack.stop" = "stack.deploy",
  ) {
    counter += 1;
    await db()
      .insert(operations)
      .values({
        id: `op_obs_${String(counter)}`,
        organizationId: ORG,
        kind,
        status,
        resourceType: "stack",
        resourceId: stackId,
        lockKey: `stack:${stackId}`,
        submittedAt: at(-30),
        completedAt,
      });
  }

  const health = (stackId: string) =>
    db()
      .select({ componentKey: appStackComponents.componentKey, health: appStackComponents.health, healthObservedAt: appStackComponents.healthObservedAt })
      .from(appStackComponents)
      .where(eq(appStackComponents.stackId, stackId))
      .orderBy(appStackComponents.componentKey);
  const domainRow = async (hostname: string) =>
    (await db().select().from(appStackDomains).where(eq(appStackDomains.hostname, hostname)))[0]!;
  const deploys = (stackId: string) =>
    db().select().from(operations).where(and(eq(operations.resourceId, stackId), eq(operations.kind, "stack.deploy"), eq(operations.status, "queued")));
  // audit_events is append-only: every query is scoped to a target created by its own test.
  const audits = (targetId: string, action?: string) =>
    db()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, targetId), action === undefined ? undefined : eq(auditEvents.action, action)));

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await db().insert(platformInstallations).values({ id: "pin_obs", name: "Platform" });
    await db().insert(hosts).values({
      id: "hst_obs",
      platformInstallationId: "pin_obs",
      name: "obs-host",
      hostname: "panel.obs.test",
      ipv4Address: IPV4,
      totalCpuMilli: 4000,
      totalMemoryBytes: "4000000000",
      totalStorageBytes: "100000000000",
    });
    await db().insert(organizations).values({ id: ORG, platformInstallationId: "pin_obs", name: "Obs", slug: "obs" });
    await db().insert(hostAllocations).values({ id: ALLOC, hostId: "hst_obs", organizationId: ORG, status: "active" });
    await db().insert(appTemplates).values({ id: "atpl_obs", slug: "obs-notes", name: "Notes", category: "web" });
    await db().insert(appTemplateVersions).values({
      id: "atv_obs1",
      templateId: "atpl_obs",
      versionNumber: 1,
      source: "x",
      specVersion: 1,
      compiledSchema: {},
      specHash: "a".repeat(64),
    });
  }, 120_000);

  beforeEach(() => {
    calls = [];
    failing = new Set();
    onStatusRead = () => undefined;
    report = { acmeEnabled: true, trusted: true, readable: true, certificates: [], failures: [] };
    reportFails = false;
    answers = new Map();
    lookups = [];
    triggerAsync = vi.fn();
  });

  afterEach(async () => {
    await db().delete(appStacks);
    await db().delete(outboxEvents);
    await db().delete(operations);
  });

  afterAll(async () => {
    await client.close();
  });

  describe("health pass", () => {
    it("reads only running, degraded, failed and unknown stacks with no active operation, oldest observation first", async () => {
      const running = await seedStack({ status: "running", observedAt: at(-1) });
      const degraded = await seedStack({ status: "degraded", observedAt: at(-30) });
      const failed = await seedStack({ status: "failed", observedAt: null });
      const unknown = await seedStack({ status: "unknown", observedAt: at(-10) });
      const skipped = [
        await seedStack({ status: "stopped", observedAt: null }),
        await seedStack({ status: "draft", observedAt: null, applied: false }),
        await seedStack({ status: "updating", observedAt: null }),
        await seedStack({ status: "deleted", observedAt: null }),
      ];
      const locked = await seedStack({ status: "running", observedAt: null });
      await insertOperation(locked.id, "unknown", null);

      await observer().reconcileOnce(NOW);

      expect(statusReads()).toEqual([failed.id, degraded.id, unknown.id, running.id]);
      expect(await health(running.id)).toEqual([
        { componentKey: "app", health: "healthy", healthObservedAt: NOW },
        { componentKey: "cache", health: "stopped", healthObservedAt: NOW },
      ]);
      for (const stack of [...skipped, locked]) expect((await health(stack.id)).map((c) => c.healthObservedAt)).toEqual([null, null]);
      expect(mutatingCalls()).toEqual([]);
      expect((await db().select({ id: appStacks.id, status: appStacks.status }).from(appStacks).where(eq(appStacks.id, failed.id)))[0]!.status).toBe("failed");
    });

    it(`reads at most ${String(APP_STACK_OBSERVE_BATCH)} stacks per pass, so the next pass reaches the rest`, async () => {
      const stacks: Seeded[] = [];
      for (let i = 0; i < APP_STACK_OBSERVE_BATCH + 2; i += 1) stacks.push(await seedStack({ status: "running", observedAt: at(-60 + i) }));

      await observer().reconcileOnce(NOW);
      expect(statusReads()).toEqual(stacks.slice(0, APP_STACK_OBSERVE_BATCH).map((s) => s.id));

      calls = [];
      await observer().reconcileOnce(at(1));
      expect(statusReads()).toHaveLength(APP_STACK_OBSERVE_BATCH);
      expect(statusReads().slice(0, 2)).toEqual(stacks.slice(APP_STACK_OBSERVE_BATCH).map((s) => s.id));
    });

    it("starts no read once the pass has run for 45 seconds", async () => {
      const stacks = [await seedStack({ status: "running", observedAt: at(-3) }), await seedStack({ status: "running", observedAt: at(-2) })];
      await seedStack({ status: "running", observedAt: at(-1) });
      let clock = Date.now();
      const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
      onStatusRead = () => {
        clock += 30_000;
      };
      try {
        await observer().reconcileOnce(NOW);
      } finally {
        spy.mockRestore();
      }
      expect(statusReads()).toEqual(stacks.map((s) => s.id));
    });

    it("a failed read records every component unknown at the current time", async () => {
      const stack = await seedStack({ status: "running", observedAt: NOW });
      failing.add(stack.id);

      await observer().reconcileOnce(at(6));

      const rows = await health(stack.id);
      expect(rows).toEqual([
        { componentKey: "app", health: "unknown", healthObservedAt: at(6) },
        { componentKey: "cache", health: "unknown", healthObservedAt: at(6) },
      ]);
      expect(
        appStackDisplayStatus({ stack: { status: "running", appliedRoutesHash: null }, plan: stack.plan, components: rows, domainCount: 0, now: at(6) }),
      ).toBe("unknown");
      expect(mutatingCalls()).toEqual([]);
    });

    it("stacks whose reads keep failing do not starve the others: a healthy stack is read within two passes", async () => {
      for (let i = 0; i < 25; i += 1) failing.add((await seedStack({ status: "running", observedAt: null })).id);
      const healthy = await seedStack({ status: "running", observedAt: at(-1) });

      await observer().reconcileOnce(NOW);
      await observer().reconcileOnce(at(1));

      expect(statusReads()).toContain(healthy.id);
      expect(await health(healthy.id)).toEqual([
        { componentKey: "app", health: "healthy", healthObservedAt: at(1) },
        { componentKey: "cache", health: "stopped", healthObservedAt: at(1) },
      ]);
    });

    it("never selects a stack with no applied revision", async () => {
      const unapplied: Seeded[] = [];
      for (let i = 0; i < APP_STACK_OBSERVE_BATCH; i += 1) unapplied.push(await seedStack({ status: "failed", observedAt: null, applied: false }));
      const running = await seedStack({ status: "running", observedAt: at(-1) });

      await observer().reconcileOnce(NOW);

      expect(statusReads()).toEqual([running.id]);
      for (const stack of unapplied) expect((await health(stack.id)).map((c) => c.healthObservedAt)).toEqual([null, null]);
    });

    it("does nothing at all when the runtime is disabled", async () => {
      const stack = await seedStack({ status: "running", observedAt: null, domains: [{ hostname: "off.example.com", dnsNextCheckAt: at(-1) }] });

      await observer({ runtimeBackend: "disabled" }).reconcileOnce(NOW);

      expect(calls).toEqual([]);
      expect(lookups).toEqual([]);
      expect((await health(stack.id)).map((c) => c.healthObservedAt)).toEqual([null, null]);
      expect((await domainRow("off.example.com")).dnsStatus).toBe("unchecked");
      expect(await db().select().from(operations)).toEqual([]);
    });
  });

  describe("DNS pass", () => {
    it("looks up due addresses only: ok resets the attempts, points_elsewhere backs off", async () => {
      const stack = await seedStack({
        status: "stopped",
        domains: [
          { hostname: "ok.example.com", dnsNextCheckAt: at(-1), dnsStatus: "not_found", dnsAttempts: 2 },
          { hostname: "later.example.com", dnsNextCheckAt: at(5) },
          { hostname: "away.example.com", dnsNextCheckAt: at(-1), dnsAttempts: 1 },
        ],
      });
      answers.set("away.example.com", { a: ["203.0.113.9"], aaaa: [] });

      await observer().reconcileOnce(NOW);

      expect(lookups).toEqual(["away.example.com", "ok.example.com"]);
      expect(await domainRow("ok.example.com")).toMatchObject({
        dnsStatus: "ok",
        dnsAttempts: 0,
        dnsCheckedAt: NOW,
        dnsNextCheckAt: nextDnsCheckAt(NOW, "ok", 2),
        dnsObserved: { a: [IPV4], aaaa: [] },
      });
      expect(await domainRow("away.example.com")).toMatchObject({
        dnsStatus: "points_elsewhere",
        dnsAttempts: 2,
        dnsNextCheckAt: nextDnsCheckAt(NOW, "points_elsewhere", 1),
      });
      expect(await domainRow("later.example.com")).toMatchObject({ dnsStatus: "unchecked", dnsCheckedAt: null });

      lookups = [];
      const later = await domainRow("later.example.com");
      await observer().reconcileStack(ORG, stack.id, NOW, { forceDnsIds: [later.id] });
      expect(lookups).toEqual(["later.example.com"]);
    });
  });

  describe("certificate pass", () => {
    it("requests a certificate only for an active address with DNS ok while ACME is on", async () => {
      await seedStack({
        status: "stopped",
        domains: [
          { hostname: "go.example.com", status: "active", dnsStatus: "ok" },
          { hostname: "pending.example.com", dnsStatus: "ok" },
          { hostname: "nodns.example.com", status: "active", dnsStatus: "not_found" },
        ],
      });

      await observer().reconcileOnce(NOW);

      const go = await domainRow("go.example.com");
      expect(go).toMatchObject({ certStatus: "requested", certRequestedAt: NOW });
      expect((await domainRow("pending.example.com")).certStatus).toBe("none");
      expect((await domainRow("nodns.example.com")).certStatus).toBe("none");
      expect(await audits(go.id)).toMatchObject([
        {
          action: "site.certificate.requested",
          actorType: "system",
          actorId: null,
          organizationId: ORG,
          targetType: "app_stack_domain",
          targetId: go.id,
          details: { hostname: "go.example.com", challenge: "http-01" },
        },
      ]);

      await seedStack({ status: "stopped", domains: [{ hostname: "noacme.example.com", status: "active", dnsStatus: "ok" }] });
      report = { ...report, acmeEnabled: false };
      await observer().reconcileOnce(NOW);
      expect((await domainRow("noacme.example.com")).certStatus).toBe("none");
    });

    it("a requested address becomes active when the report holds its certificate", async () => {
      await seedStack({
        status: "stopped",
        domains: [{ hostname: "tls.example.com", status: "active", dnsStatus: "ok", certStatus: "requested", certRequestedAt: at(-2) }],
      });
      report = { ...report, certificates: [{ hostname: "tls.example.com", notAfter: "2027-02-20T00:00:00.000Z", serialNumber: "0a" }] };

      await observer().reconcileOnce(NOW);

      const row = await domainRow("tls.example.com");
      expect(row).toMatchObject({ certStatus: "active", certExpiresAt: new Date("2027-02-20T00:00:00.000Z"), certAttempts: 0, certProblem: null });
      expect(await audits(row.id, "site.certificate.issued")).toMatchObject([
        { targetType: "app_stack_domain", targetId: row.id, details: { hostname: "tls.example.com", serialNumber: "0a" } },
      ]);
    });

    it("a reported failure fails the address and writes a redacted site.certificate.failed row", async () => {
      await seedStack({
        status: "stopped",
        domains: [{ hostname: "bad.example.com", status: "active", dnsStatus: "ok", certStatus: "requested", certRequestedAt: at(-2) }],
      });
      report = {
        ...report,
        failures: [{ hostname: "bad.example.com", at: at(-1).toISOString(), kind: "obtain", problem: "not_pointing", detail: "refused Bearer abc.def-123" }],
      };

      await observer().reconcileOnce(NOW);

      const row = await domainRow("bad.example.com");
      expect(row).toMatchObject({ certStatus: "failed", certProblem: "not_pointing", certAttempts: 1, certRetryAt: certRetryAt(NOW, "not_pointing", 0) });
      const [failed] = await audits(row.id, "site.certificate.failed");
      expect(failed).toMatchObject({
        actorType: "system",
        organizationId: ORG,
        targetType: "app_stack_domain",
        targetId: row.id,
        details: { hostname: "bad.example.com", problem: "not_pointing", challenge: "http-01" },
      });
      expect(JSON.stringify(failed!.details)).not.toContain("abc.def-123");
    });

    it("an unreadable report moves nothing", async () => {
      await seedStack({
        status: "stopped",
        domains: [{ hostname: "store.example.com", status: "active", dnsStatus: "ok", certStatus: "requested", certRequestedAt: at(-30) }],
      });
      report = {
        ...report,
        readable: false,
        certificates: [{ hostname: "store.example.com", notAfter: "2027-02-20T00:00:00.000Z", serialNumber: "0b" }],
      };

      await observer().reconcileOnce(NOW);

      const row = await domainRow("store.example.com");
      expect(row).toMatchObject({ certStatus: "requested", certRequestedAt: at(-30), certExpiresAt: null });
      expect(await audits(row.id)).toEqual([]);
    });
  });

  describe("route refresh", () => {
    it("a new address on a running stack queues exactly one system deploy of the applied revision, and the next pass none", async () => {
      const stack = await seedStack({ status: "running", domains: [{ hostname: "new.example.com" }] });

      await observer().reconcileOnce(NOW);

      const [op, ...more] = await deploys(stack.id);
      expect(more).toEqual([]);
      expect(op).toMatchObject({ requestedByUserId: null, resourceType: "stack", lockKey: `stack:${stack.id}` });
      expect(op!.idempotencyKey).toMatch(/^sys_routes_[0-9a-f]{32}$/);
      const [deployment] = await db().select().from(appStackDeployments).where(eq(appStackDeployments.operationId, op!.id));
      expect(deployment!.revisionId).toBe(stack.revisionId);
      expect(await db().select({ id: appStackRevisions.id }).from(appStackRevisions).where(eq(appStackRevisions.stackId, stack.id))).toHaveLength(1);
      const [row] = await db().select().from(appStacks).where(eq(appStacks.id, stack.id));
      expect(row).toMatchObject({ status: "updating", appliedRevisionId: stack.revisionId, desiredRevisionId: stack.revisionId });
      expect(await audits(stack.id, "app.stack.deploy")).toMatchObject([
        {
          actorType: "system",
          actorId: null,
          organizationId: ORG,
          targetType: "app_stack",
          targetId: stack.id,
          details: {
            operationId: op!.id,
            deploymentId: deployment!.id,
            revisionId: stack.revisionId,
            templateVersionId: "atv_obs1",
            status: "updating",
            trigger: "routes",
          },
        },
      ]);
      expect(triggerAsync).toHaveBeenCalledTimes(1);
      expect(mutatingCalls()).toEqual([]);

      await observer().reconcileOnce(NOW);
      expect(await deploys(stack.id)).toHaveLength(1);
      expect(triggerAsync).toHaveBeenCalledTimes(1);
    });

    it("queues nothing while the published routes match the addresses", async () => {
      const stack = await seedStack({ status: "degraded", domains: [{ hostname: "same.example.com" }] });
      const rows = await db().select().from(appStackDomains).where(eq(appStackDomains.stackId, stack.id));
      const { entries } = appStackRoutePlan({ plan: stack.plan, domains: rows, include: new Set(["app"]), now: NOW, acmeEnabled: true });
      await db().update(appStacks).set({ appliedRoutesHash: appStackRoutesHash(entries) }).where(eq(appStacks.id, stack.id));

      await observer().reconcileOnce(NOW);

      expect(await db().select().from(operations)).toEqual([]);
      expect(triggerAsync).not.toHaveBeenCalled();
    });

    it("withdraws the last removed address without a certificate report; stacks with addresses wait for one", async () => {
      reportFails = true;
      const removed = await seedStack({ status: "running", routesHash: "f".repeat(64) });
      const waiting = await seedStack({ status: "running", domains: [{ hostname: "wait.example.com" }] });

      await observer().reconcileOnce(NOW);

      expect(await deploys(removed.id)).toHaveLength(1);
      expect(await deploys(waiting.id)).toEqual([]);
    });

    it("queues none for stopped or failed stacks, nor when the desired revision differs from the applied one", async () => {
      await seedStack({ status: "stopped", domains: [{ hostname: "stopped.example.com" }] });
      await seedStack({ status: "failed", domains: [{ hostname: "failed.example.com" }] });
      await seedStack({ status: "running", desiredDiffers: true, domains: [{ hostname: "upgrade.example.com" }] });

      await observer().reconcileOnce(NOW);

      expect(await db().select().from(operations)).toEqual([]);
      expect(triggerAsync).not.toHaveBeenCalled();
    });

    it("backs off for 10 minutes after a failed operation", async () => {
      const stack = await seedStack({ status: "running", domains: [{ hostname: "retry.example.com" }] });
      await insertOperation(stack.id, "failed", at(-5));

      await observer().reconcileOnce(NOW);
      expect(await deploys(stack.id)).toEqual([]);

      await observer().reconcileOnce(at(6));
      expect(await deploys(stack.id)).toHaveLength(1);
    });

    it("never undoes a stop: a stop that failed after unpublish or that recovery settled as degraded gets no deploy on any later pass", async () => {
      const failedStop = await seedStack({ status: "degraded", domains: [{ hostname: "failed-stop.example.com" }] });
      await insertOperation(failedStop.id, "failed", at(-5), "stack.stop");
      const recoveredStop = await seedStack({ status: "degraded", domains: [{ hostname: "recovered-stop.example.com" }] });
      await insertOperation(recoveredStop.id, "succeeded", at(-5), "stack.stop");

      for (const now of [NOW, at(11), at(120)]) await observer().reconcileOnce(now);

      expect(await db().select().from(operations).where(eq(operations.kind, "stack.deploy"))).toEqual([]);
      expect(triggerAsync).not.toHaveBeenCalled();
    });
  });
});
