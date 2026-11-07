import {
  findPlaintextSecretKeys,
  findUnsafeDockerInputFields,
  type ErrorCode,
  type HostingMode,
} from "@hosting-panel/contracts";

export interface TemplatePolicyTarget {
  readonly id: string;
  readonly approvedForDedicated: boolean;
  readonly approvedForShared: boolean;
  readonly minCpuMilli: number;
  readonly minMemoryBytes: string;
}

export interface ServiceInputValidationResult {
  readonly valid: boolean;
  readonly errorCode: ErrorCode | null;
  readonly message: string;
}

export function validateDeclarativeServiceInput(
  template: TemplatePolicyTarget,
  hostingMode: HostingMode,
  configuration: Record<string, unknown>,
  resourceLimits?: { cpuMilli: number; memoryBytes: string } | null,
): ServiceInputValidationResult {
  if (hostingMode === "dedicated" && !template.approvedForDedicated) {
    return {
      valid: false,
      errorCode: "HOST_POLICY_DENIED",
      message: `Template '${template.id}' is not approved for dedicated hosting mode`,
    };
  }

  if (hostingMode === "shared" && !template.approvedForShared) {
    return {
      valid: false,
      errorCode: "HOST_POLICY_DENIED",
      message: `Template '${template.id}' is not approved for shared hosting mode`,
    };
  }

  // AC-F1-04: Recursively detects forbidden Docker attributes
  const unsafeViolations = findUnsafeDockerInputFields(configuration);
  if (unsafeViolations.length > 0) {
    return {
      valid: false,
      errorCode: "HOST_POLICY_DENIED",
      message: `Forbidden Docker input attributes detected: ${unsafeViolations.join(", ")} (AC-F1-04)`,
    };
  }

  // F1-012: Rejects plaintext secrets in configuration
  const secretViolations = findPlaintextSecretKeys(configuration);
  if (secretViolations.length > 0) {
    return {
      valid: false,
      errorCode: "VALIDATION_ERROR",
      message: `Plaintext secret keys detected in declarative configuration: ${secretViolations.join(", ")}. Use secretRefs instead.`,
    };
  }

  // Resource limits validation
  if (resourceLimits) {
    if (resourceLimits.cpuMilli < template.minCpuMilli) {
      return {
        valid: false,
        errorCode: "VALIDATION_ERROR",
        message: `Requested CPU ${resourceLimits.cpuMilli}m is below template minimum of ${template.minCpuMilli}m`,
      };
    }

    try {
      const requestedMemory = BigInt(resourceLimits.memoryBytes);
      const minMemory = BigInt(template.minMemoryBytes);
      if (requestedMemory < minMemory) {
        return {
          valid: false,
          errorCode: "VALIDATION_ERROR",
          message: `Requested memory ${resourceLimits.memoryBytes} bytes is below template minimum of ${template.minMemoryBytes} bytes`,
        };
      }
    } catch {
      return {
        valid: false,
        errorCode: "VALIDATION_ERROR",
        message: "Invalid memory byte limit format",
      };
    }
  }

  return {
    valid: true,
    errorCode: null,
    message: "VALID",
  };
}
