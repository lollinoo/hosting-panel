import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AddAppTemplateVersionInputSchema,
  AdminAppStacksDtoSchema,
  AdminAppTemplateDetailDtoSchema,
  AdminAppTemplateListQuerySchema,
  AdminAppTemplateSummaryDtoSchema,
  AdminAppTemplateUsageDtoSchema,
  AdminAppTemplateVersionCreatedDtoSchema,
  AdminAppTemplateVersionDtoSchema,
  AppTemplateSourceSchema,
  AppTemplateValidationDtoSchema,
  ArchiveAppTemplateInputSchema,
  COMPOSE_IMPORT_REPORT_MAX,
  ComposeImportDtoSchema,
  ComposeImportNoteDtoSchema,
  CreateAppTemplateInputSchema,
  ImportComposeInputSchema,
  UpdateAppTemplateInputSchema,
  ValidateAppTemplateInputSchema,
} from "../src/app-templates/admin-dto.js";
import {
  AddAppStackDomainInputSchema,
  AppStackAcceptedEnvelopeSchema,
  AppStackActionInputSchema,
  AppStackComponentHealthDtoSchema,
  AppStackComponentLogsDtoSchema,
  AppStackDeploymentDtoSchema,
  AppStackDetailDtoSchema,
  AppStackDomainDtoSchema,
  AppStackListQuerySchema,
  AppStackLogsQuerySchema,
  AppStackPlanDiffDtoSchema,
  AppStackSecretStateDtoSchema,
  AppStackSummaryDtoSchema,
  CreateAppStackInputSchema,
  CustomerAppTemplateDtoSchema,
  CustomerAppTemplatesDtoSchema,
  DeleteAppStackInputSchema,
  DeployAppStackInputSchema,
  PlanAppStackInputSchema,
  RollbackAppStackInputSchema,
  SetAppStackSecretInputSchema,
  UpgradeAppStackInputSchema,
} from "../src/app-templates/stack-dto.js";
import { AppStackSecretFileContentSchema } from "../src/app-templates/stack-ipc.js";
import { findForbiddenPublicDtoKeys, findPlaintextSecretKeys } from "../src/resources.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/app-stack-notes-demo/${name}`, import.meta.url), "utf8"));
const SPEC = fixture("spec.json") as { parameters: unknown[] };
const PREVIEW = fixture("preview.json");
const AT = "2026-11-22T10:00:00.000Z";
const HASH = "a".repeat(64);
const OP = `op_${"0".repeat(32)}`;
const ISSUE = { path: "services.app.image", line: 3, column: 5, code: "IMAGE_NOT_ALLOWLISTED", reason: "STACK_IMAGE_NOT_ALLOWED", message: "IMAGE_NOT_ALLOWLISTED: not allowed." };

const SUMMARY = {
  id: "atpl_demo", slug: "notes-demo", name: "Notes", category: "productivity", description: null, builtIn: false, enabled: true,
  archivedAt: null, state: "published", defaultVersionId: "atv_demo_1", defaultVersionNumber: 1, installations: 2, componentCount: 2,
  hasIngress: true, hasVolumes: true, updatedAt: AT,
};
const DETAIL = { ...SUMMARY, createdAt: AT, versions: [{ id: "atv_demo_1", versionNumber: 1, specHash: HASH, createdAt: AT, installations: 2 }] };
const CUSTOMER_SUMMARY = {
  id: "atpl_demo", name: "Notes", description: "Notes app", category: "productivity", versionId: "atv_demo_1", versionNumber: 1,
  componentCount: 2, cpuMilli: 1500, memoryBytes: "805306368", volumeCount: 1, hasIngress: true,
};
const STACK_SUMMARY = {
  id: "ast_demo", name: "My notes", status: "running", templateId: "atpl_demo", templateName: "Notes", templateVersionNumber: 1,
  componentCount: 2, unhealthyCount: 0, primaryHostname: "notes.example.com", updatedAt: AT,
};

const NOTE = { level: "changed", code: "IMAGE_PINNED", path: "services.app.image", message: "The image is pinned to the digest its registry gave." };

