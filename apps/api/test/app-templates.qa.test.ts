import { APP_TEMPLATE_SPEC_VERSION, toAppStackPreview } from "@hosting-panel/contracts";
import { auditEvents, createAppTemplate, type HostingPanelDatabase } from "@hosting-panel/database";
import { computeAppTemplateSpecHash } from "@hosting-panel/hosting-domain";
import { compileAppStackPlan, validateAppTemplateSource } from "@hosting-panel/policy-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin } from "../src/cli/accounts.js";
import { APP_TEST_ALLOWLIST, NOTES_DEMO_SOURCE, startAppStackHarness, type AppStackHarness } from "./fixtures/app-stack-harness.js";

// Q1 of HCP-SPEC-005 (arch-api §12.1): A1, A2, A12 and the source limits, against the real API.

const BASE = "/v1/admin/app-templates";
const IDS = { stackId: "stk_q1", organizationId: "org_q1", hostAllocationId: "alloc_q1", templateVersionId: "atv_q1", revisionId: "srev_q1" };
const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const APP_IMAGE = `registry.example.invalid/demo/app:1.2.3@sha256:${"a".repeat(64)}`;
const NO_TEMPLATE = "atpl_000000000000000000000000";
const NO_VERSION = "atv_000000000000000000000000";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const HEADER = (name: string) => `x-hp-stack:\n  schemaVersion: 1\n  name: ${name}\n  category: tools\n  description: Q1 fixture\n`;

function service(key: string, port: number, extra = "", limits = 'cpus: "0.1"\n          memory: 64M'): string {
  return `  ${key}:\n    image: ${APP_IMAGE}\n    expose:\n      - ${port}\n${extra}    deploy:\n      resources:\n        limits:\n          ${limits}\n`;
}

/** One service, no ingress, no parameters, no volumes. */
const oneService = (name = "Solo"): string => `${HEADER(name)}services:\n${service("solo", 9000)}`;

/** `count` services s1..sN, a dependency chain, one http ingress on s1. */
function manyServices(count: number, name = "Octet"): string {
  const services = Array.from({ length: count }, (_, i) =>
    service(
      `s${i + 1}`,
      8001 + i,
      i === 0 ? "    healthcheck:\n      kind: tcp\n      port: 8001\n" : `    depends_on:\n      - s${i}\n`,
    ),
  ).join("");
  return `${HEADER(name)}services:\n${services}x-hp-ingress:\n  - service: s1\n    port: 8001\n    protocol: http\n`;
}

const renamed = (name: string) => NOTES_DEMO_SOURCE.replace("name: Notes Demo", `name: ${name}`);
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** The source padded with a YAML comment up to exactly `size` UTF-8 bytes (`filler` is one character). */
function padded(source: string, size: number, filler = "a"): string {
  const head = `${source}\n#`;
  const unit = bytes(filler);
  const fill = Math.floor((size - bytes(head)) / unit);
  const out = head + filler.repeat(fill);
  return out + "a".repeat(size - bytes(out));
}

function expectedPreview(source: string, allowlist = APP_TEST_ALLOWLIST) {
  const compiled = compileAppStackPlan({ source, parameters: [], secretVersions: new Map([["app_secret", 1]]), ids: IDS }, { allowlist });
  if (!compiled.ok) throw new Error(`fixture does not compile: ${JSON.stringify(compiled)}`);
  return toAppStackPreview(compiled.plan);
}

async function auditDump(h: AppStackHarness): Promise<{ rows: Json[]; text: string }> {
  const rows = (await h.dbClient.db.select().from(auditEvents)) as Json[];
  return { rows, text: JSON.stringify(rows) };
}

/** Everything but the audit trail, which records denials. */
const withoutAudit = (counts: Record<string, number>) => ({ ...counts, audit_events: 0 });

async function login(h: AppStackHarness, email: string, totpSecret: string): Promise<string> {
  const res = await h.call(null, "POST", "/v1/auth/login", {
    email,
    password: PW,
    totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)),
  });
  if (res.status !== 200) throw new Error(`login of ${email} failed: ${res.raw}`);
  return res.body.data.accessToken as string;
}

