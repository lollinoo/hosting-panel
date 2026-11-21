import { createHash, randomUUID } from "node:crypto";
import {
  BUILT_IN_TEMPLATE_BY_MODULE,
  BUILT_IN_VERSION_BY_MODULE,
  BUILT_IN_WORDPRESS_SOURCE,
  BUILT_IN_WORDPRESS_SPEC,
  BUILT_IN_WORDPRESS_TEMPLATE_ID,
  BUILT_IN_WORDPRESS_VERSION_ID,
  LEGACY_SITE_TYPE,
  SITE_TYPE_KEYS,
  SiteTemplateSpecSchema,
  type SiteTemplateSpec,
  type SiteTypeKey,
} from "@hosting-panel/contracts";
import { canonicalizeJson } from "@hosting-panel/hosting-domain";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DatabaseExecutor, HostingPanelDatabase } from "./client.js";
import { siteTemplates, siteTemplateVersions, sites } from "./schema.js";

export type SiteTemplateRow = typeof siteTemplates.$inferSelect;
export type SiteTemplateVersionRow = typeof siteTemplateVersions.$inferSelect;

export type SiteTemplateRepositoryErrorCode =
  | "NOT_FOUND"
  | "ARCHIVED"
  | "BUILT_IN"
  | "NAME_TAKEN"
  | "MODULE_MISMATCH"
  | "INVALID_DEFAULT"
  | "CORRUPT";

export class SiteTemplateRepositoryError extends Error {
  constructor(
    readonly code: SiteTemplateRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SiteTemplateRepositoryError";
  }
}

const NAME_INDEX = "uq_site_templates_name_active";
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

/** The active-name unique index refused a write; the transaction is already rolled back (or its savepoint). */
function mapNameTaken(err: unknown): unknown {
  for (let current: unknown = err, depth = 0; current && typeof current === "object" && depth < 4; depth += 1) {
    const e = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (e.code === "23505" && (e.constraint === NAME_INDEX || (typeof e.message === "string" && e.message.includes(NAME_INDEX)))) {
      return new SiteTemplateRepositoryError("NAME_TAKEN", "A template with this name already exists.");
    }
    current = e.cause;
  }
  return err;
}

/** sha256 hex of the canonical JSON of the spec: the identity of a version's content. */
export function siteTemplateSpecHash(spec: SiteTemplateSpec): string {
  return createHash("sha256").update(canonicalizeJson(spec)).digest("hex");
}

export function readSiteTemplateSpec(row: Pick<SiteTemplateVersionRow, "spec">): SiteTemplateSpec {
  const parsed = SiteTemplateSpecSchema.safeParse(row.spec);
  if (!parsed.success) throw new SiteTemplateRepositoryError("CORRUPT", "The stored site template spec is invalid.");
  return parsed.data;
}

export interface SiteTemplateSummaryRow extends SiteTemplateRow {
  defaultVersionNumber: number | null;
  versionCount: number;
  siteCount: number;
}
export interface SiteTemplateVersionMetaRow {
  id: string;
  templateId: string;
  versionNumber: number;
  createdAt: Date;
  siteCount: number;
}
export interface SiteTemplateRefRow {
  templateId: string;
  templateName: string;
  versionId: string;
  versionNumber: number;
  defaultVersionId: string | null;
  defaultVersionNumber: number | null;
}

const isModuleKey = (value: string | null): value is SiteTypeKey => (SITE_TYPE_KEYS as readonly string[]).includes(value ?? "");
/** The version a site runs: its column, or built-in v1 of its module while the column is NULL (sites that predate templates). */
function effectiveVersionId(site: { siteType: string | null; templateVersionId: string | null }): string | null {
  if (site.templateVersionId) return site.templateVersionId;
  return isModuleKey(site.siteType) ? BUILT_IN_VERSION_BY_MODULE[site.siteType] : null;
}

const lowerName = sql`lower(${siteTemplates.name})`;

export async function countSitesByTemplateVersion(db: DatabaseExecutor): Promise<Map<string, number>> {
  const rows = await db
    .select({ versionId: sites.templateVersionId, siteType: sites.siteType, n: count() })
    .from(sites)
    .where(inArray(sites.siteType, [...SITE_TYPE_KEYS]))
    .groupBy(sites.templateVersionId, sites.siteType);
  const counts = new Map<string, number>();
  for (const row of rows) {
    const versionId = effectiveVersionId({ siteType: row.siteType, templateVersionId: row.versionId });
    if (versionId) counts.set(versionId, (counts.get(versionId) ?? 0) + row.n);
  }
  return counts;
}

