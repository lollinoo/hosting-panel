import { z } from "zod";
import { DOMAIN_STATUSES } from "../resources.js";
import { CERT_STATUSES } from "../site-domains.js";
import { SiteDomainSchema } from "../site-runtime.js";
import { APP_STACK_HASH_PATTERN, APP_TEMPLATE_LIMITS, AppStackKeySchema, AppStackPortSchema, AppTemplateParameterKeySchema } from "./limits.js";
import { AppTemplateParameterEntriesSchema, AppTemplateParameterValueSchema } from "./parameters.js";
import { AppStackPlanIngressSchema } from "./plan.js";
import { AppTemplateParameterSchema } from "./spec.js";
import { AppEntityIdSchema } from "./stack-ids.js";
import { APP_STACK_LOG_TAIL_MAX, APP_STACK_SECRET_MIN_LENGTH, AppStackSecretFileContentSchema } from "./stack-ipc.js";
import { APP_STACK_ALLOWED_ACTION_KINDS, APP_STACK_OPERATION_KINDS, MAX_APP_STACK_DOMAINS } from "./stack-operations.js";
import { AppStackDomainRoutingDtoShape } from "./stack-routing.js";
import {
  APP_STACK_RETENTION_POLICIES,
  APP_STACK_VOLUME_STATUSES,
  AppStackComponentHealthSchema,
  AppStackDeploymentStatusSchema,
  AppStackStatusSchema,
} from "./stack-status.js";

const IsoDateTimeSchema = z.string().datetime({ offset: true });
const noControl = (s: string): boolean => !/[\p{Cc}\p{Cs}]/u.test(s);
const HashSchema = z.string().regex(APP_STACK_HASH_PATTERN);
const OperationIdSchema = z.string().min(1).max(128); // op_<32 hex>[-tN]
const MemoryBytesText = z.string().regex(/^[0-9]{1,20}$/); // decimal bytes, textual like the plan
const QueryText = z.string().max(256);

// ---- customer catalogue ----
export const CustomerAppTemplateSummaryDtoSchema = z.object({
  id: AppEntityIdSchema, // template id
  name: z.string(),
  description: z.string().nullable(),
  category: z.string(),
  versionId: AppEntityIdSchema, // the installable (default) version
  versionNumber: z.number().int().positive(),
  componentCount: z.number().int().positive(),
  cpuMilli: z.number().int().nonnegative(), // sum over spec.services
  memoryBytes: MemoryBytesText, // sum over spec.services
  volumeCount: z.number().int().nonnegative(),
  hasIngress: z.boolean(),
});
export type CustomerAppTemplateSummaryDto = z.infer<typeof CustomerAppTemplateSummaryDtoSchema>;
export const CustomerAppTemplatesDtoSchema = z.object({
  templates: z.array(CustomerAppTemplateSummaryDtoSchema), // ORDER BY lower(name), id
  categories: z.array(z.string()), // distinct categories of `templates`, sorted code-unit
});
export type CustomerAppTemplatesDto = z.infer<typeof CustomerAppTemplatesDtoSchema>;
export const CustomerAppTemplateDtoSchema = CustomerAppTemplateSummaryDtoSchema.extend({
  parameters: z.array(AppTemplateParameterSchema), // appTemplateInstallParameters: customer:true, never a generated secret; source order
  ingress: z.array(AppStackPlanIngressSchema), // {componentKey: service, port}, sorted
  components: z.array(z.object({ key: AppStackKeySchema, cpuMilli: z.number().int(), memoryBytes: MemoryBytesText })), // by key
});
export type CustomerAppTemplateDto = z.infer<typeof CustomerAppTemplateDtoSchema>;

// ---- inputs ----
export const AppStackNameSchema = z.string().trim().min(1).max(64).refine(noControl); // = 0025 CHECK 1..64
/** `compression: true` creates the address with compression on (ADR-0037 R4); left out, it is off. */
export const AppStackDomainEntrySchema = z
  .object({ hostname: SiteDomainSchema, componentKey: AppStackKeySchema, port: AppStackPortSchema, compression: z.boolean().optional() })
  .strict();
