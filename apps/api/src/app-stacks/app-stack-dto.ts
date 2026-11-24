import {
  effectiveComponentHealth,
  sumAppStackPlanResources,
  type AppStackAcceptedEnvelope,
  type AppStackDeploymentDto,
  type AppStackDetailDto,
  type AppStackDomainDto,
  type AppStackOperationKind,
  type AppStackSummaryDto,
  type AppTemplateSpec,
  type ApprovedStackPlan,
} from "@hosting-panel/contracts";
import type {
  AppStackComponentRow,
  AppStackDeploymentRow,
  AppStackDomainRow,
  AppStackParameterRow,
  AppStackRevisionRow,
  AppStackRow,
  AppStackSecretMetadata,
  AppStackVolumeRow,
  AppStackWriteResult,
} from "@hosting-panel/database";
import { appStackDisplayStatus, appStackRoutesPending } from "./app-stack-runtime-policy.js";

const iso = (at: Date | null): string | null => at?.toISOString() ?? null;
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function componentHealth(row: AppStackComponentRow | undefined, now: Date) {
  return {
    health: row ? effectiveComponentHealth(row.health, row.healthObservedAt, now) : ("unknown" as const),
    healthObservedAt: iso(row?.healthObservedAt ?? null),
  };
}

export function appStackSummaryDto(input: {
  stack: AppStackRow;
  templateName: string;
  templateVersionNumber: number;
  components: readonly AppStackComponentRow[];
  domains: readonly AppStackDomainRow[];
  now: Date;
}): AppStackSummaryDto {
  const { stack, components, now } = input;
  const domains = [...input.domains].sort((a, b) => byText(a.hostname, b.hostname));
  return {
    id: stack.id,
    name: stack.name,
    status: stack.status,
    templateId: stack.templateId,
    templateName: input.templateName,
    templateVersionNumber: input.templateVersionNumber,
    componentCount: components.length,
    unhealthyCount: components.filter((c) => ["unhealthy", "missing"].includes(componentHealth(c, now).health)).length,
    primaryHostname: (domains.find((d) => d.status === "active") ?? domains[0])?.hostname ?? null,
    updatedAt: stack.updatedAt.toISOString(),
  };
}

export function appStackDetailDto(input: {
  stack: AppStackRow;
  templateName: string;
  templateVersionNumber: number;
  spec: AppTemplateSpec;
  desired: { revision: AppStackRevisionRow; plan: ApprovedStackPlan } | null;
  /** The plan of the revision that runs, whose routes are published; null when none was applied. */
  appliedPlan: ApprovedStackPlan | null;
  components: readonly AppStackComponentRow[];
  volumes: readonly AppStackVolumeRow[];
  domains: readonly AppStackDomainRow[];
  parameters: readonly AppStackParameterRow[];
  secrets: readonly AppStackSecretMetadata[];
  activeOperationId: string | null;
  upgrade: { templateVersionId: string; versionNumber: number } | null;
  rollback: { revisionId: string; revisionNumber: number; templateVersionNumber: number } | null;
  now: Date;
}): AppStackDetailDto {
  const { stack, spec, desired, now } = input;
  const rows = new Map(input.components.map((c) => [c.componentKey, c]));
  const plan = desired?.plan ?? null;
  const ingress = plan
    ? plan.ingress
    : spec.ingress
        .map(({ service, port }) => ({ componentKey: service, port }))
        .sort((a, b) => byText(a.componentKey, b.componentKey) || a.port - b.port);
  const components = plan
    ? plan.components.map((c) => ({ key: c.key, dependsOn: c.dependsOn, resources: c.resources }))
    : [...spec.services].sort((a, b) => byText(a.key, b.key)).map((s) => ({ key: s.key, dependsOn: s.dependsOn, resources: s.limits }));
  const totals = plan
    ? sumAppStackPlanResources(plan)
    : {
        cpuMilli: spec.services.reduce((sum, s) => sum + s.limits.cpuMilli, 0),
        memoryBytes: spec.services.reduce((sum, s) => sum + BigInt(s.limits.memoryBytes), BigInt(0)).toString(),
      };
  const publicParameters = new Map(spec.parameters.filter((p) => p.type !== "secret").map((p) => [p.key, p.label]));
  const latestSecrets = new Map<string, AppStackSecretMetadata>();
  for (const meta of input.secrets) {
    if ((latestSecrets.get(meta.parameterKey)?.version ?? 0) < meta.version) latestSecrets.set(meta.parameterKey, meta);
  }
  const applied = desired !== null && desired.revision.id === stack.appliedRevisionId ? desired.plan : null;
  return {
    ...appStackSummaryDto(input),
    status: appStackDisplayStatus({ stack, plan: applied, components: input.components, domainCount: input.domains.length, now }),
    templateVersionId: stack.templateVersionId,
    createdAt: stack.createdAt.toISOString(),
    activeOperationId: input.activeOperationId,
    revisionNumber: desired?.revision.revisionNumber ?? null,
    components: components.map((c) => ({
      key: c.key,
      ...componentHealth(rows.get(c.key), now),
      dependsOn: c.dependsOn,
      ingress: ingress.some((i) => i.componentKey === c.key),
      cpuMilli: c.resources.cpuMilli,
      memoryBytes: c.resources.memoryBytes,
    })),
    parameters: input.parameters
      .flatMap((row) => {
        const label = publicParameters.get(row.parameterKey);
        return label === undefined ? [] : [{ key: row.parameterKey, label, value: row.publicValue }];
      })
      .sort((a, b) => byText(a.key, b.key)),
    // A secret the platform generated and the customer may not replace (ADR-0036) is not listed.
    secretParameters: spec.parameters.flatMap((p) => {
      if (p.type !== "secret" || !p.customer) return [];
      const meta = latestSecrets.get(p.key);
      return [
        {
          key: p.key,
          label: p.label,
          required: p.required,
          isSet: meta !== undefined,
          version: meta?.version ?? null,
          setAt: iso(meta?.rotatedAt ?? null),
        },
      ];
    }),
    volumes: input.volumes.map((v) => ({ key: v.volumeKey, status: v.status, retentionPolicy: v.retentionPolicy })),
    ingress,
    // A path must point at an entry point of the plan that runs too (the API refuses any other).
    pathTargets: ingress.filter((i) => input.appliedPlan?.ingress.some((a) => a.componentKey === i.componentKey && a.port === i.port) ?? true),
    routesPending: appStackRoutesPending({
      domains: input.domains,
      appliedRoutesHash: stack.appliedRoutesHash,
      appliedAddressesHash: stack.appliedAddressesHash,
    }),
    cpuMilli: totals.cpuMilli,
    memoryBytes: totals.memoryBytes,
    upgrade: input.upgrade,
    rollback: input.rollback,
  };
}

