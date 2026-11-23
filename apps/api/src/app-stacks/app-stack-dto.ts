import {
  effectiveComponentHealth,
  sumAppStackPlanResources,
  type AppStackAcceptedEnvelope,
  type AppStackBackupDto,
  type AppStackDeploymentDto,
  type AppStackDetailDto,
  type AppStackDomainDto,
  type AppStackOperationKind,
  type AppStackSummaryDto,
  type AppTemplateSpec,
  type ApprovedStackPlan,
} from "@hosting-panel/contracts";
import type {
  AppStackBackupCopyRow,
  AppStackBackupRow,
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
import { appStackDisplayStatus } from "./app-stack-runtime-policy.js";

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
    secretParameters: spec.parameters.flatMap((p) => {
      if (p.type !== "secret") return [];
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

/**
 * What the customer sees of a backup: whether each copy is good, never where it is. `presentVolumeKeys` are the data
 * volumes the application holds now: a backup none of whose data belongs to it any more cannot be restored.
 */
export function appStackBackupDto(
  row: AppStackBackupRow,
  copies: readonly AppStackBackupCopyRow[],
  presentVolumeKeys: ReadonlySet<string>,
): AppStackBackupDto {
  const good = (row.status === "succeeded" || row.status === "partial") && copies.some((copy) => copy.status === "succeeded");
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    problem: row.problem,
    sizeBytes: row.sizeBytes,
    volumeKeys: row.volumeKeys,
    copies: copies.map((copy) => ({ priority: copy.priority, status: copy.status, problem: copy.problem })),
    startedAt: row.startedAt.toISOString(),
    finishedAt: iso(row.finishedAt),
    restore: row.restoreStatus === null ? null : { status: row.restoreStatus, problem: row.restoreProblem, at: iso(row.restoredAt) },
    restorable: good && row.volumeKeys.some((key) => presentVolumeKeys.has(key)),
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