describe("application template catalogue (Q1)", () => {
  let h: AppStackHarness;

  beforeEach(async () => {
    h = await startAppStackHarness({ allowlist: APP_TEST_ALLOWLIST });
  });

  afterEach(async () => {
    await h.close();
  });

  const create = (source: string, slug: string) => h.call(h.adminToken, "POST", BASE, { slug, source });
  const validate = (source: string) => h.call(h.adminToken, "POST", `${BASE}/validate`, { source });

  describe("A1: the preview is the compiled plan", () => {
    const sources: [string, () => string, { components: number; ingress: boolean }][] = [
      ["the notes-demo fixture", () => NOTES_DEMO_SOURCE, { components: 2, ingress: true }],
      ["a one-service template without ingress", () => oneService(), { components: 1, ingress: false }],
      ["a template with eight services", () => manyServices(8), { components: 8, ingress: true }],
    ];

    it.each(sources)("%s: validate, create and version GET all answer the compiler's preview", async (_label, make, shape) => {
      const source = make();
      const expected = expectedPreview(source);
      expect(expected.components).toHaveLength(shape.components);

      const validated = await validate(source);
      expect(validated.status, validated.raw).toBe(200);
      expect(validated.body.data).toMatchObject({ valid: true, issues: [] });
      expect(validated.body.data.preview).toEqual(expected);

      const created = await create(source, "q1-preview");
      expect(created.status, created.raw).toBe(201);
      const detail = created.body.data as Json;
      expect(detail).toMatchObject({ componentCount: shape.components, hasIngress: shape.ingress });

      const version = await h.call(h.adminToken, "GET", `${BASE}/${detail.id as string}/versions/${detail.defaultVersionId as string}`);
      expect(version.status, version.raw).toBe(200);
      expect(version.body.data.source).toBe(source);
      expect(version.body.data.preview).toEqual(expected);
      expect(version.body.data.valid).toBe(true);
    });

    it("a changed source changes the preview (the equality is not vacuous)", async () => {
      const a = (await validate(oneService("Solo"))).body.data.preview;
      const b = (await validate(manyServices(2))).body.data.preview;
      expect(a).not.toEqual(b);
      expect((await validate(oneService("Solo"))).body.data.preview).toEqual(a);
    });
  });

  describe("A2: every admin route refuses everybody who is not an active administrator", () => {
    it("owner, collaborator, stranger and a disabled administrator: 403 or 401, nothing written", async () => {
      const created = await create(NOTES_DEMO_SOURCE, "q1-guard");
      const templateId = created.body.data.id as string;
      const versionId = created.body.data.defaultVersionId as string;
      await h.call(h.adminToken, "POST", `${BASE}/${templateId}/versions`, { source: renamed("Guard Two") });

      const collaborator = await h.addMember(h.a.orgId, "role_customer_collaborator");
      const other = await createServerAdmin(h.dbClient.db, KEY, { email: "admin-q1@example.test", name: "Admin q1", password: PW });
      const disabledToken = await login(h, "admin-q1@example.test", other.totpSecretBase32);
      expect((await h.call(disabledToken, "GET", BASE)).status).toBe(200);
      const off = await h.call(h.adminToken, "PATCH", `/v1/admin/users/${other.userId}`, { status: "disabled" });
      expect(off.status, off.raw).toBe(200);

      const routes: [string, string, unknown?][] = [
        ["GET", BASE],
        ["GET", `${BASE}?state=draft&limit=1`],
        ["POST", `${BASE}/validate`, { source: NOTES_DEMO_SOURCE }],
        ["POST", BASE, { slug: "q1-other", source: renamed("Other") }],
        ["POST", BASE, "{not json"],
        ["GET", `${BASE}/${templateId}`],
        ["GET", `${BASE}/${NO_TEMPLATE}`],
        ["PATCH", `${BASE}/${templateId}`, { enabled: true }],
        ["PATCH", `${BASE}/${templateId}`, { defaultVersionId: versionId }],
        ["PATCH", `${BASE}/${templateId}`, "{not json"],
        ["POST", `${BASE}/${templateId}/versions`, { source: renamed("Guard Three"), makeDefault: true }],
        ["POST", `${BASE}/${templateId}/versions`, { source: "" }],
        ["GET", `${BASE}/${templateId}/versions/${versionId}`],
        ["GET", `${BASE}/${templateId}/versions/${NO_VERSION}`],
        ["POST", `${BASE}/${templateId}/archive`, {}],
        ["POST", `${BASE}/${templateId}/archive`, { extra: 1 }],
        ["GET", `${BASE}/${templateId}/usage`],
      ];
      const actors: [string, string | null, number][] = [
        ["owner", h.a.token, 403],
        ["collaborator", collaborator.token, 403],
        ["stranger", h.b.token, 403],
        ["disabled administrator", disabledToken, 401],
        ["no credentials", null, 401],
      ];

      const before = await h.counts();
      const failures: string[] = [];
      for (const [who, token, status] of actors) {
        for (const [method, path, body] of routes) {
          const res = await h.call(token, method, path, body);
          if (res.status !== status) failures.push(`${who}: ${method} ${path} → ${res.status} ${res.body.error?.code ?? ""}`);
          if (res.status === 403 && res.body.error?.code !== "PERMISSION_DENIED") failures.push(`${who}: ${method} ${path} code ${res.body.error?.code}`);
        }
      }
      expect(failures).toEqual([]);
      expect(withoutAudit(await h.counts())).toEqual(withoutAudit(before));

      // The template is exactly as the administrator left it.
      const after = await h.call(h.adminToken, "GET", `${BASE}/${templateId}`);
      expect(after.body.data).toMatchObject({ enabled: false, archivedAt: null, defaultVersionNumber: 1 });
      expect(after.body.data.versions).toHaveLength(2);
    });
  });

  describe("A12: the resource table", () => {
    const table: [string, (s: string) => string, string, string][] = [
      ["cpus 16.001", (s) => s.replace('cpus: "0.1"', 'cpus: "16.001"'), "LIMIT_CPU_RANGE", "STACK_TEMPLATE_INVALID"],
      ["cpus 0.049", (s) => s.replace('cpus: "0.1"', 'cpus: "0.049"'), "LIMIT_CPU_RANGE", "STACK_TEMPLATE_INVALID"],
      ["memory 17G", (s) => s.replace("memory: 64M", "memory: 17G"), "LIMIT_MEMORY_RANGE", "STACK_TEMPLATE_INVALID"],
      ["memory 16M", (s) => s.replace("memory: 64M", "memory: 16M"), "LIMIT_MEMORY_RANGE", "STACK_TEMPLATE_INVALID"],
      ["limits.pids", (s) => s.replace("memory: 64M", "memory: 64M\n          pids: 100"), "KEY_UNSUPPORTED", "STACK_UNSUPPORTED_FEATURE"],
    ];

    it.each(table)("%s is refused on every write route and on validate, storing nothing", async (_label, mutate, code, reason) => {
      const source = mutate(oneService());
      expect(source).not.toBe(oneService());
      const { templateId } = await h.publish(oneService("Base"), "q1-base");
      const before = await h.counts();

      const viaValidate = await validate(source);
      expect(viaValidate.status, viaValidate.raw).toBe(200);
      expect(viaValidate.body.data).toMatchObject({ valid: false, preview: null, parameters: [] });
      expect(viaValidate.body.data.issues.map((i: Json) => i.code)).toContain(code);

      const viaCreate = await create(source, "q1-bad");
      const viaVersion = await h.call(h.adminToken, "POST", `${BASE}/${templateId}/versions`, { source, makeDefault: true });
      for (const res of [viaCreate, viaVersion]) {
        expect(res.status, res.raw).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
        const detail = (res.body.error.details as Json[]).find((d) => (d.message as string).includes(`${code}:`));
        expect(detail, res.raw).toBeDefined();
        expect(detail!.reason).toBe(reason);
        expect(detail!.message).toMatch(/^line \d+, column \d+: /);
      }
      expect(await h.counts()).toEqual(before);
    });

    it("nine services are refused with SERVICES_TOO_MANY, eight are accepted", async () => {
      const before = await h.counts();
      const nine = manyServices(9);
      const checked = await validate(nine);
      expect(checked.body.data.valid).toBe(false);
      expect(checked.body.data.issues.map((i: Json) => i.code)).toContain("SERVICES_TOO_MANY");
      const refused = await create(nine, "q1-nine");
      expect(refused.status, refused.raw).toBe(400);
      expect(refused.body.error.details.some((d: Json) => (d.message as string).includes("SERVICES_TOO_MANY:"))).toBe(true);
      expect(await h.counts()).toEqual(before);

      expect((await create(manyServices(8), "q1-eight")).status).toBe(201);
    });

    it("the largest allowed limits (16 CPUs, 16 GiB) are accepted", async () => {
      const edge = oneService("Edge").replace('cpus: "0.1"', 'cpus: "16"').replace("memory: 64M", "memory: 16G");
      const res = await create(edge, "q1-edge");
      expect(res.status, res.raw).toBe(201);
      const floor = oneService("Floor").replace('cpus: "0.1"', 'cpus: "0.05"').replace("memory: 64M", "memory: 32M");
      expect((await create(floor, "q1-floor")).status).toBe(201);
    });
  });

  describe("source size", () => {
    it("65 537 bytes are refused before validation, on all three routes, storing nothing", async () => {
      const { templateId } = await h.publish(oneService("Base"), "q1-base");
      const big = padded(oneService("Big"), 65_537);
      expect(bytes(big)).toBe(65_537);
      const wide = padded(oneService("Wide"), 65_537, "é");
      expect(wide.length).toBeLessThan(65_537);
      expect(bytes(wide)).toBe(65_537);

      const before = await h.counts();
      for (const source of [big, wide]) {
        for (const [path, body] of [
          [`${BASE}/validate`, { source }],
          [BASE, { slug: "q1-big", source }],
          [`${BASE}/${templateId}/versions`, { source }],
        ] as const) {
          const res = await h.call(h.adminToken, "POST", path, body);
          expect(res.status, `${path} ${res.raw.slice(0, 200)}`).toBe(400);
          expect(res.body.error.code).toBe("VALIDATION_ERROR");
          // Refused by the size limit, not reported by the validator: no positioned validator detail.
          expect(res.raw).not.toMatch(/line \d+, column \d+/);
          expect(res.raw).not.toContain("IMAGE_NOT_ALLOWLISTED");
        }
      }
      expect(await h.counts()).toEqual(before);
    });

    it("exactly 65 536 bytes still validate", async () => {
      const edge = padded(oneService("Edge"), 65_536);
      expect(bytes(edge)).toBe(65_536);
      const res = await h.call(h.adminToken, "POST", `${BASE}/validate`, { source: edge });
      expect(res.status, res.raw.slice(0, 300)).toBe(200);
      expect(res.body.data.valid).toBe(true);
    });
  });

  describe("audit trail of the admin writes", () => {
    it("holds no line of the source, even a comment, for every write and for a denied attempt", async () => {
      const canary = `CANARY-${"q1x9".repeat(8)}`;
      const commented = (name: string) => `# ${canary} first line\n${renamed(name)}\n# ${canary} last line\n`;

      const validated = await validate(commented("Audit One"));
      expect(validated.body.data.valid).toBe(true);
      const created = await create(commented("Audit One"), "q1-audit");
      expect(created.status, created.raw).toBe(201);
      const templateId = created.body.data.id as string;
      const addV = await h.call(h.adminToken, "POST", `${BASE}/${templateId}/versions`, { source: commented("Audit Two"), makeDefault: true });
      expect(addV.status, addV.raw).toBe(201);
      expect((await h.call(h.adminToken, "PATCH", `${BASE}/${templateId}`, { enabled: true, name: "Audit Renamed" })).status).toBe(200);
      expect((await h.call(h.adminToken, "POST", `${BASE}/${templateId}/archive`, {})).status).toBe(200);
      // A refused write and a denied customer carry the canary too.
      expect((await create(commented("Audit One").replace("cpus: \"1.0\"", 'cpus: "99"'), "q1-audit-bad")).status).toBe(400);
      expect((await h.call(h.a.token, "POST", BASE, { slug: "q1-denied", source: commented("Denied") })).status).toBe(403);
      expect((await h.call(h.a.token, "POST", `${BASE}/validate`, { source: commented("Denied") })).status).toBe(403);

      const { rows, text } = await auditDump(h);
      const actions = rows.map((r) => r.action as string);
      for (const action of [
        "admin.app_template.create",
        "admin.app_template.version",
        "admin.app_template.publish",
        "admin.app_template.archive",
      ]) {
        expect(actions, action).toContain(action);
      }
      expect(rows.some((r) => (r.details as Json | null)?.outcome === "denied")).toBe(true);
      for (const needle of [canary, "CANARY-", "x-hp-stack", "registry.example.invalid", "sha256:", "services:", "schemaVersion"]) {
        expect(text, needle).not.toContain(needle);
      }
    });
  });
});

