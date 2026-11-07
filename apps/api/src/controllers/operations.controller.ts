import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { evaluatePolicy } from "@hosting-panel/authz";
import {
  findForbiddenPublicDtoKeys,
  OperationDtoSchema,
  type OperationDto,
  type PaginatedListEnvelope,
  type SingleReadEnvelope,
} from "@hosting-panel/contracts";
import {
  asc,
  desc,
  eq,
  getOperationWithSteps,
  inArray,
  mapOperationToDto,
  operationSteps,
  operations,
  type DatabaseClient,
  type OperationStepRow,
} from "@hosting-panel/database";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import {
  ControlPlaneError,
  paginateItems,
  parsePaginationQuery,
  resolveRequestId,
} from "../common/control-plane.error.js";
import { EventsBusService } from "../operations/events-bus.service.js";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";

@Controller("v1/organizations/:orgId")
export class OperationsController {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(AuthzContextService) private readonly authzContext: AuthzContextService,
    @Inject(EventsBusService) private readonly eventsBus: EventsBusService,
  ) {}

  @Get("operations")
  public async listOperations(
    @Param("orgId") orgId: string,
    @Query() query: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ): Promise<PaginatedListEnvelope<OperationDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requireOrgListPermission(
      auth,
      req,
      orgId,
      "operation.read",
      "operation",
    );

    const pagination = parsePaginationQuery(query);
    const db = this.dbClient.db;

    const opRows = await db
      .select()
      .from(operations)
      .where(eq(operations.organizationId, orgId))
      .orderBy(desc(operations.submittedAt), desc(operations.id));

    const now = new Date();
    const authorizedOps = opRows.filter(
      (op) =>
        evaluatePolicy({
          principal: auth.principal,
          permission: "operation.read",
          organizationId: orgId,
          resource: { id: op.resourceId, organizationId: op.organizationId },
          now,
        }).allowed,
    );

    const opIds = authorizedOps.map((op) => op.id);
    const stepRows =
      opIds.length > 0
        ? await db
            .select()
            .from(operationSteps)
            .where(inArray(operationSteps.operationId, opIds))
            .orderBy(asc(operationSteps.stepOrder), asc(operationSteps.id))
        : [];

    const stepsByOpId = new Map<string, OperationStepRow[]>();
    for (const step of stepRows) {
      const list = stepsByOpId.get(step.operationId) ?? [];
      list.push(step);
      stepsByOpId.set(step.operationId, list);
    }

    const items = authorizedOps.map((op) =>
      OperationDtoSchema.parse(
        mapOperationToDto({
          ...op,
          steps: stepsByOpId.get(op.id) ?? [],
        }),
      ),
    );

    const paged = paginateItems(items, pagination);
    return {
      data: paged.data,
      page: paged.page,
    };
  }

  @Get("operations/:opId")
  public async getOperation(
    @Param("orgId") orgId: string,
    @Param("opId") opId: string,
    @Req() req: FastifyRequest,
  ): Promise<SingleReadEnvelope<OperationDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requireTenantBoundary(
      auth,
      req,
      orgId,
      "operation.read",
      "operation",
      opId,
    );

    const opWithSteps = await getOperationWithSteps(this.dbClient.db, orgId, opId);
    if (!opWithSteps) {
      throw new ControlPlaneError("NOT_FOUND", "Operation was not found.");
    }

    await this.authzContext.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "operation.read",
      targetType: "operation",
      targetId: opWithSteps.id,
      resource: {
        id: opWithSteps.resourceId,
        organizationId: opWithSteps.organizationId,
      },
    });

    const dto = OperationDtoSchema.parse(mapOperationToDto(opWithSteps));
    return { data: dto };
  }

  @Get("events")
  public async streamEvents(
    @Param("orgId") orgId: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: false }) reply: FastifyReply,
  ): Promise<void> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requireOrgListPermission(
      auth,
      req,
      orgId,
      "operation.read",
      "operation",
    );

    const requestId = resolveRequestId(req);
    reply.hijack();

    const rawRes = reply.raw;
    rawRes.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-request-id": requestId,
    });

    const initialPayload = JSON.stringify({
      organizationId: orgId,
      connectedAt: new Date().toISOString(),
    });
    rawRes.write(`event: connected\ndata: ${initialPayload}\n\n`);

    let closed = false;
    const subscription = this.eventsBus.subscribeOrganization(orgId, (evt) => {
      if (closed || rawRes.writableEnded || rawRes.destroyed) {
        return;
      }

      const canReadOp = evaluatePolicy({
        principal: auth.principal,
        permission: "operation.read",
        organizationId: orgId,
        resource: {
          id: evt.operation.resourceId,
          organizationId: evt.operation.organizationId,
        },
      }).allowed;

      if (!canReadOp) {
        return;
      }

      if (findForbiddenPublicDtoKeys(evt.operation).length > 0) {
        return;
      }

      rawRes.write(
        `event: ${evt.event}\ndata: ${JSON.stringify({
          operation: evt.operation,
          emittedAt: evt.emittedAt,
        })}\n\n`,
      );
    });

    const heartbeat = setInterval(() => {
      if (!closed && !rawRes.writableEnded && !rawRes.destroyed) {
        rawRes.write(": keepalive\n\n");
      }
    }, 15_000);
    heartbeat.unref?.();

    let unregisterCloser: (() => void) | null = null;
    const cleanup = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(heartbeat);
      subscription.unsubscribe();
      unregisterCloser?.();
      if (!rawRes.writableEnded && !rawRes.destroyed) {
        rawRes.end();
      }
    };

    unregisterCloser = this.eventsBus.registerActiveStreamCloser(cleanup);
    req.raw.once("close", cleanup);
    rawRes.once("close", cleanup);
  }
}
