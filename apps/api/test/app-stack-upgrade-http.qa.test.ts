// Q6 · plan, upgrade and rollback refusals through HTTP (arch-api §9.6–§9.8, §12.1): every refusal answers 400 with its
// field and reason and leaves every table count, the stack row and its revisions exactly as they were; the plan is a
// pure read that answers the same JSON twice.
import { randomUUID } from "node:crypto";
import { APP_IMAGE_ALLOWLIST, type AppImageAllowlistEntry } from "@hosting-panel/contracts";
import {
  addAppStackDomainsTransactional,
  and,
  appStackRevisions,
  appStacks,
  asc,
  auditEvents,
  eq,
  operations,
  resourceQuotas,
} from "@hosting-panel/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_TEST_ALLOWLIST, NOTES_DEMO_SOURCE, startAppStackHarness, type AppStackHarness } from "./fixtures/app-stack-harness.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Reply = Awaited<ReturnType<AppStackHarness["call"]>>;

/** v2: the web component asks for more memory. Same components, same web address. */
const NOTES_V2 = NOTES_DEMO_SOURCE.replace("memory: 512M", "memory: 768M");
/** v3: same again, a little more. */
const NOTES_V3 = NOTES_DEMO_SOURCE.replace("memory: 512M", "memory: 896M");
/** The component a web address targets is renamed: `app` no longer exists, `web` does. */
const NOTES_RENAMED = NOTES_DEMO_SOURCE.replace("  app:\n", "  web:\n").replace("    service: app\n", "    service: web\n").replace(
  "service: app\n    port: 8080",
  "service: web\n    port: 8080",
);
/** The cache answers on the web too: two entry points, app:8080 and cache:6379 (ADR-0037 path rules). */
const NOTES_TWO_DOORS = `${NOTES_DEMO_SOURCE.replace(
  "      - 6379\n    deploy:",
  "      - 6379\n    healthcheck:\n      kind: tcp\n      port: 6379\n      intervalSeconds: 15\n      timeoutSeconds: 3\n    deploy:",
)}  - service: cache\n    port: 6379\n    protocol: http\n`;
const OTHER_HASH = "0".repeat(64);
const MISSING_VERSION = `atv_${"0".repeat(24)}`;
const MISSING_REVISION = `srev_${"0".repeat(24)}`;

function expectRefusal(res: Reply, status: number, code: string, detail?: Json): void {
  expect(res.status, res.raw).toBe(status);
  expect(res.body.error.code).toBe(code);
  if (detail) expect(res.body.error.details).toContainEqual(expect.objectContaining(detail));
}

