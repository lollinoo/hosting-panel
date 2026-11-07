import {
  findPlaintextSecretKeys,
  findUnsafeDockerInputFields,
} from "@hosting-panel/contracts";

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
  readonly rawConfig?: Record<string, unknown>;
}

export function createApprovedServiceSpec(
  input: CreateApprovedServiceSpecInput,
): ApprovedServiceSpec {
  // Validate unsafe Docker input fields (AC-F1-04)
  const toCheck = {
    ...(input.rawConfig ?? {}),
    env: input.env,
    portBindings: input.portBindings,
  };

  const unsafeViolations = findUnsafeDockerInputFields(toCheck);
  if (unsafeViolations.length > 0) {
    throw new Error(
      `Cannot construct ApprovedServiceSpec: unsafe Docker attributes detected: ${unsafeViolations.join(", ")} (AC-F1-04)`,
    );
  }

  // Validate zero plaintext secrets (F1-012)
  const secretViolations = findPlaintextSecretKeys(toCheck);
  if (secretViolations.length > 0) {
    throw new Error(
      `Cannot construct ApprovedServiceSpec: plaintext secrets detected: ${secretViolations.join(", ")} (F1-012)`,
    );
  }

  if (!input.image || input.image.trim().length === 0) {
    throw new Error("Cannot construct ApprovedServiceSpec: image must not be empty");
  }

  return Object.freeze({
    __brand: "ApprovedServiceSpec" as const,
    serviceInstanceId: input.serviceInstanceId,
    siteId: input.siteId,
    organizationId: input.organizationId,
    image: input.image,
    containerName: input.containerName,
    env: Object.freeze({ ...(input.env ?? {}) }),
    portBindings: Object.freeze([...(input.portBindings ?? [])]),
    resourceLimits: input.resourceLimits ? Object.freeze({ ...input.resourceLimits }) : null,
    approvedAt: new Date().toISOString(),
  });
}
