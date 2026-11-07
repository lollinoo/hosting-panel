import { describe, expect, it } from "vitest";
import {
  buildImmutableStackRevision,
  canonicalizeJson,
  computeSiteAggregateSummary,
  evaluateServiceDrift,
  rebindDockerResource,
  type DockerResourceEntity,
  type ServiceAggregateInput,
} from "../src/index.js";

describe("@hosting-panel/hosting-domain — buildImmutableStackRevision", () => {
  it("canonicalizes JSON deterministically", () => {
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe(canonicalizeJson({ a: 2, b: 1 }));
  });

  it("computes deterministic SHA-256 specHash regardless of key order in declarativeConfig", () => {
    const rev1 = buildImmutableStackRevision({
      serviceInstanceId: "svc-1",
      organizationId: "org-1",
      currentRevisionNumber: 0,
      declarativeConfig: {
        image: "wordpress:6.4",
        env: { B_VAR: "2", A_VAR: "1" },
        port: 80,
      },
    });

    const rev2 = buildImmutableStackRevision({
      serviceInstanceId: "svc-1",
      organizationId: "org-1",
      currentRevisionNumber: 0,
      declarativeConfig: {
        port: 80,
        image: "wordpress:6.4",
        env: { A_VAR: "1", B_VAR: "2" },
      },
    });

    expect(rev1.specHash).toBe(rev2.specHash);
    expect(rev1.revisionNumber).toBe(1);
    expect(rev2.revisionNumber).toBe(1);
    expect(Object.isFrozen(rev1)).toBe(true);
  });

  it("rejects declarativeConfig with plaintext secrets (F1-012)", () => {
    expect(() =>
      buildImmutableStackRevision({
        serviceInstanceId: "svc-1",
        organizationId: "org-1",
        currentRevisionNumber: 0,
        declarativeConfig: {
          image: "mariadb:11",
          password: "plain-secret-password",
        },
      }),
    ).toThrow(/Plaintext secrets detected/);
  });

  it("allows secret references via secretRefs without throwing", () => {
    const rev = buildImmutableStackRevision({
      serviceInstanceId: "svc-1",
      organizationId: "org-1",
      currentRevisionNumber: 1,
      declarativeConfig: {
        image: "mariadb:11",
        database: "shop",
      },
      secretRefs: {
        DB_PASSWORD: "vault://db/password",
      },
    });

    expect(rev.revisionNumber).toBe(2);
    expect(rev.secretRefs.DB_PASSWORD).toBe("vault://db/password");
  });
});

describe("@hosting-panel/hosting-domain — evaluateServiceDrift (§4.4)", () => {
  const NOW = new Date("2026-11-07T14:00:00.000Z");
  const FRESH_TIME = new Date("2026-11-07T13:58:00.000Z");
  const STALE_TIME = new Date("2026-11-07T13:40:00.000Z"); // 20m ago

  it("reports in_sync when observed state matches desired and is fresh", () => {
    const result = evaluateServiceDrift(
      "running",
      "hash-12345",
      {
        observedStatus: "running",
        observedRevisionHash: "hash-12345",
        outOfBandModified: false,
        observedAt: FRESH_TIME,
      },
      { now: NOW },
    );

    expect(result.driftStatus).toBe("in_sync");
    expect(result.stale).toBe(false);
    expect(result.requiresOperatorReview).toBe(false);
  });

  it("reports drifted and requiresOperatorReview: true on out-of-band modification without auto-destroying (§4.4)", () => {
    const result = evaluateServiceDrift(
      "running",
      "hash-12345",
      {
        observedStatus: "running",
        observedRevisionHash: "hash-12345",
        outOfBandModified: true,
        observedAt: FRESH_TIME,
      },
      { now: NOW },
    );

    expect(result.driftStatus).toBe("drifted");
    expect(result.requiresOperatorReview).toBe(true);
    expect(result.reason).toBe("OUT_OF_BAND_MODIFIED");
  });

  it("reports drifted on status or spec hash mismatch", () => {
    const statusMismatch = evaluateServiceDrift(
      "running",
      "hash-12345",
      {
        observedStatus: "stopped",
        observedRevisionHash: "hash-12345",
        observedAt: FRESH_TIME,
      },
      { now: NOW },
    );
    expect(statusMismatch.driftStatus).toBe("drifted");
    expect(statusMismatch.requiresOperatorReview).toBe(false);

    const hashMismatch = evaluateServiceDrift(
      "running",
      "hash-12345",
      {
        observedStatus: "running",
        observedRevisionHash: "hash-different",
        observedAt: FRESH_TIME,
      },
      { now: NOW },
    );
    expect(hashMismatch.driftStatus).toBe("drifted");
  });

  it("reports unknown when observation is missing", () => {
    const noObs = evaluateServiceDrift("running", "hash-12345", null, { now: NOW });
    expect(noObs.driftStatus).toBe("unknown");
    expect(noObs.stale).toBe(true);
  });

  it("reports stale when observation exceeds staleThresholdMs", () => {
    const staleObs = evaluateServiceDrift(
      "running",
      "hash-12345",
      {
        observedStatus: "running",
        observedRevisionHash: "hash-12345",
        observedAt: STALE_TIME,
      },
      { now: NOW, stalenessThresholdMs: 300_000 },
    );
    expect(staleObs.stale).toBe(true);
    expect(staleObs.driftStatus).toBe("in_sync");
    expect(staleObs.reason).toBe("IN_SYNC_STALE");
  });
});

