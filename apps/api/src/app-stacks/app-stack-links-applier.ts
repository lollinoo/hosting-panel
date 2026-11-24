import { Inject, Injectable } from "@nestjs/common";
import { APP_DATABASE_TEMPLATE_CATEGORY, ApprovedStackPlanSchema, type AppStackLinksIpcResult } from "@hosting-panel/contracts";
import {
  and,
  appStacks,
  appTemplates,
  eq,
  getAppStackRevision,
  isNull,
  listAppStackLinkProviderIds,
  listAppStackLinkProvidersDue,
  listAppStackLinksOfProvider,
  releaseAppStackLinksOfDeletedApplications,
  settleAppStackLinks,
  unsettleAppStackLinks,
  type AppStackRow,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import { isStackExecutor, type DockerExecutorPort, type StackExecutorPort } from "@hosting-panel/executor-contracts";
import { CONTROL_PLANE_CONFIG_TOKEN, DATABASE_CLIENT_TOKEN, DOCKER_EXECUTOR_TOKEN, type ControlPlaneRuntimeConfig } from "../tokens.js";

// Brings the server to the recorded links of a database (ADR-0039): one idempotent executor call that carries the whole
// list of applications. Best effort by design: nothing here throws; a link that could not be applied stays `pending`
// and the observer asks again. It never starts, stops or recreates anything.

/** Databases the observer retries in one pass. */
export const APP_STACK_LINK_RETRY_BATCH = 20;
/** The observer's pass asks for no further database after this long (a call already started runs to its end). */
export const APP_STACK_LINK_RETRY_BUDGET_MS = 45_000;

/** What the executor call needs of a plan: the only component's key. */
export type AppStackLinkComponents = readonly { readonly key: string }[];

interface RolloutPass {
  /** The components of the plan the rollout is applying: the container on the server belongs to it. */
  readonly components: AppStackLinkComponents;
  /** Ask the server even with no link recorded, so that a leftover attachment is taken off before the start. */
  readonly always: boolean;
}

@Injectable()
export class AppStackLinksApplier {
  readonly #db: HostingPanelDatabase;
  /** One pass at a time for each database. Each pass reads the rows itself, so the last one sees the last change. */
  readonly #passes = new Map<string, Promise<void>>();

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly executor: DockerExecutorPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
  ) {
    this.#db = dbClient.db;
  }

  /** Applies the links of one database and records what the server answered. Never throws. */
  public apply(providerStackId: string, rollout?: RolloutPass): Promise<void> {
    const pass = (this.#passes.get(providerStackId) ?? Promise.resolve())
      .then(() => this.#pass(providerStackId, rollout))
      .catch(() => undefined);
    this.#passes.set(providerStackId, pass);
    void pass.then(() => {
      if (this.#passes.get(providerStackId) === pass) this.#passes.delete(providerStackId);
    });
    return pass;
  }

  /**
   * Before the components of a rollout start: the databases this application uses are attached to its private network,
   * and a database gets its own list applied. For a database the server is always asked, so that an attachment to a
   * network that no longer exists is taken off before the start it would fail. Never throws.
   */
  public async rollout(stack: Pick<AppStackRow, "id" | "templateId">, components: AppStackLinkComponents): Promise<void> {
    try {
      for (const providerStackId of await listAppStackLinkProviderIds(this.#db, stack.id)) await this.apply(providerStackId);
      const [template] = await this.#db.select({ category: appTemplates.category }).from(appTemplates).where(eq(appTemplates.id, stack.templateId));
      const always = template?.category === APP_DATABASE_TEMPLATE_CATEGORY;
      if (always || (await listAppStackLinksOfProvider(this.#db, stack.id)).length > 0) await this.apply(stack.id, { components, always });
    } catch {
      // Best effort: a link never fails a rollout.
    }
  }

  /**
   * The observer's pass: databases with a link still to attach or to detach, the one that waited longest first, within
   * APP_STACK_LINK_RETRY_BUDGET_MS. A database this pass reached has its rows touched (settle or unsettle, also when its
   * version cannot be asked for), so it moves behind every one this pass did not reach, and the next pass begins with
   * those. Never throws.
   */
  public async retry(): Promise<void> {
    try {
      const due = await listAppStackLinkProvidersDue(this.#db, { limit: APP_STACK_LINK_RETRY_BATCH });
      const passStart = Date.now();
      for (const { stackId } of due) {
        if (Date.now() - passStart >= APP_STACK_LINK_RETRY_BUDGET_MS) break;
        await this.apply(stackId);
      }
    } catch {
      // Best effort: the next pass asks again.
    }
  }

  #port(): StackExecutorPort | null {
    const { executor } = this;
    return isStackExecutor(executor) && executor.isRuntimeAvailable && this.config.runtimeBackend !== "disabled" ? executor : null;
  }

  async #pass(providerStackId: string, rollout: RolloutPass | undefined): Promise<void> {
    const db = this.#db;
    const [provider] = await db
      .select()
      .from(appStacks)
      .where(and(eq(appStacks.id, providerStackId), isNull(appStacks.deletedAt)));
    if (provider === undefined) return;
    await releaseAppStackLinksOfDeletedApplications(db, providerStackId);
    const rows = await listAppStackLinksOfProvider(db, providerStackId);
    if (rows.length === 0 && rollout?.always !== true) return;
    const removed = rows.filter((row) => row.state === "removing").map((row) => row.id);
    const wanted = rows.filter((row) => row.state !== "removing");
    const settle = (active: readonly string[]) =>
      settleAppStackLinks(db, {
        providerStackId,
        active,
        pending: wanted.map((row) => row.id).filter((id) => !active.includes(id)),
        removed,
      });

    // The container on the server belongs to the applied version; a version that was never applied has the desired one.
    const revisionId = provider.appliedRevisionId ?? provider.desiredRevisionId;
    // Never installed: nothing of it is on the server, so there is nothing to detach and nothing to attach.
    if (rollout === undefined && revisionId === null) return settle([]);
    const components = rollout?.components ?? (await this.#components(provider, revisionId));
    const [only, ...others] = components ?? [];
    const port = this.#port();
    // No server to ask: the rows stay as they are.
    if (port === null) return;
    // More than one component, or a stored version that cannot be read: the server cannot be asked. As when it does not
    // answer, nothing is known, and the touch moves the database behind the others in the retry order.
    if (only === undefined || others.length > 0) return unsettleAppStackLinks(db, providerStackId);

    let result: AppStackLinksIpcResult;
    try {
      result = await port.syncAppStackLinks({
        stackId: provider.id,
        organizationId: provider.organizationId,
        componentKey: only.key,
        consumerStackIds: wanted.map((row) => row.consumerStackId),
      });
    } catch {
      // Refused (a change of the database is running) or no answer: nothing is known about the server.
      await unsettleAppStackLinks(db, providerStackId);
      return;
    }
    const attached = new Set(result.links.filter((link) => link.outcome !== "pending").map((link) => link.consumerStackId));
    await settle(result.container ? wanted.filter((row) => attached.has(row.consumerStackId)).map((row) => row.id) : []);
  }

  async #components(provider: AppStackRow, revisionId: string | null): Promise<AppStackLinkComponents | null> {
    if (revisionId === null) return null;
    const revision = await getAppStackRevision(this.#db, { organizationId: provider.organizationId, stackId: provider.id, revisionId });
    const plan = ApprovedStackPlanSchema.safeParse(revision?.plan);
    return plan.success ? plan.data.components : null;
  }
}
