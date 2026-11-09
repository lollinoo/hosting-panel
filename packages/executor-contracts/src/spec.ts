import {
  SECRET_KEY_PATTERN,
  findPlaintextSecretKeys,
  findUnsafeDockerInputFields,
  validateServiceVolumeMount,
  type ErrorCode,
  type ServiceVolumeMountSpec,
  type SiteHostRoute,
} from "@hosting-panel/contracts";

export type { ServiceVolumeMountSpec };

export interface PortBinding {
  readonly containerPort: number;
  readonly hostPort?: number;
}

export interface ServiceResourceLimits {
  readonly cpuMilli: number;
  readonly memoryBytes: string;
}

export interface ApprovedServiceSpec {
  readonly __brand: "ApprovedServiceSpec";
  readonly serviceInstanceId: string;
  readonly siteId: string;
  readonly organizationId: string;
  readonly image: string;
  readonly containerName: string;
  readonly env: Readonly<Record<string, string>>;
  readonly portBindings: readonly PortBinding[];
  readonly resourceLimits: ServiceResourceLimits | null;
  readonly revisionNumber?: number;
  readonly specHash?: string;
  readonly domains?: readonly string[];
  readonly hostRoutes?: readonly SiteHostRoute[];
  readonly exposeHttp?: boolean;
  readonly internalPort?: number;
  readonly pidsLimit?: number;
  readonly volumeMounts?: readonly ServiceVolumeMountSpec[];
  readonly resolvedSecrets?: Readonly<Record<string, string>>;
  readonly approvedAt: string;
}

export interface CreateApprovedServiceSpecInput {
  readonly serviceInstanceId: string;
  readonly siteId: string;
  readonly organizationId: string;
  readonly image: string;
  readonly containerName: string;
  readonly env?: Record<string, string>;
  readonly portBindings?: PortBinding[];
  readonly resourceLimits?: ServiceResourceLimits | null;
  readonly revisionNumber?: number;
  readonly specHash?: string;
  readonly domains?: readonly string[];
  readonly hostRoutes?: readonly SiteHostRoute[];
  readonly exposeHttp?: boolean;
  readonly internalPort?: number;
  readonly pidsLimit?: number;
  readonly volumeMounts?: readonly ServiceVolumeMountSpec[];
  readonly resolvedSecrets?: Readonly<Record<string, string>>;
  readonly rawConfig?: Record<string, unknown>;
}

function createCodedError(message: string, code: ErrorCode): Error {
  const err = new Error(message);
  (err as unknown as { code: ErrorCode }).code = code;
  return err;
}

