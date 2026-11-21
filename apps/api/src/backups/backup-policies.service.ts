import { Inject, Injectable } from "@nestjs/common";
import {
  DEFAULT_BACKUP_RETENTION_DAYS,
  SetSiteBackupPolicyInputSchema,
  UpdateDefaultSiteBackupPolicyInputSchema,
  UpdatePanelBackupPolicyInputSchema,
  isBackupAvailable,
  type BackupPolicyDto,
  type SiteBackupPolicyDto,
} from "@hosting-panel/contracts";
import {
  appendAuditEvent,
  getBackupTargetRow,
  getPolicy,
  getSitePolicyTargetIds,
  listBackupTargets,
  resolveEffectiveTargets,
  setPolicyTargets,
  setSitePolicy,
  updatePolicySettings,
  type BackupTargetRow,
  type DatabaseClient,
  type DatabaseExecutor,
  type EffectiveTarget,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import { ControlPlaneError, extractClientIp, extractRawHeader } from "../common/control-plane.error.js";
import { DATABASE_CLIENT_TOKEN, type ControlPlaneRuntimeConfig } from "../tokens.js";
import type { BackupSiteRef, SiteBackupActor } from "./site-backups.service.js";

/** Destinations one backup is written to. M3 ships one; M4 raises it to 2 (the schema and tables already allow 2). */
export const MAX_COPIES = 1;

export type AdminBackupPolicyScope = "default_site" | "panel";

/** A target a new backup may use: enabled, not archived, and (legacy) with the settings it reads still present. */
const isUsable = (t: BackupTargetRow): boolean =>
  t.enabled && t.archivedAt === null && (!t.legacySettings || Object.keys(t.config).length > 0);

/** A target the administrator offers to customers. */
const selectable = (t: BackupTargetRow): boolean => isUsable(t) && t.customerSelectable;

const validation = (message: string, field: string): ControlPlaneError =>
  new ControlPlaneError("VALIDATION_ERROR", message, { details: [{ field, message }] });

function assertWithinCopyLimit(targetIds: readonly string[]): void {
  if (targetIds.length > MAX_COPIES) {
    throw validation("too_many_targets", "targetIds");
  }
}

function toPolicyDto(policy: Awaited<ReturnType<typeof getPolicy>>): BackupPolicyDto {
  return {
    scope: policy.scope,
    siteId: null,
    scheduleHourUtc: policy.scope === "panel" ? null : policy.scheduleHourUtc,
    retentionDays: policy.retentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS,
    targets: policy.targets.map((t) => ({
      targetId: t.targetId,
      kind: t.kind,
      priority: t.priority === 2 ? 2 : 1,
      required: t.required,
    })),
    updatedAt: policy.updatedAt.toISOString(),
  };
}

/** Default, panel and per-site backup policies: which destinations, how often, how long. */
@Injectable()
export class BackupPoliciesService {
  public constructor(@Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient) {}

  /** The targets a new backup of the site goes to (its own policy, else the default), in priority order. */
  public static effectiveTargets(db: DatabaseExecutor, siteId: string): Promise<EffectiveTarget[]> {
    return resolveEffectiveTargets(db, siteId);
  }

  /** The one "backups are configured for this site" rule: the runtime offers backups and at least one target is usable. */
  public static async isSiteBackupConfigured(
    db: DatabaseExecutor,
    runtimeBackend: ControlPlaneRuntimeConfig["runtimeBackend"],
    siteId: string,
  ): Promise<boolean> {
    return isBackupAvailable(runtimeBackend) && (await resolveEffectiveTargets(db, siteId)).length > 0;
  }

  public async get(scope: AdminBackupPolicyScope): Promise<BackupPolicyDto> {
    return toPolicyDto(await getPolicy(this.dbClient.db, scope));
  }

  /** Changes hour, retention and/or destinations; the hour exists on the default policy only (the panel runs after the sites). */
  public async update(scope: AdminBackupPolicyScope, rawInput: unknown, actorId: string): Promise<BackupPolicyDto> {
    const input = (
      scope === "panel" ? UpdatePanelBackupPolicyInputSchema : UpdateDefaultSiteBackupPolicyInputSchema
    ).parse(rawInput ?? {}) as { scheduleHourUtc?: number; retentionDays?: number; targetIds?: string[] };
    if (input.targetIds !== undefined) {
      assertWithinCopyLimit(input.targetIds);
    }

    await this.dbClient.db.transaction(async (tx) => {
      for (const id of input.targetIds ?? []) {
        const target = await getBackupTargetRow(tx, id);
        if (!target || !isUsable(target)) {
          throw validation("target_unavailable", "targetIds");
        }
      }
      const policy = await getPolicy(tx, scope);
      if (input.scheduleHourUtc !== undefined || input.retentionDays !== undefined) {
        await updatePolicySettings(
          tx,
          scope,
          {
            ...(input.scheduleHourUtc === undefined ? {} : { scheduleHourUtc: input.scheduleHourUtc }),
            ...(input.retentionDays === undefined ? {} : { retentionDays: input.retentionDays }),
          },
          actorId,
        );
      }
      if (input.targetIds !== undefined) {
        await setPolicyTargets(tx, policy.id, input.targetIds);
      }
      await appendAuditEvent(tx as unknown as HostingPanelDatabase, {
        actorId,
        actorType: "user",
        action: "admin.backup_policy.update",
        targetType: "backup_policy",
        targetId: null,
        details: {
          scope,
          scheduleHourUtc: input.scheduleHourUtc,
          retentionDays: input.retentionDays,
          targetIds: input.targetIds,
        },
      });
    });
    return this.get(scope);
  }

  /** What the owner sees: the effective destinations and the neutral choices (id + kind only). */
  public async getSitePolicy(site: Pick<BackupSiteRef, "id">): Promise<SiteBackupPolicyDto> {
    const db = this.dbClient.db;
    const own = await getSitePolicyTargetIds(db, site.id);
    const effective = own === null ? await resolveEffectiveTargets(db, site.id) : null;
    return {
      targetIds: own ?? effective!.map((t) => t.targetId),
      inherited: own === null,
      choices: (await listBackupTargets(db)).filter(selectable).map((t) => ({ id: t.id, kind: t.kind })),
    };
  }

  /** `targetIds: null` inherits the default; ids must be targets the administrator offers, else 404 (no oracle). */
  public async updateSitePolicy(
    site: Pick<BackupSiteRef, "id" | "organizationId">,
    rawInput: unknown,
    actor: SiteBackupActor,
  ): Promise<SiteBackupPolicyDto> {
    const input = SetSiteBackupPolicyInputSchema.parse(rawInput ?? {});
    if (input.targetIds !== null) {
      assertWithinCopyLimit(input.targetIds);
    }

    await this.dbClient.db.transaction(async (tx) => {
      const kinds: string[] = [];
      for (const id of input.targetIds ?? []) {
        const target = await getBackupTargetRow(tx, id);
        if (!target || !selectable(target)) {
          throw new ControlPlaneError("NOT_FOUND", "Backup destination not found");
        }
        kinds.push(target.kind);
      }
      await setSitePolicy(tx, site.id, input.targetIds, actor.auth.user.id);
      await appendAuditEvent(tx as unknown as HostingPanelDatabase, {
        actorId: actor.auth.user.id,
        actorType: "user",
        organizationId: site.organizationId,
        action: `${actor.actionPrefix ?? "site.backups"}.policy.update`,
        targetType: "site",
        targetId: site.id,
        ipAddress: extractClientIp(actor.req),
        userAgent: extractRawHeader(
          actor.req.headers as Record<string, string | string[] | undefined>,
          "user-agent",
        ),
        details: {
          outcome: "succeeded",
          inherited: input.targetIds === null,
          targets: (input.targetIds ?? []).map((targetId, i) => ({ targetId, targetKind: kinds[i] })),
        },
      });
    });
    return this.getSitePolicy(site);
  }
}
