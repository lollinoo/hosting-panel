import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  APP_IMAGE_ALLOWLIST,
  AppStackOperationPayloadSchema,
  ApprovedStackPlanSchema,
  appStackComponentSecretRefs,
  appStackPlanEnvironmentSecretRefs,
  appStackPlanImageProblems,
  appStackPlanSecretRefs,
  type AppStackComponentHealth,
  type AppStackStatus,
  type AppStackStepKey,
  type ApprovedStackPlan,
} from "@hosting-panel/contracts";
import {
  and,
  AppStackSecretError,
  appStackDeployments,
  eq,
  getAppStack,
  getAppStackRevision,
  listAppStackDomains,
  listAppStackVolumes,
  readAppStackSecretFiles,
  recordAppStackComponentHealthTransactional,
  renewOperationLease,
  setAppStackVolumeStatusTransactional,
  transitionAppStackTransactional,
  updateAppStackDeploymentTransactional,
  updateAppStackDomainState,
  updateOperationStepTransactional,
  type AppStackRow,
  type DatabaseClient,
  type HostingPanelDatabase,
  type operations,
} from "@hosting-panel/database";
import { isStackExecutor, type DockerExecutorPort, type StackExecutorPort } from "@hosting-panel/executor-contracts";
import { computeAppStackComponentHash, verifyAppStackPlanHash } from "@hosting-panel/hosting-domain";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { isAmbiguousFailure } from "../runtime/site-provisioner.js";
import { CONTROL_PLANE_CONFIG_TOKEN, DATABASE_CLIENT_TOKEN, DOCKER_EXECUTOR_TOKEN, type ControlPlaneRuntimeConfig } from "../tokens.js";
import { AppStackLinksApplier } from "./app-stack-links-applier.js";
import { recoverAppStackOperation } from "./app-stack-recovery.js";
import {
  APP_STACK_FAILURE,
  APP_STACK_HEALTH_BUDGET_MS,
  APP_STACK_HEALTH_POLL_MS,
  APP_STACK_NO_ADDRESS_TEXT,
  APP_STACK_START_INCOMPLETE_TEXT,
  APP_STACK_STEP_DONE_TEXT,
  APP_STACK_STEP_LEASE_MS,
  APP_STACK_STEP_NOT_NEEDED_TEXT,
  APP_STACK_STEP_RUNNING_TEXT,
  APP_STACK_UNCERTAIN_TEXT,
  appStackAddressesHash,
  appStackAggregate,
  appStackComponentReady,
  appStackEssentialKeys,
  appStackHealthRows,
  appStackObservedComponent,
  appStackProblemOf,
  appStackReplacedComponents,
  appStackRestartSet,
  appStackRoutePlan,
  appStackRoutesHash,
  appStackRoutesRefresh,
  type AppStackRuntimeProblem,
  type ObservedAppStack,
} from "./app-stack-runtime-policy.js";
import { parkAppStackOperationUnknown, settleAppStackOperation, type AppStackSettlement } from "./app-stack-settle.js";

// Worker side of the seven stack kinds (ADR-0035): each step is one short idempotent executor call, readiness is polled
// with GET reads under a renewed lease, secrets are decrypted just before each start call and handed only to it.
// A definite failure settles the operation in one transaction; an ambiguous one parks it unknown with its lock.

type OperationRow = typeof operations.$inferSelect;
type HealthRows = { componentKey: string; health: AppStackComponentHealth }[];
type DomainRows = Awaited<ReturnType<typeof listAppStackDomains>>;
const ROUTES_NOT_NEEDED: readonly AppStackStepKey[] = ["reserve", "pull", "prepare", "create", "start", "health"];

export const APP_STACK_RUNTIME_CLOCK = Symbol.for("hosting-panel.api.appStackRuntimeClock");
export interface AppStackRuntimeClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const SYSTEM_APP_STACK_CLOCK: AppStackRuntimeClock = Object.freeze({
  now: () => Date.now(),
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms).unref();
    }),
});
export interface AppStackRuntimeDeps {
  readonly db: HostingPanelDatabase;
  readonly executor: DockerExecutorPort;
  readonly config: ControlPlaneRuntimeConfig;
  readonly clock: AppStackRuntimeClock;
}

