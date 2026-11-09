import { z } from "zod";
import {
  HostDaemonStatusSchema,
  RuntimeBackendSchema,
  SECRET_KEY_PATTERN,
  SecretKeySchema,
  findPlaintextSecretKeys,
  findUnsafeDockerInputFields,
} from "./resources.js";

export const VOLUME_SUFFIX_PATTERN = /^[a-zA-Z0-9_-]{1,48}$/;

export const FORBIDDEN_CONTAINER_MOUNT_TARGETS = [
  "/",
  "/etc",
  "/var/run",
  "/proc",
  "/sys",
  "/root",
  "/boot",
  "/dev",
  "/run/hosting-panel",
  "/run/secrets",
] as const;

export interface ServiceVolumeMountSpec {
  readonly volumeSuffix: string;
  readonly containerPath: string;
  readonly readOnly?: boolean;
}

export function validateServiceVolumeMount(
  mount: ServiceVolumeMountSpec,
): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
  if (!VOLUME_SUFFIX_PATTERN.test(mount.volumeSuffix)) {
    return {
      valid: false,
      reason: `Invalid volumeSuffix '${mount.volumeSuffix}': must match ${String(VOLUME_SUFFIX_PATTERN)}`,
    };
  }

  const rawPath = mount.containerPath;
  if (!rawPath || !rawPath.startsWith("/")) {
    return {
      valid: false,
      reason: `Invalid containerPath '${rawPath}': must be an absolute path starting with '/'`,
    };
  }

  if (rawPath.includes("..") || /[\0\r\n:]/.test(rawPath)) {
    return {
      valid: false,
      reason: `Unsafe containerPath '${rawPath}': path traversal or control/delimiter characters are forbidden`,
    };
  }

  const normalized = rawPath.replace(/\/+/g, "/").replace(/\/+$/, "") || "/";
  if (normalized === "/") {
    return {
      valid: false,
      reason: "Unsafe containerPath '/': mounting root filesystem is forbidden",
    };
  }

  for (const forbidden of FORBIDDEN_CONTAINER_MOUNT_TARGETS) {
    if (forbidden === "/") {
      continue;
    }
    if (normalized === forbidden || normalized.startsWith(`${forbidden}/`)) {
      return {
        valid: false,
        reason: `Unsafe containerPath '${rawPath}': target '${forbidden}' is protected by host policy`,
      };
    }
  }

  return { valid: true };
}

// Docker Executor IPC Wire Schemas
export const PortBindingWireSchema = z.object({
  containerPort: z.number().int().min(1).max(65535),
  hostPort: z.number().int().min(1).max(65535).optional(),
});
export type PortBindingWire = z.infer<typeof PortBindingWireSchema>;

export const ServiceVolumeMountWireSchema = z
  .object({
    volumeSuffix: z.string().regex(VOLUME_SUFFIX_PATTERN),
    containerPath: z.string().min(2).max(512),
    readOnly: z.boolean().optional(),
  })
  .superRefine((mount, ctx) => {
    const check = validateServiceVolumeMount(mount);
    if (!check.valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: check.reason,
        path: ["containerPath"],
      });
    }
  });
export type ServiceVolumeMountWire = z.infer<typeof ServiceVolumeMountWireSchema>;

