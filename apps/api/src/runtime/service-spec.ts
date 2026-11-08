import {
  SECRET_KEY_PATTERN,
  type ServiceVolumeMountSpec,
} from "@hosting-panel/contracts";
import {
  and,
  asc,
  desc,
  domains,
  eq,
  listEncryptedSecretsMetadata,
  rebindDockerResourceTransactional,
  recordObservedStateReconciliationTransactional,
  resolveDecryptedSecretRefs,
  serviceInstances,
  serviceTemplates,
  sites,
  stackRevisions,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import {
  createApprovedServiceSpec,
  type ApprovedServiceSpec,
  type DockerExecutionResult,
  type DockerExecutorPort,
  type PortBinding,
} from "@hosting-panel/executor-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import type { ControlPlaneRuntimeConfig } from "../tokens.js";

const STRUCTURED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "image",
  "internalPort",
  "exposeHttp",
  "pidsLimit",
  "volumeMounts",
  "portBindings",
]);

function sanitizeContainerIdentifier(serviceInstanceId: string): string {
  const cleaned = serviceInstanceId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `hp_svc_${cleaned}`.slice(0, 120);
}

function extractRestartCount(obs: unknown): number {
  if (
    obs !== null &&
    typeof obs === "object" &&
    "restartCount" in obs &&
    typeof (obs as { restartCount?: unknown }).restartCount === "number"
  ) {
    return (obs as { restartCount: number }).restartCount;
  }
  return 0;
}

