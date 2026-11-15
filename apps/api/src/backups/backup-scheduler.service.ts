import { Inject, Injectable } from "@nestjs/common";
import { PLATFORM_OPS_ORG_ID, isBackupAvailable } from "@hosting-panel/contracts";
import {
  ACTIVE_OPERATION_LOCK_STATUSES,
  and,
  appendAuditEvent,
  countNightlyRunResults,
  enqueueOperationTransactional,
  eq,
  findNextNightlySite,
  finishNightlyRun,
  inArray,
  insertSiteBackup,
  listOrphanSiteIdsWithBackupsBefore,
  lockNightlyRunState,
  operations,
  organizations,
  platformInstallations,
  siteBackups,
  sql,
  startNightlyRun,
  type DatabaseClient,
  type DatabaseExecutor,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import { BACKUP_OPERATION_KINDS, OutboxWorkerService } from "../runtime/outbox-worker.service.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import { BACKUP_LEASE_MS } from "./site-backups-applier.js";
import { SITE_BACKUP_PRUNE_STEPS, SiteBackupsService } from "./site-backups.service.js";

const PLATFORM_OPS_ORG_SLUG = "platform-ops";
const MS_PER_DAY = 86_400_000;

function isResourceLockedError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "RESOURCE_LOCKED"
  );
}

/** Schedules nightly UTC site backups one site at a time and queues orphan prunes when done. */
@Injectable()
export class BackupSchedulerService {
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #running: Promise<void> | null = null;
  #inFlightTicks = 0;

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(OutboxWorkerService) private readonly outboxWorker: OutboxWorkerService,
  ) {}

  /** Starts the polling timer when configured with a positive interval. */
  public startBackgroundLoop(
    intervalMs: number | null | undefined = this.config.backupScheduleIntervalMs,
  ): void {
    if (this.#stopped || this.#timer || !intervalMs || intervalMs <= 0) {
      return;
    }

    const run = (): void => {
      if (this.#stopped || this.#running || this.#inFlightTicks > 0) {
        return;
      }
      this.#running = this.tick()
        .catch((err: unknown) => {
          if (this.#stopped) {
            return;
          }
          const rawCode =
            typeof err === "object" && err !== null && "code" in err
              ? (err as { code?: unknown }).code
              : undefined;
          console.warn(
            JSON.stringify({
              event: "backup_scheduler_tick_failed",
              code: typeof rawCode === "string" ? rawCode : "INTERNAL_ERROR",
            }),
          );
        })
        .finally(() => {
          this.#running = null;
        });
    };

    run();
    this.#timer = setInterval(run, intervalMs);
    this.#timer.unref();
  }

  /** Stops the background polling loop and awaits any tick currently in progress. */
  public async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#running;
  }

  /** Evaluates the current UTC schedule and queues at most one nightly site backup or finishes the run. */
  public async tick(now: Date = new Date()): Promise<void> {
    if (!isBackupAvailable(this.config.runtimeBackend)) {
      return;
    }

    const today = now.toISOString().slice(0, 10);
    const hourUtc = now.getUTCHours();

    this.#inFlightTicks += 1;
    let shouldTriggerOutbox: boolean;
    try {
      shouldTriggerOutbox = await this.dbClient.db.transaction(async (tx) => {
        // Lock the singleton settings row for the full tick so concurrent ticks never interleave.
        const locked = await lockNightlyRunState(tx);
        if (!locked) {
          return false;
        }

        let runState = locked;
        if (runState.nightlyRunStartedAt === null) {
          const started = await startNightlyRun(tx, today, hourUtc, now);
          if (!started) {
            return false;
          }
          runState = started;
        }

        const runStartedAt = runState.nightlyRunStartedAt!;

        const [activeRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(operations)
          .where(
            and(
              inArray(operations.kind, BACKUP_OPERATION_KINDS),
              inArray(operations.status, ACTIVE_OPERATION_LOCK_STATUSES),
            ),
          );
        if ((activeRow?.count ?? 0) > 0) {
          return false;
        }

        const rowStartedAt = now.getTime() < runStartedAt.getTime() ? runStartedAt : now;
        while (true) {
          const site = await findNextNightlySite(tx, runStartedAt);
          if (!site) {
            break;
          }
          try {
            // Nested savepoint isolates lock/unique errors so a busy site never aborts the tick tx.
            await tx.transaction(async (sp) => {
              const enqueued = await SiteBackupsService.enqueueBackupTx(sp, site, {
                kind: "nightly",
              });
              // Align startedAt with tick clock so synthetic/adjusted ticks stay >= nightlyRunStartedAt.
              await sp
                .update(siteBackups)
                .set({ startedAt: rowStartedAt })
                .where(eq(siteBackups.id, enqueued.backupId));
            });
            return true;
          } catch (err: unknown) {
            if (isResourceLockedError(err)) {
              await insertSiteBackup(tx, {
                siteId: site.id,
                kind: "nightly",
                status: "failed",
                operationId: null,
                problem: "site_busy",
                startedAt: rowStartedAt,
              });
            } else {
              throw err;
            }
          }
        }

        const cutoff = new Date(now.getTime() - runState.retentionDays * MS_PER_DAY);
        const orphanSiteIds = await listOrphanSiteIdsWithBackupsBefore(tx, cutoff);
        let pruned = 0;
        if (orphanSiteIds.length > 0) {
          await this.#ensurePlatformOpsOrg(tx);
          for (const orphanSiteId of orphanSiteIds) {
            try {
              await tx.transaction(async (sp) => {
                await enqueueOperationTransactional(sp as unknown as HostingPanelDatabase, {
                  organizationId: PLATFORM_OPS_ORG_ID,
                  kind: "site.backups.prune",
                  resourceType: "site",
                  resourceId: orphanSiteId,
                  lockKey: `site:${orphanSiteId}`,
                  leaseDurationMs: BACKUP_LEASE_MS,
                  steps: SITE_BACKUP_PRUNE_STEPS,
                  outboxPayload: { siteId: orphanSiteId },
                });
              });
              pruned += 1;
            } catch (err: unknown) {
              if (!isResourceLockedError(err)) {
                throw err;
              }
            }
          }
        }

        const counts = await countNightlyRunResults(tx, runStartedAt);
        await appendAuditEvent(tx as unknown as HostingPanelDatabase, {
          actorId: null,
          actorType: "system",
          organizationId: null,
          action: "backups.nightly_run",
          targetType: "backups",
          targetId: null,
          details: {
            date: runState.lastNightlyRunOn ?? today,
            enqueued: counts.enqueued,
            busy: counts.busy,
            pruned,
          },
        });
        await finishNightlyRun(tx);

        return pruned > 0;
      });
    } finally {
      this.#inFlightTicks -= 1;
    }

    if (shouldTriggerOutbox) {
      this.outboxWorker.triggerAsync();
    }
  }

  async #ensurePlatformOpsOrg(tx: DatabaseExecutor): Promise<void> {
    const [existing] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, PLATFORM_OPS_ORG_ID))
      .limit(1);
    if (existing) {
      return;
    }

    const [inst] = await tx
      .select({ id: platformInstallations.id })
      .from(platformInstallations)
      .limit(1);
    if (!inst) {
      return;
    }

    await tx
      .insert(organizations)
      .values({
        id: PLATFORM_OPS_ORG_ID,
        platformInstallationId: inst.id,
        name: "Platform Infrastructure Operations",
        slug: PLATFORM_OPS_ORG_SLUG,
        status: "active",
      })
      .onConflictDoNothing();
  }
}