export type AppStackDomainEntry = z.infer<typeof AppStackDomainEntrySchema>;
export const CreateAppStackInputSchema = z
  .object({
    templateVersionId: AppEntityIdSchema,
    name: AppStackNameSchema,
    parameters: AppTemplateParameterEntriesSchema.default([]), // public values only; secrets go to …/secrets
    domains: z
      .array(AppStackDomainEntrySchema)
      .max(MAX_APP_STACK_DOMAINS)
      .default([])
      .refine((d) => new Set(d.map((e) => e.hostname)).size === d.length, { message: "Each web address once." }),
    deploy: z.boolean(), // false = draft (set secrets first, then deploy)
  })
  .strict();
export type CreateAppStackInput = z.infer<typeof CreateAppStackInputSchema>;
export const DeployAppStackInputSchema = z.object({ parameters: AppTemplateParameterEntriesSchema.optional() }).strict();
export type DeployAppStackInput = z.infer<typeof DeployAppStackInputSchema>;
/** start, stop, restart: an empty object (or no body). */
export const AppStackActionInputSchema = z.object({}).strict();
export const PlanAppStackInputSchema = z
  .object({
    templateVersionId: AppEntityIdSchema.optional(), // upgrade preview
    revisionId: AppEntityIdSchema.optional(), // rollback preview
    parameters: AppTemplateParameterEntriesSchema.optional(),
  })
  .strict()
  .refine((p) => !(p.templateVersionId !== undefined && p.revisionId !== undefined), { message: "Choose a version or a revision." })
  .refine((p) => !(p.revisionId !== undefined && p.parameters !== undefined), { message: "A rollback keeps the settings of that revision." });
export type PlanAppStackInput = z.infer<typeof PlanAppStackInputSchema>;
/** A private value an upgrade brings (issue #89): the same rule as SetAppStackSecretInputSchema, write-only alike, long
 *  enough for the log reader to mask (BUG-43). */
const UpgradeAppStackSecretSchema = z
  .object({ parameterKey: AppTemplateParameterKeySchema, value: AppStackSecretFileContentSchema.shape.content.min(APP_STACK_SECRET_MIN_LENGTH) })
  .strict();
export const UpgradeAppStackInputSchema = z
  .object({
    templateVersionId: AppEntityIdSchema,
    parameters: AppTemplateParameterEntriesSchema.optional(),
    planHash: HashSchema,
    // The required private values the target version brings and the application has none of (the plan's `newSecrets`).
    // Their values are never echoed, logged or hashed into a request hash: the hash covers their keys only.
    secrets: z
      .array(UpgradeAppStackSecretSchema)
      .max(APP_TEMPLATE_LIMITS.secretParameters)
      .refine((s) => new Set(s.map((e) => e.parameterKey)).size === s.length, { message: "Each private value once." })
      .optional(),
  })
  .strict();
export type UpgradeAppStackInput = z.infer<typeof UpgradeAppStackInputSchema>;
export const RollbackAppStackInputSchema = z.object({ revisionId: AppEntityIdSchema, planHash: HashSchema }).strict();
export type RollbackAppStackInput = z.infer<typeof RollbackAppStackInputSchema>;
export const DeleteAppStackInputSchema = z.object({ confirmName: z.string().max(64), destroyData: z.boolean() }).strict();
export type DeleteAppStackInput = z.infer<typeof DeleteAppStackInputSchema>;
/** Write-only. `value` is never echoed, logged, hashed into a request hash or stored outside app_stack_secrets. */
export const SetAppStackSecretInputSchema = z
  .object({
    parameterKey: AppTemplateParameterKeySchema,
    // The executor's rule, and a new value long enough for the log reader to mask (a stored shorter one still starts).
    value: AppStackSecretFileContentSchema.shape.content.min(APP_STACK_SECRET_MIN_LENGTH),
  })
  .strict();
export type SetAppStackSecretInput = z.infer<typeof SetAppStackSecretInputSchema>;
export const AddAppStackDomainInputSchema = AppStackDomainEntrySchema;
export const AppStackListQuerySchema = z.object({ limit: QueryText.optional(), cursor: QueryText.optional() }).strict();
export const APP_STACK_LOG_TAIL_DEFAULT = 200;
export const AppStackLogsQuerySchema = z
  .object({
    tail: z
      .string()
      .regex(/^[0-9]{1,3}$/)
      .transform(Number)
      .refine((n) => n >= 1 && n <= APP_STACK_LOG_TAIL_MAX, { message: "tail must be 1..500." })
      .optional(),
  })
  .strict();

