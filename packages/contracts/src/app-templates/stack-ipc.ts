import { z } from "zod";
import type { ErrorCode } from "../errors.js";
import { SiteHostRouteSchema } from "../ipc-schemas.js";
import { APP_STACK_IMAGE_LOOKUP_MAX_LENGTH, APP_STACK_IMAGE_LOOKUP_PATTERN, APP_STACK_PLAN_IMAGE_PATTERN } from "./images.js";
import {
  APP_STACK_DIGEST_PATTERN,
  APP_STACK_HASH_PATTERN,
  APP_TEMPLATE_LIMITS,
  AppStackKeySchema,
  AppStackPortSchema,
  AppTemplateParameterKeySchema,
} from "./limits.js";
import { ApprovedStackPlanSchema } from "./plan.js";
import { AppEntityIdSchema, AppForeignIdSchema } from "./stack-ids.js";
import { MAX_APP_STACK_DOMAINS } from "./stack-operations.js";

/** Chars of one secret file (= setAppStackSecretTransactional bound). */
export const APP_STACK_SECRET_CONTENT_MAX_CHARS = 16_384;
/** Lines per log read (= ServiceLogsIpcRequestSchema tail bound). */
export const APP_STACK_LOG_TAIL_MAX = 500;
/** Label io.hostingpanel.network_role of the stack networks. Never site_internal / site_edge. */
export const APP_STACK_NETWORK_ROLES = ["app_internal", "app_edge"] as const;
export type AppStackNetworkRole = (typeof APP_STACK_NETWORK_ROLES)[number];

/** details[0].reason of every executor refusal of the stack routes. Four names are spec §16 ones (APP_STACK_REASONS). */
export const APP_STACK_EXECUTOR_REASONS = [
  "STACK_PLAN_INVALID",
  "STACK_PLAN_HASH_MISMATCH",
  "STACK_IMAGE_NOT_ALLOWED",
  "STACK_IMAGE_PULL_FAILED",
  "STACK_IMAGE_DIGEST_MISMATCH",
  "STACK_IMAGE_MISSING",
  "STACK_SECRET_MISSING",
  "STACK_NAMESPACE_CONFLICT",
  "STACK_COMPONENT_NOT_READY",
  "STACK_VOLUME_IN_USE",
  "STACK_BUSY",
  "STACK_UNSUPPORTED_FEATURE",
] as const;
export type AppStackExecutorReason = (typeof APP_STACK_EXECUTOR_REASONS)[number];
export const AppStackExecutorReasonSchema = z.enum(APP_STACK_EXECUTOR_REASONS);
export const APP_STACK_EXECUTOR_REASON_CODES: Readonly<Record<AppStackExecutorReason, ErrorCode>> = Object.freeze({
  STACK_PLAN_INVALID: "VALIDATION_ERROR", // schema/refine failure, image or entry not in the plan, route not in plan.ingress
  STACK_PLAN_HASH_MISMATCH: "HOST_POLICY_DENIED", // computeAppStackPlanHash(plan) !== plan.planHash
  STACK_IMAGE_NOT_ALLOWED: "HOST_POLICY_DENIED", // appStackPlanImageProblems non-empty, before any Engine call
  STACK_IMAGE_PULL_FAILED: "DOCKER_ENGINE_UNAVAILABLE", // pull HTTP error or "error" line in the 200 stream
  STACK_IMAGE_DIGEST_MISMATCH: "HOST_POLICY_DENIED", // local image has no RepoDigests entry for the plan digest
  STACK_IMAGE_MISSING: "NOT_FOUND", // image not local (create, or pull with pullMissingImages false)
  STACK_SECRET_MISSING: "VALIDATION_ERROR", // a (parameterKey, version) the component pins has no content entry
  STACK_NAMESPACE_CONFLICT: "HOST_POLICY_DENIED", // a derived name or a stack_id label belongs to something not ours
  STACK_COMPONENT_NOT_READY: "RESOURCE_LOCKED", // needed resource missing, dependency or route target not running, other plan
  STACK_VOLUME_IN_USE: "RESOURCE_LOCKED", // volume delete answered 409
  STACK_BUSY: "RESOURCE_LOCKED", // another mutating call for this stack is running in this executor
  STACK_UNSUPPORTED_FEATURE: "VALIDATION_ERROR", // route host with source "manual" or a redirectTo
});

