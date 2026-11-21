import { Inject, Injectable } from "@nestjs/common";
import {
  canTransitionOperation,
  isTerminalOperationStatus,
  type CertChallenge,
  type SiteHostRoute,
  type TlsVersionProblem,
} from "@hosting-panel/contracts";
import {
  and,
  appendAuditEvent,
  domains,
  eq,
  inArray,
  listSiteDomains,
  operationSteps,
  operations,
  renewOperationLease,
  serviceInstances,
  settleOperation,
  sites,
  sql,
  tlsCertificateVersions,
  tlsCertificates,
  tlsPublishState,
  updateOperationStepTransactional,
  type DatabaseClient,
  type DomainRow,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { buildApprovedServiceSpec } from "../runtime/service-spec.js";
import { SITE_STEP_LEASE_MS, isAmbiguousFailure } from "../runtime/site-provisioner.js";
import { buildSiteHostRoutes, desiredWordpressUrl, routePlanHash } from "../sites/domain-policy.js";
import { findApiSiteType } from "../site-types/index.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import { TLS_APPLY_STEPS } from "./tls-assignment.js";
import {
  TlsPublishService,
  executorReason,
  type TlsExpectation,
  type TlsPublishResult,
  type TlsSet,
} from "./tls-publish.service.js";

// HCP-SPEC-004 A5: `site.tls.apply` hands the key material to the executor just in time, publishes the manual set with
// the fingerprints the proxy must serve, switches the routes of hosts that change mode, and only then flips the
// domain rows. Every refusal or failure leaves the database as it was; texts shown to customers are fixed.

type TlsStep = (typeof TLS_APPLY_STEPS)[number]["key"];

const STEP_DONE: Readonly<Record<TlsStep, string>> = {
  stage: "Certificate sent to the server",
  publish: "Certificate in use",
  routes: "Web addresses updated",
};
const STEP_RUNNING = "In progress";
const STEP_NOTHING = "Nothing to change";
const STEP_FAILED = "Could not finish this step";
const STEP_SKIPPED = "Skipped due to prior step failure";
export const SITE_TLS_FAILED = "The certificate change did not finish. Your site keeps the certificate it had.";
export const SITE_TLS_INTERRUPTED = "This certificate change was interrupted. Your site keeps the certificate it had.";
const APPLY_FAILED_MESSAGE = "The certificate could not be put in use.";

interface TlsProgress {
  step: TlsStep;
  published: boolean;
  /** Sites whose routes call was started: restored on failure, their applied hash forgotten when in doubt. */
  routeSites: string[];
  /** What a served publish took out of the ACME store: audited on failure too (ids and hostnames only). */
  evicted: { resolver: string; main: string }[];
  collateralHosts: string[];
}

interface TlsChangeInput {
  readonly domainId: string;
  readonly versionId: string | null;
}

interface TlsApplyInput {
  readonly changes: readonly TlsChangeInput[];
  readonly evictAcme: boolean;
  readonly challenge: CertChallenge | null;
}

/** One site the change touches: its rows now, and what they and their routes become. */
interface SiteCtx {
  site: typeof sites.$inferSelect;
  svc: typeof serviceInstances.$inferSelect;
  rows: DomainRow[];
  changes: readonly TlsChangeInput[];
  switchesMode: boolean;
  overlayRows: DomainRow[];
  finalRoutes: SiteHostRoute[];
  hashUrl: string | null;
  publish: () => Promise<void>;
}

/** Fixed-text failure carrying the problem slug stored on the version and the reason shown in `details`. */
class TlsApplyError extends ControlPlaneError {
  public constructor(
    code: ConstructorParameters<typeof ControlPlaneError>[0],
    message: string,
    public readonly problem: TlsVersionProblem,
    reason: string,
  ) {
    super(code, message, { details: [{ field: "versionId", reason, message }] });
  }
}

const OUTCOME_ERRORS: Readonly<Record<string, () => TlsApplyError>> = {
  not_served_reverted: () =>
    new TlsApplyError("CERTIFICATE_SNI_MISMATCH", "The server did not serve the certificate; the previous setup was restored.", "sni_mismatch", "not_served"),
  acme_eviction_required: () =>
    new TlsApplyError(
      "CERTIFICATE_SNI_MISMATCH",
      "An automatic certificate is in the way. An administrator must complete this change.",
      "acme_eviction_required",
      "acme_certificate_conflict",
    ),
  manual_overlap: () =>
    new TlsApplyError("CERTIFICATE_SNI_MISMATCH", "Another imported certificate would be served for the same web address.", "manual_overlap", "manual_overlap"),
  captures_host: () =>
    new TlsApplyError("CERTIFICATE_IN_USE", "This certificate would also be served for another web address.", "captures_host", "captures_host"),
  start_failed_restored: () =>
    new TlsApplyError("CERTIFICATE_APPLY_FAILED", APPLY_FAILED_MESSAGE, "apply_failed", "proxy_start_restored"),
};

/** Whatever went wrong becomes a fixed-text error: an executor message (or anything it echoed) never travels on. */
function toFixedError(err: unknown): TlsApplyError {
  if (err instanceof TlsApplyError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  const { reason } = executorReason(err);
  const retryable = reason === "TLS_MANIFEST_CONFLICT" || reason === "TLS_VERSION_MISSING" || reason === "TLS_VERSION_CONFLICT";
  if (!retryable && (code === "CERTIFICATE_INVALID" || code === "CERTIFICATE_EXPIRED" || code === "CERTIFICATE_HOSTNAME_MISMATCH")) {
    return new TlsApplyError(code, APPLY_FAILED_MESSAGE, "apply_failed", reason ?? "apply_failed");
  }
  return new TlsApplyError("CERTIFICATE_APPLY_FAILED", APPLY_FAILED_MESSAGE, "apply_failed", "apply_failed");
}

function parsePayload(payload: Record<string, unknown>): TlsApplyInput {
  const raw = payload["changes"];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ControlPlaneError("VALIDATION_ERROR", "The certificate change has no domains.");
  }
  const changes = raw.map((c): TlsChangeInput => {
    const e = c as { domainId?: unknown; versionId?: unknown } | null;
    if (typeof e?.domainId !== "string" || (e.versionId !== null && typeof e.versionId !== "string")) {
      throw new ControlPlaneError("VALIDATION_ERROR", "The certificate change is malformed.");
    }
    return { domainId: e.domainId, versionId: e.versionId };
  });
  const challenge = payload["challenge"];
  return {
    changes,
    evictAcme: payload["evictAcme"] === true,
    challenge: challenge === "http-01" || challenge === "dns-01" ? challenge : null,
  };
}

@Injectable()
export class SiteTlsApplier {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly executor: DockerExecutorPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(TlsPublishService) private readonly publisher: TlsPublishService,
  ) {}

  /** Runs one queued `site.tls.apply` under the publish mutex. Throws a fixed-text error after settling a failure. */
  public apply(op: typeof operations.$inferSelect, payload: Record<string, unknown>): Promise<void> {
    return this.publisher.runExclusive(() => this.#run(op, parsePayload(payload)));
  }

  async #run(op: typeof operations.$inferSelect, input: TlsApplyInput): Promise<void> {
    const db = this.dbClient.db;
    const { organizationId, resourceId: siteId } = op;
    const progress: TlsProgress = { step: "stage", published: false, routeSites: [], evicted: [], collateralHosts: [] };
    const restoreRoutes = new Map<string, () => Promise<void>>();

    const step = async (key: TlsStep, work: (() => Promise<void>) | null): Promise<void> => {
      progress.step = key;
      await renewOperationLease(db, op.id, SITE_STEP_LEASE_MS);
      if (!work) {
        await updateOperationStepTransactional(db, op.id, key, "skipped", STEP_NOTHING);
        return;
      }
      await updateOperationStepTransactional(db, op.id, key, "running", STEP_RUNNING);
      await work();
      await updateOperationStepTransactional(db, op.id, key, "succeeded", STEP_DONE[key]);
    };

    try {
      // The domains of the change may sit on several sites of the organisation: every one of them is staged and settled.
      const named = await db
        .select({ id: domains.id, siteId: domains.siteId })
        .from(domains)
        .where(and(inArray(domains.id, input.changes.map((c) => c.domainId)), eq(domains.organizationId, organizationId)));
      const siteIds = [...new Set([siteId, ...named.map((d) => d.siteId)])].sort();
      const ctxs: SiteCtx[] = [];
      for (const id of siteIds) {
        const [site] = await db
          .select()
          .from(sites)
          .where(and(eq(sites.id, id), eq(sites.organizationId, organizationId)))
          .limit(1);
        const [svc] = await db
          .select()
          .from(serviceInstances)
          .where(and(eq(serviceInstances.siteId, id), eq(serviceInstances.organizationId, organizationId)))
          .limit(1);
        const type = site ? findApiSiteType(site.siteType) : null;
        if (!site || !type || !svc) {
          throw new ControlPlaneError("NOT_FOUND", `Managed site '${id}' is incomplete`);
        }
        ctxs.push({
          site,
          svc,
          rows: await listSiteDomains(db, id),
          changes: [],
          switchesMode: false,
          overlayRows: [],
          finalRoutes: [],
          hashUrl: null,
          publish: async () => undefined,
        });
      }

      const now = new Date();
      const rowById = new Map(ctxs.flatMap((c) => c.rows).map((r) => [r.id, r]));
      const versionIds = [...new Set(input.changes.flatMap((c) => (c.versionId === null ? [] : [c.versionId])))];
      const versions = new Map(
        (versionIds.length === 0
          ? []
          : await db
              .select({
                id: tlsCertificateVersions.id,
                certificateId: tlsCertificateVersions.certificateId,
                notAfter: tlsCertificateVersions.notAfter,
                fingerprintSha256: tlsCertificateVersions.fingerprintSha256,
              })
              .from(tlsCertificateVersions)
              .where(and(inArray(tlsCertificateVersions.id, versionIds), eq(tlsCertificateVersions.organizationId, organizationId)))
        ).map((v) => [v.id, v]),
      );
      for (const change of input.changes) {
        if (!rowById.has(change.domainId) || (change.versionId !== null && !versions.has(change.versionId))) {
          throw new ControlPlaneError("NOT_FOUND", "A web address or certificate of this change no longer exists.");
        }
      }

      const { acmeEnabled } = await this.executor.getCertificateStatus({ failuresSince: now.toISOString() });
      const toManual = input.changes.filter((c) => c.versionId !== null);
      const toAcme = input.changes.filter((c) => c.versionId === null);

      // Per site, the rows as they will be after the settle: what the route plan and the manual set are computed from.
      for (const ctx of ctxs) {
        const mine = input.changes.filter((c) => ctx.rows.some((r) => r.id === c.domainId));
        ctx.changes = mine;
        ctx.switchesMode = mine.some((c) => (rowById.get(c.domainId)!.certMode === "manual") !== (c.versionId !== null));
        ctx.overlayRows = ctx.rows.map((row): DomainRow => {
          const change = mine.find((c) => c.domainId === row.id);
          if (!change) return row;
          if (change.versionId !== null) {
            return {
              ...row,
              certMode: "manual",
              manualCertificateVersionId: change.versionId,
              certStatus: "active",
              certProblem: null,
              certRetryAt: null,
              certAttempts: 0,
              certExpiresAt: versions.get(change.versionId)!.notAfter,
            };
          }
          return {
            ...row,
            certMode: "acme",
            manualCertificateVersionId: null,
            certStatus: acmeEnabled ? "requested" : "none",
            certProblem: null,
            certExpiresAt: null,
            certChallenge: input.challenge ?? row.certChallenge,
          };
        });
      }
      const switchesMode = ctxs.some((c) => c.switchesMode);

      const desired = await this.publisher.readDesiredGeneration();
      const overlay = new Map(input.changes.map((c) => [c.domainId, c.versionId] as const));
      const set: TlsSet = await this.publisher.buildSet(overlay);
      // A host going back to ACME must stop serving the version it had: its fingerprint is the "not" expectation.
      const leavingIds = [
        ...new Set(
          toAcme.flatMap((c) => {
            const old = rowById.get(c.domainId)!;
            return old.certMode === "manual" && old.manualCertificateVersionId ? [old.manualCertificateVersionId] : [];
          }),
        ),
      ];
      const leaving = new Map(
        (leavingIds.length === 0
          ? []
          : await db
              .select({ id: tlsCertificateVersions.id, fingerprint: tlsCertificateVersions.fingerprintSha256 })
              .from(tlsCertificateVersions)
              .where(inArray(tlsCertificateVersions.id, leavingIds))
        ).map((v) => [v.id, v.fingerprint] as const),
      );
      const expect: TlsExpectation[] = [
        ...toManual.map((c) => ({
          hostname: rowById.get(c.domainId)!.hostname.toLowerCase(),
          fingerprintSha256: versions.get(c.versionId!)!.fingerprintSha256,
        })),
        ...toAcme.flatMap((c) => {
          const old = rowById.get(c.domainId)!;
          const fingerprint = old.manualCertificateVersionId ? leaving.get(old.manualCertificateVersionId) : undefined;
          return fingerprint ? [{ hostname: old.hostname.toLowerCase(), notFingerprintSha256: fingerprint }] : [];
        }),
      ];

      for (const ctx of ctxs) {
        const { site, svc, rows } = ctx;
        const primary = rows.find((r) => r.isPrimary && r.status === "active");
        const currentUrl = site.siteUrl ?? (primary ? `http://${primary.hostname}` : null);
        const wanted = desiredWordpressUrl(ctx.overlayRows, now, currentUrl, acmeEnabled);
        const spec = await buildApprovedServiceSpec(db, this.config, { organizationId, serviceInstanceId: svc.id });
        const publishRoutes = (hosts: readonly SiteHostRoute[]) =>
          this.executor.applySiteRoutes({
            siteId: site.id,
            serviceInstanceId: svc.id,
            containerName: spec.containerName,
            internalPort: spec.internalPort ?? 80,
            hosts,
          });
        ctx.finalRoutes = buildSiteHostRoutes(ctx.overlayRows, now, { transition: wanted !== currentUrl, acmeEnabled });
        // The hash keeps the not-yet-switched WordPress address, so the domain reconciler finishes that switch.
        ctx.hashUrl = site.siteUrl !== null && wanted !== site.siteUrl ? site.siteUrl : wanted;
        ctx.publish = () => publishRoutes(ctx.finalRoutes);
        restoreRoutes.set(site.id, () => publishRoutes(buildSiteHostRoutes(rows, now, { acmeEnabled })));
      }

      let result: TlsPublishResult | null = null;
      const runStage = () => step("stage", set.entries.length > 0 ? async () => void (await this.publisher.putMissing(set)) : null);
      const runPublish = () =>
        step("publish", async () => {
          result = await this.publisher.publishSet(set, { expect, evictAcme: input.evictAcme });
          if (result.outcome !== "served") {
            throw (OUTCOME_ERRORS[result.outcome] ?? OUTCOME_ERRORS["start_failed_restored"]!)();
          }
          progress.published = true;
          progress.evicted = result.evicted.map((e) => ({ resolver: e.resolver, main: e.main }));
          progress.collateralHosts = [...result.collateralHosts];
        });
      const runRoutes = () =>
        step(
          "routes",
          switchesMode
            ? async () => {
                for (const ctx of ctxs.filter((c) => c.switchesMode)) {
                  progress.routeSites.push(ctx.site.id);
                  await ctx.publish();
                }
              }
            : null,
        );

      await runStage();
      if (toAcme.length > 0) {
        // Back to ACME: the host must route as ACME before the manual certificate leaves the store.
        await runRoutes();
        await runPublish();
      } else {
        await runPublish();
        await runRoutes();
      }

      const served = result as TlsPublishResult | null;
      const generation = served?.generation ?? 0;
      const removed = await this.executor
        .manualTls({ action: "gc", baseGeneration: generation })
        .then((r) => r.removed)
        .catch(() => [] as string[]);

      await settleOperation(db, op.id, { status: "succeeded" }, async (tx) => {
        await this.#settleSuccess(tx, {
          op,
          sites: ctxs.map((c) => ({
            siteId: c.site.id,
            domainIds: c.changes.map((ch) => ch.domainId),
            routes: c.switchesMode ? { plan: c.finalRoutes, hash: routePlanHash(c.finalRoutes, c.hashUrl) } : null,
          })),
          changes: input.changes,
          versions,
          challenge: input.challenge,
          acmeEnabled,
          now,
          generation,
          desired,
          removed,
          evicted: served?.evicted ?? [],
          collateralHosts: served?.collateralHosts ?? [],
        });
      });
    } catch (err) {
      await this.#settleFailure(op, input, progress, err, restoreRoutes);
    }
  }

  async #settleSuccess(
    tx: HostingPanelDatabase,
    r: {
      op: typeof operations.$inferSelect;
      sites: readonly { siteId: string; domainIds: readonly string[]; routes: { plan: SiteHostRoute[]; hash: string } | null }[];
      changes: readonly TlsChangeInput[];
      versions: ReadonlyMap<string, { id: string; certificateId: string; notAfter: Date }>;
      challenge: CertChallenge | null;
      acmeEnabled: boolean;
      now: Date;
      generation: number;
      desired: number;
      removed: readonly string[];
      evicted: readonly { resolver: string; main: string }[];
      collateralHosts: readonly string[];
    },
  ): Promise<void> {
    // No explicit TLS lock: domain rows are written first and the generation UPDATE last, the order a domain remove
    // (row, then bump) also uses, so the two never wait on each other.
    const left = new Set<string>();
    for (const change of r.changes) {
      if (change.versionId !== null) {
        const version = r.versions.get(change.versionId)!;
        const [before] = await tx.select({ mode: domains.certMode, version: domains.manualCertificateVersionId }).from(domains).where(eq(domains.id, change.domainId));
        if (before?.mode === "manual" && before.version && before.version !== change.versionId) left.add(before.version);
        await tx
          .update(domains)
          .set({
            certMode: "manual",
            manualCertificateVersionId: change.versionId,
            certStatus: "active",
            certProblem: null,
            certRetryAt: null,
            certAttempts: 0,
            certExpiresAt: version.notAfter,
            certTrusted: true,
            updatedAt: r.now,
          })
          .where(eq(domains.id, change.domainId));
      } else {
        const [before] = await tx.select({ mode: domains.certMode, version: domains.manualCertificateVersionId }).from(domains).where(eq(domains.id, change.domainId));
        if (before?.mode === "manual" && before.version) left.add(before.version);
        await tx
          .update(domains)
          .set({
            certMode: "acme",
            manualCertificateVersionId: null,
            certStatus: r.acmeEnabled ? "requested" : "none",
            certProblem: null,
            certRetryAt: null,
            certAttempts: 0,
            certExpiresAt: null,
            certRequestedAt: r.acmeEnabled ? r.now : null,
            ...(r.challenge ? { certChallenge: r.challenge } : {}),
            updatedAt: r.now,
          })
          .where(eq(domains.id, change.domainId));
      }
    }

    // Versions the changed domains left and nobody else uses: inactive (never touches another run's `applying`).
    const inactivated = (await this.publisher.inactivateUnused(tx)).filter((id) => left.has(id));
    const targetIds = [...new Set(r.changes.flatMap((c) => (c.versionId === null ? [] : [c.versionId])))];
    for (const versionId of targetIds) {
      const version = r.versions.get(versionId)!;
      await tx
        .update(tlsCertificateVersions)
        .set({ status: "active", activatedAt: r.now, lastCheckedAt: r.now, lastErrorCode: null, publishGeneration: r.generation })
        .where(eq(tlsCertificateVersions.id, versionId));
      await tx.update(tlsCertificates).set({ activeVersionId: versionId, updatedAt: r.now }).where(eq(tlsCertificates.id, version.certificateId));
    }
    for (const site of r.sites) {
      if (!site.routes) continue;
      await tx
        .update(sites)
        .set({ appliedRoutes: site.routes.plan, appliedRoutesHash: site.routes.hash, updatedAt: r.now })
        .where(eq(sites.id, site.siteId));
    }
    await tx
      .update(tlsPublishState)
      .set({ confirmedGeneration: sql`greatest(${tlsPublishState.confirmedGeneration}, ${r.desired})`, updatedAt: r.now })
      .where(eq(tlsPublishState.id, "default"));
    for (const site of r.sites) {
      await appendAuditEvent(tx, {
        actorId: null,
        actorType: "system",
        organizationId: r.op.organizationId,
        action: "site.tls_certificate.applied",
        targetType: "site",
        targetId: site.siteId,
        details: {
          operationId: r.op.id,
          domainIds: site.domainIds,
          versionIds: targetIds,
          inactivatedVersionIds: inactivated,
          removedVersionIds: [...r.removed],
          evicted: r.evicted.map((e) => ({ resolver: e.resolver, main: e.main })),
          collateralHosts: [...r.collateralHosts],
        },
      });
    }
  }

  /** The routes call may have taken effect without the database knowing: forget the applied hash so the next reconcile republishes. */
  async #parkAmbiguous(op: typeof operations.$inferSelect, progress: TlsProgress): Promise<never> {
    if (progress.routeSites.length > 0) {
      await this.dbClient.db
        .update(sites)
        .set({ appliedRoutesHash: null, updatedAt: new Date() })
        .where(inArray(sites.id, progress.routeSites))
        .catch(() => undefined);
    }
    throw new ControlPlaneError("OPERATION_AMBIGUOUS", SITE_TLS_INTERRUPTED, {
      details: [{ field: "versionId", reason: "apply_failed", message: SITE_TLS_INTERRUPTED }],
    });
  }

  async #settleFailure(
    op: typeof operations.$inferSelect,
    input: TlsApplyInput,
    progress: TlsProgress,
    err: unknown,
    restoreRoutes: ReadonlyMap<string, () => Promise<void>>,
  ): Promise<never> {
    const db = this.dbClient.db;
    // A lost answer may have taken effect: the worker parks the operation as unknown and the converge tick republishes.
    // The worker stores the message of what we throw, so it is fixed text, never the executor's.
    if (isAmbiguousFailure(err)) return this.#parkAmbiguous(op, progress);
    const fixed = toFixedError(err);

    try {
      for (const id of progress.routeSites) await restoreRoutes.get(id)?.();
      if (progress.published) {
        const current = await this.publisher.buildSet();
        const back = await this.publisher.publishSet(current, { expect: [] });
        if (back.outcome !== "served") throw new Error("rollback not served");
      }
    } catch {
      // The executor may hold a set the database does not: the operation stays in doubt and the tick republishes.
      return this.#parkAmbiguous(op, progress);
    }

    const steps = await db.select().from(operationSteps).where(eq(operationSteps.operationId, op.id));
    for (const s of steps) {
      if (s.key === progress.step && !["succeeded", "failed", "skipped", "cancelled"].includes(s.status)) {
        await updateOperationStepTransactional(db, op.id, s.key, "failed", STEP_FAILED);
      } else if (s.status === "pending") {
        await updateOperationStepTransactional(db, op.id, s.key, "skipped", STEP_SKIPPED);
      }
    }

    const targetIds = [...new Set(input.changes.flatMap((c) => (c.versionId === null ? [] : [c.versionId])))];
    const [latest] = await db.select().from(operations).where(eq(operations.id, op.id)).limit(1);
    if (latest && !isTerminalOperationStatus(latest.status) && canTransitionOperation(latest.status, "failed")) {
      await settleOperation(db, op.id, { status: "failed", errorCode: fixed.code, errorMessage: SITE_TLS_FAILED }, async (tx) => {
        if (targetIds.length > 0) {
          await tx
            .update(tlsCertificateVersions)
            .set({ status: "failed", lastErrorCode: fixed.problem })
            .where(and(inArray(tlsCertificateVersions.id, targetIds), eq(tlsCertificateVersions.status, "applying")));
        }
        const [first] = targetIds.length > 0
          ? await tx
              .select({ certificateId: tlsCertificateVersions.certificateId })
              .from(tlsCertificateVersions)
              .where(eq(tlsCertificateVersions.id, targetIds[0]!))
          : [];
        await appendAuditEvent(tx, {
          actorId: null,
          actorType: "system",
          organizationId: op.organizationId,
          action: "site.tls_certificate.apply_failed",
          targetType: first ? "tls_certificate" : "site",
          targetId: first?.certificateId ?? op.resourceId,
          details: {
            operationId: op.id,
            siteId: op.resourceId,
            versionId: targetIds[0] ?? null,
            step: progress.step,
            code: fixed.code,
            ...(progress.evicted.length > 0 ? { evicted: progress.evicted } : {}),
            ...(progress.collateralHosts.length > 0 ? { collateralHosts: progress.collateralHosts } : {}),
          },
        });
      });
    }
    throw fixed;
  }
}
