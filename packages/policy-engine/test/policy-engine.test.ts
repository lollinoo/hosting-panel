import { describe, expect, it } from "vitest";
import {
  evaluateHostAllocationAdmission,
  evaluateHostModeTransition,
  evaluateQuotaAdmission,
  validateDeclarativeServiceInput,
  type ExistingAllocationSnapshot,
  type HostAdmissionTarget,
  type QuotaSnapshot,
  type TemplatePolicyTarget,
} from "../src/index.js";

describe("@hosting-panel/policy-engine — Host Allocation Admission (AC-F1-01)", () => {
  const readyDedicatedHost: HostAdmissionTarget = {
    id: "hst_ded_01",
    status: "ready",
    hostingMode: "dedicated",
    securityReviewed: true,
    sharedApproved: false,
  };

  it("admits first allocation for an unallocated dedicated host", () => {
    const result = evaluateHostAllocationAdmission(readyDedicatedHost, "org_acme", []);
    expect(result.admitted).toBe(true);
    expect(result.errorCode).toBeNull();
  });

  it("admits additional allocation on dedicated host for the SAME organization (AC-F1-01)", () => {
    const existing: ExistingAllocationSnapshot[] = [
      {
        id: "alloc_01",
        organizationId: "org_acme",
        status: "active",
        hostingMode: "dedicated",
      },
    ];

    const result = evaluateHostAllocationAdmission(readyDedicatedHost, "org_acme", existing);
    expect(result.admitted).toBe(true);
  });

  it("strictly rejects allocation on dedicated host for a DIFFERENT organization (AC-F1-01)", () => {
    const existing: ExistingAllocationSnapshot[] = [
      {
        id: "alloc_01",
        organizationId: "org_acme",
        status: "active",
        hostingMode: "dedicated",
      },
    ];

    const result = evaluateHostAllocationAdmission(readyDedicatedHost, "org_beta", existing);
    expect(result.admitted).toBe(false);
    expect(result.errorCode).toBe("DEDICATED_HOST_OCCUPIED");
    expect(result.reason).toContain("org_acme");
  });

  it("rejects allocation if host status is not ready", () => {
    const maintHost: HostAdmissionTarget = {
      ...readyDedicatedHost,
      status: "maintenance",
    };
    const result = evaluateHostAllocationAdmission(maintHost, "org_acme", []);
    expect(result.admitted).toBe(false);
    expect(result.errorCode).toBe("HOST_POLICY_DENIED");
  });

  it("gates shared hosting allocation if host is not security reviewed and approved", () => {
    const ungatedSharedHost: HostAdmissionTarget = {
      id: "hst_shared_01",
      status: "ready",
      hostingMode: "shared",
      securityReviewed: false,
      sharedApproved: false,
    };

    const result = evaluateHostAllocationAdmission(ungatedSharedHost, "org_acme", []);
    expect(result.admitted).toBe(false);
    expect(result.errorCode).toBe("SHARED_MODE_GATED");
  });
});