describe("application stack plan, upgrade and rollback refusals over HTTP (QA M5, Q6)", () => {
  let h: AppStackHarness;
  let otherTemplateVersion: string;
  /** Mutable: a case changes what the panel allows and puts it back. */
  const allowlist: AppImageAllowlistEntry[] = [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST];

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist });
    for (const c of [h.a, h.b]) {
      await h.dbClient.db
        .update(resourceQuotas)
        .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
        .where(eq(resourceQuotas.organizationId, c.orgId));
    }
    otherTemplateVersion = (await h.publish()).versionId;
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  const path = (stackId: string, verb: string, orgId: string = h.a.orgId) => `/v1/organizations/${orgId}/app-stacks/${stackId}/${verb}`;
  const plan = (stackId: string, body: unknown) => h.call(h.a.token, "POST", path(stackId, "plan"), body);
  const queue = (stackId: string, verb: "upgrade" | "rollback", body: unknown) =>
    h.call(h.a.token, "POST", path(stackId, verb), body, { "Idempotency-Key": randomUUID() });
  const upgrade = (stackId: string, templateVersionId: string, planHash: string = OTHER_HASH, extra: Json = {}) =>
    queue(stackId, "upgrade", { templateVersionId, planHash, ...extra });
  const rollback = (stackId: string, revisionId: string, planHash: string) => queue(stackId, "rollback", { revisionId, planHash });
  const revisions = (stackId: string) =>
    h.dbClient.db.select().from(appStackRevisions).where(eq(appStackRevisions.stackId, stackId)).orderBy(asc(appStackRevisions.revisionNumber));
  const stackRow = async (stackId: string) => (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  const auditCount = async (action: string, targetId: string) =>
    (await h.dbClient.db.select().from(auditEvents).where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, targetId)))).length;

  /** A new default version: only the default version can be installed or upgraded to. */
  async function addVersion(templateId: string, source: string): Promise<string> {
    const res = await h.call(h.adminToken, "POST", `/v1/admin/app-templates/${templateId}/versions`, { source, makeDefault: true });
    expect(res.status, res.raw).toBe(201);
    return res.body.data.versionId as string;
  }

  /** A notes stack on `versionId` with its secret set, revision 1 queued and settled as running without the runtime. */
  async function running(versionId: string): Promise<string> {
    const res = await h.call(
      h.a.token,
      "POST",
      `/v1/organizations/${h.a.orgId}/app-stacks`,
      { templateVersionId: versionId, name: `app-${randomUUID().slice(0, 8)}`, deploy: false },
      { "Idempotency-Key": randomUUID() },
    );
    expect(res.status, res.raw).toBe(201);
    const stackId = res.body.data.stackId as string;
    await setSecret(stackId, "first-value");
    const deploy = await h.call(h.a.token, "POST", path(stackId, "deploy"), {}, { "Idempotency-Key": randomUUID() });
    expect(deploy.status, deploy.raw).toBe(202);
    await settle(stackId);
    return stackId;
  }

  async function setSecret(stackId: string, value: string): Promise<void> {
    const res = await h.call(h.a.token, "POST", path(stackId, "secrets"), { parameterKey: "app_secret", value });
    expect(res.status, res.raw).toBe(200);
  }

  async function settle(stackId: string): Promise<void> {
    await h.dbClient.db.update(operations).set({ status: "succeeded" }).where(eq(operations.resourceId, stackId));
    await h.dbClient.db.update(appStacks).set({ status: "running" }).where(eq(appStacks.id, stackId));
  }

  /** What a refusal must leave untouched: every table count, the stack row, its revisions. */
  async function snapshot(stackId: string) {
    return { counts: await h.counts(), stack: await stackRow(stackId), revisions: await revisions(stackId) };
  }

  /** A stack on v1 of its own template, upgraded to v2 and settled: revisions 1 and 2, v2 desired and the default. */
  async function upgraded(): Promise<{ templateId: string; v1: string; v2: string; stackId: string; rev1: Json; rev2: Json }> {
    const { templateId, versionId: v1 } = await h.publish();
    const stackId = await running(v1);
    const v2 = await addVersion(templateId, NOTES_V2);
    const diff = await plan(stackId, { templateVersionId: v2 });
    expect(diff.status, diff.raw).toBe(200);
    expect((await upgrade(stackId, v2, diff.body.data.planHash as string)).status).toBe(202);
    await settle(stackId);
    const [rev1, rev2] = await revisions(stackId);
    expect(rev2).toMatchObject({ revisionNumber: 2, templateVersionId: v2 });
    return { templateId, v1, v2, stackId, rev1: rev1!, rev2: rev2! };
  }

  describe("upgrade and plan with a version that cannot be the target", () => {
    it("an unknown id, a version of another template, the current version and an older one are refused, writing nothing", async () => {
      const { templateId, versionId: v1 } = await h.publish();
      const onV1 = await running(v1);
      const v2 = await addVersion(templateId, NOTES_V2);
      const onV2 = await running(v2);
      const cases: readonly (readonly [string, string, string, string, string])[] = [
        // [label, stack, target version, field, reason]
        ["well-formed id that does not exist", onV1, MISSING_VERSION, "templateVersionId", "unknown_version"],
        ["a version of another template", onV1, otherTemplateVersion, "templateVersionId", "unknown_version"],
        ["the version the stack runs", onV1, v1, "templateVersionId", "not_newer"],
        ["an older version", onV2, v1, "templateVersionId", "not_newer"],
        ["the version the stack runs (newest)", onV2, v2, "templateVersionId", "not_newer"],
      ];
      for (const [label, stackId, target, field, reason] of cases) {
        const before = await snapshot(stackId);
        const refused = await upgrade(stackId, target);
        expectRefusal(refused, 400, "VALIDATION_ERROR", { field, reason });
        // The current version is not an upgrade: its plan is the plan of the stack itself (arch-api §9.8).
        if (target === (await stackRow(stackId)).templateVersionId) {
          const same = await plan(stackId, { templateVersionId: target });
          expect(same.status, same.raw).toBe(200);
          expect(same.body.data.newRevision).toBe(false);
        } else {
          expectRefusal(await plan(stackId, { templateVersionId: target }), 400, "VALIDATION_ERROR", { field, reason });
        }
        expect(await snapshot(stackId), label).toEqual(before);
        expect(await auditCount("app.stack.upgrade", stackId), label).toBe(0);
      }
      // The refusal for another template's version does not say whose version it is.
      const foreign = await upgrade(onV1, otherTemplateVersion);
      expect(foreign.raw).not.toContain(otherTemplateVersion);
      const missing = await upgrade(onV1, MISSING_VERSION);
      expect(foreign.body.error).toEqual({ ...missing.body.error, requestId: foreign.body.error.requestId });
    });

    it("a malformed body is a validation error before anything is looked up", async () => {
      const { templateId, versionId: v1 } = await h.publish();
      const stackId = await running(v1);
      const v2 = await addVersion(templateId, NOTES_V2);
      const before = await snapshot(stackId);
      const hash = "a".repeat(64);
      const bodies: readonly unknown[] = [
        {},
        { templateVersionId: v2 },
        { planHash: hash },
        { templateVersionId: v2, planHash: "not-a-hash" },
        { templateVersionId: v2, planHash: hash.toUpperCase() },
        { templateVersionId: "not an id", planHash: hash },
        { templateVersionId: v2, planHash: hash, force: true },
        "{not json",
      ];
      for (const body of bodies) expectRefusal(await queue(stackId, "upgrade", body), 400, "VALIDATION_ERROR");
      const planBodies: readonly unknown[] = [
        { templateVersionId: v2, revisionId: MISSING_REVISION },
        { revisionId: MISSING_REVISION, parameters: [] },
        { templateVersionId: "not an id" },
        { extra: 1 },
      ];
      for (const body of planBodies) expectRefusal(await plan(stackId, body), 400, "VALIDATION_ERROR");
      expect(await snapshot(stackId)).toEqual(before);
    });
  });

  describe("the plan changed since the customer saw it", () => {
    it("upgrade: other parameters, a rotated secret, the hash of another preview or a stale hash are plan_changed; the fresh hash is accepted", async () => {
      const { templateId, versionId: v1 } = await h.publish();
      const stackId = await running(v1);
      const v2 = await addVersion(templateId, NOTES_V2);
      const seen = await plan(stackId, { templateVersionId: v2, parameters: [{ key: "worker_count", value: 3 }] });
      expect(seen.status, seen.raw).toBe(200);
      const hash = seen.body.data.planHash as string;
      const otherParametersHash = (await plan(stackId, { templateVersionId: v2, parameters: [{ key: "worker_count", value: 1 }] })).body.data
        .planHash as string;
      expect(otherParametersHash).not.toBe(hash);

      const planChanged = { field: "planHash", reason: "plan_changed" };
      let before = await snapshot(stackId);
      // The customer reviewed worker_count 3 and the request carries 4.
      expectRefusal(await upgrade(stackId, v2, hash, { parameters: [{ key: "worker_count", value: 4 }] }), 400, "VALIDATION_ERROR", planChanged);
      // The customer reviewed worker_count 1 and the request carries 3.
      expectRefusal(await upgrade(stackId, v2, otherParametersHash, { parameters: [{ key: "worker_count", value: 3 }] }), 400, "VALIDATION_ERROR", planChanged);
      // The hash of the revision running now does not confirm an upgrade.
      expectRefusal(await upgrade(stackId, v2, (await revisions(stackId))[0]!.planHash), 400, "VALIDATION_ERROR", planChanged);
      expectRefusal(await upgrade(stackId, v2, OTHER_HASH, { parameters: [{ key: "worker_count", value: 3 }] }), 400, "VALIDATION_ERROR", planChanged);
      expect(await snapshot(stackId)).toEqual(before);

      // A secret rotated after the customer saw the plan changes the plan.
      await setSecret(stackId, "second-value");
      before = await snapshot(stackId);
      const stale = await upgrade(stackId, v2, hash, { parameters: [{ key: "worker_count", value: 3 }] });
      expectRefusal(stale, 400, "VALIDATION_ERROR", planChanged);
      expect(stale.raw).not.toContain("second-value");
      expect(await snapshot(stackId)).toEqual(before);
      expect(await auditCount("app.stack.upgrade", stackId)).toBe(0);

      // Reviewing again gives a hash that is accepted, once.
      const fresh = await plan(stackId, { templateVersionId: v2, parameters: [{ key: "worker_count", value: 3 }] });
      expect(fresh.body.data.planHash).not.toBe(hash);
      const done = await upgrade(stackId, v2, fresh.body.data.planHash as string, { parameters: [{ key: "worker_count", value: 3 }] });
      expect(done.status, done.raw).toBe(202);
      expect(await auditCount("app.stack.upgrade", stackId)).toBe(1);
      expect((await revisions(stackId)).map((r) => r.revisionNumber)).toEqual([1, 2]);
    });

    it("rollback: another hash, the hash of the current revision or of an upgrade preview are plan_changed", async () => {
      const { templateId, stackId, rev1, rev2 } = await upgraded();
      const v3 = await addVersion(templateId, NOTES_V3);
      const upgradePreview = (await plan(stackId, { templateVersionId: v3 })).body.data.planHash as string;
      const before = await snapshot(stackId);
      const planChanged = { field: "planHash", reason: "plan_changed" };
      for (const hash of [OTHER_HASH, rev2.planHash as string, upgradePreview, "f".repeat(64)]) {
        expectRefusal(await rollback(stackId, rev1.id as string, hash), 400, "VALIDATION_ERROR", planChanged);
      }
      expect(await snapshot(stackId)).toEqual(before);
      expect(await auditCount("app.stack.rollback", stackId)).toBe(0);
      // The hash of the revision being restored is the one that confirms it.
      const done = await rollback(stackId, rev1.id as string, rev1.planHash as string);
      expect(done.status, done.raw).toBe(202);
      expect(await auditCount("app.stack.rollback", stackId)).toBe(1);
    });
  });

  describe("rollback to a revision that cannot be restored", () => {
    it("an unknown revision, one of another stack or organisation, and the current revision are refused, writing nothing", async () => {
      const { v1, stackId, rev1, rev2 } = await upgraded();
      const other = await running((await h.publish()).versionId);
      const [otherRevision] = await revisions(other);
      const before = await snapshot(stackId);
      const cases: readonly (readonly [string, string, string, string])[] = [
        // [label, revision, hash, reason]
        ["well-formed id that does not exist", MISSING_REVISION, rev1.planHash as string, "unknown_revision"],
        ["a revision of another stack", otherRevision!.id, otherRevision!.planHash, "unknown_revision"],
        ["a template version id", v1, rev1.planHash as string, "unknown_revision"],
        ["the current revision", rev2.id as string, rev2.planHash as string, "already_current"],
        ["the current revision with a wrong hash", rev2.id as string, OTHER_HASH, "already_current"],
      ];
      for (const [label, revisionId, hash, reason] of cases) {
        expectRefusal(await rollback(stackId, revisionId, hash), 400, "VALIDATION_ERROR", { field: "revisionId", reason });
        if (reason !== "already_current" || label === "the current revision") {
          expectRefusal(await plan(stackId, { revisionId }), 400, "VALIDATION_ERROR", { field: "revisionId", reason });
        }
        expect(await snapshot(stackId), label).toEqual(before);
      }
      // A revision of an organisation that does not own the stack is a 404 of the stack, not a hint about the revision.
      const foreign = await h.call(h.b.token, "POST", path(stackId, "rollback", h.b.orgId), { revisionId: rev1.id, planHash: rev1.planHash }, {
        "Idempotency-Key": randomUUID(),
      });
      expectRefusal(foreign, 404, "NOT_FOUND");
      expect(foreign.raw).not.toContain(rev1.id as string);
      expect(await snapshot(stackId)).toEqual(before);
      expect(await auditCount("app.stack.rollback", stackId)).toBe(0);
    });

    it("software that left the allowlist is STACK_IMAGE_NOT_ALLOWED on plan and rollback, and the same rollback works once it is allowed again", async () => {
      const { stackId, rev1 } = await upgraded();
      const app = allowlist.findIndex((entry) => entry.repository === "registry.example.invalid/demo/app");
      expect(app).toBeGreaterThanOrEqual(0);
      const saved = [...allowlist];
      const before = await snapshot(stackId);
      const notAllowed = { field: "revisionId", reason: "STACK_IMAGE_NOT_ALLOWED" };
      try {
        // The repository stays listed but must now run as another user.
        allowlist[app] = { ...allowlist[app]!, runAsUser: "1000:1000" };
        const refused = await rollback(stackId, rev1.id as string, rev1.planHash as string);
        expectRefusal(refused, 400, "VALIDATION_ERROR", notAllowed);
        expect(refused.body.error.details).toContainEqual(
          expect.objectContaining({ message: "A component of that revision uses software that is no longer allowed." }),
        );
        expectRefusal(await plan(stackId, { revisionId: rev1.id }), 400, "VALIDATION_ERROR", notAllowed);
        // A wrong hash does not turn the refusal into plan_changed: the software is judged first.
        expectRefusal(await rollback(stackId, rev1.id as string, OTHER_HASH), 400, "VALIDATION_ERROR", notAllowed);
        expect(await snapshot(stackId)).toEqual(before);
        expect(await auditCount("app.stack.rollback", stackId)).toBe(0);
      } finally {
        allowlist.splice(0, allowlist.length, ...saved);
      }
      const done = await rollback(stackId, rev1.id as string, rev1.planHash as string);
      expect(done.status, done.raw).toBe(202);
    });
  });

  describe("a component a web address targets", () => {
    it("an upgrade that removes it is domain_target_removed on plan and upgrade, and is accepted once the address is gone", async () => {
      const { templateId, versionId: first } = await h.publish();
      const stackId = await running(first);
      const renamed = await addVersion(templateId, NOTES_RENAMED);
      const hash = (await plan(stackId, { templateVersionId: renamed })).body.data.planHash as string;
      expect(typeof hash).toBe("string");
      const [domain] = await addAppStackDomainsTransactional(h.dbClient.db, {
        organizationId: h.a.orgId,
        stackId,
        entries: [{ hostname: `${randomUUID().slice(0, 8)}.removed.example.test`, componentKey: "app", internalPort: 8080 }],
      });
      expect(domain).toBeDefined();
      const before = await snapshot(stackId);
      const removed = { field: "domains", reason: "domain_target_removed" };
      expectRefusal(await upgrade(stackId, renamed, hash), 400, "VALIDATION_ERROR", removed);
      expectRefusal(await plan(stackId, { templateVersionId: renamed }), 400, "VALIDATION_ERROR", removed);
      expect(await snapshot(stackId)).toEqual(before);
      expect(await auditCount("app.stack.upgrade", stackId)).toBe(0);

      const del = await h.call(h.a.token, "DELETE", `/v1/organizations/${h.a.orgId}/app-stacks/${stackId}/domains/${domain!.id}`);
      expect(del.status, del.raw).toBeLessThan(300);
      const fresh = await plan(stackId, { templateVersionId: renamed });
      expect(fresh.status, fresh.raw).toBe(200);
      expect(fresh.body.data.ingress).toContainEqual(expect.objectContaining({ componentKey: "web", change: "added" }));
      expect((await upgrade(stackId, renamed, fresh.body.data.planHash as string)).status).toBe(202);
    });

    it("a rollback to a revision that no longer has the component is domain_target_removed on plan and rollback", async () => {
      const own = await h.publish();
      const stackId = await running(own.versionId);
      const renamed = await addVersion(own.templateId, NOTES_RENAMED);
      const diff = await plan(stackId, { templateVersionId: renamed });
      expect((await upgrade(stackId, renamed, diff.body.data.planHash as string)).status).toBe(202);
      await settle(stackId);
      const [rev1, rev2] = await revisions(stackId);
      expect(rev2).toMatchObject({ revisionNumber: 2, templateVersionId: renamed });
      // The address now targets `web`; revision 1 only has `app`.
      await addAppStackDomainsTransactional(h.dbClient.db, {
        organizationId: h.a.orgId,
        stackId,
        entries: [{ hostname: `${randomUUID().slice(0, 8)}.back.example.test`, componentKey: "web", internalPort: 8080 }],
      });
      const before = await snapshot(stackId);
      const removed = { field: "domains", reason: "domain_target_removed" };
      expectRefusal(await rollback(stackId, rev1!.id, rev1!.planHash), 400, "VALIDATION_ERROR", removed);
      expectRefusal(await plan(stackId, { revisionId: rev1!.id }), 400, "VALIDATION_ERROR", removed);
      expect(await snapshot(stackId)).toEqual(before);
      expect(await auditCount("app.stack.rollback", stackId)).toBe(0);
    });
  });

  describe("an entry point a path of a web address sends requests to (ADR-0037)", () => {
    const CACHE_PATH = { pathPrefix: "/cache", componentKey: "cache", port: 6379, stripPrefix: false };
    const removed = { field: "domains", reason: "path_target_removed" };
    const domainsPath = (stackId: string) => `/v1/organizations/${h.a.orgId}/app-stacks/${stackId}/domains`;

    /** An address on app:8080 whose one path goes to cache:6379; returns its id. */
    async function withCachePath(stackId: string): Promise<string> {
      const added = await h.call(h.a.token, "POST", domainsPath(stackId), { hostname: `${randomUUID().slice(0, 8)}.path.example.test`, componentKey: "app", port: 8080 });
      expect(added.status, added.raw).toBe(201);
      const id = (added.body.data as Json[])[0]!.id as string;
      const set = await h.call(h.a.token, "PATCH", `${domainsPath(stackId)}/${id}`, { redirectToDomainId: null, compression: false, protection: null, pathRoutes: [CACHE_PATH] });
      expect(set.status, set.raw).toBe(200);
      return id;
    }

    it("an upgrade that drops it is path_target_removed on plan and upgrade, and is accepted once the path is gone", async () => {
      const { templateId, versionId } = await h.publish(NOTES_TWO_DOORS);
      const stackId = await running(versionId);
      const oneDoor = await addVersion(templateId, NOTES_V2);
      const hash = (await plan(stackId, { templateVersionId: oneDoor })).body.data.planHash as string;
      expect(typeof hash).toBe("string");
      const id = await withCachePath(stackId);
      const before = await snapshot(stackId);
      expectRefusal(await upgrade(stackId, oneDoor, hash), 400, "VALIDATION_ERROR", removed);
      expectRefusal(await plan(stackId, { templateVersionId: oneDoor }), 400, "VALIDATION_ERROR", removed);
      expect(await snapshot(stackId)).toEqual(before);
      expect(await auditCount("app.stack.upgrade", stackId)).toBe(0);

      const cleared = await h.call(h.a.token, "PATCH", `${domainsPath(stackId)}/${id}`, { redirectToDomainId: null, compression: false, protection: null, pathRoutes: [] });
      expect(cleared.status, cleared.raw).toBe(200);
      const fresh = await plan(stackId, { templateVersionId: oneDoor });
      expect(fresh.status, fresh.raw).toBe(200);
      expect((await upgrade(stackId, oneDoor, fresh.body.data.planHash as string)).status).toBe(202);
    });

    it("a rollback to a revision without it is path_target_removed on plan and rollback", async () => {
      const own = await h.publish();
      const stackId = await running(own.versionId);
      const twoDoors = await addVersion(own.templateId, NOTES_TWO_DOORS);
      const diff = await plan(stackId, { templateVersionId: twoDoors });
      expect((await upgrade(stackId, twoDoors, diff.body.data.planHash as string)).status).toBe(202);
      await settle(stackId);
      const [rev1] = await revisions(stackId);
      await withCachePath(stackId);
      const before = await snapshot(stackId);
      expectRefusal(await rollback(stackId, rev1!.id, rev1!.planHash), 400, "VALIDATION_ERROR", removed);
      expectRefusal(await plan(stackId, { revisionId: rev1!.id }), 400, "VALIDATION_ERROR", removed);
      expect(await snapshot(stackId)).toEqual(before);
      expect(await auditCount("app.stack.rollback", stackId)).toBe(0);
    });
  });

  describe("the plan is a pure read", () => {
    it("two calls give byte-identical JSON for every kind of preview and write nothing, with or without an Idempotency-Key", async () => {
      const { templateId, stackId, rev1 } = await upgraded();
      let before = await snapshot(stackId);
      const hashes = new Set<string>();
      const check = async (label: string, body: Json): Promise<string> => {
        const first = await plan(stackId, body);
        expect(first.status, `${label}: ${first.raw}`).toBe(200);
        const second = await plan(stackId, body);
        const keyed = await h.call(h.a.token, "POST", path(stackId, "plan"), body, { "Idempotency-Key": randomUUID() });
        expect(second.raw, label).toBe(first.raw);
        expect(keyed.raw, label).toBe(first.raw);
        expect(second.body, label).toEqual(first.body);
        expect(first.body.data.planHash, label).toMatch(/^[0-9a-f]{64}$/);
        hashes.add(first.body.data.planHash as string);
        expect(await snapshot(stackId), label).toEqual(before);
        return first.raw;
      };
      await check("the desired revision", {});
      await check("the desired revision with its parameters", { parameters: [{ key: "worker_count", value: 2 }] });
      await check("a rollback", { revisionId: rev1.id });
      // A newer default version makes the upgrade previews possible (and the running one no longer installable).
      const v3 = await addVersion(templateId, NOTES_V3);
      before = await snapshot(stackId);
      const upgradeBody = { templateVersionId: v3 };
      await check("an upgrade", upgradeBody);
      await check("an upgrade with new parameters", { templateVersionId: v3, parameters: [{ key: "worker_count", value: 4 }] });
      // A refusal in between does not change the answer of the next call.
      const again = await plan(stackId, upgradeBody);
      expectRefusal(await plan(stackId, { templateVersionId: MISSING_VERSION }), 400, "VALIDATION_ERROR");
      expect((await plan(stackId, upgradeBody)).raw).toBe(again.raw);
      // Different candidates are different plans.
      expect(hashes.size).toBeGreaterThanOrEqual(3);
      expect(await auditCount("app.stack.upgrade", stackId)).toBe(1);
    });

    it("the plan of another organisation's stack is 404 and reveals nothing", async () => {
      const { templateId, versionId: v1 } = await h.publish();
      const stackId = await running(v1);
      const v2 = await addVersion(templateId, NOTES_V2);
      const before = await snapshot(stackId);
      for (const body of [{}, { templateVersionId: v2 }, { revisionId: (await revisions(stackId))[0]!.id }]) {
        const res = await h.call(h.b.token, "POST", path(stackId, "plan", h.b.orgId), body);
        expectRefusal(res, 404, "NOT_FOUND");
        expect(res.body.error.message).toBe("Requested organization or resource was not found.");
        const up = await h.call(h.b.token, "POST", path(stackId, "upgrade", h.b.orgId), { templateVersionId: v2, planHash: OTHER_HASH }, {
          "Idempotency-Key": randomUUID(),
        });
        expectRefusal(up, 404, "NOT_FOUND");
      }
      expect(await snapshot(stackId)).toEqual(before);
    });
  });
});
