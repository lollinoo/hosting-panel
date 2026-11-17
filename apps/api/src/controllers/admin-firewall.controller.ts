import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { FIREWALL_BLOCK_ID_PATTERN, FirewallBlockInputSchema, FirewallPortNameSchema, type FirewallDto, type FirewallPortName } from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService, type AuthenticatedRequestContext } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import { ControlPlaneError, extractClientIp, extractRawHeader, resolveRequestId } from "../common/control-plane.error.js";
import { FirewallService, firewallRefusal, type FirewallActor } from "../firewall/firewall.service.js";

const headersOf = (req: FastifyRequest) => req.headers as Record<string, string | string[] | undefined>;
const actorOf = (auth: AuthenticatedRequestContext, req: FastifyRequest): FirewallActor => ({
  userId: auth.user.id,
  ipAddress: extractClientIp(req),
  userAgent: extractRawHeader(headersOf(req), "user-agent") ?? null,
  requestId: resolveRequestId(req),
});

/** The closed list, refused without echoing the segment. */
const portName = (name: string): FirewallPortName => {
  const parsed = FirewallPortNameSchema.safeParse(name);
  if (!parsed.success) throw firewallRefusal("name", "unknown_port");
  return parsed.data;
};

/** Platform administrator routes for the host firewall. */
@Controller("v1/admin/firewall")
export class AdminFirewallController {
  public constructor(
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(FirewallService) private readonly firewall: FirewallService,
  ) {}

  /** The stored lists and the host's state. */
  @Get("")
  public async view(@Req() req: FastifyRequest): Promise<{ data: FirewallDto }> {
    await requireServerAdmin(this.authz, req, null, "firewall");
    return { data: await this.firewall.view() };
  }

  /** Opens one port of the safe list. */
  @Post("ports/:name/open")
  @HttpCode(200)
  public async open(@Req() req: FastifyRequest, @Param("name") name: string): Promise<{ data: FirewallDto }> {
    const auth = await requireServerAdmin(this.authz, req, null, "firewall");
    return { data: await this.firewall.setPort(portName(name), true, actorOf(auth, req)) };
  }

  /** Closes one port of the safe list. */
  @Post("ports/:name/close")
  @HttpCode(200)
  public async close(@Req() req: FastifyRequest, @Param("name") name: string): Promise<{ data: FirewallDto }> {
    const auth = await requireServerAdmin(this.authz, req, null, "firewall");
    return { data: await this.firewall.setPort(portName(name), false, actorOf(auth, req)) };
  }

  /** Blocks one address or range. */
  @Post("blocks")
  @HttpCode(201)
  public async block(@Req() req: FastifyRequest, @Body() raw: unknown): Promise<{ data: FirewallDto }> {
    const auth = await requireServerAdmin(this.authz, req, null, "firewall");
    const parsed = FirewallBlockInputSchema.safeParse(raw ?? {});
    // A malformed body is refused by field only: zod's text could quote a hostile key.
    if (!parsed.success) throw parsed.error.issues[0]?.path[0] === "note" ? firewallRefusal("note", "note_invalid") : firewallRefusal("address", "invalid");
    // D10: the web app passes the visitor's address; absent or garbage, the own-address check is skipped.
    const requester = extractRawHeader(headersOf(req), "x-hp-client-address") ?? null;
    return { data: await this.firewall.block(parsed.data, requester, actorOf(auth, req)) };
  }

  /** Removes one block. */
  @Delete("blocks/:blockId")
  @HttpCode(200)
  public async unblock(@Req() req: FastifyRequest, @Param("blockId") blockId: string): Promise<{ data: FirewallDto }> {
    const auth = await requireServerAdmin(this.authz, req, null, "firewall");
    if (!FIREWALL_BLOCK_ID_PATTERN.test(blockId)) throw new ControlPlaneError("NOT_FOUND", "This block does not exist.");
    return { data: await this.firewall.unblock(blockId, actorOf(auth, req)) };
  }
}