/** C0 controls but tab and line breaks, and unpaired surrogates: 6 bytes each in JSON, so the start body stays < 1 MiB. */
// eslint-disable-next-line no-control-regex
const SECRET_FORBIDDEN_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\p{Cs}]/u;
export const AppStackSecretFileContentSchema = z
  .object({
    parameterKey: AppTemplateParameterKeySchema,
    version: z.number().int().min(1).max(APP_TEMPLATE_LIMITS.secretVersionMax),
    content: z
      .string()
      .min(1)
      .max(APP_STACK_SECRET_CONTENT_MAX_CHARS)
      .refine((v) => !SECRET_FORBIDDEN_CHARACTER.test(v), "Secret contains a control character or an unpaired surrogate"),
  })
  .strict();
export type AppStackSecretFileContent = z.infer<typeof AppStackSecretFileContentSchema>;
/** Transient: start/restart, and create for environment secrets; never persisted, logged or echoed. */
export const AppStackSecretFileContentsSchema = z
  .array(AppStackSecretFileContentSchema)
  .max(APP_TEMPLATE_LIMITS.secretParameters)
  .superRefine((items, ctx) => {
    const seen = new Set<string>();
    items.forEach(({ parameterKey }, index) => {
      if (seen.has(parameterKey)) ctx.addIssue({ code: "custom", path: [index, "parameterKey"], message: "Duplicate secret entry" });
      seen.add(parameterKey);
    });
  });

/** prepare. */
export const AppStackPlanIpcRequestSchema = z.object({ plan: ApprovedStackPlanSchema }).strict();
export type AppStackPlanIpcRequest = z.infer<typeof AppStackPlanIpcRequestSchema>;
/** create. `secretContents` is sent only for a plan with environment secrets (version 2): one entry per secret the
 *  environment of some component references. Transient like `secretFileContents`: never persisted, logged or echoed. */
export const AppStackCreateIpcRequestSchema = z
  .object({ plan: ApprovedStackPlanSchema, secretContents: AppStackSecretFileContentsSchema.optional() })
  .strict();
export type AppStackCreateIpcRequest = z.infer<typeof AppStackCreateIpcRequestSchema>;
/** Tag to digest for the Compose importer: "[registry/]repository[:tag]", no digest, no credentials. */
export const AppStackImageResolveIpcRequestSchema = z
  .object({ image: z.string().min(1).max(APP_STACK_IMAGE_LOOKUP_MAX_LENGTH).regex(APP_STACK_IMAGE_LOOKUP_PATTERN) })
  .strict();
export type AppStackImageResolveIpcRequest = z.infer<typeof AppStackImageResolveIpcRequestSchema>;
export const AppStackImageResolveIpcResultSchema = z
  .object({
    image: z.string().min(1).max(APP_STACK_IMAGE_LOOKUP_MAX_LENGTH).regex(APP_STACK_IMAGE_LOOKUP_PATTERN),
    /** The registry's digest of that reference (the index digest of a multi-platform image). */
    digest: z.string().regex(APP_STACK_DIGEST_PATTERN),
  })
  .strict();
export type AppStackImageResolveIpcResult = z.infer<typeof AppStackImageResolveIpcResultSchema>;
export const AppStackPullIpcRequestSchema = z
  .object({ plan: ApprovedStackPlanSchema, image: z.string().regex(APP_STACK_PLAN_IMAGE_PATTERN) })
  .strict();
export type AppStackPullIpcRequest = z.infer<typeof AppStackPullIpcRequestSchema>;
/** start, restart. */
export const AppStackComponentIpcRequestSchema = z
  .object({ plan: ApprovedStackPlanSchema, componentKey: AppStackKeySchema, secretFileContents: AppStackSecretFileContentsSchema })
  .strict();
export type AppStackComponentIpcRequest = z.infer<typeof AppStackComponentIpcRequestSchema>;
/** stop, unpublish, status. */
export const AppStackRefIpcRequestSchema = z.object({ stackId: AppEntityIdSchema, organizationId: AppForeignIdSchema }).strict();
export type AppStackRefIpcRequest = z.infer<typeof AppStackRefIpcRequestSchema>;
export const AppStackRemoveIpcRequestSchema = AppStackRefIpcRequestSchema.extend({ removeVolumes: z.boolean() }).strict();
export type AppStackRemoveIpcRequest = z.infer<typeof AppStackRemoveIpcRequestSchema>;
/** Upgrade/rollback cleanup: only these containers; the keys need not be in the plan. */
export const AppStackComponentsRemoveIpcRequestSchema = z
  .object({
    plan: ApprovedStackPlanSchema,
    componentKeys: z
      .array(AppStackKeySchema)
      .min(1)
      .max(APP_TEMPLATE_LIMITS.services)
      .refine((keys) => new Set(keys).size === keys.length, "Duplicate component key"),
  })
  .strict();
