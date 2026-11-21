import { Inject, Injectable } from "@nestjs/common";
import {
  SITE_TEMPLATE_MODULES,
  SiteTemplateRenderError,
  toCustomerSiteTypeDto,
  toSiteTemplateParameterDtos,
  toSiteTemplatePreview,
  type AddSiteTemplateVersionInput,
  type AdminSiteTemplateDetailDto,
  type AdminSiteTemplateSummaryDto,
  type AdminSiteTemplatesListDto,
  type AdminSiteTemplateVersionCreatedDto,
  type AdminSiteTemplateVersionDto,
  type CreateSiteTemplateInput,
  type CustomerSiteTypesDto,
  type ErrorDetail,
  type SiteTemplateIssueDto,
  type SiteTemplateSpec,
  type SiteTemplateValidationDto,
  type UpdateSiteTemplateInput,
  type ValidateSiteTemplateInput,
} from "@hosting-panel/contracts";
import {
  SiteTemplateRepositoryError,
  addSiteTemplateVersion,
  archiveSiteTemplate,
  createSiteTemplate,
  getSiteTemplate,
  getSiteTemplateVersion,
  listCustomerSiteTemplates,
  listSiteTemplates,
  readSiteTemplateSpec,
  updateSiteTemplate,
  type DatabaseClient,
  type DatabaseExecutor,
  type HostingPanelDatabase,
  type SiteTemplateRow,
  type SiteTemplateVersionMetaRow,
  type SiteTemplateVersionRow,
  type UpdateSiteTemplateInput as UpdateSiteTemplatePatch,
} from "@hosting-panel/database";
import { validateSiteTemplateSource, type SiteTemplateIssue } from "@hosting-panel/policy-engine";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";

/** Audit rows hold ids, names, numbers and the spec hash only: never the source, the spec or an environment value. */
export interface TemplateAuditEvent {
  readonly action: string;
  readonly targetType: "site_template";
  readonly targetId: string;
  readonly details: Record<string, unknown>;
}

export interface TemplateActor {
  readonly userId: string;
  readonly audit: (tx: DatabaseExecutor, event: TemplateAuditEvent) => Promise<void>;
}

const MAX_REFUSAL_DETAILS = 20;
const TARGET_TYPE = "site_template" as const;

const refusal = (code: "VALIDATION_ERROR" | "RESOURCE_LOCKED" | "ALREADY_EXISTS", message: string, detail: ErrorDetail): ControlPlaneError =>
  new ControlPlaneError(code, message, { details: [detail] });
const notFound = (): ControlPlaneError => new ControlPlaneError("NOT_FOUND", "Requested organization or resource was not found.");
const archived = (): ControlPlaneError =>
  refusal("RESOURCE_LOCKED", "This site type is archived and cannot be changed.", { message: "This site type is archived.", reason: "template_archived" });

/** The repository errors the admin can cause, in the existing error codes; any other error is rethrown. */
function mapRepositoryError(err: unknown): unknown {
  if (!(err instanceof SiteTemplateRepositoryError)) return err;
  switch (err.code) {
    case "NOT_FOUND":
      return notFound();
    case "ARCHIVED":
      return archived();
    case "BUILT_IN":
      return refusal("RESOURCE_LOCKED", "The built-in site type cannot be archived.", { message: "The built-in site type cannot be archived.", reason: "built_in" });
    case "NAME_TAKEN":
      return refusal("ALREADY_EXISTS", "A site type with this name already exists.", {
        field: "name",
        message: "A site type with this name already exists.",
        reason: "name_taken",
      });
    case "MODULE_MISMATCH":
      return refusal("VALIDATION_ERROR", "The template does not belong to this module.", {
        field: "source",
        message: "The template does not belong to this module.",
        reason: "module_mismatch",
      });
    case "INVALID_DEFAULT":
      return refusal("VALIDATION_ERROR", "The default version must be a version of this template.", {
        field: "defaultVersionId",
        message: "The default version must be a version of this template.",
        reason: "unknown_version",
      });
    case "CORRUPT":
      return new ControlPlaneError("INTERNAL_ERROR", "The stored site type is damaged.");
  }
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw mapRepositoryError(err);
  }
}

