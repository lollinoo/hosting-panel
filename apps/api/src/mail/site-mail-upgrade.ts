import {
  and,
  appendStackRevisionTransactional,
  enqueueOperationTransactional,
  eq,
  isNotNull,
  serviceInstances,
  sites,
  sql,
  stackRevisions,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import { SERVICE_STEPS } from "../runtime/site-provisioner.js";

/**
 * Sites deployed before 0.5.0 get one new revision with `siteMail: true` and a redeploy. Only `ready`
 * sites move; a locked one is retried on the next tick. Returns the number of deploys enqueued.
 */
export async function upgradeSitesToSiteMail(db: HostingPanelDatabase): Promise<number> {
  const rows = await db
    .select({ siteId: sites.id, organizationId: sites.organizationId, serviceId: serviceInstances.id, rev: stackRevisions })
    .from(sites)
    .innerJoin(serviceInstances, eq(serviceInstances.siteId, sites.id))
    .innerJoin(stackRevisions, eq(stackRevisions.id, serviceInstances.currentRevisionId))
    .where(
      and(
        isNotNull(sites.phpVersion),
        eq(sites.status, "ready"),
        sql`${stackRevisions.declarativeConfig}->>'siteMail' is distinct from 'true'`,
      ),
    );
  let enqueued = 0;
  for (const { siteId, organizationId, serviceId, rev } of rows) {
    try {
      await db.transaction(async (tx) => {
        const t = tx as unknown as HostingPanelDatabase;
        // Enqueue first: a held site lock aborts the transaction before any revision is written.
        await enqueueOperationTransactional(t, {
          organizationId,
          kind: "service.deploy",
          resourceType: "service",
          resourceId: serviceId,
          lockKey: `site:${siteId}`,
          steps: SERVICE_STEPS,
        });
        await appendStackRevisionTransactional(t, {
          serviceInstanceId: serviceId,
          organizationId,
          declarativeConfig: { ...(rev.declarativeConfig as Record<string, unknown>), siteMail: true },
          secretRefs: rev.secretRefs as Record<string, string>,
          ...(rev.resourceLimits
            ? { resourceLimits: rev.resourceLimits as { cpuMilli: number; memoryBytes: string } }
            : {}),
        });
      });
      enqueued += 1;
    } catch (err) {
      // A locked or failing site is retried on the next tick and never blocks the others.
      const code = (err as { code?: unknown } | null)?.code;
      if (code !== "RESOURCE_LOCKED") console.warn(JSON.stringify({ event: "site_mail_upgrade_failed", siteId, code: code ?? null }));
    }
  }
  return enqueued;
}
