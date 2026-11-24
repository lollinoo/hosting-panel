import { Inject, Injectable } from "@nestjs/common";
import {
  ADMIN_APP_STACKS_MAX,
  ADMIN_APP_TEMPLATE_USAGE_MAX,
  AppTemplateSpecSchema,
  appTemplateInstallParameters,
  appTemplateState,
  type AddAppTemplateVersionInput,
  type AdminAppStacksDto,
  type AdminAppTemplateDetailDto,
  type AdminAppTemplateListQuery,
  type AdminAppTemplateSummaryDto,
  type AdminAppTemplateUsageDto,
  type AdminAppTemplateVersionCreatedDto,
  type AdminAppTemplateVersionDto,
  type AppTemplateSpec,
  type AppTemplateValidationDto,
  type CreateAppTemplateInput,
  type CursorPage,
  type CustomerAppTemplateDto,
  type CustomerAppTemplateSummaryDto,
  type CustomerAppTemplatesDto,
  type UpdateAppTemplateInput,
  type ValidateAppTemplateInput,
} from "@hosting-panel/contracts";
import {
  AppTemplateRepositoryError,
  addAppTemplateVersion,
  and,
  appStackDomains,
  appStacks,
  appTemplateVersions,
  appTemplates,
  archiveAppTemplate,
  asc,
  countAppStacksByTemplateVersion,
  createAppTemplate,
  eq,
  getAppTemplate,
  getAppTemplateVersion,
  inArray,
  isNull,
  listAppTemplates,
  listAppTemplateVersions,
  listPublishedAppTemplates,
  organizations,
  sql,
  updateAppTemplate,
  type AppTemplateRow,
  type AppTemplateVersionRow,
  type DatabaseClient,
  type DatabaseExecutor,
  type HostingPanelDatabase,
  type NewAppTemplateVersion,
} from "@hosting-panel/database";
import { computeAppTemplateSpecHash } from "@hosting-panel/hosting-domain";
import { previewAppTemplateSource, validateAppTemplateSource, type AppTemplateValidationOptions } from "@hosting-panel/policy-engine";
import { appStackDisplayStatuses } from "../app-stacks/app-stack-display-status.js";
import { paginateItems, type PaginationParams } from "../common/control-plane.error.js";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";
import { adminTemplateInvalid, appNotFound, guardedApp, mapAppTemplateError } from "./app-template-errors.js";
import { APP_TEMPLATE_VALIDATION_OPTIONS_TOKEN } from "./app-template-validation-options.js";

/** Audit rows hold ids, numbers and the spec hash only: never the source, the spec, the plan, the preview or a value. */
export interface AppTemplateAuditEvent {
  readonly action: string;
  readonly targetType: "app_template";
  readonly targetId: string;
  readonly details: Record<string, unknown>;
}

export interface AppTemplateActor {
  readonly userId: string;
  readonly audit: (tx: DatabaseExecutor, event: AppTemplateAuditEvent) => Promise<void>;
}

const TARGET_TYPE = "app_template" as const;
const iso = (date: Date): string => date.toISOString();
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Display figures only (H10): a stored spec that does not parse shows zero figures. */
function summaryOf(
  row: AppTemplateRow,
  defaultVersion: Pick<AppTemplateVersionRow, "versionNumber" | "compiledSchema"> | undefined,
  installations: number,
): AdminAppTemplateSummaryDto {
  const parsed = AppTemplateSpecSchema.safeParse(defaultVersion?.compiledSchema);
  const spec = parsed.success ? parsed.data : null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    category: row.category,
    description: row.description,
    builtIn: row.builtIn,
    enabled: row.enabled,
    archivedAt: row.archivedAt ? iso(row.archivedAt) : null,
    state: appTemplateState(row),
    defaultVersionId: row.defaultVersionId,
    defaultVersionNumber: defaultVersion?.versionNumber ?? null,
    installations,
    componentCount: spec?.services.length ?? 0,
    hasIngress: (spec?.ingress.length ?? 0) > 0,
    hasVolumes: (spec?.volumes.length ?? 0) > 0,
    updatedAt: iso(row.updatedAt),
  };
}

