export interface DockerResourceEntity {
  readonly id: string;
  readonly siteId: string;
  readonly serviceInstanceId: string;
  readonly internalDockerRef: string;
  readonly resourceType: "container" | "volume" | "network";
  readonly status: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RebindDockerResourceInput {
  readonly existingResource: DockerResourceEntity;
  readonly newInternalDockerRef: string;
  readonly newStatus?: string;
  readonly additionalMetadata?: Record<string, unknown>;
  readonly updatedAt?: string;
}

export function rebindDockerResource(input: RebindDockerResourceInput): {
  readonly updatedResource: DockerResourceEntity;
  readonly siteIdPreserved: boolean;
  readonly serviceInstanceIdPreserved: boolean;
} {
  const { existingResource, newInternalDockerRef, newStatus, additionalMetadata, updatedAt } =
    input;

  if (!newInternalDockerRef || newInternalDockerRef.trim().length === 0) {
    throw new Error("newInternalDockerRef cannot be empty");
  }

  const updatedResource: DockerResourceEntity = Object.freeze({
    ...existingResource,
    internalDockerRef: newInternalDockerRef,
    status: newStatus ?? existingResource.status,
    metadata: Object.freeze({
      ...existingResource.metadata,
      ...(additionalMetadata ?? {}),
      previousDockerRef: existingResource.internalDockerRef,
      reboundAt: updatedAt ?? new Date().toISOString(),
    }),
    updatedAt: updatedAt ?? new Date().toISOString(),
  });

  // AC-F1-05: Proving Site.id and ServiceInstance.id remain strictly invariant
  const siteIdPreserved = updatedResource.siteId === existingResource.siteId;
  const serviceInstanceIdPreserved =
    updatedResource.serviceInstanceId === existingResource.serviceInstanceId;

  if (!siteIdPreserved || !serviceInstanceIdPreserved) {
    throw new Error("AC-F1-05 invariant violated: siteId and serviceInstanceId must not change");
  }

  return {
    updatedResource,
    siteIdPreserved,
    serviceInstanceIdPreserved,
  };
}