/** The stack port when usable: isStackExecutor(executor) && executor.isRuntimeAvailable && config.runtimeBackend !== "disabled". */
export function appStackPort(deps: AppStackRuntimeDeps): StackExecutorPort | null {
  const { executor } = deps;
  return isStackExecutor(executor) && executor.isRuntimeAvailable && deps.config.runtimeBackend !== "disabled" ? executor : null;
}

/** A refusal of the handler itself (plan invalid, secret missing, runtime unavailable, health timeout). */
class AppStackStepRefusal extends Error {
  public constructor(public readonly problem: AppStackRuntimeProblem) {
    super(problem);
  }
}

interface StackContext {
  readonly op: OperationRow;
  readonly ref: { readonly stackId: string; readonly organizationId: string };
  readonly deploymentId: string;
  readonly revisionId: string | null;
  readonly port: StackExecutorPort | null;
  current: AppStackStepKey;
  /** Rows of the latest readiness poll. */
  lastHealth?: HealthRows;
}

/** What a failing deploy/start needs to settle, filled as the steps go. */
interface RolloutState {
  stack: AppStackRow | null;
  plan: ApprovedStackPlan | null;
  previous: ApprovedStackPlan | null;
  /** Components the create step created or replaced; null until it succeeded. */
  created: readonly string[] | null;
}

const healthMap = (rows: HealthRows) => new Map(rows.map((h) => [h.componentKey, h.health]));