function customerSummaryOf(row: AppTemplateRow, version: AppTemplateVersionRow, spec: AppTemplateSpec): CustomerAppTemplateSummaryDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    versionId: version.id,
    versionNumber: version.versionNumber,
    componentCount: spec.services.length,
    cpuMilli: spec.services.reduce((sum, service) => sum + service.limits.cpuMilli, 0),
    memoryBytes: spec.services.reduce((sum, service) => sum + BigInt(service.limits.memoryBytes), 0n).toString(),
    volumeCount: spec.volumes.length,
    hasIngress: spec.ingress.length > 0,
  };
}

const versionOf = (source: string, spec: AppTemplateSpec): NewAppTemplateVersion => ({
  source,
  specVersion: spec.schemaVersion,
  compiledSchema: spec as unknown as Record<string, unknown>,
  specHash: computeAppTemplateSpecHash(spec),
});

@Injectable()
export class AppTemplatesService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(APP_TEMPLATE_VALIDATION_OPTIONS_TOKEN) private readonly validation: AppTemplateValidationOptions,
  ) {}

  /**
   * Pure: no database, no audit. A problem in the template is an answer, never an error. The administrator is writing
   * this source now, so the rules for a new version apply (ADR-0036).
   */
  public validate(input: ValidateAppTemplateInput): AppTemplateValidationDto {
    return this.#preview(input.source, this.#newVersion());
  }

  /** The rules a stored version predates apply only to a source written now; a stored version keeps its own. */
  #newVersion(): AppTemplateValidationOptions {
    return { ...this.validation, newVersion: true };
  }

  #preview(source: string, options: AppTemplateValidationOptions): AppTemplateValidationDto {
    const checked = previewAppTemplateSource(source, options);
    return checked.ok
      ? { valid: true, issues: [], parameters: checked.spec.parameters, preview: checked.preview }
      : { valid: false, issues: checked.errors, parameters: [], preview: null };
  }

  public async list(
    query: AdminAppTemplateListQuery,
    page: PaginationParams,
  ): Promise<{ data: AdminAppTemplateSummaryDto[]; total: number; page: CursorPage }> {
    const db = this.dbClient.db;
    const rows = (await listAppTemplates(db)).filter(
      (row) => (query.state === undefined || appTemplateState(row) === query.state) && (query.category === undefined || row.category === query.category),
    );
    const paged = paginateItems(rows, page);
    const defaultIds = paged.data.flatMap((row) => (row.defaultVersionId === null ? [] : [row.defaultVersionId]));
    const versions =
      defaultIds.length === 0
        ? []
        : await db
            .select({ id: appTemplateVersions.id, versionNumber: appTemplateVersions.versionNumber, compiledSchema: appTemplateVersions.compiledSchema })
            .from(appTemplateVersions)
            .where(inArray(appTemplateVersions.id, defaultIds));
    const installs = await db
      .select({ templateId: appStacks.templateId, stacks: sql<number>`count(*)::int` })
      .from(appStacks)
      .where(isNull(appStacks.deletedAt))
      .groupBy(appStacks.templateId);
    const data = paged.data.map((row) =>
      summaryOf(
        row,
        versions.find((version) => version.id === row.defaultVersionId),
        installs.find((count) => count.templateId === row.id)?.stacks ?? 0,
      ),
    );
    return { data, total: rows.length, page: paged.page };
  }

  public async get(templateId: string): Promise<AdminAppTemplateDetailDto> {
    const db = this.dbClient.db;
    const row = await getAppTemplate(db, templateId);
    if (!row) throw appNotFound();
    const versions = await listAppTemplateVersions(db, templateId);
    const counts = await countAppStacksByTemplateVersion(db, templateId);
    const installs = new Map(counts.map((count) => [count.templateVersionId, count.stacks]));
    return {
      ...summaryOf(
        row,
        versions.find((version) => version.id === row.defaultVersionId),
        counts.reduce((sum, count) => sum + count.stacks, 0),
      ),
      createdAt: iso(row.createdAt),
      versions: versions.map((version) => ({
        id: version.id,
        versionNumber: version.versionNumber,
        specHash: version.specHash,
        createdAt: iso(version.createdAt),
        installations: installs.get(version.id) ?? 0,
      })),
    };
  }

  public async create(input: CreateAppTemplateInput, actor: AppTemplateActor): Promise<AdminAppTemplateDetailDto> {
    const checked = validateAppTemplateSource(input.source, this.#newVersion());
    if (!checked.ok) throw adminTemplateInvalid(checked.errors);
    const { spec } = checked;
    const templateId = await guardedApp(mapAppTemplateError, () =>
      this.dbClient.db.transaction(async (tx) => {
        const created = await createAppTemplate(tx as unknown as HostingPanelDatabase, {
          slug: input.slug,
          name: spec.name,
          description: spec.description === "" ? null : spec.description,
          category: spec.category,
          firstVersion: versionOf(input.source, spec),
          createdBy: actor.userId,
        });
        await actor.audit(tx, {
          action: "admin.app_template.create",
          targetType: TARGET_TYPE,
          targetId: created.template.id,
          details: { slug: input.slug, versionId: created.version.id, versionNumber: 1, specHash: created.version.specHash },
        });
        return created.template.id;
      }),
    );
    return this.get(templateId);
  }

  public async addVersion(templateId: string, input: AddAppTemplateVersionInput, actor: AppTemplateActor): Promise<AdminAppTemplateVersionCreatedDto> {
    const checked = validateAppTemplateSource(input.source, this.#newVersion());
    if (!checked.ok) throw adminTemplateInvalid(checked.errors);
    const { spec } = checked;
    const written = await guardedApp(mapAppTemplateError, () =>
      this.dbClient.db.transaction(async (tx) => {
        const db = tx as unknown as HostingPanelDatabase;
        const result = await addAppTemplateVersion(db, { templateId, version: versionOf(input.source, spec), createdBy: actor.userId });
        const { version } = result;
        if (result.created) {
          await actor.audit(tx, {
            action: "admin.app_template.version",
            targetType: TARGET_TYPE,
            targetId: templateId,
            details: { versionId: version.id, versionNumber: version.versionNumber, specHash: version.specHash, created: true },
          });
        }
        if (input.makeDefault && result.template.defaultVersionId !== version.id) {
          const updated = await updateAppTemplate(db, { templateId, defaultVersionId: version.id });
          await actor.audit(
            tx,
            updated.template.enabled
              ? {
                  action: "admin.app_template.publish",
                  targetType: TARGET_TYPE,
                  targetId: templateId,
                  details: { defaultVersionId: version.id, versionNumber: version.versionNumber },
                }
              : { action: "admin.app_template.update", targetType: TARGET_TYPE, targetId: templateId, details: { changes: updated.changes } },
          );
        }
        return result;
      }),
    );
    return {
      template: await this.get(templateId),
      versionId: written.version.id,
      versionNumber: written.version.versionNumber,
      created: written.created,
    };
  }

  public async update(templateId: string, input: UpdateAppTemplateInput, actor: AppTemplateActor): Promise<AdminAppTemplateDetailDto> {
    await guardedApp(mapAppTemplateError, () =>
      this.dbClient.db.transaction(async (tx) => {
        const updated = await updateAppTemplate(tx as unknown as HostingPanelDatabase, {
          templateId,
          name: input.name,
          description: input.description === "" ? null : input.description,
          category: input.category,
          enabled: input.enabled,
          defaultVersionId: input.defaultVersionId,
        });
        const isPublish = (change: { readonly field: string }): boolean =>
          updated.template.enabled && (change.field === "enabled" || change.field === "defaultVersionId");
        const others = updated.changes.filter((change) => !isPublish(change));
        if (updated.changes.some(isPublish)) {
          // A stricter release never lets an old version out: the default of the locked row is checked again, a refusal rolls back.
          const versionId = updated.template.defaultVersionId;
          const target = versionId === null ? null : await getAppTemplateVersion(tx, { templateId, versionId });
          if (!target) throw new AppTemplateRepositoryError("INVALID_DEFAULT", "unknown default version");
          const checked = validateAppTemplateSource(target.source, this.validation);
          if (!checked.ok) throw adminTemplateInvalid(checked.errors, "This version does not pass the current checks.");
          await actor.audit(tx, {
            action: "admin.app_template.publish",
            targetType: TARGET_TYPE,
            targetId: templateId,
            details: { defaultVersionId: target.id, versionNumber: target.versionNumber },
          });
        }
        if (others.length > 0) {
          await actor.audit(tx, { action: "admin.app_template.update", targetType: TARGET_TYPE, targetId: templateId, details: { changes: others } });
        }
      }),
    );
    return this.get(templateId);
  }

  /** The stored source re-validated with today's validator: an old version may now be invalid. */
  public async getVersion(templateId: string, versionId: string): Promise<AdminAppTemplateVersionDto> {
    const version = await getAppTemplateVersion(this.dbClient.db, { templateId, versionId });
    if (!version) throw appNotFound();
    return {
      id: version.id,
      templateId: version.templateId,
      versionNumber: version.versionNumber,
      specHash: version.specHash,
      createdAt: iso(version.createdAt),
      source: version.source,
      ...this.#preview(version.source, this.validation),
    };
  }

  /** Idempotent; existing stacks keep their version and keep running. */
  public async archive(templateId: string, actor: AppTemplateActor): Promise<AdminAppTemplateDetailDto> {
    await guardedApp(mapAppTemplateError, () =>
      this.dbClient.db.transaction(async (tx) => {
        const { changed } = await archiveAppTemplate(tx as unknown as HostingPanelDatabase, templateId);
        if (changed) await actor.audit(tx, { action: "admin.app_template.archive", targetType: TARGET_TYPE, targetId: templateId, details: {} });
      }),
    );
    return this.get(templateId);
  }

  /** One of the two admin reads that name other organisations' stacks (with adminStacks). */
  public async usage(templateId: string): Promise<AdminAppTemplateUsageDto> {
    const db = this.dbClient.db;
    if (!(await getAppTemplate(db, templateId))) throw appNotFound();
    const rows = await db
      .select({
        id: appStacks.id,
        name: appStacks.name,
        organizationId: appStacks.organizationId,
        organizationName: organizations.name,
        versionNumber: appTemplateVersions.versionNumber,
        status: appStacks.status,
        appliedRevisionId: appStacks.appliedRevisionId,
        appliedRoutesHash: appStacks.appliedRoutesHash,
      })
      .from(appStacks)
      .innerJoin(organizations, eq(organizations.id, appStacks.organizationId))
      .innerJoin(appTemplateVersions, eq(appTemplateVersions.id, appStacks.templateVersionId))
      .where(and(eq(appStacks.templateId, templateId), isNull(appStacks.deletedAt)))
      .orderBy(asc(organizations.name), asc(appStacks.name), asc(appStacks.id))
      .limit(ADMIN_APP_TEMPLATE_USAGE_MAX + 1);
    const kept = rows.slice(0, ADMIN_APP_TEMPLATE_USAGE_MAX);
    // The status the customer sees (ADR-0035), not the stored one.
    const shown = await appStackDisplayStatuses(db, kept, new Date());
    return {
      templateId,
      stacks: kept.map((r) => ({
        id: r.id,
        name: r.name,
        organizationId: r.organizationId,
        organizationName: r.organizationName,
        versionNumber: r.versionNumber,
        status: shown.get(r.id) ?? r.status,
      })),
      truncated: rows.length > ADMIN_APP_TEMPLATE_USAGE_MAX,
    };
  }

  /** Every organization's live stacks for the administrator's list; same joins and order as usage(), without the template filter. */
  public async adminStacks(): Promise<AdminAppStacksDto> {
    const db = this.dbClient.db;
    const rows = await db
      .select({
        id: appStacks.id,
        name: appStacks.name,
        organizationName: organizations.name,
        templateId: appStacks.templateId,
        templateName: appTemplates.name,
        versionNumber: appTemplateVersions.versionNumber,
        status: appStacks.status,
        appliedRevisionId: appStacks.appliedRevisionId,
        appliedRoutesHash: appStacks.appliedRoutesHash,
      })
      .from(appStacks)
      .innerJoin(organizations, eq(organizations.id, appStacks.organizationId))
      .innerJoin(appTemplates, eq(appTemplates.id, appStacks.templateId))
      .innerJoin(appTemplateVersions, eq(appTemplateVersions.id, appStacks.templateVersionId))
      .where(isNull(appStacks.deletedAt))
      .orderBy(asc(organizations.name), asc(appStacks.name), asc(appStacks.id))
      .limit(ADMIN_APP_STACKS_MAX + 1);
    const kept = rows.slice(0, ADMIN_APP_STACKS_MAX);
    const domains =
      kept.length === 0
        ? []
        : await db
            .select({ stackId: appStackDomains.stackId, hostname: appStackDomains.hostname, status: appStackDomains.status })
            .from(appStackDomains)
            .where(and(inArray(appStackDomains.stackId, kept.map((r) => r.id)), isNull(appStackDomains.removalRequestedAt)));
    // Same rule as the customer list (app-stack-dto.ts appStackSummaryDto).
    const primary = (id: string) => {
      const own = domains.filter((d) => d.stackId === id).sort((a, b) => byText(a.hostname, b.hostname));
      return (own.find((d) => d.status === "active") ?? own[0])?.hostname ?? null;
    };
    // The status the customer sees (ADR-0035), not the stored one.
    const shown = await appStackDisplayStatuses(db, kept, new Date());
    return {
      stacks: kept.map((r) => ({
        id: r.id,
        name: r.name,
        organizationName: r.organizationName,
        templateId: r.templateId,
        templateName: r.templateName,
        versionNumber: r.versionNumber,
        status: shown.get(r.id) ?? r.status,
        primaryHostname: primary(r.id),
      })),
      truncated: rows.length > ADMIN_APP_STACKS_MAX,
    };
  }

  public async listForCustomer(): Promise<CustomerAppTemplatesDto> {
    const templates = (await this.#offered()).map((offer) => offer.summary);
    return { templates, categories: [...new Set(templates.map((template) => template.category))].sort(byText) };
  }

  public async getForCustomer(templateId: string): Promise<CustomerAppTemplateDto> {
    const [offer] = await this.#offered(templateId);
    if (!offer) throw appNotFound();
    const { spec, summary } = offer;
    return {
      ...summary,
      parameters: appTemplateInstallParameters(spec.parameters),
      ingress: spec.ingress
        .map(({ service, port }) => ({ componentKey: service, port }))
        .sort((a, b) => byText(a.componentKey, b.componentKey) || a.port - b.port),
      components: spec.services
        .map((service) => ({ key: service.key, cpuMilli: service.limits.cpuMilli, memoryBytes: service.limits.memoryBytes }))
        .sort((a, b) => byText(a.key, b.key)),
    };
  }

  /** Published templates whose default version passes today's validator (it is an offer); the others are left out. */
  async #offered(templateId?: string): Promise<{ readonly spec: AppTemplateSpec; readonly summary: CustomerAppTemplateSummaryDto }[]> {
    const rows = await listPublishedAppTemplates(this.dbClient.db);
    return rows.flatMap(({ template, version }) => {
      if (templateId !== undefined && template.id !== templateId) return [];
      const checked = validateAppTemplateSource(version.source, this.validation);
      return checked.ok ? [{ spec: checked.spec, summary: customerSummaryOf(template, version, checked.spec) }] : [];
    });
  }
}
