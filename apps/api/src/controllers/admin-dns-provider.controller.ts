import { Body, Controller, Delete, Get, Inject, Patch, Req } from "@nestjs/common";
import { DnsProviderSettingsInputSchema, type DnsProviderSettingsDto } from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import { DnsProviderService } from "../certificates/dns-provider.service.js";

const TARGET = "dns_provider";

@Controller("v1/admin/dns-provider")
export class AdminDnsProviderController {
  public constructor(
    @Inject(DnsProviderService) private readonly dnsProvider: DnsProviderService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
  ) {}

  @Get()
  public async get(@Req() req: FastifyRequest): Promise<{ data: DnsProviderSettingsDto }> {
    await requireServerAdmin(this.authz, req, null, TARGET);
    return { data: await this.dnsProvider.get() };
  }

  @Patch()
  public async save(@Req() req: FastifyRequest, @Body() raw: unknown): Promise<{ data: DnsProviderSettingsDto }> {
    const auth = await requireServerAdmin(this.authz, req, null, TARGET);
    const input = DnsProviderSettingsInputSchema.parse(raw ?? {});
    return { data: await this.dnsProvider.save(input, auth.user.id) };
  }

  @Delete()
  public async clear(@Req() req: FastifyRequest): Promise<{ data: DnsProviderSettingsDto }> {
    const auth = await requireServerAdmin(this.authz, req, null, TARGET);
    return { data: await this.dnsProvider.clear(auth.user.id) };
  }
}