@Injectable()
export class AppStackRuntime {
  readonly #deps: AppStackRuntimeDeps;
  readonly #links: AppStackLinksApplier;

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) executor: DockerExecutorPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) config: ControlPlaneRuntimeConfig,
    @Optional() @Inject(APP_STACK_RUNTIME_CLOCK) clock?: AppStackRuntimeClock,
    @Optional() @Inject(AppStackLinksApplier) links?: AppStackLinksApplier,
  ) {
    this.#deps = { db: dbClient.db, executor, config, clock: clock ?? SYSTEM_APP_STACK_CLOCK };
    this.#links = links ?? new AppStackLinksApplier(dbClient, executor, config);
  }

  /** Worker dispatch for every APP_STACK_OPERATION_KINDS kind. Throws to fail. */
  public async apply(op: OperationRow, payload: Readonly<Record<string, unknown>>): Promise<void> {
    const parsed = AppStackOperationPayloadSchema.safeParse(payload);
    if (!parsed.success || parsed.data.stackId !== op.resourceId) {
      const failure = APP_STACK_FAILURE.STACK_TEMPLATE_INVALID;
      const { db } = this.#deps;
      // The deployment is found from the operation, as recovery does, so it is closed too.
      await db
        .select({ id: appStackDeployments.id })
        .from(appStackDeployments)
        .where(and(eq(appStackDeployments.operationId, op.id), eq(appStackDeployments.organizationId, op.organizationId)))
        .then(([deployment]) =>
          settleAppStackOperation(db, op, deployment?.id ?? null, {
            outcome: "failed",
            problem: "STACK_TEMPLATE_INVALID",
            stackStatus: op.kind === "stack.delete" ? "delete_failed" : "failed",
            failedStep: "validate",
          }),
        )
        .catch(() => undefined);
      throw new ControlPlaneError(failure.code, failure.text);
    }
    const ctx: StackContext = {
      op,
      ref: { stackId: op.resourceId, organizationId: op.organizationId },
      deploymentId: parsed.data.deploymentId,
      revisionId: parsed.data.revisionId,
      port: appStackPort(this.#deps),
      current: "validate",
    };
    switch (op.kind) {
      case "stack.deploy":
        if (appStackRoutesRefresh(op)) return this.#routes(ctx);
        return this.#rollout(ctx, null);
      case "stack.upgrade":
      case "stack.rollback":
        return this.#rollout(ctx, null);
      case "stack.start":
        return this.#rollout(ctx, false);
      case "stack.restart":
        return this.#rollout(ctx, true);
      case "stack.stop":
        return this.#stop(ctx);
      case "stack.delete":
        return this.#delete(ctx);
      default:
        throw new ControlPlaneError("NOT_SUPPORTED", "This action is not available.");
    }
  }

  /** Worker recovery for an `unknown` stack operation; read-only. */
  public recover(op: OperationRow): Promise<"pending" | "settled"> {
    return recoverAppStackOperation(this.#deps, op);
  }

  #now(): Date {
    return new Date(this.#deps.clock.now());
  }

  #renew(ctx: StackContext): Promise<void> {
    return renewOperationLease(this.#deps.db, ctx.op.id, APP_STACK_STEP_LEASE_MS);
  }

  async #step<T>(
    ctx: StackContext,
    key: AppStackStepKey,
    work: () => Promise<T>,
    doneText: string | ((result: T) => string) = APP_STACK_STEP_DONE_TEXT[key],
  ): Promise<T> {
    ctx.current = key;
    await this.#renew(ctx);
    await updateOperationStepTransactional(this.#deps.db, ctx.op.id, key, "running", APP_STACK_STEP_RUNNING_TEXT);
    const result = await work();
    await updateOperationStepTransactional(this.#deps.db, ctx.op.id, key, "succeeded", typeof doneText === "function" ? doneText(result) : doneText);
    return result;
  }

  /** One GET under a renewed lease; any error is null. */
  async #status(ctx: StackContext): Promise<ObservedAppStack | null> {
    if (!ctx.port) return null;
    try {
      await this.#renew(ctx);
      return await ctx.port.getAppStackStatus(ctx.ref);
    } catch {
      return null;
    }
  }

  /** A readiness poll: one status read whose component health is recorded. A failed read is null. */
  async #poll(ctx: StackContext, plan: ApprovedStackPlan, phase: "waiting" | "final"): Promise<ObservedAppStack | null> {
    const observed = await this.#status(ctx);
    if (!observed) return null;
    ctx.lastHealth = appStackHealthRows(plan, observed, phase);
    await recordAppStackComponentHealthTransactional(this.#deps.db, { ...ctx.ref, observedAt: this.#now(), components: ctx.lastHealth });
    return observed;
  }

  /** The certificate report is a POST that only reads: its failure is never in doubt. */
  async #acmeEnabled(): Promise<boolean> {
    try {
      const since = new Date(this.#deps.clock.now() - 10 * 60_000).toISOString();
      return (await this.#deps.executor.getCertificateStatus({ failuresSince: since })).acmeEnabled;
    } catch {
      throw new ControlPlaneError("DOCKER_ENGINE_UNAVAILABLE", APP_STACK_FAILURE.DOCKER_ENGINE_UNAVAILABLE.text);
    }
  }

  async #guard(ctx: StackContext, body: () => Promise<void>, onDefinite: (problem: AppStackRuntimeProblem) => Promise<unknown>): Promise<void> {
    try {
      await body();
    } catch (err) {
      if (!isAmbiguousFailure(err)) {
        const problem = err instanceof AppStackStepRefusal ? err.problem : appStackProblemOf(err);
        const cleanupError = await onDefinite(problem).then(
          () => null,
          (e: unknown) => e,
        );
        if (!isAmbiguousFailure(cleanupError)) throw new ControlPlaneError(APP_STACK_FAILURE[problem].code, APP_STACK_FAILURE[problem].text);
      }
      await parkAppStackOperationUnknown(this.#deps.db, ctx.op, ctx.deploymentId);
      throw new ControlPlaneError("OPERATION_AMBIGUOUS", APP_STACK_UNCERTAIN_TEXT);
    }
  }

  /** The live stack; the deployment moves to running (a first deploy also moves the stack queued → deploying). */
  async #begin(ctx: StackContext, deploy: boolean): Promise<AppStackRow> {
    const stack = await getAppStack(this.#deps.db, ctx.ref);
    if (!stack) throw new AppStackStepRefusal("STACK_TEMPLATE_INVALID");
    await this.#deps.db.transaction(async (tx) => {
      if (deploy && stack.status === "queued") await transitionAppStackTransactional(tx, { ...ctx.ref, to: "deploying" });
      await updateAppStackDeploymentTransactional(tx, {
        ...ctx.ref,
        deploymentId: ctx.deploymentId,
        deploymentStatus: "running",
        problem: null,
        stackStatus: null,
      });
    });
    return stack;
  }

  /** The revision's plan when it parses and names this stack, this revision and its own hash; else null. */
  async #planOf(ctx: StackContext, revisionId: string | null): Promise<ApprovedStackPlan | null> {
    if (revisionId === null) return null;
    const revision = await getAppStackRevision(this.#deps.db, { ...ctx.ref, revisionId });
    const parsed = ApprovedStackPlanSchema.safeParse(revision?.plan);
    if (!revision || !parsed.success) return null;
    const plan = parsed.data;
    const own =
      plan.stackId === ctx.ref.stackId &&
      plan.organizationId === ctx.ref.organizationId &&
      plan.revisionId === revision.id &&
      plan.planHash === revision.planHash &&
      verifyAppStackPlanHash(plan);
    return own ? plan : null;
  }

  /** The pinned (parameterKey, version) pairs of the plan, decrypted: the ones delivered as files and, in a version 2
   *  plan, the ones the executor writes into a component's environment (ADR-0036). */
  async #secretFiles(ctx: StackContext, plan: ApprovedStackPlan) {
    try {
      return await readAppStackSecretFiles(this.#deps.db, {
        ...ctx.ref,
        masterKey: this.#deps.config.secretsMasterKey,
        refs: appStackPlanSecretRefs(plan),
      });
    } catch (err) {
      if (err instanceof AppStackSecretError && err.code === "SECRET_MISSING") throw new AppStackStepRefusal("STACK_SECRET_MISSING");
      throw err;
    }
  }

  async #validate(ctx: StackContext, st: RolloutState, deploy: boolean): Promise<void> {
    st.stack = await this.#begin(ctx, deploy);
    if (deploy) st.previous = await this.#planOf(ctx, st.stack.appliedRevisionId);
    st.plan = await this.#planOf(
      ctx,
      deploy ? (ctx.revisionId ?? st.stack.desiredRevisionId) : (st.stack.appliedRevisionId ?? st.stack.desiredRevisionId),
    );
    if (!st.plan) throw new AppStackStepRefusal("STACK_TEMPLATE_INVALID");
    if (appStackPlanImageProblems(st.plan, APP_IMAGE_ALLOWLIST).length > 0) throw new AppStackStepRefusal("STACK_IMAGE_NOT_ALLOWED");
    if (!ctx.port) throw new AppStackStepRefusal("STACK_UNSUPPORTED_FEATURE");
    await this.#secretFiles(ctx, st.plan);
  }

  /** stack.deploy|upgrade|rollback (restart null), stack.start (false), stack.restart (true). */
  async #rollout(ctx: StackContext, restart: boolean | null): Promise<void> {
    const { db, clock } = this.#deps;
    const deploy = restart === null;
    const st: RolloutState = { stack: null, plan: null, previous: null, created: null };
    const body = async () => {
      await this.#step(ctx, "validate", () => this.#validate(ctx, st, deploy));
      const stack = st.stack!;
      const plan = st.plan!;
      const port = ctx.port!;
      if (deploy) {
        await this.#step(ctx, "reserve", async () => undefined);
        await this.#step(ctx, "pull", async () => {
          for (const image of new Set(plan.components.map((c) => c.image))) {
            await this.#renew(ctx);
            await port.pullAppStackImage({ plan, image });
          }
        });
        await this.#step(ctx, "prepare", async () => {
          const prepared = await port.prepareAppStack({ plan });
          await setAppStackVolumeStatusTransactional(db, { ...ctx.ref, volumeKeys: prepared.volumes.map((v) => v.volumeKey), status: "present" });
        });
        await this.#step(ctx, "create", async () => {
          // Only a plan with environment secrets carries values to the creation, and only those: a version 1 request
          // stays the one it was.
          const wanted = appStackPlanEnvironmentSecretRefs(plan);
          const secretContents =
            wanted.length === 0
              ? []
              : (await this.#secretFiles(ctx, plan)).filter((f) => wanted.some((w) => w.parameterKey === f.parameterKey && w.version === f.version));
          const result = await port.createAppStackComponents(wanted.length === 0 ? { plan } : { plan, secretContents });
          st.created = result.components.filter((c) => c.outcome !== "unchanged").map((c) => c.componentKey);
        });
      }

      const deadline = clock.now() + APP_STACK_HEALTH_BUDGET_MS;
      const readyWithin = async (ready: (observed: ObservedAppStack) => boolean): Promise<boolean> => {
        for (;;) {
          const observed = await this.#poll(ctx, plan, "waiting");
          if (observed && ready(observed)) return true;
          if (clock.now() >= deadline) return false;
          await clock.sleep(APP_STACK_HEALTH_POLL_MS);
        }
      };
      const budgetSpent = await this.#step(
        ctx,
        "start",
        async () => {
          // Private links to databases (ADR-0039) are in place before anything starts; none of them can fail this step.
          await this.#renew(ctx);
          await this.#links.rollout(stack, plan.components);
          const files = await this.#secretFiles(ctx, plan);
          const mine = (component: ApprovedStackPlan["components"][number]) => {
            const refs = appStackComponentSecretRefs(component);
            return files.filter((f) => refs.some((r) => r.parameterKey === f.parameterKey && r.version === f.version));
          };
          const again = deploy ? (st.previous === null ? [] : appStackRestartSet(plan, st.created ?? [])) : restart ? plan.components.map((c) => c.key) : [];
          for (const component of plan.components) {
            const depsReady = (o: ObservedAppStack) => component.dependsOn.every((d) => appStackComponentReady(appStackObservedComponent(o, d)));
            if (component.dependsOn.length > 0 && !(await readyWithin(depsReady))) return true;
            const request = { plan, componentKey: component.key, secretFileContents: mine(component) };
            await this.#renew(ctx);
            await (again.includes(component.key) ? port.restartAppStackComponent(request) : port.startAppStackComponent(request));
          }
          return false;
        },
        (spent) => (spent ? APP_STACK_START_INCOMPLETE_TEXT : APP_STACK_STEP_DONE_TEXT.start),
      );
      const final = await this.#step(ctx, "health", async () => {
        if (!budgetSpent) await readyWithin((o) => plan.components.every((c) => appStackComponentReady(appStackObservedComponent(o, c.key))));
        const observed = await this.#poll(ctx, plan, "final");
        if (!observed) throw new AppStackStepRefusal("DOCKER_ENGINE_UNAVAILABLE");
        if ([...appStackEssentialKeys(plan)].some((key) => !appStackComponentReady(appStackObservedComponent(observed, key)))) {
          throw new AppStackStepRefusal("STACK_HEALTH_TIMEOUT");
        }
        return observed;
      });

      const domains = await listAppStackDomains(db, ctx.ref);
      const addressed = domains.length > 0 || stack.appliedRoutesHash !== null;
      const routesHash = await this.#step(
        ctx,
        "publish",
        async () => (addressed ? this.#publishReady(ctx, stack, plan, final, domains) : null),
        addressed ? undefined : APP_STACK_NO_ADDRESS_TEXT,
      );

      ctx.current = "settle";
      const health = appStackHealthRows(plan, final, "final");
      const status = appStackAggregate({ plan, health: healthMap(health), domainCount: domains.length, routesPublished: true });
      await settleAppStackOperation(db, ctx.op, ctx.deploymentId, {
        outcome: "succeeded",
        problem: status === "degraded" ? "STACK_HEALTH_TIMEOUT" : null,
        stackStatus: status,
        ...(deploy ? { appliedRevisionId: plan.revisionId } : {}),
        appliedRoutesHash: routesHash,
        // What the routes were made from, read before they were written (with no address too: an address added next differs).
        appliedAddressesHash: appStackAddressesHash(domains, routesHash),
        health: { observedAt: this.#now(), components: health },
      });
    };

    await this.#guard(ctx, body, async (problem) => {
      const step = ctx.current;
      const settle = (s: Omit<AppStackSettlement, "outcome" | "problem" | "failedStep" | "health">, health?: HealthRows) =>
        settleAppStackOperation(db, ctx.op, ctx.deploymentId, {
          outcome: "failed",
          problem,
          failedStep: step,
          ...s,
          ...(health ? { health: { observedAt: this.#now(), components: health } } : {}),
        });
      if (step === "publish") {
        // The containers are healthy and the old route file is still in place.
        return settle({ stackStatus: "degraded", ...(deploy ? { appliedRevisionId: st.plan!.revisionId } : {}) }, ctx.lastHealth);
      }
      if (step === "validate" || (deploy && (step === "reserve" || step === "pull" || step === "prepare"))) {
        // Pre-flight: no container was touched; an applied stack keeps the status its previous revision shows.
        const { stack, previous } = st;
        const observed = deploy && stack && previous ? await this.#status(ctx) : null;
        if (!stack || !previous || !observed) return settle({ stackStatus: "failed" });
        const health = appStackHealthRows(previous, observed, "observer");
        const stackStatus: AppStackStatus = appStackAggregate({
          plan: previous,
          health: healthMap(health),
          domainCount: (await listAppStackDomains(db, ctx.ref)).length,
          routesPublished: stack.appliedRoutesHash !== null,
        });
        return settle({ stackStatus }, health);
      }
      const plan = st.plan!;
      if (!deploy || st.previous === null) {
        // A first deploy keeps every container so its logs stay readable.
        return settle({ stackStatus: "failed", ...(deploy && st.created !== null ? { appliedRevisionId: plan.revisionId } : {}) }, ctx.lastHealth);
      }
      // A new revision failed after create: remove only the containers it created or replaced; volumes stay.
      const observed = await this.#status(ctx);
      const cleanup = observed
        ? appStackReplacedComponents(st.previous, plan).filter(
            (key) => appStackObservedComponent(observed, key)?.componentHash === computeAppStackComponentHash(plan, key),
          )
        : [];
      let removed: readonly string[] = [];
      if (cleanup.length > 0) {
        try {
          await this.#renew(ctx);
          removed = (await ctx.port!.removeAppStackComponents({ plan, componentKeys: [...cleanup] })).removedComponents;
        } catch (err) {
          if (isAmbiguousFailure(err)) throw err;
        }
      }
      const health = (observed ? appStackHealthRows(plan, observed, "final") : ctx.lastHealth)?.map((h) =>
        removed.includes(h.componentKey) ? { ...h, health: "missing" as const } : h,
      );
      return settle({ stackStatus: "failed" }, health);
    });
  }

  /** Routes of the addresses whose ingress target is ready in `observed`, written when they changed; returns their hash. */
  async #publishReady(
    ctx: StackContext,
    stack: AppStackRow,
    plan: ApprovedStackPlan,
    observed: ObservedAppStack,
    domains: DomainRows,
  ): Promise<string | null> {
    const port = ctx.port!;
    const ready = new Set(plan.ingress.map((r) => r.componentKey).filter((key) => appStackComponentReady(appStackObservedComponent(observed, key))));
    // With no address nothing is published: no certificate read can block the withdrawal.
    const acmeEnabled = domains.length > 0 && (await this.#acmeEnabled());
    const { entries } = appStackRoutePlan({ plan, domains, include: ready, now: this.#now(), acmeEnabled });
    const hash = entries.length > 0 ? appStackRoutesHash(entries) : null;
    if (hash !== stack.appliedRoutesHash) {
      await this.#renew(ctx);
      await (entries.length > 0 ? port.publishAppStackRoutes({ plan, routes: entries }) : port.unpublishAppStackRoutes(ctx.ref));
    }
    // An address goes live (and gets its certificate) only once its route is written.
    const written = new Set(entries.flatMap((e) => e.hosts.map((h) => h.hostname)));
    for (const row of domains) {
      if (row.status === "pending" && written.has(row.hostname)) {
        await updateAppStackDomainState(this.#deps.db, { domainId: row.id, set: { status: "active" } });
      }
    }
    return hash;
  }

  /**
   * The observer's route refresh (spec §3.9): one status read, then the current addresses of the healthy ingress targets.
   * Nothing is pulled, created, started or restarted; the revisions stay as they are.
   */
  async #routes(ctx: StackContext): Promise<void> {
    const { db } = this.#deps;
    const body = async () => {
      const { stack, plan } = await this.#step(ctx, "validate", async () => {
        const stack = await this.#begin(ctx, false);
        const plan = await this.#planOf(ctx, stack.appliedRevisionId);
        if (!plan) throw new AppStackStepRefusal("STACK_TEMPLATE_INVALID");
        if (!ctx.port) throw new AppStackStepRefusal("STACK_UNSUPPORTED_FEATURE");
        return { stack, plan };
      });
      for (const key of ROUTES_NOT_NEEDED) await updateOperationStepTransactional(db, ctx.op.id, key, "skipped", APP_STACK_STEP_NOT_NEEDED_TEXT);
      const domains = await listAppStackDomains(db, ctx.ref);
      const routesHash = await this.#step(ctx, "publish", async () => {
        const observed = await this.#poll(ctx, plan, "final");
        if (!observed) throw new AppStackStepRefusal("DOCKER_ENGINE_UNAVAILABLE");
        return this.#publishReady(ctx, stack, plan, observed, domains);
      });
      ctx.current = "settle";
      const status = appStackAggregate({ plan, health: healthMap(ctx.lastHealth!), domainCount: domains.length, routesPublished: true });
      // A route change judges no component: the stack stays one the observer refreshes.
      await settleAppStackOperation(db, ctx.op, ctx.deploymentId, {
        outcome: "succeeded",
        problem: null,
        stackStatus: status === "running" ? "running" : "degraded",
        appliedRoutesHash: routesHash,
        appliedAddressesHash: appStackAddressesHash(domains, routesHash),
      });
    };
    // The previous route file stays in place on a definite failure.
    await this.#guard(ctx, body, (problem) =>
      settleAppStackOperation(db, ctx.op, ctx.deploymentId, { outcome: "failed", problem, stackStatus: "degraded", failedStep: ctx.current }),
    );
  }

  async #stop(ctx: StackContext): Promise<void> {
    const { db } = this.#deps;
    const st = { unpublished: false };
    const body = async () => {
      const { plan, planned } = await this.#step(ctx, "validate", async () => {
        const stack = await this.#begin(ctx, false);
        const revisionId = stack.appliedRevisionId ?? stack.desiredRevisionId;
        if (revisionId !== null && !ctx.port) throw new AppStackStepRefusal("STACK_UNSUPPORTED_FEATURE");
        return { plan: await this.#planOf(ctx, revisionId), planned: revisionId !== null };
      });
      if (!planned) {
        ctx.current = "settle";
        await settleAppStackOperation(db, ctx.op, ctx.deploymentId, { outcome: "succeeded", problem: null, stackStatus: "stopped" });
        return;
      }
      const port = ctx.port!;
      // Always asked (idempotent): the stored routes hash can be null while a route file is still in place.
      await this.#step(ctx, "unpublish", async () => {
        await port.unpublishAppStackRoutes(ctx.ref);
        st.unpublished = true;
      });
      await this.#step(ctx, "stop", () => port.stopAppStack(ctx.ref));
      ctx.current = "settle";
      const stopped = plan?.components.map((c) => ({ componentKey: c.key, health: "stopped" as const }));
      await settleAppStackOperation(db, ctx.op, ctx.deploymentId, {
        outcome: "succeeded",
        problem: null,
        stackStatus: "stopped",
        appliedRoutesHash: null,
        ...(stopped ? { health: { observedAt: this.#now(), components: stopped } } : {}),
      });
    };
    // stopping → failed is not a transition: with the routes possibly gone the application does not serve.
    await this.#guard(ctx, body, (problem) =>
      settleAppStackOperation(db, ctx.op, ctx.deploymentId, {
        outcome: "failed",
        problem,
        stackStatus: "degraded",
        failedStep: ctx.current,
        ...(st.unpublished ? { appliedRoutesHash: null } : {}),
      }),
    );
  }

  async #delete(ctx: StackContext): Promise<void> {
    const { db } = this.#deps;
    const body = async () => {
      const destroy = await this.#step(ctx, "validate", async () => {
        const stack = await this.#begin(ctx, false);
        // Nothing was ever created on this runtime when no revision was applied.
        if (!ctx.port && stack.appliedRevisionId !== null) throw new AppStackStepRefusal("STACK_UNSUPPORTED_FEATURE");
        return (await listAppStackVolumes(db, ctx.ref)).some((v) => v.retentionPolicy === "destroy");
      });
      const port = ctx.port;
      if (port) {
        await this.#step(ctx, "unpublish", () => port.unpublishAppStackRoutes(ctx.ref));
        await this.#step(ctx, "stop", () => port.stopAppStack(ctx.ref));
        await this.#step(ctx, "remove", async () => {
          const removed = await port.removeAppStack({ ...ctx.ref, removeVolumes: destroy });
          if (destroy && removed.retainedVolumes.length > 0) throw new AppStackStepRefusal("STACK_VOLUME_IN_USE");
        });
      }
      ctx.current = "settle";
      await settleAppStackOperation(db, ctx.op, ctx.deploymentId, { outcome: "succeeded", problem: null, stackStatus: "deleted" });
    };
    await this.#guard(ctx, body, (problem) =>
      settleAppStackOperation(db, ctx.op, ctx.deploymentId, { outcome: "failed", problem, stackStatus: "delete_failed", failedStep: ctx.current }),
    );
  }
}