export async function listSiteTemplates(db: DatabaseExecutor, options: { includeArchived?: boolean } = {}): Promise<SiteTemplateSummaryRow[]> {
  const templates = await db
    .select()
    .from(siteTemplates)
    .where(options.includeArchived ? undefined : isNull(siteTemplates.archivedAt))
    .orderBy(desc(siteTemplates.builtIn), lowerName, asc(siteTemplates.id));
  const versions = await db
    .select({ id: siteTemplateVersions.id, templateId: siteTemplateVersions.templateId, versionNumber: siteTemplateVersions.versionNumber })
    .from(siteTemplateVersions);
  const perVersion = await countSitesByTemplateVersion(db);
  return templates.map((template) => {
    const own = versions.filter((v) => v.templateId === template.id);
    return {
      ...template,
      defaultVersionNumber: own.find((v) => v.id === template.defaultVersionId)?.versionNumber ?? null,
      versionCount: own.length,
      siteCount: own.reduce((sum, v) => sum + (perVersion.get(v.id) ?? 0), 0),
    };
  });
}

export async function getSiteTemplate(
  db: DatabaseExecutor,
  templateId: string,
): Promise<{ template: SiteTemplateRow; versions: SiteTemplateVersionMetaRow[] } | null> {
  const [template] = await db.select().from(siteTemplates).where(eq(siteTemplates.id, templateId));
  if (!template) return null;
  const versions = await db
    .select({ id: siteTemplateVersions.id, templateId: siteTemplateVersions.templateId, versionNumber: siteTemplateVersions.versionNumber, createdAt: siteTemplateVersions.createdAt })
    .from(siteTemplateVersions)
    .where(eq(siteTemplateVersions.templateId, templateId))
    .orderBy(desc(siteTemplateVersions.versionNumber));
  const perVersion = await countSitesByTemplateVersion(db);
  return { template, versions: versions.map((v) => ({ ...v, siteCount: perVersion.get(v.id) ?? 0 })) };
}

export async function getSiteTemplateVersion(db: DatabaseExecutor, templateId: string, versionId: string): Promise<SiteTemplateVersionRow | null> {
  const [row] = await db
    .select()
    .from(siteTemplateVersions)
    .where(and(eq(siteTemplateVersions.id, versionId), eq(siteTemplateVersions.templateId, templateId)));
  return row ?? null;
}

export async function getSiteTemplateVersionById(
  db: DatabaseExecutor,
  versionId: string,
): Promise<{ template: SiteTemplateRow; version: SiteTemplateVersionRow } | null> {
  const [row] = await db
    .select({ template: siteTemplates, version: siteTemplateVersions })
    .from(siteTemplateVersions)
    .innerJoin(siteTemplates, eq(siteTemplates.id, siteTemplateVersions.templateId))
    .where(eq(siteTemplateVersions.id, versionId));
  return row ?? null;
}

function offeredTemplates(db: DatabaseExecutor, templateId?: string) {
  return db
    .select({ template: siteTemplates, version: siteTemplateVersions })
    .from(siteTemplates)
    .innerJoin(
      siteTemplateVersions,
      and(eq(siteTemplateVersions.id, siteTemplates.defaultVersionId), eq(siteTemplateVersions.templateId, siteTemplates.id)),
    )
    .where(and(eq(siteTemplates.enabled, true), isNull(siteTemplates.archivedAt), templateId ? eq(siteTemplates.id, templateId) : undefined))
    .orderBy(desc(siteTemplates.builtIn), lowerName, asc(siteTemplates.id));
}

/** Enabled, non-archived templates with their default version; the built-in first. */
export function listCustomerSiteTemplates(db: DatabaseExecutor): Promise<{ template: SiteTemplateRow; version: SiteTemplateVersionRow }[]> {
  return offeredTemplates(db);
}

/** `templateId: null` means the built-in of the legacy site type. Null when unknown, disabled, archived or without default. */
export async function getSiteTemplateForCreate(
  db: DatabaseExecutor,
  input: { templateId: string | null },
): Promise<{ template: SiteTemplateRow; version: SiteTemplateVersionRow } | null> {
  const [row] = await offeredTemplates(db, input.templateId ?? BUILT_IN_TEMPLATE_BY_MODULE[LEGACY_SITE_TYPE]);
  return row ?? null;
}

export interface CreateSiteTemplateInput {
  module: SiteTypeKey;
  name: string;
  description?: string | null;
  source: string;
  spec: SiteTemplateSpec;
  createdBy: string | null;
}