export function createApprovedServiceSpec(
  input: CreateApprovedServiceSpecInput,
): ApprovedServiceSpec {
  // Validate unsafe Docker input fields (AC-F1-04 / AC-F2-03)
  const toCheck = {
    ...(input.rawConfig ?? {}),
    env: input.env,
    portBindings: input.portBindings,
  };

  const unsafeViolations = findUnsafeDockerInputFields(toCheck);
  if (unsafeViolations.length > 0) {
    throw createCodedError(
      `Cannot construct ApprovedServiceSpec: unsafe Docker attributes detected: ${unsafeViolations.join(", ")} (AC-F1-04)`,
      "HOST_POLICY_DENIED",
    );
  }

  // Validate zero plaintext secrets in declarative config or env (F1-012 / AC-F2-05)
  const secretViolations = findPlaintextSecretKeys(toCheck);
  if (secretViolations.length > 0) {
    throw createCodedError(
      `Cannot construct ApprovedServiceSpec: plaintext secrets detected: ${secretViolations.join(", ")} (F1-012)`,
      "VALIDATION_ERROR",
    );
  }

  if (!input.image || input.image.trim().length === 0) {
    throw createCodedError(
      "Cannot construct ApprovedServiceSpec: image must not be empty",
      "VALIDATION_ERROR",
    );
  }

  if (!input.containerName || input.containerName.trim().length === 0) {
    throw createCodedError(
      "Cannot construct ApprovedServiceSpec: containerName must not be empty",
      "VALIDATION_ERROR",
    );
  }

  if (input.pidsLimit !== undefined) {
    if (
      !Number.isInteger(input.pidsLimit) ||
      input.pidsLimit < 16 ||
      input.pidsLimit > 4096
    ) {
      throw createCodedError(
        `Cannot construct ApprovedServiceSpec: pidsLimit must be an integer between 16 and 4096 (got ${String(input.pidsLimit)})`,
        "HOST_POLICY_DENIED",
      );
    }
  }

  if (input.internalPort !== undefined) {
    if (
      !Number.isInteger(input.internalPort) ||
      input.internalPort < 1 ||
      input.internalPort > 65535
    ) {
      throw createCodedError(
        `Cannot construct ApprovedServiceSpec: internalPort must be between 1 and 65535 (got ${String(input.internalPort)})`,
        "VALIDATION_ERROR",
      );
    }
  }

  if (input.revisionNumber !== undefined) {
    if (!Number.isInteger(input.revisionNumber) || input.revisionNumber < 1) {
      throw createCodedError(
        "Cannot construct ApprovedServiceSpec: revisionNumber must be a positive integer",
        "VALIDATION_ERROR",
      );
    }
  }

  let frozenMounts: readonly ServiceVolumeMountSpec[] | undefined;
  if (input.volumeMounts !== undefined) {
    const validatedMounts: ServiceVolumeMountSpec[] = [];
    for (const mount of input.volumeMounts) {
      const check = validateServiceVolumeMount(mount);
      if (!check.valid) {
        throw createCodedError(
          `Cannot construct ApprovedServiceSpec: ${check.reason}`,
          "HOST_POLICY_DENIED",
        );
      }
      validatedMounts.push(
        Object.freeze({
          volumeSuffix: mount.volumeSuffix,
          containerPath: mount.containerPath,
          ...(mount.readOnly !== undefined ? { readOnly: mount.readOnly } : {}),
        }),
      );
    }
    frozenMounts = Object.freeze(validatedMounts);
  }

  let frozenResolvedSecrets: Readonly<Record<string, string>> | undefined;
  if (input.resolvedSecrets !== undefined) {
    const copy: Record<string, string> = {};
    for (const [envName, secretVal] of Object.entries(input.resolvedSecrets)) {
      if (!SECRET_KEY_PATTERN.test(envName)) {
        throw createCodedError(
          `Cannot construct ApprovedServiceSpec: invalid resolvedSecrets env name '${envName}'`,
          "HOST_POLICY_DENIED",
        );
      }
      if (typeof secretVal !== "string" || secretVal.length === 0 || secretVal.length > 16384) {
        throw createCodedError(
          `Cannot construct ApprovedServiceSpec: invalid resolvedSecrets value length for '${envName}'`,
          "VALIDATION_ERROR",
        );
      }
      copy[envName] = secretVal;
    }
    frozenResolvedSecrets = Object.freeze(copy);
  }

  return Object.freeze({
    __brand: "ApprovedServiceSpec" as const,
    serviceInstanceId: input.serviceInstanceId,
    siteId: input.siteId,
    organizationId: input.organizationId,
    image: input.image,
    containerName: input.containerName,
    env: Object.freeze({ ...(input.env ?? {}) }),
    portBindings: Object.freeze(
      (input.portBindings ?? []).map((pb) => Object.freeze({ ...pb })),
    ),
    resourceLimits: input.resourceLimits ? Object.freeze({ ...input.resourceLimits }) : null,
    ...(input.revisionNumber !== undefined ? { revisionNumber: input.revisionNumber } : {}),
    ...(input.specHash !== undefined ? { specHash: input.specHash } : {}),
    ...(input.domains !== undefined ? { domains: Object.freeze([...input.domains]) } : {}),
    ...(input.hostRoutes !== undefined
      ? { hostRoutes: Object.freeze(input.hostRoutes.map((r) => Object.freeze({ ...r }))) }
      : {}),
    ...(input.exposeHttp !== undefined ? { exposeHttp: input.exposeHttp } : {}),
    ...(input.internalPort !== undefined ? { internalPort: input.internalPort } : {}),
    ...(input.pidsLimit !== undefined ? { pidsLimit: input.pidsLimit } : {}),
    ...(frozenMounts !== undefined ? { volumeMounts: frozenMounts } : {}),
    ...(frozenResolvedSecrets !== undefined ? { resolvedSecrets: frozenResolvedSecrets } : {}),
    approvedAt: new Date().toISOString(),
  });
}
