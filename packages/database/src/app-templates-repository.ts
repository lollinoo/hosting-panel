// Application template catalog (ADR-0035): templates, immutable versions, the published-version lookup and the boot seed.
// Lock order of every stack writer: organizations row FOR NO KEY UPDATE → app_templates row FOR SHARE → app_stacks row
// FOR UPDATE → resource_quotas row FOR UPDATE → tls_publish_state → hostname advisory lock (0025 triggers).

import { randomUUID } from "node:crypto";
import {
  APP_ID_PREFIXES,
  findForbiddenPublicDtoKeys,
  findPemValues,
  findPlaintextSecretKeys,
  type ErrorCode,
} from "@hosting-panel/contracts";
import { and, asc, count, desc, eq, isNull, sql } from "drizzle-orm";
import type { DatabaseExecutor, HostingPanelDatabase } from "./client.js";
import { appStacks, appTemplates, appTemplateVersions } from "./schema.js";

export type AppTemplateRow = typeof appTemplates.$inferSelect;
export type AppTemplateVersionRow = typeof appTemplateVersions.$inferSelect;
export type AppTemplateRepositoryErrorCode = "NOT_FOUND" | "ARCHIVED" | "BUILT_IN" | "SLUG_TAKEN" | "INVALID_DEFAULT";

export class AppTemplateRepositoryError extends Error {
  constructor(
    readonly code: AppTemplateRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppTemplateRepositoryError";
  }
}

export interface NewAppTemplateVersion {
  readonly source: string;
  readonly specVersion: number;
  readonly compiledSchema: Readonly<Record<string, unknown>>;
  readonly specHash: string;
}
export interface AppTemplateWithVersion {
  readonly template: AppTemplateRow;
  readonly version: AppTemplateVersionRow;
}

const SLUG_CONSTRAINT = "uq_app_templates_slug";
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
const lowerName = sql`lower(${appTemplates.name})`;

/** The slug unique constraint refused a write; the transaction is already rolled back (or its savepoint). */
function mapSlugTaken(err: unknown): unknown {
  for (let current: unknown = err, depth = 0; current && typeof current === "object" && depth < 4; depth += 1) {
    const e = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (e.code === "23505" && (e.constraint === SLUG_CONSTRAINT || (typeof e.message === "string" && e.message.includes(SLUG_CONSTRAINT)))) {
      return new AppTemplateRepositoryError("SLUG_TAKEN", "An application template with this slug already exists.");
    }
    current = e.cause;
  }
  return err;
}

function assertNoSecretMaterial(value: unknown, field: string): void {
  if (findPlaintextSecretKeys(value).length > 0 || findForbiddenPublicDtoKeys(value).length > 0 || findPemValues(value).length > 0) {
    throw Object.assign(new Error(`${field} carries secret material`), { code: "VALIDATION_ERROR" satisfies ErrorCode });
  }
}

function versionValues(id: string, templateId: string, versionNumber: number, version: NewAppTemplateVersion, createdBy: string | null) {
  assertNoSecretMaterial(version.compiledSchema, "compiledSchema");
  return {
    id,
    templateId,
    versionNumber,
    source: version.source,
    specVersion: version.specVersion,
    compiledSchema: version.compiledSchema,
    specHash: version.specHash,
    createdBy,
  };
}

/** Own tx: template (disabled, default = version 1) + version 1. SLUG_TAKEN on uq_app_templates_slug. */
export async function createAppTemplate(
  db: HostingPanelDatabase,
  input: {
    readonly slug: string;
    readonly name: string;
    readonly description: string | null;
    readonly category: string;
    readonly firstVersion: NewAppTemplateVersion;
    readonly createdBy: string | null;
  },
): Promise<AppTemplateWithVersion> {
  const templateId = newId(APP_ID_PREFIXES.template);
  const values = versionValues(newId(APP_ID_PREFIXES.templateVersion), templateId, 1, input.firstVersion, input.createdBy);
  try {
    return await db.transaction(async (tx) => {
      await tx.insert(appTemplates).values({ id: templateId, slug: input.slug, name: input.name, description: input.description, category: input.category });
      const [version] = await tx.insert(appTemplateVersions).values(values).returning();
      const [template] = await tx
        .update(appTemplates)
        .set({ defaultVersionId: version!.id })
        .where(eq(appTemplates.id, templateId))
        .returning();
      return { template: template!, version: version! };
    });
  } catch (err) {
    throw mapSlugTaken(err);
  }
}

async function lockTemplate(tx: DatabaseExecutor, templateId: string): Promise<AppTemplateRow> {
  const [row] = await tx.select().from(appTemplates).where(eq(appTemplates.id, templateId)).for("update");
  if (!row) throw new AppTemplateRepositoryError("NOT_FOUND", "Application template not found.");
  return row;
}

function assertNotArchived(template: AppTemplateRow): void {
  if (template.archivedAt) throw new AppTemplateRepositoryError("ARCHIVED", "The application template is archived.");
}

