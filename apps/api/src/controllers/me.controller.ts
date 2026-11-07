import { Controller, Get, Inject, Query, Req } from "@nestjs/common";
import {
  createPlatformCapabilities,
  type MeDto,
  type OrganizationSummaryDto,
  type PresetRoleName,
  type ReadMeta,
} from "@hosting-panel/contracts";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import {
  paginateItems,
  parsePaginationQuery,
  resolveRequestId,
} from "../common/control-plane.error.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  HOST_AGENT_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";

@Controller("v1/me")
export class MeController {
  public constructor(
    @Inject(AuthzContextService) private readonly authzService: AuthzContextService,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly dockerExecutor: DockerExecutorPort,
    @Inject(HOST_AGENT_TOKEN) private readonly hostAgent: HostAgentPort,
  ) {}

  @Get()
  public async getMe(@Req() req: FastifyRequest): Promise<{ data: MeDto }> {
    const auth = await this.authzService.authenticateRequest(req);

    const memberships = auth.activeMembershipSummaries.map((m) => ({
      id: m.membershipId,
      organizationId: m.organization.id,
      organizationName: m.organization.name,
      organizationSlug: m.organization.slug,
      role: (m.roleNames[0] ?? "customer_collaborator") as PresetRoleName,
      organizationStatus: m.organization.status,
    }));

    return {
      data: {
        user: {
          id: auth.user.id,
          email: auth.user.email,
          name: auth.user.name,
        },
        globalRoles: (auth.principal.globalRoles ?? []) as PresetRoleName[],
        hostingAdminOrgIds: (auth.principal.hostingAdminOrgIds ?? []) as string[],
        memberships,
        platformCapabilities: createPlatformCapabilities({
          runtimeBackend: this.config.runtimeBackend,
          dockerExecutorRuntimeAvailable: this.dockerExecutor.isRuntimeAvailable,
          hostAgentRuntimeAvailable: this.hostAgent.isRuntimeAvailable,
        }),
      },
    };
  }

  @Get("organizations")
  public async getMyOrganizations(
    @Req() req: FastifyRequest,
    @Query() rawQuery?: Record<string, unknown>,
  ): Promise<{
    data: OrganizationSummaryDto[];
    meta: ReadMeta;
    page: { nextCursor: string | null; hasMore: boolean };
  }> {
    const auth = await this.authzService.authenticateRequest(req);
    const pagination = parsePaginationQuery(rawQuery);

    const orgsMap = new Map<string, OrganizationSummaryDto>();
    for (const m of auth.activeMembershipSummaries) {
      if (!orgsMap.has(m.organization.id)) {
        orgsMap.set(m.organization.id, {
          id: m.organization.id,
          name: m.organization.name,
          slug: m.organization.slug,
          status: m.organization.status,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    const orgList = Array.from(orgsMap.values()).sort((a, b) =>
      a.slug.localeCompare(b.slug),
    );

    const paginated = paginateItems(orgList, pagination);

    return {
      data: paginated.data,
      meta: {
        total: orgList.length,
        cursor: pagination.cursor ?? null,
        requestId: resolveRequestId(req),
        timestamp: new Date().toISOString(),
      },
      page: paginated.page,
    };
  }
}
