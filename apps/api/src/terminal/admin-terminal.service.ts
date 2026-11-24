import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  APP_STACK_BUSY_STATUSES,
  APP_STACK_ID_PATTERN,
  APP_STACK_KEY_PATTERN,
  appStackLockKey,
  SITE_TYPE_KEYS,
  siteTypeKeyOf,
  OpenTerminalInputSchema,
  ReadTerminalInputSchema,
  TERMINAL_SESSION_ID_PATTERN,
  TERMINAL_SESSION_MAX_MS,
  WriteTerminalInputSchema,
  type AppTerminalSessionDto,
  type TerminalEndReason,
  type TerminalReadDto,
  type TerminalRefusal,
  type TerminalSessionDto,
} from "@hosting-panel/contracts";
import {
  ACTIVE_OPERATION_LOCK_STATUSES,
  and,
  appStacks,
  closeTerminalSession,
  eq,
  findTerminalSession,
  inArray,
  isNull,
  listAppStackComponents,
  listOpenTerminalSessions,
  openAppTerminalSession,
  openTerminalSession,
  operations,
  serviceInstances,
  sites,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { isAppStackTerminalExecutor } from "@hosting-panel/executor-contracts";
import type { DockerExecutorPort, TerminalReadResult, TerminalSessionRecord } from "@hosting-panel/executor-contracts";
import type { FastifyRequest } from "fastify";
import { reserveTotpAttempt } from "../auth/attempt-limits.js";
import { AuthzContextService, type AuthenticatedRequestContext } from "../auth/authz-context.service.js";
import { checkUserTotp, saveTotpStep } from "../auth/totp-secret.js";
import { ControlPlaneError, extractClientIp, extractRawHeader, resolveRequestId } from "../common/control-plane.error.js";
import { sanitizeContainerIdentifier } from "../runtime/service-spec.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";

export const TERMINAL_SWEEP_INTERVAL_MS = 30_000;
export const TERMINAL_OPEN_GRACE_MS = 60_000;

// Fixed public sentences: an executor's own text never reaches the client.
const REFUSAL_MESSAGES: Record<TerminalRefusal, string> = {
  container_down: "The site is not running. Restart it, then open the terminal.",
  site_changing: "Wait for the running change to end.",
  site_busy: "Close the other terminal of this site first.",
  server_full: "Four terminals are open on this server; close one.",
  session_ended: "This terminal session has ended. Open a new one.",
};
// The same five refusals for a component of an application (ADR-0041 T5), in its own words.
const APP_REFUSAL_MESSAGES: Record<TerminalRefusal, string> = {
  container_down: "The application is not running. A terminal opens only in a running component.",
  site_changing: "Wait for the running change of the application to end.",
  site_busy: "Close the other terminal of this component first.",
  server_full: REFUSAL_MESSAGES.server_full,
  session_ended: REFUSAL_MESSAGES.session_ended,
};
const refused = (reason: TerminalRefusal, messages: Record<TerminalRefusal, string> = REFUSAL_MESSAGES) =>
  new ControlPlaneError("RESOURCE_LOCKED", messages[reason], { details: [{ reason, message: messages[reason] }] });
const unavailable = () =>
  new ControlPlaneError("DOCKER_ENGINE_UNAVAILABLE", "The terminal is not available right now. Try again in a few minutes.");
const notFound = () => new ControlPlaneError("NOT_FOUND", "Requested organization or resource was not found.");
const invalidCode = () =>
  new ControlPlaneError("TOTP_INVALID", "The code is wrong or was already used. Wait for the next code and try again.");
const CODE_MISSING = "Enter the six-digit code from your authenticator app.";
const codeOf = (err: unknown): unknown => (err as { code?: unknown } | null)?.code;
const newSessionId = (): string => `term_${randomUUID().replace(/-/g, "")}`;
/** The name the executor derives itself for a component's container (its appStackContainerName); never a Docker id. */
const componentContainerName = (stackId: string, componentKey: string): string => `hp_app_${stackId}_${componentKey}`;

/** What a refused code is written against: the site or the application, and the customer it belongs to. */
interface CodeTarget {
  readonly organizationId: string;
  readonly targetType: "site" | "app_stack";
  readonly targetId: string;
}

/**
 * Administrator terminal sessions, in a site's container or in the container of one component of an application
 * (ADR-0027, ADR-0041): open, write, read, close and the expiry sweep. Only the open differs between the two.
 */
@Injectable()
export class AdminTerminalService {
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #activeSweep: Promise<void> | null = null;

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly executor: DockerExecutorPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
  ) {}

  /** Opens a session on the site's container after the TOTP code. */
  public async open(auth: AuthenticatedRequestContext, req: FastifyRequest, siteId: string, body: unknown): Promise<TerminalSessionDto> {
    const db = this.dbClient.db;
    const [site] = await db.select().from(sites).where(and(eq(sites.id, siteId), inArray(sites.siteType, [...SITE_TYPE_KEYS]))).limit(1);
    const siteType = siteTypeKeyOf(site?.siteType);
    if (!site || !siteType) throw notFound();
    const [svc] = await db
      .select()
      .from(serviceInstances)
      .where(and(eq(serviceInstances.siteId, site.id), eq(serviceInstances.organizationId, site.organizationId)))
      .limit(1);
    if (!svc) throw notFound();

    // Refusals that spend no code.
    if (!this.executor.isRuntimeAvailable) throw unavailable();
    const [lock] = await db
      .select({ id: operations.id })
      .from(operations)
      .where(and(eq(operations.lockKey, `site:${siteId}`), inArray(operations.status, [...ACTIVE_OPERATION_LOCK_STATUSES])))
      .limit(1);
    if (site.status === "deploying" || site.status === "maintenance" || lock) throw refused("site_changing");
    if (svc.desiredStatus === "stopped") throw refused("container_down");

    const userId = await this.#spendCode(auth, req, body, { organizationId: site.organizationId, targetType: "site", targetId: siteId });

    // The row and its open audit row are committed before the executor call, so the pass always finds the shell.
    const sessionId = newSessionId();
    const containerName = sanitizeContainerIdentifier(svc.id);
    const requestId = resolveRequestId(req);
    const result = await openTerminalSession(db, {
      id: sessionId,
      userId,
      siteId,
      organizationId: site.organizationId,
      containerName,
      ipAddress: extractClientIp(req),
      userAgent: extractRawHeader(req.headers as Record<string, string | string[] | undefined>, "user-agent") ?? null,
      requestId,
    });
    if (result !== "opened") throw refused(result);
    const { openedAt } = await this.#start(sessionId, requestId, REFUSAL_MESSAGES, () =>
      this.executor.openTerminal({ sessionId, siteId, serviceInstanceId: svc.id, siteType }),
    );
    return { sessionId, siteId, containerName, openedAt, expiresAt: new Date(Date.parse(openedAt) + TERMINAL_SESSION_MAX_MS).toISOString() };
  }

  /**
   * Opens a session in the container of one component of a customer's application, after the TOTP code, in the order
   * of ADR-0041 T5: the application and its component, the runtime, a running change, a stopped application, the
   * code, the row, the executor. The request names the application, its customer and the component and nothing else:
   * the executor derives the container's name itself and re-checks its labels.
   */
  public async openInComponent(
    auth: AuthenticatedRequestContext,
    req: FastifyRequest,
    stackId: string,
    componentKey: string,
    body: unknown,
  ): Promise<AppTerminalSessionDto> {
    const db = this.dbClient.db;
    if (!APP_STACK_ID_PATTERN.test(stackId) || !APP_STACK_KEY_PATTERN.test(componentKey)) throw notFound();
    const [stack] = await db.select().from(appStacks).where(and(eq(appStacks.id, stackId), isNull(appStacks.deletedAt))).limit(1);
    if (!stack) throw notFound();
    const { organizationId } = stack;
    const components = await listAppStackComponents(db, { organizationId, stackId });
    if (!components.some((c) => c.componentKey === componentKey)) throw notFound();

    // Refusals that spend no code. An executor that does not offer the call is the same 503 (ADR-0041 T8).
    const executor = this.executor;
    if (!executor.isRuntimeAvailable || !isAppStackTerminalExecutor(executor)) throw unavailable();
    const [lock] = await db
      .select({ id: operations.id })
      .from(operations)
      .where(and(eq(operations.lockKey, appStackLockKey(stackId)), inArray(operations.status, [...ACTIVE_OPERATION_LOCK_STATUSES])))
      .limit(1);
    // The stored status, not the one a page shows: «unknown» there is a stale observation, not a change.
    if (lock || (APP_STACK_BUSY_STATUSES as readonly string[]).includes(stack.status)) throw refused("site_changing", APP_REFUSAL_MESSAGES);
    if (stack.status === "draft" || stack.status === "stopped") throw refused("container_down", APP_REFUSAL_MESSAGES);

    const userId = await this.#spendCode(auth, req, body, { organizationId, targetType: "app_stack", targetId: stackId });

    // The row and its open audit row are committed before the executor call, so the pass always finds the shell.
    const sessionId = newSessionId();
    const containerName = componentContainerName(stackId, componentKey);
    const requestId = resolveRequestId(req);
    const result = await openAppTerminalSession(db, {
      id: sessionId,
      userId,
      stackId,
      componentKey,
      organizationId,
      containerName,
      ipAddress: extractClientIp(req),
      userAgent: extractRawHeader(req.headers as Record<string, string | string[] | undefined>, "user-agent") ?? null,
      requestId,
    });
    if (result !== "opened") throw refused(result, APP_REFUSAL_MESSAGES);
    const { openedAt } = await this.#start(sessionId, requestId, APP_REFUSAL_MESSAGES, () =>
      executor.openAppStackTerminal({ sessionId, stackId, organizationId, componentKey }),
    );
    return {
      sessionId,
      stackId,
      componentKey,
      containerName,
      openedAt,
      expiresAt: new Date(Date.parse(openedAt) + TERMINAL_SESSION_MAX_MS).toISOString(),
    };
  }

  /** Sends input to the caller's own session. */
  public async write(auth: AuthenticatedRequestContext, sessionId: string, body: unknown): Promise<void> {
    const row = await this.#mine(auth, sessionId);
    const { input } = WriteTerminalInputSchema.parse(body);
    if (row.closedAt) throw refused("session_ended");
    try {
      await this.executor.writeTerminal({ sessionId, input });
    } catch (err) {
      const code = codeOf(err);
      if (code === "NOT_FOUND") await this.#end(sessionId, "executor_gone", null, "user");
      if (code === "NOT_FOUND" || code === "OPERATION_INTERRUPTED") throw refused("session_ended");
      throw unavailable();
    }
  }

  /** Returns output after the cursor, waiting a while when there is none. */
  public async read(auth: AuthenticatedRequestContext, sessionId: string, body: unknown): Promise<TerminalReadDto> {
    const row = await this.#mine(auth, sessionId);
    const { cursor } = ReadTerminalInputSchema.parse(body);
    let result: TerminalReadResult;
    try {
      result = await this.executor.readTerminal({ sessionId, cursor });
    } catch (err) {
      if (codeOf(err) !== "NOT_FOUND") throw unavailable();
      if (!row.closedAt) await this.#end(sessionId, "executor_gone", null, "user");
      const ended = (await findTerminalSession(this.dbClient.db, sessionId, auth.user.id))!;
      return { output: "", cursor, dropped: false, ended: { reason: ended.closeReason!, at: ended.closedAt!.toISOString() } };
    }
    if (result.ended && !row.closedAt) await this.#end(sessionId, result.ended.reason, new Date(result.ended.at), "user");
    return { output: result.output, cursor: result.cursor, dropped: result.dropped, ended: result.ended };
  }

  /** Closes the caller's own session. */
  public async close(auth: AuthenticatedRequestContext, req: FastifyRequest, sessionId: string): Promise<void> {
    const row = await this.#mine(auth, sessionId);
    if (row.closedAt) return;
    let reason: TerminalEndReason = "executor_gone";
    let endedAt: Date | null = null;
    try {
      const ended = await this.executor.closeTerminal({ sessionId });
      reason = ended.reason;
      endedAt = new Date(ended.at);
    } catch (err) {
      // Unreachable: the row stays open; the executor's idle limit and the pass finish it.
      if (codeOf(err) !== "NOT_FOUND") throw unavailable();
    }
    await this.#end(sessionId, reason, endedAt, "user", resolveRequestId(req));
  }

  /** One pass that closes ended, idle and expired sessions; never two at once. */
  public async sweepOnce(now: Date = new Date()): Promise<void> {
    if (this.#activeSweep !== null) return this.#activeSweep;
    const promise = this.#sweep(now);
    this.#activeSweep = promise;
    try {
      await promise;
    } finally {
      this.#activeSweep = null;
    }
  }

  /** Starts the unref'd sweep timer; null or 0 starts nothing. */
  public startBackgroundLoop(intervalMs: number | null): void {
    if (this.#stopped || this.#timer || !intervalMs || intervalMs <= 0) return;
    this.#timer = setInterval(() => {
      if (this.#stopped) return;
      void this.sweepOnce().catch(() => undefined);
    }, intervalMs);
    this.#timer.unref();
  }

  /** Stops the timer and waits for a running pass. */
  public async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#activeSweep !== null) await this.#activeSweep.catch(() => undefined);
  }

  async #sweep(now: Date): Promise<void> {
    if (!this.executor.isRuntimeAvailable) return;
    // The list comes first: a session it shows has its row committed already.
    let listed: readonly TerminalSessionRecord[];
    try {
      listed = await this.executor.listTerminals();
    } catch {
      return;
    }
    const byId = new Map(listed.map((r) => [r.sessionId, r]));
    const open = await listOpenTerminalSessions(this.dbClient.db);
    for (const row of open) {
      const record = byId.get(row.id);
      if (record?.ended) await this.#end(row.id, record.ended.reason, new Date(record.ended.at), "system");
      else if (!record && now.getTime() - row.openedAt.getTime() >= TERMINAL_OPEN_GRACE_MS) {
        await this.#end(row.id, "executor_gone", null, "system");
      }
    }
    // Lets the executor forget ended records and kills shells that have no open row.
    const openIds = new Set(open.map((r) => r.id));
    for (const record of listed) {
      if (record.ended || !openIds.has(record.sessionId)) {
        await this.executor.closeTerminal({ sessionId: record.sessionId }).catch(() => undefined);
      }
    }
  }

  /**
   * The six-digit code, with the rules of ADR-0027 for both kinds of terminal: every refusal writes one
   * `admin.terminal.denied` row against the target. Returns the administrator's user id once the code is spent.
   */
  async #spendCode(auth: AuthenticatedRequestContext, req: FastifyRequest, body: unknown, target: CodeTarget): Promise<string> {
    const db = this.dbClient.db;
    const deny = async (reason: string, error: ControlPlaneError) => {
      await this.authz.recordDeniedAudit(auth, req, {
        organizationId: target.organizationId,
        action: "admin.terminal.denied",
        targetType: target.targetType,
        targetId: target.targetId,
        reason,
      });
      return error;
    };
    const parsed = OpenTerminalInputSchema.safeParse(body);
    if (!parsed.success) {
      throw await deny("code_missing", new ControlPlaneError("VALIDATION_ERROR", CODE_MISSING, { details: [{ field: "code", message: CODE_MISSING }] }));
    }
    // auth.user holds no TOTP columns: read the row now, so the step and the counter are fresh.
    const [user] = await db.select().from(users).where(eq(users.id, auth.user.id)).limit(1);
    if (!user) throw notFound();
    if (user.totpEnabledAt === null) {
      throw await deny("totp_not_enrolled", new ControlPlaneError("ACCOUNT_SETUP_INCOMPLETE", "Set up two-factor authentication before you open a terminal."));
    }
    if (!(await reserveTotpAttempt(db, user.id))) {
      throw await deny("locked", new ControlPlaneError("ACCOUNT_LOCKED", "Too many wrong codes. Wait 15 minutes and try again."));
    }
    const checked = checkUserTotp(user, parsed.data.code, Date.now(), this.config.secretsMasterKey);
    if (!checked.ok) throw await deny("code_wrong", invalidCode());
    // Only the TOTP counter is reset: a lock from wrong passwords stays.
    if (!(await saveTotpStep(db, user.id, checked.step, { totpFailedCount: 0 }))) throw await deny("code_used", invalidCode());
    return user.id;
  }

  /**
   * The executor's open, after the row is saved. A timed-out open may have started, so its row stays for the pass;
   * any other failure ends the row as not_started and answers with a fixed sentence, never the executor's own text.
   */
  async #start<T>(sessionId: string, requestId: string, messages: Record<TerminalRefusal, string>, open: () => Promise<T>): Promise<T> {
    try {
      return await open();
    } catch (err) {
      const code = codeOf(err);
      if (code === "OPERATION_AMBIGUOUS") {
        throw new ControlPlaneError("DOCKER_ENGINE_UNAVAILABLE", "The terminal could not be opened. Try again in a minute.");
      }
      await closeTerminalSession(this.dbClient.db, { id: sessionId, reason: "not_started", endedAt: null, actorType: "user", requestId });
      if (code === "NOT_FOUND") throw refused("container_down", messages);
      if (code === "RESOURCE_LOCKED") throw refused("site_busy", messages);
      if (code === "QUOTA_EXCEEDED") throw refused("server_full", messages);
      throw unavailable();
    }
  }

  /** The caller's own session row; anything else is 404. */
  async #mine(auth: AuthenticatedRequestContext, sessionId: string) {
    const row = TERMINAL_SESSION_ID_PATTERN.test(sessionId) ? await findTerminalSession(this.dbClient.db, sessionId, auth.user.id) : null;
    if (!row) throw notFound();
    return row;
  }

  /** Closes the row with its one close audit row, if still open. */
  async #end(id: string, reason: TerminalEndReason, endedAt: Date | null, actorType: "user" | "system", requestId?: string): Promise<void> {
    await closeTerminalSession(this.dbClient.db, { id, reason, endedAt, actorType, ...(requestId !== undefined ? { requestId } : {}) });
  }
}