/** Own tx: template FOR UPDATE, then max+1; the latest version's source and hash again → that version, created:false. */
export async function addAppTemplateVersion(
  db: HostingPanelDatabase,
  input: { readonly templateId: string; readonly version: NewAppTemplateVersion; readonly createdBy: string | null },
): Promise<AppTemplateWithVersion & { readonly created: boolean }> {
  return db.transaction(async (tx) => {
    const template = await lockTemplate(tx, input.templateId);
    assertNotArchived(template);
    const [latest] = await tx
      .select()
      .from(appTemplateVersions)
      .where(eq(appTemplateVersions.templateId, template.id))
      .orderBy(desc(appTemplateVersions.versionNumber))
      .limit(1);
    if (latest && latest.source === input.version.source && latest.specHash === input.version.specHash) {
      return { template, version: latest, created: false };
    }
    const values = versionValues(newId(APP_ID_PREFIXES.templateVersion), template.id, (latest?.versionNumber ?? 0) + 1, input.version, input.createdBy);
    const [version] = await tx.insert(appTemplateVersions).values(values).returning();
    return { template, version: version!, created: true };
  });
}

/** Own tx: template FOR UPDATE; ARCHIVED; INVALID_DEFAULT when defaultVersionId is not a version of it. */
export async function updateAppTemplate(
  db: HostingPanelDatabase,
  input: {
    readonly templateId: string;
    readonly name?: string;
    readonly description?: string | null;
    readonly category?: string;
    readonly enabled?: boolean;
    readonly defaultVersionId?: string;
  },
): Promise<{ readonly template: AppTemplateRow; readonly changes: readonly { field: string; from: unknown; to: unknown }[] }> {
  return db.transaction(async (tx) => {
    const template = await lockTemplate(tx, input.templateId);
    assertNotArchived(template);
    if (input.defaultVersionId !== undefined && !(await getAppTemplateVersion(tx, { templateId: template.id, versionId: input.defaultVersionId }))) {
      throw new AppTemplateRepositoryError("INVALID_DEFAULT", "The default must be a version of this template.");
    }
    if (input.enabled && !(input.defaultVersionId ?? template.defaultVersionId)) {
      throw new AppTemplateRepositoryError("INVALID_DEFAULT", "A template without a default version cannot be enabled.");
    }
    const fields = ["name", "description", "category", "enabled", "defaultVersionId"] as const;
    const changes = fields
      .filter((field) => input[field] !== undefined && input[field] !== template[field])
      .map((field) => ({ field, from: template[field], to: input[field] }));
    if (changes.length === 0) return { template, changes };
    const [updated] = await tx
      .update(appTemplates)
      .set({ ...Object.fromEntries(changes.map((c) => [c.field, c.to])), updatedAt: new Date() })
      .where(eq(appTemplates.id, template.id))
      .returning();
    return { template: updated!, changes };
  });
}

/** Own tx: FOR UPDATE; BUILT_IN refused; sets archived_at, enabled=false; already archived → changed:false. */
export async function archiveAppTemplate(db: HostingPanelDatabase, templateId: string): Promise<{ template: AppTemplateRow; changed: boolean }> {
  return db.transaction(async (tx) => {
    const template = await lockTemplate(tx, templateId);
    if (template.builtIn) throw new AppTemplateRepositoryError("BUILT_IN", "A built-in application template cannot be archived.");
    if (template.archivedAt) return { template, changed: false };
    const [archived] = await tx
      .update(appTemplates)
      .set({ archivedAt: new Date(), enabled: false, updatedAt: new Date() })
      .where(eq(appTemplates.id, templateId))
      .returning();
    return { template: archived!, changed: true };
  });
}

export async function getAppTemplate(db: DatabaseExecutor, templateId: string): Promise<AppTemplateRow | null> {
  const [row] = await db.select().from(appTemplates).where(eq(appTemplates.id, templateId));
  return row ?? null;
}

export function listAppTemplates(db: DatabaseExecutor): Promise<AppTemplateRow[]> {
  return db.select().from(appTemplates).orderBy(lowerName, asc(appTemplates.id));
}

export function listAppTemplateVersions(db: DatabaseExecutor, templateId: string): Promise<AppTemplateVersionRow[]> {
  return db
    .select()
    .from(appTemplateVersions)
    .where(eq(appTemplateVersions.templateId, templateId))
    .orderBy(desc(appTemplateVersions.versionNumber));
}

export async function getAppTemplateVersion(
  db: DatabaseExecutor,
  input: { templateId: string; versionId: string },
): Promise<AppTemplateVersionRow | null> {
  const [row] = await db
    .select()
    .from(appTemplateVersions)
    .where(and(eq(appTemplateVersions.id, input.versionId), eq(appTemplateVersions.templateId, input.templateId)));
  return row ?? null;
}

