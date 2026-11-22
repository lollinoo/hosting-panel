import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  APP_AUDIT_ACTIONS,
  APP_AUDIT_TARGET_TYPES,
  APP_STACK_BUSY_STATUSES,
  APP_STACK_RESOURCE_TYPE,
  ApprovedStackPlanSchema,
  isTerminalOperationStatus,
  redactSensitiveString,
  type AppStackStatus,
  type ApprovedStackPlan,
  type CertProblem,
  type DnsStatus,
} from "@hosting-panel/contracts";
import {
  ACTIVE_OPERATION_LOCK_STATUSES,
  and,
  appendAuditEvent,
  appStackComponents,
  appStackDomains,
  appStacks,
  asc,
  desc,
  enqueueAppStackOperationTransactional,
  eq,
  getAppStackRevision,
  hostAllocations,
  hosts,
  inArray,
  isNotNull,
  isNull,
  listAppStackDomains,
  operations,
  or,
  recordAppStackComponentHealthTransactional,
  sql,
  updateAppStackDomainState,
  type AppStackDomainRow,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import { isStackExecutor, type CertificateStatusReport, type DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { canonicalRequestHash } from "../common/request-hash.js";
import { OutboxWorkerService } from "../runtime/outbox-worker.service.js";
import type { DnsLookup } from "../sites/dns-check.js";
import { CERT_REQUEST_TIMEOUT_MS, MANUAL_CERT_RETRY_GAP_MS, certRetryAt, evaluateDns, nextDnsCheckAt } from "../sites/domain-policy.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DNS_LOOKUP_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import {
  APP_STACK_OBSERVE_BATCH,
  APP_STACK_OBSERVE_PASS_BUDGET_MS,
  APP_STACK_ROUTE_REFRESH_BACKOFF_MS,
  appStackHealthRows,
  appStackRoutePlan,
  appStackRoutesHash,
} from "./app-stack-runtime-policy.js";

const FAILURE_WINDOW_MS = 10 * 60_000;
const OBSERVED_STATUSES: AppStackStatus[] = ["running", "degraded", "failed", "unknown"];
const noActiveOperation = sql`NOT EXISTS (SELECT 1 FROM ${operations} WHERE ${operations.lockKey} = 'stack:' || ${appStacks.id} AND ${inArray(operations.status, [...ACTIVE_OPERATION_LOCK_STATUSES])})`;
const hasDomainRows = sql<boolean>`EXISTS (SELECT 1 FROM ${appStackDomains} WHERE ${appStackDomains.stackId} = ${appStacks.id})`;

interface StackRef {
  readonly stackId: string;
  readonly organizationId: string;
  readonly appliedRevisionId: string | null;
}

interface ManagedStack extends StackRef {
  readonly status: AppStackStatus;
  readonly desiredRevisionId: string | null;
  readonly appliedRoutesHash: string | null;
  readonly ipv4: string;
  readonly hasDomains: boolean;
  /** An operation runs: only failed orders are classified, nothing else moves. */
  readonly busy: boolean;
}

type DomainStateSet = Parameters<typeof updateAppStackDomainState>[1]["set"];

/**
 * Every 60 s: component health of idle stacks, the DNS/ACME state of stack addresses, and a system `stack.deploy` of
 * the applied revision when a running stack's routes no longer match its addresses. It never starts, restarts or
 * recreates a component and never writes app_stacks.status. All entry points share one promise chain.
 */
@Injectable()
export class AppStackObserverService {
  #stopped = false;
  #timer: NodeJS.Timeout | null = null;
  #serial: Promise<unknown> = Promise.resolve();
  readonly #certSeenAt = new Map<string, number>();

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly executor: DockerExecutorPort,
    @Inject(DNS_LOOKUP_TOKEN) private readonly dns: DnsLookup,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(OutboxWorkerService) private readonly outboxWorker: OutboxWorkerService,
  ) {}

  public startBackgroundLoop(): void {
    const intervalMs = this.config.domainReconcileIntervalMs;
    if (this.#stopped || this.#timer || !intervalMs || intervalMs <= 0) return;
    this.#timer = setInterval(() => {
      if (!this.#stopped) void this.reconcileOnce().catch(() => undefined);
    }, intervalMs);
    this.#timer.unref();
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#serial;
  }

  public reconcileOnce(now = new Date()): Promise<void> {
    return this.#queue(() => this.#run(null, now, () => false));
  }

  /** After a domain add/remove/check; `forceDnsIds` looks those addresses up now even when not due. */
  public reconcileStack(
    organizationId: string,
    stackId: string,
    now: Date,
    opts: { readonly forceDnsIds?: readonly string[] } = {},
  ): Promise<void> {
    return this.#queue(() => this.#run({ organizationId, stackId }, now, (id) => opts.forceDnsIds?.includes(id) ?? false));
  }

  #queue(work: () => Promise<void>): Promise<void> {
    const run = this.#serial.then(work);
    this.#serial = run.catch(() => undefined);
    return run;
  }

  async #run(
    only: { readonly organizationId: string; readonly stackId: string } | null,
    now: Date,
    forceDns: (domainId: string) => boolean,
  ): Promise<void> {
    if (this.config.runtimeBackend === "disabled") return;
    if (only === null) await this.#observeHealth(now);
    const db = this.dbClient.db;
    const rows = await db
      .select({
        stackId: appStacks.id,
        organizationId: appStacks.organizationId,
        status: appStacks.status,
        appliedRevisionId: appStacks.appliedRevisionId,
        desiredRevisionId: appStacks.desiredRevisionId,
        appliedRoutesHash: appStacks.appliedRoutesHash,
        ipv4: hosts.ipv4Address,
        hasDomains: hasDomainRows,
      })
      .from(appStacks)
      .innerJoin(hostAllocations, eq(hostAllocations.id, appStacks.hostAllocationId))
      .innerJoin(hosts, eq(hosts.id, hostAllocations.hostId))
      .where(
        and(
          isNull(appStacks.deletedAt),
          ...(only ? [eq(appStacks.id, only.stackId), eq(appStacks.organizationId, only.organizationId)] : []),
          or(isNotNull(appStacks.appliedRoutesHash), hasDomainRows),
        ),
      );
    const managed: ManagedStack[] = rows.map((r) => ({
      ...r,
      busy: (APP_STACK_BUSY_STATUSES as readonly AppStackStatus[]).includes(r.status),
    }));

    for (const stack of managed.filter((s) => !s.busy)) {
      if (only) await this.#checkDns(stack, now, forceDns);
      else await this.#checkDns(stack, now, forceDns).catch(() => undefined);
    }

    let report: CertificateStatusReport | null = null;
    const withDomains = managed.filter((s) => s.hasDomains);
    if (withDomains.length > 0) {
      const requestedAt = (
        await db
          .select({ at: appStackDomains.certRequestedAt })
          .from(appStackDomains)
          .where(and(inArray(appStackDomains.stackId, withDomains.map((s) => s.stackId)), eq(appStackDomains.certStatus, "requested")))
      )
        .map((r) => r.at?.getTime())
        .filter((t): t is number => t !== undefined);
      const failuresSince = new Date(requestedAt.length > 0 ? Math.min(...requestedAt) : now.getTime() - FAILURE_WINDOW_MS);
      // The site reconciler owns the panel_certificate heartbeat: a failed read only skips this pass.
      report = await this.executor.getCertificateStatus({ failuresSince: failuresSince.toISOString() }).catch(() => null);
    }

    let enqueued = false;
    for (const stack of managed) {
      const work = async () => {
        if (stack.hasDomains) {
          if (report === null) return;
          await this.#updateCertificates(stack, now, report);
        }
        enqueued = (await this.#refreshRoutes(stack, now, report?.acmeEnabled ?? false)) || enqueued;
      };
      if (only) await work();
      else await work().catch(() => undefined);
    }
    if (enqueued) this.outboxWorker.triggerAsync();
  }

  /**
   * Oldest observation first, at most APP_STACK_OBSERVE_BATCH applied stacks; a failed read records `unknown` now, so
   * the stack moves to the back of the queue instead of starving the others.
   */
  async #observeHealth(now: Date): Promise<void> {
    const port = this.executor;
    if (!isStackExecutor(port)) return;
    const db = this.dbClient.db;
    const oldest = sql`(SELECT min(${appStackComponents.healthObservedAt}) FROM ${appStackComponents} WHERE ${appStackComponents.stackId} = ${appStacks.id})`;
    const candidates: StackRef[] = await db
      .select({ stackId: appStacks.id, organizationId: appStacks.organizationId, appliedRevisionId: appStacks.appliedRevisionId })
      .from(appStacks)
      .where(
        and(isNull(appStacks.deletedAt), isNotNull(appStacks.appliedRevisionId), inArray(appStacks.status, OBSERVED_STATUSES), noActiveOperation),
      )
      .orderBy(sql`${oldest} ASC NULLS FIRST`, asc(appStacks.id))
      .limit(APP_STACK_OBSERVE_BATCH);
    const passStart = Date.now();
    for (const stack of candidates) {
      if (Date.now() - passStart >= APP_STACK_OBSERVE_PASS_BUDGET_MS) break;
      const work = async () => {
        const plan = await this.#appliedPlan(stack);
        if (plan === null) return;
        const observed = await port.getAppStackStatus({ stackId: stack.stackId, organizationId: stack.organizationId }).catch(() => null);
        await db.transaction((tx) =>
          recordAppStackComponentHealthTransactional(tx, {
            organizationId: stack.organizationId,
            stackId: stack.stackId,
            observedAt: now,
            components:
              observed === null
                ? plan.components.map((c) => ({ componentKey: c.key, health: "unknown" as const }))
                : appStackHealthRows(plan, observed, "observer"),
          }),
        );
      };
      await work().catch(() => undefined);
    }
  }

  async #appliedPlan(stack: StackRef): Promise<ApprovedStackPlan | null> {
    if (stack.appliedRevisionId === null) return null;
    const revision = await getAppStackRevision(this.dbClient.db, { ...stack, revisionId: stack.appliedRevisionId });
    const parsed = ApprovedStackPlanSchema.safeParse(revision?.plan);
    return parsed.success ? parsed.data : null;
  }

  async #checkDns(stack: ManagedStack, now: Date, force: (domainId: string) => boolean): Promise<void> {
    const db = this.dbClient.db;
    for (const row of await listAppStackDomains(db, stack)) {
      if (!force(row.id) && row.dnsNextCheckAt > now) continue;
      let observed = { a: [] as string[], aaaa: [] as string[] };
      let status: DnsStatus;
      try {
        observed = await this.dns.lookup(row.hostname);
        status = evaluateDns(observed, stack.ipv4);
      } catch {
        status = "lookup_failed";
      }
      await updateAppStackDomainState(db, {
        domainId: row.id,
        set: {
          dnsStatus: status,
          dnsObserved: observed,
          dnsCheckedAt: now,
          dnsAttempts: status === "ok" ? 0 : row.dnsAttempts + 1,
          dnsNextCheckAt: nextDnsCheckAt(now, status, row.dnsAttempts),
        },
      });
    }
  }

  async #updateCertificates(stack: ManagedStack, now: Date, report: CertificateStatusReport): Promise<void> {
    // CP-01: an unreadable or half-written store never moves a certificate state.
    if (!report.readable) return;
    const stored = new Map(report.certificates.map((c) => [c.hostname, c]));

    for (const row of await listAppStackDomains(this.dbClient.db, stack)) {
      const cert = stored.get(row.hostname);
      // A busy stack's failing name must lose its resolver, or every proxy reload re-orders it.
      if (stack.busy && (row.certStatus !== "requested" || cert)) continue;
      const failures = report.failures
        .filter((f) => f.hostname === row.hostname)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      // DNS-01 needs no A record, only the proxy's DNS resolver.
      const dnsReady = row.certChallenge === "dns-01" ? report.dnsChallenge === true : row.dnsStatus === "ok";

      if (cert) {
        const expiresAt = new Date(cert.notAfter);
        // A new certificate always brings a new expiry: that stands in for the serial, which is not stored.
        const isNew = row.certStatus !== "active" || row.certExpiresAt?.getTime() !== expiresAt.getTime();
        if (isNew) {
          const ok = await this.#transition(row, {
            certStatus: "active",
            certExpiresAt: expiresAt,
            certTrusted: report.trusted,
            certProblem: null,
            certAttempts: 0,
            certRetryAt: null,
          });
          if (ok) {
            this.#certSeenAt.set(row.id, now.getTime());
            await this.#audit(stack, row, "site.certificate.issued", {
              hostname: row.hostname,
              serialNumber: cert.serialNumber,
              expiresAt: expiresAt.toISOString(),
            });
          }
          continue;
        }
        const seenAt = this.#certSeenAt.get(row.id) ?? 0;
        const renewFailure = failures.find((f) => f.kind === "renew" && Date.parse(f.at) > seenAt);
        const problem = renewFailure?.problem ?? row.certProblem;
        if (problem !== row.certProblem || report.trusted !== row.certTrusted) {
          await this.#transition(row, { certProblem: problem, certTrusted: report.trusted });
        }
        continue;
      }

      if (row.certStatus === "active") {
        // The store lost it (e.g. a CA switch): Traefik re-obtains it under the same resolver.
        await this.#transition(row, { certStatus: "requested", certRequestedAt: now });
        continue;
      }

      if (row.certStatus === "requested") {
        const since = row.certRequestedAt?.getTime() ?? 0;
        const failure = failures.find((f) => Date.parse(f.at) >= since);
        if (failure) {
          await this.#fail(stack, row, failure.problem, failure.detail, now);
        } else if (
          now.getTime() - since >= CERT_REQUEST_TIMEOUT_MS &&
          // CP-01: a row whose real certificate is still valid keeps its resolver (e.g. the store lost it).
          !(row.certExpiresAt !== null && row.certExpiresAt > now)
        ) {
          await this.#fail(stack, row, "other", "No certificate and no reported failure within 10 minutes", now);
        } else if (!dnsReady && row.certExpiresAt === null) {
          // Only a fresh request is DNS-gated; a re-request of a lost certificate (expiry kept) stays.
          await this.#transition(row, { certStatus: "none" });
        }
        continue;
      }

      const due = row.certStatus === "none" || (row.certRetryAt !== null && row.certRetryAt <= now);
      // At most one order per 15 min, even when DNS flaps and requested→none is followed by "Check now".
      const gapOk = !row.certRequestedAt || now.getTime() >= row.certRequestedAt.getTime() + MANUAL_CERT_RETRY_GAP_MS;
      if (due && gapOk && dnsReady && row.status === "active" && report.acmeEnabled) {
        // certExpiresAt null marks a fresh request (see the DNS gate above).
        const ok = await this.#transition(row, { certStatus: "requested", certRequestedAt: now, certExpiresAt: null });
        if (ok) await this.#audit(stack, row, "site.certificate.requested", { hostname: row.hostname, challenge: row.certChallenge });
      }
    }
  }

  async #fail(stack: ManagedStack, row: AppStackDomainRow, problem: CertProblem, detail: string, now: Date): Promise<void> {
    // Never earlier than a retry already scheduled; only "Check now" may bring it forward.
    const retryAt = Math.max(certRetryAt(now, problem, row.certAttempts).getTime(), row.certRetryAt?.getTime() ?? 0);
    const ok = await this.#transition(row, {
      certStatus: "failed",
      certProblem: problem,
      certAttempts: row.certAttempts + 1,
      certRetryAt: new Date(retryAt),
    });
    // Raw ACME text is admin-only (customers lack audit.read), redacted and capped at 1 KiB.
    if (ok) {
      await this.#audit(stack, row, "site.certificate.failed", {
        hostname: row.hostname,
        problem,
        detail: redactSensitiveString(detail).slice(0, 1024),
        challenge: row.certChallenge,
      });
    }
  }

  /** Guarded on the state we read: false means another writer won, and the change is dropped. */
  #transition(row: AppStackDomainRow, set: DomainStateSet): Promise<boolean> {
    return updateAppStackDomainState(this.dbClient.db, { domainId: row.id, expect: { certStatus: row.certStatus }, set });
  }

  /** Site action names, so the 24 h certificate throttle (action + hostname) is shared with sites. */
  #audit(stack: ManagedStack, row: AppStackDomainRow, action: string, details: Record<string, unknown>) {
    return appendAuditEvent(this.dbClient.db, {
      actorId: null,
      actorType: "system",
      organizationId: stack.organizationId,
      action,
      targetType: APP_AUDIT_TARGET_TYPES.domain,
      targetId: row.id,
      details,
    });
  }

  /** Returns true when a system stack.deploy of the applied revision was queued. */
  async #refreshRoutes(stack: ManagedStack, now: Date, acmeEnabled: boolean): Promise<boolean> {
    const { appliedRevisionId } = stack;
    if (stack.status !== "running" && stack.status !== "degraded") return false;
    if (appliedRevisionId === null || appliedRevisionId !== stack.desiredRevisionId) return false;
    const db = this.dbClient.db;
    const [last] = await db
      .select({ kind: operations.kind, status: operations.status, completedAt: operations.completedAt })
      .from(operations)
      .where(and(eq(operations.resourceType, APP_STACK_RESOURCE_TYPE), eq(operations.resourceId, stack.stackId)))
      .orderBy(desc(operations.submittedAt))
      .limit(1);
    // A deploy would start what the customer last asked to stop.
    if (last?.kind === "stack.stop") return false;
    if (last && !isTerminalOperationStatus(last.status)) return false;
    if (last?.status === "failed" && last.completedAt && now.getTime() - last.completedAt.getTime() < APP_STACK_ROUTE_REFRESH_BACKOFF_MS) {
      return false;
    }
    // A deploy would start (or recreate) a component someone stopped: the routes wait until the application runs again.
    const [stopped] = await db
      .select({ componentKey: appStackComponents.componentKey })
      .from(appStackComponents)
      .where(
        and(
          eq(appStackComponents.stackId, stack.stackId),
          eq(appStackComponents.organizationId, stack.organizationId),
          inArray(appStackComponents.health, ["stopped", "missing"]),
        ),
      )
      .limit(1);
    if (stopped) return false;
    const plan = await this.#appliedPlan(stack);
    if (plan === null) return false;
    const { entries } = appStackRoutePlan({
      plan,
      domains: await listAppStackDomains(db, stack),
      include: new Set(plan.ingress.map((r) => r.componentKey)),
      now,
      acmeEnabled,
    });
    if ((entries.length > 0 ? appStackRoutesHash(entries) : null) === stack.appliedRoutesHash) return false;

    const { organizationId, stackId } = stack;
    try {
      await db.transaction(async (tx) => {
        const queued = await enqueueAppStackOperationTransactional(tx as unknown as HostingPanelDatabase, {
          organizationId,
          stackId,
          kind: "stack.deploy",
          requestedByUserId: null,
          idempotencyKey: `sys_routes_${randomUUID().replace(/-/g, "")}`,
          requestHash: canonicalRequestHash({
            route: "app.stack.deploy",
            organizationId,
            stackId,
            body: { revisionId: appliedRevisionId, trigger: "routes" },
          }),
          revision: null,
          destroyData: false,
        });
        if (queued.idempotentReplay) return;
        await appendAuditEvent(tx, {
          actorType: "system",
          actorId: null,
          organizationId,
          action: APP_AUDIT_ACTIONS.stackDeploy,
          targetType: APP_AUDIT_TARGET_TYPES.stack,
          targetId: stackId,
          details: {
            operationId: queued.operation?.id ?? null,
            deploymentId: queued.deployment?.id ?? null,
            revisionId: appliedRevisionId,
            templateVersionId: queued.revision?.templateVersionId ?? null,
            status: queued.stack.status,
            trigger: "routes",
          },
        });
      });
      return true;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "RESOURCE_LOCKED" || code === "INVALID_TRANSITION") return false; // The next pass retries.
      throw err;
    }
  }
}