describe("@hosting-panel/policy-engine — Host Mode Transition (AC-F1-06)", () => {
  it("strictly rejects direct dedicated -> shared mode transition with SHARED_MODE_GATED (AC-F1-06)", () => {
    const result = evaluateHostModeTransition("dedicated", "shared", {
      securityReviewed: true,
      sharedApproved: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.errorCode).toBe("SHARED_MODE_GATED");
  });

  it("allows noop transition", () => {
    const result = evaluateHostModeTransition("dedicated", "dedicated");
    expect(result.allowed).toBe(true);
  });
});

describe("@hosting-panel/policy-engine — Declarative Service Validation (AC-F1-04 & F1-012)", () => {
  const wpTemplate: TemplatePolicyTarget = {
    id: "tpl_wordpress",
    approvedForDedicated: true,
    approvedForShared: false,
    minCpuMilli: 500,
    minMemoryBytes: "536870912", // 512MB
  };

  it("validates compliant declarative configuration and resource limits", () => {
    const result = validateDeclarativeServiceInput(
      wpTemplate,
      "dedicated",
      {
        tablePrefix: "wp_",
        debugMode: false,
      },
      {
        cpuMilli: 1000,
        memoryBytes: "1073741824", // 1GB
      },
    );

    expect(result.valid).toBe(true);
    expect(result.errorCode).toBeNull();
  });

  it("rejects forbidden Docker input attributes with HOST_POLICY_DENIED (AC-F1-04)", () => {
    const privilegedResult = validateDeclarativeServiceInput(wpTemplate, "dedicated", {
      privileged: true,
    });
    expect(privilegedResult.valid).toBe(false);
    expect(privilegedResult.errorCode).toBe("HOST_POLICY_DENIED");

    const socketResult = validateDeclarativeServiceInput(wpTemplate, "dedicated", {
      mount: "/var/run/docker.sock",
    });
    expect(socketResult.valid).toBe(false);
    expect(socketResult.errorCode).toBe("HOST_POLICY_DENIED");

    const hostNetResult = validateDeclarativeServiceInput(wpTemplate, "dedicated", {
      networkMode: "host",
    });
    expect(hostNetResult.valid).toBe(false);
    expect(hostNetResult.errorCode).toBe("HOST_POLICY_DENIED");
  });

  it("rejects plaintext secrets in configuration with VALIDATION_ERROR (F1-012)", () => {
    const result = validateDeclarativeServiceInput(wpTemplate, "dedicated", {
      dbUser: "wp_user",
      password: "plaintext_secret_password",
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("VALIDATION_ERROR");
    expect(result.message).toContain("Plaintext secret keys detected");
  });

  it("rejects resource limits below template minimums", () => {
    const cpuLow = validateDeclarativeServiceInput(
      wpTemplate,
      "dedicated",
      {},
      { cpuMilli: 200, memoryBytes: "1073741824" },
    );
    expect(cpuLow.valid).toBe(false);
    expect(cpuLow.errorCode).toBe("VALIDATION_ERROR");

    const memLow = validateDeclarativeServiceInput(
      wpTemplate,
      "dedicated",
      {},
      { cpuMilli: 1000, memoryBytes: "268435456" }, // 256MB < 512MB
    );
    expect(memLow.valid).toBe(false);
    expect(memLow.errorCode).toBe("VALIDATION_ERROR");
  });
});

describe("@hosting-panel/policy-engine — Resource Quota Admission", () => {
  const quota: QuotaSnapshot = {
    maxSites: 5,
    maxServices: 10,
    maxCpuMilli: 8000,
    maxMemoryBytes: "8589934592", // 8GB
    maxStorageBytes: "53687091200", // 50GB
    usedSites: 2,
    usedServices: 4,
    usedCpuMilli: 2000,
    usedMemoryBytes: "2147483648", // 2GB
    usedStorageBytes: "10737418240", // 10GB
  };

  it("admits demand within available capacity", () => {
    const result = evaluateQuotaAdmission(quota, {
      sites: 1,
      services: 2,
      cpuMilli: 1000,
      memoryBytes: "1073741824",
      storageBytes: "5368709120",
    });
    expect(result.admitted).toBe(true);
    expect(result.errorCode).toBeNull();
  });

  it("rejects demand exceeding dimension with QUOTA_EXCEEDED", () => {
    const result = evaluateQuotaAdmission(quota, {
      sites: 4, // 2 + 4 = 6 > 5
    });
    expect(result.admitted).toBe(false);
    expect(result.errorCode).toBe("QUOTA_EXCEEDED");
    expect(result.dimension).toBe("sites");
  });

  it("accounts for pending reservations without overcommitting", () => {
    const pendingReservations = [
      {
        sites: 2,
        services: 2,
        cpuMilli: 1000,
        memoryBytes: "1073741824",
        storageBytes: "0",
        status: "pending" as const,
      },
    ];

    // usedSites = 2, pendingSites = 2 -> total available is 1 (out of 5)
    // Requesting 2 should fail
    const result = evaluateQuotaAdmission(
      quota,
      { sites: 2 },
      pendingReservations,
    );
    expect(result.admitted).toBe(false);
    expect(result.errorCode).toBe("QUOTA_EXCEEDED");
    expect(result.dimension).toBe("sites");
  });
});