const toIssueDto = (issue: SiteTemplateIssue): SiteTemplateIssueDto => ({
  line: issue.line ?? null,
  column: issue.column ?? null,
  path: issue.path === "" ? null : issue.path,
  code: issue.code,
  message: issue.message,
});

/** A 400 with up to 20 positioned problems and nothing written. */
function invalidTemplate(errors: readonly SiteTemplateIssue[]): ControlPlaneError {
  return new ControlPlaneError("VALIDATION_ERROR", "The template is not valid.", {
    details: errors.slice(0, MAX_REFUSAL_DETAILS).map((issue) => ({
      field: issue.path === "" ? "source" : issue.path,
      message: issue.line === undefined ? issue.message : `line ${issue.line}, column ${issue.column ?? 1}: ${issue.message}`,
      reason: issue.code,
    })),
  });
}

const iso = (date: Date): string => date.toISOString();

function summaryOf(
  template: SiteTemplateRow,
  figures: { readonly defaultVersionNumber: number | null; readonly versionCount: number; readonly siteCount: number },
): AdminSiteTemplateSummaryDto {
  if (template.defaultVersionId === null || figures.defaultVersionNumber === null) {
    throw new ControlPlaneError("INTERNAL_ERROR", "The stored site type is damaged.");
  }
  return {
    id: template.id,
    module: template.module,
    name: template.name,
    description: template.description,
    builtIn: template.builtIn,
    enabled: template.enabled,
    archivedAt: template.archivedAt ? iso(template.archivedAt) : null,
    defaultVersionId: template.defaultVersionId,
    defaultVersionNumber: figures.defaultVersionNumber,
    versionCount: figures.versionCount,
    siteCount: figures.siteCount,
    createdAt: iso(template.createdAt),
    updatedAt: iso(template.updatedAt),
  };
}

function detailOf(found: { readonly template: SiteTemplateRow; readonly versions: readonly SiteTemplateVersionMetaRow[] }): AdminSiteTemplateDetailDto {
  const { template, versions } = found;
  return {
    ...summaryOf(template, {
      defaultVersionNumber: versions.find((version) => version.id === template.defaultVersionId)?.versionNumber ?? null,
      versionCount: versions.length,
      siteCount: versions.reduce((sum, version) => sum + version.siteCount, 0),
    }),
    versions: versions.map((version) => ({
      id: version.id,
      versionNumber: version.versionNumber,
      createdAt: iso(version.createdAt),
      siteCount: version.siteCount,
      isDefault: version.id === template.defaultVersionId,
    })),
  };
}

const versionDtoOf = (version: SiteTemplateVersionRow): AdminSiteTemplateVersionDto => ({
  id: version.id,
  templateId: version.templateId,
  versionNumber: version.versionNumber,
  createdAt: iso(version.createdAt),
  source: version.source,
});

type Change = { readonly field: "name" | "description" | "enabled" | "defaultVersionId"; readonly from: unknown; readonly to: unknown };

@Injectable()
export class SiteTemplatesService {
  public constructor(@Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient) {}

  public async list(): Promise<AdminSiteTemplatesListDto> {
    const rows = await listSiteTemplates(this.dbClient.db, { includeArchived: true });
    return {
      templates: rows.map((row) => summaryOf(row, row)),
      modules: Object.values(SITE_TEMPLATE_MODULES).map((module) => ({ key: module.key, phpVersions: [...module.phpVersions] })),
    };
  }

  public async get(templateId: string): Promise<AdminSiteTemplateDetailDto> {
    const found = await getSiteTemplate(this.dbClient.db, templateId);
    if (!found) throw notFound();
    return detailOf(found);
  }

  public async getVersion(templateId: string, versionId: string): Promise<AdminSiteTemplateVersionDto> {
    const version = await getSiteTemplateVersion(this.dbClient.db, templateId, versionId);
    if (!version) throw notFound();
    return versionDtoOf(version);
  }

