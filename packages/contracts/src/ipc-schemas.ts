import { z } from "zod";
import { CERT_PROBLEMS } from "./site-domains.js";
import {
  SITE_FILE_BATCH_MAX,
  SITE_FILE_CHUNK_BYTES,
  SITE_FILE_SEGMENT_MAX_BYTES,
  SiteFileChunkBase64Schema,
  SiteFileEntrySchema,
  SiteFileItemPathSchema,
  SiteFilePathSchema,
  SiteFileUploadIdSchema,
} from "./site-files.js";
import {
  MailFailureDtoSchema,
  MailRelayHostSchema,
  MailSenderDomainSchema,
  MailRelayPasswordSchema,
  MailRelayPortSchema,
  MailRelayUsernameSchema,
  MailTestResultDtoSchema,
} from "./mail-relay.js";
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

export const SiteHostRouteSchema = z.object({
  hostname: z.string().min(1).max(253),
  tls: z.boolean(),
  httpsRedirect: z.boolean(),
  redirectTo: z.string().max(260).nullable(),
});

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
    hostRoutes: z.array(SiteHostRouteSchema).max(20).optional(),
    exposeHttp: z.boolean().optional(),
    siteMail: z.boolean().optional(),
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
  kind: z.enum(["db.provision", "db.drop", "wordpress.install", "wordpress.set-url"]),
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

export const SiteRoutesIpcRequestSchema = z.object({
  siteId: z.string().min(1).max(128),
  serviceInstanceId: z.string().min(1).max(128),
  containerName: z.string().min(1).max(128),
  internalPort: z.number().int().min(1).max(65535),
  hosts: z.array(SiteHostRouteSchema).max(20),
});
export type SiteRoutesIpcRequest = z.infer<typeof SiteRoutesIpcRequestSchema>;

export const CertificateStatusIpcRequestSchema = z.object({
  failuresSince: z.string().datetime({ offset: true }),
});
export type CertificateStatusIpcRequest = z.infer<typeof CertificateStatusIpcRequestSchema>;

export const CertificateStatusReportWireSchema = z.object({
  acmeEnabled: z.boolean(),
  trusted: z.boolean(),
  readable: z.boolean(),
  certificates: z.array(
    z.object({
      hostname: z.string().min(1).max(253),
      notAfter: z.string().datetime({ offset: true }),
      serialNumber: z.string().max(128),
    }),
  ),
  failures: z.array(
    z.object({
      hostname: z.string().min(1).max(253),
      at: z.string().datetime({ offset: true }),
      kind: z.enum(["obtain", "renew"]),
      problem: z.enum(CERT_PROBLEMS),
      detail: z.string().max(1024),
    }),
  ),
});

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

export const MailRelayApplyRequestSchema = z.object({
  host: MailRelayHostSchema,
  port: MailRelayPortSchema,
  username: MailRelayUsernameSchema,
  password: MailRelayPasswordSchema,
  senderDomain: MailSenderDomainSchema,
});
export type MailRelayApplyRequest = z.infer<typeof MailRelayApplyRequestSchema>;

export const MailRelayApplyIpcRequestSchema = z.object({
  config: MailRelayApplyRequestSchema.nullable(),
});

export const MailRelayStatusIpcRequestSchema = z.object({
  since: z.string().datetime({ offset: true }),
});

export const MailRelayStatusReportWireSchema = z.object({
  present: z.boolean(),
  running: z.boolean(),
  sentCount: z.number().int().nonnegative(),
  failures: z.array(MailFailureDtoSchema).max(50),
});
export type MailRelayStatusReport = z.infer<typeof MailRelayStatusReportWireSchema>;

export const MailTestIpcRequestSchema = z.object({ to: z.string().email(), from: z.string().email() });
export const MailTestIpcResponseSchema = MailTestResultDtoSchema;

export const SITE_FILES_LIST_MAX = 5_000;
export const SITE_FILES_MAX_FILE_BYTES = 2_147_483_648;

