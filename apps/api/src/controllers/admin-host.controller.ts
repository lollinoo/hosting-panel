import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Post, Req } from "@nestjs/common";
import { HostServiceSchema, RestartInputSchema, type HostService } from "@hosting-panel/contracts";
import type { DatabaseClient } from "@hosting-panel/database";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import {
  ControlPlaneError,
  extractClientIp,
  extractRawHeader,
  requireIdempotencyKey,
  resolveRequestId,
} from "../common/control-plane.error.js";
import { enqueueHostJob, HOST_SERVICE_JOB } from "../host/host-jobs.js";
import { DATABASE_CLIENT_TOKEN, HOST_AGENT_TOKEN } from "../tokens.js";

const headersOf = (req: FastifyRequest) => req.headers as Record<string, string | string[] | undefined>;

/** Platform administrator routes for the panel's host services. */
@Controller("v1/admin")
export class AdminHostController {
  public constructor(
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(HOST_AGENT_TOKEN) private readonly hostAgent: HostAgentPort,
  ) {}

  /** Queues a restart of one host service; the request row is written with the operation. */
  @Post("host-services/:service/restart")
  @HttpCode(HttpStatus.ACCEPTED)
  public async restartHostService(
    @Req() req: FastifyRequest,
    @Param("service") rawService: string,
    @Body() raw: unknown,
  ): Promise<{ data: { service: HostService; operationId: string } }> {
    const auth = await requireServerAdmin(this.authz, req, rawService, "host_service");
    const service = HostServiceSchema.parse(rawService);
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const { reason } = RestartInputSchema.parse(raw ?? {});
    if (!this.hostAgent.isRuntimeAvailable) {
      throw new ControlPlaneError("NOT_SUPPORTED", "The host agent is disabled on this server.");
    }
    const { operationId } = await enqueueHostJob(this.dbClient.db, {
      job: HOST_SERVICE_JOB[service],
      actorId: auth.user.id,
      idempotencyKey,
      audit: {
        action: "admin.host_service.restart",
        targetType: "host_service",
        targetId: service,
        details: { outcome: "succeeded", requestId: resolveRequestId(req), service, reason },
        ipAddress: extractClientIp(req),
        userAgent: extractRawHeader(headersOf(req), "user-agent") ?? null,
      },
    });
    return { data: { service, operationId } };
  }
}