  /** Pure: no database, no audit. A problem in the template is an answer (200), never an error. */
  public validate(input: ValidateSiteTemplateInput): SiteTemplateValidationDto {
    const checked = validateSiteTemplateSource(input.source, input.module);
    if (!checked.ok) return { valid: false, errors: checked.errors.map(toIssueDto), parameters: [], preview: null };
    try {
      // The preview is built from the spec arrays, never from the rendered configuration.
      return { valid: true, errors: [], parameters: toSiteTemplateParameterDtos(checked.spec), preview: toSiteTemplatePreview(checked.spec) };
    } catch (err) {
      if (!(err instanceof SiteTemplateRenderError)) throw err;
      return { valid: false, errors: [{ line: null, column: null, path: null, code: "render_failed", message: err.message }], parameters: [], preview: null };
    }
  }

  public async create(input: CreateSiteTemplateInput, actor: TemplateActor): Promise<AdminSiteTemplateDetailDto> {
    const checked = validateSiteTemplateSource(input.source, input.module);
    if (!checked.ok) throw invalidTemplate(checked.errors);
    const description = input.description === undefined || input.description === "" ? null : input.description;
    const id = await guarded(() =>
      this.dbClient.db.transaction(async (tx) => {
        const created = await createSiteTemplate(tx as unknown as HostingPanelDatabase, {
          module: input.module,
          name: input.name,
          description,
          source: input.source,
          spec: checked.spec,
          createdBy: actor.userId,
        });
        await actor.audit(tx, {
          action: "admin.site_template.create",
          targetType: TARGET_TYPE,
          targetId: created.template.id,
          details: {
            module: input.module,
            name: created.template.name,
            versionId: created.version.id,
            versionNumber: created.version.versionNumber,
            specHash: created.version.specHash,
          },
        });
        return created.template.id;
      }),
    );
    return this.get(id);
  }

  public async addVersion(templateId: string, input: AddSiteTemplateVersionInput, actor: TemplateActor): Promise<AdminSiteTemplateVersionCreatedDto> {
    const before = await this.#editable(templateId);
    const checked = validateSiteTemplateSource(input.source, before.template.module);
    if (!checked.ok) throw invalidTemplate(checked.errors);
    const written = await guarded(() =>
      this.dbClient.db.transaction(async (tx) => {
        const result = await addSiteTemplateVersion(tx as unknown as HostingPanelDatabase, {
          templateId,
          source: input.source,
          spec: checked.spec,
          createdBy: actor.userId,
          makeDefault: input.makeDefault,
        });
        // A no-op save (the source equals the latest version and the default stays) leaves no row.
        if (result.created || before.template.defaultVersionId !== result.template.defaultVersionId) {
          await actor.audit(tx, {
            action: "admin.site_template.version",
            targetType: TARGET_TYPE,
            targetId: templateId,
            details: {
              templateId,
              versionId: result.version.id,
              versionNumber: result.version.versionNumber,
              specHash: result.version.specHash,
              makeDefault: input.makeDefault,
              created: result.created,
            },
          });
        }
        return result;
      }),
    );
    return { ...versionDtoOf(written.version), isDefault: written.template.defaultVersionId === written.version.id, created: written.created };
  }

