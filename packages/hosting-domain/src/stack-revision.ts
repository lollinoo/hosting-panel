import { createHash, randomUUID } from "node:crypto";
import { findPlaintextSecretKeys } from "@hosting-panel/contracts";
import { canonicalizeJson } from "./canonicalize.js";

export interface ResourceLimits {
  readonly cpuMilli: number;
  readonly memoryBytes: string;
}

export interface ImmutableStackRevision {
  readonly id: string;
  readonly serviceInstanceId: string;
  readonly organizationId: string;
  readonly revisionNumber: number;
  readonly specHash: string;
  readonly declarativeConfig: Readonly<Record<string, unknown>>;
  readonly secretRefs: Readonly<Record<string, string>>;
  readonly resourceLimits: ResourceLimits | null;
  readonly authorId: string | null;
  readonly createdAt: string;
}

export interface BuildStackRevisionInput {
  readonly id?: string;
  readonly serviceInstanceId: string;
  readonly organizationId: string;
  readonly currentRevisionNumber: number;
  readonly declarativeConfig: Record<string, unknown>;
  readonly secretRefs?: Record<string, string>;
  readonly resourceLimits?: ResourceLimits | null;
  readonly authorId?: string | null;
  readonly createdAt?: string;
}

export function buildImmutableStackRevision(
  input: BuildStackRevisionInput,
): ImmutableStackRevision {
  // Validate zero plaintext secrets in declarative config (F1-012)
  const secretViolations = findPlaintextSecretKeys(input.declarativeConfig);
  if (secretViolations.length > 0) {
    throw new Error(
      `Plaintext secrets detected in declarative configuration: ${secretViolations.join(", ")}. Use secretRefs instead.`,
    );
  }

  const canonical = canonicalizeJson({
    config: input.declarativeConfig,
    secretRefs: input.secretRefs ?? {},
    resourceLimits: input.resourceLimits ?? null,
  });

  const specHash = createHash("sha256").update(canonical).digest("hex");

  const revision: ImmutableStackRevision = Object.freeze({
    id: input.id ?? randomUUID(),
    serviceInstanceId: input.serviceInstanceId,
    organizationId: input.organizationId,
    revisionNumber: input.currentRevisionNumber + 1,
    specHash,
    declarativeConfig: Object.freeze(JSON.parse(JSON.stringify(input.declarativeConfig))),
    secretRefs: Object.freeze({ ...(input.secretRefs ?? {}) }),
    resourceLimits: input.resourceLimits ? Object.freeze({ ...input.resourceLimits }) : null,
    authorId: input.authorId ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });

  return revision;
}
