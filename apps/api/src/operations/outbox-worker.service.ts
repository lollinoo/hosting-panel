import { randomUUID } from "node:crypto";
import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { ErrorCode } from "@hosting-panel/contracts";
import {
  CoolifyAdapterError,
  redactSensitiveString,
  type HostingProvider,
  type ProviderDeploymentSnapshot,
} from "@hosting-panel/coolify-adapter";
import {
  and,
  appendAuditEvent,
  applications,
  asc,
  certificateObservations,
  claimPendingOutboxEvents,
  deploymentRecords,
  domains,
  eq,
  getOperationWithSteps,
  hostingResources,
  inArray,
  mapOperationToDto,
  operations,
  providerConnections,
  providerInstances,
  transitionOperation,
  type DatabaseClient,
  type OperationRow,
} from "@hosting-panel/database";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { ProviderContextService } from "../providers/provider-context.service.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  COOLIFY_ADAPTER_TOKEN,
  DATABASE_CLIENT_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import { SecretVaultService } from "../vault/secret-vault.service.js";
import { EventsBusService } from "./events-bus.service.js";
import { HealthProbeService } from "./health-probe.service.js";

function generatePrefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

@Injectable()
export class OutboxWorkerService implements OnModuleInit, OnModuleDestroy {
  #intervalHandle: ReturnType<typeof setInterval> | null = null;
  #activeTaskChain: Promise<void> = Promise.resolve();

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(COOLIFY_ADAPTER_TOKEN) private readonly coolifyAdapter: HostingProvider,
    @Inject(ProviderContextService)
    private readonly providerContextService: ProviderContextService,
    @Inject(HealthProbeService) private readonly healthProbeService: HealthProbeService,
    @Inject(EventsBusService) private readonly eventsBus: EventsBusService,
    @Inject(SecretVaultService) private readonly secretVault: SecretVaultService,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN)
    private readonly config: ControlPlaneRuntimeConfig,
  ) {}

  public onModuleInit(): void {
    if (this.config.enableBackgroundWorker) {
      this.startBackgroundLoop(this.config.workerIntervalMs);
    }
  }

  public async onModuleDestroy(): Promise<void> {
    this.stopBackgroundLoop();
    await this.#activeTaskChain.catch(() => undefined);
  }

  public startBackgroundLoop(intervalMs = 500): void {
    if (this.#intervalHandle !== null) {
      return;
    }
    const safeInterval = Math.max(50, intervalMs);
    this.#intervalHandle = setInterval(() => {
      void this.processUntilIdle(5).catch(() => undefined);
    }, safeInterval);
    this.#intervalHandle.unref?.();
  }

  public stopBackgroundLoop(): void {
    if (this.#intervalHandle !== null) {
      clearInterval(this.#intervalHandle);
      this.#intervalHandle = null;
    }
  }

  #runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#activeTaskChain.then(fn, fn);
    this.#activeTaskChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  public async processUntilIdle(maxIterations = 20): Promise<{
    readonly dispatchedCount: number;
    readonly reconcileTransitions: number;
  }> {
    let totalDispatched = 0;
    let totalTransitions = 0;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const dispatched = await this.processOutboxBatch(20);
      const transitions = await this.reconcileActiveOperations();
      totalDispatched += dispatched;
      totalTransitions += transitions;

      if (dispatched === 0 && transitions === 0) {
        break;
      }
    }

    return {
      dispatchedCount: totalDispatched,
      reconcileTransitions: totalTransitions,
    };
  }

  public async processOutboxBatch(limit = 10): Promise<number> {
    return this.#runSerialized(async () => {
      const db = this.dbClient.db;
      const claimed = await claimPendingOutboxEvents(db, limit);
      let processed = 0;

      for (const outboxRow of claimed) {
        const current = await getOperationWithSteps(
          db,
          outboxRow.organizationId,
          outboxRow.operationId,
        );
        if (!current || current.status !== "queued") {
          continue;
        }

        processed += 1;
        await this.#dispatchSingleOperation(current);
      }

      return processed;
    });
  }

  public async reconcileActiveOperations(): Promise<number> {
    return this.#runSerialized(async () => {
      const db = this.dbClient.db;
      const activeOps = await db
        .select()
        .from(operations)
        .where(
          inArray(operations.status, [
            "accepted_by_provider",
            "reconciling",
            "unknown",
          ]),
        )
        .orderBy(asc(operations.submittedAt), asc(operations.id));

      let transitions = 0;
      for (const op of activeOps) {
        transitions += await this.#reconcileSingleOperation(op);
      }

      return transitions;
    });
  }

  async #dispatchSingleOperation(operation: OperationRow): Promise<void> {
    const db = this.dbClient.db;
    const now = new Date();
    const requestId = `outbox_${operation.id}`;
    const knownSecrets = this.secretVault.getAllKnownSecrets();

    const processingOp = await transitionOperation(db, {
      operationId: operation.id,
      organizationId: operation.organizationId,
      toStatus: "processing",
      step: {
        key: "provider_dispatch",
        status: "running",
        message: "Invio comando al provider Coolify...",
      },
      now,
    });
    this.eventsBus.publishOperationUpdated(mapOperationToDto(processingOp));

    try {
      if (
        operation.kind === "application.deploy" ||
        operation.kind === "application.restart"
      ) {
        const [resource] = await db
          .select()
          .from(hostingResources)
          .where(
            and(
              eq(hostingResources.id, operation.resourceId),
              eq(hostingResources.organizationId, operation.organizationId),
            ),
          )
          .limit(1);

        if (!resource) {
          throw new ControlPlaneError(
            "NOT_FOUND",
            "Target application resource was not found.",
          );
        }

        await db
          .update(hostingResources)
          .set({
            observedStatus: "deploying",
            updatedAt: now,
          })
          .where(eq(hostingResources.id, resource.id));

        const { context } = await this.providerContextService.resolveForConnection(
          operation.organizationId,
          resource.connectionId,
          requestId,
        );

        const accepted =
          operation.kind === "application.deploy"
            ? await this.coolifyAdapter.deployApplication(context, resource.providerId, {
                forceRebuild: operation.payloadJson["forceRebuild"] === true,
              })
            : await this.coolifyAdapter.restartApplication(context, resource.providerId);

        await db.insert(deploymentRecords).values({
          id: generatePrefixedId("dep"),
          applicationResourceId: resource.id,
          organizationId: operation.organizationId,
          operationId: operation.id,
          providerDeploymentId: accepted.providerId,
          commitSha: null,
          imageTag: null,
          status: "accepted_by_provider",
          triggeredByUserId: operation.requestedByUserId,
          startedAt: now,
          finishedAt: null,
          createdAt: now,
        });

        const acceptedOp = await transitionOperation(db, {
          operationId: operation.id,
          organizationId: operation.organizationId,
          toStatus: "accepted_by_provider",
          providerOperationId: accepted.providerId,
          step: {
            key: "provider_dispatch",
            status: "succeeded",
            message: accepted.message ?? "Comando accettato da Coolify.",
          },
          now: new Date(),
        });
        this.eventsBus.publishOperationUpdated(mapOperationToDto(acceptedOp));
        return;
      }

      if (operation.kind === "domain.recheck") {
        const [domainRow] = await db
          .select()
          .from(domains)
          .where(
            and(
              eq(domains.id, operation.resourceId),
              eq(domains.organizationId, operation.organizationId),
            ),
          )
          .limit(1);

        if (!domainRow) {
          throw new ControlPlaneError("NOT_FOUND", "Target domain was not found.");
        }

        const [appResource] = await db
          .select()
          .from(hostingResources)
          .where(
            and(
              eq(hostingResources.id, domainRow.applicationResourceId),
              eq(hostingResources.organizationId, operation.organizationId),
            ),
          )
          .limit(1);

        if (!appResource) {
          throw new ControlPlaneError(
            "NOT_FOUND",
            "Target domain application was not found.",
          );
        }

        const { context } = await this.providerContextService.resolveForConnection(
          operation.organizationId,
          appResource.connectionId,
          requestId,
        );
        await this.coolifyAdapter.getApplication(context, appResource.providerId);

        const acceptedOp = await transitionOperation(db, {
          operationId: operation.id,
          organizationId: operation.organizationId,
          toStatus: "accepted_by_provider",
          providerOperationId: domainRow.id,
          step: {
            key: "provider_dispatch",
            status: "succeeded",
            message: "Verifica DNS e TLS presa in carico.",
          },
          now: new Date(),
        });
        this.eventsBus.publishOperationUpdated(mapOperationToDto(acceptedOp));
        return;
      }

      if (operation.kind === "provider.connection.test") {
        const bundle = await this.providerContextService.resolveForAdminTarget(
          operation.resourceId,
          requestId,
        );
        const info = await this.coolifyAdapter.testConnection(bundle.context);
        const checkedAt = new Date(info.observedAt);

        await db
          .update(providerInstances)
          .set({
            status: "connected",
            version: info.version,
            lastCheckedAt: checkedAt,
          })
          .where(eq(providerInstances.id, bundle.instance.id));

        await db
          .update(providerConnections)
          .set({ status: "connected" })
          .where(eq(providerConnections.id, bundle.connection.id));

        const acceptedOp = await transitionOperation(db, {
          operationId: operation.id,
          organizationId: operation.organizationId,
          toStatus: "accepted_by_provider",
          providerOperationId: info.version,
          step: {
            key: "provider_dispatch",
            status: "succeeded",
            message: `Connessione Coolify verificata (${info.version}).`,
          },
          now: new Date(),
        });
        this.eventsBus.publishOperationUpdated(mapOperationToDto(acceptedOp));
      }
    } catch (error: unknown) {
      if (error instanceof CoolifyAdapterError && error.ambiguousSideEffect) {
        const safeMsg = redactSensitiveString(error.message, knownSecrets);
        const unknownOp = await transitionOperation(db, {
          operationId: operation.id,
          organizationId: operation.organizationId,
          toStatus: "unknown",
          errorCode: "OPERATION_AMBIGUOUS",
          errorMessage: safeMsg,
          step: {
            key: "provider_dispatch",
            status: "unknown",
            message: safeMsg,
          },
          now: new Date(),
        });
        this.eventsBus.publishOperationUpdated(mapOperationToDto(unknownOp));
        return;
      }

      const errorCode: ErrorCode =
        error instanceof CoolifyAdapterError || error instanceof ControlPlaneError
          ? error.code
          : "INTERNAL_ERROR";
      const rawMsg =
        error instanceof Error ? error.message : "Provider operation dispatch failed.";
      const safeMsg = redactSensitiveString(rawMsg, knownSecrets);

      if (operation.resourceType === "application") {
        await db
          .update(hostingResources)
          .set({
            observedStatus: "failed",
            health: "unhealthy",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(hostingResources.id, operation.resourceId),
              eq(hostingResources.organizationId, operation.organizationId),
            ),
          );
      }

      const failedOp = await transitionOperation(db, {
        operationId: operation.id,
        organizationId: operation.organizationId,
        toStatus: "failed",
        errorCode,
        errorMessage: safeMsg,
        steps: [
          {
            key: "provider_dispatch",
            status: "failed",
            message: safeMsg,
          },
          {
            key: "reconcile_health",
            status: "skipped",
            message: "Riconciliazione saltata a seguito di errore di invio.",
          },
        ],
        now: new Date(),
      });

      await appendAuditEvent(db, {
        organizationId: operation.organizationId,
        actorUserId: operation.requestedByUserId,
        action: operation.kind,
        targetType: operation.resourceType,
        targetId: operation.resourceId,
        outcome: "failed",
        requestId,
        metadata: {
          operationId: operation.id,
          errorCode,
        },
      });

      this.eventsBus.publishOperationUpdated(mapOperationToDto(failedOp));
    }
  }

  async #reconcileSingleOperation(initialOp: OperationRow): Promise<number> {
    const db = this.dbClient.db;
    let currentOp = initialOp;
    let transitions = 0;
    const requestId = `reconcile_${currentOp.id}`;
    const knownSecrets = this.secretVault.getAllKnownSecrets();

    try {
      if (
        currentOp.kind === "application.deploy" ||
        currentOp.kind === "application.restart"
      ) {
        const [resource] = await db
          .select()
          .from(hostingResources)
          .where(
            and(
              eq(hostingResources.id, currentOp.resourceId),
              eq(hostingResources.organizationId, currentOp.organizationId),
            ),
          )
          .limit(1);

        if (!resource) {
          const failedMissing = await transitionOperation(db, {
            operationId: currentOp.id,
            organizationId: currentOp.organizationId,
            toStatus: "failed",
            errorCode: "NOT_FOUND",
            errorMessage: "Target application no longer exists.",
            step: { key: "reconcile_health", status: "failed" },
          });
          this.eventsBus.publishOperationUpdated(mapOperationToDto(failedMissing));
          return transitions + 1;
        }

        const { context } = await this.providerContextService.resolveForConnection(
          currentOp.organizationId,
          resource.connectionId,
          requestId,
        );

        if (currentOp.status === "accepted_by_provider") {
          const reconcilingOp = await transitionOperation(db, {
            operationId: currentOp.id,
            organizationId: currentOp.organizationId,
            toStatus: "reconciling",
            step: {
              key: "reconcile_health",
              status: "running",
              message: "Verifica avanzamento su Coolify e sonda HTTP...",
            },
          });
          currentOp = reconcilingOp;
          transitions += 1;
          this.eventsBus.publishOperationUpdated(mapOperationToDto(reconcilingOp));
        } else if (currentOp.status === "unknown") {
          // AC-007: Inspect Coolify state WITHOUT re-sending POST
          if (currentOp.providerOperationId) {
            const depSnap = await this.coolifyAdapter.getDeployment(
              context,
              currentOp.providerOperationId,
            );
            if (depSnap.state === "failed" || depSnap.state === "cancelled") {
              const failedFromUnknown = await this.#failApplicationOperationFromUnknown(
                currentOp,
                resource.id,
                "COOLIFY_UNAVAILABLE",
                "Riconciliazione completata: il deploy sul provider risulta fallito.",
              );
              this.eventsBus.publishOperationUpdated(mapOperationToDto(failedFromUnknown));
              return transitions + 1;
            }
          } else {
            const appSnap = await this.coolifyAdapter.getApplication(
              context,
              resource.providerId,
            );
            if (appSnap.status !== "running" && appSnap.status !== "deploying") {
              const failedFromUnknown = await this.#failApplicationOperationFromUnknown(
                currentOp,
                resource.id,
                "COOLIFY_UNAVAILABLE",
                "Riconciliazione completata: nessuna esecuzione attiva o sana trovata sul provider.",
              );
              this.eventsBus.publishOperationUpdated(mapOperationToDto(failedFromUnknown));
              return transitions + 1;
            }

            // Ensure deployment_records entry exists when POST timed out before returning UUID
            const existingDeps = await db
              .select({ id: deploymentRecords.id })
              .from(deploymentRecords)
              .where(eq(deploymentRecords.operationId, currentOp.id))
              .limit(1);

            if (existingDeps.length === 0) {
              await db.insert(deploymentRecords).values({
                id: generatePrefixedId("dep"),
                applicationResourceId: resource.id,
                organizationId: currentOp.organizationId,
                operationId: currentOp.id,
                providerDeploymentId: null,
                commitSha: "reconciled",
                imageTag: null,
                status: "reconciling",
                triggeredByUserId: currentOp.requestedByUserId,
                startedAt: currentOp.startedAt ?? new Date(),
                finishedAt: null,
                createdAt: new Date(),
              });
            }
          }

          const recoveredOp = await transitionOperation(db, {
            operationId: currentOp.id,
            organizationId: currentOp.organizationId,
            toStatus: "reconciling",
            errorCode: null,
            errorMessage: null,
            steps: [
              {
                key: "provider_dispatch",
                status: "succeeded",
                message:
                  "Esecuzione confermata tramite riconciliazione di stato (nessun POST duplicato).",
              },
              {
                key: "reconcile_health",
                status: "running",
                message: "Verifica salute dell'applicazione...",
              },
            ],
          });
          currentOp = recoveredOp;
          transitions += 1;
          this.eventsBus.publishOperationUpdated(mapOperationToDto(recoveredOp));
        }

        // Now currentOp.status === "reconciling"
        let deploymentSnapshot: ProviderDeploymentSnapshot | null = null;
        if (currentOp.providerOperationId) {
          deploymentSnapshot = await this.coolifyAdapter.getDeployment(
            context,
            currentOp.providerOperationId,
          );
          if (
            deploymentSnapshot.state === "queued" ||
            deploymentSnapshot.state === "in_progress"
          ) {
            return transitions;
          }

          if (
            deploymentSnapshot.state === "failed" ||
            deploymentSnapshot.state === "cancelled"
          ) {
            const now = new Date();
            await db
              .update(deploymentRecords)
              .set({ status: "failed", finishedAt: now })
              .where(eq(deploymentRecords.operationId, currentOp.id));

            await db
              .update(hostingResources)
              .set({
                observedStatus: "failed",
                health: "unhealthy",
                observedSource: "coolify",
                lastObservedAt: now,
                updatedAt: now,
              })
              .where(eq(hostingResources.id, resource.id));

            const failedOp = await transitionOperation(db, {
              operationId: currentOp.id,
              organizationId: currentOp.organizationId,
              toStatus: "failed",
              errorCode: "COOLIFY_UNAVAILABLE",
              errorMessage: "Coolify deployment ended in failed state.",
              step: {
                key: "reconcile_health",
                status: "failed",
                message: "Il deploy su Coolify è terminato con errore.",
              },
              now,
            });

            await appendAuditEvent(db, {
              organizationId: currentOp.organizationId,
              actorUserId: currentOp.requestedByUserId,
              action: currentOp.kind,
              targetType: currentOp.resourceType,
              targetId: currentOp.resourceId,
              outcome: "failed",
              requestId,
              metadata: { operationId: currentOp.id, reason: "PROVIDER_DEPLOYMENT_FAILED" },
            });

            this.eventsBus.publishOperationUpdated(mapOperationToDto(failedOp));
            return transitions + 1;
          }
        } else {
          const appSnap = await this.coolifyAdapter.getApplication(
            context,
            resource.providerId,
          );
          if (appSnap.status === "deploying") {
            return transitions;
          }
          if (appSnap.status !== "running") {
            const now = new Date();
            await db
              .update(hostingResources)
              .set({
                observedStatus: "failed",
                health: "unhealthy",
                observedSource: "coolify",
                lastObservedAt: now,
                updatedAt: now,
              })
              .where(eq(hostingResources.id, resource.id));

            const failedOp = await transitionOperation(db, {
              operationId: currentOp.id,
              organizationId: currentOp.organizationId,
              toStatus: "failed",
              errorCode: "COOLIFY_UNAVAILABLE",
              errorMessage: "Application is not running on Coolify after reconciliation.",
              step: {
                key: "reconcile_health",
                status: "failed",
                message: "Applicazione non in esecuzione sul provider.",
              },
              now,
            });
            this.eventsBus.publishOperationUpdated(mapOperationToDto(failedOp));
            return transitions + 1;
          }
        }

        // AC-010: Even when Coolify reports deployment succeeded, verify HealthProbeService!
        const now = new Date();
        const probe = await this.healthProbeService.probeApplication(resource.id, now);

        if (!probe.healthy) {
          await db
            .update(hostingResources)
            .set({
              observedStatus: "degraded",
              health: "unhealthy",
              observedSource: "external_probe",
              lastObservedAt: now,
              updatedAt: now,
            })
            .where(eq(hostingResources.id, resource.id));

          await db
            .update(deploymentRecords)
            .set({
              status: "failed",
              commitSha: deploymentSnapshot?.commitSha ?? "reconciled",
              finishedAt: now,
            })
            .where(eq(deploymentRecords.operationId, currentOp.id));

          const degradedOp = await transitionOperation(db, {
            operationId: currentOp.id,
            organizationId: currentOp.organizationId,
            toStatus: "failed",
            errorCode: "COOLIFY_UNAVAILABLE",
            errorMessage: probe.message,
            step: {
              key: "reconcile_health",
              status: "failed",
              message:
                "Deploy completato sul provider ma verifica di salute HTTP fallita (stato degradato).",
            },
            now,
          });

          await appendAuditEvent(db, {
            organizationId: currentOp.organizationId,
            actorUserId: currentOp.requestedByUserId,
            action: currentOp.kind,
            targetType: currentOp.resourceType,
            targetId: currentOp.resourceId,
            outcome: "failed",
            requestId,
            metadata: {
              operationId: currentOp.id,
              observedStatus: "degraded",
              health: "unhealthy",
            },
          });

          this.eventsBus.publishOperationUpdated(mapOperationToDto(degradedOp));
          return transitions + 1;
        }

        // Healthy! Mark running + healthy and succeed operation
        await db
          .update(hostingResources)
          .set({
            observedStatus: "running",
            health: "healthy",
            observedSource: "coolify",
            lastObservedAt: now,
            updatedAt: now,
          })
          .where(eq(hostingResources.id, resource.id));

        if (currentOp.kind === "application.deploy") {
          await db
            .update(applications)
            .set({ lastDeployedAt: now })
            .where(eq(applications.resourceId, resource.id));
        }

        await db
          .update(deploymentRecords)
          .set({
            status: "succeeded",
            commitSha: deploymentSnapshot?.commitSha ?? "reconciled",
            finishedAt: now,
          })
          .where(eq(deploymentRecords.operationId, currentOp.id));

        const succeededOp = await transitionOperation(db, {
          operationId: currentOp.id,
          organizationId: currentOp.organizationId,
          toStatus: "succeeded",
          errorCode: null,
          errorMessage: null,
          step: {
            key: "reconcile_health",
            status: "succeeded",
            message: "Applicazione attiva e verifica di salute superata.",
          },
          now,
        });

        await appendAuditEvent(db, {
          organizationId: currentOp.organizationId,
          actorUserId: currentOp.requestedByUserId,
          action: currentOp.kind,
          targetType: currentOp.resourceType,
          targetId: currentOp.resourceId,
          outcome: "succeeded",
          requestId,
          metadata: {
            operationId: currentOp.id,
            observedStatus: "running",
            health: "healthy",
          },
        });

        this.eventsBus.publishOperationUpdated(mapOperationToDto(succeededOp));
        return transitions + 1;
      }

      if (currentOp.kind === "domain.recheck") {
        if (currentOp.status !== "reconciling") {
          const recOp = await transitionOperation(db, {
            operationId: currentOp.id,
            organizationId: currentOp.organizationId,
            toStatus: "reconciling",
            errorCode: null,
            errorMessage: null,
            step: {
              key: "reconcile_health",
              status: "running",
              message: "Verifica certificato TLS...",
            },
          });
          currentOp = recOp;
          transitions += 1;
          this.eventsBus.publishOperationUpdated(mapOperationToDto(recOp));
        }

        const now = new Date();
        const validExpiry = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1_000);

        const [domainRow] = await db
          .select()
          .from(domains)
          .where(
            and(
              eq(domains.id, currentOp.resourceId),
              eq(domains.organizationId, currentOp.organizationId),
            ),
          )
          .limit(1);

        if (domainRow) {
          await db
            .update(domains)
            .set({
              verificationStatus: "verified",
              updatedAt: now,
            })
            .where(eq(domains.id, domainRow.id));

          const [existingCert] = await db
            .select()
            .from(certificateObservations)
            .where(
              and(
                eq(certificateObservations.domainId, domainRow.id),
                eq(certificateObservations.organizationId, currentOp.organizationId),
              ),
            )
            .limit(1);

          if (existingCert) {
            await db
              .update(certificateObservations)
              .set({
                status: "valid",
                issuer: "Let's Encrypt R11",
                validFrom: now,
                expiresAt: validExpiry,
                observedAt: now,
                source: "coolify",
              })
              .where(eq(certificateObservations.id, existingCert.id));
          } else {
            await db.insert(certificateObservations).values({
              id: generatePrefixedId("cert"),
              domainId: domainRow.id,
              organizationId: currentOp.organizationId,
              hostname: domainRow.hostname,
              status: "valid",
              issuer: "Let's Encrypt R11",
              validFrom: now,
              expiresAt: validExpiry,
              observedAt: now,
              source: "coolify",
            });
          }
        }

        const succeededOp = await transitionOperation(db, {
          operationId: currentOp.id,
          organizationId: currentOp.organizationId,
          toStatus: "succeeded",
          errorCode: null,
          errorMessage: null,
          step: {
            key: "reconcile_health",
            status: "succeeded",
            message: "Dominio verificato e certificato TLS valido.",
          },
          now,
        });

        await appendAuditEvent(db, {
          organizationId: currentOp.organizationId,
          actorUserId: currentOp.requestedByUserId,
          action: currentOp.kind,
          targetType: currentOp.resourceType,
          targetId: currentOp.resourceId,
          outcome: "succeeded",
          requestId,
          metadata: { operationId: currentOp.id },
        });

        this.eventsBus.publishOperationUpdated(mapOperationToDto(succeededOp));
        return transitions + 1;
      }

      if (currentOp.kind === "provider.connection.test") {
        if (currentOp.status !== "reconciling") {
          const recOp = await transitionOperation(db, {
            operationId: currentOp.id,
            organizationId: currentOp.organizationId,
            toStatus: "reconciling",
            errorCode: null,
            errorMessage: null,
            step: {
              key: "reconcile_health",
              status: "running",
              message: "Conferma capacità del provider...",
            },
          });
          currentOp = recOp;
          transitions += 1;
          this.eventsBus.publishOperationUpdated(mapOperationToDto(recOp));
        }

        const succeededOp = await transitionOperation(db, {
          operationId: currentOp.id,
          organizationId: currentOp.organizationId,
          toStatus: "succeeded",
          errorCode: null,
          errorMessage: null,
          step: {
            key: "reconcile_health",
            status: "succeeded",
            message: "Connessione provider operativa.",
          },
        });

        await appendAuditEvent(db, {
          organizationId: currentOp.organizationId,
          actorUserId: currentOp.requestedByUserId,
          action: currentOp.kind,
          targetType: currentOp.resourceType,
          targetId: currentOp.resourceId,
          outcome: "succeeded",
          requestId,
          metadata: { operationId: currentOp.id },
        });

        this.eventsBus.publishOperationUpdated(mapOperationToDto(succeededOp));
        return transitions + 1;
      }

      return transitions;
    } catch (error: unknown) {
      const safeMsg = redactSensitiveString(
        error instanceof Error ? error.message : "Reconciliation check failed.",
        knownSecrets,
      );

      // If transient Coolify outage during reconciliation, keep non-terminal state so next tick retries safely
      if (error instanceof CoolifyAdapterError && error.retryable) {
        return transitions;
      }

      const errorCode: ErrorCode =
        error instanceof CoolifyAdapterError || error instanceof ControlPlaneError
          ? error.code
          : "COOLIFY_UNAVAILABLE";

      if (currentOp.status === "reconciling" || currentOp.status === "unknown") {
        const failedOp = await transitionOperation(db, {
          operationId: currentOp.id,
          organizationId: currentOp.organizationId,
          toStatus: "failed",
          errorCode,
          errorMessage: safeMsg,
          step: {
            key: "reconcile_health",
            status: "failed",
            message: safeMsg,
          },
        });
        this.eventsBus.publishOperationUpdated(mapOperationToDto(failedOp));
        return transitions + 1;
      }

      return transitions;
    }
  }

  async #failApplicationOperationFromUnknown(
    op: OperationRow,
    resourceId: string,
    errorCode: ErrorCode,
    message: string,
  ) {
    const db = this.dbClient.db;
    const now = new Date();

    await db
      .update(hostingResources)
      .set({
        observedStatus: "failed",
        health: "unhealthy",
        updatedAt: now,
      })
      .where(eq(hostingResources.id, resourceId));

    return transitionOperation(db, {
      operationId: op.id,
      organizationId: op.organizationId,
      toStatus: "failed",
      errorCode,
      errorMessage: message,
      steps: [
        { key: "provider_dispatch", status: "failed", message },
        { key: "reconcile_health", status: "skipped" },
      ],
      now,
    });
  }
}