/** Builds the deploy spec of a service from its current revision, its site's active domains and its secrets. */
export async function buildApprovedServiceSpec(
  db: HostingPanelDatabase,
  config: Pick<ControlPlaneRuntimeConfig, "secretsMasterKey">,
  input: { organizationId: string; serviceInstanceId: string },
): Promise<ApprovedServiceSpec> {
  const { organizationId } = input;
  const [svc] = await db
    .select()
    .from(serviceInstances)
    .where(
      and(
        eq(serviceInstances.id, input.serviceInstanceId),
        eq(serviceInstances.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!svc) {
    throw new ControlPlaneError(
      "NOT_FOUND",
      `Service instance '${input.serviceInstanceId}' not found`,
    );
  }

  const [site] = await db
    .select()
    .from(sites)
    .where(and(eq(sites.id, svc.siteId), eq(sites.organizationId, organizationId)))
    .limit(1);

  if (!site) {
    throw new ControlPlaneError("NOT_FOUND", `Site '${svc.siteId}' not found`);
  }

  const [tpl] = await db
    .select()
    .from(serviceTemplates)
    .where(eq(serviceTemplates.id, svc.serviceTemplateId))
    .limit(1);

  if (!tpl) {
    throw new ControlPlaneError(
      "NOT_FOUND",
      `Service template '${svc.serviceTemplateId}' not found`,
    );
  }

  const [rev] = svc.currentRevisionId
    ? await db
        .select()
        .from(stackRevisions)
        .where(eq(stackRevisions.id, svc.currentRevisionId))
        .limit(1)
    : await db
        .select()
        .from(stackRevisions)
        .where(eq(stackRevisions.serviceInstanceId, svc.id))
        .orderBy(desc(stackRevisions.revisionNumber))
        .limit(1);

  if (!rev) {
    throw new ControlPlaneError(
      "NOT_FOUND",
      `Stack revision for service '${svc.id}' not found`,
    );
  }

  const activeDomains = await db
    .select()
    .from(domains)
    .where(
      and(
        eq(domains.siteId, site.id),
        eq(domains.organizationId, organizationId),
        eq(domains.status, "active"),
      ),
    )
    .orderBy(asc(domains.hostname));

  const domainHostnames = activeDomains.map((d) => d.hostname);

  const rawSecretRefs = (rev.secretRefs ?? {}) as Record<string, string>;
  let resolvedSecrets: Readonly<Record<string, string>> | undefined;

  if (Object.keys(rawSecretRefs).length > 0) {
    const metadataRows = await listEncryptedSecretsMetadata(db, {
      organizationId,
      siteId: site.id,
      includeOrganizationScope: true,
    });
    const knownRefs = new Set<string>();
    for (const row of metadataRows) {
      knownRefs.add(row.id);
      knownRefs.add(row.secretKey);
    }

    const refsToResolve: Record<string, string> = {};
    for (const [envVarName, refValue] of Object.entries(rawSecretRefs)) {
      if (refValue.startsWith("vault://")) {
        if (knownRefs.has(refValue)) {
          refsToResolve[envVarName] = refValue;
        } else if (knownRefs.has(envVarName)) {
          // Map Phase 1 demo vault:// placeholder to the encrypted secret matching envVarName
          refsToResolve[envVarName] = envVarName;
        }
        // Otherwise skip legacy Phase 1 demo placeholder with no backing encrypted_secrets row
        continue;
      }
      refsToResolve[envVarName] = refValue;
    }

    if (Object.keys(refsToResolve).length > 0) {
      resolvedSecrets = await resolveDecryptedSecretRefs(db, {
        organizationId,
        siteId: site.id,
        secretRefs: refsToResolve,
        masterKey: config.secretsMasterKey,
      });
    }
  }

  const cfg = (rev.declarativeConfig ?? {}) as Record<string, unknown>;
  const secretEnvNames = new Set(Object.keys(resolvedSecrets ?? {}));
  const secretFileNames = new Set(
    Array.from(secretEnvNames, (envName) => `${envName}_FILE`),
  );

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (
      STRUCTURED_CONFIG_KEYS.has(key) ||
      secretEnvNames.has(key) ||
      secretFileNames.has(key) ||
      !SECRET_KEY_PATTERN.test(key)
    ) {
      continue;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      env[key] = String(value);
    }
  }

  const image =
    typeof cfg["image"] === "string" && cfg["image"].trim().length > 0
      ? cfg["image"].trim()
      : tpl.defaultImage;

  const rawPort = cfg["internalPort"] ?? cfg["PORT"] ?? cfg["port"] ?? tpl.defaultPort ?? 80;
  const parsedPort =
    typeof rawPort === "number"
      ? rawPort
      : typeof rawPort === "string" && /^\d+$/.test(rawPort.trim())
        ? Number.parseInt(rawPort.trim(), 10)
        : tpl.defaultPort || 80;

  const isInternalBackingCategory =
    tpl.category === "database" || tpl.category === "cache";
  const exposeHttp =
    typeof cfg["exposeHttp"] === "boolean"
      ? cfg["exposeHttp"]
      : !isInternalBackingCategory &&
        Boolean(domainHostnames.length > 0 || (tpl.defaultPort ?? 0) > 0);

  const pidsLimit =
    typeof cfg["pidsLimit"] === "number" ? cfg["pidsLimit"] : undefined;

  const volumeMounts = Array.isArray(cfg["volumeMounts"])
    ? (cfg["volumeMounts"] as ServiceVolumeMountSpec[])
    : undefined;

  const portBindings = Array.isArray(cfg["portBindings"])
    ? (cfg["portBindings"] as PortBinding[])
    : undefined;

  const resourceLimits = (rev.resourceLimits as
    | { cpuMilli: number; memoryBytes: string }
    | null
    | undefined) ?? {
    cpuMilli: tpl.minCpuMilli,
    memoryBytes: String(tpl.minMemoryBytes),
  };

  return createApprovedServiceSpec({
    serviceInstanceId: svc.id,
    siteId: site.id,
    organizationId,
    image,
    containerName: sanitizeContainerIdentifier(svc.id),
    env,
    ...(portBindings ? { portBindings } : {}),
    resourceLimits,
    revisionNumber: rev.revisionNumber,
    specHash: rev.specHash,
    domains: exposeHttp ? domainHostnames : [],
    exposeHttp,
    internalPort: parsedPort,
    ...(pidsLimit !== undefined ? { pidsLimit } : {}),
    ...(volumeMounts !== undefined ? { volumeMounts } : {}),
    ...(resolvedSecrets && Object.keys(resolvedSecrets).length > 0
      ? { resolvedSecrets }
      : {}),
  });
}

/** Reads back a just-deployed service and records its docker ref and observed state. */
export async function recordDeployedState(
  db: HostingPanelDatabase,
  executor: DockerExecutorPort,
  spec: ApprovedServiceSpec,
  execResult: DockerExecutionResult,
): Promise<string> {
  const obs = await executor.getObservedState(spec.serviceInstanceId);
  const observedStatus = obs?.observedStatus ?? execResult.containerStatus ?? "running";
  const dockerRef =
    execResult.internalDockerRef ??
    (obs as { internalDockerRef?: string } | null)?.internalDockerRef;

  if (dockerRef) {
    await rebindDockerResourceTransactional(db, spec.serviceInstanceId, dockerRef, observedStatus);
  }

  await recordObservedStateReconciliationTransactional(db, {
    serviceInstanceId: spec.serviceInstanceId,
    observedStatus,
    observedRevisionHash: obs?.observedRevisionHash ?? spec.specHash ?? null,
    outOfBandModified: Boolean(obs?.outOfBandModified),
    rawState: {
      restartCount: extractRestartCount(obs),
      ingressConfigured: Boolean(execResult.ingressConfigured),
    },
    observedAt: obs?.observedAt ? new Date(obs.observedAt) : new Date(),
  });
  return observedStatus;
}