describe("@hosting-panel/hosting-domain — rebindDockerResource (AC-F1-05)", () => {
  it("replaces internalDockerRef while proving Site.id and ServiceInstance.id remain invariant", () => {
    const originalResource: DockerResourceEntity = {
      id: "res-dock-01",
      siteId: "site_acme_shop",
      serviceInstanceId: "svc_wordpress",
      internalDockerRef: "cnt_wp_old_1111",
      resourceType: "container",
      status: "running",
      metadata: { env: "prod" },
      createdAt: "2026-11-07T10:00:00.000Z",
      updatedAt: "2026-11-07T10:00:00.000Z",
    };

    const rebindResult = rebindDockerResource({
      existingResource: originalResource,
      newInternalDockerRef: "cnt_wp_new_2222",
      newStatus: "running",
      updatedAt: "2026-11-07T14:30:00.000Z",
    });

    expect(rebindResult.siteIdPreserved).toBe(true);
    expect(rebindResult.serviceInstanceIdPreserved).toBe(true);
    expect(rebindResult.updatedResource.siteId).toBe("site_acme_shop");
    expect(rebindResult.updatedResource.serviceInstanceId).toBe("svc_wordpress");
    expect(rebindResult.updatedResource.internalDockerRef).toBe("cnt_wp_new_2222");
    expect(rebindResult.updatedResource.metadata.previousDockerRef).toBe("cnt_wp_old_1111");
  });
});

describe("@hosting-panel/hosting-domain — computeSiteAggregateSummary (F1-004)", () => {
  it("aggregates multi-service site into cohesive site status and drift summary", () => {
    const services: ServiceAggregateInput[] = [
      { id: "s1", desiredStatus: "running", driftStatus: "in_sync", operationalStatus: "running" },
      { id: "s2", desiredStatus: "running", driftStatus: "in_sync", operationalStatus: "running" },
      { id: "s3", desiredStatus: "running", driftStatus: "in_sync", operationalStatus: "running" },
    ];

    const allInSync = computeSiteAggregateSummary(services);
    expect(allInSync.siteStatus).toBe("ready");
    expect(allInSync.driftSummary).toEqual({
      totalServices: 3,
      inSyncCount: 3,
      driftedCount: 0,
      unknownCount: 0,
      overallDriftStatus: "in_sync",
    });

    const withOneDrifted: ServiceAggregateInput[] = [
      { id: "s1", desiredStatus: "running", driftStatus: "drifted", operationalStatus: "running" },
      { id: "s2", desiredStatus: "running", driftStatus: "in_sync", operationalStatus: "running" },
    ];

    const driftedSite = computeSiteAggregateSummary(withOneDrifted);
    expect(driftedSite.siteStatus).toBe("degraded");
    expect(driftedSite.driftSummary.overallDriftStatus).toBe("drifted");
    expect(driftedSite.driftSummary.driftedCount).toBe(1);
  });
});
