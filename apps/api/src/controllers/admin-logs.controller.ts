import { Controller, Get, Inject, Param, Query, Req } from "@nestjs/common";
import { HOST_JOURNAL_SOURCES, LogSourceSchema, type HostJournalSource, type SiteLogLineDto } from "@hosting-panel/contracts";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { ManagedSitesService } from "../sites/managed-sites.service.js";
import { DOCKER_EXECUTOR_TOKEN, HOST_AGENT_TOKEN } from "../tokens.js";

const LOG_TEXT_MAX = 2_000; // the executor's own cut (docker-logs.ts)
const isHostJournal = (source: string): source is HostJournalSource => (HOST_JOURNAL_SOURCES as readonly string[]).includes(source);

/** The customer route's bounds: 1 to 500 lines, 200 when absent or not a number. */
const clampTail = (raw?: string): number => {
  const n = raw === undefined ? 200 : Number(raw);
  return Math.min(500, Math.max(1, Number.isFinite(n) ? Math.trunc(n) : 200));
};

const UNAVAILABLE_MESSAGE = "The logs are not available right now. Try again in a few minutes.";
const unavailable = () => new ControlPlaneError("DOCKER_ENGINE_UNAVAILABLE", UNAVAILABLE_MESSAGE);

/** Puts a fixed sentence in place of the executor's own text. */
function publicLogError(err: unknown): unknown {
  if (err instanceof ControlPlaneError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "NOT_FOUND") {
    return new ControlPlaneError("NOT_FOUND", "There is no log to show: this part is not running on this server.");
  }
  return typeof code === "string" ? unavailable() : err;
}

/** Platform administrator routes for site and panel container logs. */
@Controller("v1/admin")
export class AdminLogsController {
  public constructor(
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(ManagedSitesService) private readonly sitesService: ManagedSitesService,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly executor: DockerExecutorPort,
    @Inject(HOST_AGENT_TOKEN) private readonly hostAgent: HostAgentPort,
  ) {}

  /** Recent log lines of any managed site; audited, because they are the customer's data. */
  @Get("sites/:siteId/logs")
  public async siteLogs(
    @Req() req: FastifyRequest,
    @Param("siteId") siteId: string,
    @Query("tail") rawTail?: string,
  ): Promise<{ data: SiteLogLineDto[] }> {
    const auth = await requireServerAdmin(this.authz, req, siteId, "site");
    const owner = await this.sitesService.ownerOf(siteId);
    const tail = clampTail(rawTail);
    const data = await this.sitesService.logs(siteId, owner, tail, true).catch((err: unknown) => {
      throw publicLogError(err);
    });
    await this.authz.recordAudit(auth, req, {
      organizationId: owner,
      action: "admin.site.logs.read",
      targetType: "site",
      targetId: siteId,
      details: { tail },
    });
    return { data };
  }

  /** Recent log lines of one of the panel's own containers or host services; not audited. */
  @Get("logs/:component")
  public async panelLogs(
    @Req() req: FastifyRequest,
    @Param("component") rawComponent: string,
    @Query("tail") rawTail?: string,
  ): Promise<{ data: SiteLogLineDto[] }> {
    await requireServerAdmin(this.authz, req, null, "platform");
    const component = LogSourceSchema.parse(rawComponent);
    const tail = clampTail(rawTail);
    if (isHostJournal(component)) return { data: await this.#journal(component, tail) };
    if (!this.executor.isRuntimeAvailable) throw unavailable();
    try {
      const lines = await this.executor.getPanelContainerLogs({ component, tail });
      return { data: lines.map((l) => ({ at: l.at, stream: l.stream, text: l.text })) };
    } catch (err) {
      throw publicLogError(err);
    }
  }

  /** A host service's journal through the agent; its text stays out of errors and logs. */
  async #journal(unit: HostJournalSource, tail: number): Promise<SiteLogLineDto[]> {
    if (!this.hostAgent.isRuntimeAvailable) throw new ControlPlaneError("NOT_SUPPORTED", "The host agent is disabled on this server.");
    try {
      const lines = await this.hostAgent.readHostJournal(unit, tail);
      return lines.map((l) => ({ at: l.at, stream: "stdout", text: l.message.slice(0, LOG_TEXT_MAX) }));
    } catch {
      throw new ControlPlaneError("HOST_AGENT_UNAVAILABLE", UNAVAILABLE_MESSAGE);
    }
  }
}