// ---- responses ----
export const AppStackAcceptedDtoSchema = z.object({
  stackId: AppEntityIdSchema,
  operationId: OperationIdSchema.nullable(), // null only for a draft create
  deploymentId: AppEntityIdSchema.nullable(),
  status: AppStackStatusSchema, // the stack status after the request (replay: the current one)
});
export const AppStackAcceptedEnvelopeSchema = z.object({
  data: AppStackAcceptedDtoSchema,
  links: z.object({ stack: z.string(), operation: z.string().nullable() }),
});
export type AppStackAcceptedEnvelope = z.infer<typeof AppStackAcceptedEnvelopeSchema>;

export const AppStackSummaryDtoSchema = z.object({
  id: AppEntityIdSchema,
  name: z.string(),
  status: AppStackStatusSchema,
  templateId: AppEntityIdSchema,
  templateName: z.string(),
  templateVersionNumber: z.number().int().positive(),
  // the applied revision whenever it is not the desired one (a change running, a failure after create, a take-back
  // declined, a deploy with new settings that failed before create); the detail's status follows its plan
  installed: z.object({ revisionNumber: z.number().int().positive(), templateVersionNumber: z.number().int().positive() }).nullable(),
  componentCount: z.number().int().nonnegative(),
  unhealthyCount: z.number().int().nonnegative(), // effective health unhealthy or missing (stale reads as unknown)
  primaryHostname: z.string().nullable(), // first active domain by hostname, else first domain, else null
  updatedAt: IsoDateTimeSchema,
});
export type AppStackSummaryDto = z.infer<typeof AppStackSummaryDtoSchema>;
/** Work of the platform that holds an application's lock: the page says what it is, nothing else of it (ADR-0038). */
export const APP_STACK_PLATFORM_WORK = ["backups_cleanup"] as const;
export type AppStackPlatformWork = (typeof APP_STACK_PLATFORM_WORK)[number];
export const AppStackDetailDtoSchema = AppStackSummaryDtoSchema.extend({
  templateVersionId: AppEntityIdSchema,
  createdAt: IsoDateTimeSchema,
  activeOperationId: OperationIdSchema.nullable(), // the customer's own operation only
  platformWork: z.enum(APP_STACK_PLATFORM_WORK).nullable(), // the application is busy with work of the platform
  // what the stored status, the lock and this caller's permissions allow now (appStackAllowedActions); a request can
  // still be refused for a reason of its own; upgrade and rollback also need their target below; [] while an operation
  // holds the application
  allowedActions: z.array(z.enum(APP_STACK_ALLOWED_ACTION_KINDS)),
  outcomeUnknown: z.boolean(), // the stored status is `unknown`: the outcome of an operation is not known (not a stale reading)
  revisionNumber: z.number().int().positive().nullable(), // desired revision; null for a draft
  // desired plan order; a draft: spec services by key
  components: z.array(
    z.object({
      key: AppStackKeySchema,
      health: AppStackComponentHealthSchema, // effective: stale → unknown
      healthObservedAt: IsoDateTimeSchema.nullable(),
      dependsOn: z.array(AppStackKeySchema),
      ingress: z.boolean(),
      cpuMilli: z.number().int(),
      memoryBytes: MemoryBytesText,
    }),
  ),
  parameters: z.array(z.object({ key: AppTemplateParameterKeySchema, label: z.string(), value: AppTemplateParameterValueSchema })),
  secretParameters: z.array(
    z.object({
      key: AppTemplateParameterKeySchema,
      label: z.string(),
      required: z.boolean(),
      isSet: z.boolean(),
      version: z.number().int().positive().nullable(),
      setAt: IsoDateTimeSchema.nullable(),
    }),
  ),
  volumes: z.array(
    z.object({ key: AppStackKeySchema, status: z.enum(APP_STACK_VOLUME_STATUSES), retentionPolicy: z.enum(APP_STACK_RETENTION_POLICIES) }),
  ),
  ingress: z.array(AppStackPlanIngressSchema),
  pathTargets: z.array(AppStackPlanIngressSchema), // ADR-0037: what a path rule may point at now (the plan that runs and the desired one)
  routesPending: z.boolean(), // ADR-0037: the saved addresses/options are not what the last published route file holds
  cpuMilli: z.number().int().nonnegative(),
  memoryBytes: MemoryBytesText,
  upgrade: z.object({ templateVersionId: AppEntityIdSchema, versionNumber: z.number().int().positive() }).nullable(),
  rollback: z
    .object({ revisionId: AppEntityIdSchema, revisionNumber: z.number().int().positive(), templateVersionNumber: z.number().int().positive() })
    .nullable(),
});
export type AppStackDetailDto = z.infer<typeof AppStackDetailDtoSchema>;
export const AppStackSecretStateDtoSchema = z.object({
  key: AppTemplateParameterKeySchema,
  isSet: z.literal(true),
  version: z.number().int().positive(),
  setAt: IsoDateTimeSchema,
});
export type AppStackSecretStateDto = z.infer<typeof AppStackSecretStateDtoSchema>;
export const AppStackDeploymentDtoSchema = z.object({
  id: AppEntityIdSchema,
  operationId: OperationIdSchema,
  kind: z.enum(APP_STACK_OPERATION_KINDS),
  revisionNumber: z.number().int().positive().nullable(),
  status: AppStackDeploymentStatusSchema,
  problem: z.string().nullable(), // UPPER_SNAKE reason or ErrorCode, never text
  startedAt: IsoDateTimeSchema,
  endedAt: IsoDateTimeSchema.nullable(),
});
export type AppStackDeploymentDto = z.infer<typeof AppStackDeploymentDtoSchema>;
export const AppStackDomainDtoSchema = z.object({
  id: AppEntityIdSchema,
  hostname: z.string(),
  componentKey: AppStackKeySchema,
  port: z.number().int(),
  status: z.enum(DOMAIN_STATUSES),
  certificateStatus: z.enum(CERT_STATUSES),
  certificateProblem: z.string().nullable(),
  certificateExpiresAt: IsoDateTimeSchema.nullable(),
  checkedAt: IsoDateTimeSchema.nullable(), // dns_checked_at
  ...AppStackDomainRoutingDtoShape, // ADR-0037
});
export type AppStackDomainDto = z.infer<typeof AppStackDomainDtoSchema>;
export const APP_STACK_DIFF_CHANGES = ["added", "updated", "removed", "unchanged"] as const;
const Change = z.enum(APP_STACK_DIFF_CHANGES);
export const AppStackPlanDiffDtoSchema = z.object({
  planHash: HashSchema, // what upgrade/rollback must echo back
  fromRevisionId: AppEntityIdSchema.nullable(),
  fromVersionNumber: z.number().int().positive().nullable(),
  toTemplateVersionId: AppEntityIdSchema,
  toVersionNumber: z.number().int().positive(),
  newRevision: z.boolean(), // false: deploy would redeploy the desired revision as is
  components: z.array(z.object({ key: AppStackKeySchema, change: Change, restart: z.boolean() })),
  volumes: z.array(z.object({ key: AppStackKeySchema, change: Change })), // "removed" = no longer mounted, data kept
  parameters: z.array(z.object({ key: AppTemplateParameterKeySchema, change: Change })), // names only, secrets included (not the ones the customer never sees)
  // upgrade: the required private values the customer types that the new version brings and the application has none
  // of; the upgrade must carry them. Empty for a deploy and a rollback.
  newSecrets: z.array(z.object({ key: AppTemplateParameterKeySchema, label: z.string() })),
  ingress: z.array(z.object({ componentKey: AppStackKeySchema, port: z.number().int(), change: Change })),
  downtime: z.boolean(),
  dataRisk: z.boolean(),
});
export type AppStackPlanDiffDto = z.infer<typeof AppStackPlanDiffDtoSchema>;
export const AppStackLogLineDtoSchema = z.object({
  at: IsoDateTimeSchema.nullable(),
  stream: z.enum(["stdout", "stderr"]),
  text: z.string(),
});
export const AppStackComponentLogsDtoSchema = z.object({ componentKey: AppStackKeySchema, lines: z.array(AppStackLogLineDtoSchema) });
export type AppStackComponentLogsDto = z.infer<typeof AppStackComponentLogsDtoSchema>;
export const AppStackComponentHealthDtoSchema = z.object({
  componentKey: AppStackKeySchema,
  health: AppStackComponentHealthSchema, // effective
  observedAt: IsoDateTimeSchema.nullable(),
  stale: z.boolean(), // the stored observation is older than APP_STACK_HEALTH_STALE_AFTER_MS
  source: z.enum(["tcp", "http", "running_state"]), // the plan's healthcheck kind; running_state when it declares none
});
export type AppStackComponentHealthDto = z.infer<typeof AppStackComponentHealthDtoSchema>;