function published(db: DatabaseExecutor, templateVersionId?: string) {
  return db
    .select({ template: appTemplates, version: appTemplateVersions })
    .from(appTemplates)
    .innerJoin(
      appTemplateVersions,
      and(eq(appTemplateVersions.id, appTemplates.defaultVersionId), eq(appTemplateVersions.templateId, appTemplates.id)),
    )
    .where(
      and(
        eq(appTemplates.enabled, true),
        isNull(appTemplates.archivedAt),
        templateVersionId === undefined ? undefined : eq(appTemplateVersions.id, templateVersionId),
      ),
    );
}

/** Customer catalog: enabled, not archived, joined with the default version. */
export function listPublishedAppTemplates(db: DatabaseExecutor): Promise<AppTemplateWithVersion[]> {
  return published(db).orderBy(lowerName, asc(appTemplates.id));
}

/**
 * The version is installable/upgradable-to only when it is the default of an enabled, non-archived template.
 * `lock: true` (inside a stack writer's tx) takes FOR SHARE on the template row so an archive cannot interleave.
 */
export async function getPublishedAppTemplateVersion(
  db: DatabaseExecutor,
  input: { templateVersionId: string; lock: boolean },
): Promise<AppTemplateWithVersion | null> {
  const query = published(db, input.templateVersionId);
  const [row] = await (input.lock ? query.for("share", { of: appTemplates }) : query);
  return row ?? null;
}

/** Usage: non-deleted stacks per version of the template (versions without stacks omitted). */
export async function countAppStacksByTemplateVersion(
  db: DatabaseExecutor,
  templateId: string,
): Promise<{ templateVersionId: string; stacks: number }[]> {
  return db
    .select({ templateVersionId: appStacks.templateVersionId, stacks: count() })
    .from(appStacks)
    .where(and(eq(appStacks.templateId, templateId), isNull(appStacks.deletedAt)))
    .groupBy(appStacks.templateVersionId);
}

/** One version of a built-in template as the seed carries it; `description` is what the catalog showed with it. */
export interface BuiltInAppTemplateVersionSeed {
  readonly versionId: string;
  readonly description: string | null;
  readonly version: NewAppTemplateVersion;
}

/**
 * Boot seed of built-in templates (M5). Inserts never rewrite what exists, so an admin's rename, enable or own default
 * survives. A built-in may carry earlier versions, oldest first: a missing one is added with the next number. The default
 * moves to a version only when the seed adds it and the current default is none or one of the seed's own versions, so
 * an admin's choice (their own version, or a move back) is kept; the description moves with it unless an admin edited it.
 */
export async function ensureBuiltInAppTemplates(
  db: HostingPanelDatabase,
  items: readonly {
    readonly templateId: string;
    readonly versionId: string;
    readonly slug: string;
    readonly name: string;
    readonly description: string | null;
    readonly category: string;
    readonly version: NewAppTemplateVersion;
    /** Oldest first; the item's own version is the newest. */
    readonly previousVersions?: readonly BuiltInAppTemplateVersionSeed[];
  }[],
): Promise<void> {
  // Checked before the transaction: a seed with secret material writes nothing.
  const rows = items.map((item) => ({
    item,
    versions: [...(item.previousVersions ?? []), { versionId: item.versionId, description: item.description, version: item.version }].map((v) => ({
      ...v,
      values: versionValues(v.versionId, item.templateId, 0, v.version, null),
    })),
  }));
  await db.transaction(async (tx) => {
    for (const { item, versions } of rows) {
      await tx
        .insert(appTemplates)
        .values({ id: item.templateId, slug: item.slug, name: item.name, description: item.description, category: item.category, builtIn: true })
        .onConflictDoNothing({ target: appTemplates.id });
      const template = await lockTemplate(tx, item.templateId);
      const existing = await tx
        .select({ id: appTemplateVersions.id, versionNumber: appTemplateVersions.versionNumber })
        .from(appTemplateVersions)
        .where(eq(appTemplateVersions.templateId, item.templateId));
      const present = new Set(existing.map((v) => v.id));
      let latest = Math.max(0, ...existing.map((v) => v.versionNumber));
      let { defaultVersionId, description } = template;
      const seeded = new Map<string, string | null>();
      for (const v of versions) {
        if (!present.has(v.versionId)) {
          const inserted = await tx
            .insert(appTemplateVersions)
            .values({ ...v.values, versionNumber: latest + 1 })
            .onConflictDoNothing({ target: appTemplateVersions.id })
            .returning({ id: appTemplateVersions.id });
          if (inserted.length > 0) {
            latest += 1;
            if (defaultVersionId === null || seeded.has(defaultVersionId)) {
              if (defaultVersionId !== null && description === seeded.get(defaultVersionId)) description = v.description;
              defaultVersionId = v.versionId;
            }
          }
        }
        seeded.set(v.versionId, v.description);
      }
      // A template left without a default gets the newest seeded version.
      defaultVersionId ??= item.versionId;
      if (defaultVersionId !== template.defaultVersionId || description !== template.description) {
        await tx.update(appTemplates).set({ defaultVersionId, description, updatedAt: new Date() }).where(eq(appTemplates.id, item.templateId));
      }
    }
  });
}
