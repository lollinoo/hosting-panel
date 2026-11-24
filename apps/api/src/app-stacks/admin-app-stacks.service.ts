import { Inject, Injectable } from "@nestjs/common";
import { APP_STACK_ID_PATTERN, type AdminAppStackDto, type AppStackComponentLogsDto } from "@hosting-panel/contracts";
import { and, appStacks, eq, isNull, organizations, type AppStackRow, type DatabaseClient } from "@hosting-panel/database";
import { appNotFound } from "../app-templates/app-template-errors.js";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";
import { AppStacksService } from "./app-stacks.service.js";

/**
 * The server administrator's view of one customer's application (ADR-0041): its page and the logs of a component.
 * Both are read by the customer's own code, so the administrator sees what the customer sees: the same components
 * in the same order, the same effective health, the same log lines with the same secrets masked.
 */
@Injectable()
export class AdminAppStacksService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(AppStacksService) private readonly stacks: AppStacksService,
  ) {}

  /** Any customer's live application by its id; an unknown or deleted one is 404. */
  public async require(stackId: string): Promise<{ readonly stack: AppStackRow; readonly organizationName: string }> {
    if (!APP_STACK_ID_PATTERN.test(stackId)) throw appNotFound();
    const [row] = await this.dbClient.db
      .select({ stack: appStacks, organizationName: organizations.name })
      .from(appStacks)
      .innerJoin(organizations, eq(organizations.id, appStacks.organizationId))
      .where(and(eq(appStacks.id, stackId), isNull(appStacks.deletedAt)))
      .limit(1);
    if (!row) throw appNotFound();
    return row;
  }

  /** The page of one application: who it belongs to and its components; no parameter, secret, volume or plan. */
  public async detail(stackId: string): Promise<AdminAppStackDto> {
    const { stack, organizationName } = await this.require(stackId);
    const detail = await this.stacks.detail(stack);
    return {
      id: detail.id,
      name: detail.name,
      organizationId: stack.organizationId,
      organizationName,
      templateId: detail.templateId,
      templateName: detail.templateName,
      versionNumber: detail.templateVersionNumber,
      status: detail.status,
      primaryHostname: detail.primaryHostname,
      components: detail.components.map((c) => ({ key: c.key, health: c.health })),
    };
  }

  /** The last lines of one component, masked; also returns the customer the application belongs to, for the audit row. */
  public async logs(
    stackId: string,
    componentKey: string,
    tail: number,
  ): Promise<{ readonly organizationId: string; readonly logs: AppStackComponentLogsDto }> {
    const { stack } = await this.require(stackId);
    return { organizationId: stack.organizationId, logs: await this.stacks.logs(stack, componentKey, tail) };
  }
}