  public async update(templateId: string, input: UpdateSiteTemplateInput, actor: TemplateActor): Promise<AdminSiteTemplateDetailDto> {
    const existing = await this.#editable(templateId);
    const { template } = existing;
    const patch: UpdateSiteTemplatePatch = {};
    const changes: Change[] = [];
    const description = input.description === undefined ? undefined : input.description === "" ? null : input.description;
    if (input.name !== undefined && input.name !== template.name) {
      patch.name = input.name;
      changes.push({ field: "name", from: template.name, to: input.name });
    }
    if (description !== undefined && description !== template.description) {
      patch.description = description;
      changes.push({ field: "description", from: template.description, to: description });
    }
    if (input.enabled !== undefined && input.enabled !== template.enabled) {
      patch.enabled = input.enabled;
      changes.push({ field: "enabled", from: template.enabled, to: input.enabled });
    }
    if (input.defaultVersionId !== undefined && input.defaultVersionId !== template.defaultVersionId) {
      patch.defaultVersionId = input.defaultVersionId;
      changes.push({ field: "defaultVersionId", from: template.defaultVersionId, to: input.defaultVersionId });
    }
    if (changes.length === 0) return detailOf(existing);

    // A template that will be offered must pass today's validator: a stricter release must not let an old version out.
    const offered = patch.enabled ?? template.enabled;
    if (offered && (patch.enabled === true || patch.defaultVersionId !== undefined)) {
      const versionId = patch.defaultVersionId ?? template.defaultVersionId;
      const version = versionId === null ? null : await getSiteTemplateVersion(this.dbClient.db, templateId, versionId);
      if (!version) throw mapRepositoryError(new SiteTemplateRepositoryError("INVALID_DEFAULT", "unknown default version"));
      const checked = validateSiteTemplateSource(version.source, template.module);
      if (!checked.ok) {
        throw refusal("VALIDATION_ERROR", "This site type does not pass the current checks and cannot be offered.", {
          field: "enabled",
          message: "This site type does not pass the current checks and cannot be offered.",
          reason: "template_invalid",
        });
      }
    }

    await guarded(() =>
      this.dbClient.db.transaction(async (tx) => {
        await updateSiteTemplate(tx as unknown as HostingPanelDatabase, templateId, patch);
        await actor.audit(tx, { action: "admin.site_template.update", targetType: TARGET_TYPE, targetId: templateId, details: { templateId, changes } });
      }),
    );
    return this.get(templateId);
  }

  /** Idempotent: an archived template is answered unchanged, with no write and no audit. */
  public async archive(templateId: string, actor: TemplateActor): Promise<AdminSiteTemplateDetailDto> {
    const existing = await this.#load(templateId);
    if (existing.template.archivedAt !== null) return detailOf(existing);
    if (existing.template.builtIn) throw mapRepositoryError(new SiteTemplateRepositoryError("BUILT_IN", "built-in"));
    const summary = detailOf(existing);
    await guarded(() =>
      this.dbClient.db.transaction(async (tx) => {
        await archiveSiteTemplate(tx as unknown as HostingPanelDatabase, templateId);
        await actor.audit(tx, {
          action: "admin.site_template.archive",
          targetType: TARGET_TYPE,
          targetId: templateId,
          details: { templateId, name: summary.name, siteCount: summary.siteCount },
        });
      }),
    );
    return this.get(templateId);
  }

  /** Enabled, not archived, default version; never the source, the image, the environment or the limits. */
  public async listForCustomer(): Promise<CustomerSiteTypesDto> {
    const rows = await listCustomerSiteTemplates(this.dbClient.db);
    const siteTypes: CustomerSiteTypesDto["siteTypes"] = [];
    for (const { template, version } of rows) {
      let spec: SiteTemplateSpec;
      try {
        spec = readSiteTemplateSpec(version);
      } catch (err) {
        if (err instanceof SiteTemplateRepositoryError && err.code === "CORRUPT") continue; // never a 500 for the customer
        throw err;
      }
      siteTypes.push(toCustomerSiteTypeDto({ id: template.id, name: template.name, description: template.description, spec }));
    }
    return { siteTypes };
  }

  async #load(templateId: string): Promise<NonNullable<Awaited<ReturnType<typeof getSiteTemplate>>>> {
    const found = await getSiteTemplate(this.dbClient.db, templateId);
    if (!found) throw notFound();
    return found;
  }

  /** The template, refused (409) when archived. */
  async #editable(templateId: string): Promise<NonNullable<Awaited<ReturnType<typeof getSiteTemplate>>>> {
    const found = await this.#load(templateId);
    if (found.template.archivedAt !== null) throw archived();
    return found;
  }
}