const SiteFilesServiceIdSchema = z.string().min(1).max(128);
const SiteFileOffsetSchema = z.number().int().min(0).max(SITE_FILES_MAX_FILE_BYTES);
const SiteFilesBatchSchema = z.array(SiteFileItemPathSchema).min(1).max(SITE_FILE_BATCH_MAX);

export const SiteFilesIpcRequestSchema = z.discriminatedUnion("op", [
  z
    .object({
      serviceInstanceId: SiteFilesServiceIdSchema,
      op: z.literal("list"),
      path: SiteFilePathSchema,
    })
    .strict(),
  z
    .object({
      serviceInstanceId: SiteFilesServiceIdSchema,
      op: z.literal("stat"),
      path: SiteFilePathSchema,
    })
    .strict(),
  z
    .object({
      serviceInstanceId: SiteFilesServiceIdSchema,
      op: z.literal("read"),
      path: SiteFileItemPathSchema,
      offset: SiteFileOffsetSchema,
      length: z.number().int().min(1).max(SITE_FILE_CHUNK_BYTES),
    })
    .strict(),
  z
    .object({
      serviceInstanceId: SiteFilesServiceIdSchema,
      op: z.literal("write"),
      path: SiteFileItemPathSchema,
      uploadId: SiteFileUploadIdSchema,
      offset: SiteFileOffsetSchema,
      dataBase64: SiteFileChunkBase64Schema,
      final: z.boolean(),
      overwrite: z.boolean(),
    })
    .strict(),
  z
    .object({
      serviceInstanceId: SiteFilesServiceIdSchema,
      op: z.literal("mkdir"),
      path: SiteFileItemPathSchema,
    })
    .strict(),
  z
    .object({
      serviceInstanceId: SiteFilesServiceIdSchema,
      op: z.literal("move"),
      from: SiteFileItemPathSchema,
      to: SiteFileItemPathSchema,
    })
    .strict(),
  z
    .object({
      serviceInstanceId: SiteFilesServiceIdSchema,
      op: z.literal("delete"),
      paths: SiteFilesBatchSchema,
    })
    .strict(),
  z
    .object({
      serviceInstanceId: SiteFilesServiceIdSchema,
      op: z.literal("archive"),
      paths: SiteFilesBatchSchema,
      to: SiteFileItemPathSchema,
    })
    .strict(),
  z
    .object({
      serviceInstanceId: SiteFilesServiceIdSchema,
      op: z.literal("extract"),
      path: SiteFileItemPathSchema,
      to: SiteFilePathSchema,
    })
    .strict(),
]);
export type SiteFilesIpcRequest = z.infer<typeof SiteFilesIpcRequestSchema>;
export type SiteFilesOp = SiteFilesIpcRequest["op"];

const SiteFilesEmptyResultSchema = z.object({}).strict();
const SiteFilesCountResultSchema = z.object({ entries: z.number().int().nonnegative() });
// Root stat returns { name: "" }; directory entries in list always require non-empty names.
const SiteFilesStatEntrySchema = z
  .object({
    ...SiteFileEntrySchema.shape,
    name: z.string().max(SITE_FILE_SEGMENT_MAX_BYTES),
  })
  .strict();

export const SITE_FILES_RESULT_SCHEMAS = {
  list: z.object({
    entries: z.array(SiteFileEntrySchema).max(SITE_FILES_LIST_MAX),
    truncated: z.boolean(),
  }),
  stat: z.object({ entry: SiteFilesStatEntrySchema }),
  read: z.object({
    dataBase64: SiteFileChunkBase64Schema,
    size: z.number().int().nonnegative(),
    eof: z.boolean(),
  }),
  write: z.object({ received: z.number().int().nonnegative() }),
  mkdir: SiteFilesEmptyResultSchema,
  move: SiteFilesEmptyResultSchema,
  delete: SiteFilesEmptyResultSchema,
  archive: SiteFilesCountResultSchema,
  extract: SiteFilesCountResultSchema,
} as const;
export type SiteFilesResultByOp = {
  [K in SiteFilesOp]: z.infer<(typeof SITE_FILES_RESULT_SCHEMAS)[K]>;
};
