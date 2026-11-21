import { Inject, Injectable } from "@nestjs/common";
import { OPERATION_TERMINAL_STATUSES, MANUAL_TLS_MAX_EXPECTATIONS } from "@hosting-panel/contracts";
import {
  and,
  domains,
  eq,
  inArray,
  isNotNull,
  lockTlsPublishState,
  operations,
  readTlsVersionKey,
  sql,
  tlsCertificateVersions,
  tlsCertificates,
  tlsPublishState,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { DockerExecutorPort, ManualTlsResult } from "@hosting-panel/executor-contracts";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import { recordExpiryAudits } from "./tls-expiry.js";

// HCP-SPEC-004 A5/A6/D9: the one place that talks to the executor's manual-certificate store about the whole set.
// The applier of a `site.tls.apply` run and the converge tick both go through `runExclusive`, so a tick never
// republishes while an apply is between its publish and its settle. The executor's compare-and-swap generation is the
// authority for conflicts; `tls_publish_state.desired_generation` only says "something in the database changed".

const EXPIRY_AUDIT_EVERY_MS = 60 * 60_000;
const PUBLISH_PUT_ATTEMPTS = 2;
// Executor conditions that a fresh read of its inventory resolves (A5: retry once).
const RETRYABLE_REASONS: ReadonlySet<string> = new Set(["TLS_MANIFEST_CONFLICT", "TLS_VERSION_MISSING"]);

/** One published version and the hosts assigned to it. */
export interface TlsSetEntry {
  readonly versionId: string;
  readonly assignedHosts: string[];
}

/** The manual set the database wants served, with the fingerprints the executor must hold. */
export interface TlsSet {
  readonly entries: TlsSetEntry[];
  readonly fingerprints: ReadonlyMap<string, string>;
}

export type TlsExpectation =
  | { readonly hostname: string; readonly fingerprintSha256: string }
  | { readonly hostname: string; readonly notFingerprintSha256: string };

export type TlsPublishResult = ManualTlsResult<"publish">;

export interface TlsConvergeResult {
  readonly status: "busy" | "idle" | "converged" | "unconverged";
  readonly outcome?: TlsPublishResult["outcome"];
}

/** The `reason` / `versionIds` an executor error carries (IPC client and in-process store errors alike). */
export function executorReason(err: unknown): { reason: string | undefined; versionIds: string[] } {
  const e = err as { reason?: unknown; versionIds?: unknown } | null | undefined;
  return {
    reason: typeof e?.reason === "string" ? e.reason : undefined,
    versionIds: Array.isArray(e?.versionIds) ? e.versionIds.filter((v): v is string => typeof v === "string") : [],
  };
}

@Injectable()
export class TlsPublishService {
  #tail: Promise<unknown> = Promise.resolve();
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #lastExpiryAuditAt = 0;
  #serial: Promise<unknown> = Promise.resolve();
  /** The boot converge is repeated on every tick until it has succeeded once (the executor may be down at boot). */
  #bootPending = false;

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly executor: DockerExecutorPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
  ) {}

  /** In-process mutex: `work` starts when every earlier call has finished (its own failure does not block the next). */
  public runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  /** The `desired_generation` read before a set is built: after a served publish, `confirmed` catches up to it. */
  public async readDesiredGeneration(): Promise<number> {
    const [row] = await this.dbClient.db.select({ desired: tlsPublishState.desiredGeneration }).from(tlsPublishState);
    return row?.desired ?? 0;
  }

  /**
   * The manual set after `overlay` (domainId -> version, or null when the domain returns to ACME) is applied to the
   * domain rows. Without an overlay it is the set the database serves right now.
   */
  public async buildSet(overlay: ReadonlyMap<string, string | null> = new Map()): Promise<TlsSet> {
    const db = this.dbClient.db;
    const overlayIds = [...overlay.keys()];
    const rows = await db
      .select({
        id: domains.id,
        hostname: domains.hostname,
        certMode: domains.certMode,
        versionId: domains.manualCertificateVersionId,
      })
      .from(domains)
      .where(
        overlayIds.length > 0
          ? sql`${domains.certMode} = 'manual' OR ${inArray(domains.id, overlayIds)}`
          : eq(domains.certMode, "manual"),
      );
    const hostsByVersion = new Map<string, string[]>();
    for (const row of rows) {
      const versionId = overlay.has(row.id) ? overlay.get(row.id)! : row.certMode === "manual" ? row.versionId : null;
      if (versionId === null || versionId === undefined) continue;
      hostsByVersion.set(versionId, [...(hostsByVersion.get(versionId) ?? []), row.hostname.toLowerCase()]);
    }
    const versionIds = [...hostsByVersion.keys()].sort();
    const fingerprints = new Map<string, string>();
    if (versionIds.length > 0) {
      const found = await db
        .select({ id: tlsCertificateVersions.id, fingerprint: tlsCertificateVersions.fingerprintSha256 })
        .from(tlsCertificateVersions)
        .where(inArray(tlsCertificateVersions.id, versionIds));
      for (const v of found) fingerprints.set(v.id, v.fingerprint);
    }
    return {
      entries: versionIds
        .filter((id) => fingerprints.has(id))
        .map((versionId) => ({ versionId, assignedHosts: [...new Set(hostsByVersion.get(versionId)!)].sort() })),
      fingerprints,
    };
  }

  /** Sends the key material of the versions the executor does not hold (JIT decrypt; the plaintext never leaves this frame). */
  public async putMissing(set: TlsSet, inventory?: ManualInventory): Promise<string[]> {
    const inv = inventory ?? (await this.executor.manualTls({ action: "inventory" }));
    const held = new Set(inv.versions.map((v) => v.versionId));
    for (const id of inv.missing) held.delete(id);
    const missing = set.entries.map((e) => e.versionId).filter((id) => !held.has(id));
    await this.putVersions(missing, set);
    return missing;
  }

  async putVersions(versionIds: readonly string[], set: TlsSet): Promise<void> {
    for (const versionId of versionIds) {
      const fingerprintSha256 = set.fingerprints.get(versionId);
      if (fingerprintSha256 === undefined) continue;
      const material = await readTlsVersionKey(this.dbClient.db, { versionId, masterKey: this.config.secretsMasterKey });
      await this.executor.manualTls({
        action: "putVersion",
        versionId,
        fullchainPem: material.fullchainPem,
        keyPem: material.privateKeyPem,
        fingerprintSha256,
      });
    }
  }

  /**
   * Compare-and-swap publish of `set`: reads the executor's inventory for the base generation, puts the missing
   * versions, publishes with `expect`. A manifest conflict or missing versions are re-read and retried once; any other
   * executor error is the caller's. The result may be a refusal (`outcome` other than `served`): nothing was changed.
   */
  public async publishSet(
    set: TlsSet,
    opts: { readonly expect: readonly TlsExpectation[]; readonly evictAcme?: boolean },
  ): Promise<TlsPublishResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < PUBLISH_PUT_ATTEMPTS; attempt += 1) {
      const inventory = await this.executor.manualTls({ action: "inventory" });
      await this.putMissing(set, inventory);
      try {
        return await this.executor.manualTls({
          action: "publish",
          baseGeneration: inventory.generation,
          entries: set.entries.map((e) => ({ versionId: e.versionId, assignedHosts: e.assignedHosts })),
          expect: opts.expect.map((e) => ({ ...e })),
          evictAcme: opts.evictAcme === true,
        });
      } catch (err) {
        const { reason } = executorReason(err);
        if (reason === undefined || !RETRYABLE_REASONS.has(reason)) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  /** Fingerprint expectations for every host of `set` (capped at the wire limit). */
  public expectAll(set: TlsSet): TlsExpectation[] {
    return set.entries
      .flatMap((e) => e.assignedHosts.map((hostname) => ({ hostname, fingerprintSha256: set.fingerprints.get(e.versionId)! })))
      .slice(0, MANUAL_TLS_MAX_EXPECTATIONS);
  }

  /**
   * Brings the executor in line with the database when something changed (`desired > confirmed`, a domain or site that
   * held a certificate went away) or an apply left a version `applying` with no operation (a crash), and once at boot.
   * Never runs while a `site.tls.apply` is queued or running. After a served publish: `confirmed` catches up, versions
   * no domain uses become `inactive`, orphan `applying` versions become `failed`/`interrupted`, then a best-effort gc.
   */
  public converge(opts: { readonly boot?: boolean } = {}): Promise<TlsConvergeResult> {
    return this.runExclusive(() => this.#converge(opts.boot === true));
  }

  async #converge(boot: boolean): Promise<TlsConvergeResult> {
    const db = this.dbClient.db;
    if ((await this.#activeApplyCount(db)) > 0) return { status: "busy" };
    const [state] = await db.select().from(tlsPublishState);
    const desired = state?.desiredGeneration ?? 0;
    const orphans = await db
      .select({ id: tlsCertificateVersions.id })
      .from(tlsCertificateVersions)
      .where(eq(tlsCertificateVersions.status, "applying"))
      .limit(1);
    const dirty = desired > (state?.confirmedGeneration ?? 0) || orphans.length > 0;
    if (!dirty && !boot) return { status: "idle" };

    const set = await this.buildSet();
    const inventory = await this.executor.manualTls({ action: "inventory" });
    const sameEntries =
      JSON.stringify(inventory.entries.map((e) => [e.versionId, [...e.assignedHosts].sort()]).sort()) ===
      JSON.stringify(set.entries.map((e) => [e.versionId, e.assignedHosts]).sort());
    let generation = inventory.generation;
    if (dirty || !sameEntries || inventory.missing.length > 0) {
      const result = await this.publishSet(set, { expect: this.expectAll(set) });
      if (result.outcome !== "served") return { status: "unconverged", outcome: result.outcome };
      generation = result.generation;
    }
    await this.#settleConverged(desired);
    await this.executor.manualTls({ action: "gc", baseGeneration: generation }).catch(() => undefined);
    return { status: "converged" };
  }

  async #activeApplyCount(db: HostingPanelDatabase): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(operations)
      .where(
        and(
          eq(operations.kind, "site.tls.apply"),
          sql`${operations.status} NOT IN (${sql.join(OPERATION_TERMINAL_STATUSES.map((s) => sql`${s}`), sql`, `)})`,
        ),
      );
    return row?.count ?? 0;
  }

  async #settleConverged(desired: number): Promise<void> {
    await this.dbClient.db.transaction(async (tx) => {
      const t = tx as unknown as HostingPanelDatabase;
      // Enqueueing an apply takes this lock too: the re-check below cannot miss one that just committed.
      await lockTlsPublishState(tx);
      await tx
        .update(tlsPublishState)
        .set({ confirmedGeneration: sql`greatest(${tlsPublishState.confirmedGeneration}, ${desired})`, updatedAt: new Date() })
        .where(eq(tlsPublishState.id, "default"));
      await this.inactivateUnused(t);
      if ((await this.#activeApplyCount(t)) > 0) return;
      await tx
        .update(tlsCertificateVersions)
        .set({ status: "failed", lastErrorCode: "interrupted" })
        .where(eq(tlsCertificateVersions.status, "applying"));
    });
  }

  /** Published versions no domain uses any more: `inactive`, and no longer the certificate's active version. */
  public async inactivateUnused(tx: HostingPanelDatabase): Promise<string[]> {
    const unused = await tx
      .select({ id: tlsCertificateVersions.id })
      .from(tlsCertificateVersions)
      .where(
        and(
          eq(tlsCertificateVersions.status, "active"),
          sql`${tlsCertificateVersions.id} NOT IN (SELECT ${domains.manualCertificateVersionId} FROM ${domains} WHERE ${isNotNull(domains.manualCertificateVersionId)})`,
        ),
      );
    const ids = unused.map((v) => v.id);
    if (ids.length === 0) return ids;
    await tx.update(tlsCertificateVersions).set({ status: "inactive" }).where(inArray(tlsCertificateVersions.id, ids));
    await tx
      .update(tlsCertificates)
      .set({ activeVersionId: null, updatedAt: new Date() })
      .where(inArray(tlsCertificates.activeVersionId, ids));
    return ids;
  }

  /** One tick: converge, and once an hour the expiry audit. Each part fails alone. */
  public async tick(now: Date = new Date()): Promise<void> {
    await this.converge().catch(() => undefined);
    if (now.getTime() - this.#lastExpiryAuditAt >= EXPIRY_AUDIT_EVERY_MS) {
      this.#lastExpiryAuditAt = now.getTime();
      await recordExpiryAudits(this.dbClient.db, now).catch(() => undefined);
    }
  }

  /** Runs once at start (boot converge: the executor may have been restored) and then every `intervalMs`. */
  public startBackgroundLoop(intervalMs: number | null): void {
    if (this.#stopped || this.#timer || !intervalMs || intervalMs <= 0) return;
    const run = (boot: boolean): void => {
      if (this.#stopped) return;
      this.#serial = this.#serial.then(async () => {
        if (this.#stopped) return;
        if (boot) this.#bootPending = true;
        if (this.#bootPending) {
          this.#bootPending = await this.converge({ boot: true }).then(
            (r) => r.status === "busy" || r.status === "unconverged",
            () => true,
          );
        }
        await this.tick();
      });
    };
    run(true);
    this.#timer = setInterval(() => run(false), intervalMs);
    this.#timer.unref();
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#serial.catch(() => undefined);
  }
}

type ManualInventory = ManualTlsResult<"inventory">;