const SAMPLES: [string, z.ZodType, unknown][] = [
  ["validation", AppTemplateValidationDtoSchema, { valid: false, issues: [ISSUE], parameters: SPEC.parameters, preview: PREVIEW }],
  [
    "compose import",
    ComposeImportDtoSchema,
    { source: "x-hp-stack: {}\n", report: [NOTE], validation: { valid: true, issues: [], parameters: SPEC.parameters, preview: PREVIEW } },
  ],
  ["compose import refused", ComposeImportDtoSchema, { source: null, report: [{ ...NOTE, level: "refused", code: "IMAGE_UNRESOLVED" }], validation: null }],
  ["admin summary", AdminAppTemplateSummaryDtoSchema, SUMMARY],
  ["admin detail", AdminAppTemplateDetailDtoSchema, DETAIL],
  ["version created", AdminAppTemplateVersionCreatedDtoSchema, { template: DETAIL, versionId: "atv_demo_1", versionNumber: 1, created: true }],
  [
    "admin version",
    AdminAppTemplateVersionDtoSchema,
    {
      id: "atv_demo_1", templateId: "atpl_demo", versionNumber: 1, specHash: HASH, createdAt: AT, source: "x-hp-stack: {}\n", valid: true,
      issues: [], parameters: SPEC.parameters, preview: PREVIEW,
    },
  ],
  [
    "usage",
    AdminAppTemplateUsageDtoSchema,
    {
      templateId: "atpl_demo",
      stacks: [{ id: "ast_demo", name: "My notes", organizationId: "org_1", organizationName: "Acme", versionNumber: 1, status: "running" }],
      truncated: false,
    },
  ],
  [
    "admin stacks",
    AdminAppStacksDtoSchema,
    {
      stacks: [
        {
          id: "ast_demo",
          name: "My notes",
          organizationName: "Acme",
          templateId: "atpl_demo",
          templateName: "Notes",
          versionNumber: 1,
          status: "running",
          primaryHostname: null,
        },
      ],
      truncated: false,
    },
  ],
  ["customer catalogue", CustomerAppTemplatesDtoSchema, { templates: [CUSTOMER_SUMMARY], categories: ["productivity"] }],
  [
    "customer template",
    CustomerAppTemplateDtoSchema,
    {
      ...CUSTOMER_SUMMARY,
      parameters: SPEC.parameters,
      ingress: [{ componentKey: "app", port: 8080 }],
      components: [{ key: "app", cpuMilli: 1000, memoryBytes: "536870912" }],
    },
  ],
  [
    "accepted",
    AppStackAcceptedEnvelopeSchema,
    {
      data: { stackId: "ast_demo", operationId: OP, deploymentId: "adep_1", status: "queued" },
      links: { stack: "/v1/organizations/org_1/app-stacks/ast_demo", operation: `/v1/organizations/org_1/operations/${OP}` },
    },
  ],
  ["stack summary", AppStackSummaryDtoSchema, STACK_SUMMARY],
  [
    "stack detail",
    AppStackDetailDtoSchema,
    {
      ...STACK_SUMMARY, templateVersionId: "atv_demo_1", createdAt: AT, activeOperationId: OP, revisionNumber: 1,
      components: [{ key: "app", health: "healthy", healthObservedAt: AT, dependsOn: ["cache"], ingress: true, cpuMilli: 1000, memoryBytes: "536870912" }],
      parameters: [{ key: "workers", label: "Workers", value: 2 }],
      secretParameters: [{ key: "app_secret", label: "App secret", required: true, isSet: true, version: 1, setAt: AT }],
      volumes: [{ key: "data", status: "present", retentionPolicy: "retain" }],
      ingress: [{ componentKey: "app", port: 8080 }],
      cpuMilli: 1500, memoryBytes: "805306368",
      upgrade: { templateVersionId: "atv_demo_2", versionNumber: 2 },
      rollback: { revisionId: "astr_1", revisionNumber: 1, templateVersionNumber: 1 },
    },
  ],
  ["secret state", AppStackSecretStateDtoSchema, { key: "app_secret", isSet: true, version: 2, setAt: AT }],
  [
    "deployment",
    AppStackDeploymentDtoSchema,
    { id: "adep_1", operationId: OP, kind: "stack.deploy", revisionNumber: 1, status: "failed", problem: "STACK_IMAGE_NOT_ALLOWED", startedAt: AT, endedAt: AT },
  ],
  [
    "domain",
    AppStackDomainDtoSchema,
    {
      id: "asd_1", hostname: "notes.example.com", componentKey: "app", port: 8080, status: "active", certificateStatus: "active",
      certificateProblem: null, certificateExpiresAt: AT, checkedAt: AT,
    },
  ],
  [
    "plan diff",
    AppStackPlanDiffDtoSchema,
    {
      planHash: HASH, fromRevisionId: "astr_1", fromVersionNumber: 1, toTemplateVersionId: "atv_demo_2", toVersionNumber: 2, newRevision: true,
      components: [{ key: "app", change: "updated", restart: true }],
      volumes: [{ key: "data", change: "unchanged" }],
      parameters: [{ key: "app_secret", change: "updated" }],
      ingress: [{ componentKey: "app", port: 8080, change: "unchanged" }],
      downtime: true, dataRisk: false,
    },
  ],
  ["logs", AppStackComponentLogsDtoSchema, { componentKey: "app", lines: [{ at: AT, stream: "stderr", text: "listening" }] }],
  ["health", AppStackComponentHealthDtoSchema, { componentKey: "app", health: "unknown", observedAt: AT, stale: true, source: "tcp" }],
];

