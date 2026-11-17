import { Body, Controller, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import type { TerminalReadDto, TerminalSessionDto } from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import { AdminTerminalService } from "../terminal/admin-terminal.service.js";

/** Platform administrator routes for a terminal in a site's container. */
@Controller("v1/admin")
export class AdminTerminalController {
  public constructor(
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(AdminTerminalService) private readonly terminal: AdminTerminalService,
  ) {}

  /** Opens a terminal session on the site's container. */
  @Post("sites/:siteId/terminal")
  @HttpCode(201)
  public async open(@Req() req: FastifyRequest, @Param("siteId") siteId: string, @Body() body: unknown): Promise<{ data: TerminalSessionDto }> {
    const auth = await requireServerAdmin(this.authz, req, siteId, "site");
    return { data: await this.terminal.open(auth, req, siteId, body) };
  }

  /** Sends input to the caller's session. */
  @Post("terminal/:sessionId/write")
  @HttpCode(204)
  public async write(@Req() req: FastifyRequest, @Param("sessionId") sessionId: string, @Body() body: unknown): Promise<void> {
    const auth = await requireServerAdmin(this.authz, req, sessionId, "terminal_session");
    await this.terminal.write(auth, sessionId, body);
  }

  /** Reads output after the cursor. */
  @Post("terminal/:sessionId/read")
  @HttpCode(200)
  public async read(@Req() req: FastifyRequest, @Param("sessionId") sessionId: string, @Body() body: unknown): Promise<{ data: TerminalReadDto }> {
    const auth = await requireServerAdmin(this.authz, req, sessionId, "terminal_session");
    return { data: await this.terminal.read(auth, sessionId, body) };
  }

  /** Closes the caller's session. */
  @Post("terminal/:sessionId/close")
  @HttpCode(204)
  public async close(@Req() req: FastifyRequest, @Param("sessionId") sessionId: string): Promise<void> {
    const auth = await requireServerAdmin(this.authz, req, sessionId, "terminal_session");
    await this.terminal.close(auth, req, sessionId);
  }
}