export type AppStackComponentsRemoveIpcRequest = z.infer<typeof AppStackComponentsRemoveIpcRequestSchema>;
export const AppStackLogsIpcRequestSchema = AppStackRefIpcRequestSchema.extend({
  componentKey: AppStackKeySchema,
  tail: z.number().int().min(1).max(APP_STACK_LOG_TAIL_MAX),
}).strict();
export type AppStackLogsIpcRequest = z.infer<typeof AppStackLogsIpcRequestSchema>;
export const AppStackRouteWireSchema = z
  .object({
    componentKey: AppStackKeySchema,
    internalPort: AppStackPortSchema,
    hosts: z.array(SiteHostRouteSchema.strict()).min(1).max(MAX_APP_STACK_DOMAINS),
  })
  .strict();
export type AppStackRouteWire = z.infer<typeof AppStackRouteWireSchema>;
/** The full route set of the stack; [] equals unpublish. */
export const AppStackRoutesIpcRequestSchema = z
  .object({ plan: ApprovedStackPlanSchema, routes: z.array(AppStackRouteWireSchema).max(APP_TEMPLATE_LIMITS.ingress) })
  .strict()
  .superRefine(({ routes }, ctx) => {
    const pairs = new Set<string>();
    const hostnames = new Set<string>();
    let total = 0;
    routes.forEach((route, index) => {
      const pair = `${route.componentKey}:${String(route.internalPort)}`;
      if (pairs.has(pair)) ctx.addIssue({ code: "custom", path: ["routes", index], message: "Duplicate route" });
      pairs.add(pair);
      route.hosts.forEach(({ hostname }, hostIndex) => {
        if (hostnames.has(hostname)) {
          ctx.addIssue({ code: "custom", path: ["routes", index, "hosts", hostIndex, "hostname"], message: "Duplicate hostname" });
        }
        hostnames.add(hostname);
      });
      total += route.hosts.length;
    });
    if (total > MAX_APP_STACK_DOMAINS) ctx.addIssue({ code: "custom", path: ["routes"], message: "Too many hostnames" });
  });
export type AppStackRoutesIpcRequest = z.infer<typeof AppStackRoutesIpcRequestSchema>;

export const AppStackPullIpcResultSchema = z
  .object({ image: z.string().regex(APP_STACK_PLAN_IMAGE_PATTERN), pulled: z.boolean() })
  .strict();
export type AppStackPullIpcResult = z.infer<typeof AppStackPullIpcResultSchema>;
export const AppStackPrepareIpcResultSchema = z
  .object({
    networks: z
      .array(z.object({ role: z.enum(APP_STACK_NETWORK_ROLES), created: z.boolean() }).strict())
      .max(APP_STACK_NETWORK_ROLES.length),
    /** Plan order. */
    volumes: z
      .array(z.object({ volumeKey: AppStackKeySchema, created: z.boolean() }).strict())
      .max(APP_TEMPLATE_LIMITS.volumes),
  })
  .strict();
export type AppStackPrepareIpcResult = z.infer<typeof AppStackPrepareIpcResultSchema>;
export const APP_STACK_CREATE_OUTCOMES = ["created", "replaced", "unchanged"] as const;
export const AppStackCreateIpcResultSchema = z
  .object({
    /** Plan order. */
    components: z
      .array(z.object({ componentKey: AppStackKeySchema, outcome: z.enum(APP_STACK_CREATE_OUTCOMES) }).strict())
      .max(APP_TEMPLATE_LIMITS.services),
    /** Keys no longer in the plan, ascending. */
    removedComponents: z.array(AppStackKeySchema).max(64),
  })
  .strict();
export type AppStackCreateIpcResult = z.infer<typeof AppStackCreateIpcResultSchema>;
export const APP_STACK_COMPONENT_OUTCOMES = ["started", "already_running", "restarted"] as const;
export const AppStackComponentActionIpcResultSchema = z
  .object({ componentKey: AppStackKeySchema, outcome: z.enum(APP_STACK_COMPONENT_OUTCOMES) })
  .strict();