// arch-api §5.3: every key of the §3/§4 response and input DTOs.
const KEYS = `valid issues parameters preview id slug name category description builtIn enabled archivedAt state defaultVersionId
defaultVersionNumber installations componentCount hasIngress hasVolumes updatedAt versionNumber specHash createdAt versions template
versionId created templateId source stacks organizationId organizationName status truncated cpuMilli memoryBytes volumeCount templates
categories ingress components key componentKey port hostname templateVersionId domains deploy revisionId planHash confirmName
destroyData parameterKey value limit cursor tail stackId operationId deploymentId links stack operation templateName
templateVersionNumber unhealthyCount primaryHostname activeOperationId revisionNumber health healthObservedAt dependsOn label
secretParameters required isSet version setAt volumes retentionPolicy upgrade rollback kind problem startedAt endedAt certificateStatus
certificateProblem certificateExpiresAt checkedAt fromRevisionId fromVersionNumber toTemplateVersionId toVersionNumber newRevision
change restart downtime dataRisk lines at stream text observedAt stale`.split(/\s+/);

describe("app API DTO keys pass the public-DTO and plaintext-secret guards", () => {
  it.each(SAMPLES)("%s: a full sample parses and has no forbidden key", (_name, schema, sample) => {
    const parsed = schema.parse(sample);
    expect(findForbiddenPublicDtoKeys(parsed)).toEqual([]);
    expect(findPlaintextSecretKeys(parsed)).toEqual([]);
  });

  it("the §5.3 key list has no forbidden key", () => {
    const all = Object.fromEntries(KEYS.map((key) => [key, "x"]));
    expect(findForbiddenPublicDtoKeys(all)).toEqual([]);
    expect(findPlaintextSecretKeys(all)).toEqual([]);
  });
});

const INPUTS: [string, z.ZodType, Record<string, unknown>, boolean][] = [
  ["validate", ValidateAppTemplateInputSchema, { source: "x" }, true],
  ["import compose", ImportComposeInputSchema, { compose: "services: {}", name: "Notes", category: "productivity" }, true],
  ["create template", CreateAppTemplateInputSchema, { slug: "notes-demo", source: "x" }, true],
  ["add version", AddAppTemplateVersionInputSchema, { source: "x" }, true],
  ["update template", UpdateAppTemplateInputSchema, { enabled: false }, true],
  ["archive", ArchiveAppTemplateInputSchema, {}, false],
  ["admin list query", AdminAppTemplateListQuerySchema, { state: "draft" }, false],
  ["create stack", CreateAppStackInputSchema, { templateVersionId: "atv_demo_1", name: "My notes", deploy: true }, true],
  ["deploy", DeployAppStackInputSchema, {}, false],
  ["action", AppStackActionInputSchema, {}, false],
  ["plan", PlanAppStackInputSchema, {}, false],
  ["upgrade", UpgradeAppStackInputSchema, { templateVersionId: "atv_demo_2", planHash: HASH }, true],
  ["rollback", RollbackAppStackInputSchema, { revisionId: "astr_1", planHash: HASH }, true],
  ["delete", DeleteAppStackInputSchema, { confirmName: "My notes", destroyData: false }, true],
  ["secret", SetAppStackSecretInputSchema, { parameterKey: "app_secret", value: "v" }, true],
  ["add domain", AddAppStackDomainInputSchema, { hostname: "notes.example.com", componentKey: "app", port: 8080 }, true],
  ["stack list query", AppStackListQuerySchema, { limit: "10" }, false],
  ["logs query", AppStackLogsQuerySchema, { tail: "10" }, false],
];

