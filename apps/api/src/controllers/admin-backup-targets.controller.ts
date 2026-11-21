import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import type { AdminBackupTargetDto, BackupTargetsDto } from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import { BackupTargetsService, type BackupTargetTestResultDto } from "../backups/backup-targets.service.js";

const TARGET = "backup_targets";
const EmptyBodySchema = z.object({}).strict();

/**
 * Platform administrator routes for backup destinations. `requireServerAdmin` runs before any body is read, so a
 * customer sending a malformed body still gets 403. The synchronous configuration needs no Idempotency-Key.
 */
@Controller("v1/admin/backup-targets")
export class AdminBackupTargetsController {
  public constructor(
    @Inject(BackupTargetsService) private readonly targets: BackupTargetsService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
  ) {}

  @Get()
  public async list(@Req() req: FastifyRequest): Promise<{ data: BackupTargetsDto }> {
    await requireServerAdmin(this.authz, req, null, TARGET);
    return { data: await this.targets.list() };
  }

  @Post()
  public async create(@Req() req: FastifyRequest, @Body() raw: unknown): Promise<{ data: AdminBackupTargetDto }> {
    const auth = await requireServerAdmin(this.authz, req, null, TARGET);
    return { data: await this.targets.create(raw, auth.user.id) };
  }

  @Patch(":targetId")
  public async update(
    @Req() req: FastifyRequest,
    @Param("targetId") targetId: string,
    @Body() raw: unknown,
  ): Promise<{ data: AdminBackupTargetDto }> {
    const auth = await requireServerAdmin(this.authz, req, null, TARGET);
    return { data: await this.targets.update(targetId, raw, auth.user.id) };
  }

  @Post(":targetId/test")
  @HttpCode(HttpStatus.OK)
  public async test(
    @Req() req: FastifyRequest,
    @Param("targetId") targetId: string,
    @Body() raw?: unknown,
  ): Promise<{ data: BackupTargetTestResultDto }> {
    const auth = await requireServerAdmin(this.authz, req, null, TARGET);
    EmptyBodySchema.parse(raw ?? {});
    return { data: await this.targets.test(targetId, auth.user.id) };
  }

  @Post(":targetId/initialize")
  @HttpCode(HttpStatus.OK)
  public async initialize(
    @Req() req: FastifyRequest,
    @Param("targetId") targetId: string,
    @Body() raw?: unknown,
  ): Promise<{ data: AdminBackupTargetDto }> {
    const auth = await requireServerAdmin(this.authz, req, null, TARGET);
    EmptyBodySchema.parse(raw ?? {});
    return { data: await this.targets.initialize(targetId, auth.user.id) };
  }

  @Delete(":targetId")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async remove(@Req() req: FastifyRequest, @Param("targetId") targetId: string): Promise<void> {
    const auth = await requireServerAdmin(this.authz, req, null, TARGET);
    await this.targets.delete(targetId, auth.user.id);
  }
}
