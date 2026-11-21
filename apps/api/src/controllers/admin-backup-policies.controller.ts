import { Body, Controller, Get, Inject, Param, Patch, Req } from "@nestjs/common";
import type { BackupPolicyDto } from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import { BackupPoliciesService, type AdminBackupPolicyScope } from "../backups/backup-policies.service.js";
import { ControlPlaneError } from "../common/control-plane.error.js";

const TARGET = "backup_policy";
const SCOPES: Readonly<Record<string, AdminBackupPolicyScope>> = { default: "default_site", panel: "panel" };

function scopeOf(raw: string): AdminBackupPolicyScope {
  const scope = Object.hasOwn(SCOPES, raw) ? SCOPES[raw] : undefined;
  if (!scope) {
    throw new ControlPlaneError("NOT_FOUND", "Backup policy not found");
  }
  return scope;
}

/** Platform administrator routes for the default-site and panel backup policies. */
@Controller("v1/admin/backup-policies")
export class AdminBackupPoliciesController {
  public constructor(
    @Inject(BackupPoliciesService) private readonly policies: BackupPoliciesService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
  ) {}

  @Get(":scope")
  public async get(@Req() req: FastifyRequest, @Param("scope") scope: string): Promise<{ data: BackupPolicyDto }> {
    await requireServerAdmin(this.authz, req, null, TARGET);
    return { data: await this.policies.get(scopeOf(scope)) };
  }

  @Patch(":scope")
  public async update(
    @Req() req: FastifyRequest,
    @Param("scope") scope: string,
    @Body() raw: unknown,
  ): Promise<{ data: BackupPolicyDto }> {
    const auth = await requireServerAdmin(this.authz, req, null, TARGET);
    return { data: await this.policies.update(scopeOf(scope), raw, auth.user.id) };
  }
}