describe("application templates after the allowlist shrank (Q1)", () => {
  let h: AppStackHarness;

  beforeEach(async () => {
    h = await startAppStackHarness({ allowlist: APP_TEST_ALLOWLIST.filter((row) => !row.repository.endsWith("/app")) });
  });

  afterEach(async () => {
    await h.close();
  });

  it("reads an old version as 200 valid:false with issues, byte-identical source and no preview", async () => {
    const checked = validateAppTemplateSource(NOTES_DEMO_SOURCE, { allowlist: APP_TEST_ALLOWLIST });
    if (!checked.ok) throw new Error("fixture does not validate");
    const { template, version } = await createAppTemplate(h.dbClient.db as HostingPanelDatabase, {
      slug: "q1-old",
      name: checked.spec.name,
      description: checked.spec.description,
      category: checked.spec.category,
      firstVersion: {
        source: NOTES_DEMO_SOURCE,
        specVersion: APP_TEMPLATE_SPEC_VERSION,
        compiledSchema: checked.spec as unknown as Record<string, unknown>,
        specHash: computeAppTemplateSpecHash(checked.spec),
      },
      createdBy: null,
    });

    const before = await h.counts();
    const shown = await h.call(h.adminToken, "GET", `${BASE}/${template.id}/versions/${version.id}`);
    expect(shown.status, shown.raw).toBe(200);
    expect(shown.body.data).toMatchObject({ valid: false, parameters: [], preview: null, source: NOTES_DEMO_SOURCE, id: version.id });
    expect(shown.body.data.issues.length).toBeGreaterThan(0);
    for (const issue of shown.body.data.issues as Json[]) {
      expect(issue.code).toBe("IMAGE_NOT_ALLOWLISTED");
      expect(issue.line).toBeGreaterThanOrEqual(1);
      expect(issue.message).not.toContain("registry.example.invalid");
    }

    // The same source is also an answer, not an error, on validate; the rest of the admin reads stay 200.
    const again = await h.call(h.adminToken, "POST", `${BASE}/validate`, { source: NOTES_DEMO_SOURCE });
    expect(again.status).toBe(200);
    expect(again.body.data.valid).toBe(false);
    for (const path of [`${BASE}/${template.id}`, BASE, `${BASE}/${template.id}/usage`]) {
      expect((await h.call(h.adminToken, "GET", path)).status, path).toBe(200);
    }
    expect(await h.counts()).toEqual(before);

    // Publishing it is refused and writes nothing.
    const publish = await h.call(h.adminToken, "PATCH", `${BASE}/${template.id}`, { enabled: true });
    expect(publish.status).toBe(400);
    expect(await h.counts()).toEqual(before);
  });
});
