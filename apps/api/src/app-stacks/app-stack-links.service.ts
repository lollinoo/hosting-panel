import { Inject, Injectable } from "@nestjs/common";
import {
  APP_AUDIT_ACTIONS,
  APP_AUDIT_TARGET_TYPES,
  APP_DATABASE_TEMPLATE_CATEGORY,
  ApprovedStackPlanSchema,
  MAX_APP_STACK_LINKS_PER_APPLICATION,
  MAX_APP_STACK_LINKS_PER_DATABASE,
  appStackLinkAlias,
  appStackLinkTarget,
  type AppStackLinkConnectionDto,
  type AppStackLinkDto,
  type AppStackLinksDto,
  type CreateAppStackLinkInput,
} from "@hosting-panel/contracts";
import {
  and,
  appStacks,
  appTemplates,
  asc,
  createAppStackLinkTransactional,
  eq,
  getAppStack,
  getAppStackRevision,
  getAppTemplateVersion,
  inArray,
  isNull,
  listAppStackLinks,
  markAppStackLinkRemoving,
  type AppStackRow,
  type DatabaseClient,
  type DatabaseExecutor,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { AppTemplateValidationOptions } from "@hosting-panel/policy-engine";
import { appNotFound, appRefusal, guardedApp } from "../app-templates/app-template-errors.js";
import { APP_TEMPLATE_VALIDATION_OPTIONS_TOKEN } from "../app-templates/app-template-validation-options.js";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";
import { validatedSpec } from "./app-stack-compile.js";
import { mapAppStackError } from "./app-stack-errors.js";
import { AppStackLinksApplier } from "./app-stack-links-applier.js";
import type { AppStackRequestContext } from "./app-stacks.service.js";

const damaged = (message: string) => new ControlPlaneError("INTERNAL_ERROR", message);
const refusal = (field: string, reason: string, message: string) => appRefusal("VALIDATION_ERROR", message, { field, message, reason });

/** Databases offered to an application at most. */
const CANDIDATES_MAX = 50;
/** A database in one of these cannot take a new link. */
const NOT_OFFERED = new Set<string>(["deleting", "delete_failed"]);

interface Described {
  readonly stack: AppStackRow;
  /** The name of its template. */
  readonly kind: string;
  readonly category: string;
}

/**
 * Private links between a database and an application of the same customer (ADR-0039): synchronous writes, no
 * operation. A link is a row; the applier brings the server to the rows, and a link it could not apply stays pending.
 * Nothing here carries a value of the database: the customer types the user name and the password into the application.
 */
@Injectable()
export class AppStackLinksService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(APP_TEMPLATE_VALIDATION_OPTIONS_TOKEN) private readonly validation: AppTemplateValidationOptions,
    @Inject(AppStackLinksApplier) private readonly applier: AppStackLinksApplier,
  ) {}

  /** A database lists the applications that use it; any other application lists the databases it uses. */
  public async list(stack: AppStackRow): Promise<AppStackLinksDto> {
    const db = this.dbClient.db;
    const all = await listAppStackLinks(db, { organizationId: stack.organizationId, stackId: stack.id });
    const described = await this.#describe(db, stack.organizationId, [stack.id, ...all.flatMap((row) => [row.consumerStackId, row.providerStackId])]);
    const self = described.get(stack.id);
    if (self === undefined) throw appNotFound();
    const isDatabase = self.category === APP_DATABASE_TEMPLATE_CATEGORY;
    const rows = all.filter((row) => (isDatabase ? row.providerStackId : row.consumerStackId) === stack.id);

    const connections = new Map<string, AppStackLinkConnectionDto | null>();
    const connectionOf = async (database: AppStackRow) => {
      if (!connections.has(database.id)) connections.set(database.id, await this.#connection(db, database));
      return connections.get(database.id) ?? null;
    };
    const links: AppStackLinkDto[] = [];
    for (const row of rows) {
      const database = described.get(row.providerStackId);
      const application = described.get(row.consumerStackId);
      // A side that is deleted: the applier takes the row away on its next pass.
      if (database === undefined || application === undefined) continue;
      links.push({
        id: row.id,
        state: row.state,
        createdAt: row.createdAt.toISOString(),
        databaseStackId: database.stack.id,
        databaseName: database.stack.name,
        databaseKind: database.kind,
        applicationStackId: application.stack.id,
        applicationName: application.stack.name,
        connection: await connectionOf(database.stack),
      });
    }
    return {
      stackId: stack.id,
      role: isDatabase ? "database" : "application",
      connection: isDatabase ? await connectionOf(stack) : null,
      links,
      candidates: isDatabase ? [] : await this.#candidates(db, stack, new Set(rows.map((row) => row.providerStackId))),
      limit: isDatabase ? MAX_APP_STACK_LINKS_PER_DATABASE : MAX_APP_STACK_LINKS_PER_APPLICATION,
    };
  }

  /** `stack` is the application. A database of another customer does not exist for this one (404). */
  public async create(ctx: AppStackRequestContext, stack: AppStackRow, input: CreateAppStackLinkInput): Promise<AppStackLinksDto> {
    const db = this.dbClient.db;
    const database = await getAppStack(db, { organizationId: stack.organizationId, stackId: input.databaseStackId });
    if (database === null) throw appNotFound();
    const described = await this.#describe(db, stack.organizationId, [stack.id, database.id]);
    if (described.get(stack.id)?.category === APP_DATABASE_TEMPLATE_CATEGORY) {
      throw refusal("stackId", "database_as_application", "A database cannot be connected to another database.");
    }
    if (described.get(database.id)?.category !== APP_DATABASE_TEMPLATE_CATEGORY) {
      throw refusal("databaseStackId", "not_a_database", "This application is not a database.");
    }
    if ((await this.#connection(db, database)) === null) {
      throw refusal("databaseStackId", "database_not_linkable", "This database cannot be connected to an application.");
    }
    await guardedApp(mapAppStackError, () =>
      db.transaction(async (tx) => {
        const t = tx as unknown as HostingPanelDatabase;
        const link = await createAppStackLinkTransactional(t, {
          organizationId: stack.organizationId,
          consumerStackId: stack.id,
          providerStackId: database.id,
          createdBy: ctx.userId,
        });
        await ctx.audit(t, {
          action: APP_AUDIT_ACTIONS.linkCreate,
          targetType: APP_AUDIT_TARGET_TYPES.link,
          targetId: link.id,
          details: { applicationStackId: stack.id, databaseStackId: database.id },
        });
      }),
    );
    await this.applier.apply(database.id);
    return this.list(stack);
  }

  /** `stack` is either side. The row stays, as `removing`, until the server confirms the database is detached. */
  public async remove(ctx: AppStackRequestContext, stack: AppStackRow, linkId: string): Promise<AppStackLinksDto> {
    const row = await guardedApp(mapAppStackError, () =>
      this.dbClient.db.transaction(async (tx) => {
        const t = tx as unknown as HostingPanelDatabase;
        const marked = await markAppStackLinkRemoving(t, { organizationId: stack.organizationId, stackId: stack.id, linkId });
        if (marked === null) throw appNotFound();
        await ctx.audit(t, {
          action: APP_AUDIT_ACTIONS.linkRemove,
          targetType: APP_AUDIT_TARGET_TYPES.link,
          targetId: marked.id,
          details: { applicationStackId: marked.consumerStackId, databaseStackId: marked.providerStackId },
        });
        return marked;
      }),
    );
    await this.applier.apply(row.providerStackId);
    return this.list(stack);
  }

  /** Live applications of the customer among `ids`, each with the name and the category of its template. */
  async #describe(db: DatabaseExecutor, organizationId: string, ids: readonly string[]): Promise<Map<string, Described>> {
    const rows = await db
      .select({ stack: appStacks, kind: appTemplates.name, category: appTemplates.category })
      .from(appStacks)
      .innerJoin(appTemplates, eq(appTemplates.id, appStacks.templateId))
      .where(and(eq(appStacks.organizationId, organizationId), isNull(appStacks.deletedAt), inArray(appStacks.id, [...new Set(ids)])));
    return new Map(rows.map((row) => [row.stack.id, row]));
  }

  /** The customer's databases the application is not connected to yet, by name. */
  async #candidates(db: DatabaseExecutor, stack: AppStackRow, linked: ReadonlySet<string>): Promise<AppStackLinksDto["candidates"]> {
    const rows = await db
      .select({ stack: appStacks, kind: appTemplates.name })
      .from(appStacks)
      .innerJoin(appTemplates, eq(appTemplates.id, appStacks.templateId))
      .where(
        and(
          eq(appStacks.organizationId, stack.organizationId),
          isNull(appStacks.deletedAt),
          eq(appTemplates.category, APP_DATABASE_TEMPLATE_CATEGORY),
        ),
      )
      .orderBy(asc(appStacks.name), asc(appStacks.id))
      .limit(CANDIDATES_MAX);
    const candidates: AppStackLinksDto["candidates"] = [];
    for (const row of rows) {
      if (linked.has(row.stack.id) || NOT_OFFERED.has(row.stack.status)) continue;
      if ((await this.#connection(db, row.stack)) === null) continue;
      candidates.push({ stackId: row.stack.id, name: row.stack.name, kind: row.kind });
    }
    return candidates;
  }

  /** Where a linked application reaches this database; null when it is not something to link to. */
  async #connection(db: DatabaseExecutor, database: AppStackRow): Promise<AppStackLinkConnectionDto | null> {
    const host = appStackLinkAlias(database.id);
    if (host === null) return null;
    try {
      const target = appStackLinkTarget(await this.#components(db, database));
      return target === null ? null : { host, port: target.port };
    } catch {
      return null;
    }
  }

  /** The desired version's components; for an application never installed, the services of its template version. */
  async #components(db: DatabaseExecutor, stack: AppStackRow): Promise<readonly { key: string; expose: readonly number[] }[]> {
    if (stack.desiredRevisionId !== null) {
      const revision = await getAppStackRevision(db, {
        organizationId: stack.organizationId,
        stackId: stack.id,
        revisionId: stack.desiredRevisionId,
      });
      const plan = ApprovedStackPlanSchema.safeParse(revision?.plan);
      if (!plan.success) throw damaged("The stored revision is damaged.");
      return plan.data.components;
    }
    const version = await getAppTemplateVersion(db, { templateId: stack.templateId, versionId: stack.templateVersionId });
    if (version === null) throw damaged("The stored application is damaged.");
    return validatedSpec(version.source, this.validation).services;
  }
}