export type AppStackComponentActionIpcResult = z.infer<typeof AppStackComponentActionIpcResultSchema>;
export const AppStackStopIpcResultSchema = z
  .object({
    /** Stop order. */
    components: z
      .array(z.object({ componentKey: AppStackKeySchema, outcome: z.enum(["stopped", "already_stopped"]) }).strict())
      .max(64),
  })
  .strict();
export type AppStackStopIpcResult = z.infer<typeof AppStackStopIpcResultSchema>;
export const AppStackRoutesIpcResultSchema = z
  .object({
    routeCount: z.number().int().min(0).max(APP_TEMPLATE_LIMITS.ingress),
    /** Ascending. */
    hostnames: z.array(z.string().min(1).max(253)).max(MAX_APP_STACK_DOMAINS),
    /** The file was written or removed. */
    changed: z.boolean(),
  })
  .strict();
export type AppStackRoutesIpcResult = z.infer<typeof AppStackRoutesIpcResultSchema>;
export const AppStackComponentsRemoveIpcResultSchema = z
  .object({
    /** Keys actually removed, ascending (absent ones skipped). */
    removedComponents: z.array(AppStackKeySchema).max(APP_TEMPLATE_LIMITS.services),
  })
  .strict();
export type AppStackComponentsRemoveIpcResult = z.infer<typeof AppStackComponentsRemoveIpcResultSchema>;
export const AppStackRemoveIpcResultSchema = z
  .object({
    removedComponents: z.array(AppStackKeySchema).max(64),
    removedNetworks: z.array(z.enum(APP_STACK_NETWORK_ROLES)).max(APP_STACK_NETWORK_ROLES.length),
    removedVolumes: z.array(AppStackKeySchema).max(64),
    retainedVolumes: z.array(AppStackKeySchema).max(64),
  })
  .strict();
export type AppStackRemoveIpcResult = z.infer<typeof AppStackRemoveIpcResultSchema>;

export const APP_STACK_CONTAINER_STATES = ["created", "running", "restarting", "exited", "dead"] as const;
/** A running component without a health check is healthy; starting/unknown/missing are the API's judgement. */
export const APP_STACK_OBSERVED_HEALTH = ["healthy", "unhealthy", "stopped"] as const;
export const APP_STACK_PROBE_OUTCOMES = ["passed", "failed", "none", "not_run"] as const;
export const AppStackComponentObservationSchema = z
  .object({
    componentKey: AppStackKeySchema,
    state: z.enum(APP_STACK_CONTAINER_STATES),
    health: z.enum(APP_STACK_OBSERVED_HEALTH),
    probe: z.enum(APP_STACK_PROBE_OUTCOMES),
    /** Label app_component_hash; null when malformed. */
    componentHash: z.string().regex(APP_STACK_HASH_PATTERN).nullable(),
    /** Label app_revision_id: the revision that created the container. */
    revisionId: AppEntityIdSchema.nullable(),
    startedAt: z.string().datetime({ offset: true }).nullable(),
    restartCount: z.number().int().min(0),
    exitCode: z.number().int().nullable(),
    oomKilled: z.boolean(),
  })
  .strict();
export type AppStackComponentObservation = z.infer<typeof AppStackComponentObservationSchema>;
export const AppStackStatusIpcResultSchema = z
  .object({
    stackId: AppEntityIdSchema,
    observedAt: z.string().datetime({ offset: true }),
    /** Observed containers only, by componentKey ascending. */
    components: z.array(AppStackComponentObservationSchema).max(64),
    networks: z.object({ internal: z.boolean(), edge: z.boolean() }).strict(),
    /** Observed volume keys, ascending. */
    volumes: z.array(AppStackKeySchema).max(64),
    routes: z
      .object({ published: z.boolean(), hostnames: z.array(z.string().min(1).max(253)).max(MAX_APP_STACK_DOMAINS) })
      .strict(),
  })
  .strict();
export type AppStackStatusIpcResult = z.infer<typeof AppStackStatusIpcResultSchema>;
export const AppStackLogLineWireSchema = z
  .object({
    at: z.string().nullable(),
    stream: z.enum(["stdout", "stderr"]),
    /** 2000-char lines plus masking growth. */
    text: z.string().max(4_096),
  })
  .strict();
export type AppStackLogLineWire = z.infer<typeof AppStackLogLineWireSchema>;
export const AppStackLogsIpcResultSchema = z.array(AppStackLogLineWireSchema).max(APP_STACK_LOG_TAIL_MAX);
