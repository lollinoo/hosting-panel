/**
 * `HCP-STACK/v2` through the API (ADR-0036): values the platform generates, secrets in a component's environment, what
 * the customer sees of them (nothing of the hidden ones) and where a value travels (to the executor, at creation and at
 * start, and nowhere else). Original templates with invented images.
 */
import { randomUUID } from "node:crypto";
import {
  APP_BUILT_IN_TEMPLATES,
  APP_IMAGE_ALLOWLIST,
  AdminAppTemplateVersionDtoSchema,
  AppTemplateValidationDtoSchema,
  ApprovedStackPlanSchema,
  CustomerAppTemplateDtoSchema,
  appStackPlanSecretRefs,
} from "@hosting-panel/contracts";
import {
  and,
  appStackRevisions,
  appStackSecrets,
  appStacks,
  appTemplateVersions,
  asc,
  auditEvents,
  eq,
  operationSteps,
  operations,
  outboxEvents,
  readAppStackSecretFiles,
  resourceQuotas,
  sql,
} from "@hosting-panel/database";
import type { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { APP_STACK_EXECUTOR_METHODS } from "@hosting-panel/executor-contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { DOCKER_EXECUTOR_TOKEN } from "../src/tokens.js";
import { APP_TEST_ALLOWLIST, APP_TEST_MASTER_KEY, startAppStackHarness, type AppStackHarness } from "./fixtures/app-stack-harness.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Reply = Awaited<ReturnType<AppStackHarness["call"]>>;

const BLOG_SOURCE = `x-hp-stack:
  schemaVersion: 2
  name: Blog Demo
  category: cms
  description: A two-component demo of the extended format.
x-hp-parameters:
  - key: site_title
    label: Site title
    type: string
    default: "My blog"
    customer: true
  - key: db_password
    label: Database password
    type: secret
    required: true
    customer: false
    generate:
      kind: password
      length: 32
  - key: admin_password
    label: Administrator password
    type: secret
    required: true
    customer: true
    generate:
      kind: hex
      length: 24
  - key: api_token
    label: API token
    type: secret
    required: false
    customer: true
  - key: licence
    label: Licence file
    type: secret
    required: false
    customer: true
services:
  web:
    image: registry.example.invalid/blog/web:1.2.3@sha256:${"c".repeat(64)}
    x-hp-profile: standard
    environment:
      - name: BLOG_TITLE
        value: "\${site_title}"
      - name: DATABASE_URL
        value: "sql://blog:\${db_password}@db:5432/blog"
      - name: ADMIN_PASSWORD
        secret: admin_password
      - name: API_TOKEN
        secret: api_token
      - name: LICENCE_FILE
        secret: licence
    volumes:
      - content:/var/www/html
    expose:
      - 80
    depends_on:
      - db
    healthcheck:
      kind: tcp
      port: 80
      intervalSeconds: 15
      timeoutSeconds: 3
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
  db:
    image: db.example.invalid/blog/sql:8.0.1@sha256:${"d".repeat(64)}
    x-hp-profile: standard
    environment:
      - name: DB_PASSWORD
        secret: db_password
    volumes:
      - dbdata:/var/lib/sql
    expose:
      - 5432
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 256M
volumes:
  content: {}
  dbdata: {}
x-hp-ingress:
  - service: web
    port: 80
    protocol: http
`;

/** A version 1 template the simulator runs: its image is on the code allowlist. */
const JOB_V1 = APP_BUILT_IN_TEMPLATES[1]!.source;
/** The same in the extended format, with a session key the platform generates and nobody sees. */
const JOB_V2 = JOB_V1.replace("schemaVersion: 1", "schemaVersion: 2")
  .replace(
    "services:\n",
    "  - key: session_key\n    label: Session key\n    type: secret\n    required: true\n    customer: false\n    generate:\n      kind: base64\n      length: 32\nservices:\n",
  )
  .replace("    depends_on:\n      - storage\n", "    depends_on:\n      - storage\n    environment:\n      - name: SESSION_KEY\n        secret: session_key\n");
const JOB_V3 = JOB_V2.replace("          memory: 32M", "          memory: 48M");
for (const [from, to] of [
  [JOB_V1, JOB_V2],
  [JOB_V2, JOB_V3],
] as const) {
  if (from === to) throw new Error("the job template fixture did not change");
}
if (!JOB_V2.includes("generate:") || !JOB_V2.includes("SESSION_KEY")) throw new Error("the job template fixture lost its secret");

const json = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
const spellings = (value: string): string[] => [value, Buffer.from(value).toString("base64"), Buffer.from(value).toString("hex"), encodeURIComponent(value)];
function expectNoValue(text: string, value: string, what: string): void {
  for (const form of new Set(spellings(value))) expect(text.includes(form), `${what} holds a secret value`).toBe(false);
}

describe("application stacks in the extended format (ADR-0036): generated values and secrets in the environment", () => {
  let h: AppStackHarness;
  let sim: InMemoryDockerSimulatorAdapter;
  let blog: { templateId: string; versionId: string };
  const printed: string[] = [];

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] });
    await h.dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, h.a.orgId));
    sim = h.app.nestApp.get<InMemoryDockerSimulatorAdapter>(DOCKER_EXECUTOR_TOKEN);
    blog = await h.publish(BLOG_SOURCE);
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
    printed.length = 0;
  });

  afterAll(async () => {
    await h?.close();
  });

  const base = `/v1/organizations/${"{org}"}/app-stacks`;
  const stacks = () => base.replace("{org}", h.a.orgId);
  const idem = (key: string = randomUUID()) => ({ "Idempotency-Key": key });
  const worker = () => h.app.nestApp.get(OutboxWorkerService);
  const stackRow = async (stackId: string) => (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  const secretRows = (stackId: string) =>
    h.dbClient.db
      .select()
      .from(appStackSecrets)
      .where(eq(appStackSecrets.stackId, stackId))
      .orderBy(asc(appStackSecrets.parameterKey), asc(appStackSecrets.version));
  const versionsOf = async (stackId: string) => (await secretRows(stackId)).map((row) => `${row.parameterKey}:${String(row.version)}`);
  const audits = (action: string, targetId: string) =>
    h.dbClient.db.select().from(auditEvents).where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, targetId)));
  const envOf = (stackId: string, component: string): string[] =>
    [...((sim.appStacks.getAppStackSnapshot(stackId)!.containers[component]!.payload as { Env?: readonly string[] }).Env ?? [])];

  async function valueOf(stackId: string, parameterKey: string, version = 1): Promise<string> {
    const [file] = await readAppStackSecretFiles(h.dbClient.db, {
      organizationId: h.a.orgId,
      stackId,
      masterKey: APP_TEST_MASTER_KEY,
      refs: [{ parameterKey, version }],
    });
    return file!.content;
  }

  function capture(): void {
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(" "));
      });
    }
  }

  /** Every call the executor receives, per method, with its arguments as text (the spy calls through). */
  function recordExecutor(): () => Map<string, string[]> {
    const spies = APP_STACK_EXECUTOR_METHODS.map((method) => [method, vi.spyOn(sim.appStacks, method as "getAppStackStatus")] as const);
    return () => new Map(spies.map(([method, spy]) => [method, spy.mock.calls.map((args) => json(args))]));
  }

  async function create(body: Json, key?: string): Promise<Reply> {
    const res = await h.call(h.a.token, "POST", stacks(), body, idem(key));
    expect(res.status, res.raw).toBe(body.deploy ? 202 : 201);
    return res;
  }
  const setSecret = (stackId: string, parameterKey: string, value: string) =>
    h.call(h.a.token, "POST", `${stacks()}/${stackId}/secrets`, { parameterKey, value });

  async function runUntilRunning(stackId: string): Promise<void> {
    for (let round = 0; round < 10 && (await stackRow(stackId)).status !== "running"; round += 1) await worker().processPendingOnce();
    expect((await stackRow(stackId)).status).toBe("running");
  }

  /** For a stack that is already running: until none of its operations is open, then it must be running again. */
  async function runUntilSettled(stackId: string): Promise<void> {
    const open = async () =>
      (await h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId))).filter((o) => !["succeeded", "failed"].includes(o.status));
    for (let round = 0; round < 10 && (await open()).length > 0; round += 1) await worker().processPendingOnce();
    expect((await open()).map((o) => o.status)).toEqual([]);
    expect((await stackRow(stackId)).status).toBe("running");
  }

  /** Rows of every public table except the secrets table, as one string per table. */
  async function publicDump(): Promise<Map<string, string>> {
    const tables = await h.dbClient.db.execute(sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    const dump = new Map<string, string>();
    for (const entry of tables.rows) {
      const name = String(entry["table_name"]);
      if (!/^[a-z0-9_]+$/i.test(name) || name === "app_stack_secrets") continue;
      dump.set(name, json((await h.dbClient.db.execute(sql.raw(`SELECT * FROM "${name}"`))).rows));
    }
    return dump;
  }

  describe("the catalogue and the administrator's view", () => {
    it("the install form is not asked a generated secret, and the answer keeps the version 1 shape", async () => {
      const res = await h.call(h.a.token, "GET", `/v1/organizations/${h.a.orgId}/app-templates/${blog.templateId}`);
      expect(res.status, res.raw).toBe(200);
      const dto = CustomerAppTemplateDtoSchema.parse(res.body.data);
      expect(dto.parameters.map((p) => p.key)).toEqual(["site_title", "api_token", "licence"]);
      expect(res.raw).not.toContain("generate");
      expect(res.raw).not.toContain("db_password");
      expect(res.raw).not.toContain("admin_password");
      expect(dto.parameters[1]).toEqual({ key: "api_token", label: "API token", type: "secret", required: false, customer: true });
    });

    it("the administrator sees every parameter with its generation rule, in the preview and in the stored version", async () => {
      const validated = await h.call(h.adminToken, "POST", "/v1/admin/app-templates/validate", { source: BLOG_SOURCE });
      expect(validated.status, validated.raw).toBe(200);
      const checked = AppTemplateValidationDtoSchema.parse(validated.body.data);
      expect(checked.valid).toBe(true);
      const stored = await h.call(h.adminToken, "GET", `/v1/admin/app-templates/${blog.templateId}/versions/${blog.versionId}`);
      expect(stored.status, stored.raw).toBe(200);
      const version = AdminAppTemplateVersionDtoSchema.parse(stored.body.data);
      for (const parameters of [checked.parameters, version.parameters]) {
        expect(parameters.map((p) => p.key)).toEqual(["site_title", "db_password", "admin_password", "api_token", "licence"]);
        expect(parameters[1]).toEqual({
          key: "db_password",
          label: "Database password",
          type: "secret",
          required: true,
          customer: false,
          generate: { kind: "password", length: 32 },
        });
        expect(parameters[3]).toMatchObject({ key: "api_token", customer: true, generate: null });
      }
    });

    it("the stored version records the format it was written in", async () => {
      const notes = await h.publish();
      const rows = await h.dbClient.db.select({ id: appTemplateVersions.id, specVersion: appTemplateVersions.specVersion }).from(appTemplateVersions);
      expect(rows.find((row) => row.id === blog.versionId)!.specVersion).toBe(2);
      expect(rows.find((row) => row.id === notes.versionId)!.specVersion).toBe(1);
    });
  });

  describe("an application installed and started in one request, without typing a password", () => {
    let stackId: string;
    let created: Reply;
    /** What the executor received and what was printed while the application was installed. */
    let seen: Map<string, string[]>;
    let log: string;
    let dbPassword: string;
    let adminPassword: string;

    beforeAll(async () => {
      capture();
      const calls = recordExecutor();
      created = await create({ templateVersionId: blog.versionId, name: "blog", deploy: true });
      stackId = created.body.data.stackId as string;
      await runUntilRunning(stackId);
      seen = calls();
      log = printed.join("\n");
      vi.restoreAllMocks();
      dbPassword = await valueOf(stackId, "db_password");
      adminPassword = await valueOf(stackId, "admin_password");
    }, 120_000);

    it("stores version 1 of each generated secret, of the kind and length the template asks", async () => {
      expect(await versionsOf(stackId)).toEqual(["admin_password:1", "db_password:1"]);
      expect(dbPassword).toMatch(/^[A-Za-z0-9]{32}$/);
      expect(adminPassword).toMatch(/^[0-9a-f]{24}$/);
    });

    it("the plan pins the versions and holds no value", async () => {
      const [revision] = await h.dbClient.db.select().from(appStackRevisions).where(eq(appStackRevisions.stackId, stackId));
      const plan = ApprovedStackPlanSchema.parse(revision!.plan);
      expect(plan.schemaVersion).toBe(2);
      expect(appStackPlanSecretRefs(plan)).toEqual([
        { parameterKey: "admin_password", version: 1 },
        { parameterKey: "db_password", version: 1 },
      ]);
      for (const value of [dbPassword, adminPassword]) expectNoValue(json(revision), value, "the revision");
    });

    it("the components run with the values in their environment, alone and inside a longer value", () => {
      expect(envOf(stackId, "db")).toContain(`DB_PASSWORD=${dbPassword}`);
      const web = envOf(stackId, "web");
      expect(web).toContain(`DATABASE_URL=sql://blog:${dbPassword}@db:5432/blog`);
      expect(web).toContain(`ADMIN_PASSWORD=${adminPassword}`);
      expect(web).toContain("BLOG_TITLE=My blog");
      // An optional secret nobody set leaves no variable behind.
      expect(web.some((entry) => entry.startsWith("API_TOKEN=") || entry.startsWith("LICENCE_FILE="))).toBe(false);
    });

    it("the values travel to the executor at creation and at start, and in no other call", () => {
      expect(seen.get("createAppStackComponents")).toHaveLength(1);
      for (const value of [dbPassword, adminPassword]) {
        const carriers = [...seen].filter(([, requests]) => requests.some((r) => r.includes(value))).map(([method]) => method);
        expect(carriers.sort()).toEqual(["createAppStackComponents", "startAppStackComponent"]);
      }
      const starts = seen.get("startAppStackComponent")!;
      // The plan names components too (its routes): the request's own field is the one before the secrets.
      const startOf = (component: string) => starts.find((r) => r.includes(`"componentKey":"${component}","secretFileContents"`))!;
      expect(starts).toHaveLength(2);
      // Each component is started with its own secrets only.
      expect(startOf("db")).toContain(dbPassword);
      expect(startOf("db")).not.toContain(adminPassword);
      expect(startOf("web")).toContain(dbPassword);
      expect(startOf("web")).toContain(adminPassword);
    });

    it("no table but the encrypted one, no answer and no log line holds a value", async () => {
      const db = h.dbClient.db;
      const reads = [stacks(), `${stacks()}/${stackId}`, `${stacks()}/${stackId}/deployments`, `${stacks()}/${stackId}/components/web/health`];
      const replies = [created];
      for (const path of reads) {
        const res = await h.call(h.a.token, "GET", path);
        expect(res.status, `${path}: ${res.raw}`).toBe(200);
        replies.push(res);
      }
      replies.push(await h.call(h.a.token, "POST", `${stacks()}/${stackId}/plan`, {}));
      replies.push(await h.call(h.adminToken, "GET", "/v1/admin/app-stacks"));
      const dump = await publicDump();
      for (const value of [dbPassword, adminPassword]) {
        for (const [what, rows] of [
          ["operations", await db.select().from(operations)],
          ["operation_steps", await db.select().from(operationSteps)],
          ["outbox_events", await db.select().from(outboxEvents)],
          ["audit_events", await db.select().from(auditEvents)],
        ] as const) {
          expectNoValue(json(rows), value, what);
        }
        for (const [name, text] of dump) expectNoValue(text, value, `table ${name}`);
        for (const res of replies) expectNoValue(res.raw, value, "an answer");
        expectNoValue(log, value, "console output");
        for (const row of await secretRows(stackId)) expectNoValue(json(row), value, "an app_stack_secrets row");
      }
    });

    it("the audit row of the installation names the generated secrets and nothing more", async () => {
      const [row] = await audits("app.stack.create", stackId);
      expect((row!.details as Json).generatedParameterKeys).toEqual(["admin_password", "db_password"]);
    });

    it("the customer sees the secrets they may set, and not the one that is not theirs", async () => {
      const res = await h.call(h.a.token, "GET", `${stacks()}/${stackId}`);
      expect(res.status, res.raw).toBe(200);
      const listed = res.body.data.secretParameters as Json[];
      expect(listed.map((s) => [s.key, s.isSet, s.version])).toEqual([
        ["admin_password", true, 1],
        ["api_token", false, null],
        ["licence", false, null],
      ]);
      expect(res.raw).not.toContain("db_password");
    });

    it("a hidden secret cannot be replaced: the answer is the one of a setting that does not exist", async () => {
      const hidden = await setSecret(stackId, "db_password", "chosen-by-the-customer");
      const unknown = await setSecret(stackId, "no_such_key", "chosen-by-the-customer");
      expect(hidden.status, hidden.raw).toBe(400);
      const strip = (res: Reply) => {
        const { requestId: _requestId, ...error } = res.body.error as Json;
        return error;
      };
      expect(strip(hidden)).toEqual(strip(unknown));
      expect(await versionsOf(stackId)).toEqual(["admin_password:1", "db_password:1"]);
    });

    it("a secret read from the environment is bounded at 4096 bytes; one delivered as a file is not", async () => {
      const tooLong = await setSecret(stackId, "api_token", "x".repeat(4_097));
      expect(tooLong.status, tooLong.raw).toBe(400);
      // Its own reason, so the page can say why, and the bound it passed, so the page can state the limit.
      expect(tooLong.body.error.details).toEqual([expect.objectContaining({ field: "value", reason: "value_too_long", limit: "environment" })]);
      // Bytes, not characters.
      expect((await setSecret(stackId, "api_token", "è".repeat(2_049))).status).toBe(400);
      expect((await setSecret(stackId, "api_token", "x".repeat(4_096))).status).toBe(200);
      expect((await setSecret(stackId, "licence", "x".repeat(5_000))).status).toBe(200);
      expect(await versionsOf(stackId)).toEqual(["admin_password:1", "api_token:1", "db_password:1", "licence:1"]);
    });

    it("the customer replaces a generated secret that is theirs, and the next deploy runs with the new value", async () => {
      const chosen = `chosen-${randomUUID()}`;
      const set = await setSecret(stackId, "admin_password", chosen);
      expect(set.status, set.raw).toBe(200);
      expect(set.body.data).toMatchObject({ key: "admin_password", isSet: true, version: 2 });
      expectNoValue(set.raw, chosen, "the answer");
      const diff = await h.call(h.a.token, "POST", `${stacks()}/${stackId}/plan`, {});
      expect(diff.status, diff.raw).toBe(200);
      // The hidden secret is not in the list of what changes; the ones the customer set are.
      expect((diff.body.data.parameters as Json[]).map((p) => [p.key, p.change])).toEqual([
        ["admin_password", "updated"],
        ["api_token", "added"],
        ["licence", "added"],
      ]);
      const queued = await h.call(h.a.token, "POST", `${stacks()}/${stackId}/deploy`, {}, idem());
      expect(queued.status, queued.raw).toBe(202);
      await runUntilSettled(stackId);
      const web = envOf(stackId, "web");
      expect(web).toContain(`ADMIN_PASSWORD=${chosen}`);
      expect(web).toContain(`API_TOKEN=${"x".repeat(4_096)}`);
      expect(web).toContain("LICENCE_FILE=/run/secrets/licence");
      // The database password did not change with it.
      expect(web).toContain(`DATABASE_URL=sql://blog:${dbPassword}@db:5432/blog`);
      expect(envOf(stackId, "db")).toContain(`DB_PASSWORD=${dbPassword}`);
    }, 60_000);
  });

  describe("a draft", () => {
    it("gets its generated secrets when it is created, once, and installs with them later", async () => {
      const key = randomUUID();
      const first = await create({ templateVersionId: blog.versionId, name: "draft-blog", deploy: false }, key);
      const stackId = first.body.data.stackId as string;
      expect(await versionsOf(stackId)).toEqual(["admin_password:1", "db_password:1"]);
      const before = await valueOf(stackId, "db_password");
      // The same request again creates nothing and generates nothing.
      const again = await h.call(h.a.token, "POST", stacks(), { templateVersionId: blog.versionId, name: "draft-blog", deploy: false }, idem(key));
      expect(again.status, again.raw).toBe(201);
      expect(again.body.data.stackId).toBe(stackId);
      expect(await versionsOf(stackId)).toEqual(["admin_password:1", "db_password:1"]);
      expect(await valueOf(stackId, "db_password")).toBe(before);
      expect(await audits("app.stack.create", stackId)).toHaveLength(1);

      const queued = await h.call(h.a.token, "POST", `${stacks()}/${stackId}/deploy`, {}, idem());
      expect(queued.status, queued.raw).toBe(202);
      await runUntilRunning(stackId);
      expect(envOf(stackId, "db")).toContain(`DB_PASSWORD=${before}`);
    }, 60_000);

    it("two applications of the same template never share a generated value", async () => {
      const one = (await create({ templateVersionId: blog.versionId, name: "blog-one", deploy: false })).body.data.stackId as string;
      const two = (await create({ templateVersionId: blog.versionId, name: "blog-two", deploy: false })).body.data.stackId as string;
      expect(await valueOf(one, "db_password")).not.toBe(await valueOf(two, "db_password"));
      expect(await valueOf(one, "admin_password")).not.toBe(await valueOf(two, "admin_password"));
    });
  });

  describe("an upgrade from the first format to the extended one", () => {
    const interval = [{ key: "worker_interval_seconds", value: 15 }];

    async function running(name: string): Promise<{ templateId: string; stackId: string }> {
      const { templateId, versionId } = await h.publish(JOB_V1);
      const stackId = (await create({ templateVersionId: versionId, name, deploy: true, parameters: interval })).body.data.stackId as string;
      await runUntilRunning(stackId);
      expect(await versionsOf(stackId)).toEqual([]);
      return { templateId, stackId };
    }

    async function addVersion(templateId: string, source: string): Promise<string> {
      const added = await h.call(h.adminToken, "POST", `/v1/admin/app-templates/${templateId}/versions`, { source, makeDefault: true });
      expect(added.status, added.raw).toBe(201);
      return added.body.data.versionId as string;
    }

    it("an application of the first format is created as before: no secret travels with the request", async () => {
      const calls = recordExecutor();
      const { stackId } = await running("job-v1");
      const seen = calls();
      expect(seen.get("createAppStackComponents")).toHaveLength(1);
      expect(seen.get("createAppStackComponents")![0]).not.toContain("secretContents");
      expect(Object.keys(JSON.parse(seen.get("createAppStackComponents")![0]!)[0] as Json)).toEqual(["plan"]);
      expect(await audits("app.stack.create", stackId)).toHaveLength(1);
      expect("generatedParameterKeys" in ((await audits("app.stack.create", stackId))[0]!.details as Json)).toBe(false);
    }, 60_000);

    it("generates what the new version brings when the upgrade is queued, not when it is reviewed, and never twice", async () => {
      const { templateId, stackId } = await running("job");
      const v2 = await addVersion(templateId, JOB_V2);

      // The review writes nothing, twice gives the same answer, and does not name the hidden secret.
      const before = await h.counts();
      const diff = await h.call(h.a.token, "POST", `${stacks()}/${stackId}/plan`, { templateVersionId: v2 });
      expect(diff.status, diff.raw).toBe(200);
      const diffAgain = await h.call(h.a.token, "POST", `${stacks()}/${stackId}/plan`, { templateVersionId: v2 });
      expect(diffAgain.body.data.planHash).toBe(diff.body.data.planHash);
      expect(await h.counts()).toEqual(before);
      expect((diff.body.data.parameters as Json[]).map((p) => p.key)).toEqual(["worker_interval_seconds"]);
      expect(diff.raw).not.toContain("session_key");
      expect(await versionsOf(stackId)).toEqual([]);

      const key = randomUUID();
      const body = { templateVersionId: v2, planHash: diff.body.data.planHash as string };
      const queued = await h.call(h.a.token, "POST", `${stacks()}/${stackId}/upgrade`, body, idem(key));
      expect(queued.status, queued.raw).toBe(202);
      expect(await versionsOf(stackId)).toEqual(["session_key:1"]);
      const sessionKey = await valueOf(stackId, "session_key");
      expect(Buffer.from(sessionKey, "base64")).toHaveLength(32);
      expect(Buffer.from(sessionKey, "base64").toString("base64")).toBe(sessionKey);
      const [audit] = await audits("app.stack.upgrade", stackId);
      expect((audit!.details as Json).generatedParameterKeys).toEqual(["session_key"]);
      expectNoValue(json(audit), sessionKey, "the audit row");
      expectNoValue(queued.raw, sessionKey, "the answer");

      // The same request again: the same operation, no second value.
      const replay = await h.call(h.a.token, "POST", `${stacks()}/${stackId}/upgrade`, body, idem(key));
      expect(replay.status, replay.raw).toBe(202);
      expect(replay.body.data.operationId).toBe(queued.body.data.operationId);
      expect(await versionsOf(stackId)).toEqual(["session_key:1"]);
      expect(await valueOf(stackId, "session_key")).toBe(sessionKey);

      await runUntilSettled(stackId);
      expect(envOf(stackId, "worker")).toContain(`SESSION_KEY=${sessionKey}`);
      const detail = await h.call(h.a.token, "GET", `${stacks()}/${stackId}`);
      expect(detail.status, detail.raw).toBe(200);
      expect(detail.body.data.secretParameters).toEqual([]);
      expect(detail.raw).not.toContain("session_key");

      // A later version of the same format keeps the value it has.
      const v3 = await addVersion(templateId, JOB_V3);
      const next = await h.call(h.a.token, "POST", `${stacks()}/${stackId}/plan`, { templateVersionId: v3 });
      expect(next.status, next.raw).toBe(200);
      const upgraded = await h.call(
        h.a.token,
        "POST",
        `${stacks()}/${stackId}/upgrade`,
        { templateVersionId: v3, planHash: next.body.data.planHash as string },
        idem(),
      );
      expect(upgraded.status, upgraded.raw).toBe(202);
      expect(await versionsOf(stackId)).toEqual(["session_key:1"]);
      const upgrades = await audits("app.stack.upgrade", stackId);
      expect(upgrades).toHaveLength(2);
      expect(upgrades.filter((row) => "generatedParameterKeys" in (row.details as Json))).toHaveLength(1);
      await runUntilSettled(stackId);
      expect(envOf(stackId, "worker")).toContain(`SESSION_KEY=${sessionKey}`);
    }, 120_000);

    it("an upgrade that fails at the download is taken back but keeps its generated value; the same upgrade again reuses it", async () => {
      const { templateId, stackId } = await running("job-retry");
      const v1 = (await stackRow(stackId)).templateVersionId;
      const v2 = await addVersion(templateId, JOB_V2);
      const diff = await h.call(h.a.token, "POST", `${stacks()}/${stackId}/plan`, { templateVersionId: v2 });
      expect(diff.status, diff.raw).toBe(200);
      const body = { templateVersionId: v2, planHash: diff.body.data.planHash as string };
      const upgradeOps = async () =>
        (await h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId)).orderBy(asc(operations.submittedAt)))
          .filter((o) => o.kind === "stack.upgrade")
          .map((o) => o.status);

      sim.appStacks.failNextAppStackStep("pull", "pull_failed");
      const failed = await h.call(h.a.token, "POST", `${stacks()}/${stackId}/upgrade`, body, idem());
      expect(failed.status, failed.raw).toBe(202);
      expect(await versionsOf(stackId)).toEqual(["session_key:1"]);
      const sessionKey = await valueOf(stackId, "session_key");
      await runUntilSettled(stackId);
      expect(await upgradeOps()).toEqual(["failed"]);

      // Back on version 1, which declares no such secret: the stored value stays, unused and never shown.
      expect(await stackRow(stackId)).toMatchObject({ templateVersionId: v1 });
      expect(await versionsOf(stackId)).toEqual(["session_key:1"]);
      expect(envOf(stackId, "worker").some((entry) => entry.startsWith("SESSION_KEY="))).toBe(false);
      const detail = await h.call(h.a.token, "GET", `${stacks()}/${stackId}`);
      expect(detail.body.data).toMatchObject({ templateVersionNumber: 1, upgrade: { versionNumber: 2 } });
      expect(detail.raw).not.toContain("session_key");

      // The same review answers the same plan (it pins the stored version 1); the new request generates nothing.
      const again = await h.call(h.a.token, "POST", `${stacks()}/${stackId}/plan`, { templateVersionId: v2 });
      expect(again.body.data.planHash).toBe(body.planHash);
      const retried = await h.call(h.a.token, "POST", `${stacks()}/${stackId}/upgrade`, body, idem());
      expect(retried.status, retried.raw).toBe(202);
      expect(await versionsOf(stackId)).toEqual(["session_key:1"]);
      expect(await valueOf(stackId, "session_key")).toBe(sessionKey);
      const upgrades = await audits("app.stack.upgrade", stackId);
      expect(upgrades).toHaveLength(2);
      expect(upgrades.filter((row) => "generatedParameterKeys" in (row.details as Json))).toHaveLength(1);
      await runUntilSettled(stackId);
      expect(await upgradeOps()).toEqual(["failed", "succeeded"]);
      expect(await stackRow(stackId)).toMatchObject({ templateVersionId: v2 });
      expect(envOf(stackId, "worker")).toContain(`SESSION_KEY=${sessionKey}`);
    }, 120_000);

    it("an upgrade that is refused stores nothing", async () => {
      const { templateId, stackId } = await running("job-refused");
      const v2 = await addVersion(templateId, JOB_V2);
      const diff = await h.call(h.a.token, "POST", `${stacks()}/${stackId}/plan`, { templateVersionId: v2 });
      expect(diff.status, diff.raw).toBe(200);
      const before = await h.counts();
      // Not the plan that was reviewed.
      const wrong = await h.call(h.a.token, "POST", `${stacks()}/${stackId}/upgrade`, { templateVersionId: v2, planHash: "0".repeat(64) }, idem());
      expect(wrong.status, wrong.raw).toBe(400);
      expect(wrong.body.error.details).toContainEqual(expect.objectContaining({ field: "planHash", reason: "plan_changed" }));
      expect(await h.counts()).toEqual(before);
      // Another operation of the application is still open.
      expect((await h.call(h.a.token, "POST", `${stacks()}/${stackId}/restart`, {}, idem())).status).toBe(202);
      const held = await h.counts();
      const locked = await h.call(
        h.a.token,
        "POST",
        `${stacks()}/${stackId}/upgrade`,
        { templateVersionId: v2, planHash: diff.body.data.planHash as string },
        idem(),
      );
      expect(locked.status, locked.raw).toBe(409);
      expect(await h.counts()).toEqual(held);
      expect(await versionsOf(stackId)).toEqual([]);
    }, 120_000);
  });
});