describe("app API input schemas", () => {
  it.each(INPUTS)("%s: strict, and {} refused when a field is required", (_name, schema, valid, hasRequired) => {
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(!hasRequired);
  });

  it("the template source is bounded by 65 536 UTF-8 bytes", () => {
    expect(AppTemplateSourceSchema.safeParse("a".repeat(65_536)).success).toBe(true);
    expect(AppTemplateSourceSchema.safeParse("a".repeat(65_537)).success).toBe(false);
    expect(AppTemplateSourceSchema.safeParse("é".repeat(32_768)).success).toBe(true);
    expect(AppTemplateSourceSchema.safeParse(`${"é".repeat(32_768)}a`).success).toBe(false);
    expect(AppTemplateSourceSchema.safeParse("").success).toBe(false);
  });

  it("a Compose file is bounded like a template source, and its name and category like a template's", () => {
    const parse = (input: unknown): boolean => ImportComposeInputSchema.safeParse(input).success;
    expect(parse({ compose: "a".repeat(65_536) })).toBe(true);
    expect(parse({ compose: "a".repeat(65_537) })).toBe(false);
    expect(parse({ compose: `${"é".repeat(32_768)}a` })).toBe(false);
    expect(parse({ compose: "" })).toBe(false);
    expect(parse({ compose: 1 })).toBe(false);
    expect(parse({ compose: "x", name: "n".repeat(81) })).toBe(false);
    expect(parse({ compose: "x", name: "a\u0000b" })).toBe(false);
    expect(parse({ compose: "x", category: "Not A Slug" })).toBe(false);
    expect(parse({ compose: "x", name: undefined })).toBe(true);
  });

  it("an import report holds at most 200 notes, each with a known level, a code in capitals and a bounded text", () => {
    const report = (count: number): unknown => ({ source: null, report: Array.from({ length: count }, () => NOTE), validation: null });
    expect(COMPOSE_IMPORT_REPORT_MAX).toBe(200);
    expect(ComposeImportDtoSchema.safeParse(report(200)).success).toBe(true);
    expect(ComposeImportDtoSchema.safeParse(report(201)).success).toBe(false);
    const note = (change: Record<string, unknown>): boolean => ComposeImportNoteDtoSchema.safeParse({ ...NOTE, ...change }).success;
    expect(note({})).toBe(true);
    expect(note({ path: "" })).toBe(true);
    expect(note({ level: "warning" })).toBe(false);
    expect(note({ code: "image_pinned" })).toBe(false);
    expect(note({ path: "p".repeat(513) })).toBe(false);
    expect(note({ message: "" })).toBe(false);
    expect(note({ message: "m".repeat(601) })).toBe(false);
    expect(note({ extra: 1 })).toBe(false);
  });

  it("a template update must change something", () => {
    expect(UpdateAppTemplateInputSchema.safeParse({}).success).toBe(false);
    expect(UpdateAppTemplateInputSchema.safeParse({ name: undefined }).success).toBe(false);
    expect(UpdateAppTemplateInputSchema.safeParse({ description: null }).success).toBe(true);
  });

  it("a plan previews a version or a revision, and a rollback takes no parameters", () => {
    const parameters = [{ key: "workers", value: 2 }];
    expect(PlanAppStackInputSchema.safeParse({ templateVersionId: "atv_demo_2", revisionId: "astr_1" }).success).toBe(false);
    expect(PlanAppStackInputSchema.safeParse({ revisionId: "astr_1", parameters }).success).toBe(false);
    expect(PlanAppStackInputSchema.safeParse({ templateVersionId: "atv_demo_2", parameters }).success).toBe(true);
    expect(PlanAppStackInputSchema.safeParse({ revisionId: "astr_1" }).success).toBe(true);
  });

  it("a stack create takes each hostname once, at most 8, normalised", () => {
    const base = { templateVersionId: "atv_demo_1", name: "My notes", deploy: false };
    const entry = (hostname: string) => ({ hostname, componentKey: "app", port: 8080 });
    expect(CreateAppStackInputSchema.safeParse({ ...base, domains: [entry("a.example.com"), entry("a.example.com")] }).success).toBe(false);
    expect(CreateAppStackInputSchema.safeParse({ ...base, domains: [entry("A.example.com"), entry("a.example.com")] }).success).toBe(false);
    const nine = Array.from({ length: 9 }, (_, i) => entry(`h${String(i)}.example.com`));
    expect(CreateAppStackInputSchema.safeParse({ ...base, domains: nine.slice(0, 8) }).success).toBe(true);
    expect(CreateAppStackInputSchema.safeParse({ ...base, domains: nine }).success).toBe(false);
    const parsed = CreateAppStackInputSchema.parse({ ...base, domains: [entry("Notes.Example.COM")] });
    expect(parsed.domains[0]?.hostname).toBe("notes.example.com");
    expect(parsed.parameters).toEqual([]);
  });

  it("the log tail is 1..500 written in decimal digits", () => {
    for (const tail of ["0", "501", "1e2", "", "-1", "1000"]) {
      expect(AppStackLogsQuerySchema.safeParse({ tail }).success, tail).toBe(false);
    }
    expect(AppStackLogsQuerySchema.parse({ tail: "500" })).toEqual({ tail: 500 });
    expect(AppStackLogsQuerySchema.parse({})).toEqual({});
  });

  it("a secret value is at most 16 384 characters and never echoed by the refusal", () => {
    const ok = SetAppStackSecretInputSchema.safeParse({ parameterKey: "app_secret", value: `Zq9${"x".repeat(16_381)}` });
    expect(ok.success).toBe(true);
    const value = `Zq9${"x".repeat(16_382)}`;
    const refused = SetAppStackSecretInputSchema.safeParse({ parameterKey: "app_secret", value });
    expect(refused.success).toBe(false);
    expect(refused.error?.message).not.toContain("Zq9");
    expect(JSON.stringify(refused.error?.issues)).not.toContain("Zq9");
  });

  it("a secret value with a NUL character is refused, as the executor would", () => {
    const refused = SetAppStackSecretInputSchema.safeParse({ parameterKey: "app_secret", value: "Zq9ab\u0000cd" });
    expect(refused.success).toBe(false);
    expect(JSON.stringify(refused.error?.issues)).not.toContain("Zq9");
  });

  it("a secret value refuses C0 controls but tab and line breaks, and unpaired surrogates, with the executor's rule", () => {
    const parse = (value: string) => SetAppStackSecretInputSchema.safeParse({ parameterKey: "app_secret", value });
    for (let unit = 0; unit < 0x20; unit += 1) {
      expect(parse(`Zq9${String.fromCharCode(unit)}`).success, String(unit)).toBe([0x09, 0x0a, 0x0d].includes(unit));
    }
    for (const value of ["Zq9\ud800", "\udfffZq9", "Zq9\udc00\ud800"]) {
      const refused = parse(value);
      expect(refused.success).toBe(false);
      expect(JSON.stringify(refused.error?.issues)).not.toContain("Zq9");
    }
    expect(parse("line 1\r\nline 2\u007f\u0085 \u{1f511}").success).toBe(true);
    expect(SetAppStackSecretInputSchema.shape.value).toBe(AppStackSecretFileContentSchema.shape.content);
  });

  it("template and stack names and descriptions refuse an unpaired surrogate, not a paired one", () => {
    for (const text of ["a\ud800", "\udc00a", "a\udc00\ud800b"]) {
      expect(UpdateAppTemplateInputSchema.safeParse({ name: text }).success, text).toBe(false);
      expect(UpdateAppTemplateInputSchema.safeParse({ description: text }).success, text).toBe(false);
      expect(CreateAppStackInputSchema.safeParse({ templateVersionId: "atv_demo_1", name: text, deploy: false }).success, text).toBe(false);
    }
    const paired = "Notes \u{1f4dd}";
    expect(UpdateAppTemplateInputSchema.safeParse({ name: paired, description: paired }).success).toBe(true);
    expect(CreateAppStackInputSchema.safeParse({ templateVersionId: "atv_demo_1", name: paired, deploy: false }).success).toBe(true);
  });
});

describe("contracts dist guard rules for the two DTO files", () => {
  const importsOf = (source: string): string[] =>
    [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g)].map(
      (m) => (m[1] ?? m[2]) as string,
    );

  it.each(["admin-dto.ts", "stack-dto.ts"])("%s imports only zod and relative files, with no dynamic import or require", (file) => {
    const source = readFileSync(new URL(`../src/app-templates/${file}`, import.meta.url), "utf8");
    const specifiers = importsOf(source);
    expect(specifiers.length).toBeGreaterThan(1);
    expect(specifiers.filter((s) => s !== "zod" && !s.startsWith("./") && !s.startsWith("../"))).toEqual([]);
    expect(source).not.toContain("import(");
    expect(source).not.toContain("require(");
  });
});