export function appStackDomainDto(row: AppStackDomainRow): AppStackDomainDto {
  return {
    id: row.id,
    hostname: row.hostname,
    componentKey: row.componentKey,
    port: row.internalPort,
    status: row.status,
    certificateStatus: row.certStatus,
    certificateProblem: row.certProblem,
    certificateExpiresAt: iso(row.certExpiresAt),
    checkedAt: iso(row.dnsCheckedAt),
    redirectToDomainId: row.redirectToDomainId,
    compression: row.compression,
    // The user name only: the verifier of the password stays in the row.
    protection: row.accessUsername === null ? null : { username: row.accessUsername },
    pathRoutes: row.pathRoutes.map((path) => ({
      pathPrefix: path.pathPrefix,
      componentKey: path.componentKey,
      port: path.port,
      stripPrefix: path.stripPrefix,
    })),
  };
}

export function appStackDeploymentDto(
  row: AppStackDeploymentRow,
  kind: AppStackOperationKind,
  revisionNumber: number | null,
): AppStackDeploymentDto {
  return {
    id: row.id,
    operationId: row.operationId,
    kind,
    revisionNumber,
    status: row.status,
    problem: row.problem,
    startedAt: row.startedAt.toISOString(),
    endedAt: iso(row.endedAt),
  };
}

export function appStackAcceptedEnvelope(organizationId: string, r: AppStackWriteResult): AppStackAcceptedEnvelope {
  const operationId = r.operation?.id ?? null;
  return {
    data: { stackId: r.stack.id, operationId, deploymentId: r.deployment?.id ?? null, status: r.stack.status },
    links: {
      stack: `/v1/organizations/${organizationId}/app-stacks/${r.stack.id}`,
      operation: operationId === null ? null : `/v1/organizations/${organizationId}/operations/${operationId}`,
    },
  };
}

/** Audit details of a new address; `compression` is named only when the address is created with it on (ADR-0037). */
export function assignedAddressDetails(row: AppStackDomainRow): Record<string, unknown> {
  return {
    domainId: row.id,
    hostname: row.hostname,
    componentKey: row.componentKey,
    internalPort: row.internalPort,
    ...(row.compression ? { compression: true } : {}),
  };
}