/** One transaction (a savepoint when `db` is one): a disabled custom template whose default is version 1. */
export async function createSiteTemplate(
  db: HostingPanelDatabase,
  input: CreateSiteTemplateInput,
): Promise<{ template: SiteTemplateRow; version: SiteTemplateVersionRow }> {
  if (input.spec.module !== input.module) {
    throw new SiteTemplateRepositoryError("MODULE_MISMATCH", "The spec belongs to another site type module.");
  }
  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(siteTemplates)
        .values({ id: newId("stpl"), module: input.module, name: input.name, description: input.description ?? null })
        .returning();
      const [version] = await tx
        .insert(siteTemplateVersions)
        .values({
          id: newId("stv"),
          templateId: created!.id,
          versionNumber: 1,
          source: input.source,
          spec: input.spec,
          specHash: siteTemplateSpecHash(input.spec),
          createdBy: input.createdBy,
        })
        .returning();
      const [template] = await tx
        .update(siteTemplates)
        .set({ defaultVersionId: version!.id })
        .where(eq(siteTemplates.id, created!.id))
        .returning();
      return { template: template!, version: version! };
    });
  } catch (err) {
    throw mapNameTaken(err);
  }
}

async function lockTemplate(tx: DatabaseExecutor, templateId: string): Promise<SiteTemplateRow> {
  const [row] = await tx.select().from(siteTemplates).where(eq(siteTemplates.id, templateId)).for("update");
  if (!row) throw new SiteTemplateRepositoryError("NOT_FOUND", "Site template not found.");
  return row;
}

function assertNotArchived(template: SiteTemplateRow): void {
  if (template.archivedAt) throw new SiteTemplateRepositoryError("ARCHIVED", "The site template is archived.");
}

export interface AddSiteTemplateVersionInput {
  templateId: string;
  source: string;
  spec: SiteTemplateSpec;
  createdBy: string | null;
  makeDefault: boolean;
}

/**
 * Template locked FOR UPDATE, then max+1. A source equal to the latest version's is not stored again (double submit);
 * `makeDefault` is still applied.
 */
export async function addSiteTemplateVersion(
  db: HostingPanelDatabase,
  input: AddSiteTemplateVersionInput,
): Promise<{ template: SiteTemplateRow; version: SiteTemplateVersionRow; created: boolean }> {
  return db.transaction(async (tx) => {
    let template: SiteTemplateRow = await lockTemplate(tx, input.templateId);
    assertNotArchived(template);
    if (input.spec.module !== template.module) {
      throw new SiteTemplateRepositoryError("MODULE_MISMATCH", "The spec belongs to another site type module.");
    }
    const [latest] = await tx
      .select()
      .from(siteTemplateVersions)
      .where(eq(siteTemplateVersions.templateId, template.id))
      .orderBy(desc(siteTemplateVersions.versionNumber))
      .limit(1);
    let version = latest;
    const created = !latest || latest.source !== input.source;
    if (created) {
      [version] = await tx
        .insert(siteTemplateVersions)
        .values({
          id: newId("stv"),
          templateId: template.id,
          versionNumber: (latest?.versionNumber ?? 0) + 1,
          source: input.source,
          spec: input.spec,
          specHash: siteTemplateSpecHash(input.spec),
          createdBy: input.createdBy,
        })
        .returning();
    }
    if (input.makeDefault) {
      const [updated] = await tx
        .update(siteTemplates)
        .set({ defaultVersionId: version!.id, updatedAt: new Date() })
        .where(eq(siteTemplates.id, template.id))
        .returning();
      template = updated!;
    }
    return { template, version: version!, created };
  });
}

export interface UpdateSiteTemplateInput {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  defaultVersionId?: string;
}

export async function updateSiteTemplate(db: HostingPanelDatabase, templateId: string, patch: UpdateSiteTemplateInput): Promise<SiteTemplateRow> {
  try {
    return await db.transaction(async (tx) => {
      const template = await lockTemplate(tx, templateId);
      assertNotArchived(template);
      if (patch.defaultVersionId !== undefined && !(await getSiteTemplateVersion(tx, templateId, patch.defaultVersionId))) {
        throw new SiteTemplateRepositoryError("INVALID_DEFAULT", "The default must be a version of this template.");
      }
      if (patch.enabled && !(patch.defaultVersionId ?? template.defaultVersionId)) {
        throw new SiteTemplateRepositoryError("INVALID_DEFAULT", "A template without a default version cannot be enabled.");
      }
      const set = {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.defaultVersionId === undefined ? {} : { defaultVersionId: patch.defaultVersionId }),
      };
      if (Object.keys(set).length === 0) return template;
      const [updated] = await tx
        .update(siteTemplates)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(siteTemplates.id, templateId))
        .returning();
      return updated!;
    });
  } catch (err) {
    throw mapNameTaken(err);
  }
}

