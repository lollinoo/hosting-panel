import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  APP_AUDIT_ACTIONS,
  ApprovedStackPlanSchema,
  type AppStackDomainDto,
  type AppStackDomainEntry,
  type AppStackDomainPathRoute,
  type UpdateAppStackDomainInput,
} from "@hosting-panel/contracts";
import {
  addAppStackDomainsTransactional,
  getAppStack,
  getAppStackRevision,
  getAppTemplateVersion,
  listAppStackDomains,
  removeAppStackDomainTransactional,
  updateAppStackDomainRoutingTransactional,
  updateAppStackDomainState,
  type AppStackDomainRow,
  type AppStackRow,
  type DatabaseClient,
  type DatabaseExecutor,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { AppTemplateValidationOptions } from "@hosting-panel/policy-engine";
import { appNotFound, appRefusal, guardedApp } from "../app-templates/app-template-errors.js";
import { APP_TEMPLATE_VALIDATION_OPTIONS_TOKEN } from "../app-templates/app-template-validation-options.js";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { MANUAL_CHECK_MIN_INTERVAL_MS } from "../sites/domain-policy.js";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";
import { validatedSpec } from "./app-stack-compile.js";
import { appStackDomainDto } from "./app-stack-dto.js";
import { mapAppStackError } from "./app-stack-errors.js";
import { AppStackObserverService } from "./app-stack-observer.service.js";
import { apr1Verifier } from "./apr1.js";
import type { AppStackRequestContext } from "./app-stacks.service.js";

const damaged = (message: string) => new ControlPlaneError("INTERNAL_ERROR", message);

/** No address is added or changed on an application that is being removed. */
function assertNotLeaving(stack: AppStackRow): void {
  if (stack.status === "deleting" || stack.status === "delete_failed") {
    const message = `This action is not possible while the application is ${stack.status}.`;
    throw appRefusal("RESOURCE_LOCKED", message, { field: "status", message, reason: stack.status }, false);
  }
}

/**
 * Web addresses of a stack (ADR-0035, ACME only): synchronous writes, no operation. A hostname held by a site, the
 * panel or another stack is DOMAIN_CONFLICT whoever holds it; the observer checks DNS and publishes the routes.
 */
@Injectable()
export class AppStackDomainsService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(APP_TEMPLATE_VALIDATION_OPTIONS_TOKEN) private readonly validation: AppTemplateValidationOptions,
    @Optional() @Inject(AppStackObserverService) private readonly observer: AppStackObserverService | null = null,
  ) {}

  public async list(stack: AppStackRow): Promise<AppStackDomainDto[]> {
    return (await this.#rows(stack)).map(appStackDomainDto);
  }

  /** A hostname already on this stack inserts nothing and audits nothing. */
  public async add(ctx: AppStackRequestContext, stack: AppStackRow, input: AppStackDomainEntry): Promise<AppStackDomainDto[]> {
    assertNotLeaving(stack);
    await this.#assertTarget(this.dbClient.db, stack, input);
    const inserted = await guardedApp(mapAppStackError, () =>
      this.dbClient.db.transaction(async (tx) => {
        const t = tx as unknown as HostingPanelDatabase;
        const rows = await addAppStackDomainsTransactional(t, {
          organizationId: ctx.organizationId,
          stackId: stack.id,
          entries: [{ hostname: input.hostname, componentKey: input.componentKey, internalPort: input.port }],
        });
        // The stack row is locked now: an upgrade or rollback committed since the first check is the plan to match.
        await this.#assertTarget(t, (await getAppStack(t, { organizationId: ctx.organizationId, stackId: stack.id })) ?? stack, input);
        for (const row of rows) {
          await ctx.audit(t, {
            action: APP_AUDIT_ACTIONS.domainAssign,
            targetType: "app_stack",
            targetId: stack.id,
            details: { domainId: row.id, hostname: row.hostname, componentKey: row.componentKey, internalPort: row.internalPort },
          });
        }
        return rows;
      }),
    );
    if (inserted.length > 0) await this.#reconcile(stack, inserted.map((row) => row.id));
    return this.list(stack);
  }

  /**
   * Routing options of one address (ADR-0037); the four are sent together, so an option left out of the form is cleared.
   * The password stops here: only its verifier is stored, and neither is audited. The observer rewrites the route.
   */
  public async update(
    ctx: AppStackRequestContext,
    stack: AppStackRow,
    domainId: string,
    input: UpdateAppStackDomainInput,
  ): Promise<AppStackDomainDto[]> {
    assertNotLeaving(stack);
    await this.#assertPathTargets(this.dbClient.db, stack, input.pathRoutes);
    const password = input.protection?.password;
    const protection =
      input.protection === null
        ? null
        : { username: input.protection.username, ...(password === undefined ? {} : { passwordHash: apr1Verifier(password) }) };
    await guardedApp(mapAppStackError, () =>
      this.dbClient.db.transaction(async (tx) => {
        const t = tx as unknown as HostingPanelDatabase;
        const { after } = await updateAppStackDomainRoutingTransactional(t, {
          organizationId: ctx.organizationId,
          stackId: stack.id,
          domainId,
          routing: { redirectToDomainId: input.redirectToDomainId, compression: input.compression, protection, pathRoutes: input.pathRoutes },
        });
        // The stack row is locked now: an upgrade or rollback committed since the first check is the plan to match.
        const locked = (await getAppStack(t, { organizationId: ctx.organizationId, stackId: stack.id })) ?? stack;
        await this.#assertPathTargets(t, locked, input.pathRoutes);
        await ctx.audit(t, {
          action: APP_AUDIT_ACTIONS.domainUpdate,
          targetType: "app_stack",
          targetId: stack.id,
          details: {
            domainId,
            hostname: after.hostname,
            redirectToDomainId: after.redirectToDomainId,
            compression: after.compression,
            protectedAs: after.accessUsername,
            passwordSet: password !== undefined,
            pathRoutes: after.pathRoutes,
          },
        });
      }),
    );
    await this.#reconcile(stack);
    return this.list(stack);
  }

  /** The observer withdraws the route. */
  public async remove(ctx: AppStackRequestContext, stack: AppStackRow, domainId: string): Promise<AppStackDomainDto[]> {
    const row = await this.#row(stack, domainId);
    await this.dbClient.db.transaction(async (tx) => {
      const t = tx as unknown as HostingPanelDatabase;
      if (!(await removeAppStackDomainTransactional(t, { organizationId: ctx.organizationId, stackId: stack.id, domainId }))) {
        throw appNotFound();
      }
      await ctx.audit(t, {
        action: APP_AUDIT_ACTIONS.domainRemove,
        targetType: "app_stack",
        targetId: stack.id,
        details: { domainId, hostname: row.hostname },
      });
    });
    await this.#reconcile(stack);
    return this.list(stack);
  }

  /** Looks this one address up now, at most every 10 seconds; not audited. */
  public async check(stack: AppStackRow, domainId: string, now = new Date()): Promise<AppStackDomainDto[]> {
    const row = await this.#row(stack, domainId);
    if (row.dnsCheckedAt === null || now.getTime() - row.dnsCheckedAt.getTime() >= MANUAL_CHECK_MIN_INTERVAL_MS) {
      await updateAppStackDomainState(this.dbClient.db, { domainId, set: { dnsNextCheckAt: now, dnsAttempts: 0 } });
      await this.#reconcile(stack, [domainId]);
    }
    return this.list(stack);
  }

  /** The pair must be an ingress of the desired plan, or of the template for a draft. */
  async #assertTarget(db: DatabaseExecutor, stack: AppStackRow, input: AppStackDomainEntry): Promise<void> {
    if (!(await this.#targets(db, stack)).some((t) => t.componentKey === input.componentKey && t.port === input.port)) {
      const message = "This web address cannot point at that part of the application.";
      throw appRefusal("VALIDATION_ERROR", message, { field: "componentKey", message, reason: "unknown_ingress" });
    }
  }

  /** A path sends its requests to an ingress of the same plan the addresses point at. */
  async #assertPathTargets(db: DatabaseExecutor, stack: AppStackRow, paths: readonly AppStackDomainPathRoute[]): Promise<void> {
    if (paths.length === 0) return;
    const targets = await this.#targets(db, stack);
    paths.forEach((path, i) => {
      if (!targets.some((t) => t.componentKey === path.componentKey && t.port === path.port)) {
        const message = "This path cannot point at that part of the application.";
        throw appRefusal("VALIDATION_ERROR", message, { field: `pathRoutes.${String(i)}.componentKey`, message, reason: "unknown_ingress" });
      }
    });
  }

  async #targets(db: DatabaseExecutor, stack: AppStackRow): Promise<readonly { componentKey: string; port: number }[]> {
    if (stack.desiredRevisionId !== null) {
      const revision = await getAppStackRevision(db, {
        organizationId: stack.organizationId,
        stackId: stack.id,
        revisionId: stack.desiredRevisionId,
      });
      const plan = revision ? ApprovedStackPlanSchema.safeParse(revision.plan) : null;
      if (!plan?.success) throw damaged("The stored revision is damaged.");
      return plan.data.ingress;
    }
    const version = await getAppTemplateVersion(db, { templateId: stack.templateId, versionId: stack.templateVersionId });
    if (!version) throw damaged("The stored application is damaged.");
    return validatedSpec(version.source, this.validation).ingress.map((route) => ({ componentKey: route.service, port: route.port }));
  }

  #rows(stack: AppStackRow): Promise<AppStackDomainRow[]> {
    return listAppStackDomains(this.dbClient.db, { organizationId: stack.organizationId, stackId: stack.id });
  }

  async #row(stack: AppStackRow, domainId: string): Promise<AppStackDomainRow> {
    const row = (await this.#rows(stack)).find((d) => d.id === domainId);
    if (!row) throw appNotFound();
    return row;
  }

  /** Best effort: the change is committed and the observer's loop retries. */
  async #reconcile(stack: AppStackRow, forceDnsIds: readonly string[] = []): Promise<void> {
    await this.observer?.reconcileStack(stack.organizationId, stack.id, new Date(), { forceDnsIds }).catch(() => undefined);
  }
}