export const ApprovedServiceSpecWireSchema = z
  .object({
    serviceInstanceId: z.string().min(1).max(128),
    siteId: z.string().min(1).max(128),
    organizationId: z.string().min(1).max(128),
    image: z.string().min(1),
    containerName: z.string().min(1),
    env: z.record(z.string(), z.string()).default({}),
    portBindings: z.array(PortBindingWireSchema).default([]),
    resourceLimits: z
      .object({
        cpuMilli: z.number().int().positive(),
        memoryBytes: z.string().regex(/^\d+$/),
      })
      .nullable()
      .default(null),
    revisionNumber: z.number().int().positive().optional(),
    specHash: z.string().min(1).optional(),
    domains: z.array(z.string().min(1)).optional(),
    exposeHttp: z.boolean().optional(),
    internalPort: z.number().int().min(1).max(65535).optional(),
    pidsLimit: z.number().int().min(16).max(4096).optional(),
    volumeMounts: z.array(ServiceVolumeMountWireSchema).optional(),
    resolvedSecrets: z.record(SecretKeySchema, z.string().max(16384)).optional(),
    approvedAt: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((spec, ctx) => {
    const unsafe = findUnsafeDockerInputFields({
      env: spec.env,
      portBindings: spec.portBindings,
    });
    if (unsafe.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unsafe Docker input fields detected: ${unsafe.join(", ")}`,
      });
    }

    const plainSecrets = findPlaintextSecretKeys({ env: spec.env });
    if (plainSecrets.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Plaintext secrets detected in env: ${plainSecrets.join(", ")}`,
        path: ["env"],
      });
    }

    if (spec.resolvedSecrets) {
      for (const envName of Object.keys(spec.resolvedSecrets)) {
        if (!SECRET_KEY_PATTERN.test(envName)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid resolvedSecrets key '${envName}'`,
            path: ["resolvedSecrets", envName],
          });
        }
      }
    }
  });
export type ApprovedServiceSpecWire = z.infer<typeof ApprovedServiceSpecWireSchema>;

export const DeployServiceIpcRequestSchema = z.object({
  operationId: z.string().min(1).max(128).optional(),
  spec: ApprovedServiceSpecWireSchema,
});
export type DeployServiceIpcRequest = z.infer<typeof DeployServiceIpcRequestSchema>;

export const ServiceInstanceActionIpcRequestSchema = z.object({
  operationId: z.string().min(1).max(128).optional(),
  serviceInstanceId: z.string().min(1).max(128),
  siteId: z.string().min(1).max(128).optional(),
  organizationId: z.string().min(1).max(128).optional(),
  action: z.enum(["restart", "stop", "delete"]),
});
export type ServiceInstanceActionIpcRequest = z.infer<
  typeof ServiceInstanceActionIpcRequestSchema
>;

export const SiteJobIpcRequestSchema = z.object({
  jobId: z.string().min(1).max(128),
  kind: z.enum(["db.provision", "db.drop", "wordpress.install"]),
  siteId: z.string().min(1).max(128),
  organizationId: z.string().min(1).max(128),
  serviceInstanceId: z.string().min(1).max(128).optional(),
  params: z.record(z.string(), z.string()),
  resolvedSecrets: z.record(z.string(), z.string()).optional(),
});
export type SiteJobIpcRequest = z.infer<typeof SiteJobIpcRequestSchema>;

export const SitePurgeIpcRequestSchema = z.object({ siteId: z.string().min(1).max(128) });
export type SitePurgeIpcRequest = z.infer<typeof SitePurgeIpcRequestSchema>;

export const ServiceLogsIpcRequestSchema = z.object({
  serviceInstanceId: z.string().min(1).max(128),
  tail: z.number().int().min(1).max(500),
});
export type ServiceLogsIpcRequest = z.infer<typeof ServiceLogsIpcRequestSchema>;

export const ObservedServiceStateWireSchema = z.object({
  serviceInstanceId: z.string().min(1).max(128).optional(),
  observedStatus: z.string().min(1),
  observedRevisionHash: z.string().nullable().optional(),
  outOfBandModified: z.boolean().optional().default(false),
  observedAt: z.string().datetime({ offset: true }).nullable().optional(),
  restartCount: z.number().int().nonnegative().optional(),
  internalDockerRef: z.string().min(1).optional(),
});
export type ObservedServiceStateWire = z.infer<typeof ObservedServiceStateWireSchema>;

export const ExecutorHealthResponseSchema = z.object({
  component: z.literal("docker_executor"),
  status: HostDaemonStatusSchema,
  version: z.string().min(1),
  runtimeBackend: RuntimeBackendSchema.optional(),
  dockerEngineReachable: z.boolean(),
  checkedAt: z.string().datetime({ offset: true }),
});
export type ExecutorHealthResponse = z.infer<typeof ExecutorHealthResponseSchema>;

// Host Agent IPC Wire Schemas
export const IPC_ALLOWLISTED_HOST_MAINTENANCE_ACTIONS = [
  "collect_diagnostics",
  "verify_storage_posture",
  "refresh_host_inventory",
] as const;

export const IPC_ALLOWLISTED_HOST_SECURITY_POLICIES = [
  "verify_baseline_firewall",
  "apply_dedicated_nftables_22_80_443",
] as const;

export const HostMaintenanceIpcRequestSchema = z.object({
  operationId: z.string().min(1).max(128).optional(),
  hostId: z.string().min(1).max(128),
  action: z.enum(IPC_ALLOWLISTED_HOST_MAINTENANCE_ACTIONS),
  reason: z.string().min(1).optional(),
});
export type HostMaintenanceIpcRequest = z.infer<typeof HostMaintenanceIpcRequestSchema>;

export const HostSecurityIpcRequestSchema = z.object({
  operationId: z.string().min(1).max(128).optional(),
  hostId: z.string().min(1).max(128),
  policyRef: z.enum(IPC_ALLOWLISTED_HOST_SECURITY_POLICIES),
  reason: z.string().min(1).optional(),
});
export type HostSecurityIpcRequest = z.infer<typeof HostSecurityIpcRequestSchema>;

export const HostTelemetryWireSchema = z.object({
  hostId: z.string().min(1).max(128),
  cpuUsagePercent: z.number().min(0).max(100),
  memoryUsedBytes: z.string().regex(/^\d+$/),
  memoryTotalBytes: z.string().regex(/^\d+$/).optional(),
  storageUsedBytes: z.string().regex(/^\d+$/),
  storageTotalBytes: z.string().regex(/^\d+$/).optional(),
  uptimeSeconds: z.number().nonnegative().optional(),
  kernelVersion: z.string().min(1).optional(),
  dockerEngineReachable: z.boolean().optional(),
  collectedAt: z.string().datetime({ offset: true }),
});
export type HostTelemetryWire = z.infer<typeof HostTelemetryWireSchema>;

export const HostAgentHealthResponseSchema = z.object({
  component: z.literal("host_agent"),
  status: HostDaemonStatusSchema,
  version: z.string().min(1),
  runtimeBackend: RuntimeBackendSchema.optional(),
  checkedAt: z.string().datetime({ offset: true }),
});
export type HostAgentHealthResponse = z.infer<typeof HostAgentHealthResponseSchema>;
