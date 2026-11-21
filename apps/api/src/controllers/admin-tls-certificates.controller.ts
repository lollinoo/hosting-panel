import { Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Req } from "@nestjs/common";
import {
  AdminTlsInventoryQuerySchema,
  type AdminTlsInventoryItemDto,
  type TlsCertificateAlertDto,
} from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import { TlsCertificatesService } from "../certificates/tls-certificates.service.js";

const TARGET = "tls_certificate";

/** The administrator's certificate inventory (imported and automatic), its expiry alerts, and deletion by id. */
@Controller("v1/admin/tls-certificates")
export class AdminTlsCertificatesController {
  public constructor(
    @Inject(TlsCertificatesService) private readonly certificates: TlsCertificatesService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
  ) {}

  @Get()
  public async inventory(@Req() req: FastifyRequest): Promise<{ data: AdminTlsInventoryItemDto[] }> {
    await requireServerAdmin(this.authz, req, null, TARGET);
    const query = AdminTlsInventoryQuerySchema.parse(req.query ?? {});
    return { data: await this.certificates.adminInventory(query) };
  }

  @Get("alerts")
  public async alerts(@Req() req: FastifyRequest): Promise<{ data: TlsCertificateAlertDto[] }> {
    await requireServerAdmin(this.authz, req, null, TARGET);
    return { data: await this.certificates.alerts() };
  }

  @Delete(":certificateId")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async remove(@Req() req: FastifyRequest, @Param("certificateId") certificateId: string): Promise<void> {
    const auth = await requireServerAdmin(this.authz, req, certificateId, TARGET);
    const organizationId = await this.certificates.ownerOf(certificateId);
    await this.certificates.deleteCertificate({
      organizationId,
      certificateId,
      audit: (event) => this.authz.recordAudit(auth, req, { organizationId, ...event }),
    });
  }
}