/**
 * Disables and archives a custom template; idempotent: an archived one is returned with `changed: false` (decided under
 * the lock, so exactly one of two concurrent calls reports a change). Sites keep their version (versions are never touched).
 */
export async function archiveSiteTemplate(db: HostingPanelDatabase, templateId: string): Promise<{ template: SiteTemplateRow; changed: boolean }> {
  return db.transaction(async (tx) => {
    const template = await lockTemplate(tx, templateId);
    if (template.builtIn) throw new SiteTemplateRepositoryError("BUILT_IN", "The built-in template cannot be archived.");
    if (template.archivedAt) return { template, changed: false };
    const [archived] = await tx
      .update(siteTemplates)
      .set({ archivedAt: new Date(), enabled: false, updatedAt: new Date() })
      .where(eq(siteTemplates.id, templateId))
      .returning();
    return { template: archived!, changed: true };
  });
}

/** Site id -> template reference. A site whose version cannot be resolved is omitted (the caller reports `template: null`). */
export async function listSiteTemplateRefs(
  db: DatabaseExecutor,
  sitesIn: readonly { id: string; siteType: string | null; templateVersionId: string | null }[],
): Promise<Map<string, SiteTemplateRefRow>> {
  const effective = new Map<string, string>();
  for (const site of sitesIn) {
    const versionId = effectiveVersionId(site);
    if (versionId) effective.set(site.id, versionId);
  }
  const refs = new Map<string, SiteTemplateRefRow>();
  if (effective.size === 0) return refs;
  const defaultVersion = alias(siteTemplateVersions, "default_version");
  const rows = await db
    .select({
      templateId: siteTemplates.id,
      templateName: siteTemplates.name,
      versionId: siteTemplateVersions.id,
      versionNumber: siteTemplateVersions.versionNumber,
      defaultVersionId: siteTemplates.defaultVersionId,
      defaultVersionNumber: defaultVersion.versionNumber,
    })
    .from(siteTemplateVersions)
    .innerJoin(siteTemplates, eq(siteTemplates.id, siteTemplateVersions.templateId))
    .leftJoin(defaultVersion, eq(defaultVersion.id, siteTemplates.defaultVersionId))
    .where(inArray(siteTemplateVersions.id, [...new Set(effective.values())]));
  const byVersion = new Map(rows.map((row) => [row.versionId, row]));
  for (const [siteId, versionId] of effective) {
    const row = byVersion.get(versionId);
    if (row) refs.set(siteId, row);
  }
  return refs;
}

/** Release downgrade gate: sites that run a version other than the built-in ones. */
export async function countSitesOnNonBuiltInTemplateVersions(db: DatabaseExecutor): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(sites)
    .where(and(isNotNull(sites.templateVersionId), notInArray(sites.templateVersionId, Object.values(BUILT_IN_VERSION_BY_MODULE))));
  return row?.n ?? 0;
}

/**
 * Boot ensure of the built-in WordPress template. Every statement is idempotent and none rewrites what exists, so an
 * admin's rename, disable or newer default survives; only a template left without a default is repaired (enabled, v1).
 * Concurrent boots are safe: a conflicting insert does nothing, the update only matches a NULL default.
 */
export async function ensureBuiltInSiteTemplates(db: DatabaseExecutor): Promise<void> {
  await db
    .insert(siteTemplates)
    .values({ id: BUILT_IN_WORDPRESS_TEMPLATE_ID, module: "wordpress", name: "WordPress", builtIn: true })
    .onConflictDoNothing({ target: siteTemplates.id });
  await db
    .insert(siteTemplateVersions)
    .values({
      id: BUILT_IN_WORDPRESS_VERSION_ID,
      templateId: BUILT_IN_WORDPRESS_TEMPLATE_ID,
      versionNumber: 1,
      source: BUILT_IN_WORDPRESS_SOURCE,
      spec: BUILT_IN_WORDPRESS_SPEC,
      specHash: siteTemplateSpecHash(BUILT_IN_WORDPRESS_SPEC),
      createdBy: null,
    })
    .onConflictDoNothing({ target: siteTemplateVersions.id });
  await db
    .update(siteTemplates)
    .set({ defaultVersionId: BUILT_IN_WORDPRESS_VERSION_ID, enabled: true, updatedAt: new Date() })
    .where(and(eq(siteTemplates.id, BUILT_IN_WORDPRESS_TEMPLATE_ID), isNull(siteTemplates.defaultVersionId)));
}
